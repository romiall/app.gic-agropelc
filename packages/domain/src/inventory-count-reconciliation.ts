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
  /**
   * Le lot est ouvert (défaut : oui). Seul un lot ouvert reçoit un gain ou l'excès d'une perte : le serveur ne sort jamais
   * d'un lot clos (BR-STK-050), un gain qui y serait posé ne serait jamais consommé et les sorties suivantes creuseraient
   * le solde sans lot.
   */
  readonly open?: boolean;
}

export interface CountAdjustmentPart {
  /** Lot de l'ajustement ; `null` : sans lot. */
  readonly lotId: string | null;
  /** Quantité de l'ajustement, strictement positive. */
  readonly quantity: number;
  readonly direction: 'GAIN' | 'LOSS';
}

/**
 * BR-STK-045 : l'écart (compté − théorique, signé) d'une ligne qui porte sur tous les lots se répartit en FIFO inverse,
 * comme le serveur prélève une sortie (BR-STK-050 : les lots en stock du plus ancien au plus récent, le sans-lot seulement
 * faute de lot).
 * - Un gain va au lot ouvert le plus récent (rien ne borne un gain) ; sans lot ouvert, au sans-lot.
 * - Une perte prend les lots du plus ancien au plus récent, chacun jusqu'à son solde positif, puis le sans-lot jusqu'à son
 *   solde positif (`lotLessBalance`) ; ce qui dépasse est imputé au lot ouvert le plus récent, comme le manque d'une sortie
 *   (BR-STK-018, traçabilité statistique), à défaut au sans-lot. Un produit dont les lots sont épuisés perd donc sur son
 *   sans-lot, non sur un lot qui passerait en négatif.
 * L'ordre est celui du rang FIFO, puis de l'identifiant (déterministe à rang égal) ; la part du sans-lot vient en dernier.
 */
export function distributeLotLessVariance(
  variance: number,
  lots: readonly CountLotBalance[],
  lotLessBalance = 0,
): readonly CountAdjustmentPart[] {
  const varianceMilli = toMilli(variance);
  if (varianceMilli === 0) return [];
  const direction: CountAdjustmentPart['direction'] = varianceMilli > 0 ? 'GAIN' : 'LOSS';
  const ordered = [...lots].sort(
    (a, b) => a.rankAt.getTime() - b.rankAt.getTime() || (a.lotId < b.lotId ? -1 : 1),
  );
  const receiver = [...ordered].reverse().find((lot) => lot.open !== false);
  if (direction === 'GAIN') {
    return [{ lotId: receiver?.lotId ?? null, quantity: varianceMilli / MILLI, direction }];
  }

  let remaining = -varianceMilli;
  const taken = new Map<string | null, number>();
  for (const lot of ordered) {
    if (remaining <= 0) break;
    const available = toMilli(lot.balance);
    if (available <= 0) continue;
    const part = Math.min(remaining, available);
    taken.set(lot.lotId, part);
    remaining -= part;
  }
  const lotLessAvailable = toMilli(lotLessBalance);
  if (remaining > 0 && lotLessAvailable > 0) {
    const part = Math.min(remaining, lotLessAvailable);
    taken.set(null, part);
    remaining -= part;
  }
  if (remaining > 0) {
    const sink = receiver?.lotId ?? null;
    taken.set(sink, (taken.get(sink) ?? 0) + remaining);
  }
  const parts: CountAdjustmentPart[] = ordered
    .filter((lot) => (taken.get(lot.lotId) ?? 0) > 0)
    .map((lot) => ({ lotId: lot.lotId, quantity: taken.get(lot.lotId)! / MILLI, direction }));
  const lotLessPart = taken.get(null) ?? 0;
  if (lotLessPart > 0) parts.push({ lotId: null, quantity: lotLessPart / MILLI, direction });
  return parts;
}

/** Ce qu'un mouvement tardif a fait au solde d'un lot (ou du sans-lot) de la ligne. */
export interface LateMoveFootprint {
  /** `null` : le sans-lot. */
  readonly lotId: string | null;
  /** Effet signé du mouvement sur le solde de la ligne : positif pour une entrée, négatif pour une sortie. */
  readonly effect: number;
}

/**
 * BR-STK-044, INV-STK-09 : la compensation d'un fait tardif sur une ligne qui porte sur tous les lots rend à chaque lot
 * ce que le fait lui a pris (ou lui a donné en trop), non l'écart entier au premier lot : une vente de 7 qui a pris 4 sur
 * le lot A et 3 sur le lot B est compensée de 4 sur A et de 3 sur B. Les soldes par lot de tout comptage postérieur, que la
 * compensation datée du comptage le plus ancien rétablit aussi, restent ainsi justes lot par lot.
 * `delta` (compté − solde à `counted_at`, signé) est l'écart à rétablir : seuls les lots dont la compensation va dans son
 * sens en reçoivent, chacun dans la limite de ce que le fait lui a fait ; un reliquat (écart plus grand que l'empreinte du
 * fait, d'une autre cause) va au premier lot touché, à défaut au sans-lot.
 */
export function distributeLateMoveCompensation(
  delta: number,
  footprint: readonly LateMoveFootprint[],
): readonly CountAdjustmentPart[] {
  const deltaMilli = toMilli(delta);
  if (deltaMilli === 0) return [];
  const direction: CountAdjustmentPart['direction'] = deltaMilli > 0 ? 'GAIN' : 'LOSS';
  let remaining = Math.abs(deltaMilli);
  const taken = new Map<string | null, number>();
  for (const entry of footprint) {
    if (remaining <= 0) break;
    const compensation = -toMilli(entry.effect);
    if (compensation === 0 || compensation > 0 !== deltaMilli > 0) continue; // sens contraire : pas pour ce lot
    const part = Math.min(remaining, Math.abs(compensation));
    taken.set(entry.lotId, (taken.get(entry.lotId) ?? 0) + part);
    remaining -= part;
  }
  if (remaining > 0) {
    const first = footprint[0]?.lotId ?? null;
    taken.set(first, (taken.get(first) ?? 0) + remaining);
  }
  return [...taken].map(([lotId, milli]) => ({ lotId, quantity: milli / MILLI, direction }));
}

/**
 * BR-STK-044, INV-STK-09 : ce qu'il faut ajouter au registre, daté du comptage, pour que le solde de la portée à
 * `counted_at` redevienne la quantité comptée. Signée : positive = gain, négative = perte ; `0` si le solde est déjà
 * égal au compté (au millième).
 */
export function reconciliationDelta(countedQty: number, balanceAtCountedAt: number): number {
  return (toMilli(countedQty) - toMilli(balanceAtCountedAt)) / MILLI;
}
