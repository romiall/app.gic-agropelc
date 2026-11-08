/**
 * ADR-071 (AV-533, Q24 du 08/11/2026) — le jeu `role_assignment` ne va plus qu'à l'utilisateur de l'affectation. Côté appareil,
 * aucun code nouveau : le retrait des affectations des autres comptes, reçues jusqu'ici par une ligne `GLOBAL`, est le
 * `SCOPE_EXIT` que la migration `20261207090000` ajoute au flux (une ligne par affectation publiée jusque-là), suivi du
 * rattrapage `UPSERT` de portée `USER` de l'affectation de l'utilisateur. Ces essais le prouvent sur la vraie `applyChange` et
 * le vrai `runPullCycle`, contre un serveur simulé qui répond ce que le vrai pull rend (`apps/server/test/
 * sync-role-assignment-scope.test.ts`) :
 * - un appareil déjà alimenté perd les affectations des autres comptes et garde la sienne, quel que soit l'ordre des deux
 *   lignes ; le reste de l'appareil (autres jeux, curseurs, file d'envoi) n'est pas touché ;
 * - un appareil neuf ne reçoit que la ligne `USER` de son utilisateur ;
 * - une tablette partagée repart de zéro au changement d'utilisateur (`ensureDataOwner`) : chacun ne voit que les siennes ;
 * - une affectation révoquée est republiée avec `revoked_at` et reste dans le périmètre `USER` de son titulaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '@gic/domain';
import type { Change, PullResponse } from '@gic/contracts';
import { createTestDb, type GicDatabase, type Projection } from '../storage/db.js';
import { clearSessionRuntime, setSessionRuntime } from '../features/auth/session-runtime.js';
import { listProjected } from '../storage/projections.js';
import type { RoleAssignmentData } from '../features/sales/types.js';
import { runPullCycle } from './pull.js';

const clock = new FixedClock(new Date('2026-11-09T08:00:00.000Z'));
const DATASET = 'role_assignment';
const ENTITY_TYPE = 'ROLE_ASSIGNMENT';

function startSession(userId: string): void {
  setSessionRuntime({
    userId,
    deviceId: 'device-1',
    deviceStatus: 'ACTIVE',
    refreshToken: `refresh-${userId}`,
    accessToken: `access-${userId}`,
    accessTokenExpiresAt: Date.now() + 60_000,
    pinKey: {} as CryptoKey,
  });
}

const assignmentData = (id: string, userId: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: userId,
  role_id: `role-${id}`,
  scope_type: 'SITE',
  scope_site_id: 'site-1',
  scope_zone_id: null,
  scope_team_id: null,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_to: null,
  revoked_at: null,
  ...extra,
});

/** Projection d'une affectation reçue avant la décision : ligne `GLOBAL`, donc périmètre `GLOBAL:`. */
const legacyProjection = (id: string, userId: string): Projection => ({
  key: `${DATASET}:${ENTITY_TYPE}:${id}`,
  dataset: DATASET,
  entity_type: ENTITY_TYPE,
  entity_id: id,
  scope_type: 'GLOBAL',
  scope_id: null,
  scopes: ['GLOBAL:'],
  row_version: 1,
  seq: 5,
  data: assignmentData(id, userId),
});

const scopeExit = (seq: number, id: string): Change => ({
  seq,
  dataset: DATASET,
  entity_type: ENTITY_TYPE,
  entity_id: id,
  change_type: 'SCOPE_EXIT',
  scope_type: 'GLOBAL',
  scope_id: null,
  row_version: 1,
});

const userUpsert = (seq: number, id: string, userId: string, version = 1, extra = {}): Change => ({
  seq,
  dataset: DATASET,
  entity_type: ENTITY_TYPE,
  entity_id: id,
  change_type: 'UPSERT',
  scope_type: 'USER',
  scope_id: userId,
  row_version: version,
  data: assignmentData(id, userId, extra),
});

/** Serveur simulé : le jeu `role_assignment` rend `changes`, tous les autres jeux rien (leur curseur reste où il était). */
function serve(changes: readonly Change[], nextCursor: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const cursor = Number(/cursor=(\d+)/.exec(url)?.[1] ?? 0);
      const body: PullResponse = url.includes(`dataset=${DATASET}&`)
        ? { changes: [...changes], next_cursor: nextCursor, has_more: false }
        : { changes: [], next_cursor: cursor, has_more: false };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const assignmentsOnDevice = async (db: GicDatabase) =>
  (await db.projections.where('dataset').equals(DATASET).toArray()).sort((a, b) =>
    a.entity_id.localeCompare(b.entity_id),
  );

describe('ADR-071 — jeu role_assignment : retrait sur l’appareil et affectations de l’utilisateur seul', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-role-assignment-${Math.random()}`);
    await db.syncMeta.put({
      key: 'device',
      device_id: 'device-1',
      clock_skew_ms: null,
      last_sync_at: null,
      data_user_id: 'user-1',
    });
    startSession('user-1');
  });

  afterEach(async () => {
    clearSessionRuntime();
    vi.unstubAllGlobals();
    await db.delete();
  });

  /** Appareil alimenté par l'ancien jeu : trois affectations (la sienne, celles de deux autres comptes), autres données, file d'envoi. */
  async function legacyDevice(): Promise<void> {
    await db.projections.bulkPut([
      legacyProjection('a-own', 'user-1'),
      legacyProjection('b-other', 'user-2'),
      legacyProjection('c-other', 'user-3'),
      {
        key: 'orders:SALES_ORDER:o1',
        dataset: 'orders',
        entity_type: 'SALES_ORDER',
        entity_id: 'o1',
        scope_type: 'USER',
        scope_id: 'user-1',
        scopes: ['USER:user-1'],
        row_version: 1,
        seq: 9,
        data: { number: 'CMD-1' },
      },
      {
        key: 'me:SETTING:s1',
        dataset: 'me',
        entity_type: 'SETTING',
        entity_id: 's1',
        scope_type: 'GLOBAL',
        scope_id: null,
        scopes: ['GLOBAL:'],
        row_version: 1,
        seq: 3,
        data: { key: 'x' },
      },
    ]);
    await db.syncCursors.bulkPut([
      { dataset: DATASET, cursor: 40, pulled_at: '2026-11-01T00:00:00.000Z' },
      { dataset: 'orders', cursor: 9, pulled_at: '2026-11-01T00:00:00.000Z' },
    ]);
    await db.outbox.put({
      command_id: 'cmd-1',
      device_seq: 1,
      command_type: 'organization.setting.set',
      command_version: 1,
      author_user_id: 'user-1',
      aggregate_type: 'SETTING',
      aggregate_id: 's1',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-11-08T10:00:00.000Z',
      client_created_at: '2026-11-08T10:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'PENDING_SYNC',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
  }

  it.each([
    ['retrait puis republication (ordre de la migration)', 'EXIT_FIRST'],
    ['republication puis retrait', 'USER_FIRST'],
  ] as const)(
    'appareil déjà alimenté, %s : les affectations des autres comptes quittent l’appareil, la sienne reste en portée USER',
    async (_label, order) => {
      await legacyDevice();
      const exits = [scopeExit(41, 'a-own'), scopeExit(42, 'b-other'), scopeExit(43, 'c-other')];
      const own = userUpsert(44, 'a-own', 'user-1');
      serve(order === 'EXIT_FIRST' ? [...exits, own] : [own, ...exits], 44);

      const result = await runPullCycle(db, { clock, userId: 'user-1' });
      expect(result).toMatchObject({ outcome: 'SYNCED' });

      const left = await assignmentsOnDevice(db);
      expect(left.map((row) => row.entity_id)).toEqual(['a-own']);
      expect(left[0]).toMatchObject({
        key: `${DATASET}:${ENTITY_TYPE}:a-own`,
        scope_type: 'USER',
        scope_id: 'user-1',
        scopes: ['USER:user-1'],
        data: { id: 'a-own', user_id: 'user-1', scope_type: 'SITE', scope_site_id: 'site-1' },
      });
      // Le lecteur de l'appareil (zones et sites proposés) ne voit plus que la sienne.
      const read = await listProjected<RoleAssignmentData>(db, DATASET, ENTITY_TYPE);
      expect(read.map((assignment) => assignment.user_id)).toEqual(['user-1']);

      // Rien d'autre n'a bougé : les autres jeux, leurs curseurs, la donnée de l'utilisateur et la file d'envoi.
      expect(await db.projections.get('orders:SALES_ORDER:o1')).toMatchObject({
        data: { number: 'CMD-1' },
      });
      expect(await db.projections.get('me:SETTING:s1')).toMatchObject({ data: { key: 'x' } });
      expect((await db.syncCursors.get('orders'))?.cursor).toBe(9);
      expect((await db.syncCursors.get(DATASET))?.cursor).toBe(44);
      expect(await db.outbox.get('cmd-1')).toMatchObject({ status: 'PENDING_SYNC' });
      expect((await db.syncMeta.get('device'))?.data_user_id).toBe('user-1');
    },
  );

  it('appareil neuf : seules les lignes USER de l’utilisateur sont servies, les retraits n’ont rien à retirer', async () => {
    // Le serveur saute les anciennes lignes GLOBAL (projection restreinte) : il ne reste que le retrait et le rattrapage.
    serve(
      [scopeExit(41, 'a-own'), scopeExit(42, 'b-other'), userUpsert(44, 'a-own', 'user-1')],
      44,
    );
    expect(await runPullCycle(db, { clock, userId: 'user-1' })).toMatchObject({
      outcome: 'SYNCED',
    });
    const mine = await assignmentsOnDevice(db);
    expect(mine.map((row) => [row.entity_id, row.scopes])).toEqual([['a-own', ['USER:user-1']]]);
  });

  it('révocation : l’affectation est republiée avec revoked_at, gardée en portée USER, et ne compte plus en vigueur', async () => {
    serve([userUpsert(44, 'a-own', 'user-1')], 44);
    await runPullCycle(db, { clock, userId: 'user-1' });

    serve([userUpsert(45, 'a-own', 'user-1', 2, { revoked_at: '2026-11-08T12:00:00.000Z' })], 45);
    await runPullCycle(db, { clock, userId: 'user-1' });

    const [row] = await assignmentsOnDevice(db);
    expect(row).toMatchObject({
      scopes: ['USER:user-1'],
      row_version: 2,
      data: { id: 'a-own', revoked_at: '2026-11-08T12:00:00.000Z' },
    });
    expect(await assignmentsOnDevice(db)).toHaveLength(1);
  });

  it('tablette partagée : au changement d’utilisateur l’appareil repart de zéro et ne garde que les affectations du suivant', async () => {
    serve([userUpsert(44, 'a-own', 'user-1')], 44);
    await runPullCycle(db, { clock, userId: 'user-1' });
    expect((await assignmentsOnDevice(db)).map((row) => row.entity_id)).toEqual(['a-own']);

    // user-2 se connecte sur la même tablette : jeux et curseurs effacés (ADR-037), puis tirage dans son périmètre.
    startSession('user-2');
    serve([userUpsert(46, 'b-other', 'user-2')], 46);
    expect(await runPullCycle(db, { clock, userId: 'user-2' })).toMatchObject({
      outcome: 'SYNCED',
    });
    const second = await assignmentsOnDevice(db);
    expect(second.map((row) => [row.entity_id, row.scopes])).toEqual([
      ['b-other', ['USER:user-2']],
    ]);
    expect((await db.syncMeta.get('device'))?.data_user_id).toBe('user-2');
  });
});
