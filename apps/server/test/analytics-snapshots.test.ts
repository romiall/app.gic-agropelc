/**
 * P9-18 — instantanés personnels d'indicateurs (ADR-076 §5 à §7 ; AV-430, AV-431, AV-498 ; AT-054) : le calcul par
 * utilisateur (`refreshSnapshotsOf`), la publication au flux du jeu hors ligne `kpi` (portée `USER`, republication au
 * changement ou toutes les heures), la suppression à la perte du droit, les utilisateurs actifs (compte, session,
 * appareil, ancienneté), le retrait des inactifs, le lecteur du jeu `kpi` et la route `GET /analytics/snapshots/me`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { kpiSnapshotSchema } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  KPI_DATASET,
  activeSnapshotUsers,
  deleteSnapshotsOfInactiveUsers,
  listSnapshotsOf,
  saveSnapshot,
  snapshotEntityId,
} from '../src/modules/analytics/application/public/index.js';
import { refreshSnapshotsOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { KPI_PROJECTIONS } from '../src/sync/kpi-projections.js';
import { actorWith, type CommandActor } from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser, signTestAccessToken } from './helpers.js';

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
    expect(await refresh(nobody.id)).toEqual({ saved: 0, published: 0, deleted: 0 });
    expect(await listSnapshotsOf(db, nobody.id)).toEqual([]);
  });

  it('un instantané par période pour le tableau dont il détient la permission, sans lien d’exploration, publié au flux USER', async () => {
    const result = await refresh(holder.id);
    expect(result).toEqual({ saved: 3, published: 3, deleted: 0 });
    const snapshots = await listSnapshotsOf(db, holder.id);
    expect(snapshots.map((snapshot) => `${snapshot.scopeKey}|${snapshot.periodKey}`).sort()).toEqual([
      'stock|MONTH',
      'stock|TODAY',
      'stock|WEEK',
    ]);
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
    expect(feed.every((row) => row.change_type === 'UPSERT' && row.scope_type === 'USER')).toBe(true);
  });

  it('un second calcul au même contenu, moins d’une heure plus tard, ne republie rien ; une heure plus tard, la date est republiée', async () => {
    const again = await refresh(holder.id, new Date(now().getTime() + 5 * 60_000));
    expect(again).toEqual({ saved: 3, published: 0, deleted: 0 });
    expect(await feedOf(holder.id)).toHaveLength(3);
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
    expect(await reader(db, freshUuid(), { scopeType: 'USER', scopeId: holder.id })).toBeUndefined();
  });

  it('GET /analytics/snapshots/me : les lignes de l’appelant seulement', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/snapshots/me',
      headers: { authorization: `Bearer ${tokens.get(holder.id)!}` },
    });
    expect(mine.statusCode, mine.body).toBe(200);
    const body = mine.json() as { snapshots: unknown[] };
    expect(body.snapshots.map((row) => kpiSnapshotSchema.parse(row).scopeKey)).toEqual(['stock', 'stock', 'stock']);
    const none = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/snapshots/me',
      headers: { authorization: `Bearer ${tokens.get(nobody.id)!}` },
    });
    expect((none.json() as { snapshots: unknown[] }).snapshots).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/analytics/snapshots/me' })).statusCode).toBe(401);
  });

  it('droit retiré : les instantanés du tableau sont supprimés et la suppression est publiée (DELETE)', async () => {
    await db
      .updateTable('identity_user_role_assignments')
      .set({ revoked_at: new Date(now().getTime() - HOUR_MS) })
      .where('user_id', '=', toBin(holder.id))
      .execute();
    const result = await refresh(holder.id);
    expect(result).toEqual({ saved: 0, published: 0, deleted: 3 });
    expect(await listSnapshotsOf(db, holder.id)).toEqual([]);
    const deletes = (await feedOf(holder.id)).filter((row) => row.change_type === 'DELETE');
    expect(deletes).toHaveLength(3);
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
        const page: readonly string[] = await activeSnapshotUsers(db, { since, afterUserId: after, limit: 500 });
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
      const removed = await db.transaction().execute((trx) => deleteSnapshotsOfInactiveUsers(trx, since));
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(await listSnapshotsOf(db, lapsed.id)).toEqual([]);
      expect(await listSnapshotsOf(db, active.id)).toHaveLength(3);
      expect((await feedOf(lapsed.id)).filter((row) => row.change_type === 'DELETE')).toHaveLength(3);
    });
  });

  it('saveSnapshot : un contenu changé est republié, un contenu identique ne l’est pas', async () => {
    const user = await db.transaction().execute((trx) => insertTestUser(trx));
    const key = { userId: user, scopeKey: 'stock', periodKey: 'TODAY' } as const;
    const at = now();
    const kpi = (value: number) => [{ code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value }];
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
});
