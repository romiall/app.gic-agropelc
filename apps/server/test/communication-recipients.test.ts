/**
 * P9-05 : adaptateur du résolveur de destinataires (ADR-062 §1, §2 ; BR-NOT-001, BR-NOT-008). Les
 * affectations sont jugées comme `evaluateAccess` : `GLOBAL` couvre tout, `SITE` le site, `ZONE` la zone et
 * ses descendantes, `TEAM` l'équipe dont un propriétaire est membre ; un utilisateur inactif, une
 * affectation révoquée ou échue n'est jamais renvoyé. La base est partagée : chaque test crée son
 * périmètre et ne juge que ses propres utilisateurs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityRecipientResolver } from '../src/communication-api/identity-recipient-resolver.js';
import { newActor, roleIdOf, tx, type Actor } from './cash-transfer-fixtures.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestRole,
  insertTestZone,
  withTestUow,
} from './helpers.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';

const AT = new Date('2026-11-02T10:00:00.000Z');
const resolver = new IdentityRecipientResolver();

let root: string;
/** Arbre : `parent` ⊃ `child` ; `other` est une zone sans lien. */
let parentZone: string;
let childZone: string;
let otherZone: string;
let siteInChild: string;
let siteInOther: string;

const holdersOf = (
  roles: readonly string[],
  perimeter: { siteId?: string | null; zoneId?: string | null; owners?: readonly string[] },
) =>
  withTestUow(async (uow) =>
    (
      await resolver.usersHoldingRolesAt(uow, {
        roles,
        perimeter: {
          siteId: perimeter.siteId ?? null,
          zoneId: perimeter.zoneId ?? null,
          ownerUserIds: perimeter.owners ?? [],
        },
        at: AT,
      })
    ).map((holder) => holder.userId),
  );

describe('P9-05 : résolveur de destinataires (adaptateur identity)', () => {
  beforeAll(async () => {
    root = await tx((trx) => insertTestUser(trx));
    await tx(async (trx) => {
      parentZone = await insertTestZone(trx, root);
      childZone = await insertTestZone(trx, root, { parentId: parentZone });
      otherZone = await insertTestZone(trx, root);
      siteInChild = await insertTestSite(trx, root, childZone);
      siteInOther = await insertTestSite(trx, root, otherZone);
    });
  });

  afterAll(closeTestDb);

  it('GLOBAL couvre tout ; SITE le seul site ; ZONE la zone et ses descendantes', async () => {
    // Aucun rôle ne porte les trois périmètres : un rôle par périmètre, une seule requête sur les trois.
    const global: Actor = await newActor('FINANCE', root, { scopeType: 'GLOBAL' });
    const siteHolder = await newActor('MAGASINIER', root, {
      scopeType: 'SITE',
      scopeSiteId: siteInChild,
    });
    const otherSiteHolder = await newActor('MAGASINIER', root, {
      scopeType: 'SITE',
      scopeSiteId: siteInOther,
    });
    const parentZoneHolder = await newActor('RESP_COMMERCIAL', root, {
      scopeType: 'ZONE',
      scopeZoneId: parentZone,
    });
    const otherZoneHolder = await newActor('RESP_COMMERCIAL', root, {
      scopeType: 'ZONE',
      scopeZoneId: otherZone,
    });
    const roles = ['FINANCE', 'MAGASINIER', 'RESP_COMMERCIAL'];

    const onSite = await holdersOf(roles, { siteId: siteInChild });
    expect(onSite).toContain(global.userId);
    expect(onSite).toContain(siteHolder.userId);
    expect(onSite).toContain(parentZoneHolder.userId); // la zone parente couvre le site de la zone fille
    expect(onSite).not.toContain(otherSiteHolder.userId);
    expect(onSite).not.toContain(otherZoneHolder.userId);

    // Sans site (alerte globale) : seule une affectation GLOBAL couvre.
    const noSite = await holdersOf(roles, {});
    expect(noSite).toContain(global.userId);
    expect(noSite).not.toContain(siteHolder.userId);
    expect(noSite).not.toContain(parentZoneHolder.userId);

    // Zone seule (sans site) : la zone fille est couverte par la zone parente, pas par un site.
    const onZone = await holdersOf(roles, { zoneId: childZone });
    expect(onZone).toContain(parentZoneHolder.userId);
    expect(onZone).not.toContain(siteHolder.userId);
  });

  it('TEAM : le propriétaire doit être membre de l’équipe de l’affectation', async () => {
    const manager = await tx((trx) => insertTestUser(trx));
    const owner = await tx((trx) => insertTestUser(trx));
    const stranger = await tx((trx) => insertTestUser(trx));
    const team = await tx((trx) => insertTestTeam(trx, manager, root));
    await tx((trx) => insertTestTeamMembership(trx, team, owner, root));
    const roleId = await roleIdOf('RESP_COMMERCIAL');
    const teamLead = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, roleId, root, { scopeType: 'TEAM', scopeTeamId: team });
      return userId;
    });

    expect(await holdersOf(['RESP_COMMERCIAL'], { owners: [owner] })).toContain(teamLead);
    expect(await holdersOf(['RESP_COMMERCIAL'], { owners: [stranger] })).not.toContain(teamLead);
    expect(await holdersOf(['RESP_COMMERCIAL'], {})).not.toContain(teamLead);
  });

  it('TEAM : une appartenance échue ne couvre plus le propriétaire', async () => {
    const manager = await tx((trx) => insertTestUser(trx));
    const former = await tx((trx) => insertTestUser(trx));
    const team = await tx((trx) => insertTestTeam(trx, manager, root));
    await tx((trx) =>
      insertTestTeamMembership(trx, team, former, root, {
        validTo: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    const teamLead = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, await roleIdOf('RESP_COMMERCIAL'), root, {
        scopeType: 'TEAM',
        scopeTeamId: team,
      });
      return userId;
    });
    expect(await holdersOf(['RESP_COMMERCIAL'], { owners: [former] })).not.toContain(teamLead);
  });

  it('un rôle désactivé ne désigne personne', async () => {
    const roleId = await tx((trx) => insertTestRole(trx, root, { allowedScopeTypes: ['GLOBAL'] }));
    const row = await db
      .selectFrom('identity_roles')
      .select('code')
      .where('id', '=', toBin(roleId))
      .executeTakeFirstOrThrow();
    const holder = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, roleId, root, { scopeType: 'GLOBAL' });
      return userId;
    });
    expect(await holdersOf([row.code], {})).toContain(holder);
    await db
      .updateTable('identity_roles')
      .set({ is_active: 0 })
      .where('id', '=', toBin(roleId))
      .execute();
    expect(await holdersOf([row.code], {})).not.toContain(holder);
  });

  it('un utilisateur sans affectation active n’est ni propriétaire ni responsable utile', async () => {
    const roleId = await roleIdOf('FINANCE');
    const assigned = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, roleId, root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const bare = await tx((trx) => insertTestUser(trx));
    const revoked = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, roleId, root, {
        scopeType: 'GLOBAL',
        revokedAt: new Date('2026-10-15T00:00:00Z'),
      });
      return userId;
    });
    const result = await withTestUow((uow) =>
      resolver.activeUsersAmong(uow, [assigned, bare, revoked], AT),
    );
    expect(result).toEqual([assigned]);

    // Responsable d'équipe sans affectation : écarté.
    const member = await tx((trx) => insertTestUser(trx));
    const team = await tx((trx) => insertTestTeam(trx, bare, root));
    await tx((trx) => insertTestTeamMembership(trx, team, member, root));
    expect(await withTestUow((uow) => resolver.teamManagersOf(uow, [member], AT))).toEqual([]);
  });

  it('équipe désactivée : son responsable n’est pas destinataire', async () => {
    const manager = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, await roleIdOf('FINANCE'), root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const member = await tx((trx) => insertTestUser(trx));
    const team = await tx((trx) => insertTestTeam(trx, manager, root));
    await tx((trx) => insertTestTeamMembership(trx, team, member, root));
    expect(await withTestUow((uow) => resolver.teamManagersOf(uow, [member], AT))).toEqual([
      manager,
    ]);
    await db
      .updateTable('organization_teams')
      .set({ is_active: 0 })
      .where('id', '=', toBin(team))
      .execute();
    expect(await withTestUow((uow) => resolver.teamManagersOf(uow, [member], AT))).toEqual([]);
  });

  it('un utilisateur inactif, une affectation révoquée ou échue ne sont jamais renvoyés', async () => {
    const roleId = await roleIdOf('FINANCE');
    const make = (options: {
      status?: 'ACTIVE' | 'SUSPENDED';
      revokedAt?: Date | null;
      validTo?: Date | null;
      validFrom?: Date;
    }) =>
      tx(async (trx) => {
        const userId = await insertTestUser(trx, {
          status: options.status ?? 'ACTIVE',
          statusChangedAt: options.status === 'SUSPENDED' ? new Date('2026-10-01T00:00:00Z') : null,
        });
        await assignTestRole(trx, userId, roleId, root, {
          scopeType: 'GLOBAL',
          ...(options.revokedAt !== undefined ? { revokedAt: options.revokedAt } : {}),
          ...(options.validTo !== undefined ? { validTo: options.validTo } : {}),
          ...(options.validFrom !== undefined ? { validFrom: options.validFrom } : {}),
        });
        return userId;
      });
    const active = await make({});
    const suspended = await make({ status: 'SUSPENDED' });
    const revoked = await make({ revokedAt: new Date('2026-10-15T00:00:00Z') });
    const expired = await make({ validTo: new Date('2026-10-20T00:00:00Z') });
    const future = await make({ validFrom: new Date('2026-12-01T00:00:00Z') });
    // Révoquée plus tard que l'instant jugé : encore valide à `AT`.
    const revokedLater = await make({ revokedAt: new Date('2026-12-15T00:00:00Z') });

    const holders = await holdersOf(['FINANCE'], {});
    expect(holders).toContain(active);
    expect(holders).toContain(revokedLater);
    for (const excluded of [suspended, revoked, expired, future]) {
      expect(holders).not.toContain(excluded);
    }
  });

  it('plusieurs rôles : le premier rôle demandé est retenu, un seul résultat par utilisateur', async () => {
    const both = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, await roleIdOf('FINANCE'), root, { scopeType: 'GLOBAL' });
      await assignTestRole(trx, userId, await roleIdOf('DIRECTION'), root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const result = await withTestUow((uow) =>
      resolver.usersHoldingRolesAt(uow, {
        roles: ['DIRECTION', 'FINANCE'],
        perimeter: { siteId: null, zoneId: null, ownerUserIds: [] },
        at: AT,
      }),
    );
    const mine = result.filter((holder) => holder.userId === both);
    expect(mine).toEqual([{ userId: both, roleCode: 'DIRECTION' }]);
    expect(
      await withTestUow((uow) =>
        resolver.usersHoldingRolesAt(uow, {
          roles: [],
          perimeter: { siteId: null, zoneId: null, ownerUserIds: [] },
          at: AT,
        }),
      ),
    ).toEqual([]);
  });

  it('responsables d’équipe : actifs, équipes actives, membres à l’instant jugé', async () => {
    const activeManager = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, await roleIdOf('FINANCE'), root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const suspendedManager = await tx((trx) =>
      insertTestUser(trx, {
        status: 'SUSPENDED',
        statusChangedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    const member = await tx((trx) => insertTestUser(trx));
    const memberOfSuspended = await tx((trx) => insertTestUser(trx));
    const lateMember = await tx((trx) => insertTestUser(trx));
    const teamA = await tx((trx) => insertTestTeam(trx, activeManager, root));
    const teamB = await tx((trx) => insertTestTeam(trx, suspendedManager, root));
    await tx(async (trx) => {
      await insertTestTeamMembership(trx, teamA, member, root);
      await insertTestTeamMembership(trx, teamB, memberOfSuspended, root);
      await insertTestTeamMembership(trx, teamA, lateMember, root, {
        validFrom: new Date('2026-12-01T00:00:00Z'),
      });
    });
    const managers = await withTestUow((uow) =>
      resolver.teamManagersOf(uow, [member, memberOfSuspended], AT),
    );
    expect(managers).toEqual([activeManager]);
    expect(await withTestUow((uow) => resolver.teamManagersOf(uow, [lateMember], AT))).toEqual([]);
    expect(await withTestUow((uow) => resolver.teamManagersOf(uow, [], AT))).toEqual([]);
  });

  it('utilisateurs actifs et affectés parmi une liste', async () => {
    const active = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, await roleIdOf('FINANCE'), root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const suspended = await tx(async (trx) => {
      const userId = await insertTestUser(trx, {
        status: 'SUSPENDED',
        statusChangedAt: new Date('2026-10-01T00:00:00Z'),
      });
      await assignTestRole(trx, userId, await roleIdOf('FINANCE'), root, { scopeType: 'GLOBAL' });
      return userId;
    });
    const result = await withTestUow((uow) =>
      resolver.activeUsersAmong(uow, [active, suspended, active], AT),
    );
    expect(result).toEqual([active]);
    expect(await withTestUow((uow) => resolver.activeUsersAmong(uow, [], AT))).toEqual([]);
  });

  it('approbateurs : la décision est celle du moteur de droits, le demandeur est exclu', async () => {
    // `finance.expense.approve` n'est pas garanti : on prend une permission sensible semée, portée SITE.
    const permission = await db
      .selectFrom('identity_role_permissions as rp')
      .innerJoin('identity_roles as r', 'r.id', 'rp.role_id')
      .select(['rp.permission_code', 'r.code as role_code', 'rp.max_scope'])
      .where('r.code', '=', 'MAGASINIER')
      .where('rp.max_scope', '=', 'SITE')
      .limit(1)
      .executeTakeFirstOrThrow();
    const inSite = await newActor('MAGASINIER', root, {
      scopeType: 'SITE',
      scopeSiteId: siteInChild,
    });
    const elsewhere = await newActor('MAGASINIER', root, {
      scopeType: 'SITE',
      scopeSiteId: siteInOther,
    });
    const requester = await newActor('MAGASINIER', root, {
      scopeType: 'SITE',
      scopeSiteId: siteInChild,
    });
    const approvers = await withTestUow((uow) =>
      resolver.usersHoldingPermissionAt(uow, {
        permission: permission.permission_code,
        perimeter: { siteId: siteInChild, zoneId: null, ownerUserIds: [] },
        at: AT,
        excludeUserIds: [requester.userId],
      }),
    );
    expect(approvers).toContain(inSite.userId);
    expect(approvers).not.toContain(elsewhere.userId);
    expect(approvers).not.toContain(requester.userId);
  });
});
