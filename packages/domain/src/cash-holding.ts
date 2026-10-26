/**
 * Encaisse élevée ou sans remise (alerte `CASH_HOLDING_HIGH`, D09 §14, P9-07 ; AV-397). Règle pure
 * partagée : la tâche planifiée de `finance` lui fournit le solde projeté, les jours écoulés depuis la
 * référence et les deux seuils déjà lus.
 *
 * - **Montant** : solde strictement supérieur à `finance.cash_holding_max_xaf`.
 * - **Durée** : solde positif et strictement plus de `finance.cash_holding_max_days` jours métier sans
 *   remise (un compte vide n'a rien à remettre : DÉDUIT). Le détecteur compte la durée depuis la plus
 *   récente de la dernière remise et de l'entrée de l'espèce encore détenue (AV-397).
 * - Un seuil **nul désactive** son critère (convention des autres paramètres : 0 = sans limite) ; une
 *   valeur négative, non entière ou illisible revient au défaut (jamais une désactivation silencieuse).
 */
import { businessDayStartUtc } from './business-day.js';

export type CashHoldingReason = 'AMOUNT' | 'DAYS' | 'BOTH';

export const DEFAULT_CASH_HOLDING_MAX_XAF = 200_000;
export const DEFAULT_CASH_HOLDING_MAX_DAYS = 3;

/** Seuil entier ≥ 0 lu d'un paramètre ; une valeur mal formée revient au défaut. */
export function cashHoldingThresholdFrom(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : fallback;
}

/** Nombre de jours métier entiers entre deux jours `AAAA-MM-JJ` (`toDay` − `fromDay`, signé). */
export function businessDaysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (businessDayStartUtc(toDay).getTime() - businessDayStartUtc(fromDay).getTime()) / 86_400_000,
  );
}

/** Une entrée d'espèces d'un compte (mouvement `IN`). */
export interface CashInflow {
  readonly occurredAt: Date;
  readonly amountXaf: number;
}

/**
 * Date d'entrée de l'espèce **encore détenue**, en FIFO : les remises et les sorties consomment les plus
 * anciennes entrées, donc le solde courant est composé des entrées les plus récentes. `inflowsNewestFirst`
 * est parcouru de la plus récente à la plus ancienne jusqu'à couvrir le solde ; la date de l'entrée qui le
 * complète est celle de la plus ancienne espèce détenue. Entrées épuisées sans couvrir le solde (historique
 * tronqué) : la plus ancienne entrée lue ; solde nul ou négatif, ou aucune entrée : `null`.
 */
export function cashHeldSince(
  balanceXaf: number,
  inflowsNewestFirst: readonly CashInflow[],
): Date | null {
  if (balanceXaf <= 0 || inflowsNewestFirst.length === 0) return null;
  let covered = 0;
  for (const inflow of inflowsNewestFirst) {
    covered += inflow.amountXaf;
    if (covered >= balanceXaf) return inflow.occurredAt;
  }
  return inflowsNewestFirst[inflowsNewestFirst.length - 1]!.occurredAt;
}

/** Motif de l'alerte, ou `null` si l'encaisse est dans les limites. */
export function assessCashHolding(input: {
  readonly balanceXaf: number;
  readonly daysWithoutTransfer: number;
  readonly maxXaf: number;
  readonly maxDays: number;
}): CashHoldingReason | null {
  const byAmount = input.maxXaf > 0 && input.balanceXaf > input.maxXaf;
  const byDays =
    input.maxDays > 0 && input.balanceXaf > 0 && input.daysWithoutTransfer > input.maxDays;
  if (byAmount && byDays) return 'BOTH';
  if (byAmount) return 'AMOUNT';
  return byDays ? 'DAYS' : null;
}
