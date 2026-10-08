/**
 * Quotas d'appareil (ADR-033 ; D06 BR-STK-010 à 014 et 017 ; AV-025, AV-160, AV-161 ; SM-ALLOCATION),
 * partagés appareil et serveur (ADR-021) : la même fonction bloque la vente sur la tablette (AT-003)
 * et contrôle l'application côté serveur. Pur, sans entrée-sortie : l'appelant fournit l'état déjà
 * lu (soldes, restes, échéances). Quantités en unité de base, trois décimales au plus ; les calculs
 * se font en millièmes entiers (ADR-013), jamais en flottant.
 */
import { businessDayOf, businessDayStartUtc, nextBusinessDay } from './business-day.js';
import { DomainError } from './errors.js';
import {
  formatQuantity,
  quantityFromDecimal,
  quantityFromMilli,
  quantityMilliUnits,
} from './quantity.js';

export type CustodyMode = 'EXCLUSIVE_USER' | 'EXCLUSIVE_DEVICE' | 'SHARED';

const milli = (value: number): number => quantityMilliUnits(quantityFromDecimal(value));
const decimal = (valueMilli: number): number => valueMilli / 1000;
const text = (valueMilli: number): string => formatQuantity(quantityFromMilli(valueMilli));

function assertPositive(requested: number): number {
  const requestedMilli = milli(requested);
  if (requestedMilli <= 0) {
    throw new DomainError('La quantité demandée doit être positive.', 'QUANTITY_INVALID');
  }
  return requestedMilli;
}

/**
 * ADR-033 §4 : disponible d'un consommateur. Garde exclusive : le solde. `SHARED` : Σ des soldes du
 * produit à l'emplacement − Σ des restes des quotas **des autres** détenteurs (le reste propre du
 * consommateur n'est pas retranché). Jamais négatif : un solde négatif (anomalie hors ligne) ne
 * donne aucune disponibilité.
 */
export function availableForConsumer(input: {
  readonly custodyMode: CustodyMode;
  readonly stockOnHand: number;
  readonly othersAllocatedRemaining: number;
}): number {
  const onHand = milli(input.stockOnHand);
  if (input.custodyMode !== 'SHARED') return decimal(Math.max(0, onHand));
  return decimal(Math.max(0, onHand - milli(input.othersAllocatedRemaining)));
}

export interface QuotaConsumptionPlan {
  /** Part prise sur le reste du quota du consommateur. */
  readonly fromQuota: number;
  /** Part prise sur le stock non alloué. */
  readonly fromFreeStock: number;
  /** Ce que ni le quota ni le stock libre ne couvrent : solde négatif si le fait est appliqué hors ligne (BR-STK-018). */
  readonly shortfall: number;
  /** Le détenteur d'un quota consomme plus que son reste (conflit `ALLOCATION_EXCEEDED`, AV-161). */
  readonly quotaExceeded: boolean;
  /** Quantité consommée au-delà du reste du quota (0 si pas de dépassement). */
  readonly excessOverQuota: number;
}

/**
 * ADR-033 §5 : une sortie consomme d'abord le quota du consommateur, puis le stock libre (Σ soldes −
 * Σ restes de **tous** les quotas actifs). Sans quota (garde exclusive, ou utilisateur sans quota sur
 * un emplacement partagé), tout vient du stock libre et il n'y a jamais de dépassement de quota.
 */
export function planQuotaConsumption(input: {
  readonly requested: number;
  readonly holdsQuota: boolean;
  readonly quotaRemaining: number;
  readonly freeStock: number;
}): QuotaConsumptionPlan {
  const requested = assertPositive(input.requested);
  const remaining = input.holdsQuota ? Math.max(0, milli(input.quotaRemaining)) : 0;
  const free = Math.max(0, milli(input.freeStock));

  const fromQuota = Math.min(requested, remaining);
  const afterQuota = requested - fromQuota;
  const fromFree = Math.min(afterQuota, free);
  const shortfall = afterQuota - fromFree;
  const excess = input.holdsQuota ? afterQuota : 0;
  return {
    fromQuota: decimal(fromQuota),
    fromFreeStock: decimal(fromFree),
    shortfall: decimal(shortfall),
    quotaExceeded: excess > 0,
    excessOverQuota: decimal(excess),
  };
}

export type LocalConsumptionBlock =
  'ALLOCATION_MISSING' | 'ALLOCATION_EXPIRED' | 'ALLOCATION_EXCEEDED' | 'INSUFFICIENT_STOCK';

export type LocalConsumptionDecision =
  | {
      readonly allowed: true;
      /** Dépassement admis par l'option « autorisée et signalée » du site : à signaler au serveur. */
      readonly signalled: LocalConsumptionBlock | null;
    }
  | {
      readonly allowed: false;
      readonly code: LocalConsumptionBlock;
      readonly messageFr: string;
      /** Quantité encore utilisable sur cet appareil. */
      readonly available: number;
    };

/**
 * AV-025 (tranché le 27/09/2026) : **hors ligne**, l'appareil bloque toute sortie au-delà de son quota
 * (emplacement partagé) ou du solde local de l'emplacement (garde exclusive) et le dit clairement
 * (AT-003). L'option « autorisée et signalée » (`sales.offline_over_allocation_allowed`, par site,
 * désactivée par défaut) laisse passer le dépassement, que le serveur applique puis signale. Côté
 * serveur, un fait physique reçu n'est jamais rejeté (BR-SYN-007) : cette fonction ne sert qu'à
 * décider, sur l'appareil, d'empêcher la saisie.
 */
export function decideLocalConsumption(input: {
  readonly custodyMode: CustodyMode;
  readonly requested: number;
  /** Stock local de l'emplacement : solde téléchargé + opérations locales en attente (garde exclusive). */
  readonly localBalance: number;
  readonly holdsQuota: boolean;
  readonly quotaRemaining: number;
  readonly quotaValidUntil: Date | null;
  readonly now: Date;
  readonly overAllocationAllowed: boolean;
}): LocalConsumptionDecision {
  const requested = assertPositive(input.requested);

  const decide = (code: LocalConsumptionBlock, availableMilli: number, messageFr: string) =>
    input.overAllocationAllowed
      ? ({ allowed: true, signalled: code } as const)
      : ({
          allowed: false,
          code,
          messageFr,
          available: decimal(Math.max(0, availableMilli)),
        } as const);

  if (input.custodyMode !== 'SHARED') {
    const balance = milli(input.localBalance);
    if (requested > balance) {
      return decide(
        'INSUFFICIENT_STOCK',
        balance,
        `Stock insuffisant sur cet appareil : ${text(Math.max(0, balance))} disponible(s), ${text(requested)} demandé(s).`,
      );
    }
    return { allowed: true, signalled: null };
  }

  if (!input.holdsQuota) {
    return decide(
      'ALLOCATION_MISSING',
      0,
      'Aucune allocation pour cet appareil sur cet emplacement : la vente hors ligne n’est pas possible.',
    );
  }
  if (isAllocationExpired(input.quotaValidUntil, input.now)) {
    return decide(
      'ALLOCATION_EXPIRED',
      0,
      'Votre allocation a expiré : synchronisez l’appareil pour la renouveler.',
    );
  }
  const remaining = Math.max(0, milli(input.quotaRemaining));
  if (requested > remaining) {
    return decide(
      'ALLOCATION_EXCEEDED',
      remaining,
      `Allocation dépassée : il vous reste ${text(remaining)}, ${text(requested)} demandé(s).`,
    );
  }
  return { allowed: true, signalled: null };
}

// --- Registre d'entrées d'un quota (stock_allocation_entries, immuable) ----------------------------------

export const ALLOCATION_ENTRY_TYPES = [
  'GRANT',
  'INCREASE',
  'CONSUME',
  'RELEASE',
  'REVOKE',
  'ADJUST',
  'RESTORE',
] as const;
export type AllocationEntryType = (typeof ALLOCATION_ENTRY_TYPES)[number];

/** Sens d'une entrée : +1 augmente le reste, −1 le diminue, 0 (`ADJUST`) : signe porté par la donnée. */
export function allocationEntrySign(type: AllocationEntryType): -1 | 0 | 1 {
  switch (type) {
    case 'GRANT':
    case 'INCREASE':
    case 'RESTORE':
      return 1;
    case 'CONSUME':
    case 'RELEASE':
    case 'REVOKE':
      return -1;
    case 'ADJUST':
      return 0;
  }
}

/** Quantité signée à écrire pour une entrée (dictionnaire : positive pour GRANT/INCREASE/RESTORE, négative sinon). */
export function signedAllocationEntry(type: AllocationEntryType, magnitude: number): number {
  const value = milli(magnitude);
  const sign = allocationEntrySign(type);
  if (sign === 0) return decimal(value);
  if (value <= 0) {
    throw new DomainError(
      `Une entrée ${type} porte une quantité strictement positive.`,
      'QUANTITY_INVALID',
    );
  }
  return decimal(sign * value);
}

/** Reste d'un quota = Σ des entrées signées (INV-STK-20). */
export function allocationRemaining(
  entries: readonly { readonly entryType: AllocationEntryType; readonly quantity: number }[],
): number {
  let total = 0;
  for (const entry of entries) {
    const sign = allocationEntrySign(entry.entryType);
    const value = milli(entry.quantity);
    if (sign !== 0 && Math.sign(value) !== sign) {
      throw new DomainError(
        `Une entrée ${entry.entryType} ne peut pas avoir le signe ${Math.sign(value)}.`,
        'ALLOCATION_ENTRY_SIGN',
      );
    }
    total += value;
  }
  return decimal(total);
}

/**
 * ADR-033 §8 : quantité qu'une annulation peut rendre à un quota encore actif, plafonnée à ce que la
 * vente d'origine y a consommé, déduction faite de ce qui a déjà été restitué.
 */
export function restorableQuantity(input: {
  readonly consumed: number;
  readonly alreadyRestored: number;
  readonly requested: number;
}): number {
  const room = Math.max(0, milli(input.consumed) - milli(input.alreadyRestored));
  return decimal(Math.min(Math.max(0, milli(input.requested)), room));
}

/**
 * INV-STK-19, BR-STK-012 : à l'octroi ou à l'augmentation, Σ des restes des quotas actifs (celui-ci
 * compris) ≤ Σ des soldes du produit à l'emplacement.
 */
export function checkGrantCapacity(input: {
  readonly stockOnHand: number;
  readonly activeRemainingTotal: number;
  readonly requested: number;
}): { readonly ok: boolean; readonly capacity: number } {
  const capacity = Math.max(0, milli(input.stockOnHand) - milli(input.activeRemainingTotal));
  return { ok: assertPositive(input.requested) <= capacity, capacity: decimal(capacity) };
}

// --- Validité (AV-160) et révocation (AV-161) -------------------------------------------------------------

/**
 * AV-160 : sans durée indiquée, un quota vaut jusqu'à la **fin du jour métier** (Africa/Douala) de
 * l'octroi, c'est-à-dire jusqu'au début du jour suivant ; sinon `validityHours` après l'octroi.
 */
export function allocationValidUntil(grantedAt: Date, validityHours?: number | null): Date {
  if (validityHours !== undefined && validityHours !== null) {
    if (!Number.isFinite(validityHours) || validityHours <= 0) {
      throw new DomainError(
        'La durée de validité doit être strictement positive.',
        'VALIDITY_INVALID',
      );
    }
    return new Date(grantedAt.getTime() + Math.round(validityHours * 3_600_000));
  }
  return businessDayStartUtc(nextBusinessDay(businessDayOf(grantedAt)));
}

/** Un quota dont la date de validité est atteinte n'est plus utilisable localement (SM-ALLOCATION). */
export function isAllocationExpired(validUntil: Date | null, at: Date): boolean {
  return validUntil !== null && at.getTime() >= validUntil.getTime();
}

/**
 * AV-161, ADR-033 §6 : une consommation imputée à un quota révoqué ouvre `ALLOCATION_REVOKED_CONSUMED`
 * seulement si le fait survient **après** la révocation (`occurred_at`) ; un fait antérieur, synchronisé
 * tard par un appareil qui n'avait pas reçu la révocation, est normal.
 */
export function isConsumedAfterRevocation(occurredAt: Date, revokedAt: Date): boolean {
  return occurredAt.getTime() > revokedAt.getTime();
}
