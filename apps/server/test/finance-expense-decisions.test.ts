/**
 * P8-06 : décisions `EXPENSE` (ADR-042 §2, §7, §8 ; SM-EXPENSE ; BR-FIN-021, BR-FIN-022 ; AV-263,
 * AV-268) — approbation d'une dépense à payer ou déjà payée (coût posé à l'approbation), justificatif
 * reçu avant la décision (BR-ADM-020), auto-approbation interdite, plafond d'approbation par rôle,
 * rejet (dépense payée reclassée `NON_JUSTIFIEE` et imputée au déclarant), retrait refusé.
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
import { registerExpenseCommands } from '../src/modules/finance/application/commands/expense-commands.js';
import { registerExpenseDecisions } from '../src/modules/finance/application/commands/expense-decisions.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { publishDetectionEvent } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { codeEntityId } from '../src/platform/sync/code-entity-id.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import {
  EXPENSE_ATTACHMENT_MISSING_JOB_TYPE,
  ExpenseAttachmentMissingJob,
} from '../src/modules/finance/application/jobs/expense-attachment-missing-job.js';
import { rolledBack } from './communication-test-kit.js';
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
} from './helpers.js';
import {
  balanceOf,
  codeOf,
  eventsOf,
  fund,
  newAccount,
  newActor,
  newPosSite,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-09';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00');
const FUNDED_AT = at('05:00', '2026-10-08');

describe('P8-06 : décisions EXPENSE', { timeout: 60_000 }, () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let root: Actor;
  let zoneId: string;
  let fin: Actor;
  let dir: Actor;
  let bank: string;
  let policyId: string;
  const category: Record<string, string> = {};
  let deviceSeq = 0;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly attachments?: readonly string[] } = {},
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: type.startsWith('approvals.')
          ? type === 'approvals.policy.set'
            ? 'CONTROL_POLICY'
            : 'APPROVAL_REQUEST'
          : 'EXPENSE',
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

  const record = async (
    actor: Actor,
    payload: Record<string, unknown>,
    options: Parameters<typeof run>[5] = {},
  ) => {
    const id = freshUuid();
    const result = await run(actor, 'finance.expense.record', id, at('10:00'), payload, options);
    expect(codeOf(result), JSON.stringify(result)).toMatch(/^APPLIED/);
    const row = await expenseRow(id);
    return { id, requestId: row?.approval_request_id ? fromBin(row.approval_request_id) : null };
  };
  const decide = (
    actor: Actor,
    verb: 'approve' | 'reject' | 'withdraw',
    requestId: string,
    occurredAt = at('15:00'),
  ) =>
    run(actor, `approvals.request.${verb}`, requestId, occurredAt, {
      requestId,
      ...(verb === 'reject' ? { comment: 'Justificatif insuffisant' } : {}),
    });

  const expenseRow = (id: string) =>
    db.selectFrom('finance_expenses').selectAll().where('id', '=', toBin(id)).executeTakeFirst();
  const requestStatus = async (id: string) =>
    (
      await db
        .selectFrom('approvals_approval_requests')
        .select('status')
        .where('id', '=', toBin(id))
        .executeTakeFirstOrThrow()
    ).status;
  const costsOf = (id: string) =>
    db
      .selectFrom('inventory_cost_entries')
      .select(['cost_type', 'amount_xaf', 'direction', 'occurred_at'])
      .where('source_type', '=', 'EXPENSE')
      .where('source_id', '=', toBin(id))
      .execute();
  const namedEvents = async (id: string) =>
    (await eventsOf(id))
      .map((event) => event.eventType)
      .filter((type) => type.startsWith('Expense'));

  async function newLot(): Promise<string> {
    const lotId = freshUuid();
    await db
      .insertInto('inventory_stock_lots')
      .values({
        id: toBin(freshUuid()),
        lot_code: `LOT-${lotId.slice(-12)}`,
        origin_type: 'PRODUCTION_LOT',
        origin_id: toBin(lotId),
        fifo_rank_at: new Date(FUNDED_AT),
        status: 'OPEN',
        created_by: toBin(root.userId),
      })
      .execute();
    return lotId;
  }

  /** Pièce jointe reçue (`AVAILABLE`), écrite directement (hors du flux d'envoi HTTP). */
  async function uploaded(photo: string, ownerId: string): Promise<void> {
    await db
      .insertInto('attachments_attachments')
      .values({
        id: toBin(photo),
        owner_type: 'EXPENSE',
        owner_id: toBin(ownerId),
        kind: 'RECEIPT',
        mime_type: 'image/jpeg',
        size_bytes: 1_000,
        uploaded_bytes: 1_000,
        sha256: 'b'.repeat(64),
        storage_key: `test/${photo}`,
        upload_status: 'AVAILABLE',
        captured_at: new Date(at('09:00')),
        occurred_at: new Date(at('09:00')),
        created_by: toBin(root.userId),
      })
      .execute();
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerExpenseCommands(registry, idGenerator, new DocumentSequenceService());
    registerExpenseDecisions(decisions, idGenerator);
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
    policyId = freshUuid();
    const policy = await run(root, 'approvals.policy.set', policyId, at('00:00'), {
      code: `EXP-DEC-${policyId.slice(-12)}`,
      operationType: 'EXPENSE',
      requiresApproval: true,
      approverPermission: 'finance.expense.approve',
      approverScope: 'ALL',
      validFrom: at('00:00'),
      validTo: at('00:00', '2026-10-10'),
    });
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await neutralizePolicy(policyId);
    await closeTestDb();
  });

  it('à payer au-delà du seuil : justificatif attendu, approuvée par la Direction, coût posé à l’approbation, puis payée', async () => {
    const lot = await newLot();
    const site = await newPosSite(root.userId, zoneId);
    const photo = freshUuid();
    const expense = await record(
      fin,
      {
        categoryId: category.VETERINAIRE,
        amountXaf: 80_000,
        description: 'Traitement du lot',
        siteId: site,
        costObject: { type: 'PRODUCTION_LOT', id: lot },
        paidNow: false,
      },
      { attachments: [photo] },
    );
    expect(await costsOf(expense.id)).toEqual([]);
    // Auto-approbation interdite ; photo non reçue : la décision attend (BR-ADM-020).
    expect(codeOf(await decide(fin, 'approve', expense.requestId!))).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    expect(codeOf(await decide(dir, 'approve', expense.requestId!))).toBe('ATTACHMENT_MISSING');
    await uploaded(photo, expense.id);
    expect(codeOf(await decide(dir, 'approve', expense.requestId!))).toBe('APPLIED');
    expect((await expenseRow(expense.id))?.status).toBe('APPROVED');
    expect(await requestStatus(expense.requestId!)).toBe('APPROVED');
    expect(await costsOf(expense.id)).toEqual([
      {
        cost_type: 'VETERINAIRE',
        amount_xaf: 80_000,
        direction: 'DEBIT',
        occurred_at: new Date(at('10:00')),
      },
    ]);
    expect(
      codeOf(
        await run(fin, 'finance.expense.pay', expense.id, at('16:00'), { paidFromAccountId: bank }),
      ),
    ).toBe('APPLIED');
    expect(await namedEvents(expense.id)).toEqual([
      'ExpenseRecorded',
      'ExpenseApproved',
      'ExpensePaid',
    ]);
  });

  it('payée au-delà du seuil (hors ligne) : approuvée → PAID, coût posé ; rejetée à payer → REJECTED, non payable', async () => {
    const lot = await newLot();
    const site = await newPosSite(root.userId, zoneId);
    const photo = freshUuid();
    const paid = await record(
      fin,
      {
        categoryId: category.ALIMENT_HORS_STOCK,
        amountXaf: 60_000,
        description: 'Aliment d’appoint',
        siteId: site,
        costObject: { type: 'PRODUCTION_LOT', id: lot },
        paidNow: true,
        paidFromAccountId: bank,
      },
      { offline: true, attachments: [photo] },
    );
    expect((await expenseRow(paid.id))?.status).toBe('PAID_PENDING_APPROVAL');
    await uploaded(photo, paid.id);
    expect(codeOf(await decide(dir, 'approve', paid.requestId!))).toBe('APPLIED');
    expect((await expenseRow(paid.id))?.status).toBe('PAID');
    expect(await costsOf(paid.id)).toHaveLength(1);

    const unpaid = await record(
      fin,
      {
        categoryId: category.DIVERS,
        amountXaf: 55_000,
        description: 'Divers',
        siteId: site,
        paidNow: false,
      },
      { attachments: [freshUuid()] },
    );
    expect(codeOf(await decide(dir, 'reject', unpaid.requestId!))).toBe('APPLIED');
    expect(await expenseRow(unpaid.id)).toMatchObject({
      status: 'REJECTED',
      reclassified_category_id: null,
    });
    expect(await requestStatus(unpaid.requestId!)).toBe('REJECTED');
    expect(
      codeOf(
        await run(fin, 'finance.expense.pay', unpaid.id, at('16:00'), { paidFromAccountId: bank }),
      ),
    ).toBe('EXPENSE_STATUS_INVALID');
    expect(await namedEvents(unpaid.id)).toEqual(['ExpenseRecorded', 'ExpenseRejected']);
  });

  it('payée hors ligne non conforme puis rejetée : décaissement conservé, NON_JUSTIFIEE, imputée au déclarant, aucun coût (AV-268)', async () => {
    const site = await newPosSite(root.userId, zoneId);
    const terrain = await newActor('COMMERCIAL_TERRAIN', root.userId, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    const own = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, own, 50_000, FUNDED_AT, root.userId);
    const lot = await newLot();
    const expense = await record(
      terrain,
      {
        categoryId: category.CARBURANT,
        amountXaf: 15_000,
        description: 'Carburant',
        siteId: site,
        costObject: { type: 'PRODUCTION_LOT', id: lot },
        paidNow: true,
        paidFromAccountId: own,
      },
      { offline: true },
    );
    expect(await expenseRow(expense.id)).toMatchObject({
      status: 'PAID_PENDING_APPROVAL',
      review_reasons: ['ATTACHMENT_MISSING'],
    });
    expect(codeOf(await decide(fin, 'reject', expense.requestId!))).toBe('APPLIED');
    const row = await expenseRow(expense.id);
    expect(row?.status).toBe('PAID_REJECTED');
    expect(fromBin(row!.reclassified_category_id!)).toBe(category.NON_JUSTIFIEE);
    expect(fromBin(row!.responsibility_user_id!)).toBe(terrain.userId);
    expect(await balanceOf(own)).toBe(35_000);
    expect(await costsOf(expense.id)).toEqual([]);
    const [rejected] = (await eventsOf(expense.id, 'ExpenseRejected')).map(
      (event) => event.payload,
    );
    expect(rejected).toMatchObject({
      status: 'PAID_REJECTED',
      responsibilityUserId: terrain.userId,
    });
  });

  it('plafond d’approbation par rôle (RC-06) : au-delà, refus et demande en attente ; retrait par le demandeur refusé', async () => {
    const limited = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, root.userId);
      await grantTestPermission(trx, role, 'approvals.request.read', root.userId);
      await grantTestPermission(trx, role, 'finance.expense.approve', root.userId, {
        limits: { maxAmountXaf: 50_000 },
      });
      await assignTestRole(trx, userId, role, root.userId);
      return { userId, deviceId };
    });
    const site = await newPosSite(root.userId, zoneId);
    const photo = freshUuid();
    const expense = await record(
      fin,
      {
        categoryId: category.ENTRETIEN,
        amountXaf: 70_000,
        description: 'Réparation',
        siteId: site,
        paidNow: false,
      },
      { attachments: [photo] },
    );
    await uploaded(photo, expense.id);
    expect(codeOf(await decide(fin, 'withdraw', expense.requestId!))).toBe(
      'EXPENSE_NOT_WITHDRAWABLE',
    );
    expect(codeOf(await decide(limited, 'approve', expense.requestId!))).toBe(
      'APPROVAL_LIMIT_EXCEEDED',
    );
    expect(await requestStatus(expense.requestId!)).toBe('PENDING');
    expect((await expenseRow(expense.id))?.status).toBe('PENDING_APPROVAL');
    expect(codeOf(await decide(dir, 'approve', expense.requestId!))).toBe('APPLIED');
    expect((await expenseRow(expense.id))?.status).toBe('APPROVED');
  });

  it('P9-07 : justificatif de dépense manquant — passe quotidienne à portée EXPENSE, résolue à l’arrivée de la pièce', async () => {
    const site = await newPosSite(root.userId, zoneId);
    const base = { categoryId: category.VETERINAIRE, siteId: site, paidNow: false };
    // Au-dessus du seuil, l'enregistrement exige un justificatif **déclaré** ; ici l'un n'arrive jamais.
    const missing = await record(
      fin,
      { ...base, amountXaf: 80_000, description: 'Sans pièce' },
      { attachments: [freshUuid()] },
    );
    const cancelledExpense = await record(
      fin,
      { ...base, amountXaf: 80_000, description: 'Annulée' },
      { attachments: [freshUuid()] },
    );
    const cancelResult = await run(
      fin,
      'finance.expense.cancel',
      cancelledExpense.id,
      at('11:00'),
      { reason: 'Saisie en double' },
    );
    expect(codeOf(cancelResult), JSON.stringify(cancelResult)).toBe('APPLIED');
    const photo = freshUuid();
    const covered = await record(
      fin,
      { ...base, amountXaf: 80_000, description: 'Avec pièce' },
      { attachments: [photo] },
    );
    await uploaded(photo, covered.id);
    const small = await record(fin, { ...base, amountXaf: 5_000, description: 'Sous le seuil' });
    const receivedAt = (await expenseRow(missing.id))!.received_at_server!;
    const dayMs = 86_400_000;

    const clock = new FixedClock(new Date(receivedAt.getTime() + 2 * dayMs));
    const jobs = new JobHandlerRegistry();
    new ExpenseAttachmentMissingJob(clock, new Uuidv7Generator(clock), jobs).onModuleInit();
    // Créneau propre à l'exécution : un marqueur validé par une exécution antérieure ne masque jamais
    // l'absence du marqueur publié ici.
    const runSlot = freshUuid().slice(-8);
    const runJob = (uow: UnitOfWork, name: string) =>
      jobs.resolve(EXPENSE_ATTACHMENT_MISSING_JOB_TYPE)!(uow, {
        scheduledFor: `${name}|${runSlot}`,
      });
    const mine = [missing.id, covered.id, small.id, cancelledExpense.id];
    const detected = async (uow: UnitOfWork) =>
      (
        await uow
          .selectFrom('platform_domain_events')
          .selectAll()
          .where('event_type', '=', 'AttachmentMissingDetected')
          .where(
            'aggregate_id',
            'in',
            mine.map((id) => toBin(id)),
          )
          .orderBy('seq')
          .execute()
      ).map((row) => toDomainEvent(row));
    const alertOf = (uow: UnitOfWork, key: string) =>
      uow
        .selectFrom('communication_alerts')
        .select(['status', 'resolution_kind', 'occurrences', 'last_pass_id'])
        .where('dedup_key', '=', key)
        .executeTakeFirst();

    await rolledBack(async (uow) => {
      // 2 jours après la réception : en deçà du délai de 7 jours, rien n'est signalé (le marqueur l'est).
      await runJob(uow, 'early');
      expect(await detected(uow)).toEqual([]);

      // 100 jours après : hors de l'horizon de balayage de 90 jours (borne l'ensemble examiné).
      clock.setTo(new Date(receivedAt.getTime() + 100 * dayMs));
      await runJob(uow, 'beyond');
      expect(await detected(uow)).toEqual([]);

      // 7 jours après : seule la dépense au-dessus du seuil et sans pièce disponible l'est.
      clock.setTo(new Date(receivedAt.getTime() + 7 * dayMs + 3_600_000));
      await runJob(uow, 'late');
      await runJob(uow, 'late'); // rejeu du même créneau : aucun doublon
      const events = await detected(uow);
      expect(events).toHaveLength(1); // ni `covered`, ni `small`, ni la dépense annulée
      expect(events[0]!.aggregateId).toBe(missing.id);
      expect(events[0]!.payload).toMatchObject({
        document_type: 'EXPENSE',
        document_id: missing.id,
        days_missing: 7,
        author_user_id: fin.userId,
        site_id: site,
        amount_xaf: 80_000,
        threshold_days: 7,
        pass_id: `ATTACHMENT_MISSING:EXPENSE:late|${runSlot}`,
      });

      // Une alerte du même type levée par une autre portée (réception) : le marqueur de la dépense
      // ne la résout pas.
      const receiptDoc = freshUuid();
      await publishDetectionEvent(uow, idGenerator, {
        eventType: 'AttachmentMissingDetected',
        producerModule: 'procurement',
        aggregateType: 'GOODS_RECEIPT',
        aggregateId: receiptDoc,
        occurredAt: clock.now(),
        passId: 'ATTACHMENT_MISSING:GOODS_RECEIPT:late',
        payload: {
          document_type: 'GOODS_RECEIPT',
          document_id: receiptDoc,
          document_label: 'REC-TEST',
          days_missing: 8,
          author_user_id: fin.userId,
          site_id: site,
          business_day: '2026-10-17',
        },
      });
      const receiptEvent = (
        await uow
          .selectFrom('platform_domain_events')
          .selectAll()
          .where('event_type', '=', 'AttachmentMissingDetected')
          .where('aggregate_id', '=', toBin(receiptDoc))
          .execute()
      ).map((row) => toDomainEvent(row));
      for (const event of [...events, ...receiptEvent]) {
        await handleAlertEvent(uow, event, { idGenerator });
      }
      expect(await alertOf(uow, `ATTACHMENT_MISSING:${missing.id}`)).toMatchObject({
        status: 'OPEN',
        occurrences: 1,
      });

      // La pièce arrive ; la passe suivante ne revoit plus la dépense : son marqueur résout son alerte,
      // jamais celle de la réception.
      await uow
        .insertInto('attachments_attachments')
        .values({
          id: toBin(freshUuid()),
          owner_type: 'EXPENSE',
          owner_id: toBin(missing.id),
          kind: 'RECEIPT',
          mime_type: 'image/jpeg',
          size_bytes: 1_000,
          uploaded_bytes: 1_000,
          sha256: 'c'.repeat(64),
          storage_key: `test/${missing.id}`,
          upload_status: 'AVAILABLE',
          captured_at: clock.now(),
          occurred_at: clock.now(),
          created_by: toBin(root.userId),
        })
        .execute();
      clock.setTo(new Date(receivedAt.getTime() + 8 * dayMs + 3_600_000));
      await runJob(uow, 'next-day');
      const marker = (
        await uow
          .selectFrom('platform_domain_events')
          .selectAll()
          .where('event_type', '=', 'AlertDetectionPassCompleted')
          .where(
            'event_id',
            '=',
            toBin(
              codeEntityId(
                'ALERT_PASS_COMPLETED',
                `ATTACHMENT_MISSING:ATTACHMENT_MISSING:EXPENSE:next-day|${runSlot}`,
              ),
            ),
          )
          .execute()
      ).map((row) => toDomainEvent(row));
      expect(marker).toHaveLength(1);
      expect(marker[0]!.payload).toMatchObject({
        alert_type: 'ATTACHMENT_MISSING',
        scope: 'EXPENSE',
      });
      expect((await detected(uow)).length).toBe(1); // aucune nouvelle détection : la pièce est là
      await handleAlertEvent(uow, marker[0]!, { idGenerator });
      expect(await alertOf(uow, `ATTACHMENT_MISSING:${missing.id}`)).toMatchObject({
        status: 'RESOLVED',
        resolution_kind: 'PASS',
      });
      expect(await alertOf(uow, `ATTACHMENT_MISSING:${receiptDoc}`)).toMatchObject({
        status: 'OPEN',
      });
    });
  });
});
