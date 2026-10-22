/**
 * Jeux de faits commerciaux de la couche sémantique (P9-13 ; ADR-074 §2 et §3, ADR-075) : lignes de vente,
 * lignes de commande, encaissements, activité de prospection, présences.
 *
 * Chaque vue est rapprochée de **la définition qui existe déjà** — les fonctions publiques que l'accueil et
 * le tableau de distribution utilisent (`salesActivityByDay`, `cashedActivity`, `commercialEffort`,
 * `saleCostsInPeriod`) — ou, à défaut de fonction publique, d'un calcul indépendant en TypeScript sur les
 * lignes sources. Tout se lit dans un seul instantané (`REPEATABLE READ`, toujours annulé) : la base d'essai est
 * partagée et d'autres essais y écrivent pendant la lecture. Les exclusions et les dates sont éprouvées sur des
 * **copies** de lignes réelles (`analytics-view-seeds.ts`), jamais validées.
 */
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayOf, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { ALL_SCOPE, type ReadScope } from '../src/platform/read-scope.js';
import { saleCostsInPeriod } from '../src/modules/inventory/application/public/index.js';
import { commercialEffort } from '../src/modules/crm/application/public/index.js';
import {
  cashedActivity,
  salesActivityByDay,
} from '../src/modules/sales/application/public/index.js';
import { closeTestDb } from './helpers.js';
import {
  snapshot,
  cloneCancelledPayment,
  cloneDiscountedCancellation,
  cloneOrder,
  cloneProspect,
  cloneWorkSession,
  reassignConvertedCustomer,
} from './analytics-view-seeds.js';

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

/**
 * La base d'essai est partagée : ces rapprochements portent sur les lignes que les autres essais y ont
 * laissées. Une base trop pauvre pour que le contrôle ait un sens **saute** l'essai (visible au rapport),
 * elle ne le fait ni échouer ni passer à vide. Toujours appelée **avant** la première assertion.
 */
function enough(ctx: TestContext, actual: number, minimum: number, what: string): void {
  if (actual < minimum) ctx.skip(`${what} : ${actual} en base, ${minimum} au moins nécessaires`);
}

const dayText = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

describe('analytics_f_sales_line', () => {
  it('rend le vendu, l’annulé, le net et le nombre de ventes de chaque jour comme salesActivityByDay', async (ctx) => {
    await snapshot(async (trx) => {
      const reference = await salesActivityByDay(trx, ALL_SCOPE, {
        fromDay: FROM_DAY,
        toDay: TO_DAY,
      });
      enough(ctx, reference.length, 3, 'jours de vente');
      const view = await rows<{
        day: string;
        sold: string;
        cancelled: string;
        sales: string;
      }>(
        trx,
        sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day,
                   COALESCE(SUM(CASE WHEN event_kind = 'SALE' THEN amount_xaf END), 0) AS sold,
                   COALESCE(-SUM(CASE WHEN event_kind = 'CANCELLATION' THEN amount_xaf END), 0) AS cancelled,
                   COUNT(DISTINCT counted_sale_id) AS sales
              FROM analytics_f_sales_line
             WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
             GROUP BY business_day`,
      );
      const byDay = new Map(view.map((row) => [row.day, row]));
      for (const day of reference) {
        const row = byDay.get(day.day);
        expect(row, day.day).toBeDefined();
        expect(Number(row!.sold), `${day.day} vendu`).toBe(day.soldXaf);
        expect(Number(row!.cancelled), `${day.day} annulé`).toBe(day.cancelledXaf);
        expect(Number(row!.sold) - Number(row!.cancelled), `${day.day} net`).toBe(day.netXaf);
        // Le nombre de ventes n'existe que pour les jours de vente : un jour d'annulation seule vaut 0.
        expect(Number(row!.sales), `${day.day} ventes`).toBe(day.salesCount);
      }
      // Aucun jour de la vue ne manque à la référence (activité ou non) : mêmes jours.
      expect(new Set(view.map((row) => row.day))).toEqual(new Set(reference.map((d) => d.day)));
    });
  });

  it('suit le périmètre de lecture : un site, ou une personne vendeur ou commercial', async (ctx) => {
    await snapshot(async (trx) => {
      const top = await rows<{ site_id: Buffer; seller: Buffer; commercial: Buffer | null }>(
        trx,
        sql`SELECT site_id, MAX(seller_user_id) AS seller, MAX(commercial_user_id) AS commercial
              FROM analytics_f_sales_line GROUP BY site_id ORDER BY COUNT(*) DESC LIMIT 1`,
      );
      enough(ctx, top.length, 1, 'sites ayant des ventes');
      const siteId = fromBin(top[0]!.site_id);
      const person = fromBin(top[0]!.commercial ?? top[0]!.seller);
      const scopes: ReadonlyArray<[string, ReadScope, ReturnType<typeof sql>]> = [
        ['site', { siteIds: [siteId] }, sql`site_id = ${toBin(siteId)}`],
        [
          'personne',
          { userIds: [person] },
          sql`(seller_user_id = ${toBin(person)} OR commercial_user_id = ${toBin(person)})`,
        ],
      ];
      const references = new Map<string, Awaited<ReturnType<typeof salesActivityByDay>>>();
      for (const [label, scope] of scopes) {
        references.set(
          label,
          await salesActivityByDay(trx, scope, { fromDay: FROM_DAY, toDay: TO_DAY }),
        );
      }
      enough(
        ctx,
        Math.min(...[...references.values()].map((reference) => reference.length)),
        1,
        'jours de vente par site et par personne',
      );
      for (const [label, , predicate] of scopes) {
        const view = await rows<{ day: string; net: string }>(
          trx,
          sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day, SUM(amount_xaf) AS net
                FROM analytics_f_sales_line
               WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND ${predicate}
               GROUP BY business_day`,
        );
        expect(new Map(view.map((r) => [r.day, Number(r.net)])), label).toEqual(
          new Map(references.get(label)!.map((day) => [day.day, day.netXaf])),
        );
      }
    });
  });

  it('la portée par personne est celle de GET /sales : le commercial, à défaut le vendeur', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong: string; fallback: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   COALESCE(SUM(NOT (v.owner_user_id <=> COALESCE(s.commercial_user_id, s.seller_user_id))), 0) AS wrong,
                   COALESCE(SUM(s.commercial_user_id IS NULL AND v.owner_user_id <=> s.seller_user_id), 0) AS fallback
              FROM analytics_f_sales_line v JOIN sales_sales s ON s.id = v.sale_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'lignes de vente');
      expect(Number(check!.wrong)).toBe(0);
    });
  });

  it('porte le coût figé des mouvements SALE et le coût retourné des annulations (saleCostsInPeriod)', async (ctx) => {
    await snapshot(async (trx) => {
      const costs = await saleCostsInPeriod(trx, {
        fromUtc: new Date('2000-01-01T00:00:00Z'),
        toUtc: new Date('2100-01-01T00:00:00Z'),
      });
      // Les ventes dont chaque mouvement de stock cite sa ligne : les mouvements orphelins que d'autres
      // essais injectent directement dans la base partagée n'ont pas de ligne où se rattacher.
      const clean = await rows<{ sale_id: Buffer; sold: string; returned: string }>(
        trx,
        sql`SELECT x.sale_id, SUM(x.sold) AS sold, SUM(x.returned) AS returned
              FROM (
                SELECT sale_id, SUM(CASE WHEN event_kind = 'SALE' THEN cost_xaf ELSE 0 END) AS sold,
                       -SUM(CASE WHEN event_kind = 'CANCELLATION' THEN cost_xaf ELSE 0 END) AS returned
                  FROM analytics_f_sales_line GROUP BY sale_id
              ) x
             WHERE NOT EXISTS (
                     SELECT 1 FROM inventory_stock_moves m
                      WHERE m.source_doc_id = x.sale_id AND m.source_doc_type = 'SALE'
                        AND m.source_line_id IS NULL)
               AND NOT EXISTS (
                     SELECT 1 FROM inventory_stock_moves r
                      JOIN inventory_stock_moves o ON o.id = r.origin_move_id
                      WHERE o.source_doc_id = x.sale_id AND o.source_doc_type = 'SALE'
                        AND r.move_type = 'CUSTOMER_RETURN' AND r.source_line_id IS NULL)
             GROUP BY x.sale_id`,
      );
      const referenceOf = (saleId: Buffer) =>
        costs.get(fromBin(saleId)) ?? { soldXaf: 0, returnedXaf: 0 };
      enough(ctx, clean.length, 3, 'ventes à mouvements rattachés');
      enough(
        ctx,
        clean.filter((row) => referenceOf(row.sale_id).returnedXaf > 0).length,
        1,
        'ventes annulées avec un retour de stock',
      );
      for (const row of clean) {
        const reference = referenceOf(row.sale_id);
        expect(Number(row.sold), fromBin(row.sale_id)).toBe(reference.soldXaf);
        expect(Number(row.returned), fromBin(row.sale_id)).toBe(reference.returnedXaf);
      }
    });
  });

  it('la marge d’une ligne est son montant moins son coût, annulation comprise', async (ctx) => {
    await snapshot(async (trx) => {
      const [totals] = await rows<{
        n: string;
        bad: string;
        amount: string;
        cost: string;
        margin: string;
      }>(
        trx,
        sql`SELECT COUNT(*) AS n, COALESCE(SUM(margin_xaf <> amount_xaf - cost_xaf), 0) AS bad,
                   COALESCE(SUM(amount_xaf), 0) AS amount, COALESCE(SUM(cost_xaf), 0) AS cost,
                   COALESCE(SUM(margin_xaf), 0) AS margin
              FROM analytics_f_sales_line`,
      );
      enough(ctx, Number(totals!.n), 1, 'lignes de vente');
      expect(Number(totals!.bad)).toBe(0);
      expect(Number(totals!.margin)).toBe(Number(totals!.amount) - Number(totals!.cost));
    });
  });

  it('la remise est celle des lignes vendues ; une annulation ne la contre-passe pas', async (ctx) => {
    await snapshot(async (trx) => {
      const [discount] = await rows<{
        sold: string;
        cancelled: string;
        source: string;
        discounted: string;
      }>(
        trx,
        sql`SELECT COALESCE(SUM(CASE WHEN event_kind = 'SALE' THEN discount_xaf END), 0) AS sold,
                   COALESCE(SUM(CASE WHEN event_kind = 'CANCELLATION' THEN discount_xaf END), 0) AS cancelled,
                   (SELECT COALESCE(SUM(discount_xaf), 0) FROM sales_sale_lines) AS source,
                   (SELECT COUNT(*) FROM sales_sale_lines WHERE discount_xaf > 0) AS discounted
              FROM analytics_f_sales_line`,
      );
      enough(ctx, Number(discount!.discounted), 1, 'lignes de vente remisées');
      expect(Number(discount!.sold)).toBe(Number(discount!.source));
      expect(Number(discount!.cancelled)).toBe(0);
    });
  });

  it('l’annulation d’une ligne remisée : ligne négative sans remise, coût et marge du retour de stock (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const cancellation = await cloneDiscountedCancellation(trx, '2019-03-07', true);
      enough(ctx, cancellation ? 1 : 0, 1, 'ligne de vente remisée');
      const line = toBin(cancellation!.lineId);
      const lines = await rows<{
        event_kind: string;
        day: string;
        discount: string;
        amount: string;
        quantity: string;
        cost: string;
        margin: string;
      }>(
        trx,
        sql`SELECT event_kind, DATE_FORMAT(business_day, '%Y-%m-%d') AS day, discount_xaf AS discount,
                   amount_xaf AS amount, quantity_base AS quantity, cost_xaf AS cost, margin_xaf AS margin
              FROM analytics_f_sales_line WHERE line_id = ${line} AND (event_kind = 'SALE' OR business_day = '2019-03-07')`,
      );
      const cancelled = lines.filter((row) => row.event_kind === 'CANCELLATION');
      expect(cancelled).toHaveLength(1);
      expect(Number(cancelled[0]!.discount)).toBe(0);
      expect(Number(cancelled[0]!.amount)).toBe(-cancellation!.amountXaf);
      expect(Number(cancelled[0]!.quantity)).toBe(-cancellation!.quantityBase);
      // Le coût d'une annulation est négatif : celui du retour de stock de sa ligne (non nul).
      expect(cancellation!.returnedValueXaf).toBeGreaterThan(0);
      expect(Number(cancelled[0]!.cost)).toBe(-cancellation!.returnedValueXaf);
      expect(Number(cancelled[0]!.margin)).toBe(
        -cancellation!.amountXaf + cancellation!.returnedValueXaf,
      );
      const sold = lines.filter((row) => row.event_kind === 'SALE');
      expect(sold).toHaveLength(1);
      expect(Number(sold[0]!.discount)).toBe(cancellation!.discountXaf);
      expect(sold[0]!.day).not.toBe('2019-03-07');
    });
  });

  it('une annulation est une ligne négative à la date d’application, la date de la vente reste lisible', async (ctx) => {
    await snapshot(async (trx) => {
      const sample = await rows<{
        business_day: unknown;
        sale_day: unknown;
        applied: unknown;
        sale_business: unknown;
        quantity_base: string;
        amount_xaf: string;
        cl_quantity: string;
        cl_amount: string;
      }>(
        trx,
        sql`SELECT v.business_day, v.sale_day, c.applied_business_date AS applied,
                   s.business_date AS sale_business, v.quantity_base, v.amount_xaf,
                   cl.quantity_base AS cl_quantity, cl.amount_xaf AS cl_amount
              FROM analytics_f_sales_line v
              JOIN sales_sale_cancellation_lines cl ON cl.sale_line_id = v.line_id
              JOIN sales_sale_cancellations c ON c.id = cl.cancellation_id AND c.status = 'APPLIED'
              JOIN sales_sales s ON s.id = v.sale_id
             WHERE v.event_kind = 'CANCELLATION' AND v.amount_xaf = -cl.amount_xaf
               AND v.business_day = c.applied_business_date
             LIMIT 200`,
      );
      enough(ctx, sample.length, 1, 'lignes d’annulation appliquées');
      for (const row of sample) {
        expect(dayText(row.business_day)).toBe(dayText(row.applied));
        expect(dayText(row.sale_day)).toBe(dayText(row.sale_business));
        expect(Number(row.quantity_base)).toBe(-Number(row.cl_quantity));
        expect(Number(row.amount_xaf)).toBe(-Number(row.cl_amount));
      }
      // Seules les annulations appliquées entrent ; une demande ou un refus n'écrit aucune ligne.
      const [counts] = await rows<{ view_lines: string; applied_lines: string }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM analytics_f_sales_line WHERE event_kind = 'CANCELLATION') AS view_lines,
                   (SELECT COUNT(*) FROM sales_sale_cancellation_lines cl
                      JOIN sales_sale_cancellations c ON c.id = cl.cancellation_id
                     WHERE c.status = 'APPLIED') AS applied_lines`,
      );
      expect(Number(counts!.view_lines)).toBe(Number(counts!.applied_lines));
    });
  });
});

describe('analytics_f_payments', () => {
  it('rend les encaissements confirmés et annulés comme cashedActivity', async (ctx) => {
    await snapshot(async (trx) => {
      const reference = await cashedActivity(trx, ALL_SCOPE, { fromDay: FROM_DAY, toDay: TO_DAY });
      enough(ctx, reference.length, 1, 'groupes d’encaissements');
      const view = await rows<{
        site_id: Buffer;
        payment_method: string;
        received_by_user_id: Buffer;
        confirmed_count: string;
        confirmed_xaf: string;
        cancelled_count: string;
        cancelled_xaf: string;
      }>(
        trx,
        sql`SELECT site_id, payment_method, received_by_user_id,
                   SUM(event_kind = 'PAYMENT') AS confirmed_count,
                   COALESCE(SUM(CASE WHEN event_kind = 'PAYMENT' THEN amount_xaf END), 0) AS confirmed_xaf,
                   SUM(event_kind = 'CANCELLATION') AS cancelled_count,
                   COALESCE(-SUM(CASE WHEN event_kind = 'CANCELLATION' THEN amount_xaf END), 0) AS cancelled_xaf
              FROM analytics_f_payments
             WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}
             GROUP BY site_id, payment_method, received_by_user_id`,
      );
      const key = (site: string, method: string, user: string) => `${site}|${method}|${user}`;
      const fromView = new Map(
        view.map((row) => [
          key(fromBin(row.site_id), row.payment_method, fromBin(row.received_by_user_id)),
          [
            Number(row.confirmed_count),
            Number(row.confirmed_xaf),
            Number(row.cancelled_count),
            Number(row.cancelled_xaf),
          ],
        ]),
      );
      const fromReference = new Map(
        reference.map((row) => [
          key(fromBin(row.siteId), row.paymentMethodCode, fromBin(row.receivedByUserId)),
          [row.confirmedCount, row.confirmedXaf, row.cancelledCount, row.cancelledXaf],
        ]),
      );
      expect(fromView).toEqual(fromReference);
    });
  });

  it('un encaissement annulé trois jours plus tard : une ligne positive le premier jour, négative le troisième (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const payment = await cloneCancelledPayment(trx, '2019-03-04', '2019-03-07');
      enough(ctx, payment ? 1 : 0, 1, 'encaissement annulé');
      const lines = await rows<{ event_kind: string; day: string; amount: string }>(
        trx,
        sql`SELECT event_kind, DATE_FORMAT(business_day, '%Y-%m-%d') AS day, amount_xaf AS amount
              FROM analytics_f_payments WHERE payment_id = ${toBin(payment!.id)} ORDER BY event_kind`,
      );
      expect(lines.map((row) => [row.event_kind, row.day, Number(row.amount)])).toEqual([
        ['CANCELLATION', '2019-03-07', -payment!.amountXaf],
        ['PAYMENT', '2019-03-04', payment!.amountXaf],
      ]);
    });
  });

  it('une annulation retranche à la date où elle a été décidée, pas à celle de l’encaissement', async (ctx) => {
    await snapshot(async (trx) => {
      const sample = await rows<{
        business_day: unknown;
        cancelled_day: unknown;
        amount_xaf: string;
        paid: string;
      }>(
        trx,
        sql`SELECT v.business_day, DATE(CONVERT_TZ(p.cancelled_at, '+00:00', '+01:00')) AS cancelled_day,
                   v.amount_xaf, p.amount_xaf AS paid
              FROM analytics_f_payments v
              JOIN sales_customer_payments p ON p.id = v.payment_id
             WHERE v.event_kind = 'CANCELLATION' LIMIT 100`,
      );
      enough(ctx, sample.length, 1, 'annulations d’encaissement');
      for (const row of sample) {
        expect(dayText(row.business_day)).toBe(dayText(row.cancelled_day));
        expect(Number(row.amount_xaf)).toBe(-Number(row.paid));
      }
      // Un encaissement seulement enregistré ne crée aucune ligne d'annulation, un refusé aucune ligne.
      const [leak] = await rows<{ n: string }>(
        trx,
        sql`SELECT COUNT(*) AS n FROM analytics_f_payments v
              JOIN sales_customer_payments p ON p.id = v.payment_id
             WHERE (v.event_kind = 'CANCELLATION' AND p.status <> 'CANCELLED')
                OR p.status NOT IN ('RECORDED', 'CANCELLATION_REQUESTED', 'CANCELLED')`,
      );
      expect(Number(leak!.n)).toBe(0);
    });
  });
});

describe('analytics_f_prospecting', () => {
  it('rend, pour chaque personne, les comptes créés, visites, prospects visités et conversions de commercialEffort', async (ctx) => {
    await snapshot(async (trx) => {
      const users = await rows<{ user_id: Buffer }>(
        trx,
        sql`SELECT user_id FROM analytics_f_prospecting
             WHERE business_day BETWEEN ${FROM_DAY} AND ${TO_DAY} AND user_id IS NOT NULL
             GROUP BY user_id ORDER BY COUNT(DISTINCT event_kind) DESC, COUNT(*) DESC LIMIT 12`,
      );
      enough(ctx, users.length, 1, 'personnes ayant une activité de prospection');
      const fromUtc = businessDayStartUtc(FROM_DAY);
      const toUtc = businessDayEndUtc(TO_DAY);
      for (const { user_id: userBin } of users) {
        const userId = fromBin(userBin);
        const reference = await commercialEffort(trx, { userId, fromUtc, toUtc });
        const [view] = await rows<{
          created: string;
          visits: string;
          prospects: string;
          converted: string;
        }>(
          trx,
          sql`SELECT COUNT(DISTINCT CASE WHEN event_kind = 'ACCOUNT' THEN created_customer_id END) AS created,
                     COUNT(DISTINCT visit_id) AS visits,
                     COUNT(DISTINCT visited_prospect_id) AS prospects,
                     COUNT(DISTINCT converted_customer_id) AS converted
                FROM analytics_f_prospecting
               WHERE user_id = ${userBin} AND business_day BETWEEN ${FROM_DAY} AND ${TO_DAY}`,
        );
        expect(Number(view!.created), `${userId} créés`).toBe(reference.prospectsCreated);
        expect(Number(view!.visits), `${userId} visites`).toBe(reference.visits);
        expect(Number(view!.prospects), `${userId} prospects visités`).toBe(
          reference.prospectsVisited,
        );
        expect(Number(view!.converted), `${userId} conversions`).toBe(reference.newCustomers);
      }
    });
  });

  it('la personne d’un événement est son acteur : acquéreur du compte, auteur de la visite', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ accounts: string; visits: string; wrong: string }>(
        trx,
        sql`SELECT COALESCE(SUM(v.event_kind = 'ACCOUNT'), 0) AS accounts,
                   COALESCE(SUM(v.event_kind = 'VISIT'), 0) AS visits,
                   COALESCE(SUM(
                     (v.event_kind = 'ACCOUNT' AND NOT (v.user_id <=> c.acquired_by_user_id))
                  OR (v.event_kind = 'VISIT' AND NOT (v.user_id <=> cv.user_id))), 0) AS wrong
              FROM analytics_f_prospecting v
              LEFT JOIN crm_customers c ON v.event_kind = 'ACCOUNT' AND c.id = v.created_customer_id
              LEFT JOIN crm_visits cv ON v.event_kind = 'VISIT' AND cv.id = v.visit_id
             WHERE v.event_kind IN ('ACCOUNT', 'VISIT')`,
      );
      enough(
        ctx,
        Math.min(Number(check!.accounts), Number(check!.visits)),
        1,
        'comptes et visites',
      );
      expect(Number(check!.wrong)).toBe(0);
    });
  });

  it('un compte créé sans téléphone, ou au téléphone vide, n’est pas un contact collecté (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const empty = await cloneProspect(trx, '');
      const absent = await cloneProspect(trx, null);
      const phone = await cloneProspect(trx, '+237699000111');
      enough(ctx, empty && absent && phone ? 1 : 0, 1, 'prospect modèle');
      const view = await rows<{ created: Buffer; contact: Buffer | null }>(
        trx,
        sql`SELECT created_customer_id AS created, contact_customer_id AS contact
              FROM analytics_f_prospecting
             WHERE created_customer_id IN (${sql.join([empty!, absent!, phone!].map(toBin))})`,
      );
      const byId = new Map(view.map((row) => [fromBin(row.created), row.contact]));
      expect(byId.size).toBe(3);
      expect(byId.get(empty!)).toBeNull();
      expect(byId.get(absent!)).toBeNull();
      expect(fromBin(byId.get(phone!)!)).toBe(phone);
    });
  });

  it('chaque conversion est comptée, au titulaire de l’historique à l’instant de la conversion (calcul indépendant)', async (ctx) => {
    await snapshot(async (trx) => {
      const customers = await trx
        .selectFrom('crm_customers')
        .select(['id', 'converted_at'])
        .where('converted_at', 'is not', null)
        .execute();
      enough(ctx, customers.length, 1, 'comptes convertis');
      const assignments = await trx
        .selectFrom('crm_customer_assignments')
        .select(['customer_id', 'user_id', 'valid_from', 'valid_to'])
        .execute();
      const byCustomer = new Map<string, typeof assignments>();
      for (const assignment of assignments) {
        const key = fromBin(assignment.customer_id);
        byCustomer.set(key, [...(byCustomer.get(key) ?? []), assignment]);
      }
      const expected = new Set<string>();
      for (const customer of customers) {
        const at = customer.converted_at!.getTime();
        const holders = (byCustomer.get(fromBin(customer.id)) ?? []).filter(
          (assignment) =>
            assignment.valid_from.getTime() <= at &&
            (assignment.valid_to === null || assignment.valid_to.getTime() > at),
        );
        // Un compte converti sans titulaire à cet instant reste compté (personne vide).
        if (holders.length === 0) expected.add(`${fromBin(customer.id)}|`);
        for (const holder of holders) {
          expected.add(`${fromBin(customer.id)}|${fromBin(holder.user_id)}`);
        }
      }
      const view = await rows<{ customer: Buffer; user_id: Buffer | null }>(
        trx,
        sql`SELECT converted_customer_id AS customer, user_id FROM analytics_f_prospecting
             WHERE event_kind = 'CONVERSION'`,
      );
      expect(
        new Set(
          view.map((row) => `${fromBin(row.customer)}|${row.user_id ? fromBin(row.user_id) : ''}`),
        ),
      ).toEqual(expected);
    });
  });

  it('le titulaire d’une conversion suit l’historique : changé avant la conversion, changé après (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const before = await reassignConvertedCustomer(trx, 'BEFORE');
      const after = await reassignConvertedCustomer(
        trx,
        'AFTER',
        before ? [before.customerId] : [],
      );
      enough(ctx, before && after ? 1 : 0, 1, 'compte converti à titulaire unique et ouvert');
      for (const seeded of [before!, after!]) {
        const holders = await rows<{ user_id: Buffer | null }>(
          trx,
          sql`SELECT user_id FROM analytics_f_prospecting
               WHERE event_kind = 'CONVERSION' AND converted_customer_id = ${toBin(seeded.customerId)}`,
        );
        expect(
          holders.map((row) => (row.user_id ? fromBin(row.user_id) : null)),
          seeded.customerId,
        ).toEqual([seeded.holderAtConversion]);
      }
    });
  });

  it('un contact collecté est un compte créé avec un téléphone ; un compte fusionné ne compte pas', async (ctx) => {
    await snapshot(async (trx) => {
      const [contacts] = await rows<{ view_n: string; source_n: string; merged: string }>(
        trx,
        sql`SELECT (SELECT COUNT(DISTINCT contact_customer_id) FROM analytics_f_prospecting) AS view_n,
                   (SELECT COUNT(*) FROM crm_customers
                     WHERE stage <> 'MERGED' AND phone_primary IS NOT NULL AND phone_primary <> '') AS source_n,
                   (SELECT COUNT(*) FROM analytics_f_prospecting v
                      JOIN crm_customers c ON c.id = v.created_customer_id
                     WHERE c.stage = 'MERGED') AS merged`,
      );
      enough(ctx, Number(contacts!.source_n), 1, 'comptes créés avec un téléphone');
      expect(Number(contacts!.view_n)).toBe(Number(contacts!.source_n));
      expect(Number(contacts!.merged)).toBe(0);
    });
  });

  it('la zone d’une visite est celle du compte, le résultat est le code du motif de sortie', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong_zone: string; wrong_result: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked,
                   SUM(NOT (v.zone_id <=> c.zone_id)) AS wrong_zone,
                   SUM(NOT (v.result <=> rc.code)) AS wrong_result
              FROM analytics_f_prospecting v
              JOIN crm_visits cv ON cv.id = v.visit_id
              JOIN crm_customers c ON c.id = cv.customer_id
              JOIN catalog_reason_codes rc ON rc.id = cv.outcome_reason_code_id
             WHERE v.event_kind = 'VISIT'`,
      );
      enough(ctx, Number(check!.checked), 1, 'visites enregistrées');
      expect(Number(check!.wrong_zone)).toBe(0);
      expect(Number(check!.wrong_result)).toBe(0);
    });
  });
});

describe('analytics_f_attendance', () => {
  it('rend les jours de présence, sessions et minutes de chaque personne comme un calcul indépendant', async (ctx) => {
    await snapshot(async (trx) => {
      const sessions = await trx
        .selectFrom('fieldwork_work_sessions')
        .select(['user_id', 'started_at', 'ended_at', 'override_status'])
        .execute();
      const expected = new Map<string, { days: Set<string>; sessions: number; minutes: number }>();
      for (const session of sessions) {
        const user = fromBin(session.user_id);
        const entry = expected.get(user) ?? { days: new Set<string>(), sessions: 0, minutes: 0 };
        entry.sessions += 1;
        if (session.override_status === 'NOT_REQUIRED' || session.override_status === 'APPROVED') {
          entry.days.add(businessDayOf(session.started_at));
        }
        if (session.ended_at !== null) {
          entry.minutes += Math.floor(
            (session.ended_at.getTime() - session.started_at.getTime()) / 60_000,
          );
        }
        expected.set(user, entry);
      }
      enough(ctx, expected.size, 1, 'personnes ayant une session de travail');
      const view = await rows<{ user_id: Buffer; days: string; sessions: string; minutes: string }>(
        trx,
        sql`SELECT user_id, COUNT(DISTINCT accepted_day_key) AS days, SUM(session_count) AS sessions,
                   COALESCE(SUM(duration_minutes), 0) AS minutes
              FROM analytics_f_attendance GROUP BY user_id`,
      );
      expect(view.length).toBe(expected.size);
      for (const row of view) {
        const entry = expected.get(fromBin(row.user_id));
        expect(entry, fromBin(row.user_id)).toBeDefined();
        expect(Number(row.days)).toBe(entry!.days.size);
        expect(Number(row.sessions)).toBe(entry!.sessions);
        expect(Number(row.minutes)).toBe(entry!.minutes);
      }
    });
  });

  it('la zone d’une session est la zone déclarée au pointage', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ checked: string; wrong: string; no_zone: string }>(
        trx,
        sql`SELECT COUNT(*) AS checked, COALESCE(SUM(NOT (v.zone_id <=> w.declared_zone_id)), 0) AS wrong,
                   COALESCE(SUM(v.zone_id IS NULL), 0) AS no_zone
              FROM analytics_f_attendance v JOIN fieldwork_work_sessions w ON w.id = v.session_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'sessions de travail');
      expect(Number(check!.wrong)).toBe(0);
      expect(Number(check!.no_zone)).toBe(0);
    });
  });

  it('une session commencée à 23 h 30 UTC est du lendemain à Douala (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const session = await cloneWorkSession(trx, '2019-03-04T23:30:00.000Z');
      enough(ctx, session ? 1 : 0, 1, 'session de travail terminée');
      const [row] = await rows<{ day: string; key: string }>(
        trx,
        sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day, accepted_day_key AS \`key\`
              FROM analytics_f_attendance WHERE session_id = ${toBin(session!)}`,
      );
      expect(row!.day).toBe('2019-03-05');
      expect(row!.key.endsWith('|2019-03-05')).toBe(true);
    });
  });

  it('une dérogation refusée ou en attente ne compte pas comme jour de présence', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{
        refused: string;
        accepted_key_on_refused: string;
        flagged: string;
      }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM fieldwork_work_sessions
                     WHERE override_status IN ('PENDING', 'REJECTED')) AS refused,
                   (SELECT COUNT(*) FROM analytics_f_attendance v
                      JOIN fieldwork_work_sessions w ON w.id = v.session_id
                     WHERE w.override_status IN ('PENDING', 'REJECTED')
                       AND v.accepted_day_key IS NOT NULL) AS accepted_key_on_refused,
                   (SELECT COUNT(*) FROM analytics_f_attendance WHERE override = 1) AS flagged`,
      );
      enough(ctx, Number(check!.refused), 1, 'sessions à dérogation refusée ou en attente');
      expect(Number(check!.accepted_key_on_refused)).toBe(0);
      expect(Number(check!.flagged)).toBeGreaterThanOrEqual(Number(check!.refused));
    });
  });
});

describe('analytics_f_orders', () => {
  it('rend les lignes des commandes engagées, au jour de leur confirmation, comme un calcul indépendant', async (ctx) => {
    await snapshot(async (trx) => {
      const lines = await trx
        .selectFrom('sales_sales_order_lines as l')
        .innerJoin('sales_sales_orders as o', 'o.id', 'l.order_id')
        .select([
          'o.id as order_id',
          'o.occurred_at',
          'o.confirmed_at',
          'o.status',
          'l.quantity_base',
          'l.delivered_quantity_base',
          'l.line_total_xaf',
        ])
        .where('o.status', 'not in', ['DRAFT', 'CANCELLED'])
        .execute();
      const expected = new Map<
        string,
        { orders: Set<string>; ordered: number; delivered: number; amount: number }
      >();
      for (const line of lines) {
        const day = businessDayOf(line.confirmed_at ?? line.occurred_at);
        const entry = expected.get(day) ?? {
          orders: new Set<string>(),
          ordered: 0,
          delivered: 0,
          amount: 0,
        };
        entry.orders.add(fromBin(line.order_id));
        entry.ordered += Number(line.quantity_base);
        entry.delivered += Number(line.delivered_quantity_base);
        entry.amount += Number(line.line_total_xaf);
        expected.set(day, entry);
      }
      enough(ctx, expected.size, 1, 'jours de commande');
      const view = await rows<{
        day: string;
        orders: string;
        ordered: string;
        delivered: string;
        amount: string;
      }>(
        trx,
        sql`SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS day, COUNT(DISTINCT order_id) AS orders,
                   SUM(ordered_quantity) AS ordered, SUM(delivered_quantity) AS delivered,
                   SUM(amount_xaf) AS amount
              FROM analytics_f_orders GROUP BY business_day`,
      );
      expect(view.length).toBe(expected.size);
      for (const row of view) {
        const entry = expected.get(row.day);
        expect(entry, row.day).toBeDefined();
        expect(Number(row.orders), row.day).toBe(entry!.orders.size);
        expect(Number(row.ordered), row.day).toBeCloseTo(entry!.ordered, 3);
        expect(Number(row.delivered), row.day).toBeCloseTo(entry!.delivered, 3);
        expect(Number(row.amount), row.day).toBe(entry!.amount);
      }
    });
  });

  it('une commande brouillon ou annulée n’entre pas, une commande engagée entre (copies)', async (ctx) => {
    await snapshot(async (trx) => {
      const draft = await cloneOrder(trx, 'DRAFT');
      const cancelled = await cloneOrder(trx, 'CANCELLED');
      const confirmed = await cloneOrder(trx, 'CONFIRMED');
      enough(ctx, draft && cancelled && confirmed ? 1 : 0, 1, 'commande modèle');
      const lines = async (orderId: string) =>
        Number(
          (
            await rows<{ n: string }>(
              trx,
              sql`SELECT COUNT(*) AS n FROM analytics_f_orders WHERE order_id = ${toBin(orderId)}`,
            )
          )[0]!.n,
        );
      expect(await lines(draft!)).toBe(0);
      expect(await lines(cancelled!)).toBe(0);
      expect(await lines(confirmed!)).toBe(1);
    });
  });

  it('la zone est celle du site de la commande, comme la lecture du module sales', async (ctx) => {
    await snapshot(async (trx) => {
      const [check] = await rows<{ excluded: string; wrong_zone: string; checked: string }>(
        trx,
        sql`SELECT (SELECT COUNT(*) FROM analytics_f_orders WHERE status IN ('DRAFT', 'CANCELLED')) AS excluded,
                   COALESCE(SUM(NOT (v.zone_id <=> st.zone_id)), 0) AS wrong_zone, COUNT(*) AS checked
              FROM analytics_f_orders v
              JOIN sales_sales_orders o ON o.id = v.order_id
              JOIN organization_sites st ON st.id = o.site_id`,
      );
      enough(ctx, Number(check!.checked), 1, 'lignes de commande');
      expect(Number(check!.excluded)).toBe(0);
      expect(Number(check!.wrong_zone)).toBe(0);
    });
  });

  it('une commande confirmée un autre jour que sa création est du jour de la confirmation (copie)', async (ctx) => {
    await snapshot(async (trx) => {
      const orderId = await cloneOrder(trx, 'CONFIRMED', {
        occurredAt: '2019-03-04T09:00:00.000Z',
        confirmedAt: '2019-03-06T09:00:00.000Z',
      });
      enough(ctx, orderId ? 1 : 0, 1, 'commande modèle');
      const [row] = await rows<{ day: string }>(
        trx,
        sql`SELECT DATE_FORMAT(MIN(business_day), '%Y-%m-%d') AS day FROM analytics_f_orders
             WHERE order_id = ${toBin(orderId!)}`,
      );
      expect(row!.day).toBe('2019-03-06');
    });
  });
});
