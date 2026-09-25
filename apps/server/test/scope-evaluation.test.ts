/**
 * Intersection « portée maximale ∩ périmètre de l'affectation » (P0-10 ; 01-rbac.md §2, §4
 * RC-01, RC-04). Un cas par (portée maximale × type d'affectation) combinaison réellement
 * documentée (voir `scope-evaluation.ts` en-tête pour la simplification DÉDUITE sur TEAM),
 * plus RC-01 (occurred_at) et le passage des `limits` (RC-06). Toutes les fixtures vivent
 * dans une transaction annulée (`withTestUow`) : rien n'est laissé en base.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAccess,
  type ResourceLocator,
} from '../src/modules/identity/application/public/index.js';
import {
  assignTestRole,
  grantTestPermission,
  insertTestPermission,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

const OCCURRED_AT = new Date('2026-09-24T09:00:00.000Z');
const PERMISSION = 'test.scope_demo.read';

describe('evaluateAccess — intersection portée maximale ∩ affectation (P0-10)', () => {
  it('ALL : aucune restriction, même sur une ressource sans aucun attribut', async () => {
    const allowed = await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const role = await insertTestRole(trx, grantee);
      await grantTestPermission(trx, role, PERMISSION, grantee, { maxScope: 'ALL' });
      await assignTestRole(trx, grantee, role, grantee);
      const result = await evaluateAccess(trx, {
        userId: grantee,
        permissionCode: PERMISSION,
        occurredAt: OCCURRED_AT,
        resource: {},
      });
      return result;
    });
    expect(allowed).toEqual({ allowed: true, limits: null });
  });

  it('OWN + affectation GLOBAL : propriétaire = utilisateur, n’importe où', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const other = await insertTestUser(trx);
      const role = await insertTestRole(trx, grantee);
      await grantTestPermission(trx, role, PERMISSION, grantee, { maxScope: 'OWN' });
      await assignTestRole(trx, grantee, role, grantee);

      const ownResource: ResourceLocator = { ownerUserId: grantee };
      const othersResource: ResourceLocator = { ownerUserId: other };

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: OCCURRED_AT,
          resource: ownResource,
        }),
      ).toEqual({ allowed: true, limits: null });

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: OCCURRED_AT,
          resource: othersResource,
        }),
      ).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
    });
  });

  it('OWN + affectation SITE : la portée maximale est encore restreinte au site de l’affectation', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const zone = await insertTestZone(trx, grantee);
      const siteIn = await insertTestSite(trx, grantee, zone);
      const siteOut = await insertTestSite(trx, grantee, zone);
      const role = await insertTestRole(trx, grantee, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, role, PERMISSION, grantee, { maxScope: 'OWN' });
      await assignTestRole(trx, grantee, role, grantee, { scopeType: 'SITE', scopeSiteId: siteIn });

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: OCCURRED_AT,
          resource: { ownerUserId: grantee, siteId: siteIn },
        }),
      ).toEqual({ allowed: true, limits: null });

      // Propriétaire correct, mais hors du site de l'affectation : l'intersection refuse.
      expect(
        (
          await evaluateAccess(trx, {
            userId: grantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { ownerUserId: grantee, siteId: siteOut },
          })
        ).allowed,
      ).toBe(false);
    });
  });

  it('SITE + affectation GLOBAL : n’importe quel site ; SITE + affectation SITE : ce site seulement', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const zone = await insertTestZone(trx, await insertTestUser(trx));
      const admin = await insertTestUser(trx);
      const siteA = await insertTestSite(trx, admin, zone);
      const siteB = await insertTestSite(trx, admin, zone);

      const globalGrantee = await insertTestUser(trx);
      const globalRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, globalRole, PERMISSION, admin, { maxScope: 'SITE' });
      await assignTestRole(trx, globalGrantee, globalRole, admin);
      for (const siteId of [siteA, siteB]) {
        expect(
          (
            await evaluateAccess(trx, {
              userId: globalGrantee,
              permissionCode: PERMISSION,
              occurredAt: OCCURRED_AT,
              resource: { siteId },
            })
          ).allowed,
        ).toBe(true);
      }
      // Une ressource sans site est hors de portée d'une permission SITE.
      expect(
        (
          await evaluateAccess(trx, {
            userId: globalGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: {},
          })
        ).allowed,
      ).toBe(false);

      const siteGrantee = await insertTestUser(trx);
      const siteRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, siteRole, PERMISSION, admin, { maxScope: 'SITE' });
      await assignTestRole(trx, siteGrantee, siteRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      expect(
        (
          await evaluateAccess(trx, {
            userId: siteGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { siteId: siteA },
          })
        ).allowed,
      ).toBe(true);
      expect(
        (
          await evaluateAccess(trx, {
            userId: siteGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { siteId: siteB },
          })
        ).allowed,
      ).toBe(false);
    });
  });

  it('ZONE + affectation ZONE : la ressource peut être rattachée directement ou via son site, sous-arbre inclus', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const admin = await insertTestUser(trx);
      const zoneRoot = await insertTestZone(trx, admin);
      const zoneChild = await insertTestZone(trx, admin, { parentId: zoneRoot });
      const zoneOther = await insertTestZone(trx, admin);
      const siteInChild = await insertTestSite(trx, admin, zoneChild);
      const siteOutside = await insertTestSite(trx, admin, zoneOther);

      const grantee = await insertTestUser(trx);
      const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['ZONE'] });
      await grantTestPermission(trx, role, PERMISSION, admin, { maxScope: 'ZONE' });
      await assignTestRole(trx, grantee, role, admin, { scopeType: 'ZONE', scopeZoneId: zoneRoot });

      // La zone racine elle-même (depth=0 dans zone_ancestors).
      expect(
        (
          await evaluateAccess(trx, {
            userId: grantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { zoneId: zoneRoot },
          })
        ).allowed,
      ).toBe(true);
      // Une sous-zone : couverte par le sous-arbre.
      expect(
        (
          await evaluateAccess(trx, {
            userId: grantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { zoneId: zoneChild },
          })
        ).allowed,
      ).toBe(true);
      // Un site de la sous-zone, résolu par site → zone (aucune zoneId directe fournie).
      expect(
        (
          await evaluateAccess(trx, {
            userId: grantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { siteId: siteInChild },
          })
        ).allowed,
      ).toBe(true);
      // Hors du sous-arbre : refusé.
      expect(
        (
          await evaluateAccess(trx, {
            userId: grantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { siteId: siteOutside },
          })
        ).allowed,
      ).toBe(false);
    });
  });

  it('TEAM : soi-même, membre d’une équipe dirigée, ou membre de l’équipe de l’affectation (§2)', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const admin = await insertTestUser(trx);

      const managerGrantee = await insertTestUser(trx); // dirige teamManaged
      const teamManaged = await insertTestTeam(trx, managerGrantee, admin);
      const memberOfManaged = await insertTestUser(trx);
      await insertTestTeamMembership(trx, teamManaged, memberOfManaged, admin);

      const roleGlobal = await insertTestRole(trx, admin);
      await grantTestPermission(trx, roleGlobal, PERMISSION, admin, { maxScope: 'TEAM' });
      await assignTestRole(trx, managerGrantee, roleGlobal, admin); // affectation GLOBAL

      // Soi-même, toujours inclus.
      expect(
        (
          await evaluateAccess(trx, {
            userId: managerGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { ownerUserId: managerGrantee },
          })
        ).allowed,
      ).toBe(true);
      // Membre d'une équipe qu'il dirige, via une affectation GLOBAL.
      expect(
        (
          await evaluateAccess(trx, {
            userId: managerGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { ownerUserId: memberOfManaged },
          })
        ).allowed,
      ).toBe(true);

      // Un utilisateur qui ne dirige aucune équipe, mais reçoit une affectation TEAM sur
      // teamManaged (délégation) : couvert par l'autre branche du OU (§2).
      const delegateGrantee = await insertTestUser(trx);
      const roleTeam = await insertTestRole(trx, admin, { allowedScopeTypes: ['TEAM'] });
      await grantTestPermission(trx, roleTeam, PERMISSION, admin, { maxScope: 'TEAM' });
      await assignTestRole(trx, delegateGrantee, roleTeam, admin, {
        scopeType: 'TEAM',
        scopeTeamId: teamManaged,
      });
      expect(
        (
          await evaluateAccess(trx, {
            userId: delegateGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { ownerUserId: memberOfManaged },
          })
        ).allowed,
      ).toBe(true);

      // Ni soi-même, ni équipe dirigée, ni équipe de l'affectation : refusé.
      const stranger = await insertTestUser(trx);
      expect(
        (
          await evaluateAccess(trx, {
            userId: delegateGrantee,
            permissionCode: PERMISSION,
            occurredAt: OCCURRED_AT,
            resource: { ownerUserId: stranger },
          })
        ).allowed,
      ).toBe(false);
    });
  });

  it('RC-01 : occurred_at avant valid_from ou après révocation → NO_PERMISSION', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const role = await insertTestRole(trx, grantee);
      await grantTestPermission(trx, role, PERMISSION, grantee, { maxScope: 'ALL' });
      const validFrom = new Date('2026-06-01T00:00:00.000Z');
      const revokedAt = new Date('2026-09-01T00:00:00.000Z');
      await assignTestRole(trx, grantee, role, grantee, { validFrom, revokedAt });

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'), // avant valid_from
          resource: {},
        }),
      ).toEqual({ allowed: false, reason: 'NO_PERMISSION' });

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: new Date('2026-07-01T00:00:00.000Z'), // entre les deux : active
          resource: {},
        }),
      ).toEqual({ allowed: true, limits: null });

      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: new Date('2026-10-01T00:00:00.000Z'), // après révocation
          resource: {},
        }),
      ).toEqual({ allowed: false, reason: 'NO_PERMISSION' });
    });
  });

  it('RC-06 : les limites (role_permissions.limits) sont renvoyées avec l’octroi accordé', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const role = await insertTestRole(trx, grantee);
      await grantTestPermission(trx, role, PERMISSION, grantee, {
        maxScope: 'ALL',
        limits: { max_discount_pct: 5 },
      });
      await assignTestRole(trx, grantee, role, grantee);

      const result = await evaluateAccess(trx, {
        userId: grantee,
        permissionCode: PERMISSION,
        occurredAt: OCCURRED_AT,
        resource: {},
      });
      expect(result).toEqual({ allowed: true, limits: { max_discount_pct: 5 } });
    });
  });

  it('plusieurs octrois pour la même permission : un octroi hors portée n’empêche pas un autre, plus large, de s’appliquer', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const admin = await insertTestUser(trx);
      const zone = await insertTestZone(trx, admin);
      const siteA = await insertTestSite(trx, admin, zone);
      const siteB = await insertTestSite(trx, admin, zone);

      const grantee = await insertTestUser(trx);
      const narrowRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, narrowRole, PERMISSION, admin, { maxScope: 'SITE' });
      await assignTestRole(trx, grantee, narrowRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });

      const broadRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, broadRole, PERMISSION, admin, { maxScope: 'ALL' });
      await assignTestRole(trx, grantee, broadRole, admin);

      // siteB est hors de la portée du premier octroi (SITE : siteA), mais le second (ALL) l'autorise.
      expect(
        await evaluateAccess(trx, {
          userId: grantee,
          permissionCode: PERMISSION,
          occurredAt: OCCURRED_AT,
          resource: { siteId: siteB },
        }),
      ).toEqual({ allowed: true, limits: null });
    });
  });

  it('sans octroi de la permission : NO_PERMISSION', async () => {
    await withTestUow(async (trx) => {
      await insertTestPermission(trx, PERMISSION);
      const grantee = await insertTestUser(trx);
      const result = await evaluateAccess(trx, {
        userId: grantee,
        permissionCode: PERMISSION,
        occurredAt: OCCURRED_AT,
        resource: {},
      });
      expect(result).toEqual({ allowed: false, reason: 'NO_PERMISSION' });
    });
  });
});
