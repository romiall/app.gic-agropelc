/**
 * Portée de la lecture du journal d'audit (07-security-rbac/03-audit.md §6 : « la Finance est limitée aux
 * entités financières » ; RP-1, AV-493). Couche de transport : c'est ici que `audit`, `identity` et
 * `organization` se rencontrent (le module `audit` ne dépend d'aucun autre).
 *
 * Règle (DÉDUIT, fermée par défaut) : la Direction et l'Admin lisent tout ; tout autre détenteur de
 * `audit.log.read` (la Finance, ou un rôle futur) ne lit que les types d'entité du paramètre
 * `audit.finance_entity_types` (règle 8), à défaut la liste ci-dessous.
 */
import type { Database } from '../platform/kysely/database.provider.js';
import { activeRoleCodesAt } from '../modules/identity/application/public/index.js';
import { currentSettingValue } from '../modules/organization/application/public/index.js';

export const FINANCE_AUDIT_ENTITY_TYPES_KEY = 'audit.finance_entity_types';

/** Rôles qui lisent tout le journal. */
const UNRESTRICTED_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'DIRECTION']);

/** Types d'entité financiers par défaut (encaissements, caisses, dépenses, achats et dettes, ventes). */
export const DEFAULT_FINANCE_AUDIT_ENTITY_TYPES: readonly string[] = [
  'CASH_ACCOUNT',
  'CASH_RECONCILIATION',
  'CASH_SESSION',
  'CASH_TRANSFER',
  'CASH_TRANSFER_TARGET',
  'CUSTOMER_PAYMENT',
  'EXPENSE',
  'EXPENSE_CATEGORY',
  'LEDGER_RECONCILIATION',
  'PURCHASE_ORDER',
  'SALE',
  'SALE_CANCELLATION',
  'SALES_ORDER',
  'SUPPLIER_INVOICE',
  'SUPPLIER_PAYMENT',
];

/** Liste de types d'entité du paramètre : un tableau de textes non vides, sinon `null` (repli sur le défaut). */
export function parseEntityTypes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const types = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return types.length === value.length ? [...new Set(types.map((item) => item.trim()))] : null;
}

/** `null` : aucune restriction ; sinon les seuls types d'entité que le lecteur peut consulter. */
export async function auditEntityRestriction(
  db: Database,
  userId: string,
  now: Date,
): Promise<readonly string[] | null> {
  const roles = await activeRoleCodesAt(db, userId, now);
  if (roles.some((role) => UNRESTRICTED_ROLES.has(role))) return null;
  const configured = await currentSettingValue(db, {
    key: FINANCE_AUDIT_ENTITY_TYPES_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at: now,
  });
  return parseEntityTypes(configured) ?? DEFAULT_FINANCE_AUDIT_ENTITY_TYPES;
}
