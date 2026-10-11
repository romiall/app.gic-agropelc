/**
 * Métriques de distribution d'`inventory` (P5-19 ; D05 BR-DIS-010, KPI-DIS-01 à 05 et 07 ; AV-164,
 * AV-199) : flux d'un emplacement par produit et par période, envoyé par destination, position des
 * quotas. Fonctions **partagées** entre le tableau de distribution (P5-20) et l'accueil (BR-ANA-009) :
 * une seule définition par indicateur. Lecture seule sur le registre (`inventory_stock_moves`) et les
 * soldes ; jamais de valeur stockée (BR-ANA-001).
 *
 * Datation (BR-ANA-002, AV-164 (a)) : chaque mouvement compte à **sa** date (`occurred_at`, jour métier
 * de Douala) — une contre-écriture (retour client, retour à la source, requalification d'une réception
 * sans document) compte à la sienne, jamais en réécrivant la période d'origine.
 *
 * Catégories d'un mouvement vu d'un emplacement L (AV-199) — chaque mouvement qui touche L tombe dans
 * **une seule** catégorie, d'où l'identité de rapprochement, vraie par construction :
 *   solde fin − solde début = reçu + gains d'inventaire + autres entrées − vendu net − perdu
 *                             − pertes en attente − transféré − autres sorties ;
 * - **reçu** : réceptions de transferts (`TRANSFER_RECEIPT` non inverse), moins les requalifications de
 *   réceptions sans document (`TRANSFER_DISPATCH` inverse, P5-16), plus la marchandise d'un écart de
 *   transfert rejeté rendue à la destination (`LOSS_RELEASE` d'un transfert) ;
 * - **transféré** (sorties vers un autre emplacement) : expéditions (`TRANSFER_DISPATCH` non inverse),
 *   moins les retours à la source (`TRANSFER_RECEIPT` inverse, transfert `RETURNED`) ;
 * - **vendu** (`SALE`, dont **vendu à livrer** vers `V_TO_DELIVER`) et **retourné** (`CUSTOMER_RETURN`,
 *   rattaché à sa vente, ADR-029) : vendu net = vendu − retourné ;
 * - **perdu** : pertes reconnues (`LOSS`), écarts d'inventaire négatifs (`INVENTORY_LOSS`) et
 *   confirmations des déclarations de L passées par la validation (`LOSS_CONFIRMATION`, datée de la
 *   décision ; elle part de `V_PENDING_LOSS`, jamais de L, et ne fait que changer la perte de colonne) ;
 * - **pertes en attente** : `LOSS_PENDING` moins leurs libérations (`LOSS_RELEASE` d'une déclaration) et
 *   leurs confirmations — négatives possibles sur une période qui ne contient que la décision ;
 * - **gains d'inventaire** (`INVENTORY_GAIN`) ;
 * - **autres** entrées et sorties : tout le reste (ouverture, achats, consommations, production,
 *   déplacements internes…).
 * Les écarts de transfert (`TRANSFER_DISCREPANCY` de `V_TRANSIT` vers `V_PENDING_LOSS`, puis
 * `LOSS_CONFIRMATION` ou `LOSS_RELEASE`) ne touchent le solde de la destination qu'au rejet (marchandise
 * rendue, comptée dans le reçu) : servis à part, hors identité — constatés (`transitDiscrepancyQty`),
 * confirmés (`transitLostQty`) et rejetés (`transitReleasedQty`) ; le « perdu » affiché d'un PDV n'ajoute
 * que les **confirmés** (AV-164 (a)) ; en attente sur la période = constatés − confirmés − rejetés.
 *
 * Coût : le solde d'ouverture somme le registre de l'emplacement depuis l'origine (même définition que
 * `GET /stock/at`, stratégie stock §3.2) ; les instantanés quotidiens prévus par la stratégie
 * (`stock_balance_snapshots`) l'allégeront si le volume l'exige (NFR-12, P5-20).
 *
 * Quantités en unité de base du produit (`numeric(14,3)`), sommées en décimal par la base puis
 * converties en nombre ; une somme entre produits n'a pas de sens.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  availableOnExclusive,
  availableOnShared,
  businessDayEndUtc,
  businessDayStartUtc,
  type DistributionFlows,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { quantityToMilli } from '../allocation-ledger.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Période en jours métier de Douala, bornes **incluses** (`AAAA-MM-JJ`). */
export interface BusinessPeriod {
  readonly fromDay: string;
  readonly toDay: string;
}

export interface LocationProductFlows {
  readonly locationId: string;
  readonly productId: string;
  /** Solde au début de la période (mouvements antérieurs au premier jour). */
  readonly openingQty: number;
  /** Solde à la fin de la période (mouvements jusqu'au dernier jour inclus). */
  readonly closingQty: number;
  readonly receivedQty: number;
  /** Envoyé vers L (KPI-DIS-01) : expéditions des transferts destinés à L, nettes des retours à la
   * source — marchandise en route, **hors identité** (elle ne touche L qu'à la réception). */
  readonly sentToQty: number;
  readonly soldQty: number;
  readonly soldToDeliverQty: number;
  readonly returnedQty: number;
  readonly soldNetQty: number;
  readonly lostQty: number;
  readonly inventoryLossQty: number;
  /** Part du perdu venue de la validation d'une déclaration de L (`LOSS_CONFIRMATION`, à sa date). */
  readonly lossConfirmedQty: number;
  readonly lostPendingQty: number;
  readonly inventoryGainQty: number;
  readonly transferredOutQty: number;
  readonly otherInQty: number;
  readonly otherOutQty: number;
  /** Écarts de transfert constatés à la réception des transferts destinés à L (hors identité). */
  readonly transitDiscrepancyQty: number;
  /** Écarts de transfert confirmés (approuvés) des transferts destinés à L (hors identité). */
  readonly transitLostQty: number;
  /** Écarts de transfert rejetés : marchandise rendue à L (déjà comptée dans le reçu ; hors identité). */
  readonly transitReleasedQty: number;
}

const qty = (value: unknown): number => Number(value ?? 0);
const milliToQty = (milli: number): number => milli / 1000;

/** Liste SQL d'identifiants binaires. */
const binList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${toBin(id)}`));

/** Types de mouvement rangés dans une catégorie nommée ; les autres vont dans « autres ». */
const CATEGORIZED_TYPES = [
  'TRANSFER_RECEIPT',
  'TRANSFER_DISPATCH',
  'SALE',
  'CUSTOMER_RETURN',
  'LOSS',
  'INVENTORY_LOSS',
  'LOSS_PENDING',
  'LOSS_RELEASE',
  'INVENTORY_GAIN',
] as const;

interface FlowRow {
  readonly loc: Buffer;
  readonly product_id: Buffer;
  readonly opening_qty: string;
  readonly closing_qty: string;
  readonly received_qty: string;
  readonly transferred_out_qty: string;
  readonly sold_qty: string;
  readonly sold_to_deliver_qty: string;
  readonly returned_qty: string;
  readonly loss_qty: string;
  readonly inventory_loss_qty: string;
  readonly lost_pending_qty: string;
  readonly inventory_gain_qty: string;
  readonly other_in_qty: string;
  readonly other_out_qty: string;
}

/**
 * Flux de chaque (emplacement, produit) de `locationIds` sur la période (KPI-DIS-02 à 05). Un tableau
 * vide d'emplacements ne lit rien. Les emplacements attendus sont physiques (un emplacement virtuel
 * n'a pas de sens métier ici).
 */
export async function locationFlows(
  executor: Executor,
  input: {
    readonly locationIds: readonly string[];
    readonly period: BusinessPeriod;
    readonly productIds?: readonly string[];
  },
): Promise<readonly LocationProductFlows[]> {
  if (input.locationIds.length === 0 || input.productIds?.length === 0) return [];
  const start = businessDayStartUtc(input.period.fromDay);
  const end = businessDayEndUtc(input.period.toDay);
  const locations = binList(input.locationIds);
  const productFilter =
    input.productIds === undefined
      ? sql``
      : sql`AND m.product_id IN (${binList(input.productIds)})`;
  const categorized = sql.join(CATEGORIZED_TYPES.map((type) => sql`${type}`));
  // `dir` : +1 pour une entrée dans L, −1 pour une sortie ; `q` toujours positive (registre).
  const { rows } = await sql<FlowRow>`
    SELECT x.loc, x.product_id,
      COALESCE(SUM(CASE WHEN x.occurred_at < ${start} THEN x.dir * x.q END), 0) AS opening_qty,
      COALESCE(SUM(x.dir * x.q), 0) AS closing_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND (
          (x.move_type = 'TRANSFER_RECEIPT' AND x.is_reversal = 0)
          OR (x.move_type = 'TRANSFER_DISPATCH' AND x.is_reversal = 1)
          OR (x.move_type = 'LOSS_RELEASE' AND x.source_doc_type = 'TRANSFER'))
        THEN x.dir * x.q END), 0) AS received_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND (
          (x.move_type = 'TRANSFER_DISPATCH' AND x.is_reversal = 0)
          OR (x.move_type = 'TRANSFER_RECEIPT' AND x.is_reversal = 1))
        THEN -x.dir * x.q END), 0) AS transferred_out_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'SALE'
        THEN -x.dir * x.q END), 0) AS sold_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'SALE' AND x.other_type = 'V_TO_DELIVER'
        THEN -x.dir * x.q END), 0) AS sold_to_deliver_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'CUSTOMER_RETURN'
        THEN x.dir * x.q END), 0) AS returned_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'LOSS'
        THEN -x.dir * x.q END), 0) AS loss_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'INVENTORY_LOSS'
        THEN -x.dir * x.q END), 0) AS inventory_loss_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND (x.move_type = 'LOSS_PENDING'
          OR (x.move_type = 'LOSS_RELEASE' AND x.source_doc_type <> 'TRANSFER'))
        THEN -x.dir * x.q END), 0) AS lost_pending_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type = 'INVENTORY_GAIN'
        THEN x.dir * x.q END), 0) AS inventory_gain_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type NOT IN (${categorized}) AND x.dir = 1
        THEN x.q END), 0) AS other_in_qty,
      COALESCE(SUM(CASE WHEN x.in_period AND x.move_type NOT IN (${categorized}) AND x.dir = -1
        THEN x.q END), 0) AS other_out_qty
    FROM (
      SELECT m.from_location_id AS loc, m.product_id, -1 AS dir, m.quantity AS q, m.move_type,
             m.is_reversal, m.source_doc_type, cp.location_type AS other_type, m.occurred_at,
             (m.occurred_at >= ${start}) AS in_period
        FROM inventory_stock_moves m
        JOIN organization_locations cp ON cp.id = m.to_location_id
       WHERE m.from_location_id IN (${locations}) AND m.occurred_at < ${end} ${productFilter}
      UNION ALL
      SELECT m.to_location_id AS loc, m.product_id, 1 AS dir, m.quantity AS q, m.move_type,
             m.is_reversal, m.source_doc_type, cp.location_type AS other_type, m.occurred_at,
             (m.occurred_at >= ${start}) AS in_period
        FROM inventory_stock_moves m
        JOIN organization_locations cp ON cp.id = m.from_location_id
       WHERE m.to_location_id IN (${locations}) AND m.occurred_at < ${end} ${productFilter}
    ) x
    GROUP BY x.loc, x.product_id
  `.execute(executor);

  const flows = new Map<string, LocationProductFlows>();
  for (const row of rows) {
    const sold = qty(row.sold_qty);
    const returned = qty(row.returned_qty);
    const loss = qty(row.loss_qty);
    const inventoryLoss = qty(row.inventory_loss_qty);
    const flow: LocationProductFlows = {
      locationId: fromBin(row.loc),
      productId: fromBin(row.product_id),
      openingQty: qty(row.opening_qty),
      closingQty: qty(row.closing_qty),
      receivedQty: qty(row.received_qty),
      sentToQty: 0,
      soldQty: sold,
      soldToDeliverQty: qty(row.sold_to_deliver_qty),
      returnedQty: returned,
      soldNetQty: milliToQty(quantityToMilli(sold) - quantityToMilli(returned)),
      lostQty: milliToQty(quantityToMilli(loss) + quantityToMilli(inventoryLoss)),
      inventoryLossQty: inventoryLoss,
      lossConfirmedQty: 0,
      lostPendingQty: qty(row.lost_pending_qty),
      inventoryGainQty: qty(row.inventory_gain_qty),
      transferredOutQty: qty(row.transferred_out_qty),
      otherInQty: qty(row.other_in_qty),
      otherOutQty: qty(row.other_out_qty),
      transitDiscrepancyQty: 0,
      transitLostQty: 0,
      transitReleasedQty: 0,
    };
    flows.set(`${flow.locationId}|${flow.productId}`, flow);
  }

  // Validation d'une déclaration de L (`LOSS_CONFIRMATION`, partie de `V_PENDING_LOSS`) : la perte passe
  // des pertes en attente au perdu, à la date de la décision. Une sortie déplacée d'une colonne à
  // l'autre : l'identité reste vraie. Les écarts de transfert (document `TRANSFER`) restent à part.
  const { rows: confirmations } = await sql<{
    readonly loc: Buffer;
    readonly product_id: Buffer;
    readonly confirmed_qty: string;
  }>`
    SELECT d.location_id AS loc, m.product_id,
      COALESCE(SUM(CASE WHEN m.is_reversal = 1 THEN -m.quantity ELSE m.quantity END), 0)
        AS confirmed_qty
    FROM inventory_stock_moves m
    JOIN inventory_loss_declarations d ON d.id = m.source_doc_id
    WHERE m.source_doc_type = 'LOSS' AND m.move_type = 'LOSS_CONFIRMATION'
      AND d.location_id IN (${locations})
      AND m.occurred_at >= ${start} AND m.occurred_at < ${end} ${productFilter}
    GROUP BY d.location_id, m.product_id
  `.execute(executor);
  for (const row of confirmations) {
    const confirmed = qty(row.confirmed_qty);
    if (confirmed === 0) continue;
    const key = `${fromBin(row.loc)}|${fromBin(row.product_id)}`;
    const flow = flows.get(key) ?? emptyFlow(fromBin(row.loc), fromBin(row.product_id));
    flows.set(key, {
      ...flow,
      lostQty: milliToQty(quantityToMilli(flow.lostQty) + quantityToMilli(confirmed)),
      lossConfirmedQty: confirmed,
      lostPendingQty: milliToQty(quantityToMilli(flow.lostPendingQty) - quantityToMilli(confirmed)),
    });
  }

  // Hors identité : envoyé vers L et écarts de transfert des transferts destinés à L.
  const inbound = await inboundTransferFlows(executor, input, start, end);
  for (const line of inbound) {
    const key = `${line.locationId}|${line.productId}`;
    const flow = flows.get(key) ?? emptyFlow(line.locationId, line.productId);
    flows.set(key, {
      ...flow,
      sentToQty: line.sentToQty,
      transitDiscrepancyQty: line.transitDiscrepancyQty,
      transitLostQty: line.transitLostQty,
      transitReleasedQty: line.transitReleasedQty,
    });
  }
  return [...flows.values()].sort(
    (a, b) => a.locationId.localeCompare(b.locationId) || a.productId.localeCompare(b.productId),
  );
}

/**
 * Flux d'un (emplacement, produit) dans les catégories de l'identité de rapprochement du domaine
 * (`distributionResidual`, AV-199) : les gains d'inventaire rejoignent les autres entrées, les
 * transferts expédiés les autres sorties ; l'envoyé et les écarts de transfert restent dehors.
 */
export function distributionFlowsOf(flow: LocationProductFlows): DistributionFlows {
  const sum = (...values: number[]) =>
    milliToQty(values.reduce((total, value) => total + quantityToMilli(value), 0));
  return {
    openingBalance: flow.openingQty,
    received: flow.receivedQty,
    otherIn: sum(flow.inventoryGainQty, flow.otherInQty),
    soldNet: flow.soldNetQty,
    lost: flow.lostQty,
    lostPending: flow.lostPendingQty,
    otherOut: sum(flow.transferredOutQty, flow.otherOutQty),
    closingBalance: flow.closingQty,
  };
}

function emptyFlow(locationId: string, productId: string): LocationProductFlows {
  return {
    locationId,
    productId,
    openingQty: 0,
    closingQty: 0,
    receivedQty: 0,
    sentToQty: 0,
    soldQty: 0,
    soldToDeliverQty: 0,
    returnedQty: 0,
    soldNetQty: 0,
    lostQty: 0,
    inventoryLossQty: 0,
    lossConfirmedQty: 0,
    lostPendingQty: 0,
    inventoryGainQty: 0,
    transferredOutQty: 0,
    otherInQty: 0,
    otherOutQty: 0,
    transitDiscrepancyQty: 0,
    transitLostQty: 0,
    transitReleasedQty: 0,
  };
}

async function inboundTransferFlows(
  executor: Executor,
  input: {
    readonly locationIds: readonly string[];
    readonly productIds?: readonly string[];
  },
  start: Date,
  end: Date,
): Promise<
  readonly {
    readonly locationId: string;
    readonly productId: string;
    readonly sentToQty: number;
    readonly transitDiscrepancyQty: number;
    readonly transitLostQty: number;
    readonly transitReleasedQty: number;
  }[]
> {
  const productFilter =
    input.productIds === undefined
      ? sql``
      : sql`AND m.product_id IN (${binList(input.productIds)})`;
  const { rows } = await sql<{
    readonly loc: Buffer;
    readonly product_id: Buffer;
    readonly sent_qty: string;
    readonly discrepancy_qty: string;
    readonly lost_qty: string;
    readonly released_qty: string;
  }>`
    SELECT t.to_location_id AS loc, m.product_id,
      COALESCE(SUM(CASE
        WHEN m.move_type = 'TRANSFER_DISPATCH' AND m.is_reversal = 0 THEN m.quantity
        WHEN m.move_type = 'TRANSFER_RECEIPT' AND m.is_reversal = 1 THEN -m.quantity END), 0) AS sent_qty,
      COALESCE(SUM(CASE WHEN m.move_type = 'TRANSFER_DISCREPANCY' THEN m.quantity END), 0)
        AS discrepancy_qty,
      COALESCE(SUM(CASE WHEN m.move_type = 'LOSS_CONFIRMATION' THEN m.quantity END), 0) AS lost_qty,
      COALESCE(SUM(CASE WHEN m.move_type = 'LOSS_RELEASE' THEN m.quantity END), 0) AS released_qty
    FROM inventory_stock_moves m
    JOIN inventory_stock_transfers t ON t.id = m.source_doc_id
    WHERE m.source_doc_type = 'TRANSFER'
      AND t.to_location_id IN (${binList(input.locationIds)})
      AND m.move_type IN ('TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY',
                          'LOSS_CONFIRMATION', 'LOSS_RELEASE')
      AND m.occurred_at >= ${start} AND m.occurred_at < ${end} ${productFilter}
    GROUP BY t.to_location_id, m.product_id
  `.execute(executor);
  return rows.map((row) => ({
    locationId: fromBin(row.loc),
    productId: fromBin(row.product_id),
    sentToQty: qty(row.sent_qty),
    transitDiscrepancyQty: qty(row.discrepancy_qty),
    transitLostQty: qty(row.lost_qty),
    transitReleasedQty: qty(row.released_qty),
  }));
}

export interface SentByDestinationLine {
  readonly sourceLocationId: string;
  readonly destinationLocationId: string;
  readonly productId: string;
  /** Expédié dans la période (`TRANSFER_DISPATCH` non inverses). */
  readonly dispatchedQty: number;
  /** Revenu à la source dans la période (retour à la source d'un transfert `RETURNED`). */
  readonly returnedQty: number;
  /** Envoyé net = expédié − revenu (AV-199 : chacun à sa date, négatif possible). */
  readonly sentNetQty: number;
}

/**
 * Envoyé par destination (KPI-DIS-01 ; plan P5-19) : par (source, destination, produit), sur les
 * transferts expédiés (jamais les réceptions sans document ni les déplacements internes). Au moins un
 * des deux filtres est attendu ; un tableau vide ne lit rien.
 */
export async function sentByDestination(
  executor: Executor,
  input: {
    readonly period: BusinessPeriod;
    readonly sourceLocationIds?: readonly string[];
    readonly destinationLocationIds?: readonly string[];
    readonly productIds?: readonly string[];
  },
): Promise<readonly SentByDestinationLine[]> {
  if (
    input.sourceLocationIds?.length === 0 ||
    input.destinationLocationIds?.length === 0 ||
    input.productIds?.length === 0 ||
    (input.sourceLocationIds === undefined && input.destinationLocationIds === undefined)
  ) {
    return [];
  }
  const start = businessDayStartUtc(input.period.fromDay);
  const end = businessDayEndUtc(input.period.toDay);
  const filters = [
    input.sourceLocationIds !== undefined
      ? sql`AND t.from_location_id IN (${binList(input.sourceLocationIds)})`
      : sql``,
    input.destinationLocationIds !== undefined
      ? sql`AND t.to_location_id IN (${binList(input.destinationLocationIds)})`
      : sql``,
    input.productIds !== undefined
      ? sql`AND m.product_id IN (${binList(input.productIds)})`
      : sql``,
  ];
  const { rows } = await sql<{
    readonly source: Buffer;
    readonly destination: Buffer;
    readonly product_id: Buffer;
    readonly dispatched_qty: string;
    readonly returned_qty: string;
  }>`
    SELECT t.from_location_id AS source, t.to_location_id AS destination, m.product_id,
      COALESCE(SUM(CASE WHEN m.move_type = 'TRANSFER_DISPATCH' THEN m.quantity END), 0)
        AS dispatched_qty,
      COALESCE(SUM(CASE WHEN m.move_type = 'TRANSFER_RECEIPT' THEN m.quantity END), 0)
        AS returned_qty
    FROM inventory_stock_moves m
    JOIN inventory_stock_transfers t ON t.id = m.source_doc_id
    WHERE m.source_doc_type = 'TRANSFER'
      AND ((m.move_type = 'TRANSFER_DISPATCH' AND m.is_reversal = 0)
           OR (m.move_type = 'TRANSFER_RECEIPT' AND m.is_reversal = 1))
      AND m.occurred_at >= ${start} AND m.occurred_at < ${end}
      ${sql.join(filters, sql` `)}
    GROUP BY t.from_location_id, t.to_location_id, m.product_id
    ORDER BY t.from_location_id, t.to_location_id, m.product_id
  `.execute(executor);
  return rows.map((row) => {
    const dispatched = qty(row.dispatched_qty);
    const returned = qty(row.returned_qty);
    return {
      sourceLocationId: fromBin(row.source),
      destinationLocationId: fromBin(row.destination),
      productId: fromBin(row.product_id),
      dispatchedQty: dispatched,
      returnedQty: returned,
      sentNetQty: milliToQty(quantityToMilli(dispatched) - quantityToMilli(returned)),
    };
  });
}

export interface AllocationPosition {
  readonly locationId: string;
  readonly productId: string;
  readonly custodyMode: string | null;
  /** Solde physique (Σ des lots). */
  readonly onHandQty: number;
  readonly reservedQty: number;
  /** Restant alloué : Σ des restes des quotas actifs (échus non libérés et en révocation compris). */
  readonly allocatedQty: number;
  readonly activeAllocations: number;
  /** Quotas actifs dont la validité est passée (le serveur ne libère jamais seul, SM-ALLOCATION). */
  readonly expiredAllocations: number;
  readonly revocationPendingAllocations: number;
  /** Non alloué : max(0, solde − réservé − alloué). */
  readonly unallocatedQty: number;
  /** Σ restes alloués au-delà du solde (`ALLOCATION_OVERCOMMITTED`, INV-STK-19). */
  readonly overcommitted: boolean;
  /** Reste du quota du détenteur demandé (0 sans détenteur ou sans quota). */
  readonly holderRemainingQty: number;
  /** BR-STK-011 : disponible pour le détenteur demandé — partagé : solde − réservé − restes des
   * **autres** détenteurs ; exclusif : solde − réservé. */
  readonly availableToHolderQty: number;
}

/**
 * Restant alloué et non alloué par (emplacement, produit) (plan P5-19 ; ADR-033 ; « disponible net des
 * quotas » de `GET /stock`). `qty_allocated` des soldes reste à zéro (ADR-033 §3) : les quotas se lisent
 * dans `inventory_stock_allocations`. Un tableau vide ne lit rien.
 */
export async function allocationPositions(
  executor: Executor,
  input: {
    readonly locationIds: readonly string[];
    readonly now: Date;
    readonly productIds?: readonly string[];
    readonly holder?: { readonly userId: string; readonly deviceId: string };
  },
): Promise<readonly AllocationPosition[]> {
  if (input.locationIds.length === 0 || input.productIds?.length === 0) return [];
  const locations = input.locationIds.map((id) => toBin(id));
  const products = input.productIds?.map((id) => toBin(id));
  const balances = await executor
    .selectFrom('inventory_stock_balances as b')
    .innerJoin('organization_locations as l', 'l.id', 'b.location_id')
    .select([
      'b.location_id as location_id',
      'b.product_id as product_id',
      'l.custody_mode as custody_mode',
      sql<string>`SUM(b.qty_on_hand)`.as('on_hand'),
      sql<string>`SUM(b.qty_reserved)`.as('reserved'),
    ])
    .where('b.location_id', 'in', locations)
    .$if(products !== undefined, (qb) => qb.where('b.product_id', 'in', products!))
    .groupBy(['b.location_id', 'b.product_id', 'l.custody_mode'])
    .execute();
  const holderUser = input.holder !== undefined ? toBin(input.holder.userId) : null;
  const holderDevice = input.holder !== undefined ? toBin(input.holder.deviceId) : null;
  const quotas = await executor
    .selectFrom('inventory_stock_allocations as a')
    .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
    .select([
      'a.location_id as location_id',
      'a.product_id as product_id',
      'l.custody_mode as custody_mode',
      sql<string>`COUNT(*)`.as('active_count'),
      sql<string>`SUM(a.quantity_remaining)`.as('remaining'),
      sql<string>`SUM(a.valid_until IS NOT NULL AND a.valid_until <= ${input.now})`.as(
        'expired_count',
      ),
      sql<string>`SUM(a.revocation_pending)`.as('revocation_count'),
      sql<string>`COALESCE(SUM(CASE WHEN a.holder_user_id = ${holderUser}
        AND a.holder_device_id = ${holderDevice} THEN a.quantity_remaining END), 0)`.as(
        'holder_remaining',
      ),
    ])
    .where('a.location_id', 'in', locations)
    .where('a.status', '=', 'ACTIVE')
    .$if(products !== undefined, (qb) => qb.where('a.product_id', 'in', products!))
    .groupBy(['a.location_id', 'a.product_id', 'l.custody_mode'])
    .execute();

  interface Acc {
    locationId: string;
    productId: string;
    custodyMode: string | null;
    onHand: number;
    reserved: number;
    allocated: number;
    active: number;
    expired: number;
    revocation: number;
    holder: number;
  }
  const acc = new Map<string, Acc>();
  const entry = (location: Buffer, product: Buffer, custodyMode: string | null): Acc => {
    const key = `${fromBin(location)}|${fromBin(product)}`;
    let value = acc.get(key);
    if (value === undefined) {
      value = {
        locationId: fromBin(location),
        productId: fromBin(product),
        custodyMode,
        onHand: 0,
        reserved: 0,
        allocated: 0,
        active: 0,
        expired: 0,
        revocation: 0,
        holder: 0,
      };
      acc.set(key, value);
    }
    return value;
  };
  for (const row of balances) {
    const value = entry(row.location_id, row.product_id, row.custody_mode);
    value.onHand = quantityToMilli(row.on_hand);
    value.reserved = quantityToMilli(row.reserved);
  }
  for (const row of quotas) {
    const value = entry(row.location_id, row.product_id, row.custody_mode);
    value.allocated = quantityToMilli(row.remaining);
    value.active = Number(row.active_count);
    value.expired = Number(row.expired_count);
    value.revocation = Number(row.revocation_count);
    value.holder = quantityToMilli(row.holder_remaining);
  }
  const positions: AllocationPosition[] = [];
  for (const value of acc.values()) {
    if (value.onHand === 0 && value.reserved === 0 && value.active === 0) continue;
    const exclusive =
      value.custodyMode === 'EXCLUSIVE_USER' || value.custodyMode === 'EXCLUSIVE_DEVICE';
    const available = exclusive
      ? availableOnExclusive(value.onHand, value.reserved)
      : availableOnShared(value.onHand, value.reserved, value.allocated, value.holder);
    positions.push({
      locationId: value.locationId,
      productId: value.productId,
      custodyMode: value.custodyMode,
      onHandQty: milliToQty(value.onHand),
      reservedQty: milliToQty(value.reserved),
      allocatedQty: milliToQty(value.allocated),
      activeAllocations: value.active,
      expiredAllocations: value.expired,
      revocationPendingAllocations: value.revocation,
      unallocatedQty: milliToQty(Math.max(0, value.onHand - value.reserved - value.allocated)),
      overcommitted: value.onHand - value.reserved < value.allocated,
      holderRemainingQty: milliToQty(value.holder),
      availableToHolderQty: milliToQty(available),
    });
  }
  return positions.sort(
    (a, b) => a.locationId.localeCompare(b.locationId) || a.productId.localeCompare(b.productId),
  );
}
