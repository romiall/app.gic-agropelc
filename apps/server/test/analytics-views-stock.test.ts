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
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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
import {
  cloneConsumptions,
  cloneEggCollections,
  cloneLossDeclarations,
  seedReservedBalances,
} from './analytics-view-seeds-stock.js';

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
             WHERE m.business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
             GROUP BY m.to_location_id ORDER BY COUNT(*) DESC LIMIT 8`,
      );
      const prepared = [];
      for (const { loc } of locations) {
        const flows = await locationFlows(trx, {
          locationIds: [fromBin(loc)],
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
        prepared.push({ locationId: fromBin(loc), flows, view });
      }
      enough(
        ctx,
        prepared.reduce((total, entry) => total + entry.flows.length, 0),
        1,
        'flux d’emplacement physique',
      );
      for (const { locationId, flows, view } of prepared) {
        const byProduct = new Map(view.map((row) => [fromBin(row.product_id), row]));
        // Mêmes produits des deux côtés : la vue n'invente pas de produit, la référence n'en perd aucun.
        expect(new Set(byProduct.keys()), locationId).toEqual(
          new Set(flows.map((f) => f.productId)),
        );
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
        wrong_kind: string;
      }>(
        trx,
        sql`SELECT SUM(NOT (v.is_reversal <=> m.is_reversal)
                    OR NOT (v.source_doc_type <=> m.source_doc_type)
                    OR NOT (v.move_type <=> m.move_type)) AS wrong_kind,
                   SUM(NOT (v.from_site_id <=> fl.site_id)) AS wrong_from,
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
      expect(Number(sites!.wrong_kind)).toBe(0);
    });
  });

  it('le motif est le code du motif du mouvement, la date est son jour métier', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong_code: string; wrong_day: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(NOT (v.reason_code <=> rc.code)) AS wrong_code,
                   SUM(NOT (v.business_day <=> DATE(CONVERT_TZ(m.occurred_at, '+00:00', '+01:00')))) AS wrong_day
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
      // Les soldes de la base d'essai n'ont ni réservé ni alloué et aucun emplacement à garde par appareil : on en
      // amorce un de chaque mode de garde AVANT de choisir les emplacements comparés (le mode lu est le nouveau).
      const seeded = await seedReservedBalances(trx);
      const locations: { id: Buffer; custody_mode: string | null }[] = [];
      locations.push(
        ...(await rows<{ id: Buffer; custody_mode: string | null }>(
          trx,
          sql`SELECT l.id, l.custody_mode
              FROM analytics_f_stock_balance b
              JOIN organization_locations l ON l.id = b.location_id
             GROUP BY l.id, l.custody_mode ORDER BY COUNT(*) DESC LIMIT 10`,
        )),
      );
      for (const balance of seeded) {
        if (!locations.some((known) => fromBin(known.id) === balance.locationId)) {
          locations.push({ id: toBin(balance.locationId), custody_mode: balance.custodyMode });
        }
      }
      const prepared = [];
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
        prepared.push({ locationId: fromBin(location.id), balances, view });
      }
      enough(
        ctx,
        prepared.reduce((total, entry) => total + entry.balances.length, 0),
        1,
        'soldes non nuls',
      );
      const key = (product: Buffer | string, lot: Buffer | string | null) =>
        `${typeof product === 'string' ? product : fromBin(product)}|${
          lot === null ? '' : typeof lot === 'string' ? lot : fromBin(lot)
        }`;
      for (const { locationId, balances, view } of prepared) {
        const byKey = new Map(view.map((row) => [key(row.product_id, row.stock_lot_id), row]));
        for (const balance of balances) {
          const row = byKey.get(key(balance.productId, balance.lotId));
          const label = `${locationId}/${balance.productId}/${balance.lotId ?? '-'}`;
          expect(row, label).toBeDefined();
          near(Number(row!.balance_base), balance.qtyOnHand, `${label} solde`);
          near(Number(row!.allocated_base), balance.qtyAllocated, `${label} alloué`);
          near(Number(row!.available_base), balance.qtyAvailable, `${label} disponible`);
          // `+ 0` : la référence rend `-0` pour un petit solde négatif arrondi à zéro.
          expect(Number(row!.value_xaf) + 0, `${label} valeur`).toBe(balance.valueXaf + 0);
        }
        // Une ligne de la vue que `GET /stock` ne rend pas est entièrement à zéro (il omet ces lignes).
        const known = new Set(balances.map((balance) => key(balance.productId, balance.lotId)));
        for (const row of view) {
          if (known.has(key(row.product_id, row.stock_lot_id))) continue;
          expect(Number(row.balance_base), `${locationId} ligne en trop`).toBe(0);
          expect(Number(row.allocated_base), `${locationId} ligne en trop`).toBe(0);
          expect(Number(row.available_base), `${locationId} ligne en trop`).toBe(0);
        }
      }
    });
  });

  it('n’y figurent ni source ni puits de mouvement ; le transit, les pertes en attente et l’à-livrer y figurent', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        sinks: string;
        view_n: string;
        source_n: string;
        wrong_type: string;
      }>(
        trx,
        sql`SELECT COALESCE(SUM(v.location_type IN ('V_SUPPLIER', 'V_CUSTOMER', 'V_LOSS', 'V_PRODUCTION',
                                                     'V_CONSUMPTION', 'V_ADJUSTMENT', 'V_OPENING')), 0) AS sinks,
                   COUNT(*) AS view_n,
                   COALESCE(SUM(NOT (v.location_type <=> l.location_type)), 0) AS wrong_type,
                   (SELECT COUNT(*) FROM inventory_stock_balances b
                      JOIN organization_locations x ON x.id = b.location_id
                     WHERE x.is_virtual = 0 OR x.location_type IN ('V_TRANSIT', 'V_PENDING_LOSS', 'V_TO_DELIVER')) AS source_n
              FROM analytics_f_stock_balance v JOIN organization_locations l ON l.id = v.location_id`,
      );
      enough(ctx, Number(check!.view_n), 1, 'soldes');
      expect(Number(check!.sinks)).toBe(0);
      expect(Number(check!.wrong_type)).toBe(0);
      expect(Number(check!.view_n)).toBe(Number(check!.source_n));
      const [kinds] = await rows<{ virtual_sources: string }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM inventory_stock_balances b
                      JOIN organization_locations x ON x.id = b.location_id
                     WHERE x.is_virtual = 1 AND x.location_type NOT IN ('V_TRANSIT', 'V_PENDING_LOSS', 'V_TO_DELIVER')) AS virtual_sources`,
      );
      enough(ctx, Number(kinds!.virtual_sources), 1, 'soldes d’emplacements source ou puits');
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
                   SUM(NOT (v.family <=> p.stock_family)) AS wrong_family
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
  it('rend, par produit et par lot, les déclarations, quantités et valeurs constatées ou en attente comme lossValueSummary', async (ctx) => {
    await snapshot(async (trx) => {
      const fromUtc = businessDayStartUtc(FROM_DAY);
      const toUtc = businessDayEndUtc(TO_DAY);
      const references = new Map<'product' | 'lot', Awaited<ReturnType<typeof lossValueSummary>>>();
      for (const groupBy of ['product', 'lot'] as const) {
        references.set(groupBy, await lossValueSummary(trx, { fromUtc, toUtc, groupBy }));
      }
      enough(
        ctx,
        Math.min(...[...references.values()].map((reference) => reference.length)),
        1,
        'groupes de pertes par produit et par lot',
      );
      for (const groupBy of ['product', 'lot'] as const) {
        const reference = references.get(groupBy)!;
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
                     SUM(quantity_base IS NOT NULL) AS declarations,
                     COALESCE(SUM(quantity_base), 0) AS quantity,
                     COALESCE(SUM(value_xaf), 0) AS value,
                     COALESCE(SUM(pending_quantity_base), 0) AS pending_quantity,
                     COALESCE(SUM(pending_value_xaf), 0) AS pending_value
                FROM analytics_f_losses
               WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
                 AND status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING', 'PENDING_APPROVAL')
                 AND ${sql.ref(column)} IS NOT NULL
               GROUP BY ${sql.ref(column)}`,
        );
        const byKey = new Map(view.map((row) => [fromBin(row.key), row]));
        expect(byKey.size, groupBy).toBe(reference.length);
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

  it('une perte rejetée et rendue n’est pas une perte, une perte en attente est à part (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const lot = await cloneLossDeclarations(trx, '2019-03-04', [
        { status: 'RECORDED', category: 'CASSE', quantity: 1 },
        { status: 'PENDING_APPROVAL', category: 'CASSE', quantity: 2 },
        { status: 'REJECTED_RETURNED', category: 'CASSE', quantity: 4 },
        { status: 'CANCELLED', category: 'CASSE', quantity: 8 },
      ]);
      enough(ctx, lot ? 1 : 0, 1, 'déclaration de perte modèle');
      const [day] = await rows<{
        counted: string;
        value: string;
        pending: string;
        pending_value: string;
        line_count: string;
      }>(
        trx,
        sql`SELECT COALESCE(SUM(quantity_base), 0) AS counted, COALESCE(SUM(value_xaf), 0) AS value,
                   COALESCE(SUM(pending_quantity_base), 0) AS pending,
                   COALESCE(SUM(pending_value_xaf), 0) AS pending_value, COUNT(*) AS line_count
              FROM analytics_f_losses
             WHERE production_lot_id = ${toBin(lot!)} AND business_day = '2019-03-04'`,
      );
      expect(Number(day!.counted)).toBe(1);
      expect(Number(day!.value)).toBe(100);
      expect(Number(day!.pending)).toBe(2);
      expect(Number(day!.pending_value)).toBe(200);
      // L'annulée n'a pas de ligne ; la rejetée et rendue en a une, sans mesure.
      expect(Number(day!.line_count)).toBe(3);
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

  it('la mortalité comptée suit les statuts du résumé du lot, hors annulée, en attente et autre catégorie (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const lot = await cloneLossDeclarations(trx, '2019-03-04', [
        { status: 'RECORDED', category: 'MORTALITE', quantity: 1 },
        { status: 'APPROVED', category: 'MORTALITE', quantity: 2 },
        { status: 'REJECTED_UNJUSTIFIED', category: 'MORTALITE', quantity: 4 },
        { status: 'CANCELLATION_PENDING', category: 'MORTALITE', quantity: 8 },
        { status: 'PENDING_APPROVAL', category: 'MORTALITE', quantity: 16 },
        { status: 'REJECTED_RETURNED', category: 'MORTALITE', quantity: 32 },
        { status: 'CANCELLED', category: 'MORTALITE', quantity: 64 },
        { status: 'RECORDED', category: 'CASSE', quantity: 128 },
      ]);
      enough(ctx, lot ? 1 : 0, 1, 'déclaration de mortalité modèle');
      const [day] = await rows<{ heads: string }>(
        trx,
        sql`SELECT COALESCE(SUM(mortality_heads), 0) AS heads FROM analytics_f_production_daily
             WHERE lot_id = ${toBin(lot!)} AND business_day = '2019-03-04'`,
      );
      expect(Number(day!.heads)).toBe(1 + 2 + 4 + 8);
    });
  });

  it('seul l’aliment enregistré est compté, ni l’annulé ni une autre nature (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const lot = await cloneConsumptions(trx, '2019-03-04', [
        { status: 'RECORDED', costType: 'ALIMENT', quantity: 1 },
        { status: 'CANCELLED', costType: 'ALIMENT', quantity: 2 },
        { status: 'RECORDED', costType: 'VETERINAIRE', quantity: 4 },
      ]);
      enough(ctx, lot ? 1 : 0, 1, 'consommation d’aliment modèle');
      const [day] = await rows<{ feed: string }>(
        trx,
        sql`SELECT COALESCE(SUM(feed_quantity), 0) AS feed FROM analytics_f_production_daily
             WHERE lot_id = ${toBin(lot!)} AND business_day = '2019-03-04'`,
      );
      expect(Number(day!.feed)).toBe(1);
    });
  });

  it('seules les collectes d’œufs enregistrées sont comptées, au jour de la collecte (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const lot = await cloneEggCollections(trx, '2019-03-04', [
        { status: 'RECORDED', collected: 3 },
        { status: 'CANCELLED', collected: 5 },
      ]);
      enough(ctx, lot ? 1 : 0, 1, 'collecte d’œufs modèle');
      const [day] = await rows<{ collected: string; sellable: string }>(
        trx,
        sql`SELECT COALESCE(SUM(eggs_collected), 0) AS collected, COALESCE(SUM(eggs_sellable), 0) AS sellable
              FROM analytics_f_production_daily
             WHERE lot_id = ${toBin(lot!)} AND business_day = '2019-03-04'`,
      );
      expect(Number(day!.collected)).toBe(3);
      expect(Number(day!.sellable)).toBe(3);
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
                   SUM(NOT (v.site_id <=> pl.site_id)) AS wrong_site,
                   SUM(NOT (v.lot_type <=> pl.lot_type)) AS wrong_type,
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
                   SUM(NOT (v.business_day <=> DATE(CONVERT_TZ(e.occurred_at, '+00:00', '+01:00')))) AS wrong_day
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
