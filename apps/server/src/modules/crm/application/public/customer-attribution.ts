/**
 * Lectures et verrou du compte client pour la vente (BR-VEN-020, BR-VEN-025) : titulaire à une
 * date, rôle commercial, compte verrouillé avant un contrôle de crédit. API publique de `crm`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import {
  hasCommercialRoleAt as hasCommercialRole,
  lockCustomer,
  ownerAt,
} from '../commands/shared.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { getCustomer, type CustomerSummary } from './customer-query.js';

/** Titulaire du compte à `at` (`crm.customer_assignments`, INV-CRM-02) ; `null` sans titulaire. */
export async function ownerOfCustomerAt(
  executor: Kysely<DB> | Transaction<DB>,
  customerId: string,
  at: Date,
): Promise<string | null> {
  return ownerAt(executor as Transaction<DB>, toBin(customerId), at);
}

/**
 * « Rôle commercial » à `at` (BR-CRM-003) : un rôle actif parmi le paramètre
 * `crm.commercial_role_codes`.
 */
export async function hasCommercialRoleAt(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
  at: Date,
): Promise<boolean> {
  return hasCommercialRole(executor as Transaction<DB>, userId, at);
}

/**
 * Verrouille le compte (`FOR UPDATE`) et le renvoie : un contrôle de plafond de crédit ne doit pas
 * être doublé par une vente concurrente au même client (BR-VEN-025). À appeler avant de calculer
 * l'encours, dans le même ordre de verrous que `convertOnConfirmedSale`. Un compte fusionné est
 * renvoyé tel quel (`stage` = `MERGED`) : l'appelant agit sur le compte conservé.
 */
export async function lockCustomerAccount(
  uow: Transaction<DB>,
  customerId: string,
): Promise<CustomerSummary | undefined> {
  const row = await lockCustomer(uow, customerId);
  if (!row) return undefined;
  return getCustomer(uow, customerId);
}
