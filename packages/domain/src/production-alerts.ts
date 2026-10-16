/**
 * Règles pures des alertes de production (P9-09 ; D13 §7.1 ; AV-406, AV-121, AV-124 ; AV-461 à AV-463).
 * Partagées par les détecteurs du module `production`, sans entrée-sortie : l'appelant fournit l'état déjà
 * lu. Aucune fonction ne lève : un détecteur « sur fait » s'exécute dans la transaction d'un fait accompli,
 * qu'une donnée de réglage invalide ne doit jamais faire échouer (BR-SYN-007).
 *
 * - **Mortalité anormale** (`HIGH_MORTALITY`) : le cumul des morts du jour métier d'un lot dépasse le seuil
 *   absolu (têtes) **ou** le seuil relatif (pourcentage de l'effectif de référence) ; comparaisons strictes
 *   (D13 : « > 0,5 % de l'effectif ou > 20 têtes »).
 * - **Saisie du jour manquante** (`DAILY_ENTRY_MISSING`) : un lot en cours d'élevage, dont l'effectif est
 *   positif, sans aucune saisie le jour ouvré examiné.
 * - **Coût standard manquant** (`STANDARD_COST_MISSING`) : repli de la fenêtre de revue des entrées.
 */
import { acceptsDailyEntries, type ProductionLotStatus } from './production.js';

// --- Mortalité anormale (HIGH_MORTALITY) -----------------------------------------------------------

/** Repli du seuil relatif (D13 §7.1 : 0,5 % de l'effectif du lot). */
export const DEFAULT_HIGH_MORTALITY_ALERT_PCT = 0.5;
/** Repli du seuil absolu (D13 §7.1 : plus de 20 têtes dans la journée). */
export const DEFAULT_HIGH_MORTALITY_ALERT_HEADS = 20;

/** `production.high_mortality_alert_pct` : un nombre fini positif ou nul, sinon 0,5 (AV-121). */
export function highMortalityAlertPctOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_HIGH_MORTALITY_ALERT_PCT;
}

/** `production.high_mortality_alert_heads` : un nombre fini positif ou nul, sinon 20 (AV-121). */
export function highMortalityAlertHeadsOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_HIGH_MORTALITY_ALERT_HEADS;
}

/**
 * Effectif de référence du taux du jour (AV-461) : l'effectif en élevage **au début du jour métier**
 * (précédent du taux de ponte, AV-116). Un lot mis en place le jour même n'a pas d'effectif en début de
 * journée : l'appelant fournit alors l'effectif de repli (effectif en fin de saisie plus les morts du
 * jour). Sans effectif positif, la référence est 0 : seul le seuil absolu s'applique.
 */
export function mortalityReferenceHeadcount(input: {
  readonly startOfDayHeadcount: number;
  readonly fallbackHeadcount: number;
}): number {
  if (Number.isFinite(input.startOfDayHeadcount) && input.startOfDayHeadcount > 0) {
    return input.startOfDayHeadcount;
  }
  return Number.isFinite(input.fallbackHeadcount) && input.fallbackHeadcount > 0
    ? input.fallbackHeadcount
    : 0;
}

/** Taux du jour en %, à deux décimales (`null` sans effectif de référence positif). */
export function highMortalityRatePct(heads: number, referenceHeadcount: number): number | null {
  if (!(referenceHeadcount > 0) || !Number.isFinite(heads)) return null;
  return Math.round((heads * 10_000) / referenceHeadcount) / 100;
}

export type HighMortalityCause = 'RELATIVE' | 'ABSOLUTE' | 'BOTH';

/**
 * Cause du déclenchement, `null` si aucun seuil n'est dépassé. Comparaisons strictes : 20 morts n'alertent
 * pas, 21 oui ; 5 sur 1 000 (0,5 %) n'alerte pas, 6 sur 1 000 oui. Le seuil relatif est ignoré sans
 * effectif de référence positif. Les seuils invalides reviennent aux défauts.
 */
export function highMortalityCause(input: {
  readonly heads: number;
  readonly referenceHeadcount: number;
  readonly pct: number;
  readonly headsThreshold: number;
}): HighMortalityCause | null {
  if (!(input.heads > 0)) return null;
  const pct = highMortalityAlertPctOrDefault(input.pct);
  const headsThreshold = highMortalityAlertHeadsOrDefault(input.headsThreshold);
  const absolute = input.heads > headsThreshold;
  const relative =
    input.referenceHeadcount > 0 && input.heads * 100 > input.referenceHeadcount * pct;
  if (absolute && relative) return 'BOTH';
  if (relative) return 'RELATIVE';
  return absolute ? 'ABSOLUTE' : null;
}

// --- Saisie du jour manquante (DAILY_ENTRY_MISSING) --------------------------------------------------

/** Jours ISO (1 = lundi … 7 = dimanche) où une saisie est attendue : tous, un élevage ne s'arrête pas. */
export const DEFAULT_DAILY_ENTRY_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * `production.daily_entry_working_days` : liste de numéros ISO de 1 à 7. Une liste vide, absente ou sans
 * aucun numéro valide revient aux sept jours (AV-462).
 */
export function dailyEntryWorkingDaysOrDefault(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return DEFAULT_DAILY_ENTRY_WORKING_DAYS;
  const days = value
    .map((item) => Number(item))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return days.length > 0
    ? [...new Set(days)].sort((a, b) => a - b)
    : DEFAULT_DAILY_ENTRY_WORKING_DAYS;
}

/**
 * Une saisie est attendue d'un lot le jour examiné (AV-462) : lot en cours (`ACTIVE` ou `SELLING`), mis en
 * place **avant** ce jour (le jour de la mise en place compte une entrée de lot, en général aucune saisie),
 * avec des animaux en élevage à la fin du jour (un lot en vente vidé par les ventes n'a plus rien à saisir).
 * `startDay` et `examinedDay` sont des jours métier `AAAA-MM-JJ`.
 */
export function dailyEntryExpected(input: {
  readonly status: ProductionLotStatus;
  readonly startDay: string | null;
  readonly examinedDay: string;
  readonly endOfDayHeadcount: number;
}): boolean {
  if (!acceptsDailyEntries(input.status)) return false;
  if (input.startDay === null || !(input.startDay < input.examinedDay)) return false;
  return input.endOfDayHeadcount > 0;
}

// --- Coût standard manquant (STANDARD_COST_MISSING) ---------------------------------------------------

/** Repli de la fenêtre de revue des entrées de production sans coût standard (AV-463). */
export const DEFAULT_STANDARD_COST_ALERT_LOOKBACK_DAYS = 30;

/** `production.standard_cost_alert_lookback_days` : un entier strictement positif, sinon 30. */
export function standardCostAlertLookbackDaysOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_STANDARD_COST_ALERT_LOOKBACK_DAYS;
}
