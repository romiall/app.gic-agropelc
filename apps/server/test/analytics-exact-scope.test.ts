/**
 * Étendue exacte des lignes lisibles (P9-14 ; BR-ANA-004, ADR-074 §4, AV-423) : la grille portée maximale ×
 * affectation, jugée **ligne à ligne contre `evaluateAccess`** sur des lignes réelles d'un monde de test
 * (zones imbriquées, sites, équipe, trois propriétaires).
 *
 * - **Sûreté** : la clause compilée en SQL ne sélectionne jamais une ligne que `evaluateAccess` refuse. C'est la
 *   propriété qui compte : l'explorateur ne rend jamais plus que ce que l'application autorise.
 * - **Complétude** : ce que `evaluateAccess` autorise, la clause le sélectionne, pour les vingt couples de la
 *   grille (aucun écart connu).
 * - **Règle fermée** : permission absente, affectation expirée ou jeu sans colonne de portée : aucune ligne.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  evaluateAccess,
  type ResourceLocator,
} from '../src/modules/identity/application/public/index.js';
import {
  DEFAULT_MAX_SCOPE_CANDIDATES,
  resolveExactScope,
  scopeCondition,
  scopeConditions,
  type ExactScope,
  type ScopedDataset,
} from '../src/modules/analytics/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  grantTestPermission,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

afterAll(closeTestDb);

const PERMISSION = 'analytics.explore';
const OTHER_PERMISSION = 'inventory.ledger.read';
const AT = new Date();

type Trx = Transaction<DB>;
type MaxScope = 'ALL' | 'SITE' | 'ZONE' | 'TEAM' | 'OWN';
type AssignmentKind = 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';

const DATASET: ScopedDataset = {
  scope: { SITE: ['site_id'], ZONE: ['zone_id'], PERSON: ['person_id'] },
};

interface World {
  readonly admin: string;
  readonly zoneA: string;
  readonly zoneAa: string;
  readonly zoneB: string;
  readonly site1: string;
  readonly site2: string;
  readonly site3: string;
  readonly other: string;
  readonly rows: readonly Row[];
}
interface Row {
  readonly siteId: string;
  readonly zoneId: string;
  readonly ownerUserId: string;
}

async function buildWorld(trx: Trx): Promise<Omit<World, 'rows'>> {
  const admin = await insertTestUser(trx);
  const zoneA = await insertTestZone(trx, admin);
  const zoneAa = await insertTestZone(trx, admin, { parentId: zoneA });
  const zoneB = await insertTestZone(trx, admin);
  return {
    admin,
    zoneA,
    zoneAa,
    zoneB,
    site1: await insertTestSite(trx, admin, zoneA),
    site2: await insertTestSite(trx, admin, zoneAa),
    site3: await insertTestSite(trx, admin, zoneB),
    other: await insertTestUser(trx),
  };
}

/** Un utilisateur neuf, sa propre équipe (avec `mate`), son rôle de test et son affectation. */
async function grantUser(
  trx: Trx,
  world: Omit<World, 'rows'>,
  maxScope: MaxScope,
  assignment: AssignmentKind,
  options: { readonly permission?: string; readonly validTo?: Date } = {},
): Promise<{ readonly userId: string; readonly teamId: string; readonly mate: string }> {
  const userId = await insertTestUser(trx);
  const mate = await insertTestUser(trx);
  const teamId = await insertTestTeam(trx, userId, world.admin);
  // Un membre ne peut appartenir qu'à une équipe à la fois (BR-ADM-014) : un coéquipier par utilisateur.
  await insertTestTeamMembership(trx, teamId, mate, world.admin);
  const roleId = await insertTestRole(trx, world.admin, {
    allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE', 'TEAM'],
  });
  await grantTestPermission(trx, roleId, options.permission ?? PERMISSION, world.admin, {
    maxScope,
  });
  await assignTestRole(trx, userId, roleId, world.admin, {
    scopeType: assignment,
    ...(assignment === 'SITE' ? { scopeSiteId: world.site1 } : {}),
    ...(assignment === 'ZONE' ? { scopeZoneId: world.zoneA } : {}),
    ...(assignment === 'TEAM' ? { scopeTeamId: teamId } : {}),
    ...(options.validTo !== undefined ? { validTo: options.validTo } : {}),
  });
  return { userId, teamId, mate };
}

function rowsFor(world: Omit<World, 'rows'>, owners: readonly string[]): readonly Row[] {
  const sites: ReadonlyArray<readonly [string, string]> = [
    [world.site1, world.zoneA],
    [world.site2, world.zoneAa],
    [world.site3, world.zoneB],
  ];
  return sites.flatMap(([siteId, zoneId]) =>
    owners.map((ownerUserId) => ({ siteId, zoneId, ownerUserId })),
  );
}

function rowsOf(world: Omit<World, 'rows'>, userId: string, mate: string): readonly Row[] {
  return rowsFor(world, [userId, mate, world.other]);
}

/**
 * Lignes dont la zone propre diffère de celle de leur site (une vente hors point de vente porte la zone du
 * client ou du pointage, non celle du site) : le module juge la ressource `{siteId, zoneId}` de la ligne.
 */
function divergentRowsFor(world: Omit<World, 'rows'>, owners: readonly string[]): readonly Row[] {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [world.site3, world.zoneA],
    [world.site1, world.zoneB],
    [world.site2, world.zoneB],
  ];
  return pairs.flatMap(([siteId, zoneId]) =>
    owners.map((ownerUserId) => ({ siteId, zoneId, ownerUserId })),
  );
}

interface GrantSpec {
  readonly maxScope: MaxScope;
  readonly scopeType: AssignmentKind;
  readonly permission?: string;
  readonly scopeSiteId?: string;
  readonly scopeZoneId?: string;
  readonly scopeTeamId?: string;
}

/** Un rôle de test portant `permission` (portée maximale `maxScope`), affecté à l'utilisateur. */
async function addGrant(
  trx: Trx,
  world: Omit<World, 'rows'>,
  userId: string,
  spec: GrantSpec,
): Promise<void> {
  const roleId = await insertTestRole(trx, world.admin, {
    allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE', 'TEAM'],
  });
  await grantTestPermission(trx, roleId, spec.permission ?? PERMISSION, world.admin, {
    maxScope: spec.maxScope,
  });
  await assignTestRole(trx, userId, roleId, world.admin, {
    scopeType: spec.scopeType,
    ...(spec.scopeSiteId !== undefined ? { scopeSiteId: spec.scopeSiteId } : {}),
    ...(spec.scopeZoneId !== undefined ? { scopeZoneId: spec.scopeZoneId } : {}),
    ...(spec.scopeTeamId !== undefined ? { scopeTeamId: spec.scopeTeamId } : {}),
  });
}

/** Un utilisateur qui dirige une équipe (`mate`) et dont une autre équipe, qu'il ne dirige pas, a un membre (`m2`). */
async function userWithTwoTeams(
  trx: Trx,
  world: Omit<World, 'rows'>,
): Promise<{
  readonly userId: string;
  readonly mate: string;
  readonly m2: string;
  readonly assignedTeamId: string;
}> {
  const userId = await insertTestUser(trx);
  const mate = await insertTestUser(trx);
  const m2 = await insertTestUser(trx);
  const leader2 = await insertTestUser(trx);
  const managed = await insertTestTeam(trx, userId, world.admin);
  await insertTestTeamMembership(trx, managed, mate, world.admin);
  const assignedTeamId = await insertTestTeam(trx, leader2, world.admin);
  await insertTestTeamMembership(trx, assignedTeamId, m2, world.admin);
  return { userId, mate, m2, assignedTeamId };
}

const keyOf = (row: Row) => `${row.siteId}|${row.zoneId}|${row.ownerUserId}`;

/** Lignes que la clause compilée sélectionne, lues par MySQL sur les lignes du monde de test. */
async function selectedBy(
  trx: Trx,
  rows: readonly Row[],
  conditions: readonly ReturnType<typeof scopeCondition>[],
): Promise<ReadonlySet<string>> {
  const values = sql.join(
    rows.map(
      (row) => sql`ROW(${toBin(row.siteId)}, ${toBin(row.zoneId)}, ${toBin(row.ownerUserId)})`,
    ),
  );
  const where = sql.join(
    [sql`1 = 1`, ...conditions.filter((part) => part !== undefined)],
    sql` AND `,
  );
  const { rows: found } = await sql<{ site_id: Buffer; zone_id: Buffer; person_id: Buffer }>`
    SELECT site_id, zone_id, person_id FROM (VALUES ${values}) AS r(site_id, zone_id, person_id)
     WHERE ${where}
  `.execute(trx);
  return new Set(
    found.map((row) => `${fromBin(row.site_id)}|${fromBin(row.zone_id)}|${fromBin(row.person_id)}`),
  );
}

const fullLocator = (row: Row): ResourceLocator => ({
  siteId: row.siteId,
  zoneId: row.zoneId,
  ownerUserId: row.ownerUserId,
});

async function allowedRows(
  trx: Trx,
  userId: string,
  permission: string,
  rows: readonly Row[],
  locator: (row: Row) => ResourceLocator = fullLocator,
): Promise<ReadonlySet<string>> {
  const allowed = new Set<string>();
  for (const row of rows) {
    const access = await evaluateAccess(trx, {
      userId,
      permissionCode: permission,
      occurredAt: AT,
      resource: locator(row),
    });
    if (access.allowed) allowed.add(keyOf(row));
  }
  return allowed;
}

/**
 * Un jeu de faits ne porte pas toujours les trois attributs (un compte n'a pas de site, un mouvement pas de
 * propriétaire) : la ressource jugée par `evaluateAccess` ne porte alors que les attributs du jeu.
 */
interface Projection {
  readonly name: string;
  readonly dataset: ScopedDataset;
  readonly locator: (row: Row) => ResourceLocator;
}

const PROJECTIONS: readonly Projection[] = [
  { name: 'site, zone et personne', dataset: DATASET, locator: fullLocator },
  {
    name: 'site et personne',
    dataset: { scope: { SITE: ['site_id'], PERSON: ['person_id'] } },
    locator: (row) => ({ siteId: row.siteId, ownerUserId: row.ownerUserId }),
  },
  {
    name: 'zone et personne',
    dataset: { scope: { ZONE: ['zone_id'], PERSON: ['person_id'] } },
    locator: (row) => ({ zoneId: row.zoneId, ownerUserId: row.ownerUserId }),
  },
  {
    name: 'site seul',
    dataset: { scope: { SITE: ['site_id'] } },
    locator: (row) => ({ siteId: row.siteId }),
  },
  {
    name: 'zone seule',
    dataset: { scope: { ZONE: ['zone_id'] } },
    locator: (row) => ({ zoneId: row.zoneId }),
  },
  {
    name: 'personne seule',
    dataset: { scope: { PERSON: ['person_id'] } },
    locator: (row) => ({ ownerUserId: row.ownerUserId }),
  },
];

const projection = (name: string): Projection => {
  const found = PROJECTIONS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`projection inconnue : ${name}`);
  return found;
};

/** Écarts (lignes rendues à tort, lignes autorisées non rendues) de chaque projection, et lignes lisibles. */
async function judgeProjections(
  trx: Trx,
  userId: string,
  rows: readonly Row[],
  scope: ExactScope,
): Promise<{ readonly report: readonly string[]; readonly readable: ReadonlyMap<string, number> }> {
  const report: string[] = [];
  const readable = new Map<string, number>();
  for (const candidate of PROJECTIONS) {
    const selected = await selectedBy(trx, rows, [scopeCondition(candidate.dataset, scope)]);
    const allowed = await allowedRows(trx, userId, PERMISSION, rows, candidate.locator);
    const tooWide = [...selected].filter((key) => !allowed.has(key)).length;
    const missing = [...allowed].filter((key) => !selected.has(key)).length;
    if (tooWide > 0) report.push(`${candidate.name} : ${tooWide} ligne(s) rendue(s) à tort`);
    if (missing > 0)
      report.push(`${candidate.name} : ${missing} ligne(s) autorisée(s) non rendue(s)`);
    readable.set(candidate.name, allowed.size);
  }
  return { report, readable };
}

const ownersOf = (keys: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...keys].map((key) => key.split('|')[2]));

const MAX_SCOPES: readonly MaxScope[] = ['ALL', 'SITE', 'ZONE', 'TEAM', 'OWN'];
const ASSIGNMENTS: readonly AssignmentKind[] = ['GLOBAL', 'SITE', 'ZONE', 'TEAM'];

describe('étendue exacte : grille portée maximale × affectation', () => {
  it('la clause ne sélectionne jamais plus qu’evaluateAccess, et rend ce qu’il autorise', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const report: string[] = [];
      let nonEmpty = 0;
      for (const maxScope of MAX_SCOPES) {
        for (const assignment of ASSIGNMENTS) {
          const label = `${maxScope}/${assignment}`;
          const { userId, mate } = await grantUser(trx, base, maxScope, assignment);
          const rows = rowsOf(base, userId, mate);
          const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
          const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
          const allowed = await allowedRows(trx, userId, PERMISSION, rows);
          const tooWide = [...selected].filter((key) => !allowed.has(key));
          expect(tooWide, `${label} : lignes rendues que evaluateAccess refuse`).toEqual([]);
          const missing = [...allowed].filter((key) => !selected.has(key));
          if (missing.length > 0) {
            report.push(`${label} : ${missing.length} ligne(s) autorisée(s) non rendue(s)`);
          }
          if (allowed.size > 0) nonEmpty += 1;
        }
      }
      expect(report).toEqual([]);
      // La grille n'est pas vide : la plupart des couples donnent des lignes.
      expect(nonEmpty).toBeGreaterThan(10);
    });
  });

  it('portée maximale ALL : aucune restriction, sous toute affectation', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      for (const assignment of ASSIGNMENTS) {
        const { userId } = await grantUser(trx, base, 'ALL', assignment);
        expect(
          await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT }),
          assignment,
        ).toEqual({ kind: 'ALL' });
      }
    });
  });

  it('un propriétaire seul : OWN sous une affectation globale rend ses propres lignes, de tout site', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'OWN', 'GLOBAL');
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect([...selected].sort()).toEqual(
        rows
          .filter((row) => row.ownerUserId === userId)
          .map(keyOf)
          .sort(),
      );
    });
  });

  it('OWN sous une affectation de site : ses lignes de ce site seulement (couple site et soi)', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'OWN', 'SITE');
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect([...selected]).toEqual(
        rows.filter((r) => r.ownerUserId === userId && r.siteId === base.site1).map(keyOf),
      );
    });
  });

  it('SITE sous une affectation de zone : les sites de la zone et de ses descendantes', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'SITE', 'ZONE');
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect(new Set(rows.filter((r) => r.siteId !== base.site3).map(keyOf))).toEqual(selected);
    });
  });

  it('plusieurs rôles : l’union de leurs étendues, ligne à ligne comme evaluateAccess', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'SITE', 'SITE');
      // Un second rôle, de portée propriétaire sous une affectation globale, pour la même permission.
      const secondRole = await insertTestRole(trx, base.admin);
      await grantTestPermission(trx, secondRole, PERMISSION, base.admin, { maxScope: 'OWN' });
      await assignTestRole(trx, userId, secondRole, base.admin);
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      const allowed = await allowedRows(trx, userId, PERMISSION, rows);
      expect(selected).toEqual(allowed);
      // Le site de l'affectation (tous propriétaires) et ses propres lignes (tout site) : 3 + 3 - 1.
      expect(selected.size).toBe(5);
    });
  });

  it('un jeu à plusieurs colonnes de portée se lit par l’une d’elles (un mouvement : l’un de ses deux sites)', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId } = await grantUser(trx, base, 'SITE', 'SITE');
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const moves: ScopedDataset = { scope: { SITE: ['from_site_id', 'to_site_id'] } };
      const pairs: ReadonlyArray<readonly [string, string]> = [
        [base.site1, base.site3],
        [base.site3, base.site1],
        [base.site2, base.site3],
        [base.site3, base.site3],
      ];
      const values = sql.join(pairs.map(([a, b]) => sql`ROW(${toBin(a)}, ${toBin(b)})`));
      const condition = scopeCondition(moves, scope);
      const { rows: found } = await sql<{ from_site_id: Buffer; to_site_id: Buffer }>`
        SELECT from_site_id, to_site_id FROM (VALUES ${values}) AS r(from_site_id, to_site_id)
         WHERE ${condition}
      `.execute(trx);
      expect(
        found.map((row) => `${fromBin(row.from_site_id)}|${fromBin(row.to_site_id)}`).sort(),
      ).toEqual([`${base.site1}|${base.site3}`, `${base.site3}|${base.site1}`].sort());
    });
  });

  it('TEAM : soi et les membres de l’équipe qu’on dirige, de tout site', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'TEAM', 'GLOBAL');
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect(selected).toEqual(
        new Set(rows.filter((r) => r.ownerUserId !== base.other).map(keyOf)),
      );
    });
  });
});

describe('étendue exacte : jeux qui ne portent qu’une partie des attributs', () => {
  it('la grille entière, jugée pour chaque projection (site seul, zone seule, personne seule…)', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const report: string[] = [];
      const readable = new Map<string, number>();
      for (const maxScope of MAX_SCOPES) {
        for (const assignment of ASSIGNMENTS) {
          const { userId, mate } = await grantUser(trx, base, maxScope, assignment);
          const rows = rowsOf(base, userId, mate);
          const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
          const judged = await judgeProjections(trx, userId, rows, scope);
          report.push(...judged.report.map((line) => `${maxScope}/${assignment} ${line}`));
          for (const [name, count] of judged.readable) {
            readable.set(name, (readable.get(name) ?? 0) + count);
          }
        }
      }
      expect(report).toEqual([]);
      // Aucune projection n'est jugée à vide : chacune rend des lignes quelque part dans la grille.
      for (const candidate of PROJECTIONS) {
        expect(readable.get(candidate.name) ?? 0, candidate.name).toBeGreaterThan(0);
      }
    });
  });

  it('un jeu qui porte le site et la zone propre de la ligne (zone différente de celle du site) : la grille entière', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const report: string[] = [];
      let divergentReadable = 0;
      for (const maxScope of MAX_SCOPES) {
        for (const assignment of ASSIGNMENTS) {
          const { userId, mate } = await grantUser(trx, base, maxScope, assignment);
          const owners = [userId, mate, base.other];
          const rows = [...rowsFor(base, owners), ...divergentRowsFor(base, owners)];
          const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
          const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
          const allowed = await allowedRows(trx, userId, PERMISSION, rows);
          const tooWide = [...selected].filter((key) => !allowed.has(key)).length;
          const missing = [...allowed].filter((key) => !selected.has(key)).length;
          if (tooWide > 0)
            report.push(`${maxScope}/${assignment} : ${tooWide} ligne(s) rendue(s) à tort`);
          if (missing > 0) {
            report.push(
              `${maxScope}/${assignment} : ${missing} ligne(s) autorisée(s) non rendue(s)`,
            );
          }
          divergentReadable += divergentRowsFor(base, owners).filter((row) =>
            allowed.has(keyOf(row)),
          ).length;
        }
      }
      expect(report).toEqual([]);
      expect(divergentReadable).toBeGreaterThan(0);
    });
  });

  it('SITE ou ZONE sous une affectation d’équipe : les membres de l’équipe affectée, non ceux d’une équipe dirigée', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      for (const maxScope of ['SITE', 'ZONE'] as const) {
        const { userId, mate, m2, assignedTeamId } = await userWithTwoTeams(trx, base);
        await addGrant(trx, base, userId, {
          maxScope,
          scopeType: 'TEAM',
          scopeTeamId: assignedTeamId,
        });
        const rows = rowsFor(base, [userId, mate, m2, base.other]);
        const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
        const judged = await judgeProjections(trx, userId, rows, scope);
        expect(judged.report, maxScope).toEqual([]);
        const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
        expect(ownersOf(selected), maxScope).toEqual(new Set([m2]));
        // Le membre de l'équipe affectée se lit par les projections qui portent une personne et le périmètre exigé.
        const projections =
          maxScope === 'SITE' ? ['site et personne'] : ['site et personne', 'zone et personne'];
        for (const name of projections) {
          expect(judged.readable.get(name), `${maxScope} ${name}`).toBeGreaterThan(0);
        }
        expect(judged.readable.get('personne seule'), `${maxScope} personne seule`).toBe(0);
      }
    });
  });

  it('un octroi global à côté d’un octroi d’équipe : les membres viennent des équipes, pas du pré-filtre', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate, m2, assignedTeamId } = await userWithTwoTeams(trx, base);
      // Un octroi TEAM (équipe dirigée et équipe affectée) et un octroi ZONE global : `listConfinementAt` rend `null`.
      await addGrant(trx, base, userId, {
        maxScope: 'TEAM',
        scopeType: 'TEAM',
        scopeTeamId: assignedTeamId,
      });
      await addGrant(trx, base, userId, { maxScope: 'ZONE', scopeType: 'GLOBAL' });
      const rows = rowsFor(base, [userId, mate, m2, base.other]);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const judged = await judgeProjections(trx, userId, rows, scope);
      expect(judged.report).toEqual([]);
      const personOnly = projection('personne seule');
      const selected = await selectedBy(trx, rows, [scopeCondition(personOnly.dataset, scope)]);
      expect(ownersOf(selected)).toEqual(new Set([userId, mate, m2]));
    });
  });

  it('deux octrois sous des affectations de zone, de portées maximales différentes : l’union des deux', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const userId = await insertTestUser(trx);
      const mate = await insertTestUser(trx);
      // Portée `ZONE` sur la zone A (et sa descendante) et portée `SITE` sur la zone B : les zones lues sans
      // exiger de site et celles lues pour une ligne qui porte un site coexistent dans la même clause.
      await addGrant(trx, base, userId, {
        maxScope: 'ZONE',
        scopeType: 'ZONE',
        scopeZoneId: base.zoneA,
      });
      await addGrant(trx, base, userId, {
        maxScope: 'SITE',
        scopeType: 'ZONE',
        scopeZoneId: base.zoneB,
      });
      const owners = [userId, mate, base.other];
      const rows = [...rowsFor(base, owners), ...divergentRowsFor(base, owners)];
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const judged = await judgeProjections(trx, userId, rows, scope);
      expect(judged.report).toEqual([]);
      const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect(selected).toEqual(await allowedRows(trx, userId, PERMISSION, rows));
      const zonesRead = new Set([...selected].map((key) => key.split('|')[1]));
      expect(zonesRead).toEqual(new Set([base.zoneA, base.zoneAa, base.zoneB]));
    });
  });

  it('les affectations d’un autre droit sont des candidats jugés pour cette permission, jamais retenus d’office', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      for (const assignment of ['SITE', 'GLOBAL'] as const) {
        const userId = await insertTestUser(trx);
        const mate = await insertTestUser(trx);
        await addGrant(trx, base, userId, {
          maxScope: 'OWN',
          scopeType: assignment,
          ...(assignment === 'SITE' ? { scopeSiteId: base.site1 } : {}),
        });
        // Des affectations de site et de zone pour une autre permission : candidats, non droits de celle-ci.
        await addGrant(trx, base, userId, {
          maxScope: 'OWN',
          scopeType: 'SITE',
          scopeSiteId: base.site3,
          permission: OTHER_PERMISSION,
        });
        await addGrant(trx, base, userId, {
          maxScope: 'OWN',
          scopeType: 'ZONE',
          scopeZoneId: base.zoneB,
          permission: OTHER_PERMISSION,
        });
        const rows = rowsOf(base, userId, mate);
        const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
        const judged = await judgeProjections(trx, userId, rows, scope);
        expect(judged.report, assignment).toEqual([]);
        if (assignment === 'SITE') {
          // Ses lignes du seul site de l'affectation, non celles des sites d'un autre droit.
          const selected = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
          expect(selected).toEqual(
            new Set(
              rows.filter((r) => r.ownerUserId === userId && r.siteId === base.site1).map(keyOf),
            ),
          );
        } else {
          // Soi suffit : aucune clause (site, soi) redondante.
          expect(scope).toMatchObject({ kind: 'CLAUSES' });
          expect(
            scope.kind === 'CLAUSES' ? scope.clauses.map((clause) => clause.type) : [],
          ).toEqual(['PERSONS']);
        }
      }
    });
  });
});

describe('étendue exacte : règle fermée', () => {
  it('une permission absente donne une étendue vide, qui ne sélectionne aucune ligne', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'ALL', 'GLOBAL', {
        permission: OTHER_PERMISSION,
      });
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      expect(scope).toEqual({ kind: 'CLAUSES', clauses: [], truncated: false });
      const selected = await selectedBy(trx, rowsOf(base, userId, mate), [
        scopeCondition(DATASET, scope),
      ]);
      expect(selected.size).toBe(0);
    });
  });

  it('une affectation expirée donne une étendue vide', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId } = await grantUser(trx, base, 'ALL', 'GLOBAL', {
        validTo: new Date('2021-01-01T00:00:00.000Z'),
      });
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      expect(scope).toEqual({ kind: 'CLAUSES', clauses: [], truncated: false });
    });
  });

  it('un jeu sans colonne pour le type de portée ne rend aucune ligne (jamais « tout »)', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'SITE', 'SITE');
      const rows = rowsOf(base, userId, mate);
      const scope = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const withSite = await selectedBy(trx, rows, [scopeCondition(DATASET, scope)]);
      expect(withSite.size).toBeGreaterThan(0);
      const personOnly: ScopedDataset = { scope: { PERSON: ['person_id'] } };
      const withoutSite = await selectedBy(trx, rows, [scopeCondition(personOnly, scope)]);
      expect(withoutSite.size).toBe(0);
    });
  });

  it('plusieurs permissions exigées : l’intersection de leurs étendues', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'SITE', 'ZONE');
      // La seconde permission est accordée en propre par un second rôle, de portée propriétaire seule.
      const secondRole = await insertTestRole(trx, base.admin);
      await grantTestPermission(trx, secondRole, OTHER_PERMISSION, base.admin, { maxScope: 'OWN' });
      await assignTestRole(trx, userId, secondRole, base.admin);
      const rows = rowsOf(base, userId, mate);
      const first = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const second = await resolveExactScope(trx, { userId, permission: OTHER_PERMISSION, at: AT });
      const both = await selectedBy(trx, rows, scopeConditions(DATASET, [first, second]));
      const a = await selectedBy(trx, rows, [scopeCondition(DATASET, first)]);
      const b = await selectedBy(trx, rows, [scopeCondition(DATASET, second)]);
      expect(a.size).toBeGreaterThan(0);
      expect(b.size).toBeGreaterThan(0);
      expect(both).toEqual(new Set([...a].filter((key) => b.has(key))));
      expect(both.size).toBeGreaterThan(0);
      expect(both.size).toBeLessThan(a.size);
    });
  });

  it('au-delà du nombre de candidats, l’étendue est tronquée, plus étroite et signalée', async () => {
    await withTestUow(async (trx) => {
      const base = await buildWorld(trx);
      const { userId, mate } = await grantUser(trx, base, 'SITE', 'ZONE');
      const rows = rowsOf(base, userId, mate);
      const full = await resolveExactScope(trx, { userId, permission: PERMISSION, at: AT });
      const tight = await resolveExactScope(
        trx,
        { userId, permission: PERMISSION, at: AT },
        { maxCandidates: 1 },
      );
      expect(full).toMatchObject({ kind: 'CLAUSES', truncated: false });
      expect(tight).toMatchObject({ kind: 'CLAUSES', truncated: true });
      const wide = await selectedBy(trx, rows, [scopeCondition(DATASET, full)]);
      const narrow = await selectedBy(trx, rows, [scopeCondition(DATASET, tight)]);
      expect([...narrow].every((key) => wide.has(key))).toBe(true);
      expect(narrow.size).toBeLessThan(wide.size);
      expect(DEFAULT_MAX_SCOPE_CANDIDATES).toBeGreaterThan(1);
    });
  });
});

describe('compilation de l’étendue', () => {
  const scope = (clauses: ExactScope & { kind: 'CLAUSES' }) => clauses;
  it('l’étendue ALL ne restreint rien, une étendue vide ne rend rien', () => {
    expect(scopeCondition(DATASET, { kind: 'ALL' })).toBeUndefined();
    expect(scopeConditions(DATASET, [{ kind: 'ALL' }, { kind: 'ALL' }])).toEqual([]);
    expect(
      scopeCondition(DATASET, scope({ kind: 'CLAUSES', clauses: [], truncated: false })),
    ).toBeDefined();
  });
});
