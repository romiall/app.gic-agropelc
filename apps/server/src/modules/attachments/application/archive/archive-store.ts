/**
 * Archive des photos jointes : lecture et écriture des trois tables du module (AV-539, ADR-070) —
 * `attachments_archives` (le plan d'une période), `attachments_archive_volumes` (un fichier ZIP) et
 * `attachments_archive_items` (une photo). Seul ce module écrit ces tables ; la couche de transport
 * (`attachments-api/archive/`) compose avec les faits des modules propriétaires des documents.
 *
 * Aucune ligne de `attachments_attachments` n'est touchée : une pièce archivée reste `AVAILABLE`, sa trace
 * d'archivage est ici (ADR-070 §1).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ArchiveCategory, ArchiveGranularity } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export type ArchiveStatus = 'READY' | 'COMPLETED' | 'CANCELLED';
export type ArchiveItemState = 'PLANNED' | 'PURGED' | 'RELEASED';
export type ArchiveReleaseReason =
  'OPEN_OPERATION' | 'CHANGED' | 'TOO_RECENT' | 'ARCHIVE_CANCELLED';

/** Jour `AAAA-MM-JJ` d'une colonne `DATE` (lue comme minuit UTC, pool en UTC). */
function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateParam(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// -------------------------------------------------------------------------------------------------------------
// Candidates et agrégats
// -------------------------------------------------------------------------------------------------------------

export interface ArchiveCandidate {
  readonly attachmentId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly capturedAt: Date;
  /** Soumission : réception par le serveur (`received_at`, à défaut `created_at`). */
  readonly submittedAt: Date;
}

const SUBMITTED_AT = sql<Date>`COALESCE(a.received_at, a.created_at)`;

/**
 * Pièces reçues et vérifiées (`AVAILABLE`) de la fenêtre `[fromUtc, toUtc[`, reçues avant `cutoff`, qu'aucun plan
 * ne couvre (prévues ou vidées), des plus anciennes aux plus récentes. L'état de l'opération qui les porte est jugé
 * par l'appelant (ADR-070 §2.4).
 */
export async function loadArchiveCandidates(
  executor: Executor,
  input: {
    readonly fromUtc: Date;
    readonly toUtc: Date;
    readonly cutoff: Date;
    readonly ownerTypes: readonly string[];
    readonly limit: number;
  },
): Promise<ArchiveCandidate[]> {
  const rows = await executor
    .selectFrom('attachments_attachments as a')
    .select([
      'a.id as id',
      'a.owner_type as owner_type',
      'a.owner_id as owner_id',
      'a.kind as kind',
      'a.mime_type as mime_type',
      'a.size_bytes as size_bytes',
      'a.sha256 as sha256',
      'a.storage_key as storage_key',
      'a.captured_at as captured_at',
      SUBMITTED_AT.as('submitted_at'),
    ])
    .where('a.upload_status', '=', 'AVAILABLE')
    .where('a.storage_key', 'is not', null)
    .where('a.owner_type', 'in', [...input.ownerTypes])
    .where(SUBMITTED_AT, '>=', input.fromUtc)
    .where(SUBMITTED_AT, '<', input.toUtc)
    .where(SUBMITTED_AT, '<', input.cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('attachments_archive_items as i')
            .select(sql.lit(1).as('one'))
            .whereRef('i.held_attachment_id', '=', 'a.id'),
        ),
      ),
    )
    .orderBy(SUBMITTED_AT)
    .orderBy('a.id')
    .limit(input.limit)
    .execute();
  return rows.map((row) => ({
    attachmentId: fromBin(row.id),
    ownerType: row.owner_type,
    ownerId: fromBin(row.owner_id),
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storageKey: row.storage_key as string,
    capturedAt: row.captured_at,
    submittedAt: new Date(row.submitted_at),
  }));
}

export interface MonthAggregate {
  /** Mois local `AAAA-MM`. */
  readonly month: string;
  readonly files: number;
  readonly bytes: number;
  /** Dont reçues avant `cutoff`. */
  readonly oldFiles: number;
  readonly oldBytes: number;
}

/**
 * Pièces `AVAILABLE` encore sur le serveur (non vidées) par mois local de réception : le catalogue des périodes.
 * Agrégat SQL seul, sans état d'opération (jugé à la préparation du plan). Le mois est celui de Douala (UTC+1, fixe) :
 * `DATE_ADD(… INTERVAL 1 HOUR)` et non `CONVERT_TZ`, qui ne convertit plus au-delà de janvier 2038 (plage de TIMESTAMP).
 */
export async function serverMonthAggregates(
  executor: Executor,
  input: { readonly cutoff: Date },
): Promise<MonthAggregate[]> {
  const result = await sql<{
    month: string;
    files: string | number;
    bytes: string | number;
    old_files: string | number;
    old_bytes: string | number;
  }>`
    SELECT DATE_FORMAT(DATE_ADD(COALESCE(a.received_at, a.created_at), INTERVAL 1 HOUR), '%Y-%m') AS month,
           COUNT(*) AS files,
           COALESCE(SUM(a.size_bytes), 0) AS bytes,
           COALESCE(SUM(CASE WHEN COALESCE(a.received_at, a.created_at) < ${input.cutoff} THEN 1 ELSE 0 END), 0) AS old_files,
           COALESCE(SUM(CASE WHEN COALESCE(a.received_at, a.created_at) < ${input.cutoff} THEN a.size_bytes ELSE 0 END), 0) AS old_bytes
    FROM attachments_attachments a
    WHERE a.upload_status = 'AVAILABLE' AND a.storage_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM attachments_archive_items i WHERE i.attachment_id = a.id AND i.state = 'PURGED'
      )
    GROUP BY month
    ORDER BY month`.execute(executor);
  return result.rows.map((row) => ({
    month: row.month,
    files: Number(row.files),
    bytes: Number(row.bytes),
    oldFiles: Number(row.old_files),
    oldBytes: Number(row.old_bytes),
  }));
}

/** Pièces déjà vidées du serveur, par mois local de soumission. */
export async function purgedMonthAggregates(
  executor: Executor,
): Promise<{ month: string; files: number; bytes: number }[]> {
  const result = await sql<{ month: string; files: string | number; bytes: string | number }>`
    SELECT DATE_FORMAT(DATE_ADD(i.submitted_at, INTERVAL 1 HOUR), '%Y-%m') AS month,
           COUNT(*) AS files,
           COALESCE(SUM(i.size_bytes), 0) AS bytes
    FROM attachments_archive_items i
    WHERE i.state = 'PURGED'
    GROUP BY month
    ORDER BY month`.execute(executor);
  return result.rows.map((row) => ({
    month: row.month,
    files: Number(row.files),
    bytes: Number(row.bytes),
  }));
}

// -------------------------------------------------------------------------------------------------------------
// Plan : écriture
// -------------------------------------------------------------------------------------------------------------

export interface NewArchiveItem {
  readonly attachmentId: string;
  readonly entryPath: string;
  readonly category: ArchiveCategory;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly reference: string;
  readonly secondaryReference: string | null;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly capturedAt: Date;
  readonly submittedAt: Date;
}

export interface NewArchiveVolume {
  readonly id: string;
  readonly seq: number;
  readonly category: ArchiveCategory;
  /** Premier jour du mois local, `AAAA-MM-01`. */
  readonly monthStart: string;
  readonly part: number;
  readonly fileName: string;
  readonly filesBytes: number;
  readonly zipBytes: number;
  readonly items: readonly NewArchiveItem[];
}

export interface NewArchivePlan {
  readonly id: string;
  readonly granularity: ArchiveGranularity;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly cutoffAt: Date;
  readonly minAgeDays: number;
  readonly volumeMaxBytes: number;
  readonly retentionYears: number;
  readonly keptOpenCount: number;
  readonly absentCount: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly volumes: readonly NewArchiveVolume[];
}

const INSERT_BATCH = 500;

/** Écrit le plan (plan, volumes, photos) dans la transaction de l'appelant. */
export async function insertArchivePlan(trx: Transaction<DB>, plan: NewArchivePlan): Promise<void> {
  const fileCount = plan.volumes.reduce((sum, volume) => sum + volume.items.length, 0);
  const filesBytes = plan.volumes.reduce((sum, volume) => sum + volume.filesBytes, 0);
  await trx
    .insertInto('attachments_archives')
    .values({
      id: toBin(plan.id),
      granularity: plan.granularity,
      period_start: dateParam(plan.periodStart),
      period_end: dateParam(plan.periodEnd),
      cutoff_at: plan.cutoffAt,
      min_age_days: plan.minAgeDays,
      volume_max_bytes: plan.volumeMaxBytes,
      retention_years: plan.retentionYears,
      file_count: fileCount,
      files_bytes: filesBytes,
      kept_open_count: plan.keptOpenCount,
      absent_count: plan.absentCount,
      status: 'READY',
      created_at: plan.createdAt,
      created_by: toBin(plan.createdBy),
    })
    .execute();

  await trx
    .insertInto('attachments_archive_volumes')
    .values(
      plan.volumes.map((volume) => ({
        id: toBin(volume.id),
        archive_id: toBin(plan.id),
        seq: volume.seq,
        category: volume.category,
        month_start: dateParam(volume.monthStart),
        part: volume.part,
        file_name: volume.fileName,
        file_count: volume.items.length,
        files_bytes: volume.filesBytes,
        zip_bytes: volume.zipBytes,
        created_at: plan.createdAt,
      })),
    )
    .execute();

  for (const volume of plan.volumes) {
    for (let at = 0; at < volume.items.length; at += INSERT_BATCH) {
      await trx
        .insertInto('attachments_archive_items')
        .values(
          volume.items.slice(at, at + INSERT_BATCH).map((item) => ({
            archive_id: toBin(plan.id),
            attachment_id: toBin(item.attachmentId),
            volume_id: toBin(volume.id),
            entry_path: item.entryPath,
            category: item.category,
            owner_type: item.ownerType,
            owner_id: toBin(item.ownerId),
            reference: item.reference,
            secondary_reference: item.secondaryReference,
            kind: item.kind,
            mime_type: item.mimeType,
            size_bytes: item.sizeBytes,
            sha256: item.sha256,
            captured_at: item.capturedAt,
            submitted_at: item.submittedAt,
            state: 'PLANNED' as const,
            created_at: plan.createdAt,
          })),
        )
        .execute();
    }
  }
}

// -------------------------------------------------------------------------------------------------------------
// Lectures
// -------------------------------------------------------------------------------------------------------------

export interface ArchiveRecord {
  readonly id: string;
  readonly granularity: ArchiveGranularity;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly cutoffAt: Date;
  readonly minAgeDays: number;
  readonly volumeMaxBytes: number;
  readonly retentionYears: number;
  readonly fileCount: number;
  readonly filesBytes: number;
  readonly keptOpenCount: number;
  readonly absentCount: number;
  readonly status: ArchiveStatus;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface ArchiveVolumeRecord {
  readonly id: string;
  readonly archiveId: string;
  readonly seq: number;
  readonly category: ArchiveCategory;
  /** Mois local `AAAA-MM`. */
  readonly month: string;
  readonly part: number;
  readonly fileName: string;
  readonly fileCount: number;
  readonly filesBytes: number;
  readonly zipBytes: number;
  readonly zipSha256: string | null;
  readonly deliveries: number;
  readonly abortedDeliveries: number;
  readonly firstDeliveredAt: Date | null;
  readonly lastDeliveredAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  /** Photos du volume par état. */
  readonly planned: number;
  readonly purged: number;
  readonly released: number;
}

const ARCHIVE_COLUMNS = [
  'id',
  'granularity',
  'period_start',
  'period_end',
  'cutoff_at',
  'min_age_days',
  'volume_max_bytes',
  'retention_years',
  'file_count',
  'files_bytes',
  'kept_open_count',
  'absent_count',
  'status',
  'completed_at',
  'cancelled_at',
  'created_at',
  'created_by',
] as const;

function toArchiveRecord(row: {
  id: Buffer;
  granularity: string;
  period_start: Date;
  period_end: Date;
  cutoff_at: Date;
  min_age_days: number;
  volume_max_bytes: number;
  retention_years: number;
  file_count: number;
  files_bytes: number;
  kept_open_count: number;
  absent_count: number;
  status: string;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  created_by: Buffer;
}): ArchiveRecord {
  return {
    id: fromBin(row.id),
    granularity: row.granularity as ArchiveGranularity,
    periodStart: dateOnly(row.period_start),
    periodEnd: dateOnly(row.period_end),
    cutoffAt: row.cutoff_at,
    minAgeDays: row.min_age_days,
    volumeMaxBytes: Number(row.volume_max_bytes),
    retentionYears: row.retention_years,
    fileCount: row.file_count,
    filesBytes: Number(row.files_bytes),
    keptOpenCount: row.kept_open_count,
    absentCount: row.absent_count,
    status: row.status as ArchiveStatus,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    createdBy: fromBin(row.created_by),
  };
}

export async function getArchive(
  executor: Executor,
  archiveId: string,
): Promise<ArchiveRecord | undefined> {
  const row = await executor
    .selectFrom('attachments_archives')
    .select([...ARCHIVE_COLUMNS])
    .where('id', '=', toBin(archiveId))
    .executeTakeFirst();
  return row ? toArchiveRecord(row) : undefined;
}

/** Plans les plus récents d'abord. */
export async function listArchives(executor: Executor, limit: number): Promise<ArchiveRecord[]> {
  const rows = await executor
    .selectFrom('attachments_archives')
    .select([...ARCHIVE_COLUMNS])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toArchiveRecord);
}

/** Plans vivants (`READY`) : un par période au plus (clé unique). */
export async function listLivePlans(
  executor: Executor,
): Promise<{ id: string; granularity: ArchiveGranularity; periodStart: string }[]> {
  const rows = await executor
    .selectFrom('attachments_archives')
    .select(['id', 'granularity', 'period_start'])
    .where('status', '=', 'READY')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    granularity: row.granularity as ArchiveGranularity,
    periodStart: dateOnly(row.period_start),
  }));
}

const VOLUME_COLUMNS = [
  'id',
  'archive_id',
  'seq',
  'category',
  'month_start',
  'part',
  'file_name',
  'file_count',
  'files_bytes',
  'zip_bytes',
  'zip_sha256',
  'deliveries',
  'aborted_deliveries',
  'first_delivered_at',
  'last_delivered_at',
  'verified_at',
  'resolved_at',
  'created_at',
] as const;

type VolumeRow = {
  id: Buffer;
  archive_id: Buffer;
  seq: number;
  category: string;
  month_start: Date;
  part: number;
  file_name: string;
  file_count: number;
  files_bytes: number;
  zip_bytes: number;
  zip_sha256: string | null;
  deliveries: number;
  aborted_deliveries: number;
  first_delivered_at: Date | null;
  last_delivered_at: Date | null;
  verified_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
};

function toVolumeRecord(
  row: VolumeRow,
  counts: { planned: number; purged: number; released: number },
): ArchiveVolumeRecord {
  return {
    id: fromBin(row.id),
    archiveId: fromBin(row.archive_id),
    seq: row.seq,
    category: row.category as ArchiveCategory,
    month: dateOnly(row.month_start).slice(0, 7),
    part: row.part,
    fileName: row.file_name,
    fileCount: row.file_count,
    filesBytes: Number(row.files_bytes),
    zipBytes: Number(row.zip_bytes),
    zipSha256: row.zip_sha256,
    deliveries: row.deliveries,
    abortedDeliveries: row.aborted_deliveries,
    firstDeliveredAt: row.first_delivered_at,
    lastDeliveredAt: row.last_delivered_at,
    verifiedAt: row.verified_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    ...counts,
  };
}

async function itemCountsByVolume(
  executor: Executor,
  volumeIds: readonly Buffer[],
): Promise<Map<string, { planned: number; purged: number; released: number }>> {
  const counts = new Map<string, { planned: number; purged: number; released: number }>();
  if (volumeIds.length === 0) return counts;
  const rows = await executor
    .selectFrom('attachments_archive_items')
    .select(['volume_id', 'state', sql<string>`COUNT(*)`.as('n')])
    .where('volume_id', 'in', [...volumeIds])
    .groupBy(['volume_id', 'state'])
    .execute();
  for (const row of rows) {
    const key = fromBin(row.volume_id);
    const entry = counts.get(key) ?? { planned: 0, purged: 0, released: 0 };
    const n = Number(row.n);
    if (row.state === 'PLANNED') entry.planned += n;
    else if (row.state === 'PURGED') entry.purged += n;
    else entry.released += n;
    counts.set(key, entry);
  }
  return counts;
}

/** Volumes de plusieurs plans, avec le nombre de photos par état, dans l'ordre des plans puis des volumes. */
export async function listVolumes(
  executor: Executor,
  archiveIds: readonly string[],
): Promise<ArchiveVolumeRecord[]> {
  if (archiveIds.length === 0) return [];
  const rows = await executor
    .selectFrom('attachments_archive_volumes')
    .select([...VOLUME_COLUMNS])
    .where(
      'archive_id',
      'in',
      archiveIds.map((id) => toBin(id)),
    )
    .orderBy('archive_id')
    .orderBy('seq')
    .execute();
  const counts = await itemCountsByVolume(
    executor,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    toVolumeRecord(row, counts.get(fromBin(row.id)) ?? { planned: 0, purged: 0, released: 0 }),
  );
}

export async function getVolume(
  executor: Executor,
  volumeId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ArchiveVolumeRecord | undefined> {
  const query = executor
    .selectFrom('attachments_archive_volumes')
    .select([...VOLUME_COLUMNS])
    .where('id', '=', toBin(volumeId));
  const row = await (options.forUpdate ? query.forUpdate() : query).executeTakeFirst();
  if (!row) return undefined;
  const counts = await itemCountsByVolume(executor, [row.id]);
  return toVolumeRecord(row, counts.get(volumeId) ?? { planned: 0, purged: 0, released: 0 });
}

export interface ArchiveItemRecord {
  readonly archiveId: string;
  readonly attachmentId: string;
  readonly volumeId: string;
  readonly entryPath: string;
  readonly category: ArchiveCategory;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly reference: string;
  readonly secondaryReference: string | null;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly capturedAt: Date;
  readonly submittedAt: Date;
  readonly state: ArchiveItemState;
  readonly resolvedAt: Date | null;
  readonly storageKey: string | null;
  /** État actuel de la pièce elle-même (relu au vidage : elle ne doit pas avoir changé depuis le plan). */
  readonly currentUploadStatus: string;
  readonly currentSha256: string;
  readonly currentSizeBytes: number;
}

const ITEM_COLUMNS = [
  'i.archive_id as archive_id',
  'i.attachment_id as attachment_id',
  'i.volume_id as volume_id',
  'i.entry_path as entry_path',
  'i.category as category',
  'i.owner_type as owner_type',
  'i.owner_id as owner_id',
  'i.reference as reference',
  'i.secondary_reference as secondary_reference',
  'i.kind as kind',
  'i.mime_type as mime_type',
  'i.size_bytes as size_bytes',
  'i.sha256 as sha256',
  'i.captured_at as captured_at',
  'i.submitted_at as submitted_at',
  'i.state as state',
  'i.resolved_at as resolved_at',
  'a.storage_key as storage_key',
  'a.upload_status as current_upload_status',
  'a.sha256 as current_sha256',
  'a.size_bytes as current_size_bytes',
] as const;

function toItemRecord(row: {
  archive_id: Buffer;
  attachment_id: Buffer;
  volume_id: Buffer;
  entry_path: string;
  category: string;
  owner_type: string;
  owner_id: Buffer;
  reference: string;
  secondary_reference: string | null;
  kind: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  captured_at: Date;
  submitted_at: Date;
  state: string;
  resolved_at: Date | null;
  storage_key: string | null;
  current_upload_status: string;
  current_sha256: string;
  current_size_bytes: number;
}): ArchiveItemRecord {
  return {
    archiveId: fromBin(row.archive_id),
    attachmentId: fromBin(row.attachment_id),
    volumeId: fromBin(row.volume_id),
    entryPath: row.entry_path,
    category: row.category as ArchiveCategory,
    ownerType: row.owner_type,
    ownerId: fromBin(row.owner_id),
    reference: row.reference,
    secondaryReference: row.secondary_reference,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    capturedAt: row.captured_at,
    submittedAt: row.submitted_at,
    state: row.state as ArchiveItemState,
    resolvedAt: row.resolved_at,
    storageKey: row.storage_key,
    currentUploadStatus: row.current_upload_status,
    currentSha256: row.current_sha256,
    currentSizeBytes: row.current_size_bytes,
  };
}

/**
 * Photos d'un volume dans l'ordre du fichier (soumission puis identifiant), avec la clé de stockage de la pièce.
 * `states` limite aux photos dans ces états (`PLANNED` pour fabriquer ou vider).
 */
export async function listVolumeItems(
  executor: Executor,
  volumeId: string,
  options: { readonly states?: readonly ArchiveItemState[]; readonly limit?: number } = {},
): Promise<ArchiveItemRecord[]> {
  let query = executor
    .selectFrom('attachments_archive_items as i')
    .innerJoin('attachments_attachments as a', 'a.id', 'i.attachment_id')
    .select([...ITEM_COLUMNS])
    .where('i.volume_id', '=', toBin(volumeId));
  if (options.states) query = query.where('i.state', 'in', [...options.states]);
  query = query.orderBy('i.submitted_at').orderBy('i.attachment_id');
  if (options.limit !== undefined) query = query.limit(options.limit);
  return (await query.execute()).map(toItemRecord);
}

/** Élément d'archive qui couvre une pièce (prévu ou vidé) : explique son absence du disque. */
export async function archivedItemOfAttachment(
  executor: Executor,
  attachmentId: string,
): Promise<
  | {
      readonly state: ArchiveItemState;
      readonly resolvedAt: Date | null;
      readonly archiveCreatedAt: Date;
      readonly reference: string;
      readonly entryPath: string;
      readonly volumeFileName: string;
    }
  | undefined
> {
  const row = await executor
    .selectFrom('attachments_archive_items as i')
    .innerJoin('attachments_archive_volumes as v', 'v.id', 'i.volume_id')
    .innerJoin('attachments_archives as r', 'r.id', 'i.archive_id')
    .select([
      'i.state as state',
      'i.resolved_at as resolved_at',
      'r.created_at as archive_created_at',
      'i.reference as reference',
      'i.entry_path as entry_path',
      'v.file_name as volume_file_name',
    ])
    .where('i.held_attachment_id', '=', toBin(attachmentId))
    .executeTakeFirst();
  return row
    ? {
        state: row.state as ArchiveItemState,
        resolvedAt: row.resolved_at,
        archiveCreatedAt: row.archive_created_at,
        reference: row.reference,
        entryPath: row.entry_path,
        volumeFileName: row.volume_file_name,
      }
    : undefined;
}

// -------------------------------------------------------------------------------------------------------------
// Livraison, vérification
// -------------------------------------------------------------------------------------------------------------

/**
 * Livraison complète d'un volume : le serveur a écrit la réponse entière (ADR-070 §7). L'empreinte suit la dernière
 * livraison ; si elle change, la vérification de l'Admin ne vaut plus (`hashChanged`).
 */
export async function recordVolumeDelivered(
  trx: Transaction<DB>,
  input: {
    readonly volumeId: string;
    readonly sha256: string;
    readonly at: Date;
    readonly by: string;
  },
): Promise<{ readonly hashChanged: boolean; readonly previousSha256: string | null }> {
  const current = await trx
    .selectFrom('attachments_archive_volumes')
    .select(['zip_sha256', 'first_delivered_at'])
    .where('id', '=', toBin(input.volumeId))
    .forUpdate()
    .executeTakeFirstOrThrow();
  const hashChanged = current.zip_sha256 !== null && current.zip_sha256 !== input.sha256;
  await trx
    .updateTable('attachments_archive_volumes')
    .set({
      zip_sha256: input.sha256,
      deliveries: sql<number>`deliveries + 1`,
      first_delivered_at: current.first_delivered_at ?? input.at,
      last_delivered_at: input.at,
      last_delivered_by: toBin(input.by),
      ...(hashChanged ? { verified_at: null, verified_by: null } : {}),
    })
    .where('id', '=', toBin(input.volumeId))
    .execute();
  return { hashChanged, previousSha256: current.zip_sha256 };
}

export async function recordVolumeAborted(trx: Transaction<DB>, volumeId: string): Promise<void> {
  await trx
    .updateTable('attachments_archive_volumes')
    .set({ aborted_deliveries: sql<number>`aborted_deliveries + 1` })
    .where('id', '=', toBin(volumeId))
    .execute();
}

export async function recordVolumeVerified(
  trx: Transaction<DB>,
  input: { readonly volumeId: string; readonly at: Date; readonly by: string },
): Promise<void> {
  await trx
    .updateTable('attachments_archive_volumes')
    .set({ verified_at: input.at, verified_by: toBin(input.by) })
    .where('id', '=', toBin(input.volumeId))
    .execute();
}

// -------------------------------------------------------------------------------------------------------------
// Résolution : vidage et annulation
// -------------------------------------------------------------------------------------------------------------

/** Passe des photos prévues à vidées (le fichier vient d'être supprimé du stockage par l'appelant). */
export async function markItemsPurged(
  trx: Transaction<DB>,
  input: {
    readonly volumeId: string;
    readonly attachmentIds: readonly string[];
    readonly at: Date;
  },
): Promise<void> {
  if (input.attachmentIds.length === 0) return;
  await trx
    .updateTable('attachments_archive_items')
    .set({ state: 'PURGED', resolved_at: input.at })
    .where('volume_id', '=', toBin(input.volumeId))
    .where('state', '=', 'PLANNED')
    .where(
      'attachment_id',
      'in',
      input.attachmentIds.map((id) => toBin(id)),
    )
    .execute();
}

/** Libère des photos prévues : elles restent sur le serveur et pourront entrer dans un autre plan. */
export async function markItemsReleased(
  trx: Transaction<DB>,
  input: {
    readonly volumeId: string;
    readonly attachmentIds: readonly string[];
    readonly reason: ArchiveReleaseReason;
    readonly at: Date;
  },
): Promise<void> {
  if (input.attachmentIds.length === 0) return;
  await trx
    .updateTable('attachments_archive_items')
    .set({ state: 'RELEASED', resolved_at: input.at, release_reason: input.reason })
    .where('volume_id', '=', toBin(input.volumeId))
    .where('state', '=', 'PLANNED')
    .where(
      'attachment_id',
      'in',
      input.attachmentIds.map((id) => toBin(id)),
    )
    .execute();
}

/** Le volume est résolu quand plus aucune de ses photos n'est prévue. Rend vrai s'il vient de l'être. */
export async function resolveVolumeIfDone(
  trx: Transaction<DB>,
  input: { readonly volumeId: string; readonly at: Date; readonly by: string },
): Promise<boolean> {
  const left = await trx
    .selectFrom('attachments_archive_items')
    .select('attachment_id')
    .where('volume_id', '=', toBin(input.volumeId))
    .where('state', '=', 'PLANNED')
    .limit(1)
    .executeTakeFirst();
  if (left) return false;
  const result = await trx
    .updateTable('attachments_archive_volumes')
    .set({ resolved_at: input.at, resolved_by: toBin(input.by) })
    .where('id', '=', toBin(input.volumeId))
    .where('resolved_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Le plan est terminé quand tous ses volumes le sont. Rend vrai s'il vient de passer `COMPLETED`. */
export async function completeArchiveIfDone(
  trx: Transaction<DB>,
  input: { readonly archiveId: string; readonly at: Date },
): Promise<boolean> {
  const open = await trx
    .selectFrom('attachments_archive_volumes')
    .select('id')
    .where('archive_id', '=', toBin(input.archiveId))
    .where('resolved_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  if (open) return false;
  const result = await trx
    .updateTable('attachments_archives')
    .set({ status: 'COMPLETED', completed_at: input.at })
    .where('id', '=', toBin(input.archiveId))
    .where('status', '=', 'READY')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Verrouille la ligne du plan (deux annulations ou vidages ne se croisent pas). */
export async function lockArchive(
  trx: Transaction<DB>,
  archiveId: string,
): Promise<ArchiveRecord | undefined> {
  const row = await trx
    .selectFrom('attachments_archives')
    .select([...ARCHIVE_COLUMNS])
    .where('id', '=', toBin(archiveId))
    .forUpdate()
    .executeTakeFirst();
  return row ? toArchiveRecord(row) : undefined;
}

/** Nombre de photos déjà vidées d'un plan. */
export async function countPurgedItems(executor: Executor, archiveId: string): Promise<number> {
  const row = await executor
    .selectFrom('attachments_archive_items')
    .select(sql<string>`COUNT(*)`.as('n'))
    .where('archive_id', '=', toBin(archiveId))
    .where('state', '=', 'PURGED')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Annule un plan dont rien n'a été vidé : ses photos sont libérées, ses volumes soldés. */
export async function cancelArchivePlan(
  trx: Transaction<DB>,
  input: { readonly archiveId: string; readonly at: Date; readonly by: string },
): Promise<{ readonly released: number }> {
  const released = await trx
    .updateTable('attachments_archive_items')
    .set({ state: 'RELEASED', resolved_at: input.at, release_reason: 'ARCHIVE_CANCELLED' })
    .where('archive_id', '=', toBin(input.archiveId))
    .where('state', '=', 'PLANNED')
    .executeTakeFirst();
  await trx
    .updateTable('attachments_archive_volumes')
    .set({ resolved_at: input.at, resolved_by: toBin(input.by) })
    .where('archive_id', '=', toBin(input.archiveId))
    .where('resolved_at', 'is', null)
    .execute();
  await trx
    .updateTable('attachments_archives')
    .set({ status: 'CANCELLED', cancelled_at: input.at, cancelled_by: toBin(input.by) })
    .where('id', '=', toBin(input.archiveId))
    .where('status', '=', 'READY')
    .execute();
  return { released: Number(released.numUpdatedRows) };
}
