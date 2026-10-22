/**
 * Données d'amorce des essais des vues `analytics_f_*` (P9-13) : des **copies** de lignes réelles de la base
 * d'essai, dans l'état voulu (brouillon, annulée, remisée…), insérées dans la transaction de l'essai et jamais
 * validées. Elles donnent aux contrôles d'exclusion et de date leur dent même quand la base partagée ne
 * contient aucune ligne de cet état — sans reconstruire un monde entier.
 */
import { sql, type Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid } from './helpers.js';

export type Trx = Transaction<DB>;
export type Row = Record<string, unknown>;

const ROLLBACK = Symbol('rollback');

/**
 * Un instantané unique (`REPEATABLE READ`) **toujours annulé** : les copies que les essais y insèrent ne sont
 * jamais validées, la base partagée n'en garde rien, quelle que soit l'issue de l'essai (réussite, échec ou saut).
 */
export async function snapshot<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
  const box: { result?: T; error?: unknown; failed: boolean } = { failed: false };
  try {
    await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        try {
          box.result = await fn(trx);
        } catch (error) {
          box.error = error;
          box.failed = true;
        }
        throw ROLLBACK;
      });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  if (box.failed) throw box.error;
  return box.result as T;
}

const generatedCache = new Map<string, ReadonlySet<string>>();

/** Colonnes calculées par la base : elles ne s'insèrent pas. */
async function generatedColumns(trx: Trx, table: string): Promise<ReadonlySet<string>> {
  const cached = generatedCache.get(table);
  if (cached) return cached;
  const { rows } = await sql<{ name: string }>`
    SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
       AND (EXTRA LIKE 'STORED GENERATED%' OR EXTRA LIKE 'VIRTUAL GENERATED%')
  `.execute(trx);
  const names = new Set(rows.map((row) => row.name));
  generatedCache.set(table, names);
  return names;
}

const asParameter = (value: unknown): unknown =>
  value !== null &&
  typeof value === 'object' &&
  !(value instanceof Buffer) &&
  !(value instanceof Date)
    ? JSON.stringify(value)
    : value;

/** Copie `source` dans `table` avec les surcharges (hors colonnes calculées). */
export async function insertCopy(
  trx: Trx,
  table: string,
  source: Row,
  overrides: Row,
): Promise<void> {
  const generated = await generatedColumns(trx, table);
  const values = Object.entries({ ...source, ...overrides }).filter(
    ([name]) => !generated.has(name),
  );
  await sql`
    INSERT INTO ${sql.table(table)} (${sql.join(values.map(([name]) => sql.ref(name)))})
    VALUES (${sql.join(values.map(([, value]) => asParameter(value)))})
  `.execute(trx);
}

export const atDay = (day: string): Date => new Date(`${day}T09:00:00.000Z`);

export const newId = (): Buffer => Buffer.from(freshUuid().replaceAll('-', ''), 'hex');

export async function firstRow(
  trx: Trx,
  query: ReturnType<typeof sql<Row>>,
): Promise<Row | undefined> {
  return (await query.execute(trx)).rows[0];
}

/** Une copie d'une commande engagée (avec sa première ligne) dans l'état demandé ; `undefined` sans modèle. */
export async function cloneOrder(
  trx: Trx,
  status: 'DRAFT' | 'CANCELLED' | 'CONFIRMED',
  dates: { readonly occurredAt?: string; readonly confirmedAt?: string } = {},
): Promise<string | undefined> {
  const order = await firstRow(
    trx,
    sql`SELECT o.* FROM sales_sales_orders o
         WHERE o.status NOT IN ('DRAFT', 'CANCELLED', 'CLOSED') AND o.closed_at IS NULL
           AND EXISTS (SELECT 1 FROM sales_sales_order_lines l WHERE l.order_id = o.id)
         ORDER BY o.id LIMIT 1`,
  );
  if (!order) return undefined;
  const line = await firstRow(
    trx,
    sql`SELECT * FROM sales_sales_order_lines WHERE order_id = ${order.id} ORDER BY id LIMIT 1`,
  );
  if (!line) return undefined;
  const id = newId();
  await insertCopy(trx, 'sales_sales_orders', order, {
    id,
    doc_number: `AV-${freshUuid()}`,
    command_id: null,
    local_ref: null,
    status,
    ...(dates.occurredAt ? { occurred_at: new Date(dates.occurredAt) } : {}),
    ...(dates.confirmedAt ? { confirmed_at: new Date(dates.confirmedAt) } : {}),
    ...(status === 'CANCELLED'
      ? { cancelled_at: order.occurred_at, cancelled_by: order.created_by }
      : {}),
  });
  await insertCopy(trx, 'sales_sales_order_lines', line, { id: newId(), order_id: id });
  return fromBin(id);
}

export interface ClonedPayment {
  readonly id: string;
  readonly amountXaf: number;
}

/**
 * Une copie d'un encaissement annulé, daté de `occurredDay` et annulé le `cancelledDay` (jours métier
 * `AAAA-MM-JJ`, 10 h 00 heure de Douala), avec le mouvement de trésorerie qu'il exige.
 */
export async function cloneCancelledPayment(
  trx: Trx,
  occurredDay: string,
  cancelledDay: string,
): Promise<ClonedPayment | undefined> {
  const payment = await firstRow(
    trx,
    sql`SELECT * FROM sales_customer_payments WHERE status = 'CANCELLED' AND amount_xaf > 0 ORDER BY id LIMIT 1`,
  );
  if (!payment) return undefined;
  const movement = await firstRow(
    trx,
    sql`SELECT * FROM finance_cash_movements WHERE id = ${payment.cash_movement_id}`,
  );
  if (!movement) return undefined;
  const at = (day: string) => new Date(`${day}T09:00:00.000Z`);
  const movementId = newId();
  await insertCopy(trx, 'finance_cash_movements', movement, {
    id: movementId,
    command_id: null,
    reverses_movement_id: null,
    occurred_at: at(occurredDay),
  });
  const id = newId();
  await insertCopy(trx, 'sales_customer_payments', payment, {
    id,
    doc_number: `AV-${freshUuid()}`,
    cash_movement_id: movementId,
    command_id: null,
    local_ref: null,
    reference_normalized: null,
    external_reference: null,
    duplicate_of_payment_id: null,
    occurred_at: at(occurredDay),
    cancelled_at: at(cancelledDay),
  });
  return { id: fromBin(id), amountXaf: Number(payment.amount_xaf) };
}

/** Une copie d'un prospect, avec le téléphone donné (`''` ou `null` : sans téléphone) ; `undefined` sans modèle. */
export async function cloneProspect(trx: Trx, phone: string | null): Promise<string | undefined> {
  const customer = await firstRow(
    trx,
    sql`SELECT * FROM crm_customers WHERE stage = 'PROSPECT' AND lat IS NOT NULL ORDER BY id LIMIT 1`,
  );
  if (!customer) return undefined;
  const id = newId();
  await insertCopy(trx, 'crm_customers', customer, {
    id,
    command_id: null,
    phone_key: null,
    phone_primary: phone,
    phone_secondary: null,
    // Un doublon suspect n'occupe pas la clé unique du téléphone (colonne calculée).
    duplicate_of_id: customer.id,
    converted_at: null,
    first_sale_id: null,
  });
  return fromBin(id);
}

export interface ClonedCancellation {
  readonly saleId: string;
  readonly lineId: string;
  readonly discountXaf: number;
  readonly amountXaf: number;
  readonly quantityBase: number;
  /** Valeur au coût du retour de stock de la ligne d'annulation (0 : aucun retour). */
  readonly returnedValueXaf: number;
}

/**
 * Une annulation appliquée, ajoutée à une vente existante, d'une ligne remisée (`discount_xaf > 0`), avec, si
 * `withReturn`, le retour de stock `CUSTOMER_RETURN` de la ligne annulée, valorisé à la valeur exacte du
 * mouvement de vente qu'il défait en entier (le dernier retour solde l'origine, INV-STK-17).
 */
export async function cloneDiscountedCancellation(
  trx: Trx,
  appliedDay: string,
  withReturn = false,
): Promise<ClonedCancellation | undefined> {
  const line = await firstRow(
    trx,
    sql`SELECT l.*, s.site_id AS sale_site_id FROM sales_sale_lines l
          JOIN sales_sales s ON s.id = l.sale_id
         WHERE l.discount_xaf > 0 AND l.quantity_base > 0
           AND NOT EXISTS (SELECT 1 FROM sales_sale_cancellation_lines x WHERE x.sale_line_id = l.id)
           AND EXISTS (SELECT 1 FROM inventory_stock_moves m
                        WHERE m.move_type = 'SALE' AND m.source_line_id = l.id AND m.value_xaf >= 2)
         ORDER BY l.id LIMIT 1`,
  );
  if (!line) return undefined;
  const cancellation = await firstRow(
    trx,
    sql`SELECT * FROM sales_sale_cancellations WHERE status = 'APPLIED' AND order_id IS NULL ORDER BY id LIMIT 1`,
  );
  if (!cancellation) return undefined;
  const id = newId();
  const at = new Date(`${appliedDay}T09:00:00.000Z`);
  const amount = Number(line.line_total_xaf);
  await insertCopy(trx, 'sales_sale_cancellations', cancellation, {
    id,
    sale_id: line.sale_id,
    site_id: line.sale_site_id,
    order_id: null,
    doc_number: `AV-${freshUuid()}`,
    command_id: null,
    local_ref: null,
    approval_request_id: null,
    cancelled_total_xaf: amount,
    occurred_at: at,
    applied_at: at,
  });
  const cancellationLineId = newId();
  await insertCopy(
    trx,
    'sales_sale_cancellation_lines',
    { cancellation_id: id, sale_line_id: line.id },
    { id: cancellationLineId, quantity_base: line.quantity_base, amount_xaf: amount },
  );
  let returnedValueXaf = 0;
  if (withReturn) {
    const movement = await firstRow(
      trx,
      sql`SELECT * FROM inventory_stock_moves
           WHERE move_type = 'CUSTOMER_RETURN' AND origin_move_id IS NOT NULL ORDER BY id LIMIT 1`,
    );
    if (!movement) return undefined;
    // Le retour défait un mouvement `SALE` de la ligne (INV-STK-17 : jamais plus que l'origine).
    const origin = await firstRow(
      trx,
      sql`SELECT * FROM inventory_stock_moves
           WHERE move_type = 'SALE' AND source_line_id = ${line.id} AND value_xaf >= 2 ORDER BY id LIMIT 1`,
    );
    if (!origin) return undefined;
    returnedValueXaf = Number(origin.value_xaf);
    await insertCopy(trx, 'inventory_stock_moves', movement, {
      id: newId(),
      command_id: null,
      reverses_move_id: null,
      origin_move_id: origin.id,
      origin_seq: 1,
      from_location_id: origin.to_location_id,
      to_location_id: origin.from_location_id,
      product_id: origin.product_id,
      lot_id: origin.lot_id,
      quantity: origin.quantity,
      unit_cost_xaf: origin.unit_cost_xaf,
      source_doc_type: 'SALE_CANCELLATION',
      source_doc_id: id,
      source_line_id: cancellationLineId,
      value_xaf: returnedValueXaf,
      occurred_at: at,
    });
  }
  return {
    saleId: fromBin(line.sale_id as Buffer),
    lineId: fromBin(line.id as Buffer),
    discountXaf: Number(line.discount_xaf),
    amountXaf: amount,
    quantityBase: Number(line.quantity_base),
    returnedValueXaf,
  };
}

export interface ReassignedConversion {
  readonly customerId: string;
  /** Titulaire à l'instant de la conversion, d'après l'historique reconstitué. */
  readonly holderAtConversion: string;
}

/**
 * Un compte converti dont le titulaire change : `BEFORE`, avant la conversion (le titulaire de la conversion
 * est le nouveau, dont la période commence après la création du compte) ; `AFTER`, après (le titulaire de la
 * conversion est l'ancien, dont la période est close depuis). Prend un compte à titulaire unique et ouvert.
 */
export async function reassignConvertedCustomer(
  trx: Trx,
  mode: 'BEFORE' | 'AFTER',
  excluded: readonly string[] = [],
): Promise<ReassignedConversion | undefined> {
  const exclusion =
    excluded.length === 0
      ? sql``
      : sql`AND c.id NOT IN (${sql.join(excluded.map((id) => Buffer.from(id.replaceAll('-', ''), 'hex')))})`;
  const found = await firstRow(
    trx,
    sql`SELECT a.id AS assignment_id, a.user_id, a.valid_from, c.id AS customer_id, c.converted_at
          FROM crm_customers c
          JOIN crm_customer_assignments a ON a.customer_id = c.id
         WHERE c.converted_at IS NOT NULL AND a.valid_to IS NULL AND a.valid_from < c.converted_at
           AND TIMESTAMPDIFF(MINUTE, a.valid_from, c.converted_at) > 120 ${exclusion}
           AND (SELECT COUNT(*) FROM crm_customer_assignments x WHERE x.customer_id = c.id) = 1
         ORDER BY c.id LIMIT 1`,
  );
  if (!found) return undefined;
  const other = await firstRow(
    trx,
    sql`SELECT id FROM identity_users WHERE id <> ${found.user_id} ORDER BY id LIMIT 1`,
  );
  if (!other) return undefined;
  const from = (found.valid_from as Date).getTime();
  const converted = (found.converted_at as Date).getTime();
  const switchAt = new Date(
    mode === 'BEFORE' ? from + (converted - from) / 2 : converted + 3_600_000,
  );
  await sql`UPDATE crm_customer_assignments SET valid_to = ${switchAt} WHERE id = ${found.assignment_id}`.execute(
    trx,
  );
  const previous = await firstRow(
    trx,
    sql`SELECT * FROM crm_customer_assignments WHERE id = ${found.assignment_id}`,
  );
  await insertCopy(trx, 'crm_customer_assignments', previous!, {
    id: newId(),
    user_id: other.id,
    valid_from: switchAt,
    valid_to: null,
    command_id: null,
  });
  return {
    customerId: fromBin(found.customer_id as Buffer),
    holderAtConversion: fromBin((mode === 'BEFORE' ? other.id : found.user_id) as Buffer),
  };
}

/**
 * Une copie d'une session de travail terminée, commencée à l'instant UTC donné (ISO 8601), avec le statut de
 * dérogation demandé (une session à dérogation porte sa raison).
 */
export async function cloneWorkSession(
  trx: Trx,
  startedAtUtc: string,
  overrideStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' = 'NOT_REQUIRED',
): Promise<string | undefined> {
  const session = await firstRow(
    trx,
    sql`SELECT * FROM fieldwork_work_sessions
         WHERE status = 'CLOSED' AND override_status = 'NOT_REQUIRED' AND ended_at IS NOT NULL ORDER BY id LIMIT 1`,
  );
  if (!session) return undefined;
  const id = newId();
  const startedAt = new Date(startedAtUtc);
  await insertCopy(trx, 'fieldwork_work_sessions', session, {
    id,
    command_id: null,
    started_at: startedAt,
    ended_at: new Date(startedAt.getTime() + 30 * 60_000),
    override_status: overrideStatus,
    override_reason: overrideStatus === 'NOT_REQUIRED' ? null : 'copie d’essai',
  });
  return fromBin(id);
}

export interface MergedConversion {
  readonly keptId: string;
  readonly mergedId: string;
}

/**
 * Une fusion de comptes dont les deux comptes portent la même conversion : le compte absorbé (`MERGED`) garde
 * son `converted_at` alors que le compte conservé le porte aussi (reprise de la conversion par la fusion).
 * Le compte conservé est un compte converti existant ; l'absorbé en est une copie fusionnée.
 */
export async function cloneMergedConvertedCustomer(
  trx: Trx,
): Promise<MergedConversion | undefined> {
  const kept = await firstRow(
    trx,
    sql`SELECT * FROM crm_customers WHERE stage = 'CUSTOMER' AND converted_at IS NOT NULL ORDER BY id LIMIT 1`,
  );
  if (!kept) return undefined;
  const id = newId();
  await insertCopy(trx, 'crm_customers', kept, {
    id,
    command_id: null,
    phone_key: null,
    stage: 'MERGED',
    merged_into_id: kept.id,
  });
  return { keptId: fromBin(kept.id as Buffer), mergedId: fromBin(id) };
}
