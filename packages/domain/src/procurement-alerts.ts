/**
 * Règle pure de l'alerte `RECEIPT_INCOMPLETE` (P9-09 ; BR-APP-015, D13 §7.1 ; AV-360, AV-414). Partagée par
 * la tâche planifiée et par le détecteur « sur réception » du module `procurement`, sans entrée-sortie :
 * l'appelant fournit l'état du bon de commande déjà lu.
 *
 * BR-APP-015 : « bon de commande dont la date prévue est dépassée de plus de 2 jours avec un reliquat, ou
 * réception comportant une quantité rejetée » ; D13 : résolue quand le reliquat est nul ou clôturé. La
 * condition est donc : **un reliquat existe** et (la date prévue est dépassée de plus que le délai, ou une
 * quantité a été rejetée à une réception comptée). Le délai se compte en jours métier depuis la date
 * prévue ; « plus de N jours » est strict (exactement N jours n'alerte pas).
 */
import { businessDaysBetween } from './cash-holding.js';

/** Repli du délai (BR-APP-015 : plus de 2 jours après la date prévue). */
export const DEFAULT_RECEIPT_INCOMPLETE_ALERT_DAYS = 2;

/** `procurement.receipt_incomplete_alert_days` : un entier positif ou nul, sinon 2 (0 : dès le lendemain). */
export function receiptIncompleteAlertDaysOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_RECEIPT_INCOMPLETE_ALERT_DAYS;
}

/** Une ligne de bon de commande avec son rejeté cumulé (réceptions comptées du bon). */
export interface ReceiptIncompleteLine {
  readonly ordered: number;
  readonly accepted: number;
  readonly closed: number;
  readonly cancelled: boolean;
  readonly rejected: number;
  readonly unitCode: string;
}

export type ReceiptIncompleteReason = 'OVERDUE' | 'REJECTED' | 'BOTH';

export interface ReceiptIncompleteState {
  /** Au moins une ligne active a un reliquat (commandé − accepté − clôturé > 0). */
  readonly remaining: boolean;
  /** Nombre de lignes actives avec un reliquat. */
  readonly remainingLines: number;
  /** Jours de retard sur la date prévue (≥ 1) ; `null` sans date prévue ou date non dépassée. */
  readonly daysLate: number | null;
  readonly overdue: boolean;
  readonly hasRejection: boolean;
  /** Quantité rejetée cumulée ; `null` si absente ou de plusieurs unités (une somme n'aurait pas de sens). */
  readonly rejectedQuantity: number | null;
  readonly reason: ReceiptIncompleteReason | null;
  readonly incomplete: boolean;
}

const milli = (value: number): number => Math.round(value * 1000);

/**
 * État d'un bon de commande vis-à-vis de BR-APP-015. Ne lève jamais. `expectedDeliveryDay` et `today`
 * sont des jours métier `AAAA-MM-JJ` ; `thresholdDays` invalide revient au défaut.
 */
export function receiptIncompleteState(input: {
  readonly lines: readonly ReceiptIncompleteLine[];
  readonly expectedDeliveryDay: string | null;
  readonly today: string;
  readonly thresholdDays: number;
}): ReceiptIncompleteState {
  const threshold = receiptIncompleteAlertDaysOrDefault(input.thresholdDays);
  let remainingLines = 0;
  const rejectedUnits = new Set<string>();
  let rejectedMilli = 0;
  for (const line of input.lines) {
    if (!line.cancelled) {
      const left = milli(line.ordered) - milli(line.accepted) - milli(line.closed);
      if (left > 0) remainingLines += 1;
    }
    const rejected = milli(line.rejected);
    if (rejected > 0) {
      rejectedMilli += rejected;
      rejectedUnits.add(line.unitCode);
    }
  }
  const hasRejection = rejectedMilli > 0;
  const lateBy =
    input.expectedDeliveryDay === null
      ? null
      : businessDaysBetween(input.expectedDeliveryDay, input.today);
  const daysLate = lateBy !== null && lateBy >= 1 ? lateBy : null;
  const overdue = daysLate !== null && daysLate > threshold;
  const remaining = remainingLines > 0;
  const incomplete = remaining && (overdue || hasRejection);
  const reason: ReceiptIncompleteReason | null = !incomplete
    ? null
    : overdue && hasRejection
      ? 'BOTH'
      : overdue
        ? 'OVERDUE'
        : 'REJECTED';
  return {
    remaining,
    remainingLines,
    daysLate,
    overdue,
    hasRejection,
    rejectedQuantity: hasRejection && rejectedUnits.size === 1 ? rejectedMilli / 1000 : null,
    reason,
    incomplete,
  };
}
