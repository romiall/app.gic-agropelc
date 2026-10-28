/**
 * Calcul d'un export (P9-20 ; ADR-067 §3 à §8, BR-ANA-008, AT-046) : tâche `analytics.export.run`, exécutée par le
 * worker dans la transaction de la tâche.
 *
 * - **Ne lève jamais pour un échec métier** : droit retiré, définition devenue obsolète, limite de lignes ou de durée,
 *   étendue tronquée — la ligne passe `FAILED` avec son `error_code` et la tâche rend normalement (sinon la
 *   transaction serait annulée et la tâche rejouée cinq fois). Seule une erreur technique (base, stockage) lève, et
 *   la tâche est rejouée : le fichier partiel est alors supprimé avant la nouvelle écriture. Au dernier essai,
 *   `runExportJob` ne laisse plus l'erreur remonter : l'export passe `FAILED` / `EXPORT_JOB_FAILED` (P9-25, PF-6).
 * - **Droits revérifiés à l'instant du calcul** : compte actif, `analytics.export`, jeu lisible, mesure au coût
 *   réservée à `inventory.valuation.read` (la demande les a vérifiés une première fois), puis l'étendue exacte de
 *   chaque permission de lecture (jamais plus large que celle de l'écran).
 * - **Jamais de fichier tronqué** : plus de `analytics.export_max_rows` lignes (100 000) ou plus de
 *   `analytics.export_max_seconds` secondes (120) : `FAILED` `QUERY_LIMIT_EXCEEDED` ; une étendue exacte tronquée
 *   faute de place (`scopeMaxCandidates`) : `FAILED` `SCOPE_TRUNCATED` (un export partiel serait trompeur).
 * - **Fichier** : clé `exports/<id>`, écrit par morceaux de 256 Kio (`appendChunk`, séquentiel) ; valable jusqu'à
 *   l'échéance de la ligne (`analytics.export_file_hours` heures après la demande, immuable).
 * - **Audit et événement** : une ligne d'audit et `AnalyticsExportCompleted` à la fin, quelle qu'en soit l'issue.
 */
import type { Logger } from '@nestjs/common';
import { explorationDefinitionSchema } from '@gic/contracts';
import {
  ANALYTICS_CATALOG_VERSION,
  type Clock,
  type ExplorationPlan,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import { recordAudit } from '../../../../audit/record-audit.js';
import type { JobAttemptContext } from '../../../../platform/jobs/job-handler-registry.js';
import type { ChunkStorage } from '../../../../platform/storage/chunk-storage.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { checkUserActive, hasPermissionAt } from '../../../identity/application/public/index.js';
import { compileExploration, type ExplorationValue } from '../query/compile-exploration.js';
import { readExplorerLimits } from '../query/limits.js';
import { zoneDescendantsOf } from '../query/zone-filters.js';
import { ExplorationLimitError, executeExploration } from '../query/run-exploration.js';
import { explorationDefinitionFrom } from '../query/exploration-definition.js';
import { resolveExactScope, type ExactScope } from '../scope/exact-scope.js';
import { VALUATION_PERMISSION, validateExplorationForUser } from '../query/validate-for-user.js';
import { csvHeader, csvRows } from './csv-writer.js';
import { publishExportEvent } from './export-events.js';
import { readExportSettings } from './export-settings.js';
import {
  exportStorageKey,
  lockExport,
  markExportDone,
  markExportFailed,
  type StoredExport,
} from './export-store.js';
import { buildXlsx } from './xlsx-writer.js';

export const EXPORT_PERMISSION = 'analytics.export';
/** Taille d'un morceau écrit dans le stockage (le port d'upload en utilise autant, ADR-012). */
export const EXPORT_CHUNK_BYTES = 256 * 1024;
/** Lignes mises en forme d'un coup pour le CSV. */
const CSV_BATCH_ROWS = 2_000;

export interface RunExportDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly storage: ChunkStorage;
}

export type RunExportOutcome =
  | { readonly status: 'SKIPPED' }
  | { readonly status: 'DONE'; readonly rowCount: number }
  | { readonly status: 'FAILED'; readonly errorCode: string };

/** Écrit un contenu par morceaux dans le stockage, après avoir supprimé un éventuel fichier partiel. */
async function writeInChunks(
  storage: ChunkStorage,
  key: string,
  parts: Iterable<Buffer>,
): Promise<number> {
  await storage.delete(key);
  let offset = 0;
  for (const part of parts) {
    for (let start = 0; start < part.length; start += EXPORT_CHUNK_BYTES) {
      offset = await storage.appendChunk(
        key,
        offset,
        part.subarray(start, start + EXPORT_CHUNK_BYTES),
      );
    }
  }
  return offset;
}

function* csvParts(
  columns: Parameters<typeof csvHeader>[0],
  rows: readonly Record<string, ExplorationValue>[],
): Generator<Buffer> {
  yield Buffer.from(csvHeader(columns), 'utf8');
  for (let start = 0; start < rows.length; start += CSV_BATCH_ROWS) {
    yield Buffer.from(csvRows(columns, rows.slice(start, start + CSV_BATCH_ROWS)), 'utf8');
  }
}

/** Les permissions dont l'étendue exacte borne les lignes de l'export (jeu, et valeur au coût si une mesure l'exige). */
function readPermissions(plan: ExplorationPlan): readonly string[] {
  return [
    ...new Set([
      ...plan.dataset.permissions,
      ...(plan.measures.some((measure) => measure.protected === true)
        ? [VALUATION_PERMISSION]
        : []),
    ]),
  ];
}

export async function runExport(
  uow: UnitOfWork,
  deps: RunExportDeps,
  exportId: string,
): Promise<RunExportOutcome> {
  const job = await lockExport(uow, exportId);
  if (job === undefined || (job.status !== 'QUEUED' && job.status !== 'RUNNING')) {
    return { status: 'SKIPPED' };
  }
  const startedAt = deps.clock.now();
  const clockStart = process.hrtime.bigint();
  const elapsedMs = (): number => Number((process.hrtime.bigint() - clockStart) / 1_000_000n);
  const settings = await readExportSettings(uow, startedAt);
  const key = exportStorageKey(job.id);

  const conclude = (
    outcome:
      | { readonly status: 'DONE'; readonly rowCount: number }
      | { readonly status: 'FAILED'; readonly errorCode: string },
  ): Promise<RunExportOutcome> => concludeExport(uow, deps, job, outcome, elapsedMs());

  const rights = await revalidateRights(uow, job, startedAt);
  if (rights !== null) return conclude({ status: 'FAILED', errorCode: rights });

  const parsed = explorationDefinitionSchema.safeParse(job.definition);
  if (!parsed.success)
    return conclude({ status: 'FAILED', errorCode: 'ANALYTICS_DEFINITION_INVALID' });
  const definition = explorationDefinitionFrom(parsed.data);
  const validation = await validateExplorationForUser(uow, {
    userId: job.requestedBy,
    definition,
    at: startedAt,
    maxRows: settings.maxRows,
  });
  if (!validation.ok) return conclude({ status: 'FAILED', errorCode: validation.code });

  const limits = await readExplorerLimits(uow, startedAt);
  const scopes: ExactScope[] = [];
  for (const permission of readPermissions(validation.plan)) {
    scopes.push(
      await resolveExactScope(
        uow,
        { userId: job.requestedBy, permission, at: startedAt },
        { maxCandidates: limits.scopeMaxCandidates },
      ),
    );
  }
  if (scopes.some((scope) => scope.kind === 'CLAUSES' && scope.truncated)) {
    return conclude({ status: 'FAILED', errorCode: 'SCOPE_TRUNCATED' });
  }

  const maxExecutionMs = settings.maxSeconds * 1000;
  let result;
  try {
    const compiled = compileExploration(validation.plan, scopes, {
      maxExecutionMs,
      zoneDescendants: await zoneDescendantsOf(uow, validation.plan),
    });
    // L'export ne lit jamais le total : ne pas l'exécuter garde le budget de temps pour les lignes (EP-2).
    result = await executeExploration(
      uow,
      { ...compiled, totals: null },
      { maxRows: settings.maxRows, maxExecutionMs },
    );
  } catch (error) {
    if (error instanceof ExplorationLimitError) {
      return conclude({ status: 'FAILED', errorCode: 'QUERY_LIMIT_EXCEEDED' });
    }
    throw error;
  }

  if (job.format === 'CSV') {
    await writeInChunks(deps.storage, key, csvParts(result.columns, result.rows));
  } else {
    const workbook = await buildXlsx(result.columns, result.rows, `Export ${job.dataset}`);
    await writeInChunks(deps.storage, key, [workbook]);
  }
  return conclude({ status: 'DONE', rowCount: result.rowCount });
}

/**
 * Conclut l'export `job` : le fichier (supprimé si l'issue est un échec), la ligne (`DONE` ou `FAILED`), l'audit et
 * `AnalyticsExportCompleted` (le demandeur est prévenu). `durationMs` est la durée mesurée par l'appelant.
 *
 * `lateFileDeletion` (repli du dernier essai, `EXPORT_JOB_FAILED`) : le stockage est alors souvent la cause de
 * l'échec, et sa suppression lèverait la même erreur. La base est donc conclue **d'abord**, puis le fichier est
 * supprimé « au mieux » (l'échec est journalisé, jamais relevé) ; la purge supprime de toute façon le fichier d'un
 * export `FAILED`. Sans cette option, l'ordre d'origine est conservé (fichier puis ligne).
 */
export async function concludeExport(
  uow: UnitOfWork,
  deps: RunExportDeps,
  job: StoredExport,
  outcome:
    | { readonly status: 'DONE'; readonly rowCount: number }
    | { readonly status: 'FAILED'; readonly errorCode: string },
  durationMs: number,
  lateFileDeletion?: Pick<Logger, 'error'>,
): Promise<RunExportOutcome> {
  const finishedAt = deps.clock.now();
  const key = exportStorageKey(job.id);
  if (outcome.status === 'DONE') {
    await markExportDone(uow, {
      id: job.id,
      rowCount: outcome.rowCount,
      durationMs,
      storageKey: key,
      finishedAt,
    });
  } else {
    if (lateFileDeletion === undefined) await deps.storage.delete(key);
    await markExportFailed(uow, {
      id: job.id,
      errorCode: outcome.errorCode,
      durationMs,
      finishedAt,
    });
  }
  await recordAudit(uow, deps, {
    occurredAt: finishedAt,
    actorUserId: job.requestedBy,
    actorRoles: [],
    action: 'analytics.export.completed',
    entityType: 'ANALYTICS_EXPORT',
    entityId: job.id,
    after: {
      dataset: job.dataset,
      format: job.format,
      definition: job.definition,
      catalog_version: job.catalogVersion,
      status: outcome.status,
      ...(outcome.status === 'DONE'
        ? { row_count: outcome.rowCount }
        : { error_code: outcome.errorCode }),
      duration_ms: durationMs,
    },
    result: outcome.status === 'DONE' ? 'SUCCESS' : 'FAILED',
    errorCode: outcome.status === 'FAILED' ? outcome.errorCode : null,
  });
  await publishExportEvent(uow, deps, {
    eventType: 'AnalyticsExportCompleted',
    exportId: job.id,
    occurredAt: finishedAt,
    commandId: null,
    payload: {
      export_id: job.id,
      requested_by: job.requestedBy,
      dataset: job.dataset,
      format: job.format,
      status: outcome.status,
      ...(outcome.status === 'DONE'
        ? { row_count: outcome.rowCount }
        : { error_code: outcome.errorCode }),
    },
  });
  if (outcome.status === 'FAILED' && lateFileDeletion !== undefined) {
    try {
      await deps.storage.delete(key);
    } catch (error) {
      lateFileDeletion.error(
        `Export ${job.id} : fichier partiel non supprimé (${errorKindOf(error)}) ; la purge le supprimera.`,
      );
    }
  }
  return outcome;
}

/** Code d'échec d'un export dont la tâche a épuisé ses essais sur une erreur technique (P9-25, PF-6, AV-469). */
export const EXPORT_JOB_FAILED = 'EXPORT_JOB_FAILED';

/**
 * Tâche `analytics.export.run` avec l'essai en cours (P9-25, PF-6 ; AV-469). Avant le dernier essai, ou sans contexte,
 * c'est `runExport` : l'erreur technique remonte, le `JobRunner` annule les écritures et rejoue. Au **dernier** essai,
 * l'erreur technique ne remonte plus : sans cela la tâche passerait `FAILED` et la ligne resterait `QUEUED` (donc
 * comptée parmi les exports en cours, `EXPORT_BACKLOG`) jusqu'à l'abandon de 24 h, sans que le demandeur soit
 * prévenu. Les écritures de l'essai sont annulées (point de sauvegarde), puis l'export passe `FAILED` /
 * `EXPORT_JOB_FAILED` : audité, demandeur prévenu, fichier partiel supprimé au mieux (`concludeExport`). Le message
 * technique n'est écrit ni dans la ligne ni dans l'audit : le journal ne porte que la nature de l'erreur.
 *
 * Limite (AV-469) : si la transaction est perdue (interblocage), `ROLLBACK TO SAVEPOINT` échoue, l'erreur remonte, la
 * tâche passe `FAILED` et la ligne reste `QUEUED` jusqu'à l'abandon de 24 h.
 */
export async function runExportJob(
  uow: UnitOfWork,
  deps: RunExportDeps,
  exportId: string,
  attempt: JobAttemptContext | undefined,
  logger?: Pick<Logger, 'error'>,
): Promise<RunExportOutcome> {
  if (attempt === undefined || attempt.attempt < attempt.maxAttempts) {
    return runExport(uow, deps, exportId);
  }
  await sql`SAVEPOINT export_attempt`.execute(uow);
  try {
    return await runExport(uow, deps, exportId);
  } catch (error) {
    try {
      await sql`ROLLBACK TO SAVEPOINT export_attempt`.execute(uow);
    } catch {
      throw error;
    }
    logger?.error(
      `Export ${exportId} : dernier essai en échec (${errorKindOf(error)}) ; l’export passe ${EXPORT_JOB_FAILED}.`,
    );
    const job = await lockExport(uow, exportId);
    // Défensif : `runExport` tenait le verrou de la ligne, que le retour au point de sauvegarde ne relâche pas.
    if (job === undefined || (job.status !== 'QUEUED' && job.status !== 'RUNNING')) {
      return { status: 'SKIPPED' };
    }
    return concludeExport(
      uow,
      deps,
      job,
      { status: 'FAILED', errorCode: EXPORT_JOB_FAILED },
      0,
      logger ?? { error: () => undefined },
    );
  }
}

/** Nature d'une erreur pour le journal : son nom et son code éventuel, jamais son message (il peut citer des valeurs). */
function errorKindOf(error: unknown): string {
  if (!(error instanceof Error)) return 'erreur non typée';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number'
    ? `${error.name}, code ${String(code)}`
    : error.name;
}

/**
 * Les droits du demandeur à l'instant du calcul : `null` si tout est en règle, sinon le code d'échec. La version du
 * catalogue de la demande doit être la version courante (une définition figée sur un catalogue périmé n'est pas
 * rejouée, jamais réécrite).
 */
async function revalidateRights(
  uow: UnitOfWork,
  job: StoredExport,
  at: Date,
): Promise<string | null> {
  const active = await checkUserActive(uow, toBin(job.requestedBy), at);
  if (!active.ok) return 'FORBIDDEN';
  if (!(await hasPermissionAt(uow, toBin(job.requestedBy), EXPORT_PERMISSION, at)))
    return 'FORBIDDEN';
  if (job.catalogVersion !== ANALYTICS_CATALOG_VERSION) return 'CATALOG_OUTDATED';
  return null;
}
