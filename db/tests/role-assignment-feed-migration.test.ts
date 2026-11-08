// Migration 20261207090000 (ADR-071 ; AV-533, AV-550 à AV-552 ; Q24 du 08/11/2026) : le jeu `role_assignment` du flux de
// changements ne va plus qu'à l'utilisateur de l'affectation. Le SQL **du fichier de migration lui-même** est rejoué ici sur
// des copies, à nom unique, des deux tables (`CREATE TABLE … LIKE`, supprimées en fin d'essai) : rien n'est écrit dans le flux
// partagé, aucun trou dans sa numérotation, aucune interférence avec les essais qui tirent le flux. Des tables temporaires ne
// conviendraient pas : MySQL refuse qu'une instruction lise et écrive la même table temporaire (erreur 1137), ce que fait le
// retrait en lisant le flux pour y écrire.
// - retrait : une ligne `SCOPE_EXIT` de portée `GLOBAL` par affectation déjà publiée en `GLOBAL`, une seule même publiée
//   plusieurs fois (octroi puis révocation), rien pour les autres jeux ni les autres portées ;
// - rattrapage : une ligne `UPSERT` de portée `USER` par affectation, à sa version courante, révoquée ou échue comprises ;
// - le retrait est écrit avant le rattrapage ; le retour arrière ne supprime que ce que la migration ajoute.
// Le comportement de l'appareil devant ces lignes est éprouvé côté PWA (role-assignment-transition.test.ts), celui du
// serveur qui les sert dans apps/server/test/sync-role-assignment-scope.test.ts.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const FILE = '20261207090000_publish_role_assignments_to_their_user.sql';
const text = readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const [upPart, downPart] = text.split(/^-- migrate:down.*$/m);
const upSection = upPart!.split(/^-- migrate:up.*$/m)[1]!;

/** Instructions d'une section, commentaires `--` retirés, telles qu'écrites dans le fichier. */
const statementsOf = (section: string): string[] =>
  section
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
const upStatements = statementsOf(upSection);
const downStatements = statementsOf(downPart!);

/** Copies de l'essai en cours (voir `withCopies`). */
let copies = { feed: '', assignments: '' };
const retarget = (statement: string): string =>
  statement
    .replace(/\bsync_change_feed\b/g, copies.feed)
    .replace(/\bidentity_user_role_assignments\b/g, copies.assignments);

/** Crée les copies à nom unique du flux et des affectations, exécute `fn`, puis les supprime quoi qu'il arrive. */
async function withCopies<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  return withRollback(async (conn) => {
    const suffix = randomBytes(5).toString('hex');
    copies = { feed: `zz_test_feed_${suffix}`, assignments: `zz_test_ura_${suffix}` };
    try {
      await conn.query(`CREATE TABLE ${copies.feed} LIKE sync_change_feed`);
      await conn.query(`CREATE TABLE ${copies.assignments} LIKE identity_user_role_assignments`);
      return await fn(conn);
    } finally {
      await conn.query(`DROP TABLE IF EXISTS ${copies.feed}, ${copies.assignments}`);
    }
  });
}

interface FeedLine {
  readonly dataset: string;
  readonly entityType: string;
  readonly entityId: Buffer;
  readonly changeType: string;
  readonly scopeType: string;
  readonly scopeId: Buffer | null;
  readonly version: number;
}

const line = (overrides: Partial<FeedLine> & Pick<FeedLine, 'entityId'>): FeedLine => ({
  dataset: 'role_assignment',
  entityType: 'ROLE_ASSIGNMENT',
  changeType: 'UPSERT',
  scopeType: 'GLOBAL',
  scopeId: null,
  version: 1,
  ...overrides,
});

async function seedFeed(conn: PoolConnection, lines: readonly FeedLine[]): Promise<void> {
  if (lines.length === 0) return;
  await conn.query(
    `INSERT INTO ${copies.feed} (dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version)
     VALUES ?`,
    [
      lines.map((l) => [
        l.dataset,
        l.entityType,
        l.entityId,
        l.changeType,
        l.scopeType,
        l.scopeId,
        l.version,
      ]),
    ],
  );
}

async function seedAssignment(
  conn: PoolConnection,
  assignment: {
    readonly id: Buffer;
    readonly userId: Buffer;
    readonly version: number;
    readonly revoked?: boolean;
    readonly expired?: boolean;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO ${copies.assignments}
       (id, user_id, role_id, scope_type, valid_from, valid_to, revoked_at, created_by, version)
     VALUES (?, ?, ?, 'GLOBAL', '2026-01-01 00:00:00.000000', ?, ?, ?, ?)`,
    [
      assignment.id,
      assignment.userId,
      randomId(),
      assignment.expired ? '2026-02-01 00:00:00.000000' : null,
      assignment.revoked ? '2026-03-01 00:00:00.000000' : null,
      assignment.userId,
      assignment.version,
    ],
  );
}

async function runUp(conn: PoolConnection): Promise<void> {
  for (const statement of upStatements) await conn.query(retarget(statement));
}

interface Stored {
  readonly seq: number;
  readonly dataset: string;
  readonly entityType: string;
  readonly entity: string;
  readonly changeType: string;
  readonly scopeType: string;
  readonly scope: string | null;
  readonly version: number;
}

async function stored(conn: PoolConnection): Promise<Stored[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT seq, dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version
       FROM ${copies.feed} ORDER BY seq`,
  );
  return rows.map((row) => ({
    seq: Number(row.seq),
    dataset: row.dataset as string,
    entityType: row.entity_type as string,
    entity: (row.entity_id as Buffer).toString('hex'),
    changeType: row.change_type as string,
    scopeType: row.scope_type as string,
    scope: row.scope_id === null ? null : (row.scope_id as Buffer).toString('hex'),
    version: Number(row.row_version),
  }));
}
const hex = (id: Buffer) => id.toString('hex');

describe('migration 20261207090000 : jeu role_assignment publié à l’utilisateur de l’affectation (ADR-071)', () => {
  it('le fichier est celui attendu : deux instructions montantes, une descendante, sur les deux tables concernées', () => {
    expect(upStatements).toHaveLength(2);
    expect(downStatements).toHaveLength(1);
    expect(
      upStatements.every((statement) => statement.startsWith('INSERT INTO sync_change_feed')),
    ).toBe(true);
    expect(upStatements[1]).toContain('identity_user_role_assignments');
    expect(downStatements[0]).toMatch(/^DELETE FROM sync_change_feed/);
  });

  it('retrait : une ligne SCOPE_EXIT GLOBAL par affectation publiée en GLOBAL, une seule même publiée plusieurs fois', async () => {
    await withCopies(async (conn) => {
      const [granted, revoked, other, alreadyUser, otherDataset] = [
        randomId(),
        randomId(),
        randomId(),
        randomId(),
        randomId(),
      ];
      const user = randomId();
      await seedFeed(conn, [
        line({ entityId: granted }), // octroi (repli du pipeline)
        line({ entityId: granted }), // révocation (repli du pipeline)
        line({ entityId: revoked }),
        line({ entityId: other, version: 3 }),
        line({ entityId: alreadyUser, scopeType: 'USER', scopeId: user }), // déjà en portée USER : pas de retrait
        line({ entityId: otherDataset, dataset: 'user', entityType: 'USER' }), // autre jeu, même portée GLOBAL
      ]);

      await runUp(conn);

      const exits = (await stored(conn)).filter((row) => row.changeType === 'SCOPE_EXIT');
      expect(exits.map((row) => row.entity).sort()).toEqual(
        [hex(granted), hex(revoked), hex(other)].sort(),
      );
      for (const row of exits) {
        expect(row).toMatchObject({
          dataset: 'role_assignment',
          entityType: 'ROLE_ASSIGNMENT',
          scopeType: 'GLOBAL',
          scope: null,
          version: 1,
        });
      }
      // Les lignes d'avant ne sont ni modifiées ni supprimées (flux en ajout seul).
      expect((await stored(conn)).filter((row) => row.changeType === 'UPSERT')).toHaveLength(6);
    });
  });

  it('rattrapage : une ligne UPSERT USER par affectation, à sa version, révoquée ou échue comprises', async () => {
    await withCopies(async (conn) => {
      const [alice, bob] = [randomId(), randomId()];
      const [a1, a2, a3, a4] = [randomId(), randomId(), randomId(), randomId()];
      await seedAssignment(conn, { id: a1, userId: alice, version: 1 });
      await seedAssignment(conn, { id: a2, userId: alice, version: 2, revoked: true });
      await seedAssignment(conn, { id: a3, userId: bob, version: 1, expired: true });
      await seedAssignment(conn, { id: a4, userId: bob, version: 5 });

      await runUp(conn);

      const users = (await stored(conn)).filter((row) => row.scopeType === 'USER');
      expect(users).toHaveLength(4);
      expect(
        users.every((row) => row.changeType === 'UPSERT' && row.dataset === 'role_assignment'),
      ).toBe(true);
      expect(users.every((row) => row.entityType === 'ROLE_ASSIGNMENT')).toBe(true);
      const byEntity = new Map(users.map((row) => [row.entity, row]));
      expect(byEntity.get(hex(a1))).toMatchObject({ scope: hex(alice), version: 1 });
      expect(byEntity.get(hex(a2))).toMatchObject({ scope: hex(alice), version: 2 });
      expect(byEntity.get(hex(a3))).toMatchObject({ scope: hex(bob), version: 1 });
      expect(byEntity.get(hex(a4))).toMatchObject({ scope: hex(bob), version: 5 });
      // Aucune ligne GLOBAL : la portée d'une affectation est son utilisateur, jamais « tout le monde ».
      expect((await stored(conn)).filter((row) => row.scopeType === 'GLOBAL')).toEqual([]);
    });
  });

  it('retrait écrit avant le rattrapage ; une affectation publiée en GLOBAL reçoit les deux lignes', async () => {
    await withCopies(async (conn) => {
      const [user, id] = [randomId(), randomId()];
      await seedAssignment(conn, { id, userId: user, version: 1 });
      await seedFeed(conn, [line({ entityId: id })]);

      await runUp(conn);

      const rows = await stored(conn);
      expect(rows.map((row) => [row.changeType, row.scopeType])).toEqual([
        ['UPSERT', 'GLOBAL'], // l'ancienne ligne
        ['SCOPE_EXIT', 'GLOBAL'], // le retrait
        ['UPSERT', 'USER'], // le rattrapage
      ]);
      expect(rows[1]!.seq).toBeLessThan(rows[2]!.seq);
      expect(rows[2]).toMatchObject({ entity: hex(id), scope: hex(user) });
    });
  });

  it('sans affectation ni ligne GLOBAL (base neuve) : rien n’est écrit', async () => {
    await withCopies(async (conn) => {
      await runUp(conn);
      expect(await stored(conn)).toEqual([]);
    });
  });

  it('retour arrière : supprime les retraits GLOBAL et les lignes USER du jeu, rien d’autre', async () => {
    await withCopies(async (conn) => {
      const [user, id, otherEntity] = [randomId(), randomId(), randomId()];
      await seedAssignment(conn, { id, userId: user, version: 1 });
      await seedFeed(conn, [
        line({ entityId: id }),
        line({ entityId: otherEntity, dataset: 'user', entityType: 'USER' }),
        line({
          entityId: otherEntity,
          dataset: 'user',
          entityType: 'USER',
          changeType: 'SCOPE_EXIT',
        }),
        line({
          entityId: otherEntity,
          dataset: 'user',
          entityType: 'USER',
          scopeType: 'USER',
          scopeId: user,
        }),
      ]);
      await runUp(conn);

      for (const statement of downStatements) await conn.query(retarget(statement));

      const rows = await stored(conn);
      // Restent : l'ancienne ligne GLOBAL du jeu, et les trois lignes de l'autre jeu (même forme, jeu différent).
      expect(
        rows
          .filter((row) => row.dataset === 'role_assignment')
          .map((row) => [row.changeType, row.scopeType]),
      ).toEqual([['UPSERT', 'GLOBAL']]);
      expect(rows.filter((row) => row.dataset === 'user')).toHaveLength(3);
    });
  });
});
