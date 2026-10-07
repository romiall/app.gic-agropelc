/**
 * Utilitaires communs aux commandes de `sales` (D04-VEN) : sites, paramètres système, politiques
 * de contrôle, traduction des refus métier. Les tables d'`organization` sont lues par clé
 * (dépendance autorisée, même précédent que `procurement/commands/shared.ts`).
 */
import type { Transaction } from 'kysely';
import { DomainError, businessDayOf } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  currentPolicies,
  type ActiveControlPolicy,
  type OperationType,
} from '../../../approvals/application/public/index.js';
import { InventoryMoveError } from '../../../inventory/application/public/index.js';
import { CashMovementError } from '../../../finance/application/public/index.js';

export type Uow = Transaction<DB>;

export function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

export const FORBIDDEN_SCOPE = rejected(
  'FORBIDDEN_SCOPE',
  'Opération hors de votre périmètre (site ou emplacement).',
);

export interface SiteRef {
  readonly id: string;
  readonly code: string;
  readonly zoneId: string;
  readonly siteType: string;
}

export async function loadSite(uow: Uow, siteId: string): Promise<SiteRef | undefined> {
  const row = await uow
    .selectFrom('organization_sites')
    .select(['id', 'code', 'zone_id', 'site_type'])
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        code: row.code,
        zoneId: fromBin(row.zone_id),
        siteType: row.site_type,
      }
    : undefined;
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
  /**
   * Hors ligne : politique en vigueur à la réception si aucune ne l'était à `occurred_at` (une vente
   * saisie avant la mise en place de la politique reste un fait accompli, BR-SYN-007).
   */
  offlineFallbackAt?: Date,
): Promise<ActiveControlPolicy | undefined> {
  const policy = (await currentPolicies(uow, operationType, at))[0];
  if (policy !== undefined || offlineFallbackAt === undefined) return policy;
  return (await currentPolicies(uow, operationType, offlineFallbackAt))[0];
}

export const CONTROL_POLICY_MISSING = (operationType: string) =>
  rejected(
    'CONTROL_POLICY_MISSING',
    `Aucune politique de contrôle ${operationType} active (approvals.policy.set) : la validation est obligatoire.`,
  );

/** Année du numéro de document : celle du jour métier (Africa/Douala) de l'opération. */
export function documentYear(at: Date): number {
  return Number(businessDayOf(at).slice(0, 4));
}

/**
 * `DomainError` et refus d'`inventory` ou de `finance` → rejet métier ; toute autre erreur est
 * relancée (erreur transitoire : le pipeline rejoue la commande, il ne la rejette pas).
 */
export function businessRejection(error: unknown): CommandHandlerOutcome {
  if (error instanceof DomainError) return rejected(error.code, error.message);
  if (error instanceof InventoryMoveError) return rejected(error.code, error.message);
  if (error instanceof CashMovementError) return rejected(error.code, error.message);
  throw error;
}

export const milli = (value: number): number => Math.round(value * 1000);
export const fromMilli = (value: number): number => value / 1000;
