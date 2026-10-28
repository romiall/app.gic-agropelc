/**
 * Jeux de faits de finance et d'achats de la couche sémantique (P9-13 ; ADR-064 §2, ADR-065) : dépenses,
 * mouvements de trésorerie, achats (commandes et réceptions).
 *
 * Chaque vue est rapprochée de la définition qui existe déjà — `expensesSummary` (KPI-FIN-04),
 * `cashAccountBalance` (solde projeté d'un compte) et `purchaseOrderMatching` (rapprochement d'un bon).
 * Tout se lit dans un seul instantané (`REPEATABLE READ`), sur la base d'essai partagée : une base trop pauvre
 * pour qu'un contrôle ait un sens le **saute** (visible au rapport).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  cashAccountBalance,
  expensesSummary,
} from '../src/modules/finance/application/public/index.js';
import { purchaseOrderMatching } from '../src/modules/procurement/application/public/index.js';
import { closeTestDb } from './helpers.js';
import { enough, atDay, snapshot } from './analytics-view-seeds.js';
import {
  cloneCashMovementOnHolderlessAccount,
  cloneOrderLine,
  cloneOrderWithStatus,
  cloneReceipts,
} from './analytics-view-seeds-stock.js';

afterAll(closeTestDb);

const FROM_DAY = '2020-01-01';
const TO_DAY = '2099-12-31';

type Trx = Transaction<DB>;

async function rows<T extends Record<string, unknown>>(
  trx: Trx,
  query: ReturnType<typeof sql<T>>,
): Promise<readonly T[]> {
  return (await query.execute(trx)).rows;
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
        amount: string;
        n: string;
        pending: string;
        unjustified: string;
      }>(
        trx,
        sql`SELECT c.code AS code, COALESCE(SUM(v.amount_xaf), 0) AS amount, SUM(v.amount_xaf IS NOT NULL) AS n,
                   COALESCE(SUM(v.pending_xaf), 0) AS pending, COALESCE(SUM(v.unjustified_xaf), 0) AS unjustified
              FROM analytics_f_expenses v
              JOIN finance_expense_categories c ON c.id = v.category_id
             WHERE v.business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
             GROUP BY c.code`,
      );
      // Les catégories sans dépense valide n'ont pas de ligne chez la référence : seules celles qui en ont comptent.
      expect(
        new Map(
          view
            .filter((row) => Number(row.n) > 0)
            .map((row) => [row.code, { amount: Number(row.amount), count: Number(row.n) }]),
        ),
      ).toEqual(
        new Map(
          reference.byCategory.map((line) => [
            line.code,
            { amount: line.amountXaf, count: line.count },
          ]),
        ),
      );
      expect(view.reduce((total, row) => total + Number(row.pending), 0)).toBe(
        reference.pendingXaf,
      );
      expect(view.reduce((total, row) => total + Number(row.unjustified), 0)).toBe(
        reference.unjustifiedXaf,
      );
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
                   COALESCE(SUM(NOT (v.site_id <=> e.site_id) OR NOT (v.created_by <=> e.created_by)), 0) AS wrong_site,
                   COALESCE(SUM(NOT (v.business_day <=> DATE(CONVERT_TZ(e.occurred_at, '+00:00', '+01:00')))), 0) AS wrong_day
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

  it('un mouvement est une entrée ou une sortie, jamais les deux ; site et titulaire (à défaut le responsable) viennent du compte', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        checked: string;
        both_ways: string;
        wrong_amount: string;
        wrong_account: string;
        wrong_reversal: string;
        reversals: string;
        view_n: string;
        source_n: string;
      }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   COALESCE(SUM(NOT (v.is_reversal <=> m.is_reversal)), 0) AS wrong_reversal,
                   COALESCE(SUM(m.is_reversal = 1), 0) AS reversals,
                   SUM(v.inflow_xaf > 0 AND v.outflow_xaf > 0) AS both_ways,
                   SUM(v.inflow_xaf + v.outflow_xaf <> m.amount_xaf) AS wrong_amount,
                   SUM(NOT (v.site_id <=> a.site_id)
                    OR NOT (v.holder_user_id <=> COALESCE(a.holder_user_id, a.responsible_user_id))) AS wrong_account,
                   (SELECT COUNT(*) FROM analytics_f_cash) AS view_n,
                   (SELECT COUNT(*) FROM finance_cash_movements) AS source_n
              FROM analytics_f_cash v
              JOIN finance_cash_movements m ON m.id = v.movement_id
              JOIN finance_cash_accounts a ON a.id = m.cash_account_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'mouvements de trésorerie');
      // Sans contre-écriture, un mutant qui n'expose pas `is_reversal` passerait : l'essai saute plutôt.
      enough(ctx, Number(check!.reversals), 1, 'contre-écritures de trésorerie');
      expect(Number(check!.wrong_reversal)).toBe(0);
      expect(Number(check!.both_ways)).toBe(0);
      expect(Number(check!.wrong_amount)).toBe(0);
      expect(Number(check!.wrong_account)).toBe(0);
      expect(Number(check!.view_n)).toBe(Number(check!.source_n));
    });
  });
});

describe('analytics_f_cash (compte sans titulaire)', () => {
  it('la personne d’un mouvement sur un compte sans titulaire est le responsable du compte (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const seeded = await cloneCashMovementOnHolderlessAccount(trx, '2019-03-04');
      enough(ctx, seeded ? 1 : 0, 1, 'compte de trésorerie sans titulaire');
      const [row] = await rows<{ person: Buffer | null }>(
        trx,
        sql`SELECT holder_user_id AS person FROM analytics_f_cash WHERE movement_id = ${toBin(seeded!.movementId)}`,
      );
      expect(row!.person ? fromBin(row!.person) : null).toBe(seeded!.responsibleUserId);
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
            // Une ligne annulée n'est plus commandée (la vue l'écarte) ; ses réceptions éventuelles restent.
            ordered: current.ordered + (line.status === 'CANCELLED' ? 0 : line.orderedQtyBase),
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
        const byProduct = new Map(view.map((row) => [fromBin(row.product_id), row]));
        // La vue n'invente pas de produit ; un produit qu'elle n'a pas (ligne annulée sans réception) est à zéro.
        for (const productId of byProduct.keys()) {
          expect(expected.has(productId), `${orderId}/${productId}`).toBe(true);
        }
        for (const [productId, line] of expected) {
          const row = byProduct.get(productId);
          const label = `${orderId}/${productId}`;
          if (row === undefined) {
            expect([line.ordered, line.delivered, line.rejected, line.accepted], label).toEqual([
              0, 0, 0, 0,
            ]);
            continue;
          }
          near(Number(row.ordered), line.ordered, `${label} commandé`);
          near(Number(row.delivered), line.delivered, `${label} livré`);
          near(Number(row.rejected), line.rejected, `${label} rejeté`);
          near(Number(row.accepted), line.accepted, `${label} accepté`);
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
                     WHERE v.receipt_id IS NULL AND po.status IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')) AS leaked_orders,
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

  it('seules les réceptions comptabilisées entrent, au jour de la réception (copies, une par statut)', async (ctx) => {
    await snapshot(async (trx) => {
      const receipts = await cloneReceipts(trx, '2019-03-04', [
        { status: 'POSTED', delivered: 1 },
        { status: 'POSTED_PENDING_REVIEW', delivered: 2 },
        { status: 'REVIEW_REJECTED', delivered: 4 },
        { status: 'CANCELLATION_PENDING', delivered: 8 },
        { status: 'QUARANTINED', delivered: 16 },
        { status: 'REJECTED', delivered: 32 },
        { status: 'CANCELLED', delivered: 64 },
      ]);
      enough(ctx, receipts ? 1 : 0, 1, 'réception modèle');
      const [day] = await rows<{ delivered: string; accepted: string }>(
        trx,
        sql`SELECT COALESCE(SUM(delivered_quantity), 0) AS delivered, COALESCE(SUM(accepted_quantity), 0) AS accepted
              FROM analytics_f_purchases
             WHERE order_id = ${toBin(receipts!.orderId)} AND product_id = ${toBin(receipts!.productId)}
               AND receipt_id IS NOT NULL AND business_day = '2019-03-04'`,
      );
      expect(Number(day!.delivered)).toBe(1 + 2 + 4 + 8);
      expect(Number(day!.accepted)).toBe(1 + 2 + 4 + 8);
    });
  });

  it('le commandé et le montant commandé de chaque produit d’un bon sont ceux de ses lignes non annulées (copies de lignes)', async (ctx) => {
    await snapshot(async (trx) => {
      const added = await cloneOrderLine(trx);
      const cancelled = await cloneOrderLine(trx, 'CANCELLED', 1);
      enough(ctx, added && cancelled ? 1 : 0, 1, 'ligne de bon de commande modèle');
      const source = await rows<{
        order_id: Buffer;
        product_id: Buffer;
        ordered: string;
        amount: string;
      }>(
        trx,
        sql`SELECT l.order_id, l.product_id, SUM(l.ordered_qty_base) AS ordered, SUM(l.line_total_xaf) AS amount
              FROM procurement_purchase_order_lines l
              JOIN procurement_purchase_orders po ON po.id = l.order_id
             WHERE po.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') AND l.status <> 'CANCELLED'
             GROUP BY l.order_id, l.product_id`,
      );
      const view = await rows<{
        order_id: Buffer;
        product_id: Buffer;
        ordered: string;
        amount: string;
      }>(
        trx,
        sql`SELECT order_id, product_id, SUM(ordered_quantity) AS ordered, SUM(amount_xaf) AS amount
              FROM analytics_f_purchases WHERE receipt_id IS NULL GROUP BY order_id, product_id`,
      );
      const key = (row: { order_id: Buffer; product_id: Buffer }) =>
        `${fromBin(row.order_id)}|${fromBin(row.product_id)}`;
      expect(
        new Map(view.map((row) => [key(row), [Number(row.ordered), Number(row.amount)]])),
      ).toEqual(
        new Map(source.map((row) => [key(row), [Number(row.ordered), Number(row.amount)]])),
      );
      // Le produit de la ligne ajoutée est nouveau pour le bon : sa ligne vaut exactement le montant ajouté ; celui de
      // la ligne annulée n'a aucune ligne.
      const own = view.find((row) => key(row) === `${added!.orderId}|${added!.productId}`);
      expect(Number(own!.amount)).toBe(added!.lineTotalXaf);
      expect(Number(own!.ordered)).toBe(3);
      expect(view.some((row) => key(row) === `${cancelled!.orderId}|${cancelled!.productId}`)).toBe(
        false,
      );
    });
  });

  it('un bon en attente d’approbation, brouillon ou annulé n’entre pas, un bon approuvé entre (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const orders = new Map<string, string>();
      for (const status of ['PENDING_APPROVAL', 'DRAFT', 'CANCELLED', 'APPROVED']) {
        const copy = await cloneOrderWithStatus(trx, status);
        if (copy) orders.set(status, copy.orderId);
      }
      enough(ctx, orders.size === 4 ? 1 : 0, 1, 'bon de commande modèle');
      for (const [status, orderId] of orders) {
        const [count] = await rows<{ n: string }>(
          trx,
          sql`SELECT COUNT(*) AS n FROM analytics_f_purchases
               WHERE order_id = ${toBin(orderId)} AND receipt_id IS NULL`,
        );
        expect(Number(count!.n), status).toBe(status === 'APPROVED' ? 1 : 0);
      }
    });
  });

  it('un bon est daté de son approbation, non de la création de son brouillon (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const copy = await cloneOrderWithStatus(trx, 'APPROVED', {
        occurred_at: atDay('2019-03-01'),
        approved_at: atDay('2019-03-05'),
      });
      enough(ctx, copy ? 1 : 0, 1, 'bon de commande modèle');
      const days = await rows<{ day: string }>(
        trx,
        sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day FROM analytics_f_purchases
             WHERE order_id = ${toBin(copy!.orderId)} AND receipt_id IS NULL`,
      );
      expect(days.map((row) => row.day)).toEqual(['2019-03-05']);
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
