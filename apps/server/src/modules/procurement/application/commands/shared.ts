/**
 * Utilitaires communs aux commandes des achats (D08-APP) : sites, emplacements, produits
 * achetables, portée d'autorisation (RC-04), paramètres système et politiques de contrôle.
 * Les tables d'`organization` et de `catalog` sont lues par clé (dépendances autorisées par le
 * graphe, même précédent qu'`inventory/commands/shared.ts`).
 */
import type { Transaction } from 'kysely';
import { DomainError, quantityFromDecimal, type Quantity } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  evaluateAccess,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  currentPolicies,
  type ActiveControlPolicy,
  type OperationType,
} from '../../../approvals/application/public/index.js';

export type Uow = Transaction<DB>;

export function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

export const FORBIDDEN_SCOPE = rejected(
  'FORBIDDEN_SCOPE',
  'Opération hors de votre périmètre (site ou emplacement).',
);

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface SiteRef {
  readonly id: string;
  readonly code: string;
  readonly zoneId: string;
  readonly isActive: boolean;
}

export async function loadSite(uow: Uow, siteId: string): Promise<SiteRef | undefined> {
  const row = await uow
    .selectFrom('organization_sites')
    .select(['id', 'code', 'zone_id', 'status'])
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        code: row.code,
        zoneId: fromBin(row.zone_id),
        isActive: row.status === 'ACTIVE',
      }
    : undefined;
}

export interface LocationRef {
  readonly id: string;
  readonly site: SiteRef;
  readonly locationType: string;
  readonly isActive: boolean;
}

/** Emplacement physique avec son site ; `undefined` pour un emplacement inconnu ou virtuel. */
export async function loadPhysicalLocation(
  uow: Uow,
  locationId: string,
): Promise<LocationRef | undefined> {
  const row = await uow
    .selectFrom('organization_locations')
    .select(['id', 'site_id', 'location_type', 'is_virtual', 'status'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row || row.is_virtual || !row.site_id) return undefined;
  const site = await loadSite(uow, fromBin(row.site_id));
  if (!site) return undefined;
  return {
    id: fromBin(row.id),
    site,
    locationType: row.location_type,
    isActive: row.status === 'ACTIVE',
  };
}

/** Produits actifs et achetables (BR-APP-002, D08 §4) ; renvoie les identifiants refusés. */
export async function nonPurchasableProducts(
  uow: Uow,
  productIds: readonly string[],
): Promise<readonly string[]> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return [];
  const rows = await uow
    .selectFrom('catalog_products')
    .select(['id', 'status', 'is_purchasable'])
    .where(
      'id',
      'in',
      unique.map((id) => toBin(id)),
    )
    .execute();
  const ok = new Set(
    rows
      .filter((row) => row.status === 'ACTIVE' && row.is_purchasable)
      .map((row) => fromBin(row.id)),
  );
  return unique.filter((id) => !ok.has(id));
}

export async function unknownUnits(
  uow: Uow,
  unitCodes: readonly string[],
): Promise<readonly string[]> {
  const unique = [...new Set(unitCodes)];
  if (unique.length === 0) return [];
  const rows = await uow
    .selectFrom('catalog_units')
    .select('code')
    .where('code', 'in', unique)
    .execute();
  const known = new Set(rows.map((row) => row.code));
  return unique.filter((code) => !known.has(code));
}

export async function isAllowed(
  uow: Uow,
  userId: string,
  permissionCode: string,
  at: Date,
  resource: ResourceLocator,
): Promise<boolean> {
  return (await evaluateAccess(uow, { userId, permissionCode, occurredAt: at, resource })).allowed;
}

/** Paramètre système numérique (règle 8) ; repli = valeur par défaut documentée du seed. */
export async function numberSetting(
  uow: Uow,
  key: string,
  at: Date,
  fallback: number,
): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  const parsed = typeof value === 'number' ? value : Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : fallback;
}

/** Politique de contrôle active (validation inconditionnelle : sans elle, refus explicite). */
export async function activePolicy(
  uow: Uow,
  operationType: OperationType,
  at: Date,
): Promise<ActiveControlPolicy | undefined> {
  return (await currentPolicies(uow, operationType, at))[0];
}

export const CONTROL_POLICY_MISSING = (operationType: string) =>
  rejected(
    'CONTROL_POLICY_MISSING',
    `Aucune politique de contrôle ${operationType} active (approvals.policy.set) : la validation est obligatoire.`,
  );

/** Quantité en unité de base à 3 décimales au plus (ADR-013) ; `DomainError` sinon. */
export function baseQuantity(value: number): Quantity {
  return quantityFromDecimal(value);
}

/** `DomainError` → rejet métier ; toute autre erreur est relancée (erreur transitoire). */
export function domainRejection(error: unknown): CommandHandlerOutcome {
  if (error instanceof DomainError) return rejected(error.code, error.message);
  throw error;
}
