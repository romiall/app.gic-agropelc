/**
 * P9-25 (TB-3, TB-8) — la tâche d'instantanés d'indicateurs est isolée par unité (utilisateur, tableau, période) sous
 * point de sauvegarde, sa purge ne dépend pas de la réussite des calculs, une transaction perdue remonte pour que la
 * tâche soit rejouée, la préparation d'un tableau est faite une seule fois par utilisateur, et la boucle des
 * utilisateurs a un budget de durée avec tâche de reprise (AV-448, ADR-068 §3).
 *
 * Les défaillances sont injectées par des enveloppes `vi.fn` autour du compositeur de tableaux et du flux de
 * changements (modèle de approvals-pending-long-job.test.ts) ; les assertions sont relatives (aucun compte absolu sur
 * la base partagée) et les instants sont ceux de l'horloge réelle, jamais une date simulée. Les essais de la tâche
 * complète (`runKpiSnapshotsRefresh`) donnent une session ouverte à leurs utilisateurs : le retrait des inactifs, qui
 * porte sur toute la base, ne touche alors que d'autres instantanés (comme l'essai existant de analytics-snapshots).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/analytics-api/dashboards/dashboard-builder.js', async (importActual) => {
  const actual = (await importActual()) as {
    prepareDashboard: (...args: never[]) => unknown;
    buildDashboardBlocks: (...args: never[]) => unknown;
  };
  return {
    ...actual,
    prepareDashboard: vi.fn(actual.prepareDashboard),
    buildDashboardBlocks: vi.fn(actual.buildDashboardBlocks),
  };
});
vi.mock('../src/platform/sync/change-feed.js', async (importActual) => {
  const actual = (await importActual()) as { recordChanges: (...args: never[]) => unknown };
  return { ...actual, recordChanges: vi.fn(actual.recordChanges) };
});
vi.mock('../src/modules/analytics/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as { activeSnapshotUsers: (...args: never[]) => unknown };
  return { ...actual, activeSnapshotUsers: vi.fn(actual.activeSnapshotUsers) };
});

import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { FixedClock } from '@gic/domain';
import {
  buildDashboardBlocks,
  prepareDashboard,
} from '../src/analytics-api/dashboards/dashboard-builder.js';
import {
  refreshSnapshotsBatch,
  refreshSnapshotsOf,
  runKpiSnapshotsRefresh,
} from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordChanges } from '../src/platform/sync/change-feed.js';
import type { JobsService } from '../src/platform/jobs/jobs.service.js';
import {
  KPI_DATASET,
  activeSnapshotUsers,
  listSnapshotsOf,
  saveSnapshot,
  snapshotEntityId,
} from '../src/modules/analytics/application/public/index.js';
import { actorWith } from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

// Les originaux : les enveloppes ci-dessus y reviennent entre les essais (vitest 2 : `mockReset` vide l'implémentation).
let originalBuilder: {
  prepareDashboard: typeof prepareDashboard;
  buildDashboardBlocks: typeof buildDashboardBlocks;
};
let originalFeed: { recordChanges: typeof recordChanges };
let originalAnalytics: { activeSnapshotUsers: typeof activeSnapshotUsers };

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const STOCK = 'analytics.dashboard.stock';
const PRODUCTION = 'analytics.dashboard.production';

const logger = new Logger('analytics-snapshots-resilience');
const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

const deadlock = () =>
  Object.assign(new Error('Deadlock found when trying to get lock'), {
    code: 'ER_LOCK_DEADLOCK',
    errno: 1213,
  });

/** Un contenu d'indicateurs distinct du contenu réel, pour forcer une écriture. */
const alteredBlocks = [
  {
    code: 'STOCK',
    title: 'Stock',
    kpis: [{ code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value: 424_242 }],
    details: [],
  },
] as unknown as Awaited<ReturnType<typeof buildDashboardBlocks>>;

describe('P9-25 : instantanés d’indicateurs, isolation et budget', { timeout: 120_000 }, () => {
  let admin: string;

  const base = () => new Date(Math.floor(Date.now() / 1000) * 1000);
  const refresh = (userId: string, at: Date) =>
    db.transaction().execute((trx) => refreshSnapshotsOf(trx, userId, at, { logger }));
  const feedOf = (userId: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['change_type', 'entity_id'])
      .where('dataset', '=', KPI_DATASET)
      .where('scope_id', '=', toBin(userId))
      .orderBy('seq')
      .execute();
  const savedAt = async (userId: string) =>
    new Map(
      (await listSnapshotsOf(db, userId)).map((snapshot) => [
        `${snapshot.scopeKey}|${snapshot.periodKey}`,
        snapshot,
      ]),
    );
  const writeRaw = (
    userId: string,
    scopeKey: string,
    periodKey: 'TODAY' | 'WEEK' | 'MONTH',
    at: Date,
  ) =>
    db
      .transaction()
      .execute((trx) =>
        saveSnapshot(trx, { userId, scopeKey, periodKey, kpis: [], computedAt: at }),
      );
  const holders = async (count: number, permissions: readonly string[] = [STOCK]) => {
    const users: string[] = [];
    for (let k = 0; k < count; k += 1) users.push((await actorWith(admin, permissions)).id);
    return users;
  };
  const openSession = (userId: string, deviceId: string) =>
    db
      .insertInto('identity_auth_sessions')
      .values({
        id: toBin(freshUuid()),
        user_id: toBin(userId),
        device_id: toBin(deviceId),
        refresh_token_hash: randomBytes(32).toString('hex'),
        token_family_id: toBin(freshUuid()),
        expires_at: new Date(Date.now() + 365 * 24 * HOUR_MS),
        offline_grant_until: new Date(Date.now() + 365 * 24 * HOUR_MS),
        last_used_at: new Date(Date.now() - HOUR_MS),
      })
      .execute();
  /** Utilisateurs titulaires de `stock` qui ont une session ouverte sur un appareil en service (actifs). */
  const activeHolders = async (count: number) => {
    const users: string[] = [];
    for (let k = 0; k < count; k += 1) {
      const actor = await actorWith(admin, [STOCK]);
      await openSession(actor.id, actor.deviceId);
      users.push(actor.id);
    }
    return users;
  };

  beforeAll(async () => {
    originalBuilder = await vi.importActual('../src/analytics-api/dashboards/dashboard-builder.js');
    originalFeed = await vi.importActual('../src/platform/sync/change-feed.js');
    originalAnalytics = await vi.importActual(
      '../src/modules/analytics/application/public/index.js',
    );
    admin = await db.transaction().execute((trx) => insertTestUser(trx));
  });
  afterAll(closeTestDb);
  beforeEach(() => {
    vi.mocked(prepareDashboard).mockReset().mockImplementation(originalBuilder.prepareDashboard);
    vi.mocked(buildDashboardBlocks)
      .mockReset()
      .mockImplementation(originalBuilder.buildDashboardBlocks);
    vi.mocked(recordChanges).mockReset().mockImplementation(originalFeed.recordChanges);
    vi.mocked(activeSnapshotUsers)
      .mockReset()
      .mockImplementation(originalAnalytics.activeSnapshotUsers);
    errorSpy.mockClear();
  });

  describe('isolation par unité (TB-3)', () => {
    it('la préparation d’un tableau échoue : son instantané précédent est gardé, l’autre tableau est calculé, le droit perdu est purgé', async () => {
      const [user] = await holders(1, [STOCK, PRODUCTION]);
      const t0 = base();
      expect(await refresh(user!, t0)).toMatchObject({ saved: 6, failed: 0 });
      // Un instantané d'un tableau dont l'utilisateur n'a pas la permission.
      await writeRaw(user!, 'finance', 'TODAY', t0);
      const before = await savedAt(user!);
      expect(before.has('finance|TODAY')).toBe(true);

      vi.mocked(prepareDashboard).mockImplementation(async (executor, input) => {
        if (input.code === 'stock') throw new Error('lecture impossible');
        return originalBuilder.prepareDashboard(executor, input);
      });
      const second = await refresh(user!, new Date(t0.getTime() + 20 * MIN_MS));
      expect(second).toMatchObject({ saved: 3, failed: 1, deleted: 1 });
      // Une seule ligne de journal par utilisateur, qui nomme l'unité en échec.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('tableau stock');

      const after = await savedAt(user!);
      for (const period of ['TODAY', 'WEEK', 'MONTH']) {
        const key = `stock|${period}`;
        expect(after.get(key)?.computedAt.getTime(), key).toBe(
          before.get(key)?.computedAt.getTime(),
        );
      }
      expect(after.has('finance|TODAY')).toBe(false);
      const financeId = snapshotEntityId({
        userId: user!,
        scopeKey: 'finance',
        periodKey: 'TODAY',
      });
      expect(
        (await feedOf(user!)).some(
          (row) => row.change_type === 'DELETE' && fromBin(row.entity_id) === financeId,
        ),
      ).toBe(true);
    });

    it('une période échoue : les deux autres sont écrites, la troisième garde son instantané', async () => {
      const [user] = await holders(1);
      const t0 = base();
      expect(await refresh(user!, t0)).toMatchObject({ saved: 3, failed: 0 });
      const before = (await savedAt(user!)).get('stock|WEEK')!;

      vi.mocked(buildDashboardBlocks).mockImplementation(async (prepared, period) => {
        if (period.code === 'WEEK') throw new Error('lecture impossible');
        return originalBuilder.buildDashboardBlocks(prepared, period);
      });
      // Plus d'une heure : la date seule est republiée pour les deux périodes qui réussissent.
      const second = await refresh(user!, new Date(t0.getTime() + 2 * HOUR_MS));
      expect(second).toMatchObject({ saved: 2, failed: 1, published: 2 });
      const week = (await savedAt(user!)).get('stock|WEEK')!;
      expect(week.computedAt.getTime()).toBe(before.computedAt.getTime());
      expect(week.kpis).toEqual(before.kpis);
    });

    it('une publication qui échoue défait l’écriture, puis la passe suivante la publie', async () => {
      const [user] = await holders(1);
      const t0 = base();
      expect(await refresh(user!, t0)).toMatchObject({ saved: 3, failed: 0 });
      const before = (await savedAt(user!)).get('stock|TODAY')!;
      const feedBefore = (await feedOf(user!)).length;
      const todayId = snapshotEntityId({ userId: user!, scopeKey: 'stock', periodKey: 'TODAY' });

      vi.mocked(buildDashboardBlocks).mockImplementation(async (prepared, period) =>
        period.code === 'TODAY'
          ? alteredBlocks
          : originalBuilder.buildDashboardBlocks(prepared, period),
      );
      // Armé sur la publication de `stock|TODAY` seulement, et rétabli en `finally`.
      let armed = true;
      vi.mocked(recordChanges).mockImplementation(async (uow, entries) => {
        if (armed && entries.some((entry) => entry.entityId === todayId)) {
          armed = false;
          throw new Error('flux indisponible');
        }
        return originalFeed.recordChanges(uow, entries);
      });
      try {
        const failedPass = await refresh(user!, new Date(t0.getTime() + 20 * MIN_MS));
        expect(failedPass.failed).toBe(1);
        const row = (await savedAt(user!)).get('stock|TODAY')!;
        expect(row.kpis).toEqual(before.kpis);
        expect(row.computedAt.getTime()).toBe(before.computedAt.getTime());
        expect(await feedOf(user!)).toHaveLength(feedBefore);

        const retry = await refresh(user!, new Date(t0.getTime() + 40 * MIN_MS));
        expect(retry.failed).toBe(0);
        expect(retry.published).toBeGreaterThanOrEqual(1);
        const published = (await savedAt(user!)).get('stock|TODAY')!;
        expect(published.kpis).toEqual([
          { code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value: 424_242 },
        ]);
        expect((await feedOf(user!)).length).toBeGreaterThan(feedBefore);
      } finally {
        vi.mocked(recordChanges).mockReset().mockImplementation(originalFeed.recordChanges);
      }
    });

    it('transaction perdue : l’erreur n’est pas avalée, la tâche est rejouée', async () => {
      const [user] = await holders(1);
      vi.mocked(buildDashboardBlocks).mockImplementation(async () => {
        throw deadlock();
      });
      await expect(
        db
          .transaction()
          .execute((trx) =>
            refreshSnapshotsBatch(
              trx,
              { logger, elapsedMs: () => 0 },
              { userIds: [user!], now: base(), startedAt: 0, budgetMs: 60_000 },
            ),
          ),
      ).rejects.toMatchObject({ errno: 1213 });
      // Aucun échec silencieux : rien n'a été journalisé comme une unité en échec.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('purge indépendante des échecs : tous les calculs lèvent, l’instantané d’un droit perdu est tout de même supprimé', async () => {
      const [user] = await holders(1);
      const t0 = base();
      for (const period of ['TODAY', 'WEEK', 'MONTH'] as const) {
        await writeRaw(user!, 'finance', period, t0);
      }
      vi.mocked(prepareDashboard).mockImplementation(async () => {
        throw new Error('lecture impossible');
      });
      const result = await refresh(user!, new Date(t0.getTime() + 20 * MIN_MS));
      expect(result).toMatchObject({ saved: 0, published: 0, deleted: 3, failed: 1 });
      expect([...(await savedAt(user!)).keys()].some((key) => key.startsWith('finance|'))).toBe(
        false,
      );
    });

    it('purge indépendante des échecs : sans aucun tableau détenu, rien n’est calculé et tout est purgé', async () => {
      const [user] = await holders(1, ['sales.sale.read']);
      const t0 = base();
      for (const period of ['TODAY', 'WEEK', 'MONTH'] as const) {
        await writeRaw(user!, 'finance', period, t0);
      }
      vi.mocked(prepareDashboard).mockImplementation(async () => {
        throw new Error('lecture impossible');
      });
      vi.mocked(buildDashboardBlocks).mockImplementation(async () => {
        throw new Error('lecture impossible');
      });
      const result = await refresh(user!, new Date(t0.getTime() + 20 * MIN_MS));
      expect(result).toEqual({ saved: 0, published: 0, deleted: 3, failed: 0 });
      expect(vi.mocked(prepareDashboard)).not.toHaveBeenCalled();
      expect(await listSnapshotsOf(db, user!)).toEqual([]);
    });

    it('préparation unique : une fois par utilisateur et tableau, les blocs une fois par période', async () => {
      const [user] = await holders(1);
      await refresh(user!, base());
      expect(vi.mocked(prepareDashboard).mock.calls).toHaveLength(1);
      expect(vi.mocked(buildDashboardBlocks).mock.calls).toHaveLength(3);
    });
  });

  describe('budget de durée et reprise (TB-8, AV-448)', () => {
    it('arrêt à l’échéance, au moins un utilisateur par exécution', async () => {
      const [u1, u2, u3] = await holders(3);
      let t = 0;
      const elapsedMs = () => (t += 40_000);
      const batch = await db
        .transaction()
        .execute((trx) =>
          refreshSnapshotsBatch(
            trx,
            { logger, elapsedMs },
            { userIds: [u1!, u2!, u3!], now: base(), startedAt: 0, budgetMs: 60_000 },
          ),
        );
      // 40 000 après le premier, 80 000 après le deuxième : l'échéance de 60 000 est dépassée.
      expect(batch).toMatchObject({ processed: 2, failed: 0 });
      expect(await listSnapshotsOf(db, u1!)).toHaveLength(3);
      expect(await listSnapshotsOf(db, u2!)).toHaveLength(3);
      expect(await listSnapshotsOf(db, u3!)).toEqual([]);

      const [v1, v2] = await holders(2);
      const zero = await db
        .transaction()
        .execute((trx) =>
          refreshSnapshotsBatch(
            trx,
            { logger, elapsedMs: () => 1 },
            { userIds: [v1!, v2!], now: base(), startedAt: 0, budgetMs: 0 },
          ),
        );
      expect(zero.processed).toBe(1);
      expect(await listSnapshotsOf(db, v2!)).toEqual([]);
    });

    it('reprise : une tâche est déposée à la suite du dernier utilisateur traité, sans retrait des inactifs', async () => {
      const [u1, u2, u3] = await activeHolders(3);
      const [lapsed] = await holders(1);
      await refresh(lapsed!, base());
      expect(await listSnapshotsOf(db, lapsed!)).toHaveLength(3);
      const enqueue = vi.fn().mockResolvedValue('job-id');
      const jobs = { enqueue } as unknown as JobsService;
      let t = 0;
      // Vaut 40 000 au départ ; le budget (60 s) est dépassé après le deuxième utilisateur.
      const elapsedMs = () => (t += 40_000);
      vi.mocked(activeSnapshotUsers).mockResolvedValue([u1!, u2!, u3!]);
      const outcome = await db
        .transaction()
        .execute((trx) =>
          runKpiSnapshotsRefresh(
            trx,
            { clock: new FixedClock(base()), jobs, logger, elapsedMs },
            {},
          ),
        );
      // Trois utilisateurs lus, moins que le lot : la reprise vient du budget seul.
      expect(outcome).toMatchObject({ users: 3, processed: 2, continued: true, failed: 0 });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(expect.anything(), {
        jobType: 'analytics.kpi_snapshots.refresh',
        payload: { afterUserId: u2 },
      });
      expect(await listSnapshotsOf(db, u1!)).toHaveLength(3);
      expect(await listSnapshotsOf(db, u2!)).toHaveLength(3);
      expect(await listSnapshotsOf(db, u3!)).toEqual([]);
      // Le retrait des inactifs n'a pas eu lieu au milieu d'une reprise.
      expect(await listSnapshotsOf(db, lapsed!)).toHaveLength(3);
    });

    it('pas de reprise quand tout est traité et que le lot n’est pas plein : le retrait des inactifs est exécuté', async () => {
      const [u1, u2] = await activeHolders(2);
      const [lapsed] = await holders(1);
      await refresh(lapsed!, base());
      const enqueue = vi.fn().mockResolvedValue('job-id');
      const jobs = { enqueue } as unknown as JobsService;
      vi.mocked(activeSnapshotUsers).mockResolvedValue([u1!, u2!]);
      const outcome = await db
        .transaction()
        .execute((trx) =>
          runKpiSnapshotsRefresh(
            trx,
            { clock: new FixedClock(base()), jobs, logger, elapsedMs: () => 0 },
            {},
          ),
        );
      expect(outcome).toMatchObject({ users: 2, processed: 2, continued: false, failed: 0 });
      expect(enqueue).not.toHaveBeenCalled();
      // Relatif : d'autres instantanés d'inactifs de la base partagée peuvent aussi être retirés.
      expect(outcome.deleted).toBeGreaterThanOrEqual(3);
      expect(await listSnapshotsOf(db, lapsed!)).toEqual([]);
      expect(await listSnapshotsOf(db, u1!)).toHaveLength(3);
      expect(await listSnapshotsOf(db, u2!)).toHaveLength(3);
    });

    it('liste vide : aucune reprise', async () => {
      const enqueue = vi.fn().mockResolvedValue('job-id');
      const jobs = { enqueue } as unknown as JobsService;
      vi.mocked(activeSnapshotUsers).mockResolvedValue([]);
      const outcome = await db
        .transaction()
        .execute((trx) =>
          runKpiSnapshotsRefresh(
            trx,
            { clock: new FixedClock(base()), jobs, logger, elapsedMs: () => 0 },
            {},
          ),
        );
      expect(outcome).toMatchObject({ users: 0, processed: 0, continued: false });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
