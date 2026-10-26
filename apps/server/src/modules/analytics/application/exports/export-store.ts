/**
 * Tâches d'export (P9-20 ; ADR-077 §3 et §6, dictionnaire `analytics.export_jobs`) : le module `analytics` est le
 * seul à écrire `analytics_export_jobs`. Une ligne naît `QUEUED` avec la définition **telle que validée à la demande**
 * et la version du catalogue ; la tâche `analytics.export.run` la termine `DONE` ou `FAILED` (jamais en levant pour un
 * échec métier) ; la purge la passe `EXPIRED` à l'échéance `expires_at` (24 h après la demande, immuable : trigger). La ligne n'est jamais supprimée : elle
 * est la trace de l'export (BR-ANA-008).
 *
 * Les contraintes de la base garantissent la cohérence : `DONE` exige un fichier et un nombre de lignes, `FAILED` un
 * code d'erreur, `finished_at` n'est posé qu'à l'état final.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'EXPIRED';
export type ExportFormat = 'CSV' | 'XLSX';

export interface StoredExport {
  readonly id: string;
  readonly requestedBy: string;
  readonly dataset: string;
  readonly definition: unknown;
  readonly format: ExportFormat;
  readonly status: ExportStatus;
  readonly rowCount: number | null;
  readonly durationMs: number | null;
  readonly storageKey: string | null;
  readonly catalogVersion: number;
  readonly errorCode: string | null;
  readonly commandId: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

const COLUMNS = [
  'id',
  'requested_by',
  'dataset',
  'definition',
  'format',
  'status',
  'row_count',
  'duration_ms',
  'storage_key',
  'catalog_version',
  'error_code',
  'command_id',
  'expires_at',
  'created_at',
  'finished_at',
] as const;

interface ExportRow {
  readonly id: Buffer;
  readonly requested_by: Buffer;
  readonly dataset: string;
  readonly definition: unknown;
  readonly format: string;
  readonly status: string;
  readonly row_count: number | null;
  readonly duration_ms: number | null;
  readonly storage_key: string | null;
  readonly catalog_version: number;
  readonly error_code: string | null;
  readonly command_id: Buffer | null;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly finished_at: Date | null;
}

const exportOf = (row: ExportRow): StoredExport => ({
  id: fromBin(row.id),
  requestedBy: fromBin(row.requested_by),
  dataset: row.dataset,
  definition: row.definition,
  format: row.format as ExportFormat,
  status: row.status as ExportStatus,
  rowCount: row.row_count,
  durationMs: row.duration_ms,
  storageKey: row.storage_key,
  catalogVersion: row.catalog_version,
  errorCode: row.error_code,
  commandId: row.command_id === null ? null : fromBin(row.command_id),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

/** Clé du fichier d'un export dans le stockage. */
export const exportStorageKey = (exportId: string): string => `exports/${exportId}`;

export async function readExport(
  executor: Executor,
  id: string,
): Promise<StoredExport | undefined> {
  const row = await executor
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row === undefined ? undefined : exportOf(row as ExportRow);
}

/** L'export verrouillé en écriture (début de la tâche de calcul). */
export async function lockExport(
  uow: Transaction<DB>,
  id: string,
): Promise<StoredExport | undefined> {
  const row = await uow
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('id', '=', toBin(id))
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : exportOf(row as ExportRow);
}

export async function insertExport(
  uow: Transaction<DB>,
  input: {
    readonly id: string;
    readonly requestedBy: string;
    readonly dataset: string;
    readonly definition: unknown;
    readonly format: ExportFormat;
    readonly catalogVersion: number;
    readonly commandId: string;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await uow
    .insertInto('analytics_export_jobs')
    .values({
      id: toBin(input.id),
      requested_by: toBin(input.requestedBy),
      dataset: input.dataset,
      definition: jsonValue(input.definition),
      format: input.format,
      status: 'QUEUED',
      catalog_version: input.catalogVersion,
      command_id: toBinOrNull(input.commandId),
      expires_at: input.expiresAt,
    })
    .execute();
}

/** Nombre d'exports du demandeur encore en file ou en cours (garde-fou de la demande). */
export async function pendingExportCount(executor: Executor, userId: string): Promise<number> {
  const row = await executor
    .selectFrom('analytics_export_jobs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('requested_by', '=', toBin(userId))
    .where('status', 'in', ['QUEUED', 'RUNNING'])
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function markExportDone(
  uow: Transaction<DB>,
  input: {
    readonly id: string;
    readonly rowCount: number;
    readonly durationMs: number;
    readonly storageKey: string;
    readonly finishedAt: Date;
  },
): Promise<void> {
  await uow
    .updateTable('analytics_export_jobs')
    .set({
      status: 'DONE',
      row_count: input.rowCount,
      duration_ms: input.durationMs,
      storage_key: input.storageKey,
      error_code: null,
      finished_at: input.finishedAt,
    })
    .where('id', '=', toBin(input.id))
    .execute();
}

export async function markExportFailed(
  uow: Transaction<DB>,
  input: {
    readonly id: string;
    readonly errorCode: string;
    readonly durationMs: number;
    readonly finishedAt: Date;
  },
): Promise<void> {
  await uow
    .updateTable('analytics_export_jobs')
    .set({
      status: 'FAILED',
      error_code: input.errorCode.slice(0, 60),
      duration_ms: input.durationMs,
      storage_key: null,
      row_count: null,
      finished_at: input.finishedAt,
    })
    .where('id', '=', toBin(input.id))
    .execute();
}

/** Les exports `DONE` dont le fichier est périmé à `at` (purge : fichier supprimé, ligne passée `EXPIRED`). */
export async function expiredDoneExports(
  executor: Executor,
  at: Date,
  limit: number,
): Promise<readonly StoredExport[]> {
  const rows = await executor
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('status', '=', 'DONE')
    .where('expires_at', '<=', at)
    .orderBy('expires_at')
    .limit(limit)
    .execute();
  return rows.map((row) => exportOf(row as ExportRow));
}

export async function markExportExpired(uow: Transaction<DB>, id: string): Promise<void> {
  await uow
    .updateTable('analytics_export_jobs')
    .set({ status: 'EXPIRED' })
    .where('id', '=', toBin(id))
    .where('status', '=', 'DONE')
    .execute();
}

/** Les exports encore en file ou en cours créés avant `before` : leur tâche est perdue (rejeux épuisés). */
export async function abandonedExports(
  executor: Executor,
  before: Date,
  limit: number,
): Promise<readonly StoredExport[]> {
  const rows = await executor
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('status', 'in', ['QUEUED', 'RUNNING'])
    .where('created_at', '<', before)
    .orderBy('created_at')
    .limit(limit)
    .execute();
  return rows.map((row) => exportOf(row as ExportRow));
}

/** Les exports expirés créés dans `[from, to[` : leur fichier est à supprimer (purge des fichiers). */
export async function expiredExportsCreatedBetween(
  executor: Executor,
  from: Date,
  to: Date,
  limit: number,
): Promise<readonly StoredExport[]> {
  const rows = await executor
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('status', '=', 'EXPIRED')
    .where('created_at', '>=', from)
    .where('created_at', '<', to)
    .orderBy('created_at')
    .limit(limit)
    .execute();
  return rows.map((row) => exportOf(row as ExportRow));
}

/** Les exports du demandeur, du plus récent au plus ancien (jamais ceux d'un autre). */
export async function exportsPage(
  executor: Executor,
  input: { readonly userId: string; readonly limit: number },
): Promise<readonly StoredExport[]> {
  const rows = await executor
    .selectFrom('analytics_export_jobs')
    .select(COLUMNS)
    .where('requested_by', '=', toBin(input.userId))
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(input.limit)
    .execute();
  return rows.map((row) => exportOf(row as ExportRow));
}
