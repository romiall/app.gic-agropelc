/**
 * Conflits de synchronisation (`sync.sync_conflicts`, SM-CONFLICT ; 06-offline-sync/
 * 02-synchronisation.md §6, 03-matrice-conflits.md). Même rôle que `change-feed.ts` : la table
 * appartient au noyau de synchronisation, les modules y consignent leurs conflits par cette API,
 * dans la transaction de la commande. Un conflit **informatif** (`applied = true`) accompagne un
 * fait appliqué (`APPLIED_WITH_WARNINGS`) et reste ouvert pour revue par `owner_role`.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../kysely/database.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { jsonValue } from '../kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../kysely/uuid-columns.js';

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

/**
 * Clôt les conflits ouverts d'un type dont les `details` portent exactement les valeurs données
 * (ex. `STOCK_NEGATIVE` d'un (emplacement, produit) résolu par un inventaire, AT-049). Les conflits
 * sans ces clés dans leurs `details` ne sont jamais touchés. Renvoie le nombre de conflits résolus.
 */
export async function resolveOpenConflictsByDetails(
  uow: UnitOfWork,
  input: {
    readonly conflictType: string;
    readonly details: Readonly<Record<string, string>>;
    readonly resolution: 'ACCEPT_CLIENT' | 'KEEP_SERVER' | 'MERGE' | 'COMPENSATE';
    readonly resolvedBy: string;
    readonly resolvedAt: Date;
    readonly comment?: string | null;
    readonly refs?: readonly string[];
  },
): Promise<number> {
  const keys = Object.entries(input.details);
  if (keys.length === 0) return 0;
  let query = uow
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
    .where('conflict_type', '=', input.conflictType);
  for (const [key, value] of keys) {
    query = query.where(
      sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, ${`$.${key}`})) = ${value}`,
    );
  }
  const result = await query.executeTakeFirst();
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

export interface OpenConflictSummary {
  readonly total: number;
  /** Conflits d'impact fort : stock négatif, doublon de paiement, vente anonyme non payée… */
  readonly byType: Readonly<Record<string, number>>;
}

/**
 * Conflits ouverts (KPI-OPS-02), filtrés par rôle propriétaire et/ou par site. Un conflit sans site
 * ne se rattache qu'à une lecture sans filtre de site. Lecture seule : la résolution relève de
 * `sync.conflict.resolve`.
 */
export async function openConflictSummary(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly ownerRoles?: readonly string[]; readonly siteIds?: readonly string[] } = {},
): Promise<OpenConflictSummary> {
  if (filter.ownerRoles?.length === 0 || filter.siteIds?.length === 0) {
    return { total: 0, byType: {} };
  }
  const rows = await executor
    .selectFrom('sync_sync_conflicts')
    .select(['conflict_type', sql<string>`COUNT(*)`.as('count')])
    .where('status', '=', 'OPEN')
    .$if(filter.ownerRoles !== undefined, (qb) =>
      qb.where('owner_role', 'in', [...filter.ownerRoles!]),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .groupBy('conflict_type')
    .execute();
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byType[row.conflict_type] = Number(row.count);
    total += Number(row.count);
  }
  return { total, byType };
}

/** Détails consignés par le conflit le plus récent d'un type sur une entité (`null` : aucun). */
export async function latestConflictDetails(
  uow: UnitOfWork,
  input: { readonly conflictType: string; readonly entityId: string },
): Promise<unknown> {
  const row = await uow
    .selectFrom('sync_sync_conflicts')
    .select('details')
    .where('conflict_type', '=', input.conflictType)
    .where('entity_id', '=', toBin(input.entityId))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row?.details ?? null;
}

// --- P5-17 : lecture et clôture manuelle (`GET /sync/conflicts`, `sync.conflict.resolve`/`.dismiss`) --

export const CONFLICT_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];
export const CONFLICT_RESOLUTIONS = [
  'ACCEPT_CLIENT',
  'KEEP_SERVER',
  'MERGE',
  'COMPENSATE',
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export interface ConflictRecord {
  readonly id: string;
  readonly conflictType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly siteId: string | null;
  readonly ownerRole: string;
  /** Vrai : fait appliqué, conflit informatif ; faux : commande en quarantaine, sans effet. */
  readonly applied: boolean;
  readonly details: unknown;
  readonly status: ConflictStatus;
  readonly resolution: ConflictResolution | null;
  readonly resolutionRefs: readonly string[];
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionComment: string | null;
  readonly createdAt: string;
  readonly commandId: string | null;
  /** Auteur et appareil de la commande à l'origine du conflit (inbox) ; nuls pour un conflit système. */
  readonly authorUserId: string | null;
  readonly deviceId: string | null;
}

const parseJson = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

function selectConflicts(executor: Kysely<DB> | Transaction<DB>) {
  return executor
    .selectFrom('sync_sync_conflicts as c')
    .leftJoin('sync_command_inbox as i', 'i.command_id', 'c.command_id')
    .selectAll('c')
    .select(['i.user_id as author_user_id', 'i.device_id as author_device_id']);
}

type ConflictRow = Awaited<ReturnType<ReturnType<typeof selectConflicts>['execute']>>[number];

function toConflictRecord(row: ConflictRow): ConflictRecord {
  const refs = parseJson(row.resolution_refs);
  return {
    id: fromBin(row.id),
    conflictType: row.conflict_type,
    entityType: row.entity_type,
    entityId: fromBin(row.entity_id),
    siteId: row.site_id === null ? null : fromBin(row.site_id),
    ownerRole: row.owner_role,
    applied: Boolean(row.applied),
    details: parseJson(row.details),
    status: row.status as ConflictStatus,
    resolution: row.resolution as ConflictResolution | null,
    resolutionRefs: Array.isArray(refs) ? (refs as string[]) : [],
    resolvedBy: row.resolved_by === null ? null : fromBin(row.resolved_by),
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolutionComment: row.resolution_comment,
    createdAt: row.created_at.toISOString(),
    commandId: row.command_id === null ? null : fromBin(row.command_id),
    authorUserId: row.author_user_id === null ? null : fromBin(row.author_user_id),
    deviceId: row.author_device_id === null ? null : fromBin(row.author_device_id),
  };
}

/**
 * Conflits, du plus récent au plus ancien (`id`, UUIDv7). `ownerRoles` / `siteIds` : filtres (liste
 * vide ⇒ aucun conflit ; un conflit sans site n'apparaît pas sous un filtre de site). `confinement` :
 * pré-filtre sûr de la couche de transport (sur-ensemble) — conflits d'un de ces sites, **ou** produits
 * par l'un de ces auteurs, **ou** conflits système (sans commande), évalués ensuite un par un. Aucune
 * décision d'autorisation ici (RC-04 : `sync/` évalue chaque conflit).
 */
export async function listConflicts(
  executor: Kysely<DB> | Transaction<DB>,
  filter: {
    readonly status?: ConflictStatus;
    readonly ownerRoles?: readonly string[];
    readonly siteIds?: readonly string[];
    readonly confinement?: {
      readonly siteIds: readonly string[];
      readonly authorUserIds: readonly string[];
    };
    readonly conflictType?: string;
    readonly entityId?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly ConflictRecord[]; readonly nextCursor: string | null }> {
  const confinement = filter.confinement;
  if (filter.ownerRoles?.length === 0 || filter.siteIds?.length === 0) {
    return { items: [], nextCursor: null };
  }
  const rows = await selectConflicts(executor)
    .$if(filter.status !== undefined, (qb) => qb.where('c.status', '=', filter.status!))
    .$if(filter.ownerRoles !== undefined, (qb) =>
      qb.where('c.owner_role', 'in', [...filter.ownerRoles!]),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'c.site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(confinement !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('c.command_id', 'is', null),
          ...(confinement!.siteIds.length > 0
            ? [
                eb(
                  'c.site_id',
                  'in',
                  confinement!.siteIds.map((id) => toBin(id)),
                ),
              ]
            : []),
          ...(confinement!.authorUserIds.length > 0
            ? [
                eb(
                  'i.user_id',
                  'in',
                  confinement!.authorUserIds.map((id) => toBin(id)),
                ),
              ]
            : []),
        ]),
      ),
    )
    .$if(filter.conflictType !== undefined, (qb) =>
      qb.where('c.conflict_type', '=', filter.conflictType!),
    )
    .$if(filter.entityId !== undefined, (qb) =>
      qb.where('c.entity_id', '=', toBin(filter.entityId!)),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('c.id', '<', toBin(filter.beforeId!)))
    .orderBy('c.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    items: page.map(toConflictRecord),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

export async function findConflict(
  executor: Kysely<DB> | Transaction<DB>,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<ConflictRecord | null> {
  let query = selectConflicts(executor).where('c.id', '=', toBin(id));
  // Le conflit seul (ADR-038 §2) : l'inbox jointe de la commande d'origine n'est pas verrouillée.
  if (options.lock) query = query.forUpdate('c');
  const row = await query.executeTakeFirst();
  return row ? toConflictRecord(row) : null;
}

/**
 * Clôture manuelle d'un conflit **ouvert** (SM-CONFLICT) : `RESOLVED` avec une résolution, ou
 * `DISMISSED` (conflit informatif écarté, sans résolution). Renvoie faux si le conflit n'est plus
 * ouvert (déjà clos par un autre acteur ou par sa régularisation) : le déclencheur d'immuabilité n'est
 * jamais atteint.
 */
export async function closeConflict(
  uow: UnitOfWork,
  input: {
    readonly id: string;
    readonly status: 'RESOLVED' | 'DISMISSED';
    readonly resolution: ConflictResolution | null;
    readonly refs: readonly string[];
    readonly comment: string;
    readonly closedBy: string;
    readonly closedAt: Date;
  },
): Promise<boolean> {
  const result = await uow
    .updateTable('sync_sync_conflicts')
    .set({
      status: input.status,
      resolution: input.resolution,
      resolution_refs: jsonValue(input.refs),
      resolved_by: toBin(input.closedBy),
      resolved_at: input.closedAt,
      resolution_comment: input.comment,
    })
    .where('id', '=', toBin(input.id))
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
