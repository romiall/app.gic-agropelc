/**
 * AV-524 (décision du porteur du 06/11/2026, ADR-057) : l'Administrateur exerce lui-même la gestion de la
 * ferme et du stock — lots, saisie du jour, collectes, incubations, réceptions, transferts, pertes,
 * inventaires, consommations, seuils, quotas — partout (portée `ALL`). Il ne reçoit toujours aucune
 * permission d'approbation métier (RC-03) ni de valorisation (RC-05) : les coûts restent masqués, les
 * mortalités, pertes et écarts restent à la Direction et aux responsables.
 *
 * Deux niveaux : la matrice semée (sans base) et l'effet réel d'une affectation `GLOBAL` sur un site de
 * ferme (cache RBAC et évaluation de portée, comme le font le pipeline de commandes et les gestionnaires).
 */
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../db/seeds/rbac-data.js';
import {
  evaluateAccess,
  hasPermissionAt,
} from '../src/modules/identity/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

const OCCURRED_AT = new Date('2026-11-06T09:00:00.000Z');

/** Les 22 octrois de la ferme et du stock accordés à l'Administrateur par AV-524, en portée `ALL`. */
const FARM_AND_STOCK = [
  'production.lot.read',
  'production.lot.manage',
  'production.daily.record',
  'production.incubation.record',
  'inventory.stock.read',
  'inventory.ledger.read',
  'inventory.transfer.request',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
  'inventory.transfer.cancel',
  'inventory.loss.declare',
  'inventory.loss.read',
  'inventory.count.perform',
  'inventory.consumption.record',
  'inventory.threshold.manage',
  'inventory.allocation.manage',
  'procurement.supplier.read',
  'procurement.request.create',
  'procurement.order.read',
  'procurement.receipt.record',
  'analytics.dashboard.stock',
  'analytics.dashboard.production',
] as const;

/** Approbations et valorisation qui restent hors de l'Administrateur (RC-03, RC-05). */
const STILL_REFUSED = [
  'production.mortality.approve',
  'inventory.loss.approve',
  'inventory.count.approve',
  'inventory.transfer_discrepancy.approve',
  'procurement.request.approve',
  'procurement.receipt.cancel',
  'inventory.valuation.read',
  'finance.expense.record',
  'sales.sale.record',
] as const;

const adminGrants = ROLE_PERMISSIONS.filter((grant) => grant.roleCode === 'ADMIN');
const adminCodes = new Set(adminGrants.map((grant) => grant.permissionCode));

describe('AV-524 : droits de l’Administrateur sur la ferme et le stock — matrice semée', () => {
  it('accorde les 22 permissions de la ferme et du stock en portée ALL', () => {
    expect(FARM_AND_STOCK).toHaveLength(22);
    for (const code of FARM_AND_STOCK) {
      const grant = adminGrants.find((candidate) => candidate.permissionCode === code);
      expect(grant, `${code} manque à l’Administrateur`).toBeDefined();
      expect(grant?.maxScope, code).toBe('ALL');
    }
    expect(adminGrants).toHaveLength(53);
  });

  it('ne lui donne aucune permission d’approbation métier ni de valorisation (RC-03, RC-05)', () => {
    for (const code of STILL_REFUSED) expect(adminCodes.has(code), code).toBe(false);
    // Seule approbation d’administrateur : l’enrôlement d’un appareil (AV-010, commentaire de la matrice).
    const approvals = PERMISSIONS.filter(
      (permission) => permission.isApproval && adminCodes.has(permission.code),
    ).map((permission) => permission.code);
    expect(approvals).toEqual(['identity.device.approve']);
  });

  it('ne retire rien aux responsables de la ferme : la production garde ses droits, y compris les validations', () => {
    const responsible = new Set(
      ROLE_PERMISSIONS.filter((grant) => grant.roleCode === 'RESP_PRODUCTION').map(
        (grant) => grant.permissionCode,
      ),
    );
    for (const code of [
      'production.lot.manage',
      'production.mortality.approve',
      'inventory.loss.approve',
    ]) {
      expect(responsible.has(code), code).toBe(true);
    }
  });
});

describe('AV-524 : droits de l’Administrateur sur la ferme et le stock — effet d’une affectation globale', () => {
  it('chaque permission est effective, sur un site de ferme comme ailleurs', async () => {
    await withTestUow(async (trx) => {
      const role = await trx
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', 'ADMIN')
        .executeTakeFirstOrThrow();
      const userId = await insertTestUser(trx);
      await assignTestRole(trx, userId, fromBin(role.id), userId, { scopeType: 'GLOBAL' });
      const zoneId = await insertTestZone(trx, userId);
      const farmId = await insertTestSite(trx, userId, zoneId, { siteType: 'FERME' });
      const shopId = await insertTestSite(trx, userId, zoneId, { siteType: 'MAGASIN' });

      for (const code of FARM_AND_STOCK) {
        expect(await hasPermissionAt(trx, toBin(userId), code, OCCURRED_AT), code).toBe(true);
      }
      // Gestionnaires de commandes : la portée est évaluée sur le site du lot, de l’emplacement…
      for (const code of [
        'production.lot.manage',
        'production.daily.record',
        'inventory.count.perform',
      ]) {
        for (const siteId of [farmId, shopId]) {
          const access = await evaluateAccess(trx, {
            userId,
            permissionCode: code,
            occurredAt: OCCURRED_AT,
            resource: { siteId },
          });
          expect(access.allowed, `${code} sur ${siteId}`).toBe(true);
        }
      }
      for (const code of STILL_REFUSED) {
        expect(await hasPermissionAt(trx, toBin(userId), code, OCCURRED_AT), code).toBe(false);
      }
    });
  });
});
