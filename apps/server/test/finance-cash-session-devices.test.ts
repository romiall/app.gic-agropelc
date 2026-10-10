/**
 * P5-12 — sessions de caisse avec plusieurs tablettes hors ligne (ADR-032 §2 et §8 ; AV-007, AV-154,
 * AV-167, AV-168 ; BR-SYN-007), contre les vrais services de synchronisation (`SyncPushService`) et
 * le harnais multi-appareils `OfflineDevice` (P5-07) :
 * - PDV partagé : deux tablettes ouvrent « la » session hors ligne, la plus matinale synchronise en
 *   dernier (fusion, AV-167) ; fin de journée : clôture par l'alias, puis clôture concurrente observée ;
 * - réponse perdue puis renvoi du même lot : aucune session ni aucun mouvement en double ;
 * - l'attendu de clôture ne dépend pas de l'ordre de synchronisation (fenêtre de temps) ;
 * - clôture forcée de la session de la veille pendant que la tablette est hors ligne (AV-168).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerAccountCommands } from '../src/modules/finance/application/commands/account-commands.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import {
  recordCashMovement,
  verifyCashLedger,
} from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { NetworkDownError, OfflineDevice } from './device-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-09T21:00:00.000Z';
const t = (day: string, hhmm: string) => `2026-10-0${day}T${hhmm}:00.000Z`;

interface SharedPos {
  readonly siteId: string;
  readonly accountId: string;
  readonly vendorA: string;
  readonly vendorB: string;
  readonly tabletA: OfflineDevice;
  readonly tabletB: OfflineDevice;
}

describe('P5-12 : sessions de caisse et tablettes hors ligne (harnais multi-appareils)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let admin: string;
  let adminDevice: string;
  let finance: string;
  let financeDevice: string;
  let vendorRole: string;

  const tx = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(fn);

  const online = (
    author: string,
    device: string,
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    occurredAt: string,
  ) =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        author_user_id: author,
        base_version: null,
        depends_on: [],
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        command_type: type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        occurred_at: occurredAt,
        payload,
      },
      { authenticatedUserId: author, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );

  async function newSharedPos(): Promise<SharedPos> {
    const base = await tx(async (trx) => {
      const zone = await insertTestZone(trx, admin);
      const siteId = await insertTestSite(trx, admin, zone, { siteType: 'POINT_DE_VENTE' });
      const vendorA = await insertTestUser(trx);
      const vendorB = await insertTestUser(trx);
      for (const user of [vendorA, vendorB]) {
        await assignTestRole(trx, user, vendorRole, admin, {
          scopeType: 'SITE',
          scopeSiteId: siteId,
        });
      }
      const deviceA = await insertTestDevice(trx, vendorA);
      const deviceB = await insertTestDevice(trx, vendorB);
      return { siteId, vendorA, vendorB, deviceA, deviceB };
    });
    const accountId = freshUuid();
    const created = await online(
      admin,
      adminDevice,
      'finance.cash_account.create',
      'CASH_ACCOUNT',
      accountId,
      {
        code: `PDV-${accountId.slice(-12)}`,
        name: 'Caisse du PDV',
        accountType: 'CAISSE_PDV',
        siteId: base.siteId,
        responsibleUserId: admin,
      },
      t('1', '06:00'),
    );
    expect(created.status).toBe('APPLIED');
    return {
      siteId: base.siteId,
      accountId,
      vendorA: base.vendorA,
      vendorB: base.vendorB,
      tabletA: new OfflineDevice(services, base.deviceA, clock),
      tabletB: new OfflineDevice(services, base.deviceB, clock),
    };
  }

  const openSpec = (
    accountId: string,
    countedXaf: number,
    occurredAt: string,
    id = freshUuid(),
  ) => ({
    type: 'finance.cash_session.open',
    aggregateType: 'CASH_SESSION',
    aggregateId: id,
    occurredAt,
    payload: { cashAccountId: accountId, countedXaf },
  });
  const closeSpec = (sessionId: string, countedXaf: number, occurredAt: string) => ({
    type: 'finance.cash_session.close',
    aggregateType: 'CASH_SESSION',
    aggregateId: sessionId,
    occurredAt,
    payload: { countedXaf },
  });

  /** Encaissement en espèces injecté dans le registre (comme `sales` le ferait). */
  async function payment(
    accountId: string,
    amountXaf: number,
    occurredAt: string,
  ): Promise<string> {
    const recorded = await tx((trx) =>
      recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId: accountId,
          direction: 'IN',
          amountXaf,
          movementType: 'CUSTOMER_PAYMENT',
          sourceDocType: 'CUSTOMER_PAYMENT',
          sourceDocId: freshUuid(),
          occurredAt: new Date(occurredAt),
          createdBy: admin,
          capturedOffline: true,
          allowNegative: true,
        },
      ),
    );
    return recorded.movementId;
  }

  async function sessionsOf(accountId: string) {
    return db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('cash_account_id', '=', toBin(accountId))
      .orderBy('opened_at')
      .execute();
  }

  async function closingVariances(accountId: string) {
    return db
      .selectFrom('finance_cash_movements as m')
      .innerJoin('finance_cash_sessions as s', 's.id', 'm.source_doc_id')
      .select(['m.direction', 'm.amount_xaf', 'm.source_doc_id'])
      .where('m.cash_account_id', '=', toBin(accountId))
      .where('m.movement_type', '=', 'SESSION_VARIANCE')
      .whereRef('m.occurred_at', '=', 's.closed_at')
      .execute();
  }

  async function conflictsOn(entityId: string, conflictType: string) {
    const rows = await db
      .selectFrom('sync_sync_conflicts')
      .select(['details'])
      .where('conflict_type', '=', conflictType)
      .where('entity_id', '=', toBin(entityId))
      .execute();
    return rows.map((row) => row.details as Record<string, unknown>);
  }

  const ledgerOk = async (accountId: string) =>
    expect((await verifyCashLedger(db, { cashAccountIds: [accountId] })).ok).toBe(true);

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerAccountCommands(registry);
    registerCashSessionCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    await tx(async (trx) => {
      admin = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin);
      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'finance.cash_account.manage', admin);
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
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('PDV partagé : la tablette la plus matinale synchronise en dernier (AV-167), clôture par l’alias puis clôture concurrente observée', async () => {
    const pos = await newSharedPos();
    const idA = freshUuid();
    const idB = freshUuid();
    pos.tabletA.enqueue(pos.vendorA, openSpec(pos.accountId, 20_000, t('6', '07:58'), idA));
    pos.tabletB.enqueue(pos.vendorB, openSpec(pos.accountId, 20_500, t('6', '08:05'), idB));

    const [openedB] = await pos.tabletB.sync(pos.vendorB);
    expect(openedB).toMatchObject({ status: 'APPLIED', server_refs: { cashSessionId: idB } });
    const [mergedA] = await pos.tabletA.sync(pos.vendorA);
    expect(mergedA).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
      server_refs: { cashSessionId: idB },
    });
    const merge = await conflictsOn(idA, 'CASH_SESSION_CONCURRENT_OPEN');
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({
      outcome: 'MERGED',
      targetSessionId: idB,
      earlierThanTarget: true,
      requestedOpenedAt: t('6', '07:58'),
      countDifferenceXaf: -500,
    });
    const opened = await sessionsOf(pos.accountId);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.opened_at.toISOString()).toBe(t('6', '08:05'));

    // Journée : ventes des deux tablettes, puis A clôture « sa » session (l'alias) hors ligne.
    await payment(pos.accountId, 60_000, t('6', '10:00'));
    await payment(pos.accountId, 40_000, t('6', '15:00'));
    pos.tabletA.enqueue(pos.vendorA, closeSpec(idA, 120_000, t('6', '18:00')));
    pos.tabletB.enqueue(pos.vendorB, closeSpec(idB, 121_000, t('6', '18:10')));
    const [closedA] = await pos.tabletA.sync(pos.vendorA);
    expect(closedA).toMatchObject({
      status: 'APPLIED',
      server_refs: { cashSessionId: idB, varianceXaf: '-500', status: 'PENDING_VALIDATION' },
    });
    const [observedB] = await pos.tabletB.sync(pos.vendorB);
    expect(observedB).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_SESSION_CONCURRENT_CLOSE'],
    });
    expect((await conflictsOn(idB, 'CASH_SESSION_CONCURRENT_CLOSE'))[0]).toMatchObject({
      reason: 'ALREADY_CLOSED',
      countedXaf: 121_000,
      existingCountedXaf: 120_000,
    });

    const [row] = await sessionsOf(pos.accountId);
    expect(row).toMatchObject({ status: 'PENDING_VALIDATION' });
    expect(fromBin(row!.closed_by!)).toBe(pos.vendorA);
    // Attendu = 20 500 (fonds de la session retenue) + 100 000 ; un seul écart de clôture.
    expect(Number(row!.closing_expected_xaf)).toBe(120_500);
    const variances = await closingVariances(pos.accountId);
    expect(variances).toHaveLength(1);
    expect(Number(variances[0]!.amount_xaf)).toBe(500);
    expect((await sessionsOf(pos.accountId)).filter((s) => s.status === 'OPEN')).toHaveLength(0);
    await ledgerOk(pos.accountId);
  });

  it('réponse perdue puis renvoi du même lot : aucune session ni aucun mouvement en double, résultats définitifs', async () => {
    const pos = await newSharedPos();
    const id = freshUuid();
    pos.tabletA.enqueue(pos.vendorA, openSpec(pos.accountId, 5_000, t('6', '07:00'), id));
    pos.tabletA.enqueue(pos.vendorA, closeSpec(id, 4_000, t('6', '18:00')));
    pos.tabletA.loseNextResponses(1);
    await expect(pos.tabletA.sync(pos.vendorA)).rejects.toBeInstanceOf(NetworkDownError);
    const replayed = await pos.tabletA.sync(pos.vendorA);
    expect(replayed.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(pos.tabletA.pending()).toBe(0);
    const rows = await sessionsOf(pos.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING_VALIDATION' });
    const movements = await db
      .selectFrom('finance_cash_movements')
      .select('id')
      .where('cash_account_id', '=', toBin(pos.accountId))
      .execute();
    expect(movements).toHaveLength(2); // écart d'ouverture +5 000, écart de clôture −1 000
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select('status')
      .where('aggregate_id', '=', toBin(id))
      .execute();
    expect(inbox.map((r) => r.status).sort()).toEqual(['APPLIED', 'APPLIED']);
    await ledgerOk(pos.accountId);
  });

  it('l’attendu de clôture ne dépend pas de l’ordre de synchronisation (fenêtre de temps, ADR-032 §2)', async () => {
    const expectedFor = async (paymentsFirst: boolean) => {
      const pos = await newSharedPos();
      const id = freshUuid();
      pos.tabletA.enqueue(pos.vendorA, openSpec(pos.accountId, 0, t('6', '08:00'), id));
      if (paymentsFirst) {
        await payment(pos.accountId, 15_000, t('6', '09:00'));
        await payment(pos.accountId, 25_000, t('6', '12:00'));
        await pos.tabletA.sync(pos.vendorA);
      } else {
        await pos.tabletA.sync(pos.vendorA);
        await payment(pos.accountId, 15_000, t('6', '09:00'));
        await payment(pos.accountId, 25_000, t('6', '12:00'));
      }
      pos.tabletA.enqueue(pos.vendorA, closeSpec(id, 40_000, t('6', '18:00')));
      const [closed] = await pos.tabletA.sync(pos.vendorA);
      expect(closed!.status).toBe('APPLIED');
      const [row] = await sessionsOf(pos.accountId);
      return { expected: Number(row!.closing_expected_xaf), status: row!.status };
    };
    const late = await expectedFor(true);
    const early = await expectedFor(false);
    expect(late).toEqual({ expected: 40_000, status: 'VALIDATED' });
    expect(early).toEqual(late);
  });

  it('AV-168 : clôture forcée de la session de la veille pendant que la tablette est hors ligne — ouverture du matin décalée à la clôture forcée', async () => {
    const pos = await newSharedPos();
    const previous = freshUuid();
    pos.tabletA.enqueue(pos.vendorA, openSpec(pos.accountId, 0, t('5', '07:00'), previous));
    await pos.tabletA.sync(pos.vendorA);
    await payment(pos.accountId, 100_000, t('5', '12:00'));
    // Le vendeur oublie de clôturer ; le lendemain, la tablette (hors ligne) ouvre la journée.
    const today = freshUuid();
    pos.tabletA.goOffline();
    pos.tabletA.enqueue(pos.vendorA, openSpec(pos.accountId, 100_000, t('6', '07:30'), today));
    await payment(pos.accountId, 30_000, t('6', '08:30'));
    // La Finance clôt d'office la session de la veille (27 h), comptage déclaré.
    const forced = await online(
      finance,
      financeDevice,
      'finance.cash_session.force_close',
      'CASH_SESSION',
      previous,
      { countedXaf: 130_000, reason: 'Session de la veille non clôturée' },
      t('6', '10:00'),
    );
    expect(forced).toMatchObject({
      status: 'APPLIED',
      server_refs: { varianceXaf: '0', status: 'PENDING_VALIDATION' },
    });
    const afternoon = await payment(pos.accountId, 50_000, t('6', '14:00'));
    pos.tabletA.enqueue(pos.vendorA, closeSpec(today, 180_000, t('6', '18:00')));
    pos.tabletA.goOnline();
    const [opened, closed] = await pos.tabletA.sync(pos.vendorA);

    expect(opened).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
      server_refs: {
        cashSessionId: today,
        openedAt: t('6', '10:00'),
        openingExpectedXaf: '130000',
        openingVarianceXaf: '-30000',
      },
    });
    expect((await conflictsOn(today, 'CASH_SESSION_CONCURRENT_OPEN'))[0]).toMatchObject({
      outcome: 'SHIFTED',
      reason: 'OPENED_DURING_PREVIOUS_DAY_SESSION',
      previousSessionId: previous,
      requestedOpenedAt: t('6', '07:30'),
      openedAt: t('6', '10:00'),
      flowsBetweenXaf: 30_000,
    });
    // La journée a sa session : la clôture du soir est rapprochée (attendu 100 000 + 50 000).
    expect(closed).toMatchObject({
      status: 'APPLIED',
      server_refs: { cashSessionId: today, closingExpectedXaf: '150000', varianceXaf: '30000' },
    });
    const rows = await sessionsOf(pos.accountId);
    expect(rows.map((r) => [fromBin(r.id), r.status, r.force_closed])).toEqual([
      [previous, 'PENDING_VALIDATION', 1],
      [today, 'PENDING_VALIDATION', 0],
    ]);
    // L'encaissement de 14:00, enregistré avant que la session décalée n'existe, n'a pas d'index :
    // l'attendu le compte quand même (fenêtre de temps).
    const index = await db
      .selectFrom('finance_cash_movements')
      .select('cash_session_id')
      .where('id', '=', toBin(afternoon))
      .executeTakeFirstOrThrow();
    expect(index.cash_session_id).toBeNull();
    // Écarts d'ouverture et de clôture de signes opposés : leur somme est l'écart réel (nul ici).
    expect(Number(rows[1]!.opening_variance_xaf) + Number(rows[1]!.variance_xaf)).toBe(0);
    await ledgerOk(pos.accountId);
  });
});
