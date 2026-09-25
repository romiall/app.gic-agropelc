/**
 * Lecture des paramètres système historisés (organization.system_settings, BR-ADM-015,
 * §016). API publique du module `organization` — seule dépendance externe attendue :
 * `organization/api/settings.controller.ts` (même module) ; aucun autre module n'en a
 * besoin en P0 (aucun n'existe encore hors `identity`, qui ne lit pas les paramètres).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

export type SettingScopeType = 'GLOBAL' | 'SITE' | 'ZONE' | 'ROLE';

export interface SettingVersion {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly scopeType: SettingScopeType;
  readonly scopeId: string | null;
  readonly validFrom: Date;
  readonly isClientVisible: boolean;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface SettingFilter {
  readonly key: string;
  readonly scopeType?: SettingScopeType;
  readonly scopeId?: string;
}

/** Historique complet (toutes les versions), le plus récent en premier — « historique des paramètres lisible » (P0-11). */
export async function listSettingHistory(
  executor: Kysely<DB> | Transaction<DB>,
  filter: SettingFilter,
): Promise<readonly SettingVersion[]> {
  const rows = await executor
    .selectFrom('organization_system_settings')
    .selectAll()
    .where('key', '=', filter.key)
    .$if(filter.scopeType !== undefined, (qb) => qb.where('scope_type', '=', filter.scopeType!))
    .$if(filter.scopeId !== undefined, (qb) => qb.where('scope_id', '=', toBin(filter.scopeId!)))
    .orderBy('valid_from', 'desc')
    .execute();
  return rows.map(toSettingVersion);
}

/** Valeur en vigueur à `at` (dernière `valid_from ≤ at`, BR-ADM-016) ; `undefined` si aucune version n'existe encore à cet instant. */
export async function currentSettingValue(
  executor: Kysely<DB> | Transaction<DB>,
  filter: {
    readonly key: string;
    readonly scopeType: SettingScopeType;
    readonly scopeId: string | null;
    readonly at: Date;
  },
): Promise<unknown> {
  const row = await executor
    .selectFrom('organization_system_settings')
    .select('value')
    .where('key', '=', filter.key)
    .where('scope_type', '=', filter.scopeType)
    .where('valid_from', '<=', filter.at)
    .$if(filter.scopeId === null, (qb) => qb.where('scope_id', 'is', null))
    .$if(filter.scopeId !== null, (qb) =>
      qb.where('scope_id', '=', toBin(filter.scopeId as string)),
    )
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.value;
}

function toSettingVersion(row: {
  id: Buffer;
  key: string;
  value: unknown;
  scope_type: string;
  scope_id: Buffer | null;
  valid_from: Date;
  is_client_visible: number;
  reason: string | null;
  created_at: Date;
  created_by: Buffer;
}): SettingVersion {
  return {
    id: fromBin(row.id),
    key: row.key,
    value: row.value,
    scopeType: row.scope_type as SettingScopeType,
    scopeId: fromBinOrNull(row.scope_id),
    validFrom: row.valid_from,
    isClientVisible: Boolean(row.is_client_visible),
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: fromBin(row.created_by),
  };
}
