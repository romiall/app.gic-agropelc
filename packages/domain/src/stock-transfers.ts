/**
 * Transferts de stock : rapprochement d'une réception sans document et répartition d'une réception
 * sur les mouvements d'expédition (P5-16 ; D06 BR-STK-021, BR-STK-024 ; SM-TRANSFER ; AV-180,
 * AV-182, AV-184). Partagé appareil et serveur (ADR-021), pur, sans entrée-sortie : l'appelant
 * fournit l'état déjà lu (lignes, mouvements, dates). Quantités en **millièmes entiers** (ADR-013),
 * montants en XAF entiers (ADR-016), jamais de calcul en flottant.
 */
import { DomainError } from './errors.js';
import { quantityFromMilli } from './quantity.js';
import { xaf } from './money.js';
import { settlementValueXaf } from './stock-engine.js';

/** Repli documenté du délai de rapprochement (BR-STK-024 « après 48 h ») si le paramètre manque. */
export const DEFAULT_TRANSFER_UNMATCHED_HOURS = 48;

/**
 * `inventory.transfer_unmatched_hours` lu dans les paramètres : un nombre fini strictement positif,
 * sinon le repli de 48 h (paramètre absent à la date demandée, ou valeur invalide).
 */
export function unmatchedHoursOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TRANSFER_UNMATCHED_HOURS;
}

/**
 * Le délai d'une réception sans document non rapprochée est échu (AV-184) : il court depuis
 * l'`occurred_at` de la réception (heure physique, CM §38), borne atteinte comprise.
 */
export function isUnmatchedOverdue(occurredAt: Date, now: Date, hours: number): boolean {
  return now.getTime() - occurredAt.getTime() >= unmatchedHoursOrDefault(hours) * 3_600_000;
}

/**
 * Règle d'éligibilité d'un rapprochement (AV-180, paramètre `inventory.blind_receipt_match_mode`) :
 * `SUBSET` (défaut) — les produits reçus sont des produits expédiés, quantités égales, inférieures
 * (écart à valider) ou supérieures (excédent signalé, BR-STK-021) ; `EXACT` — mêmes produits et
 * mêmes quantités seulement.
 */
export type BlindReceiptMatchMode = 'SUBSET' | 'EXACT';
export const DEFAULT_BLIND_RECEIPT_MATCH_MODE: BlindReceiptMatchMode = 'SUBSET';

export function blindReceiptMatchModeOrDefault(value: unknown): BlindReceiptMatchMode {
  return value === 'EXACT' || value === 'SUBSET' ? value : DEFAULT_BLIND_RECEIPT_MATCH_MODE;
}

/** Une quantité d'un produit (ligne de réception ou ligne expédiée), en millièmes. */
export interface ProductQuantityMilli {
  readonly productId: string;
  readonly quantityMilli: number;
}

/**
 * Nature d'un rapprochement : `EXACT` (mêmes produits, mêmes quantités), `PARTIAL` (sous-ensemble,
 * reçu ≤ expédié pour chaque produit : l'écart devient une perte en transit à valider), `OVER` (au
 * moins un produit reçu au-delà de l'expédié : l'excédent est reçu et signalé, BR-STK-021).
 */
export type BlindReceiptMatchKind = 'EXACT' | 'PARTIAL' | 'OVER';

const MATCH_KIND_RANK: Readonly<Record<BlindReceiptMatchKind, number>> = {
  EXACT: 0,
  PARTIAL: 1,
  OVER: 2,
};

function assertMilli(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      `${label} : millièmes entiers positifs ou nuls attendus.`,
      'QUANTITY_INVALID',
    );
  }
}

/** Cumule les lignes d'un même produit ; une ligne nulle (non expédiée, non reçue) est ignorée. */
function byProduct(lines: readonly ProductQuantityMilli[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    assertMilli(line.quantityMilli, 'Quantité');
    if (line.quantityMilli === 0) continue;
    totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantityMilli);
  }
  return totals;
}

/**
 * Le rapprochement d'une réception sans document (`received`) et d'une expédition (`dispatched`)
 * est-il possible, et de quelle nature ? `null` : non éligible — réception ou expédition vide (une
 * ligne lue dans un instantané périmé ne doit jamais devenir une perte totale), produit reçu qui
 * n'a pas été expédié, ou (mode `EXACT`) toute différence.
 */
export function blindReceiptMatch(
  received: readonly ProductQuantityMilli[],
  dispatched: readonly ProductQuantityMilli[],
  mode: BlindReceiptMatchMode = DEFAULT_BLIND_RECEIPT_MATCH_MODE,
): BlindReceiptMatchKind | null {
  const got = byProduct(received);
  const sent = byProduct(dispatched);
  if (got.size === 0 || sent.size === 0) return null;
  let over = false;
  let short = got.size !== sent.size;
  for (const [productId, quantity] of got) {
    const expected = sent.get(productId);
    if (expected === undefined) return null;
    if (quantity > expected) over = true;
    else if (quantity < expected) short = true;
  }
  if (!over && !short) return 'EXACT';
  if (mode === 'EXACT') return null;
  return over ? 'OVER' : 'PARTIAL';
}

/** Un document candidat au rapprochement : identifiant, date (tri), lignes par produit. */
export interface MatchCandidate {
  readonly id: string;
  readonly at: Date;
  readonly lines: readonly ProductQuantityMilli[];
}

export interface ChosenMatch {
  readonly id: string;
  readonly kind: BlindReceiptMatchKind;
}

function chooseAmong(
  candidates: readonly MatchCandidate[],
  kindOf: (candidate: MatchCandidate) => BlindReceiptMatchKind | null,
): ChosenMatch | null {
  let best: { readonly candidate: MatchCandidate; readonly kind: BlindReceiptMatchKind } | null =
    null;
  for (const candidate of candidates) {
    const kind = kindOf(candidate);
    if (kind === null) continue;
    if (
      best === null ||
      MATCH_KIND_RANK[kind] < MATCH_KIND_RANK[best.kind] ||
      (MATCH_KIND_RANK[kind] === MATCH_KIND_RANK[best.kind] &&
        (candidate.at.getTime() < best.candidate.at.getTime() ||
          (candidate.at.getTime() === best.candidate.at.getTime() &&
            candidate.id < best.candidate.id)))
    ) {
      best = { candidate, kind };
    }
  }
  return best === null ? null : { id: best.candidate.id, kind: best.kind };
}

/**
 * Expédition à rapprocher d'une réception sans document (AV-180) : l'exacte la plus ancienne, sinon
 * la partielle la plus ancienne, sinon celle dont la réception excède l'expédié ; à date égale,
 * l'identifiant départage (ordre stable). Aucune contrainte de date entre expédition et réception
 * (horloges des appareils, ADR-016).
 */
export function chooseDispatchForBlindReceipt(
  received: readonly ProductQuantityMilli[],
  dispatches: readonly MatchCandidate[],
  mode: BlindReceiptMatchMode = DEFAULT_BLIND_RECEIPT_MATCH_MODE,
): ChosenMatch | null {
  return chooseAmong(dispatches, (dispatch) => blindReceiptMatch(received, dispatch.lines, mode));
}

/** Symétrique : réception sans document à rapprocher d'une expédition qui arrive (même ordre). */
export function chooseBlindReceiptForDispatch(
  dispatched: readonly ProductQuantityMilli[],
  receipts: readonly MatchCandidate[],
  mode: BlindReceiptMatchMode = DEFAULT_BLIND_RECEIPT_MATCH_MODE,
): ChosenMatch | null {
  return chooseAmong(receipts, (receipt) => blindReceiptMatch(receipt.lines, dispatched, mode));
}

/** Un mouvement d'expédition d'un produit : lot, quantité et valeur figée (dans l'ordre d'écriture). */
export interface DispatchPiece {
  readonly moveId: string;
  readonly lotId: string | null;
  readonly quantityMilli: number;
  readonly valueXaf: number;
}

/** Une ligne du transfert pour ce produit : expédié, reçu, lot porté par la ligne (repli). */
export interface TransferReceiptLine {
  readonly lineId: string;
  readonly dispatchedMilli: number;
  readonly receivedMilli: number;
  readonly lotId: string | null;
}

/**
 * Un mouvement à écrire : réception (`V_TRANSIT` → destination), écart (`V_TRANSIT` →
 * `V_PENDING_LOSS`) ou excédent reçu au-delà de l'expédié (`V_TRANSIT` → destination, sans
 * mouvement d'expédition en face). `valueXaf` nul : aucune valeur imposée (le registre valorise).
 */
export interface PlannedTransferMove {
  readonly lineId: string;
  readonly kind: 'RECEIPT' | 'DISCREPANCY' | 'EXCESS';
  readonly lotId: string | null;
  readonly quantityMilli: number;
  readonly valueXaf: number | null;
  /** Premier mouvement d'expédition dont cette part provient (absent : excédent ou repli). */
  readonly moveId: string | null;
}

/**
 * Répartit la réception d'un produit sur ses mouvements d'expédition (P5-16 ; AV-182) : chaque ligne
 * prend, dans l'ordre, sa quantité expédiée parmi les mouvements d'expédition ; dans cette part, le
 * reçu d'abord, l'écart ensuite. Chaque part porte le **lot** et la **valeur** de son mouvement
 * d'expédition, au prorata cumulatif (la dernière part d'un mouvement en emporte le reliquat exact,
 * BR-STK-056) : le transit d'un transfert reçu s'annule exactement, en quantité, par lot et en
 * valeur, même pour une expédition multi-lots. Une quantité expédiée sans mouvement en face (donnée
 * incohérente) garde le lot de la ligne, sans valeur imposée ; un reçu au-delà de l'expédié devient
 * un excédent (`EXCESS`, lot du dernier mouvement ou de la ligne), lui aussi sans valeur imposée.
 * Deux parts consécutives d'une même ligne, d'une même nature et d'un même lot (parts d'un quota et du
 * stock commun d'une même expédition, par exemple) sont fusionnées, valeurs additionnées.
 */
export function planTransferReceipt(
  pieces: readonly DispatchPiece[],
  lines: readonly TransferReceiptLine[],
): readonly PlannedTransferMove[] {
  const pool = pieces.map((piece) => {
    assertMilli(piece.quantityMilli, 'Mouvement d’expédition');
    return { piece, left: piece.quantityMilli, settled: 0 };
  });
  const planned: PlannedTransferMove[] = [];
  const push = (move: PlannedTransferMove): void => {
    if (move.quantityMilli <= 0) return;
    const last = planned[planned.length - 1];
    if (
      last !== undefined &&
      last.lineId === move.lineId &&
      last.kind === move.kind &&
      last.lotId === move.lotId &&
      last.valueXaf !== null &&
      move.valueXaf !== null
    ) {
      planned[planned.length - 1] = {
        ...last,
        quantityMilli: last.quantityMilli + move.quantityMilli,
        valueXaf: last.valueXaf + move.valueXaf,
      };
      return;
    }
    planned.push(move);
  };
  let lastLotId: string | null = null;
  let poolIndex = 0;
  for (const line of lines) {
    assertMilli(line.dispatchedMilli, 'Quantité expédiée');
    assertMilli(line.receivedMilli, 'Quantité reçue');
    let toReceive = Math.min(line.receivedMilli, line.dispatchedMilli);
    let need = line.dispatchedMilli;
    while (need > 0) {
      while (poolIndex < pool.length && pool[poolIndex]!.left === 0) poolIndex += 1;
      const slot = pool[poolIndex];
      if (slot === undefined) {
        // Expédié sans mouvement en face : lot de la ligne, valeur laissée au registre.
        const received = Math.min(toReceive, need);
        push({
          lineId: line.lineId,
          kind: 'RECEIPT',
          lotId: line.lotId,
          quantityMilli: received,
          valueXaf: null,
          moveId: null,
        });
        push({
          lineId: line.lineId,
          kind: 'DISCREPANCY',
          lotId: line.lotId,
          quantityMilli: need - received,
          valueXaf: null,
          moveId: null,
        });
        toReceive -= received;
        need = 0;
        break;
      }
      const take = Math.min(need, slot.left);
      const received = Math.min(toReceive, take);
      for (const [kind, quantity] of [
        ['RECEIPT', received],
        ['DISCREPANCY', take - received],
      ] as const) {
        if (quantity === 0) continue;
        // Une valeur d'expédition négative (anomalie) n'est pas répartie : le registre valorise.
        const valueXaf =
          slot.piece.valueXaf < 0
            ? null
            : settlementValueXaf({
                originQuantity: quantityFromMilli(slot.piece.quantityMilli),
                originValueXaf: xaf(slot.piece.valueXaf),
                settledQuantity: quantityFromMilli(slot.settled),
                quantity: quantityFromMilli(quantity),
              });
        slot.settled += quantity;
        push({
          lineId: line.lineId,
          kind,
          lotId: slot.piece.lotId,
          quantityMilli: quantity,
          valueXaf,
          moveId: slot.piece.moveId,
        });
      }
      lastLotId = slot.piece.lotId;
      slot.left -= take;
      toReceive -= received;
      need -= take;
    }
    const excess = line.receivedMilli - Math.min(line.receivedMilli, line.dispatchedMilli);
    push({
      lineId: line.lineId,
      kind: 'EXCESS',
      lotId: lastLotId ?? line.lotId,
      quantityMilli: excess,
      valueXaf: null,
      moveId: null,
    });
  }
  return planned;
}

/** Une ligne d'un transfert expédié, pour la répartition d'une réception déclarée par produit. */
export interface DispatchedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly dispatchedMilli: number;
}

/**
 * Quantité reçue de chaque ligne d'un transfert expédié, à partir d'une réception déclarée par
 * produit (réception sans document rapprochée, AV-180) : les lignes d'un produit se remplissent dans
 * l'ordre jusqu'à leur expédié, la dernière ligne du produit prend l'excédent éventuel ; une ligne
 * dont le produit n'a pas été déclaré reçoit 0 (écart de toute la ligne). Un produit déclaré sans
 * ligne au transfert est ignoré (la règle d'éligibilité l'a déjà exclu).
 */
export function allocateReceivedToLines(
  received: readonly ProductQuantityMilli[],
  lines: readonly DispatchedLine[],
): ReadonlyMap<string, number> {
  const left = byProduct(received);
  const lastLineOf = new Map<string, string>();
  for (const line of lines) {
    assertMilli(line.dispatchedMilli, 'Quantité expédiée');
    lastLineOf.set(line.productId, line.lineId);
  }
  const allocation = new Map<string, number>();
  for (const line of lines) {
    const available = left.get(line.productId) ?? 0;
    const take =
      lastLineOf.get(line.productId) === line.lineId
        ? available
        : Math.min(available, line.dispatchedMilli);
    allocation.set(line.lineId, take);
    left.set(line.productId, available - take);
  }
  return allocation;
}
