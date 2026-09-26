/**
 * Calculs partagés du registre de stock (D06-STK ; docs/02-domain-model/03-strategie-stock.md),
 * partagés appareil et serveur (ADR-021) : disponibilité, sélection FIFO/FEFO des lots à une
 * sortie, recalcul du CMUP (AV-042, ADR-015). Pur, sans entrée-sortie — aucune lecture de
 * base : l'appelant fournit l'état déjà lu (soldes, lots).
 */
import { DomainError, assertSafeInteger } from './errors.js';

/** §3.3 : disponible sur un emplacement à garde exclusive (`EXCLUSIVE_USER`/`EXCLUSIVE_DEVICE`). */
export function availableOnExclusive(qtyOnHand: number, qtyReserved: number): number {
  return qtyOnHand - qtyReserved;
}

/** §3.3 : disponible pour un consommateur C sur un emplacement `SHARED`. */
export function availableOnShared(
  qtyOnHand: number,
  qtyReserved: number,
  qtyAllocated: number,
  ownRemaining: number,
): number {
  return qtyOnHand - qtyReserved - (qtyAllocated - ownRemaining);
}

export interface LotBalance {
  readonly lotId: string;
  /** Solde positif disponible dans cet emplacement pour ce lot. */
  readonly qtyAvailable: number;
  /** Date de référence FIFO (`fifo_rank_at`), ou péremption pour FEFO. */
  readonly rankAt: Date;
}

export interface LotAllocation {
  readonly lotId: string;
  readonly quantity: number;
}

export interface LotSelectionResult {
  readonly allocations: readonly LotAllocation[];
  /** > 0 si les lots en solde positif ne couvrent pas la quantité demandée (BR-STK-018). */
  readonly shortfall: number;
}

/**
 * BR-STK-050, D06 §7 : sortie sans lot désigné → consommation FIFO (rang croissant) des lots
 * en solde positif de l'emplacement. `lots` triés par l'appelant selon FIFO (`rankAt` =
 * `fifo_rank_at`) ou FEFO (`rankAt` = `expiry_date`) — cette fonction ne trie pas elle-même
 * (l'ordre voulu dépend du contexte, D06 §7 « FEFO pour les intrants périssables »).
 */
export function selectLotsFifo(
  lots: readonly LotBalance[],
  requestedQty: number,
): LotSelectionResult {
  if (requestedQty <= 0) {
    throw new DomainError('La quantité demandée doit être positive.', 'QUANTITY_INVALID');
  }
  const allocations: LotAllocation[] = [];
  let remaining = requestedQty;
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.qtyAvailable <= 0) continue;
    const consumed = Math.min(remaining, lot.qtyAvailable);
    allocations.push({ lotId: lot.lotId, quantity: consumed });
    remaining -= consumed;
  }
  return { allocations, shortfall: Math.max(remaining, 0) };
}

/**
 * AV-042, stratégie stock §9 : `nouveau_cmup = (qté_avant × cmup_avant + qté_entrée ×
 * coût_entrée) / (qté_avant + qté_entrée)`. Si la quantité de référence est ≤ 0 au moment de
 * l'entrée, le CMUP prend le coût d'entrée. Résultat arrondi à 2 décimales (précision interne
 * de `product_valuations.avg_unit_cost_xaf`, `DECIMAL(14,2)`).
 */
export function recalculateCmup(
  qtyBasisBefore: number,
  cmupBefore: number,
  qtyEntry: number,
  costEntryXaf: number,
): number {
  if (qtyEntry <= 0) {
    throw new DomainError("La quantité d'entrée doit être positive.", 'QUANTITY_INVALID');
  }
  const nextQtyBasis = qtyBasisBefore + qtyEntry;
  const cmup =
    qtyBasisBefore <= 0
      ? costEntryXaf
      : (qtyBasisBefore * cmupBefore + qtyEntry * costEntryXaf) / nextQtyBasis;
  return Math.round(cmup * 100) / 100;
}

/** Arrondit un CMUP (2 décimales) au franc entier le plus proche, demi supérieur (ADR-013). */
export function roundCmupToXaf(cmup: number): number {
  const rounded = Math.floor(cmup + 0.5);
  assertSafeInteger(rounded, 'roundCmupToXaf');
  return rounded;
}
