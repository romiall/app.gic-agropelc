/**
 * P9-18 — instantanés personnels d'indicateurs (ADR-066 §5 à §7 ; AV-380, AV-381, AV-448 ; AT-054) : le calcul par
 * utilisateur (`refreshSnapshotsOf`), la publication au flux du jeu hors ligne `kpi` (portée `USER`, republication au
 * changement ou toutes les heures ; `computed_at` = dernière publication, TB-2), la suppression à la perte du droit, les utilisateurs actifs (compte, session,
 * appareil, ancienneté), le retrait des inactifs, le lecteur du jeu `kpi` et la route `GET /analytics/snapshots/me`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { DASHBOARD_CODES, kpiSnapshotSchema } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  KPI_DATASET,
  activeSnapshotUsers,
  deleteSnapshotsOfInactiveUsers,
  listSnapshotsOf,
  saveSnapshot,
  snapshotEntityId,
  snapshotReadPermission,
} from '../src/modules/analytics/application/public/index.js';
import { refreshSnapshotsOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { dashboardPermission } from '../src/analytics-api/dashboards/dashboard-builder.js';
import { KPI_PROJECTIONS } from '../src/sync/kpi-projections.js';
import { actorWith, type CommandActor } from './analytics-command-fixtures.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  signTestAccessToken,
} from './helpers.js';

const HOUR_MS = 3_600_000;

describe('P9-18 : instantanés personnels d’indicateurs', { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let admin: string;
  let holder: CommandActor & { roleCode: string };
  let nobody: CommandActor & { roleCode: string };
  const tokens = new Map<string, string>();

  const now = () => clock.now();
  const refresh = (userId: string, at: Date = now()) =>
    db.transaction().execute((trx) => refreshSnapshotsOf(trx, userId, at));
  const feedOf = (userId: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['change_type', 'entity_id', 'scope_type'])
      .where('dataset', '=', KPI_DATASET)
      .where('scope_id', '=', toBin(userId))
      .orderBy('seq')
      .execute();
  const openSession = (userId: string, deviceId: string, lastUsedAt: Date) =>
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
        last_used_at: lastUsedAt,
      })
      .execute();

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    holder = await actorWith(admin, ['analytics.dashboard.stock']);
    nobody = await actorWith(admin, ['sales.sale.read']);
    const jwtKeys = app.get(JWT_KEYS);
    for (const actor of [holder, nobody]) {
      tokens.set(
        actor.id,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.id, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('un utilisateur sans permission de tableau n’a aucun instantané', async () => {
    expect(await refresh(nobody.id)).toEqual({ saved: 0, published: 0, deleted: 0, failed: 0 });
    expect(await listSnapshotsOf(db, nobody.id)).toEqual([]);
  });

  it('un instantané par période pour le tableau dont il détient la permission, sans lien d’exploration, publié au flux USER', async () => {
    const result = await refresh(holder.id);
    expect(result).toEqual({ saved: 3, published: 3, deleted: 0, failed: 0 });
    const snapshots = await listSnapshotsOf(db, holder.id);
    expect(
      snapshots.map((snapshot) => `${snapshot.scopeKey}|${snapshot.periodKey}`).sort(),
    ).toEqual(['stock|MONTH', 'stock|TODAY', 'stock|WEEK']);
    for (const snapshot of snapshots) {
      const parsed = kpiSnapshotSchema.parse({
        scopeKey: snapshot.scopeKey,
        periodKey: snapshot.periodKey,
        computedAt: snapshot.computedAt.toISOString(),
        kpis: snapshot.kpis,
      });
      expect(parsed.kpis.length).toBeGreaterThan(0);
      for (const kpi of parsed.kpis) expect(kpi).not.toHaveProperty('explore');
    }
    const feed = await feedOf(holder.id);
    expect(feed).toHaveLength(3);
    expect(feed.every((row) => row.change_type === 'UPSERT' && row.scope_type === 'USER')).toBe(
      true,
    );
  });

  it('un second calcul au même contenu, moins d’une heure plus tard, ne republie rien ; une heure plus tard, la date est republiée', async () => {
    const firstDates = (await listSnapshotsOf(db, holder.id)).map((s) => s.computedAt.getTime());
    const again = await refresh(holder.id, new Date(now().getTime() + 5 * 60_000));
    expect(again).toEqual({ saved: 3, published: 0, deleted: 0, failed: 0 });
    expect(await feedOf(holder.id)).toHaveLength(3);
    // Aucune réécriture : la date reste celle de la dernière publication (TB-2).
    expect((await listSnapshotsOf(db, holder.id)).map((s) => s.computedAt.getTime())).toEqual(
      firstDates,
    );
    const later = await refresh(holder.id, new Date(now().getTime() + 2 * HOUR_MS));
    expect(later.published).toBe(3);
    expect(await feedOf(holder.id)).toHaveLength(6);
  });

  it('le lecteur du jeu kpi ne sert que l’instantané de son utilisateur, en portée USER', async () => {
    const [snapshot] = await listSnapshotsOf(db, holder.id);
    const entityId = snapshotEntityId(snapshot!);
    const reader = KPI_PROJECTIONS['KPI_SNAPSHOT']!;
    const own = await reader(db, entityId, { scopeType: 'USER', scopeId: holder.id });
    expect(own).toMatchObject({ id: entityId, scope_key: 'stock' });
    expect(await reader(db, entityId, { scopeType: 'USER', scopeId: nobody.id })).toBeUndefined();
    expect(await reader(db, entityId, { scopeType: 'GLOBAL', scopeId: null })).toBeUndefined();
    expect(
      await reader(db, freshUuid(), { scopeType: 'USER', scopeId: holder.id }),
    ).toBeUndefined();
  });

  it('GET /analytics/snapshots/me : les lignes de l’appelant seulement', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/snapshots/me',
      headers: { authorization: `Bearer ${tokens.get(holder.id)!}` },
    });
    expect(mine.statusCode, mine.body).toBe(200);
    const body = mine.json() as { snapshots: unknown[] };
    expect(body.snapshots.map((row) => kpiSnapshotSchema.parse(row).scopeKey)).toEqual([
      'stock',
      'stock',
      'stock',
    ]);
    const none = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/snapshots/me',
      headers: { authorization: `Bearer ${tokens.get(nobody.id)!}` },
    });
    expect((none.json() as { snapshots: unknown[] }).snapshots).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/analytics/snapshots/me' })).statusCode,
    ).toBe(401);
  });

  it('droit retiré : les instantanés du tableau sont supprimés et la suppression est publiée (DELETE)', async () => {
    await db
      .updateTable('identity_user_role_assignments')
      .set({ revoked_at: new Date(now().getTime() - HOUR_MS) })
      .where('user_id', '=', toBin(holder.id))
      .execute();
    // Les octrois sont mis en cache par processus : une révocation écrite en base se déclare au cache.
    invalidateUser(holder.id);
    const result = await refresh(holder.id);
    expect(result).toEqual({ saved: 0, published: 0, deleted: 3, failed: 0 });
    expect(await listSnapshotsOf(db, holder.id)).toEqual([]);
    const deletes = (await feedOf(holder.id)).filter((row) => row.change_type === 'DELETE');
    expect(deletes).toHaveLength(3);
  });

  it('un titulaire de analytics.dashboard.distribution seul a un instantané par période (TB-4, AV-467)', async () => {
    const seller = await actorWith(admin, ['analytics.dashboard.distribution']);
    const result = await refresh(seller.id);
    expect(result).toEqual({ saved: 3, published: 3, deleted: 0, failed: 0 });
    const snapshots = await listSnapshotsOf(db, seller.id);
    expect(
      snapshots.map((snapshot) => `${snapshot.scopeKey}|${snapshot.periodKey}`).sort(),
    ).toEqual(['distribution|MONTH', 'distribution|TODAY', 'distribution|WEEK']);
    for (const snapshot of snapshots) {
      const parsed = kpiSnapshotSchema.parse({
        scopeKey: snapshot.scopeKey,
        periodKey: snapshot.periodKey,
        computedAt: snapshot.computedAt.toISOString(),
        kpis: snapshot.kpis,
      });
      for (const kpi of parsed.kpis) expect(kpi).not.toHaveProperty('explore');
      // Les indicateurs du bloc DISTRIBUTION (aucun si la base n'a aucun point de vente) : les quatre d'origine, plus
      // KPI-OPS-02 (AV-480) et son compteur de conflits, que ce titulaire sans `sync.conflict.resolve` ne reçoit pas.
      const allowed = [
        'KPI-DIS-03',
        'KPI-DIS-06',
        'KPI-DIS-05',
        'KPI-FIN-CS-PENDING',
        'KPI-OPS-02',
        'KPI-OPS-02-CONFLICTS',
      ];
      for (const kpi of parsed.kpis) expect(allowed).toContain(kpi.code);
      const codes = parsed.kpis.map((kpi) => kpi.code);
      // Un bloc non vide (au moins un point de vente dans la portée) porte les opérations en attente.
      if (codes.length > 0) expect(codes).toContain('KPI-OPS-02');
      expect(codes).not.toContain('KPI-OPS-02-CONFLICTS');
    }
    // Droit révoqué : les trois instantanés disparaissent et la suppression est publiée.
    await db
      .updateTable('identity_user_role_assignments')
      .set({ revoked_at: new Date(now().getTime() - HOUR_MS) })
      .where('user_id', '=', toBin(seller.id))
      .execute();
    invalidateUser(seller.id);
    const revoked = await refresh(seller.id);
    expect(revoked).toEqual({ saved: 0, published: 0, deleted: 3, failed: 0 });
    expect(await listSnapshotsOf(db, seller.id)).toEqual([]);
    expect((await feedOf(seller.id)).filter((row) => row.change_type === 'DELETE')).toHaveLength(3);
  });

  describe('lecture revérifiée (TB-7)', () => {
    const tokenOf = (actor: CommandActor) =>
      signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: actor.id, device_id: actor.deviceId, session_id: freshUuid() },
        now(),
      );
    const mineOf = async (actor: CommandActor) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/analytics/snapshots/me',
        headers: { authorization: `Bearer ${await tokenOf(actor)}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { snapshots: ReturnType<typeof kpiSnapshotSchema.parse>[] })
        .snapshots;
    };
    /** Révoque une affectation précise, ou toutes celles de l'utilisateur (`assignmentId` absent). */
    const revoke = async (userId: string, assignmentId?: string) => {
      const query = db
        .updateTable('identity_user_role_assignments')
        .set({ revoked_at: new Date(now().getTime() - HOUR_MS) })
        .where('user_id', '=', toBin(userId));
      await (
        assignmentId === undefined ? query : query.where('id', '=', toBin(assignmentId))
      ).execute();
      // Les octrois sont mis en cache par processus : une révocation écrite en base se déclare au cache.
      invalidateUser(userId);
    };

    it('droit du tableau retiré avant la passe : la route et le lecteur ne servent plus la ligne', async () => {
      const user = await actorWith(admin, ['analytics.dashboard.stock']);
      expect(await refresh(user.id)).toEqual({ saved: 3, published: 3, deleted: 0, failed: 0 });
      expect(await mineOf(user)).toHaveLength(3);
      await revoke(user.id);
      // Aucune passe : la ligne brute est encore là, mais elle n'est plus servie.
      const raw = await listSnapshotsOf(db, user.id);
      expect(raw).toHaveLength(3);
      expect(await mineOf(user)).toEqual([]);
      const reader = KPI_PROJECTIONS['KPI_SNAPSHOT']!;
      for (const snapshot of raw) {
        expect(
          await reader(db, snapshotEntityId(snapshot), { scopeType: 'USER', scopeId: user.id }),
        ).toBeUndefined();
      }
    });

    it('valorisation retirée : les indicateurs protégés sont masqués à la lecture, la ligne brute est inchangée', async () => {
      const user = await db.transaction().execute(async (trx) => {
        const id = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, id, { status: 'ACTIVE' });
        const dashboardRole = await insertTestRole(trx, admin);
        await grantTestPermission(trx, dashboardRole, 'analytics.dashboard.stock', admin);
        await assignTestRole(trx, id, dashboardRole, admin);
        const valuationRole = await insertTestRole(trx, admin);
        await grantTestPermission(trx, valuationRole, 'inventory.valuation.read', admin);
        const valuationAssignment = await assignTestRole(trx, id, valuationRole, admin);
        return { id, deviceId, valuationAssignment };
      });
      invalidateUser(user.id);
      expect(await refresh(user.id)).toEqual({ saved: 3, published: 3, deleted: 0, failed: 0 });
      const kpiOf = (kpis: readonly unknown[], code: string) =>
        (kpis as { code: string; value: number | null }[]).find((entry) => entry.code === code);
      const rawBefore = await listSnapshotsOf(db, user.id);
      const rawMonth = rawBefore.find((snapshot) => snapshot.periodKey === 'MONTH')!;
      expect(kpiOf(rawMonth.kpis, 'KPI-STK-02')?.value).not.toBeNull();
      expect((await mineOf(user)).find((s) => s.periodKey === 'MONTH')).toBeDefined();

      await revoke(user.id, user.valuationAssignment);
      const served = (await mineOf(user)).find((snapshot) => snapshot.periodKey === 'MONTH')!;
      expect(served).toBeDefined();
      let protectedSeen = 0;
      for (const code of ['KPI-STK-02', 'KPI-FIN-08', 'KPI-STK-04']) {
        const masked = served.kpis.find((entry) => entry.code === code);
        if (masked === undefined) continue;
        protectedSeen += 1;
        expect(masked.value, code).toBeNull();
        expect(masked.previousValue ?? null, code).toBeNull();
        expect(masked.variationPct ?? null, code).toBeNull();
        expect(masked.explore ?? null, code).toBeNull();
      }
      expect(protectedSeen).toBeGreaterThan(0);
      // Un indicateur non protégé est servi tel quel.
      const unprotected = rawMonth.kpis.find(
        (entry) => (entry as { code: string }).code === 'KPI-STK-06',
      );
      if (unprotected !== undefined) {
        expect(served.kpis.find((entry) => entry.code === 'KPI-STK-06')).toMatchObject(
          unprotected as object,
        );
      }
      // La ligne brute (stockée avec la valorisation) n'est pas modifiée par la lecture.
      const rawAfter = (await listSnapshotsOf(db, user.id)).find((s) => s.periodKey === 'MONTH')!;
      expect(rawAfter.kpis).toEqual(rawMonth.kpis);
      expect(kpiOf(rawAfter.kpis, 'KPI-STK-02')?.value).not.toBeNull();
      // Le lecteur du jeu hors ligne masque de la même façon.
      const reader = KPI_PROJECTIONS['KPI_SNAPSHOT']!;
      const projected = await reader(db, snapshotEntityId(rawMonth), {
        scopeType: 'USER',
        scopeId: user.id,
      });
      expect(projected).toBeDefined();
      expect(kpiOf(projected!['kpis'] as unknown[], 'KPI-STK-02')?.value).toBeNull();
    });

    it('la permission lue pour un instantané est celle du tableau de bord, pour chacun des six codes', () => {
      for (const code of DASHBOARD_CODES) {
        expect(snapshotReadPermission(code), code).toBe(dashboardPermission(code));
      }
    });
  });

  describe('utilisateurs actifs et retrait des inactifs', () => {
    it('actif = compte actif, session ouverte non révoquée, appareil en service, utilisée depuis la date', async () => {
      const since = new Date(now().getTime() - 7 * 24 * HOUR_MS);
      const fresh = await actorWith(admin, []);
      await openSession(fresh.id, fresh.deviceId, new Date(now().getTime() - HOUR_MS));
      const stale = await actorWith(admin, []);
      await openSession(stale.id, stale.deviceId, new Date(now().getTime() - 30 * 24 * HOUR_MS));
      const suspendedDevice = await db.transaction().execute(async (trx) => {
        const userId = await insertTestUser(trx);
        return { id: userId };
      });
      const all = new Set<string>();
      let after: string | null = null;
      for (;;) {
        const page: readonly string[] = await activeSnapshotUsers(db, {
          since,
          afterUserId: after,
          limit: 500,
        });
        if (page.length === 0) break;
        page.forEach((id) => all.add(id));
        after = page[page.length - 1]!;
      }
      expect(all.has(fresh.id)).toBe(true);
      expect(all.has(stale.id)).toBe(false);
      expect(all.has(suspendedDevice.id)).toBe(false);
    });

    it('la reprise après un identifiant et la limite bornent la page, dans l’ordre des identifiants', async () => {
      const since = new Date(now().getTime() - 7 * 24 * HOUR_MS);
      const first = await activeSnapshotUsers(db, { since, afterUserId: null, limit: 2 });
      expect(first.length).toBeLessThanOrEqual(2);
      if (first.length === 2) {
        const next = await activeSnapshotUsers(db, { since, afterUserId: first[1]!, limit: 2 });
        expect(next.every((id) => id > first[1]!)).toBe(true);
      }
      expect([...first]).toEqual([...first].sort());
    });

    it('les instantanés d’un utilisateur devenu inactif sont retirés (DELETE publié), pas ceux d’un utilisateur actif', async () => {
      const active = await actorWith(admin, ['analytics.dashboard.stock']);
      const lapsed = await actorWith(admin, ['analytics.dashboard.stock']);
      await openSession(active.id, active.deviceId, new Date(now().getTime() - HOUR_MS));
      await openSession(lapsed.id, lapsed.deviceId, new Date(now().getTime() - 30 * 24 * HOUR_MS));
      await refresh(active.id);
      await refresh(lapsed.id);
      expect(await listSnapshotsOf(db, lapsed.id)).toHaveLength(3);

      const since = new Date(now().getTime() - 7 * 24 * HOUR_MS);
      const removed = await db
        .transaction()
        .execute((trx) => deleteSnapshotsOfInactiveUsers(trx, since));
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(await listSnapshotsOf(db, lapsed.id)).toEqual([]);
      expect(await listSnapshotsOf(db, active.id)).toHaveLength(3);
      expect((await feedOf(lapsed.id)).filter((row) => row.change_type === 'DELETE')).toHaveLength(
        3,
      );
    });
  });

  it('saveSnapshot : un contenu changé est republié, un contenu identique ne l’est pas', async () => {
    const user = await db.transaction().execute((trx) => insertTestUser(trx));
    const key = { userId: user, scopeKey: 'stock', periodKey: 'TODAY' } as const;
    const at = now();
    const kpi = (value: number) => [
      { code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value },
    ];
    const write = (kpis: readonly unknown[], computedAt: Date) =>
      db.transaction().execute((trx) => saveSnapshot(trx, { ...key, kpis, computedAt }));
    expect(await write(kpi(1), at)).toBe(true);
    expect(await write(kpi(1), new Date(at.getTime() + 60_000))).toBe(false);
    expect(await write(kpi(2), new Date(at.getTime() + 120_000))).toBe(true);
    expect(await write(kpi(2), new Date(at.getTime() + HOUR_MS + 180_000))).toBe(true);
    const [row] = await listSnapshotsOf(db, user);
    expect(fromBin(toBin(row!.userId))).toBe(user);
    expect(row!.kpis).toEqual(kpi(2));
  });

  describe('cadence de 15 minutes (TB-2)', () => {
    const MIN = 60_000;
    const kpi = (value: number) => [
      { code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value },
    ];
    const key = (userId: string) => ({ userId, scopeKey: 'stock', periodKey: 'TODAY' }) as const;
    const write = (userId: string, kpis: readonly unknown[], computedAt: Date) =>
      db.transaction().execute((trx) => saveSnapshot(trx, { ...key(userId), kpis, computedAt }));
    // Secondes entières : la colonne de date peut tronquer les millisecondes.
    const base = () => new Date(Math.floor(now().getTime() / 1000) * 1000);

    it('à la cadence de 15 minutes, la date seule est republiée au bout d’une heure', async () => {
      const user = await db.transaction().execute((trx) => insertTestUser(trx));
      const at = base();
      const published: boolean[] = [];
      for (let k = 0; k <= 8; k += 1) {
        published.push(await write(user, kpi(1), new Date(at.getTime() + k * 15 * MIN)));
        const [row] = await listSnapshotsOf(db, user);
        const expectedMin = k >= 8 ? 120 : k >= 4 ? 60 : 0;
        expect(row!.computedAt.getTime()).toBe(at.getTime() + expectedMin * MIN);
      }
      expect(published).toEqual([true, false, false, false, true, false, false, false, true]);
      // Une ligne de flux par publication, pas une par passe.
      const feed = await feedOf(user);
      expect(feed).toHaveLength(3);
      expect(feed.every((row) => row.change_type === 'UPSERT')).toBe(true);
    });

    it('un contenu qui change est publié aussitôt et sa date devient la référence de l’heure suivante', async () => {
      const user = await db.transaction().execute((trx) => insertTestUser(trx));
      const at = base();
      const published: boolean[] = [];
      for (let k = 0; k <= 6; k += 1) {
        published.push(
          await write(user, kpi(k >= 2 ? 2 : 1), new Date(at.getTime() + k * 15 * MIN)),
        );
      }
      expect(published).toEqual([true, false, true, false, false, false, true]);
    });

    it('bornes de la comparaison stricte : 59 min 59 s ne publie pas, 60 min publie', async () => {
      const user = await db.transaction().execute((trx) => insertTestUser(trx));
      const at = base();
      expect(await write(user, kpi(1), at)).toBe(true);
      expect(await write(user, kpi(1), new Date(at.getTime() + HOUR_MS - 1000))).toBe(false);
      expect(await write(user, kpi(1), new Date(at.getTime() + HOUR_MS))).toBe(true);
    });
  });
});
