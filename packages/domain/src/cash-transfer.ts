/**
 * Remises de fonds : règles pures partagées par l'appareil et le serveur (P5-15 ; ADR-021, ADR-032
 * §7 et §8 ; SM-CASH-TRANSFER ; D05 BR-DIS-009, D09 BR-FIN-013 ; AV-153, AV-158, AV-172 à AV-176).
 * Sans entrée-sortie : l'appelant fournit l'état de la remise, les comptes et les paramètres déjà
 * lus. Les montants, l'écart et l'état après réception restent dans `cash-session.ts`
 * (`transferDiscrepancyXaf`, `transferStatusAfterReceive`, `cashInTransitXaf`).
 *
 * - **Paires de comptes** (AV-158, À VALIDER) : paramètre `finance.cash_transfer_allowed_pairs`
 *   (objet « type source → types destinataires »), repli sur {@link DEFAULT_CASH_TRANSFER_PAIRS}
 *   quand la valeur est absente ou mal formée.
 * - **Séparation des tâches** (AV-158, AV-172, AV-174, RC-03) : le récepteur n'est pas l'expéditeur ;
 *   le valideur d'un écart n'est ni l'expéditeur, ni le récepteur, ni le porteur.
 * - **Transitions et courses hors ligne** (ADR-032 §8, BR-SYN-007, AV-173) : une seule table,
 *   {@link decideCashTransferAction}, dit si une réception ou une annulation s'applique, est sans
 *   effet, est conservée comme observation (hors ligne) ou est refusée (en ligne).
 */
import { CASH_TRANSFER_IMPUTATIONS, type CashTransferImputation } from './cash-session.js';
import { DomainError } from './errors.js';

/** États d'une remise (SM-CASH-TRANSFER). */
export const CASH_TRANSFER_STATUSES = [
  'SENT',
  'RECEIVED',
  'DISCREPANCY_PENDING',
  'CLOSED',
  'CANCELLED',
] as const;
export type CashTransferStatus = (typeof CASH_TRANSFER_STATUSES)[number];

/** Types de comptes de trésorerie (BR-FIN-010), tels que les connaît la règle des paires. */
export const CASH_TRANSFER_ACCOUNT_TYPES = [
  'CAISSE_PDV',
  'CAISSE_UTILISATEUR',
  'CAISSE_CENTRALE',
  'MOBILE_MONEY',
  'BANQUE',
] as const;
export type CashTransferAccountType = (typeof CASH_TRANSFER_ACCOUNT_TYPES)[number];

/** Paires admises : type du compte source → types des comptes destinataires. */
export type CashTransferPairs = Readonly<Record<string, readonly string[]>>;

/**
 * Défaut d'AV-158 (a), complété (À VALIDER, fiche AV-158) : les caisses de PDV et d'utilisateur
 * remettent à la caisse centrale ou à la banque ; la caisse centrale alimente le fonds d'un PDV et
 * remet à la banque (glossaire « PDV → caisse centrale → banque ») ; la banque alimente la caisse
 * centrale (retrait) ; le mobile money se vide vers la caisse centrale ou la banque. Aucune remise
 * vers une caisse d'utilisateur ni vers le mobile money.
 */
export const DEFAULT_CASH_TRANSFER_PAIRS: CashTransferPairs = {
  CAISSE_PDV: ['CAISSE_CENTRALE', 'BANQUE'],
  CAISSE_UTILISATEUR: ['CAISSE_CENTRALE', 'BANQUE'],
  CAISSE_CENTRALE: ['CAISSE_PDV', 'BANQUE'],
  BANQUE: ['CAISSE_CENTRALE'],
  MOBILE_MONEY: ['CAISSE_CENTRALE', 'BANQUE'],
};

const isAccountType = (value: unknown): value is CashTransferAccountType =>
  typeof value === 'string' && (CASH_TRANSFER_ACCOUNT_TYPES as readonly string[]).includes(value);

/**
 * Paires lues du paramètre `finance.cash_transfer_allowed_pairs` : un objet dont chaque clé est un
 * type de compte et chaque valeur une liste de types. Toute autre forme (absent, tableau, type
 * inconnu, valeur non textuelle) revient au défaut : une valeur mal saisie ne bloque pas les remises.
 */
export function cashTransferPairsFrom(value: unknown): CashTransferPairs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_CASH_TRANSFER_PAIRS;
  }
  const pairs: Record<string, readonly string[]> = {};
  for (const [from, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!isAccountType(from) || !Array.isArray(targets) || !targets.every(isAccountType)) {
      return DEFAULT_CASH_TRANSFER_PAIRS;
    }
    pairs[from] = [...targets];
  }
  return pairs;
}

/** La remise d'un compte `fromType` vers un compte `toType` est-elle admise ? */
export function isCashTransferPairAllowed(
  fromType: string,
  toType: string,
  pairs: CashTransferPairs = DEFAULT_CASH_TRANSFER_PAIRS,
): boolean {
  return pairs[fromType]?.includes(toType) ?? false;
}

/** AV-158, AV-172 : le récepteur d'une remise n'en est jamais l'expéditeur (le porteur peut l'être). */
export function isAllowedTransferReceiver(receiverId: string, sentBy: string): boolean {
  return receiverId !== sentBy;
}

/**
 * AV-174 (RC-03) : le valideur d'un écart de remise n'est ni l'expéditeur, ni le récepteur, ni le
 * porteur connu.
 */
export function isAllowedTransferValidator(
  validatorId: string,
  involved: {
    readonly sentBy: string;
    readonly receivedBy: string | null;
    readonly carrierUserId: string | null;
  },
): boolean {
  return (
    validatorId !== involved.sentBy &&
    validatorId !== involved.receivedBy &&
    validatorId !== involved.carrierUserId
  );
}

/**
 * AV-174 : imputation choisie à la clôture d'un écart. Absente ou inconnue :
 * `CASH_TRANSFER_IMPUTATION_REQUIRED` ; `CARRIER` sans porteur connu (ni utilisateur, ni nom) :
 * `CASH_TRANSFER_IMPUTATION_INVALID`.
 */
export function checkTransferImputation(
  option: string | undefined,
  carrier: { readonly carrierUserId: string | null; readonly carrierName: string | null },
): CashTransferImputation {
  if (option === undefined || !(CASH_TRANSFER_IMPUTATIONS as readonly string[]).includes(option)) {
    throw new DomainError(
      'Imputation de l’écart à choisir : expéditeur, porteur, récepteur ou entreprise (AV-153).',
      'CASH_TRANSFER_IMPUTATION_REQUIRED',
    );
  }
  if (option === 'CARRIER' && carrier.carrierUserId === null && carrier.carrierName === null) {
    throw new DomainError(
      'Aucun porteur n’est connu pour cette remise : l’écart ne peut pas lui être imputé.',
      'CASH_TRANSFER_IMPUTATION_INVALID',
    );
  }
  return option as CashTransferImputation;
}

/** Délai d'alerte d'une remise non reçue (AV-158) : 48 h par défaut. */
export const DEFAULT_CASH_TRANSFER_UNRECEIVED_HOURS = 48;

/**
 * Heures lues du paramètre `finance.cash_transfer_unreceived_hours` : entier strictement positif,
 * sinon le défaut (une valeur mal saisie ne fait jamais échouer la tâche quotidienne).
 */
export function cashTransferUnreceivedHoursFrom(value: unknown): number {
  const hours = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof hours === 'number' && Number.isSafeInteger(hours) && hours > 0
    ? hours
    : DEFAULT_CASH_TRANSFER_UNRECEIVED_HOURS;
}

/** Une remise envoyée à `sentAt` est-elle en retard à `now` (au-delà de `hours` heures, bord inclus) ? */
export function isTransferUnreceived(sentAt: Date, now: Date, hours: number): boolean {
  if (!Number.isSafeInteger(hours) || hours <= 0) {
    throw new DomainError(
      'Le délai d’alerte d’une remise est un nombre entier d’heures strictement positif.',
      'HOURS_INVALID',
    );
  }
  return sentAt.getTime() + hours * 3_600_000 <= now.getTime();
}

/** Code de la série globale des remises sans site (AV-176) : `SIEGE` par défaut. */
export const CASH_TRANSFER_DEFAULT_SERIES_CODE = 'SIEGE';

/**
 * Code lu du paramètre `finance.cash_transfer_series_code` : 1 à 10 lettres majuscules ou chiffres
 * (même borne que le code d'un site), sinon le défaut. Un code trop long ferait dépasser le numéro
 * de document (erreur SQL rejouée sans fin).
 */
export function cashTransferSeriesCodeFrom(value: unknown): string {
  return typeof value === 'string' && /^[A-Z0-9]{1,10}$/.test(value)
    ? value
    : CASH_TRANSFER_DEFAULT_SERIES_CODE;
}

/** Observations conservées hors ligne quand une course a déjà tranché (AV-173). */
export const CASH_TRANSFER_RACE_CODES = [
  'CASH_TRANSFER_RECEIVED_AFTER_CANCEL',
  'CASH_TRANSFER_CANCEL_AFTER_RECEIVE',
  'CASH_TRANSFER_RECEIVED_TWICE',
] as const;
export type CashTransferRaceCode = (typeof CASH_TRANSFER_RACE_CODES)[number];

export type CashTransferAction = 'RECEIVE' | 'CANCEL';

export type CashTransferDecision =
  | { readonly kind: 'APPLY' }
  | { readonly kind: 'NOOP' }
  | { readonly kind: 'OBSERVE'; readonly code: CashTransferRaceCode }
  | { readonly kind: 'REJECT'; readonly code: string; readonly messageFr: string };

/**
 * Table unique des transitions d'une remise et des courses (SM-CASH-TRANSFER ; ADR-032 §8 ;
 * AV-173). Seule `SENT` se reçoit ou s'annule ; une seconde annulation est sans effet. Les autres
 * cas sont refusés en ligne et, hors ligne, conservés comme observation (fait accompli, jamais
 * rejeté pour un état métier, BR-SYN-007).
 */
export function decideCashTransferAction(
  status: string,
  action: CashTransferAction,
  offline: boolean,
): CashTransferDecision {
  if (!(CASH_TRANSFER_STATUSES as readonly string[]).includes(status)) {
    throw new DomainError(`État de remise inconnu : ${status}.`, 'CASH_TRANSFER_STATUS_INVALID');
  }
  if (status === 'SENT') return { kind: 'APPLY' };
  if (status === 'CANCELLED') {
    if (action === 'CANCEL') return { kind: 'NOOP' };
    return offline
      ? { kind: 'OBSERVE', code: 'CASH_TRANSFER_RECEIVED_AFTER_CANCEL' }
      : {
          kind: 'REJECT',
          code: 'CASH_TRANSFER_CANCELLED',
          messageFr: 'Remise annulée par l’expéditeur : elle ne peut plus être reçue.',
        };
  }
  // RECEIVED, DISCREPANCY_PENDING ou CLOSED : la remise a déjà été reçue.
  if (offline) {
    return {
      kind: 'OBSERVE',
      code:
        action === 'RECEIVE'
          ? 'CASH_TRANSFER_RECEIVED_TWICE'
          : 'CASH_TRANSFER_CANCEL_AFTER_RECEIVE',
    };
  }
  return {
    kind: 'REJECT',
    code: 'CASH_TRANSFER_ALREADY_RECEIVED',
    messageFr:
      action === 'RECEIVE'
        ? 'Remise déjà reçue.'
        : 'Remise déjà reçue : elle ne peut plus être annulée.',
  };
}
