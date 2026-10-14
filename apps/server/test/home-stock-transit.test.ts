/**
 * AV-256 (MP-09) : la valeur du stock de toute l'entreprise (KPI-STK-02) comprend le transit et
 * l'annonce ; un site ne le voit pas (l'emplacement de transit n'a pas de site) ; les pertes en attente
 * restent à part. Tout se passe dans une transaction annulée : la base partagée n'en garde rien, et
 * l'instantané de la transaction rend les écarts exacts malgré les autres fichiers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Transaction } from 'kysely';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { DB } from '../src/platform/kysely/database.js';
import {
  recordStockMove,
  stockHealth,
  virtualLocationId,
  type MoveType,
} from '../src/modules/inventory/application/public/index.js';
import { buildHome } from '../src/home-api/home-service.js';
import { formatXaf } from '../src/home-api/home-format.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date('2026-10-09T18:00:00.000Z');

class Rollback extends Error {}

describe('AV-256 : valeur du stock avec le transit (KPI-STK-02)', () => {
  afterAll(closeTestDb);

  it('toute l’entreprise : transit compté et annoncé ; un site sans transit ; pertes en attente à part', async () => {
    const clock = new FixedClock(NOW);
    const idGenerator = new Uuidv7Generator(clock);
    const run = db.transaction().execute(async (trx: Transaction<DB>) => {
      const admin = await insertTestUser(trx);
      const zone = await insertTestZone(trx, admin);
      const site = await insertTestSite(trx, admin, zone);
      const store = await insertTestLocation(trx, admin, site);
      const product = await insertTestProduct(trx, admin);
      const move = async (
        from: string,
        to: string,
        moveType: MoveType,
        quantityBase: number,
        declaredUnitCostXaf?: number,
      ) =>
        recordStockMove(
          trx,
          { idGenerator },
          {
            productId: product,
            quantityBase,
            fromLocationId: from.startsWith('V_') ? await virtualLocationId(trx, from) : from,
            toLocationId: to.startsWith('V_') ? await virtualLocationId(trx, to) : to,
            moveType,
            ...(declaredUnitCostXaf !== undefined ? { declaredUnitCostXaf } : {}),
            occurredAt: new Date('2026-10-09T08:00:00.000Z'),
            sourceDocType: moveType === 'OPENING_BALANCE' ? 'INVENTORY_COUNT' : 'TRANSFER',
            sourceDocId: freshUuid(),
            createdBy: admin,
            allowNegative: false,
          },
        );

      await move('V_OPENING', store, 'OPENING_BALANCE', 10, 500);
      const before = await stockHealth(trx, ALL_SCOPE);
      const siteBefore = await stockHealth(trx, { siteIds: [site] });
      expect(siteBefore.valueXaf).toBe(5_000);
      expect(siteBefore.transitValueXaf).toBeNull();
      expect(siteBefore.pendingLossValueXaf).toBeNull();

      // Expédition de 4 vers le transit : la valeur quitte le site, pas l'entreprise.
      await move(store, 'V_TRANSIT', 'TRANSFER_DISPATCH', 4);
      const after = await stockHealth(trx, ALL_SCOPE);
      expect(after.valueXaf - before.valueXaf).toBe(-2_000);
      expect(after.transitValueXaf! - before.transitValueXaf!).toBe(2_000);
      expect(after.valueXaf + after.transitValueXaf!).toBe(
        before.valueXaf + before.transitValueXaf!,
      );
      const siteAfter = await stockHealth(trx, { siteIds: [site] });
      expect(siteAfter.valueXaf).toBe(3_000);
      expect(siteAfter.transitValueXaf).toBeNull();

      // Perte déclarée en attente de validation : hors du stock, annoncée à part.
      await move(store, 'V_PENDING_LOSS', 'LOSS_PENDING', 1);
      const final = await stockHealth(trx, ALL_SCOPE);
      expect(final.pendingLossValueXaf! - after.pendingLossValueXaf!).toBe(500);
      expect(final.valueXaf - after.valueXaf).toBe(-500);
      expect(final.transitValueXaf).toBe(after.transitValueXaf);

      // Accueil de la Direction (toute l'entreprise) : valeur et détail.
      const role = await trx
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', 'DIRECTION')
        .executeTakeFirstOrThrow();
      const director = await insertTestUser(trx);
      await assignTestRole(trx, director, fromBin(role.id), admin);
      const home = await buildHome({ executor: trx, userId: director, clock });
      const kpi = home.sections
        .find((section) => section.role === 'DIRECTION')!
        .kpis.find((entry) => entry.code === 'KPI-STK-02');
      expect(kpi?.value).toBe(final.valueXaf + final.transitValueXaf!);
      expect(kpi?.detail).toContain('au coût moyen pondéré');
      expect(kpi?.detail).toContain(`dont ${formatXaf(final.transitValueXaf!)} en transit`);
      expect(kpi?.detail).toContain(
        `pertes en attente à part : ${formatXaf(final.pendingLossValueXaf!)}`,
      );
      expect(kpi!.detail!.length).toBeLessThanOrEqual(120);
      throw new Rollback();
    });
    await expect(run).rejects.toBeInstanceOf(Rollback);
  });
});
