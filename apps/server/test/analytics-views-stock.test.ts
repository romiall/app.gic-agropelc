/**
 * Jeux de faits de stock et de production de la couche sémantique (P9-13 ; ADR-074 §2, §3 et §7, ADR-075) :
 * mouvements, soldes, pertes, production du jour par lot, écritures de coût.
 *
 * Chaque vue est rapprochée de la définition qui existe déjà — `locationFlows` (flux d'un emplacement),
 * `listStockBalances` (`GET /stock`), `lossValueSummary` (valeur des pertes), `lotMortalitySummary`,
 * `costObjectConsumptionsByDay` et `costObjectBreakdown` (production) — ou d'un calcul indépendant en
 * TypeScript sur les lignes sources. Tout se lit dans un seul instantané (`REPEATABLE READ`), sur la base
 * d'essai partagée : une base trop pauvre pour qu'un contrôle ait un sens le **saute** (visible au rapport).
 */
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayOf, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import {
  costObjectBreakdown,
  costObjectConsumptionsByDay,
  listStockBalances,
  locationFlows,
  lossValueSummary,
  lotMortalitySummary,
} from '../src/modules/inventory/application/public/index.js';
import { closeTestDb } from './helpers.js';
import { snapshot } from './analytics-view-seeds.js';

afterAll(closeTestDb);

const FROM_DAY = '2026-01-01';
const TO_DAY = '2026-12-31';

type Trx = Transaction<DB>;

async function rows<T extends Record<string, unknown>>(
  trx: Trx,
  query: ReturnType<typeof sql<T>>,
): Promise<readonly T[]> {
  return (await query.execute(trx)).rows;
}

function enough(ctx: TestContext, actual: number, minimum: number, what: string): void {
  if (actual < minimum) ctx.skip(`${what} : ${actual} en base, ${minimum} au moins nécessaires`);
}

const near = (actual: number, expected: number, label: string) =>
  expect(actual, label).toBeCloseTo(expected, 3);

describe('analytics_f_stock_moves', () => {
  it('rend le solde final, la valeur et les flux de chaque emplacement comme locationFlows', async (ctx) => {
    await snapshot(async (trx) => {
      const locations = await rows<{ loc: Buffer }>(
        trx,
        sql`SELECT m.to_location_id AS loc
              FROM analytics_f_stock_moves m
              JOIN organization_locations l ON l.id = m.to_location_id AND l.is_virtual = 0
             GROUP BY m.to_location_id ORDER BY COUNT(*) DESC LIMIT 8`,
      );
      enough(ctx, locations.length, 1, 'emplacements physiques ayant reçu des mouvements');
      for (const { loc } of locations) {
        const locationId = fromBin(loc);
        const flows = await locationFlows(trx, {
          locationIds: [locationId],
          period: { fromDay: FROM_DAY, toDay: TO_DAY },
        });
        const view = await rows<{
          product_id: Buffer;
          closing: string;
          closing_value: string;
          sold: string;
          returned: string;
          lost: string;
          inventory_lost: string;
          inventory_gain: string;
        }>(
          trx,
          sql`SELECT product_id,
                     SUM(quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc}))) AS closing,
                     SUM(value_xaf * ((to_location_id = ${loc}) - (from_location_id = ${loc}))) AS closing_value,
                     SUM(CASE WHEN business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND move_type = 'SALE'
                              THEN -quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc})) END) AS sold,
                     SUM(CASE WHEN business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND move_type = 'CUSTOMER_RETURN'
                              THEN quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc})) END) AS returned,
                     SUM(CASE WHEN business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND move_type = 'LOSS'
                              THEN -quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc})) END) AS lost,
                     SUM(CASE WHEN business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND move_type = 'INVENTORY_LOSS'
                              THEN -quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc})) END) AS inventory_lost,
                     SUM(CASE WHEN business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND move_type = 'INVENTORY_GAIN'
                              THEN quantity_base * ((to_location_id = ${loc}) - (from_location_id = ${loc})) END) AS inventory_gain
                FROM analytics_f_stock_moves
               WHERE (to_location_id = ${loc} OR from_location_id = ${loc}) AND business_day <= ${TO_DAY}
               GROUP BY product_id`,
        );
        const byProduct = new Map(view.map((row) => [fromBin(row.product_id), row]));
        for (const flow of flows) {
          const row = byProduct.get(flow.productId);
          const label = `${locationId}/${flow.productId}`;
          expect(row, label).toBeDefined();
          near(Number(row!.closing), flow.closingQty, `${label} solde`);
          expect(Number(row!.closing_value), `${label} valeur`).toBe(flow.closingValueXaf);
          near(Number(row!.sold ?? 0), flow.soldQty, `${label} vendu`);
          near(Number(row!.returned ?? 0), flow.returnedQty, `${label} retours`);
          near(Number(row!.lost ?? 0), flow.lostQty, `${label} pertes`);
          near(
            Number(row!.inventory_lost ?? 0),
            flow.inventoryLossQty,
            `${label} pertes d’inventaire`,
          );
          near(
            Number(row!.inventory_gain ?? 0),
            flow.inventoryGainQty,
            `${label} gains d’inventaire`,
          );
        }
      }
    });
  });

  it('une ligne par mouvement ; le site et le titulaire d’une extrémité viennent de son emplacement', async (ctx) => {
    await snapshot(async (trx) => {
      const [counts] = await rows<{
        source: string;
        view_n: string;
        qty: string;
        view_qty: string;
      }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM inventory_stock_moves) AS source,
                   (SELECT COUNT(*) FROM analytics_f_stock_moves) AS view_n,
                   (SELECT SUM(quantity) FROM inventory_stock_moves) AS qty,
                   (SELECT SUM(quantity_base) FROM analytics_f_stock_moves) AS view_qty`,
      );
      enough(ctx, Number(counts!.source), 1, 'mouvements de stock');
      expect(Number(counts!.view_n)).toBe(Number(counts!.source));
      near(Number(counts!.view_qty), Number(counts!.qty), 'quantité');
      const [sites] = await rows<{
        wrong_from: string;
        wrong_to: string;
        wrong_holder: string;
      }>(
        trx,
        sql`SELECT SUM(NOT (v.from_site_id <=> fl.site_id)) AS wrong_from,
                   SUM(NOT (v.to_site_id <=> tl.site_id)) AS wrong_to,
                   SUM(NOT (v.from_custodian_user_id <=> fl.custodian_user_id)
                    OR NOT (v.to_custodian_user_id <=> tl.custodian_user_id)) AS wrong_holder
              FROM analytics_f_stock_moves v
              JOIN inventory_stock_moves m ON m.id = v.move_id
              JOIN organization_locations fl ON fl.id = m.from_location_id
              JOIN organization_locations tl ON tl.id = m.to_location_id`,
      );
      expect(Number(sites!.wrong_from)).toBe(0);
      expect(Number(sites!.wrong_to)).toBe(0);
      expect(Number(sites!.wrong_holder)).toBe(0);
    });
  });

  it('le motif est le code du motif du mouvement, la date est son jour métier', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong_code: string; wrong_day: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(NOT (v.reason_code <=> rc.code)) AS wrong_code,
                   SUM(v.business_day <> DATE(CONVERT_TZ(m.occurred_at, '+00:00', '+01:00'))) AS wrong_day
              FROM analytics_f_stock_moves v
              JOIN inventory_stock_moves m ON m.id = v.move_id
              LEFT JOIN catalog_reason_codes rc ON rc.id = m.reason_code_id
             WHERE m.reason_code_id IS NOT NULL`,
      );
      enough(ctx, Number(check!.checked), 1, 'mouvements à motif');
      expect(Number(check!.wrong_code)).toBe(0);
      expect(Number(check!.wrong_day)).toBe(0);
    });
  });
});

describe('analytics_f_stock_balance', () => {
  it('rend, pour chaque emplacement, les soldes de GET /stock : solde, alloué, disponible, valeur', async (ctx) => {
    await snapshot(async (trx) => {
      const locations = await rows<{ id: Buffer; custody_mode: string | null }>(
        trx,
        sql`SELECT l.id, l.custody_mode
              FROM analytics_f_stock_balance b
              JOIN organization_locations l ON l.id = b.location_id
             GROUP BY l.id, l.custody_mode ORDER BY COUNT(*) DESC LIMIT 10`,
      );
      enough(ctx, locations.length, 1, 'emplacements ayant des soldes');
      let compared = 0;
      for (const location of locations) {
        const balances = await listStockBalances(trx, {
          locationId: fromBin(location.id),
          custodyMode: location.custody_mode,
        });
        const view = await rows<{
          product_id: Buffer;
          stock_lot_id: Buffer | null;
          balance_base: string;
          allocated_base: string;
          available_base: string;
          value_xaf: string;
        }>(
          trx,
          sql`SELECT product_id, stock_lot_id, balance_base, allocated_base, available_base, value_xaf
                FROM analytics_f_stock_balance WHERE location_id = ${location.id}`,
        );
        const key = (product: Buffer, lot: Buffer | null) =>
          `${fromBin(product)}|${lot === null ? '' : fromBin(lot)}`;
        const byKey = new Map(view.map((row) => [key(row.product_id, row.stock_lot_id), row]));
        for (const balance of balances) {
          const row = byKey.get(`${balance.productId}|${balance.lotId ?? ''}`);
          const label = `${fromBin(location.id)}/${balance.productId}/${balance.lotId ?? '-'}`;
          expect(row, label).toBeDefined();
          near(Number(row!.balance_base), balance.qtyOnHand, `${label} solde`);
          near(Number(row!.allocated_base), balance.qtyAllocated, `${label} alloué`);
          near(Number(row!.available_base), balance.qtyAvailable, `${label} disponible`);
          // `+ 0` : la référence rend `-0` pour un petit solde négatif arrondi à zéro.
          expect(Number(row!.value_xaf) + 0, `${label} valeur`).toBe(balance.valueXaf + 0);
          compared += 1;
        }
      }
      enough(ctx, compared, 1, 'soldes non nuls');
    });
  });

  it('la clé de lot nulle de la table source est un lot vide ; la famille est celle du produit', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        checked: string;
        lot_with_key: string;
        lotless_without_key: string;
        wrong_family: string;
      }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(v.stock_lot_id IS NOT NULL AND b.lot_key = UNHEX('00000000000000000000000000000000')) AS lot_with_key,
                   SUM(v.stock_lot_id IS NULL AND b.lot_key <> UNHEX('00000000000000000000000000000000')) AS lotless_without_key,
                   SUM(v.family <> p.stock_family) AS wrong_family
              FROM analytics_f_stock_balance v
              JOIN inventory_stock_balances b ON b.location_id = v.location_id AND b.product_id = v.product_id
                   AND (b.lot_key <=> COALESCE(v.stock_lot_id, UNHEX('00000000000000000000000000000000')))
              JOIN catalog_products p ON p.id = v.product_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'soldes');
      expect(Number(check!.lot_with_key)).toBe(0);
      expect(Number(check!.lotless_without_key)).toBe(0);
      expect(Number(check!.wrong_family)).toBe(0);
    });
  });
});

describe('analytics_f_losses', () => {
  it('rend, par produit, les déclarations, quantités et valeurs comme lossValueSummary', async (ctx) => {
    await snapshot(async (trx) => {
      const fromUtc = businessDayStartUtc(FROM_DAY);
      const toUtc = businessDayEndUtc(TO_DAY);
      for (const groupBy of ['product', 'lot'] as const) {
        const reference = await lossValueSummary(trx, { fromUtc, toUtc, groupBy });
        enough(ctx, reference.length, 1, `groupes de pertes (${groupBy})`);
        const column = groupBy === 'product' ? 'product_id' : 'production_lot_id';
        const view = await rows<{
          key: Buffer;
          declarations: string;
          quantity: string;
          value: string;
          pending_quantity: string;
          pending_value: string;
        }>(
          trx,
          sql`SELECT ${sql.ref(column)} AS \`key\`,
                     SUM(status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')) AS declarations,
                     COALESCE(SUM(CASE WHEN status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')
                                       THEN quantity_base END), 0) AS quantity,
                     COALESCE(SUM(CASE WHEN status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')
                                       THEN value_xaf END), 0) AS value,
                     COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN quantity_base END), 0) AS pending_quantity,
                     COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN value_xaf END), 0) AS pending_value
                FROM analytics_f_losses
               WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
                 AND status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING', 'PENDING_APPROVAL')
                 AND ${sql.ref(column)} IS NOT NULL
               GROUP BY ${sql.ref(column)}`,
        );
        const byKey = new Map(view.map((row) => [fromBin(row.key), row]));
        for (const line of reference) {
          const id = groupBy === 'product' ? line.productId : line.productionLotId;
          const row = byKey.get(id!);
          expect(row, `${groupBy} ${id}`).toBeDefined();
          expect(Number(row!.declarations), `${groupBy} ${id} déclarations`).toBe(
            line.declarations,
          );
          near(Number(row!.quantity), line.quantityBase, `${groupBy} ${id} quantité`);
          expect(Number(row!.value), `${groupBy} ${id} valeur`).toBe(line.valueXaf);
          near(Number(row!.pending_quantity), line.pendingQuantityBase, `${groupBy} ${id} attente`);
          expect(Number(row!.pending_value), `${groupBy} ${id} valeur en attente`).toBe(
            line.pendingValueXaf,
          );
        }
      }
    });
  });

  it('une déclaration annulée n’y figure pas ; le motif est le code du motif de la déclaration', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        cancelled: string;
        view_n: string;
        source_n: string;
        wrong_code: string;
        checked: string;
      }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM analytics_f_losses WHERE status = 'CANCELLED') AS cancelled,
                   (SELECT COUNT(*) FROM analytics_f_losses) AS view_n,
                   (SELECT COUNT(*) FROM inventory_loss_declarations WHERE status <> 'CANCELLED') AS source_n,
                   COALESCE(SUM(NOT (v.reason_code <=> rc.code)), 0) AS wrong_code, COUNT(*) AS checked
              FROM analytics_f_losses v
              JOIN inventory_loss_declarations d ON d.id = v.loss_id
              LEFT JOIN catalog_reason_codes rc ON rc.id = d.reason_code_id`,
      );
      enough(ctx, Number(check!.source_n), 1, 'déclarations de perte non annulées');
      expect(Number(check!.cancelled)).toBe(0);
      expect(Number(check!.view_n)).toBe(Number(check!.source_n));
      expect(Number(check!.wrong_code)).toBe(0);
    });
  });
});

describe('analytics_f_production_daily', () => {
  it('rend la mortalité comptée de chaque lot comme lotMortalitySummary', async (ctx) => {
    await snapshot(async (trx) => {
      const lots = await rows<{ lot_id: Buffer }>(
        trx,
        sql`SELECT lot_id FROM analytics_f_production_daily WHERE mortality_heads IS NOT NULL
             GROUP BY lot_id ORDER BY COUNT(*) DESC LIMIT 12`,
      );
      enough(ctx, lots.length, 1, 'lots à mortalité déclarée');
      for (const { lot_id: lotBin } of lots) {
        const lotId = fromBin(lotBin);
        const reference = await lotMortalitySummary(trx, { productionLotId: lotId });
        const [view] = await rows<{ heads: string }>(
          trx,
          sql`SELECT COALESCE(SUM(mortality_heads), 0) AS heads
                FROM analytics_f_production_daily WHERE lot_id = ${lotBin}`,
        );
        near(Number(view!.heads), reference.countedQuantity, `lot ${lotId}`);
      }
    });
  });

  it('rend l’aliment consommé de chaque lot, jour par jour, comme costObjectConsumptionsByDay', async (ctx) => {
    await snapshot(async (trx) => {
      const lots = await rows<{ lot_id: Buffer }>(
        trx,
        sql`SELECT lot_id FROM analytics_f_production_daily WHERE feed_quantity IS NOT NULL
             GROUP BY lot_id ORDER BY COUNT(*) DESC LIMIT 12`,
      );
      enough(ctx, lots.length, 1, 'lots à aliment consommé');
      for (const { lot_id: lotBin } of lots) {
        const lotId = fromBin(lotBin);
        const reference = await costObjectConsumptionsByDay(trx, {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lotId,
          fromUtc: businessDayStartUtc('2000-01-01'),
          toUtc: businessDayEndUtc('2099-12-31'),
        });
        const expected = new Map<string, number>();
        for (const line of reference) {
          if (line.costType !== 'ALIMENT') continue;
          expected.set(line.day, (expected.get(line.day) ?? 0) + line.quantityBase);
        }
        const view = await rows<{ day: string; feed: string }>(
          trx,
          sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day, SUM(feed_quantity) AS feed
                FROM analytics_f_production_daily WHERE lot_id = ${lotBin} AND feed_quantity IS NOT NULL
               GROUP BY business_day`,
        );
        expect(view.length, `lot ${lotId}`).toBe(expected.size);
        for (const row of view) {
          near(Number(row.feed), expected.get(row.day) ?? Number.NaN, `lot ${lotId} ${row.day}`);
        }
      }
    });
  });

  it('rend les œufs collectés et commercialisables et le poids moyen des pesées comme un calcul indépendant', async (ctx) => {
    await snapshot(async (trx) => {
      const collections = await trx
        .selectFrom('production_egg_collections')
        .select(['production_lot_id', 'collection_date', 'collected_qty', 'marketable_qty'])
        .where('status', '=', 'RECORDED')
        .execute();
      const weighings = await trx
        .selectFrom('production_lot_weighings')
        .select(['production_lot_id', 'occurred_at', 'avg_weight_g'])
        .where('status', '=', 'RECORDED')
        .execute();
      enough(ctx, collections.length + weighings.length, 1, 'collectes d’œufs et pesées');
      const eggs = new Map<string, { collected: number; sellable: number }>();
      for (const row of collections) {
        const key = `${fromBin(row.production_lot_id)}|${businessDayOf(row.collection_date)}`;
        const entry = eggs.get(key) ?? { collected: 0, sellable: 0 };
        entry.collected += Number(row.collected_qty);
        entry.sellable += Number(row.marketable_qty);
        eggs.set(key, entry);
      }
      const weights = new Map<string, number[]>();
      for (const row of weighings) {
        const key = `${fromBin(row.production_lot_id)}|${businessDayOf(row.occurred_at)}`;
        weights.set(key, [...(weights.get(key) ?? []), Number(row.avg_weight_g) / 1000]);
      }
      const view = await rows<{
        lot_id: Buffer;
        day: string;
        collected: string | null;
        sellable: string | null;
        weight: string | null;
      }>(
        trx,
        sql`SELECT lot_id, DATE_FORMAT(business_day, '%Y-%m-%d') AS day, SUM(eggs_collected) AS collected,
                   SUM(eggs_sellable) AS sellable, AVG(average_weight_kg) AS weight
              FROM analytics_f_production_daily
             WHERE eggs_collected IS NOT NULL OR average_weight_kg IS NOT NULL
             GROUP BY lot_id, business_day`,
      );
      const seenEggs = new Set<string>();
      const seenWeights = new Set<string>();
      for (const row of view) {
        const key = `${fromBin(row.lot_id)}|${row.day}`;
        if (row.collected !== null) {
          const expected = eggs.get(key);
          expect(expected, `œufs ${key}`).toBeDefined();
          expect(Number(row.collected), `collectés ${key}`).toBe(expected!.collected);
          expect(Number(row.sellable), `commercialisables ${key}`).toBe(expected!.sellable);
          seenEggs.add(key);
        }
        if (row.weight !== null) {
          const list = weights.get(key);
          expect(list, `pesées ${key}`).toBeDefined();
          const mean = list!.reduce((total, value) => total + value, 0) / list!.length;
          expect(Number(row.weight), `poids ${key}`).toBeCloseTo(mean, 3);
          seenWeights.add(key);
        }
      }
      expect(seenEggs.size).toBe(eggs.size);
      expect(seenWeights.size).toBe(weights.size);
    });
  });

  it('le site est celui du lot, le bâtiment son emplacement principal ou le parent de celui-ci', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        checked: string;
        wrong_site: string;
        wrong_type: string;
        wrong_building: string;
      }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(v.site_id <> pl.site_id) AS wrong_site,
                   SUM(v.lot_type <> pl.lot_type) AS wrong_type,
                   SUM(NOT (v.building_id <=> CASE WHEN ml.location_type = 'BUILDING' THEN ml.id ELSE ml.parent_location_id END)) AS wrong_building
              FROM analytics_f_production_daily v
              JOIN production_production_lots pl ON pl.id = v.lot_id
              LEFT JOIN organization_locations ml ON ml.id = pl.main_location_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'faits de production');
      expect(Number(check!.wrong_site)).toBe(0);
      expect(Number(check!.wrong_type)).toBe(0);
      expect(Number(check!.wrong_building)).toBe(0);
    });
  });
});

describe('analytics_f_costs', () => {
  it('rend, par objet de coût et nature, le net des écritures comme costObjectBreakdown', async (ctx) => {
    await snapshot(async (trx) => {
      const objects = await rows<{ cost_object_type: string; cost_object_id: Buffer }>(
        trx,
        sql`(SELECT cost_object_type, cost_object_id FROM analytics_f_costs WHERE cost_object_type = 'PRODUCTION_LOT'
              GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 6)
            UNION ALL
            (SELECT cost_object_type, cost_object_id FROM analytics_f_costs WHERE cost_object_type = 'SITE'
              GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 3)
            UNION ALL
            (SELECT cost_object_type, cost_object_id FROM analytics_f_costs WHERE cost_object_type = 'INCUBATION_BATCH'
              GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 3)`,
      );
      enough(ctx, objects.length, 1, 'objets de coût');
      for (const object of objects) {
        const reference = await costObjectBreakdown(trx, {
          costObjectType: object.cost_object_type as 'PRODUCTION_LOT' | 'SITE' | 'INCUBATION_BATCH',
          costObjectId: fromBin(object.cost_object_id),
        });
        const view = await rows<{ cost_type: string; net: string }>(
          trx,
          sql`SELECT cost_type, SUM(amount_xaf) AS net FROM analytics_f_costs
               WHERE cost_object_type = ${object.cost_object_type} AND cost_object_id = ${object.cost_object_id}
               GROUP BY cost_type`,
        );
        expect(
          new Map(view.map((row) => [row.cost_type, Number(row.net)])),
          fromBin(object.cost_object_id),
        ).toEqual(new Map(reference.map((line) => [line.costType, line.netXaf])));
      }
    });
  });

  it('le site d’une écriture est celui de son site, de son lot de production ou de son lot d’incubation (vide si l’objet n’existe pas)', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong_site: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(NOT (v.site_id <=> CASE e.cost_object_type
                       WHEN 'SITE' THEN e.cost_object_id
                       WHEN 'PRODUCTION_LOT' THEN (SELECT site_id FROM production_production_lots WHERE id = e.cost_object_id)
                       WHEN 'INCUBATION_BATCH' THEN (SELECT site_id FROM production_incubation_batches WHERE id = e.cost_object_id)
                     END)) AS wrong_site
              FROM analytics_f_costs v JOIN inventory_cost_entries e ON e.id = v.entry_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'écritures de coût');
      expect(Number(check!.wrong_site)).toBe(0);
    });
  });

  it('un crédit est négatif, un débit positif, à son jour métier', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong_sign: string; wrong_day: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(v.amount_xaf <> CASE WHEN e.direction = 'DEBIT' THEN e.amount_xaf ELSE -e.amount_xaf END) AS wrong_sign,
                   SUM(v.business_day <> DATE(CONVERT_TZ(e.occurred_at, '+00:00', '+01:00'))) AS wrong_day
              FROM analytics_f_costs v JOIN inventory_cost_entries e ON e.id = v.entry_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'écritures de coût');
      expect(Number(check!.wrong_sign)).toBe(0);
      expect(Number(check!.wrong_day)).toBe(0);
      const [credits] = await rows<{ credits: string; negative: string }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM inventory_cost_entries WHERE direction = 'CREDIT') AS credits,
                   (SELECT COUNT(*) FROM analytics_f_costs WHERE amount_xaf < 0) AS negative`,
      );
      expect(Number(credits!.negative)).toBeLessThanOrEqual(Number(credits!.credits));
    });
  });
});
