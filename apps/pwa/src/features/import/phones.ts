/**
 * Index des comptes clients de l'appareil par téléphone normalisé (RP-2, PP-C) : un seul passage par chargement, au
 * lieu d'un balayage de tous les comptes à chaque ligne du fichier (`checkProspect` balaie la liste à chaque appel).
 */
import { DomainError, normalizePhone } from '@gic/domain';
import type { CustomerData } from '../sales/types.js';

const phoneIndexes = new WeakMap<
  readonly CustomerData[],
  { readonly countryCode: string; readonly byPhone: ReadonlyMap<string, CustomerData> }
>();

/** Comptes de l'appareil par téléphone normalisé (hors comptes fusionnés), comme le repère `checkProspect`. */
export function customersByPhone(
  customers: readonly CustomerData[],
  countryCode: string,
): ReadonlyMap<string, CustomerData> {
  const cached = phoneIndexes.get(customers);
  if (cached !== undefined && cached.countryCode === countryCode) return cached.byPhone;
  const byPhone = new Map<string, CustomerData>();
  for (const customer of customers) {
    if (customer.merged_into_id !== null || customer.phone_primary === null) continue;
    try {
      const phone = normalizePhone(customer.phone_primary, countryCode);
      if (!byPhone.has(phone)) byPhone.set(phone, customer);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  phoneIndexes.set(customers, { countryCode, byPhone });
  return byPhone;
}
