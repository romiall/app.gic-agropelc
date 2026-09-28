/**
 * Conflits de synchronisation (`sync.sync_conflicts`, SM-CONFLICT ; 06-offline-sync/
 * 02-synchronisation.md §6, 03-matrice-conflits.md). Même rôle que `change-feed.ts` : la table
 * appartient au noyau de synchronisation, les modules y consignent leurs conflits par cette API,
 * dans la transaction de la commande. Un conflit **informatif** (`applied = true`) accompagne un
 * fait appliqué (`APPLIED_WITH_WARNINGS`) et reste ouvert pour revue par `owner_role`.
 */
import type { UnitOfWork } from '../unit-of-work.js';
import { jsonValue } from '../kysely/json-value.js';
import { toBin, toBinOrNull } from '../kysely/uuid-columns.js';

export interface ConflictInput {
  readonly id: string;
  readonly commandId: string | null;
  readonly conflictType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly siteId?: string | null;
  /** Rôle chargé de la résolution (matrice des conflits, dernière colonne). */
  readonly ownerRole: string;
  readonly applied: boolean;
  readonly details: Record<string, unknown>;
}

export async function recordConflict(uow: UnitOfWork, input: ConflictInput): Promise<void> {
  await uow
    .insertInto('sync_sync_conflicts')
    .values({
      id: toBin(input.id),
      command_id: toBinOrNull(input.commandId),
      conflict_type: input.conflictType,
      entity_type: input.entityType,
      entity_id: toBin(input.entityId),
      site_id: toBinOrNull(input.siteId ?? null),
      owner_role: input.ownerRole,
      applied: input.applied ? 1 : 0,
      details: jsonValue(input.details),
    })
    .execute();
}

/**
 * Clôt les conflits ouverts d'un type portant sur l'une des entités (ex. `DUPLICATE_CUSTOMER`
 * résolu par la fusion des comptes, BR-CRM-006). Renvoie le nombre de conflits résolus.
 */
export async function resolveOpenConflicts(
  uow: UnitOfWork,
  input: {
    readonly conflictType: string;
    readonly entityType: string;
    readonly entityIds: readonly string[];
    readonly resolution: 'ACCEPT_CLIENT' | 'KEEP_SERVER' | 'MERGE' | 'COMPENSATE';
    readonly resolvedBy: string;
    readonly resolvedAt: Date;
    readonly comment?: string | null;
    readonly refs?: readonly string[];
  },
): Promise<number> {
  if (input.entityIds.length === 0) return 0;
  const result = await uow
    .updateTable('sync_sync_conflicts')
    .set({
      status: 'RESOLVED',
      resolution: input.resolution,
      resolution_refs: jsonValue(input.refs ?? []),
      resolved_by: toBin(input.resolvedBy),
      resolved_at: input.resolvedAt,
      resolution_comment: input.comment ?? null,
    })
    .where('status', '=', 'OPEN')
    .where('conflict_type', '=', input.conflictType)
    .where('entity_type', '=', input.entityType)
    .where(
      'entity_id',
      'in',
      input.entityIds.map((id) => toBin(id)),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Une commande a-t-elle consigné ce type de conflit sur cette entité (correction d'un fait) ? */
export async function hasConflict(
  uow: UnitOfWork,
  input: {
    readonly commandId: string;
    readonly conflictType: string;
    readonly entityId: string;
  },
): Promise<boolean> {
  const row = await uow
    .selectFrom('sync_sync_conflicts')
    .select('id')
    .where('command_id', '=', toBin(input.commandId))
    .where('conflict_type', '=', input.conflictType)
    .where('entity_id', '=', toBin(input.entityId))
    .executeTakeFirst();
  return row !== undefined;
}
