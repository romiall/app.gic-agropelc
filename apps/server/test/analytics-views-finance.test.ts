/**
 * Jeux de faits de finance et d'achats de la couche sémantique (P9-13 ; ADR-074 §2, ADR-075) : dépenses,
 * mouvements de trésorerie, achats (commandes et réceptions).
 *
 * Chaque vue est rapprochée de la définition qui existe déjà — `expensesSummary` (KPI-FIN-04),
 * `cashAccountBalance` (solde projeté d'un compte) et `purchaseOrderMatching` (rapprochement d'un bon).
 * Tout se lit dans un seul instantané (`REPEATABLE READ`), sur la base d'essai partagée : une base trop pauvre
 * pour qu'un contrôle ait un sens le **saute** (visible au rapport).
 */
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import {
  cashAccountBalance,
  expensesSummary,
} from '../src/modules/finance/application/public/index.js';
import { purchaseOrderMatching } from '../src/modules/procurement/application/public/index.js';
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

describe('analytics_f_expenses', () => {
  it('rend les dépenses valides, en attente et non justifiées de chaque catégorie comme expensesSummary', async (ctx) => {
    await snapshot(async (trx) => {
      const reference = await expensesSummary(trx, {
        fromUtc: businessDayStartUtc(FROM_DAY),
        toUtc: businessDayEndUtc(TO_DAY),
      });
      enough(ctx, reference.count, 1, 'dépenses valides');
      const view = await rows<{
        code: string;
        status: string;
        amount: string;
        n: string;
      }>(
        trx,
        sql`SELECT c.code AS code, v.status AS status, SUM(v.amount_xaf) AS amount, COUNT(*) AS n
              FROM analytics_f_expenses v
              JOIN finance_expense_categories c ON c.id = v.category_id
             WHERE v.business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
             GROUP BY c.code, v.status`,
      );
      const valid = new Set(['RECORDED', 'APPROVED', 'PAID']);
      const byCategory = new Map<string, { amount: number; count: number }>();
      let pending = 0;
      let unjustified = 0;
      for (const row of view) {
        if (valid.has(row.status)) {
          const current = byCategory.get(row.code) ?? { amount: 0, count: 0 };
          byCategory.set(row.code, {
            amount: current.amount + Number(row.amount),
            count: current.count + Number(row.n),
          });
        } else if (row.status === 'PENDING_APPROVAL' || row.status === 'PAID_PENDING_APPROVAL') {
          pending += Number(row.amount);
        } else if (row.status === 'PAID_REJECTED') {
          unjustified += Number(row.amount);
        }
      }
      expect(byCategory).toEqual(
        new Map(
          reference.byCategory.map((line) => [
            line.code,
            { amount: line.amountXaf, count: line.count },
          ]),
        ),
      );
      expect(pending).toBe(reference.pendingXaf);
      expect(unjustified).toBe(reference.unjustifiedXaf);
    });
  });

  it('ni dépense annulée ni dépense refusée avant paiement ; le site est celui de la dépense', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        leaked: string;
        view_n: string;
        source_n: string;
        wrong_site: string;
        wrong_day: string;
      }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM analytics_f_expenses WHERE status IN ('CANCELLED', 'REJECTED')) AS leaked,
                   (SELECT COUNT(*) FROM analytics_f_expenses) AS view_n,
                   (SELECT COUNT(*) FROM finance_expenses WHERE status NOT IN ('CANCELLED', 'REJECTED')) AS source_n,
                   COALESCE(SUM(v.site_id <> e.site_id OR v.created_by <> e.created_by), 0) AS wrong_site,
                   COALESCE(SUM(v.business_day <> DATE(CONVERT_TZ(e.occurred_at, '+00:00', '+01:00'))), 0) AS wrong_day
              FROM analytics_f_expenses v JOIN finance_expenses e ON e.id = v.expense_id`,
      );
      enough(ctx, Number(check!.source_n), 1, 'dépenses vivantes');
      expect(Number(check!.leaked)).toBe(0);
      expect(Number(check!.view_n)).toBe(Number(check!.source_n));
      expect(Number(check!.wrong_site)).toBe(0);
      expect(Number(check!.wrong_day)).toBe(0);
    });
  });
});

describe('analytics_f_cash', () => {
  it('rend, pour chaque compte, le solde projeté : entrées moins sorties', async (ctx) => {
    await snapshot(async (trx) => {
      const accounts = await rows<{ account: Buffer; net: string }>(
        trx,
        sql`SELECT cash_account_id AS account, SUM(inflow_xaf) - SUM(outflow_xaf) AS net
              FROM analytics_f_cash GROUP BY cash_account_id ORDER BY COUNT(*) DESC LIMIT 25`,
      );
      enough(ctx, accounts.length, 1, 'comptes de trésorerie mouvementés');
      for (const { account, net } of accounts) {
        const projected = await cashAccountBalance(trx, fromBin(account));
        expect(Number(net), fromBin(account)).toBe(projected);
      }
    });
  });

  it('un mouvement est une entrée ou une sortie, jamais les deux ; site et titulaire viennent du compte', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        checked: string;
        both_ways: string;
        wrong_amount: string;
        wrong_account: string;
        view_n: string;
        source_n: string;
      }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(v.inflow_xaf > 0 AND v.outflow_xaf > 0) AS both_ways,
                   SUM(v.inflow_xaf + v.outflow_xaf <> m.amount_xaf) AS wrong_amount,
                   SUM(NOT (v.site_id <=> a.site_id) OR NOT (v.holder_user_id <=> a.holder_user_id)) AS wrong_account,
                   (SELECT COUNT(*) FROM analytics_f_cash) AS view_n,
                   (SELECT COUNT(*) FROM finance_cash_movements) AS source_n
              FROM analytics_f_cash v
              JOIN finance_cash_movements m ON m.id = v.movement_id
              JOIN finance_cash_accounts a ON a.id = m.cash_account_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'mouvements de trésorerie');
      expect(Number(check!.both_ways)).toBe(0);
      expect(Number(check!.wrong_amount)).toBe(0);
      expect(Number(check!.wrong_account)).toBe(0);
      expect(Number(check!.view_n)).toBe(Number(check!.source_n));
    });
  });
});

describe('analytics_f_purchases', () => {
  it('rend, pour chaque bon, le commandé, le livré, le rejeté et l’accepté de chaque produit comme purchaseOrderMatching', async (ctx) => {
    await snapshot(async (trx) => {
      const orders = await rows<{ order_id: Buffer }>(
        trx,
        sql`SELECT order_id FROM analytics_f_purchases WHERE receipt_id IS NOT NULL AND order_id IS NOT NULL
             GROUP BY order_id ORDER BY COUNT(*) DESC LIMIT 15`,
      );
      enough(ctx, orders.length, 1, 'bons de commande réceptionnés');
      for (const { order_id: orderBin } of orders) {
        const orderId = fromBin(orderBin);
        const matching = await purchaseOrderMatching(trx, orderId);
        expect(matching, orderId).toBeDefined();
        const expected = new Map<
          string,
          { ordered: number; delivered: number; rejected: number; accepted: number }
        >();
        for (const line of matching!.lines) {
          const current = expected.get(line.productId) ?? {
            ordered: 0,
            delivered: 0,
            rejected: 0,
            accepted: 0,
          };
          expected.set(line.productId, {
            ordered: current.ordered + line.orderedQtyBase,
            delivered: current.delivered + line.deliveredQtyBase,
            rejected: current.rejected + line.rejectedQtyBase,
            accepted: current.accepted + line.acceptedQtyBase,
          });
        }
        const view = await rows<{
          product_id: Buffer;
          ordered: string;
          delivered: string;
          rejected: string;
          accepted: string;
        }>(
          trx,
          sql`SELECT product_id, COALESCE(SUM(ordered_quantity), 0) AS ordered,
                     COALESCE(SUM(delivered_quantity), 0) AS delivered,
                     COALESCE(SUM(rejected_quantity), 0) AS rejected,
                     COALESCE(SUM(accepted_quantity), 0) AS accepted
                FROM analytics_f_purchases WHERE order_id = ${orderBin} GROUP BY product_id`,
        );
        expect(view.length, orderId).toBe(expected.size);
        for (const row of view) {
          const line = expected.get(fromBin(row.product_id));
          const label = `${orderId}/${fromBin(row.product_id)}`;
          expect(line, label).toBeDefined();
          near(Number(row.ordered), line!.ordered, `${label} commandé`);
          near(Number(row.delivered), line!.delivered, `${label} livré`);
          near(Number(row.rejected), line!.rejected, `${label} rejeté`);
          near(Number(row.accepted), line!.accepted, `${label} accepté`);
        }
      }
    });
  });

  it('le montant commandé de chaque bon est son total ; ni brouillon, ni bon annulé, ni réception hors statuts comptés', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        orders: string;
        wrong_total: string;
        leaked_orders: string;
        leaked_receipts: string;
        accepted_gap: string;
      }>(
        trx,
        sql`SELECT (SELECT COUNT(DISTINCT order_id) FROM analytics_f_purchases WHERE amount_xaf IS NOT NULL) AS orders,
                   (SELECT COUNT(*) FROM (
                      SELECT v.order_id FROM analytics_f_purchases v
                        JOIN procurement_purchase_orders po ON po.id = v.order_id
                       WHERE v.amount_xaf IS NOT NULL
                       GROUP BY v.order_id, po.total_xaf HAVING SUM(v.amount_xaf) <> po.total_xaf) x) AS wrong_total,
                   (SELECT COUNT(*) FROM analytics_f_purchases v
                      JOIN procurement_purchase_orders po ON po.id = v.order_id
                     WHERE v.receipt_id IS NULL AND po.status IN ('DRAFT', 'CANCELLED')) AS leaked_orders,
                   (SELECT COUNT(*) FROM analytics_f_purchases v
                      JOIN procurement_goods_receipts r ON r.id = v.receipt_id
                     WHERE r.status NOT IN ('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING')) AS leaked_receipts,
                   (SELECT COUNT(*) FROM analytics_f_purchases
                     WHERE receipt_id IS NOT NULL AND accepted_quantity <> delivered_quantity - rejected_quantity) AS accepted_gap`,
      );
      enough(ctx, Number(check!.orders), 1, 'bons de commande engagés');
      expect(Number(check!.wrong_total)).toBe(0);
      expect(Number(check!.leaked_orders)).toBe(0);
      expect(Number(check!.leaked_receipts)).toBe(0);
      expect(Number(check!.accepted_gap)).toBe(0);
    });
  });

  it('le site, le fournisseur et l’auteur d’une ligne sont ceux de son document', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(NOT (v.site_id <=> COALESCE(po.site_id, r.site_id))
                    OR NOT (v.supplier_id <=> COALESCE(po.supplier_id, r.supplier_id))
                    OR NOT (v.created_by <=> COALESCE(po.created_by, r.created_by))) AS wrong
              FROM analytics_f_purchases v
              LEFT JOIN procurement_purchase_orders po ON v.receipt_id IS NULL AND po.id = v.order_id
              LEFT JOIN procurement_goods_receipts r ON r.id = v.receipt_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'lignes d’achat');
      expect(Number(check!.wrong)).toBe(0);
    });
  });
});
