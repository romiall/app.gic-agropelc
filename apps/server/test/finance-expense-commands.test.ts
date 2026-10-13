/**
 * P8-05 : dépenses (ADR-060 ; SM-EXPENSE ; BR-FIN-020 à 022, BR-DIS-013 ; AV-058, AV-351 à AV-357) —
 * enregistrement en ligne et hors ligne, payée ou à payer ; caisse de PDV (catégorie, plafond, session
 * exigée, `CASH_SESSION_MISSING` résolu à l'ouverture) ; validation a posteriori d'une saisie hors
 * ligne non conforme ; seuils de validation et de justificatif ; coût par l'API d'`inventory` ;
 * paiement ; annulation (contrepassation, frais généraux déjà répartis) ; portée et rejeu.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import { registerExpenseCommands } from '../src/modules/finance/application/commands/expense-commands.js';
import { recordCostEntry } from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  openTestCashSession,
  withoutActivePolicies,
} from './helpers.js';
import {
  balanceOf,
  codeOf,
  conflictsOf,
  eventsOf,
  fund,
  newAccount,
  newActor,
  newPosSite,
  siteCode,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-09';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00');
const FUNDED_AT = at('05:00', '2026-10-08');

describe('P8-05 : dépenses', { timeout: 60_000 }, () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let root: Actor;
  let zoneId: string;
  let fin: Actor;
  let dir: Actor;
  let policyId: string;
  let bank: string;
  const category: Record<string, string> = {};
  let deviceSeq = 0;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: {
      readonly offline?: boolean;
      readonly attachments?: readonly string[];
      readonly commandId?: string;
      readonly aggregateType?: string;
    } = {},
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: options.aggregateType ?? 'EXPENSE',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [...(options.attachments ?? [])],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );

  /** Enregistre une dépense ; renvoie son identifiant et le résultat. */
  const record = async (
    actor: Actor,
    payload: Record<string, unknown>,
    options: Parameters<typeof run>[5] & {
      readonly occurredAt?: string;
      readonly id?: string;
    } = {},
  ) => {
    const id = options.id ?? freshUuid();
    const result = await run(
      actor,
      'finance.expense.record',
      id,
      options.occurredAt ?? at('10:00'),
      payload,
      options,
    );
    return { id, result };
  };

  const expenseRow = (id: string) =>
    db.selectFrom('finance_expenses').selectAll().where('id', '=', toBin(id)).executeTakeFirst();

  const movementsOf = (id: string) =>
    db
      .selectFrom('finance_cash_movements')
      .select(['cash_account_id', 'direction', 'amount_xaf', 'movement_type', 'cash_session_id'])
      .where('source_doc_type', '=', 'EXPENSE')
      .where('source_doc_id', '=', toBin(id))
      .execute();

  const costsOf = async (id: string) => {
    const rows = await db
      .selectFrom('inventory_cost_entries')
      .select([
        'cost_object_type',
        'cost_object_id',
        'cost_type',
        'species_group',
        'amount_xaf',
        'direction',
        'occurred_at',
      ])
      .where('source_type', '=', 'EXPENSE')
      .where((eb) =>
        eb.or([
          eb('source_id', '=', toBin(id)),
          eb(
            'reverses_entry_id',
            'in',
            eb
              .selectFrom('inventory_cost_entries')
              .select('id')
              .where('source_type', '=', 'EXPENSE')
              .where('source_id', '=', toBin(id)),
          ),
        ]),
      )
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      object: row.cost_object_type,
      objectId: fromBin(row.cost_object_id),
      costType: row.cost_type,
      species: row.species_group,
      amount: Number(row.amount_xaf),
      direction: row.direction,
      occurredAt: row.occurred_at.toISOString(),
    }));
  };

  const requestOf = (expenseId: string) =>
    db
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status', 'required_attachment_ids', 'amount_xaf'])
      .where('subject_id', '=', toBin(expenseId))
      .where('operation_type', '=', 'EXPENSE')
      .execute();

  /** Point de vente : site, vendeur du site, caisse de PDV alimentée, session ouverte à 06:00 si demandé. */
  async function newPdv(options: { readonly session?: boolean } = {}) {
    const siteId = await newPosSite(root.userId, zoneId);
    const seller = await newActor('VENDEUR_PDV', root.userId, {
      scopeType: 'SITE',
      scopeSiteId: siteId,
    });
    const pos = await newAccount({ type: 'CAISSE_PDV', responsible: seller.userId, siteId });
    await fund(idGenerator, pos, 100_000, FUNDED_AT, root.userId);
    const sessionId =
      options.session === false
        ? null
        : await tx((trx) =>
            openTestCashSession(trx, {
              cashAccountId: pos,
              siteId,
              openedBy: seller.userId,
              openedAt: new Date(at('06:00')),
            }),
          );
    return { siteId, seller, pos, sessionId };
  }

  /** Lot de production simulé par son lot de stock de traçabilité (origine `PRODUCTION_LOT`). */
  async function newLot(status: 'OPEN' | 'CLOSED' = 'OPEN'): Promise<string> {
    const lotId = freshUuid();
    await db
      .insertInto('inventory_stock_lots')
      .values({
        id: toBin(freshUuid()),
        lot_code: `LOT-${lotId.slice(-12)}`,
        origin_type: 'PRODUCTION_LOT',
        origin_id: toBin(lotId),
        fifo_rank_at: new Date(FUNDED_AT),
        status,
        created_by: toBin(root.userId),
      })
      .execute();
    return lotId;
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerCashSessionCommands(registry, idGenerator, decisions);
    registerExpenseCommands(registry, idGenerator, new DocumentSequenceService());
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    root = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, userId);
      await grantTestPermission(trx, role, 'approvals.policy.manage', userId);
      await assignTestRole(trx, userId, role, userId);
      zoneId = await insertTestZone(trx, userId);
      return { userId, deviceId };
    });
    fin = await newActor('FINANCE', root.userId);
    dir = await newActor('DIRECTION', root.userId);
    bank = await newAccount({ type: 'BANQUE', responsible: fin.userId });
    await fund(idGenerator, bank, 1_000_000, FUNDED_AT, root.userId);

    for (const row of await db
      .selectFrom('finance_expense_categories')
      .select(['id', 'code'])
      .execute()) {
      category[row.code] = fromBin(row.id);
    }

    // Politique propre au fichier, bornée à la journée du test, neutralisée en fin de fichier.
    policyId = freshUuid();
    const policy = await run(
      root,
      'approvals.policy.set',
      policyId,
      at('00:00'),
      {
        code: `EXP-TEST-${policyId.slice(-12)}`,
        operationType: 'EXPENSE',
        requiresApproval: true,
        approverPermission: 'finance.expense.approve',
        approverScope: 'ALL',
        validFrom: at('00:00'),
        validTo: at('00:00', '2026-10-10'),
      },
      { aggregateType: 'CONTROL_POLICY' },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await neutralizePolicy(policyId);
    await closeTestDb();
  });

  it('PDV en session : petite dépense payée, numéro DEP du site, sortie dans la session, événements, flux de l’auteur', async () => {
    const pdv = await newPdv();
    const { id, result } = await record(pdv.seller, {
      categoryId: category.TRANSPORT,
      amountXaf: 2_000,
      description: 'Moto-taxi pour la livraison',
      siteId: pdv.siteId,
      paidNow: true,
      paidFromAccountId: pdv.pos,
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await expenseRow(id);
    expect(row).toMatchObject({
      status: 'PAID',
      amount_xaf: 2_000,
      paid_now: 1,
      review_reasons: null,
    });
    expect(row!.doc_number).toMatch(new RegExp(`^DEP-${await siteCode(pdv.siteId)}-2026-\\d{6}$`));
    const [movement] = await movementsOf(id);
    expect(movement).toMatchObject({
      direction: 'OUT',
      amount_xaf: 2_000,
      movement_type: 'EXPENSE',
    });
    expect(fromBin(movement!.cash_session_id!)).toBe(pdv.sessionId);
    expect(await balanceOf(pdv.pos)).toBe(98_000);
    expect(
      (await eventsOf(id))
        .map((event) => event.eventType)
        .filter((type) => type.startsWith('Expense')),
    ).toEqual(['ExpenseRecorded', 'ExpensePaid']);
    expect(await costsOf(id)).toEqual([]);
    const feed = await db
      .selectFrom('sync_change_feed')
      .select(['scope_type', 'scope_id'])
      .where('dataset', '=', 'cash')
      .where('entity_type', '=', 'EXPENSE')
      .where('entity_id', '=', toBin(id))
      .execute();
    expect(feed.map((line) => [line.scope_type, fromBin(line.scope_id!)])).toEqual([
      ['USER', pdv.seller.userId],
    ]);
  });

  it('PDV en ligne : catégorie non permise, plafond, justificatif, session absente ou close → refus, rien d’écrit', async () => {
    const pdv = await newPdv();
    const base = {
      description: 'x',
      siteId: pdv.siteId,
      paidNow: true,
      paidFromAccountId: pdv.pos,
    };
    const refused = async (
      payload: Record<string, unknown>,
      attachments: readonly string[] = [],
    ) => {
      const { id, result } = await record(pdv.seller, { ...base, ...payload }, { attachments });
      expect(await expenseRow(id)).toBeUndefined();
      return codeOf(result);
    };
    expect(await refused({ categoryId: category.VETERINAIRE, amountXaf: 5_000 })).toBe(
      'EXPENSE_CATEGORY_NOT_ALLOWED_ON_POS',
    );
    expect(
      await refused({ categoryId: category.TRANSPORT, amountXaf: 50_001 }, [freshUuid()]),
    ).toBe('POS_EXPENSE_CAP_EXCEEDED');
    expect(await refused({ categoryId: category.TRANSPORT, amountXaf: 12_000 })).toBe(
      'ATTACHMENT_REQUIRED',
    );
    expect(await refused({ categoryId: category.NON_JUSTIFIEE, amountXaf: 1_000 })).toBe(
      'EXPENSE_CATEGORY_INACTIVE',
    );
    const closed = await newPdv({ session: false });
    const { result } = await record(closed.seller, {
      ...base,
      siteId: closed.siteId,
      paidFromAccountId: closed.pos,
      categoryId: category.TRANSPORT,
      amountXaf: 1_000,
    });
    expect(codeOf(result)).toBe('CASH_SESSION_REQUIRED');
    // Refus précoce, avant toute écriture : aucune session (BR-DIS-005), pas une session close.
    expect(result.status === 'REJECTED' && result.error?.message_fr).toMatch(
      /Aucune session de caisse ouverte/,
    );
    expect(await balanceOf(closed.pos)).toBe(100_000);
  });

  it('PDV hors ligne non conforme : appliquée, validation a posteriori, CASH_SESSION_MISSING résolu par l’ouverture après coup', async () => {
    const pdv = await newPdv({ session: false });
    const { id, result } = await record(
      pdv.seller,
      {
        categoryId: category.VETERINAIRE,
        amountXaf: 60_000,
        description: 'Vaccins achetés au marché',
        siteId: pdv.siteId,
        paidNow: true,
        paidFromAccountId: pdv.pos,
      },
      { offline: true, occurredAt: at('09:00') },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    expect(result.status === 'APPLIED_WITH_WARNINGS' && [...result.warnings].sort()).toEqual([
      'CASH_SESSION_MISSING',
      'EXPENSE_REVIEW_REQUIRED',
    ]);
    const row = await expenseRow(id);
    expect(row?.status).toBe('PAID_PENDING_APPROVAL');
    expect(row?.review_reasons).toEqual([
      'CATEGORY_NOT_ALLOWED_ON_POS',
      'POS_CAP_EXCEEDED',
      'ATTACHMENT_MISSING',
    ]);
    expect(await balanceOf(pdv.pos)).toBe(40_000);
    const [request] = await requestOf(id);
    expect(request).toMatchObject({ status: 'PENDING', amount_xaf: 60_000 });
    expect(fromBin(row!.approval_request_id!)).toBe(fromBin(request!.id));
    expect(await costsOf(id)).toEqual([]);
    expect(await conflictsOf(id, 'CASH_SESSION_MISSING')).toMatchObject([
      { entityType: 'EXPENSE', ownerRole: 'FINANCE', applied: true, status: 'OPEN' },
    ]);
    // Ouverture saisie hors ligne à 07:00, synchronisée après : la dépense de 09:00 est couverte.
    const open = await run(
      pdv.seller,
      'finance.cash_session.open',
      freshUuid(),
      at('07:00'),
      { cashAccountId: pdv.pos, countedXaf: 100_000 },
      { offline: true, aggregateType: 'CASH_SESSION' },
    );
    expect(codeOf(open)).toMatch(/^APPLIED/);
    expect((await conflictsOf(id, 'CASH_SESSION_MISSING'))[0]?.status).toBe('RESOLVED');
  });

  it('caisse personnelle : CASH_INSUFFICIENT en ligne, CASH_NEGATIVE hors ligne ; compte d’un autre et site hors périmètre refusés', async () => {
    const terrain = await newActor('COMMERCIAL_TERRAIN', root.userId, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    const own = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, own, 1_000, FUNDED_AT, root.userId);
    const site = await newPosSite(root.userId, zoneId);
    const payload = {
      categoryId: category.CARBURANT,
      amountXaf: 5_000,
      description: 'Essence',
      siteId: site,
      paidNow: true,
      paidFromAccountId: own,
    };
    expect(codeOf((await record(terrain, payload)).result)).toBe('CASH_INSUFFICIENT');
    const offline = await record(terrain, payload, { offline: true });
    expect(offline.result.status === 'APPLIED_WITH_WARNINGS' && offline.result.warnings).toEqual([
      'CASH_NEGATIVE',
    ]);
    expect(await balanceOf(own)).toBe(-4_000);
    expect(await conflictsOf(own, 'CASH_NEGATIVE')).toHaveLength(1);
    // Caisse d'un autre utilisateur, et site d'une autre zone pour un vendeur de site.
    const other = await newActor('COMMERCIAL_TERRAIN', root.userId, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    expect(codeOf((await record(other, { ...payload, amountXaf: 500 })).result)).toBe(
      'CASH_ACCOUNT_FORBIDDEN',
    );
    const pdv = await newPdv();
    expect(
      codeOf(
        (await record(pdv.seller, { ...payload, paidFromAccountId: pdv.pos, amountXaf: 500 }))
          .result,
      ),
    ).toBe('FORBIDDEN_SCOPE');
  });

  it('à payer sous le seuil, imputée à un lot : RECORDED, coût VETERINAIRE ; payée par la Finance ; payée ne s’annule plus', async () => {
    const lot = await newLot();
    const site = await newPosSite(root.userId, zoneId);
    const { id, result } = await record(
      fin,
      {
        categoryId: category.VETERINAIRE,
        amountXaf: 30_000,
        description: 'Visite du vétérinaire',
        siteId: site,
        costObject: { type: 'PRODUCTION_LOT', id: lot },
        paidNow: false,
      },
      { attachments: [freshUuid()] },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect((await expenseRow(id))?.status).toBe('RECORDED');
    expect(await costsOf(id)).toEqual([
      {
        object: 'PRODUCTION_LOT',
        objectId: lot,
        costType: 'VETERINAIRE',
        species: null,
        amount: 30_000,
        direction: 'DEBIT',
        occurredAt: at('10:00'),
      },
    ]);
    const paid = await run(fin, 'finance.expense.pay', id, at('15:00'), {
      paidFromAccountId: bank,
    });
    expect(paid.status, JSON.stringify(paid)).toBe('APPLIED');
    expect(await expenseRow(id)).toMatchObject({ status: 'PAID', paid_now: 0 });
    expect(await movementsOf(id)).toHaveLength(1);
    expect(
      (await eventsOf(id))
        .map((event) => event.eventType)
        .filter((type) => type.startsWith('Expense')),
    ).toEqual(['ExpenseRecorded', 'ExpensePaid']);
    expect(
      codeOf(await run(fin, 'finance.expense.cancel', id, at('16:00'), { reason: 'Erreur' })),
    ).toBe('EXPENSE_STATUS_INVALID');
    expect(await costsOf(id)).toHaveLength(1);
  });

  it('au-delà du seuil : PENDING_APPROVAL, demande avec justificatif, sans coût ; non payable ; annulée par l’auteur, demande retirée', async () => {
    const site = await newPosSite(root.userId, zoneId);
    const photo = freshUuid();
    const { id, result } = await record(
      fin,
      {
        categoryId: category.ENERGIE_EAU,
        amountXaf: 80_000,
        description: 'Facture d’électricité de la ferme',
        siteId: site,
        costObject: { type: 'SITE', id: site, speciesGroup: 'VOLAILLE' },
        paidNow: false,
      },
      { attachments: [photo] },
    );
    expect(result.status === 'APPLIED' && result.server_refs).toMatchObject({
      status: 'PENDING_APPROVAL',
    });
    const [request] = await requestOf(id);
    expect(request?.status).toBe('PENDING');
    expect(request?.required_attachment_ids).toEqual([photo]);
    expect(await costsOf(id)).toEqual([]);
    expect(
      codeOf(await run(fin, 'finance.expense.pay', id, at('11:00'), { paidFromAccountId: bank })),
    ).toBe('EXPENSE_STATUS_INVALID');
    expect(
      codeOf(await run(fin, 'finance.expense.cancel', id, at('11:30'), { reason: 'Doublon' })),
    ).toBe('APPLIED');
    expect(await expenseRow(id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Doublon' });
    expect((await requestOf(id))[0]?.status).toBe('CANCELLED');
  });

  it('annulation : coût contrepassé à la date de la dépense ; tiers sans droit refusé, approbateur admis ; frais généraux répartis : refus', async () => {
    const lot = await newLot();
    const site = await newPosSite(root.userId, zoneId);
    const { id } = await record(fin, {
      categoryId: category.TRANSPORT,
      amountXaf: 9_000,
      description: 'Transport des poussins',
      siteId: site,
      costObject: { type: 'PRODUCTION_LOT', id: lot },
      paidNow: false,
    });
    const stranger = await newActor('RESP_ACHATS', root.userId);
    expect(
      codeOf(await run(stranger, 'finance.expense.cancel', id, at('12:00'), { reason: 'x' })),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      codeOf(await run(dir, 'finance.expense.cancel', id, at('12:00'), { reason: 'Non engagée' })),
    ).toBe('APPLIED');
    expect(await costsOf(id)).toEqual([
      expect.objectContaining({
        costType: 'DEPENSE_DIRECTE',
        direction: 'DEBIT',
        amount: 9_000,
        occurredAt: at('10:00'),
      }),
      expect.objectContaining({
        costType: 'DEPENSE_DIRECTE',
        direction: 'CREDIT',
        amount: 9_000,
        occurredAt: at('10:00'),
      }),
    ]);

    // Frais généraux d'une espèce : le mois déjà réparti interdit l'annulation (ADR-026).
    const farm = await newPosSite(root.userId, zoneId);
    const overhead = await record(fin, {
      categoryId: category.DIVERS,
      amountXaf: 4_000,
      description: 'Petit matériel de la ferme',
      siteId: farm,
      costObject: { type: 'SITE', id: farm, speciesGroup: 'PORC' },
      paidNow: false,
    });
    expect(await costsOf(overhead.id)).toEqual([
      expect.objectContaining({
        object: 'SITE',
        costType: 'FRAIS_GENERAUX',
        species: 'PORC',
        amount: 4_000,
      }),
    ]);
    await tx((trx) =>
      recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'SITE',
          costObjectId: farm,
          costType: 'FRAIS_GENERAUX',
          speciesGroup: 'PORC',
          amountXaf: 4_000,
          direction: 'CREDIT',
          sourceType: 'ALLOCATION',
          sourceId: freshUuid(),
          occurredAt: new Date(at('20:00')),
          createdBy: root.userId,
        },
      ),
    );
    expect(
      codeOf(await run(fin, 'finance.expense.cancel', overhead.id, at('21:00'), { reason: 'x' })),
    ).toBe('OVERHEAD_ALREADY_ALLOCATED');
  });

  it('objet de coût : lot clos refusé en ligne et mis en revue hors ligne ; lot inconnu refusé', async () => {
    const closed = await newLot('CLOSED');
    const site = await newPosSite(root.userId, zoneId);
    const payload = {
      categoryId: category.TRANSPORT,
      amountXaf: 3_000,
      description: 'Transport',
      siteId: site,
      costObject: { type: 'PRODUCTION_LOT', id: closed },
      paidNow: true,
      paidFromAccountId: bank,
    };
    expect(codeOf((await record(fin, payload)).result)).toBe('COST_OBJECT_CLOSED');
    const offline = await record(fin, payload, { offline: true });
    expect(offline.result.status === 'APPLIED_WITH_WARNINGS' && offline.result.warnings).toEqual([
      'EXPENSE_REVIEW_REQUIRED',
    ]);
    expect(await expenseRow(offline.id)).toMatchObject({
      status: 'PAID_PENDING_APPROVAL',
      review_reasons: ['COST_OBJECT_CLOSED'],
    });
    expect(await costsOf(offline.id)).toEqual([]);
    expect(
      codeOf(
        (
          await record(
            fin,
            { ...payload, costObject: { type: 'PRODUCTION_LOT', id: freshUuid() } },
            { offline: true },
          )
        ).result,
      ),
    ).toBe('COST_OBJECT_UNKNOWN');
  });

  it('sans politique EXPENSE active : aucune validation au-delà du seuil, coût écrit (AV-351)', async () => {
    const lot = await newLot();
    const site = await newPosSite(root.userId, zoneId);
    await withoutActivePolicies('EXPENSE', new Date(at('00:00')), async () => {
      const { id, result } = await record(
        fin,
        {
          categoryId: category.ALIMENT_HORS_STOCK,
          amountXaf: 90_000,
          description: 'Aliment acheté hors stock',
          siteId: site,
          costObject: { type: 'PRODUCTION_LOT', id: lot },
          paidNow: true,
          paidFromAccountId: bank,
        },
        { attachments: [freshUuid()] },
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      expect((await expenseRow(id))?.status).toBe('PAID');
      expect(await requestOf(id)).toEqual([]);
      expect(await costsOf(id)).toEqual([
        expect.objectContaining({ costType: 'ALIMENT', amount: 90_000 }),
      ]);
    });
  });

  it('rejeu du même agrégat sans effet ; référence locale en double : refus en ligne, ignorée hors ligne', async () => {
    const pdv = await newPdv();
    const payload = {
      categoryId: category.FOURNITURES,
      amountXaf: 1_500,
      description: 'Sachets',
      siteId: pdv.siteId,
      paidNow: true,
      paidFromAccountId: pdv.pos,
      localRef: `L-${freshUuid().slice(-8)}`,
    };
    const first = await record(pdv.seller, payload);
    const docNumber = (await expenseRow(first.id))!.doc_number;
    const replay = await record(pdv.seller, payload, { id: first.id });
    expect(replay.result.status === 'APPLIED' && replay.result.server_refs).toMatchObject({
      docNumber,
    });
    expect(await movementsOf(first.id)).toHaveLength(1);
    expect(await balanceOf(pdv.pos)).toBe(98_500);
    expect(codeOf((await record(pdv.seller, payload)).result)).toBe('LOCAL_REF_DUPLICATE');
    const offline = await record(pdv.seller, payload, { offline: true });
    expect(offline.result.status === 'APPLIED_WITH_WARNINGS' && offline.result.warnings).toEqual([
      'LOCAL_REF_DUPLICATE',
    ]);
    expect((await expenseRow(offline.id))?.local_ref).toBeNull();
  });
});
