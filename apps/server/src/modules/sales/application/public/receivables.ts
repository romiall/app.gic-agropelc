/**
 * Encours d'un client (BR-VEN-025, D09 §7.1) : somme des soldes dus de ses ventes non annulées. Les
 * créances et l'encours ne sont jamais stockés (ADR-010) : ils se calculent sur `balance_due_xaf`
 * (colonne générée, index `(customer_id, occurred_at)`). Un compte fusionné s'ajoute à celui qui
 * l'a absorbé (BR-CRM-007) : l'appelant passe le compte conservé. C'est le **reste à encaisser** ; le contrôle
 * du crédit à la livraison d'une commande (AV-512) compte seulement le remis non payé :
 * `customerCreditExposureXaf`.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { businessDayOf, receivableAging, type AgingBucket } from '@gic/domain';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { absorbedCustomerIds } from '../../../crm/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import type { ListScope } from './sales-query.js';

/** Interrupteur d'AV-513 (réglage global, serveur seulement) : voir `receivablesDeliveredOnly`. */
export const RECEIVABLES_DELIVERED_ONLY_SETTING = 'sales.receivables_delivered_only';

/**
 * AV-513 (b), tranché par le porteur le 08/11/2026 (questionnaire de clôture, Q47 A) : vrai seulement si le réglage
 * global vaut exactement `true` (son défaut depuis la décision). Alors les créances par ancienneté, l'encours qui sert
 * au contrôle du crédit d'une vente directe, la liste des créances, le résumé des tableaux de bord et de l'accueil
 * (KPI-FIN-02, KPI-FIN-03) et l'encours servi aux appareils ne comptent que le **livré non payé** d'une commande, avec
 * une échéance comptée depuis la première livraison (`deliveredOnlyReceivables`) ; faux, le reste à encaisser compte
 * dès la confirmation, comme avant la décision.
 */
export async function receivablesDeliveredOnly(
  executor: Kysely<DB> | Transaction<DB>,
  at: Date,
): Promise<boolean> {
  const value = await currentSettingValue(executor, {
    key: RECEIVABLES_DELIVERED_ONLY_SETTING,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return value === true;
}

export async function customerOutstandingXaf(
  executor: Kysely<DB> | Transaction<DB>,
  keptCustomerId: string,
): Promise<number> {
  // AV-513 : le contrôle du crédit d'une vente directe compte le livré non payé, comme celui d'une livraison.
  if (await receivablesDeliveredOnly(executor, new Date())) {
    return customerCreditExposureXaf(executor, keptCustomerId);
  }
  const accounts = [keptCustomerId, ...(await absorbedCustomerIds(executor, keptCustomerId))];
  const row = await executor
    .selectFrom('sales_sales')
    .select(sql<string>`COALESCE(SUM(balance_due_xaf), 0)`.as('outstanding'))
    .where(
      'customer_id',
      'in',
      accounts.map((id) => toBin(id)),
    )
    .where('status', '<>', 'CANCELLED')
    // Lecture verrouillante : le compte est verrouillé par l'appelant, mais en isolation répétable
    // une lecture simple ne verrait pas la vente à crédit d'une transaction concurrente déjà validée
    // (plafond dépassé sans être détecté, BR-VEN-025).
    .forShare()
    .executeTakeFirst();
  return Number(row?.outstanding ?? 0);
}

const milliOf = (value: string | number): number => Math.round(Number(value) * 1000);

/**
 * Part du montant d'une ligne de vente que représente la quantité livrée (AV-512) : montant × livré ÷
 * quantité, arrondie au franc (demi supérieur) ; au livré complet, exactement le montant de la ligne.
 * Quantités en millièmes d'unité de base. Entiers en `BigInt` : le produit intermédiaire dépasse 2^53 pour
 * une très grosse ligne.
 */
export function deliveredShareXaf(
  lineTotalXaf: number,
  quantityBaseMilli: number,
  deliveredBaseMilli: number,
): number {
  if (lineTotalXaf <= 0 || quantityBaseMilli <= 0 || deliveredBaseMilli <= 0) return 0;
  const base = BigInt(quantityBaseMilli);
  const delivered = BigInt(Math.min(deliveredBaseMilli, quantityBaseMilli));
  return Number((2n * BigInt(lineTotalXaf) * delivered + base) / (2n * base));
}

/**
 * Encours de crédit d'une vente (AV-512) : ce que le client doit pour de la marchandise **déjà remise**. Une
 * vente directe est remise à la vente : son solde dû. Une vente sur commande n'est remise qu'à la livraison :
 * valeur livrée moins ce qui est payé, jamais négative (le payé s'impute d'abord sur le livré) ; le non livré,
 * même impayé, n'est pas un crédit accordé.
 */
export function saleCreditExposureXaf(input: {
  readonly saleType: string;
  readonly balanceDueXaf: number;
  readonly amountPaidXaf: number;
  readonly deliveredValueXaf: number;
}): number {
  if (input.saleType !== 'ORDER') return Math.max(0, input.balanceDueXaf);
  return Math.max(0, Math.min(input.balanceDueXaf, input.deliveredValueXaf - input.amountPaidXaf));
}

/**
 * Encours de crédit d'un client (AV-512, BR-VEN-034) : somme des encours de crédit de ses ventes non annulées
 * (`saleCreditExposureXaf`), comptes absorbés compris (BR-CRM-007) ; l'appelant passe le compte conservé. Il
 * diffère de `customerOutstandingXaf` (le **reste à encaisser**) par le non livré des commandes : une commande
 * qu'on n'a pas livrée n'est pas un crédit. Sert au contrôle du crédit **à la livraison** d'une commande.
 * Lectures verrouillantes, comme `customerOutstandingXaf`, sous le verrou du compte pris par l'appelant : seules
 * les ventes à solde dû peuvent porter un encours, elles sont lues seules. `lock: false` : lecture simple, pour un
 * appelant qui ne décide rien (l'encours servi aux appareils, AV-513).
 */
export async function customerCreditExposureXaf(
  executor: Kysely<DB> | Transaction<DB>,
  keptCustomerId: string,
  options: { readonly lock?: boolean } = {},
): Promise<number> {
  const lock = options.lock !== false;
  const accounts = [keptCustomerId, ...(await absorbedCustomerIds(executor, keptCustomerId))];
  const sales = await executor
    .selectFrom('sales_sales')
    .select(['id', 'sale_type', 'amount_paid_xaf', 'balance_due_xaf'])
    .where(
      'customer_id',
      'in',
      accounts.map((id) => toBin(id)),
    )
    .where('status', '<>', 'CANCELLED')
    .where('balance_due_xaf', '>', 0)
    .$if(lock, (qb) => qb.forShare())
    .execute();
  const orderSaleIds = sales.filter((sale) => sale.sale_type === 'ORDER').map((sale) => sale.id);
  const delivered = new Map<string, number>();
  if (orderSaleIds.length > 0) {
    const lines = await executor
      .selectFrom('sales_sale_lines')
      .select(['sale_id', 'line_total_xaf', 'quantity_base', 'delivered_quantity_base'])
      .where('sale_id', 'in', orderSaleIds)
      .$if(lock, (qb) => qb.forShare())
      .execute();
    for (const line of lines) {
      const saleId = fromBin(line.sale_id);
      delivered.set(
        saleId,
        (delivered.get(saleId) ?? 0) +
          deliveredShareXaf(
            Number(line.line_total_xaf),
            milliOf(line.quantity_base),
            milliOf(line.delivered_quantity_base),
          ),
      );
    }
  }
  return sales.reduce(
    (sum, sale) =>
      sum +
      saleCreditExposureXaf({
        saleType: sale.sale_type,
        balanceDueXaf: Number(sale.balance_due_xaf),
        amountPaidXaf: Number(sale.amount_paid_xaf),
        deliveredValueXaf: delivered.get(fromBin(sale.id)) ?? 0,
      }),
    0,
  );
}

export interface ReceivableLine {
  readonly saleId: string;
  readonly docNumber: string;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly commercialUserId: string | null;
  readonly sellerUserId: string;
  readonly zoneId: string;
  readonly occurredAt: Date;
  /** Échéance `AAAA-MM-JJ` (AV-129). */
  readonly dueDate: string;
  readonly netTotalXaf: number;
  readonly amountPaidXaf: number;
  readonly balanceDueXaf: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  readonly bucket: AgingBucket;
}

/** Jour `AAAA-MM-JJ` décalé de `days` jours (calendrier civil, sans fuseau). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Écart en jours entre deux jours `AAAA-MM-JJ` (`to` moins `from`). */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

/** Vente à solde dû telle que la lisent les créances : colonnes de `sales_sales`, jours `AAAA-MM-JJ`. */
export interface OpenSaleRow {
  readonly id: Buffer;
  readonly sale_type: string;
  readonly amount_paid_xaf: number | string;
  readonly balance_due_xaf: number | string | null;
  readonly occurred_at: Date;
  /** Échéance `AAAA-MM-JJ` ; `null` : vente sans échéance. */
  readonly due: string | null;
  readonly business_day: string | null;
}

/** Solde et échéance d'une créance « livré seulement » (AV-513 (b)). */
export interface DeliveredOnlyReceivable {
  readonly balanceDueXaf: number;
  readonly dueDate: string | null;
}

/**
 * AV-513 (b), Q47 A : créance « livré seulement » de chaque vente à solde dû — le livré non payé d'une vente sur
 * commande (le payé s'impute d'abord sur le livré, `saleCreditExposureXaf`), son échéance gardant le délai accordé à
 * la confirmation mais comptée depuis la première livraison de **cette** vente ; une vente directe garde son solde et
 * son échéance. Une vente qui n'est pas une créance (commande non livrée, ou payée à hauteur de son livré) est absente
 * du résultat, indexé par identifiant de vente. Seule définition du mode, partagée par la liste des créances et par le
 * résumé des tableaux de bord et de l'accueil (`receivablesSummary`) : les deux ne peuvent pas diverger.
 */
export async function deliveredOnlyReceivables(
  executor: Kysely<DB> | Transaction<DB>,
  rows: readonly OpenSaleRow[],
): Promise<Map<string, DeliveredOnlyReceivable>> {
  const orderSaleIds = rows.filter((row) => row.sale_type === 'ORDER').map((row) => row.id);
  const deliveredValue = new Map<string, number>();
  const firstDelivery = new Map<string, string>();
  if (orderSaleIds.length > 0) {
    const lines = await executor
      .selectFrom('sales_sale_lines')
      .select(['sale_id', 'line_total_xaf', 'quantity_base', 'delivered_quantity_base'])
      .where('sale_id', 'in', orderSaleIds)
      .execute();
    for (const line of lines) {
      const saleId = fromBin(line.sale_id);
      deliveredValue.set(
        saleId,
        (deliveredValue.get(saleId) ?? 0) +
          deliveredShareXaf(
            Number(line.line_total_xaf),
            milliOf(line.quantity_base),
            milliOf(line.delivered_quantity_base),
          ),
      );
    }
    // Première livraison de CHAQUE vente, par les lignes de bon de livraison, et non celle de la commande : une
    // commande porte plusieurs ventes quand son reste est confirmé plus tard (ADR-028 §4), et l'échéance d'une vente
    // tardive ne se compte pas depuis la livraison d'une vente plus ancienne.
    const deliveries = await executor
      .selectFrom('sales_delivery_note_lines as dl')
      .innerJoin('sales_delivery_notes as dn', 'dn.id', 'dl.delivery_note_id')
      .innerJoin('sales_sale_lines as sl', 'sl.id', 'dl.sale_line_id')
      .select(['sl.sale_id as sale_id', sql<Date | string>`MIN(dn.occurred_at)`.as('first_at')])
      .where('sl.sale_id', 'in', orderSaleIds)
      .groupBy('sl.sale_id')
      .execute();
    for (const delivery of deliveries) {
      firstDelivery.set(fromBin(delivery.sale_id), businessDayOf(new Date(delivery.first_at)));
    }
  }
  const receivables = new Map<string, DeliveredOnlyReceivable>();
  for (const row of rows) {
    const saleId = fromBin(row.id);
    const balanceDueXaf = saleCreditExposureXaf({
      saleType: row.sale_type,
      balanceDueXaf: Number(row.balance_due_xaf ?? 0),
      amountPaidXaf: Number(row.amount_paid_xaf),
      deliveredValueXaf: deliveredValue.get(saleId) ?? 0,
    });
    // Une commande qu'on n'a pas livrée n'est pas une créance.
    if (balanceDueXaf <= 0) continue;
    let dueDate = row.due;
    const delivered = firstDelivery.get(saleId);
    if (row.sale_type === 'ORDER' && delivered !== undefined && dueDate !== null) {
      // L'échéance garde le délai accordé à la confirmation, compté depuis la première livraison.
      const soldOn = row.business_day ?? businessDayOf(row.occurred_at);
      dueDate = addDays(delivered, Math.max(0, daysBetween(soldOn, dueDate)));
    }
    receivables.set(saleId, { balanceDueXaf, dueDate });
  }
  return receivables;
}

export interface ReceivableFilter {
  /** Jour métier de référence `AAAA-MM-JJ` (Africa/Douala). */
  readonly today: string;
  /**
   * AV-513 : ne compter que le livré non payé d'une commande, échéance depuis la première livraison. Absent : le
   * réglage `sales.receivables_delivered_only` en vigueur (faux par défaut).
   */
  readonly deliveredOnly?: boolean;
  readonly customerIds?: readonly string[];
  readonly siteIds?: readonly string[];
  /** Périmètre d'une liste (sites OU titulaires : commercial attributaire, à défaut vendeur). */
  readonly anyOf?: ListScope;
  readonly commercialUserId?: string;
  /** Seulement les créances échues (échéance antérieure au jour). */
  readonly overdueOnly?: boolean;
  readonly limit?: number;
}

/**
 * BR-FIN-007 : créances par vente — ventes non annulées au solde dû positif, avec leur échéance, leurs
 * jours de retard et leur tranche d'ancienneté (`receivableAging`). La plus ancienne échéance d'abord.
 */
export async function listReceivables(
  executor: Kysely<DB> | Transaction<DB>,
  filter: ReceivableFilter,
): Promise<readonly ReceivableLine[]> {
  if (filter.customerIds?.length === 0 || filter.siteIds?.length === 0) return [];
  const scope = filter.anyOf;
  if (scope && scope.siteIds.length === 0 && scope.ownerUserIds.length === 0) return [];
  const deliveredOnly =
    filter.deliveredOnly ?? (await receivablesDeliveredOnly(executor, new Date()));
  const rows = await executor
    .selectFrom('sales_sales')
    .select([
      'id',
      'doc_number',
      'customer_id',
      'site_id',
      'commercial_user_id',
      'seller_user_id',
      'zone_id',
      'occurred_at',
      'net_total_xaf',
      'amount_paid_xaf',
      'balance_due_xaf',
      'sale_type',
      sql<string>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due'),
      sql<string>`DATE_FORMAT(business_date, '%Y-%m-%d')`.as('business_day'),
    ])
    .where('status', '<>', 'CANCELLED')
    .where('balance_due_xaf', '>', 0)
    .where('due_date', 'is not', null)
    // En mode « livré seulement », l'échéance change après lecture : l'échu et la limite se jugent ensuite.
    .$if(filter.overdueOnly === true && !deliveredOnly, (qb) =>
      qb.where('due_date', '<', sql<Date>`${filter.today}`),
    )
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        'customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(scope !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          ...(scope!.siteIds.length > 0
            ? [
                eb(
                  'site_id',
                  'in',
                  scope!.siteIds.map((id) => toBin(id)),
                ),
              ]
            : []),
          ...(scope!.ownerUserIds.length > 0
            ? [
                eb(
                  eb.fn.coalesce('commercial_user_id', 'seller_user_id'),
                  'in',
                  scope!.ownerUserIds.map((id) => toBin(id)),
                ),
              ]
            : []),
        ]),
      ),
    )
    .orderBy('due_date', 'asc')
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .$if(filter.limit !== undefined && !deliveredOnly, (qb) => qb.limit(filter.limit!))
    .execute();

  // AV-513 (b), Q47 A : solde et échéance « livré seulement » de chaque vente (définition partagée).
  const adjusted = deliveredOnly ? await deliveredOnlyReceivables(executor, rows) : undefined;

  const lines: ReceivableLine[] = [];
  for (const row of rows) {
    let balanceDueXaf = Number(row.balance_due_xaf);
    let dueDate = row.due!;
    if (adjusted !== undefined) {
      const receivable = adjusted.get(fromBin(row.id));
      // Une commande qu'on n'a pas livrée n'est pas une créance.
      if (receivable === undefined) continue;
      balanceDueXaf = receivable.balanceDueXaf;
      dueDate = receivable.dueDate ?? dueDate;
    }
    const aging = receivableAging(dueDate, filter.today);
    if (deliveredOnly && filter.overdueOnly === true && !aging.overdue) continue;
    lines.push({
      saleId: fromBin(row.id),
      docNumber: row.doc_number,
      customerId: fromBinOrNull(row.customer_id),
      siteId: fromBin(row.site_id),
      commercialUserId: fromBinOrNull(row.commercial_user_id),
      sellerUserId: fromBin(row.seller_user_id),
      zoneId: fromBin(row.zone_id),
      occurredAt: row.occurred_at,
      dueDate,
      netTotalXaf: Number(row.net_total_xaf),
      amountPaidXaf: Number(row.amount_paid_xaf),
      balanceDueXaf,
      ...aging,
    });
  }
  if (deliveredOnly) {
    // Même ordre qu'en lecture directe : la plus ancienne échéance d'abord.
    lines.sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        a.saleId.localeCompare(b.saleId),
    );
    return filter.limit !== undefined ? lines.slice(0, filter.limit) : lines;
  }
  return lines;
}

export interface ReceivableAgingSummary {
  readonly totalXaf: number;
  readonly overdueXaf: number;
  readonly count: number;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
}

/** Créances par ancienneté (D09 §6) : total, échu, et montant par tranche. */
export function summarizeReceivables(lines: readonly ReceivableLine[]): ReceivableAgingSummary {
  const buckets: Record<AgingBucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
  let totalXaf = 0;
  let overdueXaf = 0;
  for (const line of lines) {
    totalXaf += line.balanceDueXaf;
    if (line.overdue) {
      overdueXaf += line.balanceDueXaf;
      buckets[line.bucket] += line.balanceDueXaf;
    }
  }
  return { totalXaf, overdueXaf, count: lines.length, buckets };
}
