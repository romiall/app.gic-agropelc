/**
 * Quotas d'un emplacement partagé (ECR-STK-06 ; ADR-033 ; BR-STK-010 à 014 ; SM-ALLOCATION). Logique
 * pure sur la lecture `GET /api/v1/allocations?location_id=` (quotas de tous statuts, du plus récent au
 * plus ancien, et total des restes actifs par produit) : quotas actifs, détenteurs connus, part non
 * allouée indicative, charges utiles de l'octroi, de l'augmentation et de la révocation (en ligne
 * seulement, `ONLINE_ONLY` sinon).
 */
import { parseQuantity } from '../sales/sale-form.js';

/** Quota tel que le sert `GET /allocations` (`AllocationSummary`, camelCase). */
export interface AllocationItem {
  readonly id: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly holderUserId: string | null;
  readonly holderDeviceId: string | null;
  readonly quantityGranted: number;
  readonly quantityRemaining: number;
  readonly validUntil: string | null;
  readonly status: string;
  readonly revocationPending: boolean;
  readonly version: number;
}

export interface AllocationsPage {
  readonly location_id: string | null;
  readonly allocations: readonly AllocationItem[];
  readonly active_totals?: readonly {
    readonly productId: string;
    readonly activeCount: number;
    readonly quantityRemaining: number;
  }[];
  readonly next_cursor: string | null;
}

/** Couple détenteur (utilisateur, appareil) d'un quota. */
export interface Holder {
  readonly userId: string;
  readonly deviceId: string;
}

export const holderKey = (holder: Holder): string => `${holder.userId}|${holder.deviceId}`;

/** Quotas actifs, par produit puis du plus ancien au plus récent. */
export function activeQuotas(items: readonly AllocationItem[]): AllocationItem[] {
  return items
    .filter((item) => item.status === 'ACTIVE')
    .sort((a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id));
}

/**
 * AV-310 (défaut) : détenteurs proposés à l'octroi. Aucune lecture des utilisateurs ni des appareils
 * n'est servie (S-28) : seuls les couples déjà détenteurs d'un quota sur cet emplacement (lecture de
 * l'historique) et l'utilisateur lui-même sur ce téléphone sont proposés, jamais un identifiant saisi.
 */
export function knownHolders(items: readonly AllocationItem[], self: Holder | null): Holder[] {
  const holders = new Map<string, Holder>();
  if (self) holders.set(holderKey(self), self);
  for (const item of items) {
    if (!item.holderUserId || !item.holderDeviceId) continue;
    const holder = { userId: item.holderUserId, deviceId: item.holderDeviceId };
    if (!holders.has(holderKey(holder))) holders.set(holderKey(holder), holder);
  }
  return [...holders.values()];
}

/** Libellé court d'un identifiant (les noms ne sont pas servis, S-28). */
export const shortId = (id: string): string => `…${id.slice(-4)}`;

/**
 * Part non allouée indicative d'un produit : physique connu de l'appareil moins les restes actifs
 * servis ; le serveur la recalcule à l'octroi (`ALLOCATION_EXCEEDS_AVAILABLE`).
 */
export function unallocated(
  onHand: number,
  page: Pick<AllocationsPage, 'active_totals'>,
  productId: string,
): number {
  const allocated =
    page.active_totals?.find((total) => total.productId === productId)?.quantityRemaining ?? 0;
  return Math.round((onHand - allocated) * 1000) / 1000;
}

/** Quantité saisie (unité de base, trois décimales au plus, > 0) ; `null` si invalide. */
export function parsePositiveQuantity(text: string): number | null {
  const value = parseQuantity(text);
  return value !== null && value > 0 ? value : null;
}

/** Durée de validité saisie (heures, au plus 744 = 31 jours, `allocationGrantPayloadSchema`). */
export const MAX_VALIDITY_HOURS = 24 * 31;

export function parseValidityHours(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= MAX_VALIDITY_HOURS ? value : null;
}

/** Charge utile de `inventory.allocation.grant` : validité en heures, sinon fin du jour métier. */
export function grantPayload(input: {
  readonly holder: Holder;
  readonly locationId: string;
  readonly productId: string;
  readonly quantityBase: number;
  readonly validityHours: number | null;
}) {
  return {
    holderUserId: input.holder.userId,
    holderDeviceId: input.holder.deviceId,
    locationId: input.locationId,
    productId: input.productId,
    quantityBase: input.quantityBase,
    ...(input.validityHours !== null ? { validityHours: input.validityHours } : {}),
  };
}

/** Longueur maximale du motif d'une révocation (`allocationRevokePayloadSchema`). */
export const MAX_REVOKE_REASON = 500;
