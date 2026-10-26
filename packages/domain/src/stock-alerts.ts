/**
 * Règles pures des alertes de stock (P9-08 ; D13 §7.1 ; AV-355, AV-356 ; AV-402 à AV-411). Partagées par
 * les détecteurs du module `inventory` (transitions sur mouvement, passes planifiées) et du module `sales`
 * (part « % du CA » de `HIGH_LOSS`), sans entrée-sortie : l'appelant fournit l'état déjà lu.
 *
 * - **Niveaux** : `STOCK_LOW` (disponible sous le minimum) et `STOCK_OUT` (disponible ≤ 0) sont deux
 *   alertes d'état distinctes d'un même couple (emplacement, produit) ; `evaluateStockThreshold`
 *   (BR-STK-051) n'en retient qu'une à la fois. Une transition lève la nouvelle et résout l'ancienne.
 * - **Seuils de paramètres** : chaque paramètre a un repli documenté si la valeur manque ou est
 *   invalide (règle 8 : aucun seuil métier codé en dur hors défaut paramétrable).
 */
import { addBusinessDays } from './business-day.js';
import { businessDaysBetween } from './cash-holding.js';
import { evaluateStockThreshold, type StockThresholdState } from './stock-engine.js';

// --- Niveaux de stock (STOCK_LOW, STOCK_OUT) --------------------------------------------------------

/** Niveau d'alerte de stock : `LOW` = `STOCK_LOW`, `OUT` = `STOCK_OUT`. */
export type StockAlertLevel = 'LOW' | 'OUT';

/** Changement d'un niveau : levée (`breached`) ou fin (`!breached`) de la condition. */
export interface StockLevelChange {
  readonly level: StockAlertLevel;
  readonly breached: boolean;
}

/**
 * État de seuil d'un solde physique (BR-STK-051) : `STOCK_OUT` si disponible ≤ 0, `STOCK_LOW` si
 * disponible < minimum, `OK` sinon. Même évaluation que la lecture des seuils (partagée appareil/serveur).
 */
export function stockThresholdStateOf(input: {
  readonly available: number;
  readonly minQty: number;
}): StockThresholdState {
  return evaluateStockThreshold({
    available: input.available,
    minQty: input.minQty,
    targetQty: input.minQty,
    inTransitIn: 0,
  }).state;
}

/**
 * Événements de transition entre deux états de seuil (AV-355) : les fins de condition d'abord, puis les
 * levées. `OK → LOW` : `{LOW, vrai}` ; `OUT → LOW` : `{OUT, faux}` et `{LOW, vrai}` ; `LOW → OK` :
 * `{LOW, faux}` ; `LOW → OUT` : `{LOW, faux}` et `{OUT, vrai}` ; sans changement d'état : rien (une
 * sortie qui laisse le couple dans le même état n'ajoute aucun événement).
 */
export function stockLevelChanges(
  before: StockThresholdState,
  after: StockThresholdState,
): readonly StockLevelChange[] {
  if (before === after) return [];
  const changes: StockLevelChange[] = [];
  if (before === 'STOCK_LOW') changes.push({ level: 'LOW', breached: false });
  if (before === 'STOCK_OUT') changes.push({ level: 'OUT', breached: false });
  if (after === 'STOCK_LOW') changes.push({ level: 'LOW', breached: true });
  if (after === 'STOCK_OUT') changes.push({ level: 'OUT', breached: true });
  return changes;
}

/** Niveau de l'état de seuil (`null` pour `OK`). */
export function stockLevelOfState(state: StockThresholdState): StockAlertLevel | null {
  return state === 'STOCK_LOW' ? 'LOW' : state === 'STOCK_OUT' ? 'OUT' : null;
}

// --- Réapprovisionnement d'un point de vente (POS_REPLENISH) -----------------------------------------

/**
 * Condition de `POS_REPLENISH` (AV-402) : `BELOW_TARGET` (défaut, D13 §7.1 littéral : la suggestion
 * « cible − disponible − transit entrant » est positive) ou `BELOW_MINIMUM` (la suggestion est positive
 * **et** le point de vente est sous son minimum).
 */
export const POS_REPLENISH_SCOPES = ['BELOW_TARGET', 'BELOW_MINIMUM'] as const;
export type PosReplenishScope = (typeof POS_REPLENISH_SCOPES)[number];
export const DEFAULT_POS_REPLENISH_SCOPE: PosReplenishScope = 'BELOW_TARGET';

export function posReplenishScopeOrDefault(value: unknown): PosReplenishScope {
  return typeof value === 'string' && (POS_REPLENISH_SCOPES as readonly string[]).includes(value)
    ? (value as PosReplenishScope)
    : DEFAULT_POS_REPLENISH_SCOPE;
}

/** Une suggestion de réapprovisionnement est à signaler selon la portée choisie. */
export function needsReplenishment(input: {
  readonly scope: PosReplenishScope;
  readonly state: StockThresholdState;
  readonly suggestedQty: number;
}): boolean {
  if (!(input.suggestedQty > 0)) return false;
  return input.scope === 'BELOW_TARGET' || input.state !== 'OK';
}

// --- Transferts non reçus (TRANSFER_NOT_RECEIVED) ------------------------------------------------------

/** Repli du délai d'un transfert expédié non reçu (D13 §7.1 : « plus de 48 h »). */
export const DEFAULT_TRANSFER_NOT_RECEIVED_HOURS = 48;

/** `inventory.transfer_not_received_hours` : un nombre fini strictement positif, sinon 48 h. */
export function transferNotReceivedHoursOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TRANSFER_NOT_RECEIVED_HOURS;
}

/** Heures entières écoulées depuis `since` (jamais négatives). */
export function elapsedHours(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
}

/** Le transfert expédié à `dispatchedAt` est non reçu au-delà du délai (borne atteinte comprise). */
export function isTransferNotReceived(dispatchedAt: Date, now: Date, hours: number): boolean {
  return (
    now.getTime() - dispatchedAt.getTime() >= transferNotReceivedHoursOrDefault(hours) * 3_600_000
  );
}

// --- Péremption (LOT_EXPIRING) ---------------------------------------------------------------------

/** Repli de l'horizon de péremption (D13 §7.1 : « périmant sous 15 jours »). */
export const DEFAULT_LOT_EXPIRING_DAYS = 15;

/**
 * Plafond de l'horizon (dix ans) : au-delà d'environ 380 000 jours le jour d'horizon n'est plus une date
 * valide et la passe quotidienne échouerait (même classe de défaut que les fenêtres de P9-09).
 */
export const MAX_LOT_EXPIRING_DAYS = 3650;

/** `inventory.lot_expiring_days` : un entier positif ou nul (plafonné), sinon 15. */
export function lotExpiringDaysOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_LOT_EXPIRING_DAYS)
    : DEFAULT_LOT_EXPIRING_DAYS;
}

/** Dernier jour d'échéance signalé : un lot qui périme au plus tard ce jour est « bientôt périmé ». */
export function lotExpiringHorizonDay(today: string, days: number): string {
  return addBusinessDays(today, lotExpiringDaysOrDefault(days));
}

/** Jours restants avant la péremption (négatif : déjà périmé), en jours métier du calendrier. */
export function lotDaysLeft(expiryDay: string, today: string): number {
  return businessDaysBetween(today, expiryDay);
}

// --- Pertes anormales (HIGH_LOSS) ------------------------------------------------------------------

/** Repli du seuil absolu de perte d'un emplacement sur un jour (D13 §7.1 : 50 000 XAF). */
export const DEFAULT_HIGH_LOSS_ALERT_XAF = 50_000;

/** `inventory.high_loss_alert_xaf` : un nombre fini positif ou nul, sinon 50 000 XAF. */
export function highLossAlertXafOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_HIGH_LOSS_ALERT_XAF;
}

/** La perte cumulée du jour atteint le seuil absolu (une perte sans valeur n'alerte jamais). */
export function isHighLossAbsolute(input: {
  readonly valueXaf: number;
  readonly thresholdXaf: number;
}): boolean {
  return input.valueXaf > 0 && input.valueXaf >= highLossAlertXafOrDefault(input.thresholdXaf);
}

/** Repli de la part des ventes du jour (D13 §7.1 : 5 %). */
export const DEFAULT_HIGH_LOSS_SALES_PCT = 5;

/** `sales.high_loss_alert_sales_pct` : un nombre fini strictement positif, sinon 5. */
export function highLossSalesPctOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HIGH_LOSS_SALES_PCT;
}

/** Part de la perte dans le CA net du jour, en %, au dixième (`null` sans vente). */
export function lossSalesSharePct(lossValueXaf: number, salesNetXaf: number): number | null {
  if (!(salesNetXaf > 0)) return null;
  return Math.round((lossValueXaf * 1000) / salesNetXaf) / 10;
}

/**
 * La perte du jour atteint la part des ventes du jour (AV-356, AV-405) : ventes nettes strictement
 * positives (sans vente, la part n'est pas définie : le seuil absolu seul s'applique), perte positive,
 * `perte × 100 ≥ ventes × pourcentage` (borne atteinte comprise).
 */
export function isHighLossSalesShare(input: {
  readonly lossValueXaf: number;
  readonly salesNetXaf: number;
  readonly pct: number;
}): boolean {
  if (!(input.salesNetXaf > 0) || !(input.lossValueXaf > 0)) return false;
  return input.lossValueXaf * 100 >= input.salesNetXaf * highLossSalesPctOrDefault(input.pct);
}
