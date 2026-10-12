/**
 * Sessions de caisse et remises de fonds (ADR-032 ; D05 BR-DIS-005 à 009 ; D09 BR-FIN-013 et 014 ;
 * SM-CASH-SESSION, SM-CASH-TRANSFER ; WF-15 ; AV-153 à 159), partagés appareil et serveur (ADR-021).
 * Pur, sans entrée-sortie : l'appelant fournit les mouvements déjà lus du registre de trésorerie.
 *
 * Principe unique : **un écart n'est compté qu'une fois**. L'attendu se tire du registre par fenêtre
 * de temps ; l'écart d'ouverture appartient à la période précédente ; une réévaluation pose le
 * *delta* ; une remise de fonds n'a pas de second mouvement. Montants en XAF entiers signés
 * (ADR-013) ; un solde de caisse peut être négatif (fait accompli hors ligne, BR-FIN-012).
 */
import { assertSafeInteger, DomainError } from './errors.js';
import { splitSignedXaf, type Xaf } from './money.js';

export const CASH_SESSION_STATUSES = ['OPEN', 'PENDING_VALIDATION', 'VALIDATED'] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

const int = (value: number, label: string): number => {
  assertSafeInteger(value, label);
  return value;
};

// --- Fenêtre d'une session -------------------------------------------------------------------------------

/** Fenêtre `[ouverture, clôture[` ; une session encore ouverte n'a pas de fin. */
export interface CashSessionWindow {
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

/** ADR-032 §2 : un mouvement appartient à la session dont la fenêtre couvre son `occurred_at`. */
export function isInCashSessionWindow(occurredAt: Date, window: CashSessionWindow): boolean {
  const at = occurredAt.getTime();
  return (
    at >= window.openedAt.getTime() && (window.closedAt === null || at < window.closedAt.getTime())
  );
}

/** Deux fenêtres d'un même compte se chevauchent-elles ? (demi-ouvertes ; sans fin = +∞) */
export function cashSessionWindowsOverlap(a: CashSessionWindow, b: CashSessionWindow): boolean {
  const aEnd = a.closedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.closedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.openedAt.getTime() < bEnd && b.openedAt.getTime() < aEnd;
}

// --- Solde attendu et écarts -----------------------------------------------------------------------------

/** Types de mouvements qui ne comptent jamais dans l'attendu : les écarts eux-mêmes et le solde d'ouverture. */
export const CASH_EXPECTED_EXCLUDED_TYPES: readonly string[] = [
  'SESSION_VARIANCE',
  'OPENING_BALANCE',
];

export interface CashMovementAmount {
  readonly direction: 'IN' | 'OUT';
  readonly movementType: string;
  readonly amountXaf: number;
}

/**
 * ADR-032 §3 : attendu = fonds compté à l'ouverture + Σ entrées − Σ sorties des mouvements de la
 * fenêtre, hors `SESSION_VARIANCE` et `OPENING_BALANCE`. Les remises envoyées, remboursements et
 * dépenses sont des sorties ordinaires du registre ; aucun terme n'est énuméré à part (BR-DIS-007).
 */
export function expectedCashXaf(
  openingCountedXaf: number,
  movements: readonly CashMovementAmount[],
): number {
  let total = int(openingCountedXaf, 'openingCountedXaf');
  for (const movement of movements) {
    if (CASH_EXPECTED_EXCLUDED_TYPES.includes(movement.movementType)) continue;
    const amount = int(movement.amountXaf, 'amountXaf');
    if (amount < 0) {
      throw new DomainError('Un montant de mouvement est toujours positif.', 'AMOUNT_INVALID');
    }
    total += movement.direction === 'IN' ? amount : -amount;
  }
  return int(total, 'expectedCashXaf');
}

/** Écart signé = compté − attendu (BR-DIS-007) : négatif = manque. */
export function cashVarianceXaf(countedXaf: number, expectedXaf: number): number {
  return int(int(countedXaf, 'countedXaf') - int(expectedXaf, 'expectedXaf'), 'cashVarianceXaf');
}

/**
 * ADR-032 §4 : écart d'ouverture = fonds compté − solde du compte à l'ouverture (somme du registre
 * ordonnée par `occurred_at`). Il appartient à la période précédente : il s'écrit à l'ouverture et
 * n'entre jamais dans l'attendu de la session ouverte.
 */
export function openingVarianceXaf(countedXaf: number, ledgerBalanceAtOpeningXaf: number): number {
  return cashVarianceXaf(countedXaf, ledgerBalanceAtOpeningXaf);
}

/**
 * ADR-032 §6 : mouvement compensatoire d'une réévaluation = nouvel écart − Σ des `SESSION_VARIANCE`
 * déjà posés (clôture et ajustements). Nul quand rien ne change.
 */
export function reevaluationDeltaXaf(input: {
  readonly countedXaf: number;
  readonly expectedXaf: number;
  readonly postedVarianceXaf: number;
}): number {
  return int(
    cashVarianceXaf(input.countedXaf, input.expectedXaf) -
      int(input.postedVarianceXaf, 'postedVarianceXaf'),
    'reevaluationDeltaXaf',
  );
}

/** Éclate un écart signé en montant positif et sens du mouvement `SESSION_VARIANCE` (INV-GLO-06). */
export function varianceMovement(varianceXaf: number): { amount: Xaf; direction: 'IN' | 'OUT' } {
  return splitSignedXaf(varianceXaf);
}

/**
 * Statut après clôture : un écart nul (ou dans la tolérance paramétrée, 0 par défaut : AV-057, tout
 * écart est validé) est `VALIDATED` d'office ; sinon `PENDING_VALIDATION`.
 */
export function statusAfterClose(varianceXaf: number, toleranceXaf = 0): CashSessionStatus {
  if (!Number.isSafeInteger(toleranceXaf) || toleranceXaf < 0) {
    throw new DomainError(
      'La tolérance d’écart est un entier positif ou nul.',
      'TOLERANCE_INVALID',
    );
  }
  return Math.abs(int(varianceXaf, 'varianceXaf')) <= toleranceXaf
    ? 'VALIDATED'
    : 'PENDING_VALIDATION';
}

/** D13 : alerte `CASH_VARIANCE` de gravité critique à partir du seuil paramétré (10 000 XAF par défaut). */
export function varianceSeverity(varianceXaf: number, criticalXaf: number): 'WARNING' | 'CRITICAL' {
  return Math.abs(int(varianceXaf, 'varianceXaf')) >= criticalXaf ? 'CRITICAL' : 'WARNING';
}

/**
 * ADR-032 §6 : comment traiter une opération tardive tombée dans la fenêtre d'une session.
 * `ABSORBED` : session encore ouverte, l'opération entre naturellement dans l'attendu futur ;
 * `INCLUDED_IN_VALIDATION` : `PENDING_VALIDATION`, l'ajustement est validé avec la session ;
 * `OWN_APPROVAL` : `VALIDATED` (figée), l'ajustement porte sa propre demande de validation.
 */
export type AdjustmentTreatment = 'ABSORBED' | 'INCLUDED_IN_VALIDATION' | 'OWN_APPROVAL';

export function adjustmentTreatment(status: CashSessionStatus): AdjustmentTreatment {
  switch (status) {
    case 'OPEN':
      return 'ABSORBED';
    case 'PENDING_VALIDATION':
      return 'INCLUDED_IN_VALIDATION';
    case 'VALIDATED':
      return 'OWN_APPROVAL';
  }
}

/**
 * AV-155 : le valideur d'un écart n'est ni celui qui a ouvert, ni celui qui a clôturé, ni l'auteur
 * d'une clôture forcée (séparation des tâches, RC-03).
 */
export function isAllowedCashValidator(
  validatorId: string,
  involved: {
    readonly openedBy: string;
    readonly closedBy: string | null;
    readonly forcedBy?: string | null;
  },
): boolean {
  return (
    validatorId !== involved.openedBy &&
    validatorId !== involved.closedBy &&
    validatorId !== (involved.forcedBy ?? null)
  );
}

/** Sous-total des encaissements en espèces d'une session reçus par un vendeur (AV-155, AV-187). */
export interface SellerCashSubtotal {
  readonly userId: string;
  /** Σ signée des encaissements reçus, nette de leurs inverses (annulations d'encaissement). */
  readonly receivedXaf: number;
  readonly paymentsCount: number;
}

/**
 * P5-14 (AV-155, AV-187) : sous-totaux par vendeur des encaissements en espèces de la fenêtre d'une
 * session, pour l'enquête sur un écart. Chaque encaissement (montant signé, net de son inverse) est
 * rapporté à celui qui l'a reçu ; un encaissement dont le vendeur est inconnu reste « non attribué ».
 * Les remboursements, remises et dépenses ne sont pas attribués (listés à part par l'appelant) : ces
 * sous-totaux ne se somment donc pas à l'attendu. Tri : montant décroissant, puis identifiant.
 */
export function sellerCashSubtotals(
  payments: readonly { readonly paymentId: string; readonly signedXaf: number }[],
  receiverOf: (paymentId: string) => string | null,
): { readonly sellers: readonly SellerCashSubtotal[]; readonly unattributedReceivedXaf: number } {
  const bySeller = new Map<string, { receivedXaf: number; paymentsCount: number }>();
  let unattributedReceivedXaf = 0;
  for (const payment of payments) {
    const amount = int(payment.signedXaf, 'signedXaf');
    const seller = receiverOf(payment.paymentId);
    if (seller === null) {
      unattributedReceivedXaf = int(unattributedReceivedXaf + amount, 'unattributedReceivedXaf');
      continue;
    }
    const current = bySeller.get(seller) ?? { receivedXaf: 0, paymentsCount: 0 };
    current.receivedXaf = int(current.receivedXaf + amount, 'receivedXaf');
    current.paymentsCount += 1;
    bySeller.set(seller, current);
  }
  const sellers = [...bySeller.entries()]
    .map(([userId, totals]) => ({ userId, ...totals }))
    .sort((a, b) => b.receivedXaf - a.receivedXaf || a.userId.localeCompare(b.userId));
  return { sellers, unattributedReceivedXaf };
}

// --- Remises de fonds ---------------------------------------------------------------------------------------

export const CASH_TRANSFER_IMPUTATIONS = ['SENDER', 'CARRIER', 'RECEIVER', 'COMPANY'] as const;
export type CashTransferImputation = (typeof CASH_TRANSFER_IMPUTATIONS)[number];

/** Écart d'une remise = reçu − envoyé (AV-153) : négatif = manque, positif = excédent. */
export function transferDiscrepancyXaf(sentXaf: number, receivedXaf: number): number {
  const sent = int(sentXaf, 'sentXaf');
  const received = int(receivedXaf, 'receivedXaf');
  if (sent <= 0 || received < 0) {
    throw new DomainError('Montants de remise invalides.', 'AMOUNT_INVALID');
  }
  return received - sent;
}

/** SM-CASH-TRANSFER : montant reçu égal à l'envoyé → `RECEIVED` ; sinon `DISCREPANCY_PENDING`. */
export function transferStatusAfterReceive(
  sentXaf: number,
  receivedXaf: number,
): 'RECEIVED' | 'DISCREPANCY_PENDING' {
  return transferDiscrepancyXaf(sentXaf, receivedXaf) === 0 ? 'RECEIVED' : 'DISCREPANCY_PENDING';
}

/** Argent en transit d'un ensemble de remises envoyées et pas encore reçues (KPI de trésorerie). */
export function cashInTransitXaf(
  transfers: readonly { readonly status: string; readonly amountSentXaf: number }[],
): number {
  return transfers
    .filter((transfer) => transfer.status === 'SENT')
    .reduce((sum, transfer) => sum + int(transfer.amountSentXaf, 'amountSentXaf'), 0);
}
