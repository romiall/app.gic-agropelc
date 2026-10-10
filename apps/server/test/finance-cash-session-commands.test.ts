/**
 * P5-12 — sessions de caisse (ADR-032 ; D05 BR-DIS-005 à 007, §14 ; SM-CASH-SESSION ; BR-FIN-014 ;
 * INV-FIN-02, INV-FIN-05, INV-FIN-06, INV-FIN-11 à la clôture ; AV-154 à AV-156, AV-165, AV-167 à
 * AV-171), à travers le vrai pipeline de commandes :
 * - `finance.cash_session.open` : écart d'ouverture tiré du registre, caisse de PDV seulement, portée,
 *   ouvertures concurrentes (refus en ligne, fusion hors ligne avec conflit), limite du jour ;
 * - `finance.cash_session.close` : attendu par fenêtre, écart, `SESSION_VARIANCE`, statut, observation
 *   d'une clôture concurrente ou datée avant l'ouverture, alias d'une ouverture fusionnée ;
 * - `finance.cash_session.force_close` : en ligne, permission de validation, seuil strict ;
 * - index `cash_session_id` posé par `recordCashMovement` ; gardes de désactivation ; tâche des
 *   sessions ouvertes trop longtemps ; événements explicites ; idempotence et concurrence.
 *
 * Base partagée : chaque test crée son PDV ; dates fixes dans le passé (aucune horloge future) ; les
 * paramètres de test sont des réglages de **site** de ce PDV, jamais globaux.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { registerAccountCommands } from '../src/modules/finance/application/commands/account-commands.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { financeLocationDeactivationGuard } from '../src/modules/finance/application/location-deactivation-guard.js';
import {
  CASH_SESSION_OPEN_LONG_JOB_TYPE,
  CashSessionOpenLongJob,
} from '../src/modules/finance/application/jobs/cash-session-open-long-job.js';
import {
  findCashSessionCovering,
  recordCashMovement,
  verifyCashLedger,
  type CashMovementType,
  type CashSourceDocType,
} from '../src/modules/finance/application/public/index.js';
import { registerSiteCommands } from '../src/modules/organization/application/commands/site-commands.js';
import { registerLocationCommands } from '../src/modules/organization/application/commands/location-commands.js';
import { LocationDeactivationGuardRegistry } from '../src/modules/organization/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-09T20:00:00.000Z';
const t = (day: string, hhmm: string) => `2026-10-0${day}T${hhmm}:00.000Z`;

interface Pos {
  readonly siteId: string;
  readonly locationId: string;
  readonly accountId: string;
  readonly vendor: string;
  readonly vendorDevice: string;
  readonly vendor2: string;
  readonly vendor2Device: string;
}

describe('P5-12 : sessions de caisse (ouverture, clôture, clôture forcée)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let finance: string;
  let financeDevice: string;
  let noPerm: string;
  let noPermDevice: string;
  let vendorRole: string;

  const tx = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(fn);

  interface RunOptions {
    readonly occurredAt: string;
    readonly offline?: boolean;
    readonly aggregateType?: string;
    readonly commandId?: string;
  }

  const envelopeOf = (
    author: string,
    type: string,
    aggregateId: string,
    payload: unknown,
    options: RunOptions,
  ) => ({
    command_id: options.commandId ?? freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: author,
    base_version: null,
    depends_on: [],
    client_created_at: options.occurredAt,
    captured_offline: options.offline ?? false,
    backdated_reason: null,
    attachment_ids: [],
    command_type: type,
    aggregate_type: options.aggregateType ?? 'CASH_SESSION',
    aggregate_id: aggregateId,
    occurred_at: options.occurredAt,
    payload,
  });

  const run = (
    author: string,
    device: string,
    type: string,
    aggregateId: string,
    payload: unknown,
    options: RunOptions,
  ): Promise<CommandResult> =>
    pipeline.handle(envelopeOf(author, type, aggregateId, payload, options), {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
      transport: 'ONLINE_API',
    });

  const codeOf = (result: CommandResult) =>
    result.status === 'REJECTED' ? result.error?.code : result.status;

  // --- Fixtures ----------------------------------------------------------------------------------

  async function createAccount(
    accountType: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = freshUuid();
    const result = await run(
      admin,
      adminDevice,
      'finance.cash_account.create',
      id,
      {
        code: `CPT-${id.slice(-12)}`,
        name: 'Caisse de test',
        accountType,
        responsibleUserId: admin,
        ...extra,
      },
      { occurredAt: t('1', '06:00'), aggregateType: 'CASH_ACCOUNT' },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return id;
  }

  async function newPos(): Promise<Pos> {
    const base = await tx(async (trx) => {
      const zone = await insertTestZone(trx, admin);
      const siteId = await insertTestSite(trx, admin, zone, { siteType: 'POINT_DE_VENTE' });
      const locationId = await insertTestLocation(trx, admin, siteId, { locationType: 'POS' });
      const vendor = await insertTestUser(trx);
      const vendorDevice = await insertTestDevice(trx, vendor);
      const vendor2 = await insertTestUser(trx);
      const vendor2Device = await insertTestDevice(trx, vendor2);
      for (const user of [vendor, vendor2]) {
        await assignTestRole(trx, user, vendorRole, admin, {
          scopeType: 'SITE',
          scopeSiteId: siteId,
        });
      }
      return { siteId, locationId, vendor, vendorDevice, vendor2, vendor2Device };
    });
    return { ...base, accountId: await createAccount('CAISSE_PDV', { siteId: base.siteId }) };
  }

  /** Réglage de site daté dans le passé (jamais global : base partagée). */
  async function siteSetting(siteId: string, key: string, value: number): Promise<void> {
    await db
      .insertInto('organization_system_settings')
      .values({
        id: toBin(freshUuid()),
        key,
        value: jsonValue(value),
        scope_type: 'SITE',
        scope_id: toBin(siteId),
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        is_client_visible: 0,
        reason: 'Réglage de test P5-12',
        created_by: toBin(admin),
      })
      .execute();
  }

  const openSession = (
    pos: Pos,
    countedXaf: number,
    occurredAt: string,
    options: { offline?: boolean; sessionId?: string; author?: string; device?: string } = {},
  ) =>
    run(
      options.author ?? pos.vendor,
      options.device ?? pos.vendorDevice,
      'finance.cash_session.open',
      options.sessionId ?? freshUuid(),
      { cashAccountId: pos.accountId, countedXaf },
      { occurredAt, offline: options.offline ?? false },
    );

  async function openOk(pos: Pos, countedXaf: number, occurredAt: string): Promise<string> {
    const sessionId = freshUuid();
    const result = await openSession(pos, countedXaf, occurredAt, { sessionId });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return sessionId;
  }

  const closeSession = (
    pos: Pos,
    sessionId: string,
    countedXaf: number,
    occurredAt: string,
    options: { offline?: boolean; author?: string; device?: string; comment?: string } = {},
  ) =>
    run(
      options.author ?? pos.vendor,
      options.device ?? pos.vendorDevice,
      'finance.cash_session.close',
      sessionId,
      { countedXaf, ...(options.comment ? { comment: options.comment } : {}) },
      { occurredAt, offline: options.offline ?? false },
    );

  const forceClose = (sessionId: string, countedXaf: number, occurredAt: string, offline = false) =>
    run(
      finance,
      financeDevice,
      'finance.cash_session.force_close',
      sessionId,
      { countedXaf, reason: 'Vendeur absent : comptage déclaré par téléphone' },
      { occurredAt, offline },
    );

  const RULES: Record<string, { direction: 'IN' | 'OUT'; source: CashSourceDocType }> = {
    CUSTOMER_PAYMENT: { direction: 'IN', source: 'CUSTOMER_PAYMENT' },
    REFUND: { direction: 'OUT', source: 'SALE_REFUND' },
    EXPENSE: { direction: 'OUT', source: 'EXPENSE' },
  };

  /** Mouvement injecté dans le registre (encaissement, remboursement, dépense de P8). */
  async function movement(
    accountId: string,
    amountXaf: number,
    occurredAt: string,
    type: CashMovementType = 'CUSTOMER_PAYMENT',
    extra: { cashSessionId?: string; reversesMovementId?: string; sourceDocId?: string } = {},
  ): Promise<string> {
    const rule = RULES[type]!;
    const recorded = await tx((trx) =>
      recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId: accountId,
          direction:
            extra.reversesMovementId !== undefined
              ? rule.direction === 'IN'
                ? 'OUT'
                : 'IN'
              : rule.direction,
          amountXaf,
          movementType: type,
          sourceDocType: rule.source,
          sourceDocId: extra.sourceDocId ?? freshUuid(),
          occurredAt: new Date(occurredAt),
          createdBy: admin,
          allowNegative: true,
          ...(extra.cashSessionId !== undefined ? { cashSessionId: extra.cashSessionId } : {}),
          ...(extra.reversesMovementId !== undefined
            ? { reversesMovementId: extra.reversesMovementId }
            : {}),
        },
      ),
    );
    return recorded.movementId;
  }

  async function session(id: string) {
    return db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function sessionsOf(accountId: string) {
    return db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('cash_account_id', '=', toBin(accountId))
      .orderBy('opened_at')
      .execute();
  }

  async function varianceMovements(sessionId: string) {
    return db
      .selectFrom('finance_cash_movements')
      .select(['id', 'direction', 'amount_xaf', 'occurred_at', 'cash_session_id', 'source_doc_id'])
      .where('movement_type', '=', 'SESSION_VARIANCE')
      .where('source_doc_type', '=', 'CASH_SESSION')
      .where('source_doc_id', '=', toBin(sessionId))
      .orderBy('occurred_at')
      .execute();
  }

  async function movementIndex(movementId: string): Promise<string | null> {
    const row = await db
      .selectFrom('finance_cash_movements')
      .select('cash_session_id')
      .where('id', '=', toBin(movementId))
      .executeTakeFirstOrThrow();
    return row.cash_session_id === null ? null : fromBin(row.cash_session_id);
  }

  async function events(sessionId: string, eventType: string) {
    const rows = await db
      .selectFrom('platform_domain_events')
      .select(['payload', 'producer_module', 'aggregate_type'])
      .where('event_type', '=', eventType)
      .where('aggregate_id', '=', toBin(sessionId))
      .orderBy('seq')
      .execute();
    return rows.map((row) => ({
      ...(row.payload as Record<string, unknown>),
      _producer: row.producer_module,
      _aggregate: row.aggregate_type,
    }));
  }

  async function conflicts(entityId: string, conflictType: string) {
    const rows = await db
      .selectFrom('sync_sync_conflicts')
      .select(['details', 'owner_role', 'applied', 'status', 'entity_type', 'site_id'])
      .where('conflict_type', '=', conflictType)
      .where('entity_id', '=', toBin(entityId))
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      ...row,
      details: row.details as Record<string, unknown>,
      site_id: row.site_id === null ? null : fromBin(row.site_id),
    }));
  }

  /** INV-FIN-11 à la clôture : Σ signée des écarts de clôture = compté − attendu recalculé par fenêtre. */
  async function assertClosingVarianceInvariant(sessionId: string): Promise<void> {
    const row = await session(sessionId);
    const flows = await db
      .selectFrom('finance_cash_movements')
      .select(['direction', 'amount_xaf', 'movement_type'])
      .where('cash_account_id', '=', row.cash_account_id)
      .where('occurred_at', '>=', row.opened_at)
      .where('occurred_at', '<', row.closed_at!)
      .execute();
    const expected = flows
      .filter((flow) => !['SESSION_VARIANCE', 'OPENING_BALANCE'].includes(flow.movement_type))
      .reduce(
        (sum, flow) =>
          sum + (flow.direction === 'IN' ? Number(flow.amount_xaf) : -Number(flow.amount_xaf)),
        Number(row.opening_counted_xaf),
      );
    const closingVariances = (await varianceMovements(sessionId)).filter(
      (m) => m.occurred_at.getTime() === row.closed_at!.getTime(),
    );
    const posted = closingVariances.reduce(
      (sum, m) => sum + (m.direction === 'IN' ? Number(m.amount_xaf) : -Number(m.amount_xaf)),
      0,
    );
    expect(Number(row.closing_expected_xaf)).toBe(expected);
    expect(posted).toBe(Number(row.closing_counted_xaf) - expected);
  }

  const ledgerOk = async (accountId: string) =>
    expect((await verifyCashLedger(db, { cashAccountIds: [accountId] })).ok).toBe(true);

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerAccountCommands(registry);
    registerCashSessionCommands(registry, idGenerator, new ApprovalDecisionHandlerRegistry());
    const guards = new LocationDeactivationGuardRegistry();
    guards.register('finance', financeLocationDeactivationGuard);
    registerSiteCommands(registry, guards);
    registerLocationCommands(registry, guards);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await tx(async (trx) => {
      admin = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin);
      const adminRole = await insertTestRole(trx, admin);
      for (const code of ['finance.cash_account.manage', 'org.structure.manage']) {
        await grantTestPermission(trx, adminRole, code, admin);
      }
      await assignTestRole(trx, admin, adminRole, admin);

      finance = await insertTestUser(trx);
      financeDevice = await insertTestDevice(trx, finance);
      const financeRole = await insertTestRole(trx, admin);
      for (const code of ['finance.cash_session.operate', 'finance.cash_session.validate']) {
        await grantTestPermission(trx, financeRole, code, admin);
      }
      await assignTestRole(trx, finance, financeRole, admin);

      vendorRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, vendorRole, 'finance.cash_session.operate', admin, {
        maxScope: 'SITE',
      });

      noPerm = await insertTestUser(trx);
      noPermDevice = await insertTestDevice(trx, noPerm);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // --- Ouverture ---------------------------------------------------------------------------------

  describe('finance.cash_session.open', () => {
    it('ouverture en ligne : session OPEN, origine et jour métier ; fonds égal au solde du registre, aucun écart', async () => {
      const pos = await newPos();
      await movement(pos.accountId, 20_000, t('5', '18:00'));
      // Encaissement daté après l'ouverture, enregistré avant elle : il n'entre pas dans le solde
      // d'ouverture (registre à `opened_at`, jamais la projection) et n'a pas d'index.
      const later = await movement(pos.accountId, 5_000, t('6', '09:00'));
      const sessionId = freshUuid();
      const result = await openSession(pos, 20_000, t('6', '08:00'), { sessionId });
      expect(result).toMatchObject({
        status: 'APPLIED',
        server_refs: {
          cashSessionId: sessionId,
          openingExpectedXaf: '20000',
          openingVarianceXaf: '0',
          openedAt: t('6', '08:00'),
        },
      });
      const row = await session(sessionId);
      expect(row.status).toBe('OPEN');
      expect(fromBin(row.site_id)).toBe(pos.siteId);
      expect(fromBin(row.opened_by)).toBe(pos.vendor);
      expect(fromBin(row.opened_device_id!)).toBe(pos.vendorDevice);
      expect(row.opened_at.toISOString()).toBe(t('6', '08:00'));
      expect(row.business_date).not.toBeNull();
      expect(Number(row.opening_expected_xaf)).toBe(20_000);
      expect(Number(row.opening_variance_xaf)).toBe(0);
      expect(row.received_at_server).not.toBeNull();
      expect(row.captured_offline).toBe(0);
      expect(row.command_id).not.toBeNull();
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      expect(await movementIndex(later)).toBeNull();
      const opened = await events(sessionId, 'CashSessionOpened');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        _producer: 'finance',
        _aggregate: 'CASH_SESSION',
        opening_counted_xaf: 20_000,
        opening_expected_xaf: 20_000,
        opening_variance_xaf: 0,
      });
      expect(await events(sessionId, 'CashVarianceDetected')).toHaveLength(0);
    });

    it('caisse neuve (AV-156) : fonds de 20 000 sur un solde nul, écart d’ouverture +20 000 posé à l’ouverture', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 20_000, t('6', '07:00'));
      const row = await session(sessionId);
      expect(Number(row.opening_variance_xaf)).toBe(20_000);
      const variances = await varianceMovements(sessionId);
      expect(variances).toHaveLength(1);
      expect(variances[0]).toMatchObject({ direction: 'IN' });
      expect(Number(variances[0]!.amount_xaf)).toBe(20_000);
      expect(variances[0]!.occurred_at.toISOString()).toBe(t('6', '07:00'));
      expect(fromBin(variances[0]!.cash_session_id!)).toBe(sessionId);
      const balance = await db
        .selectFrom('finance_cash_accounts')
        .select('balance_xaf')
        .where('id', '=', toBin(pos.accountId))
        .executeTakeFirstOrThrow();
      expect(Number(balance.balance_xaf)).toBe(20_000);
      await ledgerOk(pos.accountId); // INV-FIN-02
      expect(await events(sessionId, 'CashVarianceDetected')).toEqual([
        expect.objectContaining({
          phase: 'OPENING',
          variance_xaf: 20_000,
          severity: 'CRITICAL',
          imputed_user_id: pos.vendor,
        }),
      ]);
    });

    it('AV-165 : seule une caisse de PDV ouvre une session (en ligne et hors ligne) ; compte inconnu ; compte désactivé', async () => {
      const pos = await newPos();
      const userCash = await createAccount('CAISSE_UTILISATEUR', { holderUserId: pos.vendor });
      for (const offline of [false, true]) {
        const result = await run(
          finance,
          financeDevice,
          'finance.cash_session.open',
          freshUuid(),
          { cashAccountId: userCash, countedXaf: 0 },
          { occurredAt: t('6', '07:00'), offline },
        );
        expect(codeOf(result)).toBe('CASH_SESSION_POS_ACCOUNT_REQUIRED');
      }
      expect(await sessionsOf(userCash)).toHaveLength(0);
      const unknown = await run(
        finance,
        financeDevice,
        'finance.cash_session.open',
        freshUuid(),
        { cashAccountId: freshUuid(), countedXaf: 0 },
        { occurredAt: t('6', '07:00') },
      );
      expect(codeOf(unknown)).toBe('NOT_FOUND');

      // Compte désactivé : refus en ligne ; hors ligne, fait accompli avec avertissement et conflit.
      const deactivated = await run(
        admin,
        adminDevice,
        'finance.cash_account.deactivate',
        pos.accountId,
        {},
        {
          occurredAt: t('6', '06:30'),
          aggregateType: 'CASH_ACCOUNT',
        },
      );
      expect(deactivated.status).toBe('APPLIED');
      expect(codeOf(await openSession(pos, 0, t('6', '07:00')))).toBe('CASH_ACCOUNT_INACTIVE');
      const sessionId = freshUuid();
      const offline = await openSession(pos, 0, t('6', '07:00'), { offline: true, sessionId });
      expect(offline).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_ACCOUNT_INACTIVE'],
      });
      expect((await session(sessionId)).status).toBe('OPEN');
      const [conflict] = await conflicts(sessionId, 'CASH_ACCOUNT_INACTIVE');
      expect(conflict).toMatchObject({ owner_role: 'FINANCE', applied: 1, site_id: pos.siteId });
    });

    it('portée : vendeur d’un autre site → FORBIDDEN_SCOPE (même hors ligne) ; sans permission → FORBIDDEN', async () => {
      const pos = await newPos();
      const other = await newPos();
      for (const offline of [false, true]) {
        const result = await openSession(pos, 0, t('6', '07:00'), {
          offline,
          author: other.vendor,
          device: other.vendorDevice,
        });
        expect(codeOf(result)).toBe('FORBIDDEN_SCOPE');
      }
      const forbidden = await openSession(pos, 0, t('6', '07:00'), {
        author: noPerm,
        device: noPermDevice,
      });
      expect(codeOf(forbidden)).toBe('FORBIDDEN');
      expect(await sessionsOf(pos.accountId)).toHaveLength(0);
    });

    it('INV-FIN-06 et AV-154 : seconde ouverture — refus en ligne, fusion hors ligne avec conflit pour la Finance', async () => {
      const pos = await newPos();
      const first = await openOk(pos, 20_000, t('6', '07:00'));
      const online = await openSession(pos, 20_000, t('6', '07:10'));
      expect(codeOf(online)).toBe('CASH_SESSION_ALREADY_OPEN');

      const proposed = freshUuid();
      const offline = await openSession(pos, 19_000, t('6', '07:20'), {
        offline: true,
        sessionId: proposed,
        author: pos.vendor2,
        device: pos.vendor2Device,
      });
      expect(offline).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
        server_refs: { cashSessionId: first },
      });
      const rows = await sessionsOf(pos.accountId);
      expect(rows).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'OPEN')).toHaveLength(1);
      expect(await varianceMovements(proposed)).toHaveLength(0);
      expect(await varianceMovements(first)).toHaveLength(1); // le fonds initial de la première
      const [conflict] = await conflicts(proposed, 'CASH_SESSION_CONCURRENT_OPEN');
      expect(conflict).toMatchObject({
        owner_role: 'FINANCE',
        applied: 1,
        status: 'OPEN',
        entity_type: 'CASH_SESSION',
        site_id: pos.siteId,
      });
      expect(conflict!.details).toMatchObject({
        outcome: 'MERGED',
        reason: 'OPEN_SESSION_EXISTS',
        targetSessionId: first,
        earlierThanTarget: false,
        countedXaf: 19_000,
        countDifferenceXaf: -1_000,
        authorUserId: pos.vendor2,
        deviceId: pos.vendor2Device,
      });
      expect(await events(proposed, 'CashSessionOpened')).toHaveLength(0);
    });

    it('ouverture dans la fenêtre d’une session close : CASH_SESSION_OVERLAP en ligne, fusion hors ligne, aucune erreur SQL', async () => {
      const pos = await newPos();
      await siteSetting(pos.siteId, 'finance.cash_sessions_per_day_max', 5);
      const first = await openOk(pos, 0, t('6', '07:00'));
      expect((await closeSession(pos, first, 0, t('6', '12:00'))).status).toBe('APPLIED');
      expect(codeOf(await openSession(pos, 0, t('6', '10:00')))).toBe('CASH_SESSION_OVERLAP');
      const proposed = freshUuid();
      const offline = await openSession(pos, 0, t('6', '10:00'), {
        offline: true,
        sessionId: proposed,
      });
      expect(offline).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        server_refs: { cashSessionId: first },
      });
      expect((await conflicts(proposed, 'CASH_SESSION_CONCURRENT_OPEN'))[0]!.details).toMatchObject(
        { reason: 'OVERLAPS_CLOSED_SESSION', targetStatus: 'VALIDATED' },
      );
      expect(await sessionsOf(pos.accountId)).toHaveLength(1);
    });

    it('limite du jour métier (AV-154) : refus en ligne, fusion hors ligne ; réglage de site à 2 ; jour suivant', async () => {
      const pos = await newPos();
      const first = await openOk(pos, 0, t('6', '07:00'));
      expect((await closeSession(pos, first, 0, t('6', '12:00'))).status).toBe('APPLIED');
      expect(codeOf(await openSession(pos, 0, t('6', '13:00')))).toBe('CASH_SESSION_DAILY_LIMIT');
      const proposed = freshUuid();
      expect(
        await openSession(pos, 0, t('6', '13:00'), { offline: true, sessionId: proposed }),
      ).toMatchObject({ status: 'APPLIED_WITH_WARNINGS', server_refs: { cashSessionId: first } });
      expect((await conflicts(proposed, 'CASH_SESSION_CONCURRENT_OPEN'))[0]!.details).toMatchObject(
        { reason: 'DAILY_LIMIT_REACHED' },
      );
      // Jour métier suivant : nouvelle session.
      const nextDay = await openOk(pos, 0, t('7', '07:00'));
      expect((await closeSession(pos, nextDay, 0, t('7', '12:00'))).status).toBe('APPLIED');

      const two = await newPos();
      await siteSetting(two.siteId, 'finance.cash_sessions_per_day_max', 2);
      const morning = await openOk(two, 0, t('6', '07:00'));
      expect((await closeSession(two, morning, 0, t('6', '12:00'))).status).toBe('APPLIED');
      const afternoon = await openOk(two, 0, t('6', '13:00'));
      expect((await closeSession(two, afternoon, 0, t('6', '18:00'))).status).toBe('APPLIED');
      expect(codeOf(await openSession(two, 0, t('6', '19:00')))).toBe('CASH_SESSION_DAILY_LIMIT');
    });

    it('solde d’ouverture à l’instant exact de la clôture précédente porteuse d’un écart de −500 : compté une fois', async () => {
      const pos = await newPos();
      await siteSetting(pos.siteId, 'finance.cash_sessions_per_day_max', 2);
      const first = await openOk(pos, 0, t('6', '07:00'));
      await movement(pos.accountId, 10_000, t('6', '08:00'));
      const closed = await closeSession(pos, first, 9_500, t('6', '12:00'));
      expect(closed).toMatchObject({ server_refs: { varianceXaf: '-500' } });
      const second = freshUuid();
      const reopened = await openSession(pos, 9_500, t('6', '12:00'), { sessionId: second });
      expect(reopened).toMatchObject({
        status: 'APPLIED',
        server_refs: { openingExpectedXaf: '9500', openingVarianceXaf: '0' },
      });
      expect(await varianceMovements(second)).toHaveLength(0);
      await ledgerOk(pos.accountId);
    });

    it('concurrence : deux ouvertures simultanées — en ligne un APPLIED et un refus, hors ligne une session et une fusion', async () => {
      const online = await newPos();
      const results = await Promise.all([
        openSession(online, 0, t('6', '07:00')),
        openSession(online, 0, t('6', '07:00'), {
          author: online.vendor2,
          device: online.vendor2Device,
        }),
      ]);
      expect(results.map(codeOf).sort()).toEqual(['APPLIED', 'CASH_SESSION_ALREADY_OPEN']);
      expect(await sessionsOf(online.accountId)).toHaveLength(1);

      const offline = await newPos();
      const offlineResults = await Promise.all([
        openSession(offline, 0, t('6', '07:00'), { offline: true }),
        openSession(offline, 500, t('6', '07:01'), {
          offline: true,
          author: offline.vendor2,
          device: offline.vendor2Device,
        }),
      ]);
      expect(offlineResults.map((r) => r.status).sort()).toEqual([
        'APPLIED',
        'APPLIED_WITH_WARNINGS',
      ]);
      expect(await sessionsOf(offline.accountId)).toHaveLength(1);
    });

    it('idempotence : rejeu de l’enveloppe (même résultat, une session, un mouvement) ; autre commande sur le même identifiant sans effet', async () => {
      const pos = await newPos();
      const sessionId = freshUuid();
      const envelope = envelopeOf(
        pos.vendor,
        'finance.cash_session.open',
        sessionId,
        { cashAccountId: pos.accountId, countedXaf: 5_000 },
        { occurredAt: t('6', '07:00') },
      );
      const ctx = {
        authenticatedUserId: pos.vendor,
        authenticatedDeviceId: pos.vendorDevice,
        transport: 'ONLINE_API' as const,
      };
      const first = await pipeline.handle(envelope, ctx);
      const replay = await pipeline.handle(envelope, ctx);
      expect(replay).toEqual(first);
      const again = await openSession(pos, 7_000, t('6', '07:05'), { sessionId });
      expect(again).toMatchObject({ status: 'APPLIED', server_refs: { cashSessionId: sessionId } });
      expect(await sessionsOf(pos.accountId)).toHaveLength(1);
      expect(await varianceMovements(sessionId)).toHaveLength(1);
      expect(Number((await session(sessionId)).opening_counted_xaf)).toBe(5_000);
    });

    it('revue P5-12 : ouvertures puis clôtures parallèles de caisses voisines et vierges — aucun interblocage (RETRY_LATER)', async () => {
      // Deux caisses neuves ont des identifiants UUIDv7 voisins : sous la lecture répétable, leurs lectures
      // verrouillantes par plage verrouillaient le même intervalle d'index puis s'attendaient l'une l'autre
      // à l'INSERT (interblocage 1213, 7 tours sur 8 avant correction).
      for (let round = 0; round < 6; round++) {
        const [a, b] = [await newPos(), await newPos()];
        const [sessionA, sessionB] = [freshUuid(), freshUuid()];
        const opened = await Promise.all([
          openSession(a, 20_000, t('6', '07:00'), { sessionId: sessionA }),
          openSession(b, 20_000, t('6', '07:00'), { sessionId: sessionB }),
        ]);
        expect(opened.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
        const closed = await Promise.all([
          closeSession(a, sessionA, 19_000, t('6', '18:00')),
          closeSession(b, sessionB, 19_000, t('6', '18:00')),
        ]);
        expect(closed.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
      }
    });

    it('revue P5-12 : ouverture hors ligne sur un site fermé depuis — session ouverte, avertissement et conflit pour la Finance ; refus en ligne', async () => {
      const pos = await newPos();
      const closedSite = await run(
        admin,
        adminDevice,
        'organization.site.close',
        pos.siteId,
        {},
        { occurredAt: t('6', '18:00'), aggregateType: 'SITE' },
      );
      expect(closedSite.status).toBe('APPLIED');
      expect(codeOf(await openSession(pos, 0, t('6', '07:00')))).toBe('SITE_CLOSED');
      expect(await sessionsOf(pos.accountId)).toHaveLength(0);

      // Ouverture saisie à 07:00 sur la tablette, synchronisée après la fermeture du site à 18:00.
      const sessionId = freshUuid();
      const offline = await openSession(pos, 0, t('6', '07:00'), { offline: true, sessionId });
      expect(offline).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_SITE_CLOSED'],
        server_refs: { cashSessionId: sessionId },
      });
      expect((await session(sessionId)).status).toBe('OPEN');
      const [conflict] = await conflicts(sessionId, 'CASH_SESSION_SITE_CLOSED');
      expect(conflict).toMatchObject({
        owner_role: 'FINANCE',
        applied: 1,
        status: 'OPEN',
        entity_type: 'CASH_SESSION',
        site_id: pos.siteId,
      });
      expect(conflict!.details).toMatchObject({
        siteStatus: 'CLOSED',
        cashAccountId: pos.accountId,
        countedXaf: 0,
        authorUserId: pos.vendor,
        deviceId: pos.vendorDevice,
      });
      // La session reste clôturable (rien n'est perdu).
      expect(
        (await closeSession(pos, sessionId, 0, t('6', '19:00'), { offline: true })).status,
      ).toBe('APPLIED');
    });

    it('revue P5-12 : caisse désactivée — ouverture hors ligne avec fonds (écart posé), puis clôture en ligne avec écart : faits accomplis, registre cohérent', async () => {
      const pos = await newPos();
      const deactivated = await run(
        admin,
        adminDevice,
        'finance.cash_account.deactivate',
        pos.accountId,
        {},
        { occurredAt: t('6', '06:30'), aggregateType: 'CASH_ACCOUNT' },
      );
      expect(deactivated.status).toBe('APPLIED');

      const sessionId = freshUuid();
      const opened = await openSession(pos, 20_000, t('6', '07:00'), { offline: true, sessionId });
      expect(opened).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_ACCOUNT_INACTIVE'],
        server_refs: { openingVarianceXaf: '20000' },
      });
      expect(await varianceMovements(sessionId)).toHaveLength(1);

      // Clôture EN LIGNE sur la caisse désactivée : l'écart de clôture est posé (`pastFact`), la session
      // ne reste pas ouverte faute d'un mouvement refusé (CASH_ACCOUNT_INACTIVE).
      const closed = await closeSession(pos, sessionId, 19_000, t('6', '18:00'));
      expect(closed).toMatchObject({
        status: 'APPLIED',
        server_refs: {
          closingExpectedXaf: '20000',
          varianceXaf: '-1000',
          status: 'PENDING_VALIDATION',
        },
      });
      const variances = await varianceMovements(sessionId);
      expect(variances.map((v) => `${v.direction}:${Number(v.amount_xaf)}`)).toEqual([
        'IN:20000',
        'OUT:1000',
      ]);
      await assertClosingVarianceInvariant(sessionId);
      await ledgerOk(pos.accountId);
    });

    it('revue P5-12 : montant compté démesuré face à un registre négatif — refus CASH_AMOUNT_INVALID, jamais une commande rejouée sans fin', async () => {
      const huge = Number.MAX_SAFE_INTEGER;
      // Ouverture : solde négatif du registre (dépense antérieure, fait accompli hors ligne, BR-FIN-012).
      const negative = await newPos();
      await movement(negative.accountId, 500, t('5', '12:00'), 'EXPENSE');
      for (const offline of [false, true]) {
        const result = await openSession(negative, huge, t('6', '07:00'), { offline });
        expect(codeOf(result)).toBe('CASH_AMOUNT_INVALID');
      }
      expect(await sessionsOf(negative.accountId)).toHaveLength(0);

      // Clôture ordinaire, hors ligne et forcée : attendu négatif (dépense dans la fenêtre).
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('5', '07:00'));
      await movement(pos.accountId, 500, t('5', '12:00'), 'EXPENSE');
      for (const offline of [false, true]) {
        const result = await closeSession(pos, sessionId, huge, t('5', '18:00'), { offline });
        expect(codeOf(result)).toBe('CASH_AMOUNT_INVALID');
      }
      expect(codeOf(await forceClose(sessionId, huge, t('6', '13:00')))).toBe(
        'CASH_AMOUNT_INVALID',
      );
      expect((await session(sessionId)).status).toBe('OPEN');
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      // Un comptage réel referme ensuite la session.
      expect(await closeSession(pos, sessionId, 0, t('5', '18:00'))).toMatchObject({
        status: 'APPLIED',
        server_refs: { closingExpectedXaf: '-500', varianceXaf: '500' },
      });
    });
  });

  // --- Clôture -----------------------------------------------------------------------------------

  describe('finance.cash_session.close', () => {
    it('vecteur WF-15 (part session ; la remise relève de P5-15) : attendu 193 500, compté 193 000, écart −500 (AT-031, première moitié)', async () => {
      const pos = await newPos();
      await movement(pos.accountId, 13_000, t('5', '17:00'));
      await movement(pos.accountId, 7_000, t('6', '05:00')); // avant l'ouverture : solde d'ouverture
      const sessionId = await openOk(pos, 20_000, t('6', '07:00'));
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      await movement(pos.accountId, 100_000, t('6', '09:00'));
      await movement(pos.accountId, 80_000, t('6', '14:00'));
      await movement(pos.accountId, 4_500, t('6', '15:00'), 'REFUND');
      // Dépense de P8 payée par la caisse, injectée (BR-DIS-013).
      await movement(pos.accountId, 2_000, t('6', '16:00'), 'EXPENSE');
      // Un mouvement daté après la clôture (hors fenêtre) rend la clôture suspecte : voir les tests AV-171.

      const result = await closeSession(pos, sessionId, 193_000, t('6', '18:00'), {
        comment: 'Billet de 500 manquant',
      });
      expect(result).toMatchObject({
        status: 'APPLIED',
        server_refs: {
          cashSessionId: sessionId,
          closingExpectedXaf: '193500',
          varianceXaf: '-500',
          status: 'PENDING_VALIDATION',
        },
      });
      const row = await session(sessionId);
      expect(row).toMatchObject({
        status: 'PENDING_VALIDATION',
        auto_validated: 0,
        force_closed: 0,
      });
      expect(Number(row.closing_counted_xaf)).toBe(193_000);
      expect(Number(row.closing_expected_xaf)).toBe(193_500);
      expect(Number(row.variance_xaf)).toBe(-500);
      expect(fromBin(row.closed_by!)).toBe(pos.vendor);
      expect(fromBin(row.closed_device_id!)).toBe(pos.vendorDevice);
      expect(row.validated_at).toBeNull();
      // P5-13 : la session à valider porte sa demande CASH_VARIANCE (sujet : la session, demandeur : le
      // clôtureur, montant : |écart| ; voir finance-cash-session-validation.test.ts).
      expect(row.approval_request_id).not.toBeNull();
      const request = await db
        .selectFrom('approvals_approval_requests')
        .select([
          'operation_type',
          'subject_type',
          'subject_id',
          'status',
          'amount_xaf',
          'requested_by',
        ])
        .where('id', '=', row.approval_request_id!)
        .executeTakeFirstOrThrow();
      expect(request).toMatchObject({
        operation_type: 'CASH_VARIANCE',
        subject_type: 'CASH_SESSION',
        status: 'PENDING',
      });
      expect(fromBin(request.subject_id)).toBe(sessionId);
      // Montant : écarts d'ouverture et de clôture en valeur absolue.
      expect(Number(request.amount_xaf)).toBe(Math.abs(Number(row.opening_variance_xaf)) + 500);
      expect(fromBin(request.requested_by)).toBe(pos.vendor);
      expect(row.close_command_id).not.toBeNull();
      const [variance] = await varianceMovements(sessionId);
      expect(variance).toMatchObject({ direction: 'OUT' });
      expect(Number(variance!.amount_xaf)).toBe(500);
      expect(variance!.occurred_at.toISOString()).toBe(t('6', '18:00'));
      await assertClosingVarianceInvariant(sessionId); // INV-FIN-11 à la clôture
      await ledgerOk(pos.accountId);

      expect(await events(sessionId, 'CashSessionClosed')).toEqual([
        expect.objectContaining({
          closing_expected_xaf: 193_500,
          closing_counted_xaf: 193_000,
          variance_xaf: -500,
          status: 'PENDING_VALIDATION',
          auto_validated: false,
          forced: false,
          comment: 'Billet de 500 manquant',
        }),
      ]);
      expect(await events(sessionId, 'CashVarianceDetected')).toEqual([
        expect.objectContaining({
          phase: 'CLOSING',
          variance_xaf: -500,
          severity: 'WARNING',
          imputed_user_id: pos.vendor,
        }),
      ]);
      const audit = await db
        .selectFrom('audit_audit_log')
        .select('after')
        .where('action', '=', 'finance.cash_session.close')
        .where('entity_id', '=', toBin(sessionId))
        .executeTakeFirstOrThrow();
      expect(audit.after).toMatchObject({ countedXaf: 193_000, closingExpectedXaf: 193_500 });
    });

    it('ADR-032 §2 : un encaissement de 09:00 enregistré avant l’ouverture hors ligne de 08:00 est compté dans l’attendu (index NULL)', async () => {
      const pos = await newPos();
      const early = await movement(pos.accountId, 5_000, t('6', '09:00'));
      const sessionId = freshUuid();
      expect(
        (await openSession(pos, 0, t('6', '08:00'), { offline: true, sessionId })).status,
      ).toBe('APPLIED');
      const closed = await closeSession(pos, sessionId, 5_000, t('6', '17:00'), { offline: true });
      expect(closed).toMatchObject({
        server_refs: { closingExpectedXaf: '5000', varianceXaf: '0', status: 'VALIDATED' },
      });
      expect(await movementIndex(early)).toBeNull();
    });

    it('statut : écarts nuls → validée d’office ; écart d’ouverture seul → à valider ; tolérance de site ; gravité critique', async () => {
      const zero = await newPos();
      const s1 = await openOk(zero, 0, t('6', '07:00'));
      await closeSession(zero, s1, 0, t('6', '18:00'));
      const row1 = await session(s1);
      expect(row1).toMatchObject({ status: 'VALIDATED', auto_validated: 1 });
      expect(row1.validated_at!.toISOString()).toBe(t('6', '18:00'));
      expect(row1.validated_by).toBeNull();
      expect(await varianceMovements(s1)).toHaveLength(0);
      expect(await events(s1, 'CashVarianceDetected')).toHaveLength(0);

      const openingOnly = await newPos();
      const s2 = await openOk(openingOnly, 20_000, t('6', '07:00')); // fonds initial
      await closeSession(openingOnly, s2, 20_000, t('6', '18:00'));
      expect((await session(s2)).status).toBe('PENDING_VALIDATION');

      const tolerant = await newPos();
      await siteSetting(tolerant.siteId, 'finance.cash_variance_tolerance_xaf', 1_000);
      const s3 = await openOk(tolerant, 0, t('6', '07:00'));
      await movement(tolerant.accountId, 10_000, t('6', '09:00'));
      await closeSession(tolerant, s3, 9_500, t('6', '18:00'));
      const row3 = await session(s3);
      expect(row3).toMatchObject({ status: 'VALIDATED', auto_validated: 1 });
      expect(Number(row3.variance_xaf)).toBe(-500);
      expect(await varianceMovements(s3)).toHaveLength(1); // INV-FIN-11 : l'écart toléré est posé
      await assertClosingVarianceInvariant(s3);

      const big = await newPos();
      const s4 = await openOk(big, 0, t('6', '07:00'));
      await movement(big.accountId, 50_000, t('6', '09:00'));
      await closeSession(big, s4, 38_000, t('6', '18:00'));
      expect(await events(s4, 'CashVarianceDetected')).toEqual([
        expect.objectContaining({ variance_xaf: -12_000, severity: 'CRITICAL' }),
      ]);
    });

    it('clôture d’une session déjà close : refus en ligne ; hors ligne, observation (session validée inchangée, INV-FIN-05)', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      await closeSession(pos, sessionId, 0, t('6', '18:00'));
      const before = await session(sessionId);
      expect(before.status).toBe('VALIDATED');
      expect(codeOf(await closeSession(pos, sessionId, 100, t('6', '18:30')))).toBe(
        'CASH_SESSION_NOT_OPEN',
      );
      const observed = await closeSession(pos, sessionId, 100, t('6', '18:30'), {
        offline: true,
        author: pos.vendor2,
        device: pos.vendor2Device,
      });
      expect(observed).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_CONCURRENT_CLOSE'],
        server_refs: { cashSessionId: sessionId, status: 'VALIDATED' },
      });
      const after = await session(sessionId);
      expect(after.version).toBe(before.version);
      expect(after.closed_at!.getTime()).toBe(before.closed_at!.getTime());
      expect(Number(after.closing_counted_xaf)).toBe(0);
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      const [conflict] = await conflicts(sessionId, 'CASH_SESSION_CONCURRENT_CLOSE');
      expect(conflict).toMatchObject({ owner_role: 'FINANCE', applied: 1 });
      expect(conflict!.details).toMatchObject({
        reason: 'ALREADY_CLOSED',
        countedXaf: 100,
        existingStatus: 'VALIDATED',
        existingCountedXaf: 0,
        existingForced: false,
        authorUserId: pos.vendor2,
      });
    });

    it('AV-169 : clôture datée avant l’ouverture — refus en ligne ; hors ligne, observation et session laissée ouverte', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '09:00'));
      expect(codeOf(await closeSession(pos, sessionId, 0, t('6', '08:00')))).toBe(
        'CASH_SESSION_CLOSE_BEFORE_OPEN',
      );
      const observed = await closeSession(pos, sessionId, 0, t('6', '08:00'), { offline: true });
      expect(observed).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_CONCURRENT_CLOSE'],
      });
      expect((await session(sessionId)).status).toBe('OPEN');
      expect(
        (await conflicts(sessionId, 'CASH_SESSION_CONCURRENT_CLOSE'))[0]!.details,
      ).toMatchObject({ reason: 'CLOSE_BEFORE_OPEN', existingStatus: 'OPEN' });
      // Une clôture ultérieure valide referme la session.
      expect((await closeSession(pos, sessionId, 0, t('6', '18:00'))).status).toBe('APPLIED');
    });

    it('alias : la clôture d’un identifiant fusionné clôt la session retenue ; identifiant inconnu → NOT_FOUND', async () => {
      const pos = await newPos();
      const real = await openOk(pos, 0, t('6', '07:00'));
      const alias = freshUuid();
      await openSession(pos, 0, t('6', '07:30'), {
        offline: true,
        sessionId: alias,
        author: pos.vendor2,
        device: pos.vendor2Device,
      });
      const closed = await closeSession(pos, alias, 0, t('6', '18:00'), {
        offline: true,
        author: pos.vendor2,
        device: pos.vendor2Device,
      });
      expect(closed).toMatchObject({ status: 'APPLIED', server_refs: { cashSessionId: real } });
      const row = await session(real);
      expect(row.status).toBe('VALIDATED');
      // AV-155 : l'écart est imputé à celui qui clôture ; ici un second vendeur du site.
      expect(fromBin(row.closed_by!)).toBe(pos.vendor2);
      const audit = await db
        .selectFrom('audit_audit_log')
        .select('after')
        .where('action', '=', 'finance.cash_session.close')
        .where('entity_id', '=', toBin(alias))
        .executeTakeFirstOrThrow();
      expect(audit.after).toMatchObject({ cashSessionId: real, aliasOf: alias });
      expect(codeOf(await closeSession(pos, freshUuid(), 0, t('6', '18:00')))).toBe('NOT_FOUND');
    });

    it('AV-155 : un second vendeur du site clôture — écart imputé au clôtureur', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      await movement(pos.accountId, 1_000, t('6', '08:00'));
      await closeSession(pos, sessionId, 900, t('6', '18:00'), {
        author: pos.vendor2,
        device: pos.vendor2Device,
      });
      expect(fromBin((await session(sessionId)).closed_by!)).toBe(pos.vendor2);
      expect((await events(sessionId, 'CashVarianceDetected'))[0]).toMatchObject({
        imputed_user_id: pos.vendor2,
        closed_by: pos.vendor2,
        opened_by: pos.vendor,
      });
    });

    it('concurrence d’une clôture et d’un encaissement daté dans la fenêtre : attendu E ou E + montant, index de la session', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      await movement(pos.accountId, 10_000, t('6', '09:00'));
      const [closed, late] = await Promise.all([
        closeSession(pos, sessionId, 10_000, t('6', '18:00')),
        movement(pos.accountId, 1_000, t('6', '17:00')),
      ]);
      expect(closed.status).toBe('APPLIED');
      const expected = Number((await session(sessionId)).closing_expected_xaf);
      expect([10_000, 11_000]).toContain(expected);
      expect(await movementIndex(late)).toBe(sessionId);
      await ledgerOk(pos.accountId);
    });

    it('AV-171 : clôture en ligne antidatée avant des encaissements — refusée sans effet ; à l’heure réelle, acceptée', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '08:00'));
      await movement(pos.accountId, 10_000, t('6', '09:00'));
      await movement(pos.accountId, 50_000, t('6', '17:00'));
      // Antidatée à 10:00 : l'attendu tronqué (10 000) serait compté sans écart et validé d'office,
      // les 50 000 de 17:00 restant dans la poche du vendeur.
      const antedated = await closeSession(pos, sessionId, 10_000, t('6', '10:00'));
      expect(codeOf(antedated)).toBe('CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT');
      expect((await session(sessionId)).status).toBe('OPEN');
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      expect(await events(sessionId, 'CashSessionClosed')).toHaveLength(0);
      expect(await conflicts(sessionId, 'CASH_SESSION_CLOSE_BEFORE_MOVEMENTS')).toHaveLength(0);

      const real = await closeSession(pos, sessionId, 60_000, t('6', '17:30'));
      expect(real).toMatchObject({
        status: 'APPLIED',
        server_refs: { closingExpectedXaf: '60000', varianceXaf: '0', status: 'VALIDATED' },
      });
    });

    it('AV-171 : borne exacte — un mouvement daté à l’instant de la clôture la fait refuser ; un instant plus tard, acceptée ; les écarts ne comptent pas', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '08:00'));
      await movement(pos.accountId, 4_000, t('6', '12:00'));
      expect(codeOf(await closeSession(pos, sessionId, 4_000, t('6', '12:00')))).toBe(
        'CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT',
      );
      expect(await closeSession(pos, sessionId, 4_000, '2026-10-06T12:00:00.001Z')).toMatchObject({
        status: 'APPLIED',
        server_refs: { closingExpectedXaf: '4000' },
      });

      // Le SESSION_VARIANCE d'ouverture, posé à l'instant de l'ouverture, n'est pas un mouvement à craindre.
      const instant = await newPos();
      const fund = await openOk(instant, 20_000, t('6', '07:00'));
      expect(await closeSession(instant, fund, 20_000, t('6', '07:00'))).toMatchObject({
        status: 'APPLIED',
        server_refs: { closingExpectedXaf: '20000', varianceXaf: '0' },
      });
    });

    it('AV-171 : clôture hors ligne antidatée — appliquée, jamais validée d’office, conflit pour la Finance ; clôture ordinaire inchangée', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '08:00'));
      await movement(pos.accountId, 10_000, t('6', '10:00'));
      // Encaissement daté après la clôture, enregistré avant elle : hors de la fenêtre, indexé à la session.
      const late = await movement(pos.accountId, 5_000, t('6', '17:00'));
      expect(await movementIndex(late)).toBe(sessionId);

      const closed = await closeSession(pos, sessionId, 10_000, t('6', '12:00'), { offline: true });
      expect(closed).toMatchObject({
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_CLOSE_BEFORE_MOVEMENTS'],
        server_refs: {
          closingExpectedXaf: '10000',
          varianceXaf: '0',
          status: 'PENDING_VALIDATION',
        },
      });
      const row = await session(sessionId);
      expect(row).toMatchObject({ status: 'PENDING_VALIDATION', auto_validated: 0 });
      expect(row.validated_at).toBeNull();
      expect(await movementIndex(late)).toBe(sessionId); // l'index n'est jamais réécrit
      const [conflict] = await conflicts(sessionId, 'CASH_SESSION_CLOSE_BEFORE_MOVEMENTS');
      expect(conflict).toMatchObject({
        owner_role: 'FINANCE',
        applied: 1,
        status: 'OPEN',
        entity_type: 'CASH_SESSION',
        site_id: pos.siteId,
      });
      expect(conflict!.details).toMatchObject({
        closedAt: t('6', '12:00'),
        latestMovementAt: t('6', '17:00'),
        countedXaf: 10_000,
        closingExpectedXaf: 10_000,
        varianceXaf: 0,
        status: 'PENDING_VALIDATION',
        forced: false,
        capturedOffline: true,
        authorUserId: pos.vendor,
      });
      await assertClosingVarianceInvariant(sessionId);
      await ledgerOk(pos.accountId);

      // Clôture hors ligne postérieure à tous les mouvements : validée d'office, sans conflit.
      const clean = await newPos();
      const cleanId = await openOk(clean, 0, t('6', '08:00'));
      await movement(clean.accountId, 10_000, t('6', '10:00'));
      expect(
        await closeSession(clean, cleanId, 10_000, t('6', '18:00'), { offline: true }),
      ).toMatchObject({
        status: 'APPLIED',
        server_refs: { status: 'VALIDATED' },
      });
      expect(await conflicts(cleanId, 'CASH_SESSION_CLOSE_BEFORE_MOVEMENTS')).toHaveLength(0);
    });
  });

  // --- Clôture forcée ----------------------------------------------------------------------------

  describe('finance.cash_session.force_close', () => {
    it('en ligne seulement, permission de validation, seuil strict de 24 h ; statut toujours à valider', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('5', '07:00'));
      await movement(pos.accountId, 30_000, t('5', '10:00'));
      expect(codeOf(await forceClose(sessionId, 30_000, t('6', '13:00'), true))).toBe(
        'ONLINE_REQUIRED',
      );
      const byVendor = await run(
        pos.vendor,
        pos.vendorDevice,
        'finance.cash_session.force_close',
        sessionId,
        { countedXaf: 0, reason: 'x' },
        { occurredAt: t('6', '13:00') },
      );
      expect(codeOf(byVendor)).toBe('FORBIDDEN');
      expect(codeOf(await forceClose(sessionId, 30_000, t('6', '06:00')))).toBe(
        'CASH_SESSION_FORCE_CLOSE_TOO_EARLY',
      );
      expect(codeOf(await forceClose(sessionId, 30_000, t('6', '07:00')))).toBe(
        'CASH_SESSION_FORCE_CLOSE_TOO_EARLY',
      ); // exactement 24 h : borne stricte (« plus de 24 h »)

      const forced = await forceClose(sessionId, 29_000, t('6', '13:00'));
      expect(forced).toMatchObject({
        status: 'APPLIED',
        server_refs: { varianceXaf: '-1000', status: 'PENDING_VALIDATION' },
      });
      const row = await session(sessionId);
      expect(row).toMatchObject({
        status: 'PENDING_VALIDATION',
        force_closed: 1,
        auto_validated: 0,
      });
      expect(fromBin(row.forced_by!)).toBe(finance);
      expect(fromBin(row.closed_by!)).toBe(finance);
      expect(row.closed_at!.toISOString()).toBe(t('6', '13:00'));
      expect(await varianceMovements(sessionId)).toHaveLength(1);
      await assertClosingVarianceInvariant(sessionId);
      expect((await events(sessionId, 'CashSessionClosed'))[0]).toMatchObject({
        forced: true,
        forced_by: finance,
        reason: 'Vendeur absent : comptage déclaré par téléphone',
      });
      // AV-170 : écart d'une clôture forcée imputé à l'ouvreur, pas à l'agent de la Finance.
      expect((await events(sessionId, 'CashVarianceDetected'))[0]).toMatchObject({
        imputed_user_id: pos.vendor,
        forced: true,
      });
      const audit = await db
        .selectFrom('audit_audit_log')
        .select('after')
        .where('action', '=', 'finance.cash_session.force_close')
        .where('entity_id', '=', toBin(sessionId))
        .where('result', '=', 'SUCCESS')
        .executeTakeFirstOrThrow();
      expect(audit.after).toMatchObject({
        reason: 'Vendeur absent : comptage déclaré par téléphone',
        countedXaf: 29_000,
        forced: true,
      });

      // Clôture hors ligne du vendeur, arrivée ensuite : observation (existingForced).
      const late = await closeSession(pos, sessionId, 30_000, t('6', '18:00'), { offline: true });
      expect(late).toMatchObject({ warnings: ['CASH_SESSION_CONCURRENT_CLOSE'] });
      expect(
        (await conflicts(sessionId, 'CASH_SESSION_CONCURRENT_CLOSE'))[0]!.details,
      ).toMatchObject({ existingForced: true, existingStatus: 'PENDING_VALIDATION' });
      expect(codeOf(await forceClose(sessionId, 0, t('7', '13:00')))).toBe('CASH_SESSION_NOT_OPEN');
    });

    it('écart nul : à valider quand même ; seuil de site à 12 h respecté', async () => {
      const pos = await newPos();
      await siteSetting(pos.siteId, 'finance.cash_session_force_close_hours', 12);
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      expect(codeOf(await forceClose(sessionId, 0, t('6', '18:00')))).toBe(
        'CASH_SESSION_FORCE_CLOSE_TOO_EARLY',
      );
      expect(await forceClose(sessionId, 0, t('6', '20:00'))).toMatchObject({
        status: 'APPLIED',
        server_refs: { varianceXaf: '0', status: 'PENDING_VALIDATION' },
      });
      expect(await varianceMovements(sessionId)).toHaveLength(0);
    });

    it('AV-171 : clôture forcée antidatée avant un mouvement enregistré — refusée sans effet ; à l’heure réelle, acceptée', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('5', '07:00'));
      await movement(pos.accountId, 30_000, t('6', '12:00'));
      expect(codeOf(await forceClose(sessionId, 0, t('6', '10:00')))).toBe(
        'CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT',
      );
      const row = await session(sessionId);
      expect(row.status).toBe('OPEN');
      expect(row.force_closed).toBe(0);
      expect(await varianceMovements(sessionId)).toHaveLength(0);
      expect(await forceClose(sessionId, 30_000, t('6', '13:00'))).toMatchObject({
        status: 'APPLIED',
        server_refs: {
          closingExpectedXaf: '30000',
          varianceXaf: '0',
          status: 'PENDING_VALIDATION',
        },
      });
    });
  });

  // --- Index cash_session_id ---------------------------------------------------------------------

  describe('index cash_session_id posé par recordCashMovement (ADR-032 §2)', () => {
    it('fenêtre ouverte, avant l’ouverture, fenêtre close, autre type de compte, valeur explicite, inverse, bornes', async () => {
      const pos = await newPos();
      await siteSetting(pos.siteId, 'finance.cash_sessions_per_day_max', 3);
      const before = await movement(pos.accountId, 1_000, t('6', '06:00'));
      const s1 = await openOk(pos, 1_000, t('6', '07:00'));
      const inWindow = await movement(pos.accountId, 2_000, t('6', '08:00'));
      await closeSession(pos, s1, 3_000, t('6', '12:00'));
      const s2 = await openOk(pos, 3_000, t('6', '13:00'));
      const inClosed = await movement(pos.accountId, 500, t('6', '11:00')); // tardif, fenêtre de s1
      const inS2 = await movement(pos.accountId, 700, t('6', '14:00'));
      expect(await movementIndex(before)).toBeNull();
      expect(await movementIndex(inWindow)).toBe(s1);
      expect(await movementIndex(inClosed)).toBe(s1);
      expect(await movementIndex(inS2)).toBe(s2);
      // Valeur explicite conservée.
      const explicit = await movement(pos.accountId, 100, t('6', '15:00'), 'CUSTOMER_PAYMENT', {
        cashSessionId: s1,
      });
      expect(await movementIndex(explicit)).toBe(s1);
      // Inverse (AV-157) : l'index de l'original, quelle que soit la date de la décision.
      const sourceDocId = freshUuid();
      const original = await movement(pos.accountId, 400, t('6', '09:00'), 'CUSTOMER_PAYMENT', {
        sourceDocId,
      });
      expect(await movementIndex(original)).toBe(s1);
      const reversal = await movement(pos.accountId, 400, t('6', '15:30'), 'CUSTOMER_PAYMENT', {
        sourceDocId,
        reversesMovementId: original,
      });
      expect(await movementIndex(reversal)).toBe(s1);
      // Inverse d'un original sans index : la session couvrant la date de l'original.
      const noIndexDoc = freshUuid();
      const unindexed = await movement(pos.accountId, 300, t('6', '05:00'), 'CUSTOMER_PAYMENT', {
        sourceDocId: noIndexDoc,
      });
      expect(await movementIndex(unindexed)).toBeNull();
      const unindexedReversal = await movement(
        pos.accountId,
        300,
        t('6', '15:45'),
        'CUSTOMER_PAYMENT',
        {
          sourceDocId: noIndexDoc,
          reversesMovementId: unindexed,
        },
      );
      expect(await movementIndex(unindexedReversal)).toBeNull();

      // Autre type de compte : jamais d'index.
      const central = await createAccount('CAISSE_CENTRALE');
      expect(await movementIndex(await movement(central, 1_000, t('6', '08:00')))).toBeNull();

      // Bornes : ouverture incluse, clôture exclue.
      const covering = (at: string) =>
        findCashSessionCovering(db, pos.accountId, new Date(at)).then((s) => s?.id ?? null);
      expect(await covering(t('6', '07:00'))).toBe(s1);
      expect(await covering(t('6', '12:00'))).toBeNull();
      expect(await covering(t('6', '12:30'))).toBeNull();
      expect(await covering(t('6', '13:00'))).toBe(s2);
      expect(await covering(t('7', '23:00'))).toBe(s2);
      await ledgerOk(pos.accountId);
    });
  });

  // --- Gardes de désactivation -------------------------------------------------------------------

  describe('gardes de désactivation', () => {
    it('compte : refus tant qu’une session est ouverte (même à solde nul), accepté après la clôture', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      const deactivate = () =>
        run(
          admin,
          adminDevice,
          'finance.cash_account.deactivate',
          pos.accountId,
          {},
          {
            occurredAt: t('6', '10:00'),
            aggregateType: 'CASH_ACCOUNT',
          },
        );
      expect(codeOf(await deactivate())).toBe('CASH_ACCOUNT_HAS_OPEN_SESSION');
      await closeSession(pos, sessionId, 0, t('6', '09:00'));
      expect(codeOf(await deactivate())).toBe('APPLIED');
    });

    it('emplacement de vente et fermeture du site : LOCATION_HAS_OPEN_CASH_SESSION, acceptés après la clôture', async () => {
      const pos = await newPos();
      const sessionId = await openOk(pos, 0, t('6', '07:00'));
      const closeSite = () =>
        run(
          admin,
          adminDevice,
          'organization.site.close',
          pos.siteId,
          {},
          {
            occurredAt: t('6', '20:00'),
            aggregateType: 'SITE',
          },
        );
      const deactivateLocation = () =>
        run(
          admin,
          adminDevice,
          'organization.location.deactivate',
          pos.locationId,
          {},
          {
            occurredAt: t('6', '20:00'),
            aggregateType: 'LOCATION',
          },
        );
      expect(codeOf(await closeSite())).toBe('LOCATION_HAS_OPEN_CASH_SESSION');
      expect(codeOf(await deactivateLocation())).toBe('LOCATION_HAS_OPEN_CASH_SESSION');
      // Un emplacement d'un autre type du même site n'est pas concerné.
      const store = await tx((trx) =>
        insertTestLocation(trx, admin, pos.siteId, { locationType: 'STORE' }),
      );
      expect(await tx((trx) => financeLocationDeactivationGuard(trx, store))).toBeNull();
      expect(
        await tx((trx) => financeLocationDeactivationGuard(trx, pos.locationId)),
      ).toMatchObject({ code: 'LOCATION_HAS_OPEN_CASH_SESSION' });
      await closeSession(pos, sessionId, 0, t('6', '18:00'));
      expect(codeOf(await deactivateLocation())).toBe('APPLIED');
      expect(codeOf(await closeSite())).toBe('APPLIED');
      // Site fermé : une ouverture en ligne est refusée.
      expect(codeOf(await openSession(pos, 0, t('7', '07:00')))).toBe('SITE_CLOSED');
    });

    it('concurrence : fermeture du site et ouverture simultanées — jamais un site fermé avec une session ouverte, aucun interblocage', async () => {
      for (let round = 0; round < 3; round++) {
        const pos = await newPos();
        const [closed, opened] = await Promise.all([
          run(
            admin,
            adminDevice,
            'organization.site.close',
            pos.siteId,
            {},
            {
              occurredAt: t('6', '20:00'),
              aggregateType: 'SITE',
            },
          ),
          openSession(pos, 0, t('6', '20:00')),
        ]);
        expect([closed.status, opened.status]).not.toContain('RETRY_LATER');
        const outcome = [codeOf(closed), codeOf(opened)].join('/');
        expect(['APPLIED/SITE_CLOSED', 'LOCATION_HAS_OPEN_CASH_SESSION/APPLIED']).toContain(
          outcome,
        );
      }
    });
  });

  // --- Tâche -------------------------------------------------------------------------------------

  describe('tâche finance.cash_sessions.open_long_check', () => {
    function job() {
      const jobs = new JobHandlerRegistry();
      new CashSessionOpenLongJob(clock, idGenerator, jobs).onModuleInit();
      return jobs.resolve(CASH_SESSION_OPEN_LONG_JOB_TYPE)!;
    }

    it('une alerte par session ouverte depuis plus du seuil et par jour métier ; ni session récente ni close', async () => {
      const longPos = await newPos();
      const long = await openOk(longPos, 0, t('7', '08:00'));
      const shortPos = await newPos();
      const short = await openOk(shortPos, 0, t('8', '12:00'));
      const closedPos = await newPos();
      const closed = await openOk(closedPos, 0, t('7', '06:00'));
      await closeSession(closedPos, closed, 0, t('7', '20:00'));
      const handler = job();
      clock.setTo(new Date(t('8', '14:00'))); // 30 h après `long`, 2 h après `short`
      try {
        await tx((trx) => handler(trx, {}));
        const detected = await events(long, 'CashSessionOpenLongDetected');
        expect(detected).toEqual([
          expect.objectContaining({
            session_id: long,
            cash_account_id: longPos.accountId,
            site_id: longPos.siteId,
            opened_by: longPos.vendor,
            hours_open: 30,
            threshold_hours: 24,
            business_day: '2026-10-08',
          }),
        ]);
        expect(await events(short, 'CashSessionOpenLongDetected')).toHaveLength(0);
        expect(await events(closed, 'CashSessionOpenLongDetected')).toHaveLength(0);
        await tx((trx) => handler(trx, {})); // rejouable le même jour
        expect(await events(long, 'CashSessionOpenLongDetected')).toHaveLength(1);
        expect((await session(long)).status).toBe('OPEN');
      } finally {
        clock.setTo(new Date(NOW));
      }
    });
  });
});
