/**
 * Calculs partagés de l'inventaire : portée d'une ligne comptée, répartition de l'écart d'une ligne sans lot sur les
 * lots (BR-STK-045) et écart d'un rapprochement tardif (BR-STK-044, INV-STK-09). Pur, sans entrée-sortie : l'appelant
 * fournit les soldes déjà lus. Quantités calculées en millièmes entiers (ADR-013) : en flottant, 0,3 − 0,1 − 0,2 laisse
 * un reliquat qui ferait un faux mouvement.
 */

const MILLI = 1000;
const toMilli = (quantity: number): number => Math.round(quantity * MILLI);

/**
 * Sur quel(s) solde(s) du registre une ligne comptée porte :
 * - `LOT` : un lot désigné ;
 * - `NO_LOT` : le seul solde sans lot ;
 * - `ALL_LOTS` : tous les soldes du produit dans l'emplacement, lots et sans-lot confondus (BR-STK-045 : le
 *   compteur a donné un total sans détailler les lots).
 */
export type CountLineScope = 'LOT' | 'NO_LOT' | 'ALL_LOTS';

/**
 * Portée d'une ligne (BR-STK-040, BR-STK-045). Une ligne sans lot porte sur tous les lots du produit seulement si le
 * produit en a dans l'emplacement et si le même inventaire ne compte aucun lot de ce produit : l'écran « une ligne par
 * lot réel plus une ligne pour le reste sans lot » garde ainsi sa lecture (le reste sans lot est le seul solde sans
 * lot) ; un total donné sans détail se répartit.
 */
export function resolveCountLineScope(input: {
  readonly lotId: string | null;
  /** Une autre ligne du même inventaire compte un lot de ce produit. */
  readonly hasSiblingLotLine: boolean;
  /** Le produit a des soldes par lot dans l'emplacement à l'instant du comptage. */
  readonly productHasLots: boolean;
}): CountLineScope {
  if (input.lotId !== null) return 'LOT';
  return !input.hasSiblingLotLine && input.productHasLots ? 'ALL_LOTS' : 'NO_LOT';
}

export interface CountLotBalance {
  readonly lotId: string;
  /** Solde du lot à l'instant du comptage ; peut être nul ou négatif (fait hors ligne appliqué, BR-STK-018). */
  readonly balance: number;
  /** `fifo_rank_at` du lot : le plus récent a la plus grande valeur. */
  readonly rankAt: Date;
}

export interface CountAdjustmentPart {
  /** Lot de l'ajustement ; `null` : sans lot. */
  readonly lotId: string | null;
  /** Quantité de l'ajustement, strictement positive. */
  readonly quantity: number;
  readonly direction: 'GAIN' | 'LOSS';
}

/**
 * BR-STK-045 : l'écart (compté − théorique, signé) d'une ligne qui porte sur tous les lots se répartit en FIFO inverse.
 * - Un gain va au lot le plus récent (rien ne borne un gain) ; sans lot, au sans-lot.
 * - Une perte prend les lots du plus ancien au plus récent, chacun jusqu'à son solde positif ; ce qui dépasse le total
 *   des lots est imputé au lot le plus récent, comme le manque d'une sortie (BR-STK-018, traçabilité statistique) ;
 *   sans lot, au sans-lot.
 * L'ordre est celui du rang FIFO, puis de l'identifiant (déterministe à rang égal).
 */
export function distributeLotLessVariance(
  variance: number,
  lots: readonly CountLotBalance[],
): readonly CountAdjustmentPart[] {
  const varianceMilli = toMilli(variance);
  if (varianceMilli === 0) return [];
  const direction: CountAdjustmentPart['direction'] = varianceMilli > 0 ? 'GAIN' : 'LOSS';
  const ordered = [...lots].sort(
    (a, b) => a.rankAt.getTime() - b.rankAt.getTime() || (a.lotId < b.lotId ? -1 : 1),
  );
  const newest = ordered[ordered.length - 1];
  if (newest === undefined) {
    return [{ lotId: null, quantity: Math.abs(varianceMilli) / MILLI, direction }];
  }
  if (direction === 'GAIN') {
    return [{ lotId: newest.lotId, quantity: varianceMilli / MILLI, direction }];
  }

  let remaining = -varianceMilli;
  const taken = new Map<string, number>();
  for (const lot of ordered) {
    if (remaining <= 0) break;
    const available = toMilli(lot.balance);
    if (available <= 0) continue;
    const part = Math.min(remaining, available);
    taken.set(lot.lotId, part);
    remaining -= part;
  }
  if (remaining > 0) taken.set(newest.lotId, (taken.get(newest.lotId) ?? 0) + remaining);
  return ordered
    .filter((lot) => (taken.get(lot.lotId) ?? 0) > 0)
    .map((lot) => ({ lotId: lot.lotId, quantity: taken.get(lot.lotId)! / MILLI, direction }));
}

/**
 * BR-STK-044, INV-STK-09 : ce qu'il faut ajouter au registre, daté du comptage, pour que le solde de la portée à
 * `counted_at` redevienne la quantité comptée. Signée : positive = gain, négative = perte ; `0` si le solde est déjà
 * égal au compté (au millième).
 */
export function reconciliationDelta(countedQty: number, balanceAtCountedAt: number): number {
  return (toMilli(countedQty) - toMilli(balanceAtCountedAt)) / MILLI;
}
