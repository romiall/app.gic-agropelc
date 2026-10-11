/**
 * ECR-STK-05 « INVENTAIRE » (BR-STK-040 à 043) : logique pure.
 *
 * - Un inventaire porte sur un emplacement (`inventory.count.open`) ; un seul en cours par emplacement.
 * - Chaque ligne donne le produit, et le lot quand le solde en porte, et la quantité comptée à
 *   `counted_at` (`inventory.count.record_lines`, ressaisie = correction).
 * - Sur une tablette partagée, seules les saisies de l'utilisateur sont reprises (ADR-051 §13).
 * - L'appareil estime l'écart (compté − physique connu − opérations en attente) pour aider le
 *   compteur ; le serveur calcule l'écart réel à la soumission (`inventory.count.submit`), puis
 *   comptabilise ou demande une validation (BR-STK-043).
 * - BR-STK-042 : un écart est justifié par un motif `INVENTORY_ADJUSTMENT`. Le serveur ne l'exige pas ;
 *   l'appareil l'exige sur un écart estimé non nul quand des motifs existent (AV-301, paramétrable :
 *   `REQUIRE_VARIANCE_REASON`).
 * - Tout passe hors ligne ; la validation des écarts reste en ligne, hors de cet écran.
 */
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import { MAX_QUANTITY } from '../sales/sale-form.js';
import { physicalLeft, stockKey } from '../sales/stock.js';
import type { InventoryCountData, LocationData } from '../sales/types.js';

/** AV-301 : motif exigé sur un écart estimé non nul (si des motifs `INVENTORY_ADJUSTMENT` existent). */
export const REQUIRE_VARIANCE_REASON = true;
export const MAX_COUNT_COMMENT = 2000;
export const COUNT_TYPES = ['FULL', 'PARTIAL', 'SPOT'] as const;
export type CountType = (typeof COUNT_TYPES)[number];

export const lineKey = (productId: string, lotId: string | null): string =>
  `${productId}:${lotId ?? ''}`;

export interface CountLineView {
  readonly productId: string;
  readonly lotId: string | null;
  readonly countedQtyBase: number;
  readonly varianceReasonCodeId: string | null;
  readonly comment: string | null;
  /** Saisie de l'appareil pas encore retéléchargée. */
  readonly pending: boolean;
  readonly varianceQtyBase: number | null;
}

export interface CountView {
  readonly id: string;
  readonly docNumber: string | null;
  readonly locationId: string;
  readonly countType: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly lines: ReadonlyMap<string, CountLineView>;
  /** Ouverture saisie sur l'appareil, pas encore retéléchargée (dépendance des saisies suivantes). */
  readonly openCommandId: string | null;
  /** Saisies de lignes de l'appareil encore en vol (dépendances de la soumission). */
  readonly lineCommandIds: readonly string[];
  readonly submitting: boolean;
  readonly cancelling: boolean;
  /** Fin ou abandon de l'appareil encore en vol : une nouvelle ouverture sur l'emplacement l'attend. */
  readonly closingCommandId: string | null;
}

interface CountPayload {
  readonly countId?: string;
  readonly locationId?: string;
  readonly countType?: string;
  readonly lines?: readonly {
    readonly productId?: string;
    readonly lotId?: string;
    readonly countedQtyBase?: number;
    readonly varianceReasonCodeId?: string;
    readonly comment?: string;
  }[];
}

/** Inventaires vus par l'appareil : jeu `counts`, complété par les saisies de l'appareil en vol. */
export function deviceCounts(
  projected: readonly InventoryCountData[],
  outbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
): CountView[] {
  const counts = new Map<string, CountView>();
  for (const count of projected) {
    counts.set(count.id, {
      id: count.id,
      docNumber: count.doc_number,
      locationId: count.location_id,
      countType: count.count_type,
      status: count.status,
      occurredAt: count.occurred_at,
      lines: new Map(
        count.lines.map((line) => [
          lineKey(line.product_id, line.lot_id),
          {
            productId: line.product_id,
            lotId: line.lot_id,
            countedQtyBase: Number(line.counted_qty_base),
            varianceReasonCodeId: line.variance_reason_code_id,
            comment: line.comment,
            pending: false,
            varianceQtyBase:
              line.variance_qty_base === null ? null : Number(line.variance_qty_base),
          },
        ]),
      ),
      openCommandId: null,
      lineCommandIds: [],
      submitting: false,
      cancelling: false,
      closingCommandId: null,
    });
  }
  const inFlight = outbox
    .filter(
      (command) =>
        command.command_type.startsWith('inventory.count.') && stillInFlight(command, pulledAt),
    )
    .sort((a, b) => a.device_seq - b.device_seq);
  for (const command of inFlight) {
    const payload = command.payload as CountPayload;
    if (command.command_type === 'inventory.count.open') {
      if (counts.has(command.aggregate_id) || !payload.locationId) continue;
      counts.set(command.aggregate_id, {
        id: command.aggregate_id,
        docNumber: null,
        locationId: payload.locationId,
        countType: payload.countType ?? 'FULL',
        status: 'IN_PROGRESS',
        occurredAt: command.occurred_at,
        lines: new Map(),
        openCommandId: command.command_id,
        lineCommandIds: [],
        submitting: false,
        cancelling: false,
        closingCommandId: null,
      });
      continue;
    }
    const count = counts.get(payload.countId ?? command.aggregate_id);
    if (!count) continue;
    if (command.command_type === 'inventory.count.record_lines') {
      const lines = new Map(count.lines);
      for (const line of payload.lines ?? []) {
        if (!line.productId || line.countedQtyBase === undefined) continue;
        lines.set(lineKey(line.productId, line.lotId ?? null), {
          productId: line.productId,
          lotId: line.lotId ?? null,
          countedQtyBase: line.countedQtyBase,
          varianceReasonCodeId: line.varianceReasonCodeId ?? null,
          comment: line.comment ?? null,
          pending: true,
          varianceQtyBase: null,
        });
      }
      counts.set(count.id, {
        ...count,
        lines,
        lineCommandIds: [...count.lineCommandIds, command.command_id],
      });
    } else if (command.command_type === 'inventory.count.submit') {
      counts.set(count.id, { ...count, submitting: true, closingCommandId: command.command_id });
    } else if (command.command_type === 'inventory.count.cancel') {
      counts.set(count.id, { ...count, cancelling: true, closingCommandId: command.command_id });
    }
  }
  return [...counts.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** Inventaire en cours de saisie sur l'emplacement (ni soumis, ni abandonné), s'il y en a un. */
export function activeCount(
  counts: readonly CountView[],
  locationId: string,
): CountView | undefined {
  return counts.find(
    (count) =>
      count.locationId === locationId &&
      count.status === 'IN_PROGRESS' &&
      !count.submitting &&
      !count.cancelling,
  );
}

export interface CountEntry {
  readonly key: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly productName: string;
  readonly lotCode: string | null;
  readonly unit: string;
  /**
   * Quantité attendue estimée par l'appareil (physique connu, opérations en attente déduites), ou
   * `null` quand l'appareil ne peut pas la répartir entre les lots (opérations en attente sur un
   * produit à plusieurs lots) : pas d'écart estimé, pas de motif exigé.
   */
  readonly expectedQtyBase: number | null;
}

/**
 * Lignes à compter : les produits en stock sur l'emplacement (et les produits ajoutés), une ligne par
 * lot réel du solde (quel que soit le suivi de lot) et une ligne sans lot pour le reste sans lot,
 * chacune comparée à sa propre quantité (le serveur calcule le théorique de la ligne sans lot sur le
 * seul reste sans lot, S-23). Inventaire partiel ou tournant : seulement les produits déjà comptés ou
 * ajoutés. Les lignes déjà comptées restent proposées.
 */
export function countEntries(
  refs: Pick<SalesReferences, 'products' | 'stock' | 'pending'>,
  location: LocationData,
  count: CountView,
  added: readonly string[],
): CountEntry[] {
  const counted = [...count.lines.values()];
  const countedProducts = new Set(counted.map((line) => line.productId));
  const wanted = new Set(added);
  const entries: CountEntry[] = [];
  for (const product of refs.products) {
    const balance = refs.stock.get(stockKey(location.id, product.id));
    const listed =
      count.countType === 'FULL'
        ? balance !== undefined || countedProducts.has(product.id) || wanted.has(product.id)
        : countedProducts.has(product.id) || wanted.has(product.id);
    if (!listed) continue;
    const pending = refs.pending.get(stockKey(location.id, product.id)) ?? 0;
    const lots = (balance?.lots ?? []).filter((lot) => Number(lot.qty_on_hand) !== 0);
    const realLots = lots.filter((lot) => lot.lot_id);
    const entry = (lotId: string | null, lotCode: string | null, expected: number | null) => ({
      key: lineKey(product.id, lotId),
      productId: product.id,
      lotId,
      productName: product.name,
      lotCode,
      unit: product.base_unit_code,
      expectedQtyBase: expected,
    });
    const keys = new Set<string>();
    const push = (value: CountEntry) => {
      if (keys.has(value.key)) return;
      keys.add(value.key);
      entries.push(value);
    };
    if (realLots.length === 0) {
      push(entry(null, null, physicalLeft(balance, pending)));
    } else {
      // Une seule ligne de solde : les opérations en attente s'y imputent ; plusieurs : inconnu.
      const single = lots.length === 1;
      const expectedOf = (qty: string): number | null =>
        pending === 0
          ? Number(qty)
          : single
            ? Math.round((Number(qty) - pending) * 1000) / 1000
            : null;
      for (const lot of lots) {
        push(
          entry(
            lot.lot_id,
            lot.lot_id ? (lot.lot_code ?? lot.lot_id) : null,
            expectedOf(lot.qty_on_hand),
          ),
        );
      }
    }
    // Lignes déjà comptées sur des lots qui ne sont plus au solde.
    for (const line of counted) {
      if (line.productId !== product.id) continue;
      push(entry(line.lotId, line.lotId, pending === 0 ? 0 : null));
    }
  }
  return entries.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName, 'fr') ||
      (a.lotCode ?? '').localeCompare(b.lotCode ?? '', 'fr'),
  );
}

/** Quantité comptée (≥ 0, 3 décimales au plus, borne `numeric(14,3)`) ; `null` si invalide. */
export function parseCounted(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= MAX_QUANTITY ? value : null;
}

/** Écart estimé par l'appareil, arrondi au millième. */
export const estimatedVariance = (counted: number, expected: number): number =>
  Math.round((counted - expected) * 1000) / 1000;

export interface CountInput {
  readonly productId: string;
  readonly lotId: string | null;
  readonly countedQtyBase: number;
  readonly varianceReasonCodeId: string;
  readonly comment: string;
}

/** Charge utile de `inventory.count.record_lines`. */
export function recordLinesPayload(
  countId: string,
  lines: readonly CountInput[],
  countedAt: string,
) {
  return {
    countId,
    lines: lines.map((line) => {
      const comment = line.comment.trim();
      return {
        productId: line.productId,
        ...(line.lotId ? { lotId: line.lotId } : {}),
        countedAt,
        countedQtyBase: line.countedQtyBase,
        ...(line.varianceReasonCodeId ? { varianceReasonCodeId: line.varianceReasonCodeId } : {}),
        ...(comment ? { comment } : {}),
      };
    }),
  };
}
