/**
 * Tests RBAC générés depuis la matrice de référence (09-non-functional/03-plan-de-tests.md
 * §5 : « pour chaque (rôle, permission, portée)… générés depuis la matrice, données de
 * référence »). Source unique : `db/seeds/rbac-data.ts`, devenue — une fois livrée — la
 * source de vérité courante de la matrice (son propre en-tête) ; ce test lit **cette même**
 * référence, jamais une copie maintenue à la main qui pourrait diverger du catalogue
 * réellement semé par P0-05.
 *
 * Portée : cas 1 (accordé) et 3 (refus sans la permission) sur les 11 rôles réels et
 * l'intégralité de leurs octrois — une seule affectation par rôle suffit, dans le premier
 * type de périmètre que ce rôle autorise (`roles.allowed_scope_types`, ex. `TEAM` pour
 * RESP_COMMERCIAL, `SITE` pour VENDEUR_PDV) : certains rôles n'autorisent pas `GLOBAL` (le
 * déclencheur `trg_identity_ura_scope_allowed` le refuse), d'où la fixture SITE/ZONE/TEAM
 * minimale construite au besoin. Le cache RBAC (`hasPermissionAt`) rend chaque vérification
 * suivante gratuite (aucun aller-retour base par permission). Le cas 2 (refus hors portée),
 * qui dépend du **type** de portée plutôt que du code de permission, est couvert une fois par
 * combinaison dans `scope-evaluation.test.ts` — le répéter pour chacune des ~140 permissions
 * de la matrice n'exercerait pas un chemin de code différent.
 *
 * Toute la matière (affectation + vérifications) reste dans **une même** transaction annulée
 * (`withTestUow`) par rôle : `hasPermissionAt` doit interroger le même exécuteur que celui
 * qui a écrit l'affectation, sous peine de lire une base d'où le rollback a déjà retiré la
 * ligne.
 */
import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_PERMISSIONS, PERMISSIONS } from '../../../db/seeds/rbac-data.js';
import { hasPermissionAt } from '../src/modules/identity/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';

const OCCURRED_AT = new Date('2026-09-24T09:00:00.000Z');
const NEGATIVE_SAMPLE_SIZE = 5;

async function lookupRealRoleId(trx: UnitOfWork, code: string): Promise<string> {
  const row = await trx
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/** Affecte `roleId` à `userId` dans le premier type de périmètre que le rôle autorise
 * (`allowedScopeTypes`, matrice de référence), fabriquant au besoin le site/zone/équipe
 * minimal exigé par `trg_identity_ura_scope_allowed`. */
async function assignInFirstAllowedScope(
  trx: UnitOfWork,
  userId: string,
  roleId: string,
  allowedScopeTypes: readonly string[],
): Promise<void> {
  const scopeType = allowedScopeTypes[0];
  switch (scopeType) {
    case 'SITE': {
      const zoneId = await insertTestZone(trx, userId);
      const siteId = await insertTestSite(trx, userId, zoneId);
      await assignTestRole(trx, userId, roleId, userId, { scopeType: 'SITE', scopeSiteId: siteId });
      return;
    }
    case 'ZONE': {
      const zoneId = await insertTestZone(trx, userId);
      await assignTestRole(trx, userId, roleId, userId, { scopeType: 'ZONE', scopeZoneId: zoneId });
      return;
    }
    case 'TEAM': {
      const teamId = await insertTestTeam(trx, userId, userId); // dirigeant = le titulaire lui-même
      await assignTestRole(trx, userId, roleId, userId, { scopeType: 'TEAM', scopeTeamId: teamId });
      return;
    }
    default:
      await assignTestRole(trx, userId, roleId, userId, { scopeType: 'GLOBAL' });
  }
}

describe('Matrice RBAC générée (db/seeds/rbac-data.ts) — plan de tests §5', () => {
  it('la matrice de référence est non vide (garde contre un test vide qui passerait trivialement)', () => {
    expect(ROLES.length).toBeGreaterThan(0);
    expect(ROLE_PERMISSIONS.length).toBeGreaterThan(0);
  });

  for (const role of ROLES) {
    const granted = ROLE_PERMISSIONS.filter((rp) => rp.roleCode === role.code);
    if (granted.length === 0) continue; // rôle sans octroi dans la matrice (aucun en pratique)

    it(`${role.code} : chaque permission accordée par la matrice est effective (cas 1)`, async () => {
      await withTestUow(async (trx) => {
        const roleId = await lookupRealRoleId(trx, role.code);
        const userId = await insertTestUser(trx);
        await assignInFirstAllowedScope(trx, userId, roleId, role.allowedScopeTypes);

        for (const rp of granted) {
          const allowed = await hasPermissionAt(trx, toBin(userId), rp.permissionCode, OCCURRED_AT);
          expect(allowed, `${role.code} devrait avoir ${rp.permissionCode} (matrice)`).toBe(true);
        }
      });
    });

    it(`${role.code} : un échantillon de permissions non accordées est refusé (cas 3)`, async () => {
      await withTestUow(async (trx) => {
        const roleId = await lookupRealRoleId(trx, role.code);
        const userId = await insertTestUser(trx);
        await assignInFirstAllowedScope(trx, userId, roleId, role.allowedScopeTypes);

        const grantedCodes = new Set(granted.map((rp) => rp.permissionCode));
        const notGranted = PERMISSIONS.filter((p) => !grantedCodes.has(p.code)).slice(
          0,
          NEGATIVE_SAMPLE_SIZE,
        );
        for (const permission of notGranted) {
          const allowed = await hasPermissionAt(trx, toBin(userId), permission.code, OCCURRED_AT);
          expect(allowed, `${role.code} ne devrait pas avoir ${permission.code} (matrice)`).toBe(
            false,
          );
        }
      });
    });
  }
});
