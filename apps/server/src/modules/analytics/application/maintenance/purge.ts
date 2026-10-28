/**
 * Purges techniques de l'analyse (P9-22 ; ADR-068 §6, dictionnaire `analytics.*`) : tâche quotidienne
 * `analytics.maintenance.purge_daily`.
 *
 * - **Journal des requêtes** (`analytics_query_log`, `PURGE_TECHNIQUE`) : lignes de plus de
 *   `analytics.query_log_retention_days` jours (90) ; par lots bornés, jamais une ligne plus récente que la limite.
 * - **Exports expirés** : un export `DONE` dont l'échéance est passée devient `EXPIRED` (la ligne reste : trace
 *   d'audit, BR-ANA-008) ; son fichier est supprimé du stockage `analytics.export_file_retention_days` jours (30)
 *   après la création de la ligne. La purge part des **fichiers présents** (`listKeys`) et jamais d'une fenêtre de
 *   dates : un fichier que la purge a manqué (arrêt de plus de 30 jours, durée de rétention abaissée) est repris le
 *   jour suivant, et le compte rendu ne compte que les fichiers réellement supprimés (P9-25, EX-2). Le fichier d'un
 *   export `FAILED` est supprimé sans attendre ; une clé qui n'est pas d'un export connu n'est jamais touchée.
 * - **Exports abandonnés** : un export encore `QUEUED` ou `RUNNING` plus de `analytics.export_abandon_hours` heures
 *   (24) après sa demande a perdu sa tâche (rejeux épuisés) : il passe `FAILED` (`EXPORT_ABANDONED`), puis son fichier
 *   partiel est supprimé. La ligne est lue verrouillée en sautant celles qu'un calcul tient (`SKIP LOCKED`) : la purge
 *   ne dispute jamais un export que le worker termine (P9-25, EX-1, EX-6).
 * - **Instantanés** : ceux des utilisateurs inactifs sont retirés par la tâche d'instantanés elle-même
 *   (`analytics.kpi_snapshots.refresh`, dernier lot de la passe).
 *
 * **Étapes isolées** (P9-25, PF-5). Ces rétentions sont des durées paramétrées (ADR-068 §8 : journal 90 jours, abandon
 * 24 h, fichiers 30 jours) : une purge qui s'arrête en silence les rend lettre morte. Les étapes s'exécutent dans la
 * transaction de la tâche, chacune sous un point de sauvegarde : l'échec d'une étape n'annule que ses propres
 * écritures, il est consigné dans `failedSteps` (la tâche le journalise à l'erreur et reste `DONE`), et les autres
 * étapes sont menées ; sans cela, l'échec du stockage faisait annuler aussi les suppressions du journal, rejouées cinq
 * fois puis abandonnées jusqu'au lendemain. Un export fautif n'empêche pas les autres d'être abandonnés, un fichier
 * qui résiste n'empêche pas les suivants d'être supprimés.
 *
 * **Ordre : journal, expiration, fichiers, abandon.** L'étape d'abandon audite (`recordAudit` verrouille la ligne
 * unique `audit_chain_head`, rang N14 « toujours la dernière », ADR-038) : elle passe en dernier pour ne tenir ce
 * verrou global que le temps de son propre travail, jamais pendant la suppression des fichiers. `ROLLBACK TO
 * SAVEPOINT` ne relâche pas un verrou de ligne posé après le point de sauvegarde : si l'abandon échoue après un audit,
 * le verrou de la chaîne reste tenu jusqu'à la fin de la transaction, sans conséquence tant que l'abandon est la
 * dernière étape — **ne pas réordonner**. Conséquence de l'ordre : l'étape des fichiers voit encore `QUEUED` l'export
 * que l'abandon traitera ensuite et ne touche pas à son fichier partiel ; c'est l'abandon qui le supprime (EX-1).
 */
import { sql } from 'kysely';
import type { Clock, IdGenerator } from '@gic/domain';
import { recordAudit } from '../../../../audit/record-audit.js';
import type { ChunkStorage } from '../../../../platform/storage/chunk-storage.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { readExportSettings } from '../exports/export-settings.js';
import {
  EXPORT_STORAGE_PREFIX,
  exportFileStates,
  exportIdOfStorageKey,
  exportStorageKey,
  expiredDoneExports,
  lockAbandonedExports,
  markExportExpired,
  markExportFailed,
} from '../exports/export-store.js';

export const QUERY_LOG_RETENTION_KEY = 'analytics.query_log_retention_days';
export const EXPORT_FILE_RETENTION_KEY = 'analytics.export_file_retention_days';
const DEFAULT_QUERY_LOG_RETENTION_DAYS = 90;
const DEFAULT_EXPORT_FILE_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BATCH = 500;
/** Fichiers examinés au plus par exécution (le reste attend le lendemain) et identifiants lus par requête. */
const FILE_SCAN_MAX = 10_000;
const FILE_STATE_BATCH = 500;
const QUERY_LOG_BATCH = 5_000;
/** Lots de journal supprimés au plus par exécution (le reste attend le lendemain). */
const QUERY_LOG_MAX_BATCHES = 20;

export type PurgeStep = 'journal' | 'expiration' | 'fichiers' | 'abandon';

/** Une étape (ou, pour les fichiers et l'abandon, un élément) que la purge n'a pas pu mener : reprise à la prochaine exécution. */
export interface PurgeStepFailure {
  readonly step: PurgeStep;
  readonly message: string;
}

export interface PurgeOutcome {
  readonly queryLogDeleted: number;
  readonly exportsExpired: number;
  readonly exportFilesDeleted: number;
  readonly exportsAbandoned: number;
  readonly failedSteps: readonly PurgeStepFailure[];
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Exécute `run` sous un point de sauvegarde. S'il lève, ses écritures sont annulées, l'échec est ajouté à `failures` et
 * `undefined` est rendu : l'appelant n'a ni compte partiel à reprendre, ni exception à traiter. Si le retour au point
 * de sauvegarde échoue (interblocage dont MySQL fait sa victime, connexion perdue : la transaction entière est perdue),
 * l'erreur d'origine remonte et la reprise est celle du `JobRunner`. Pas de `RELEASE SAVEPOINT` : MySQL remplace un
 * point du même nom. Deux points de noms distincts s'imbriquent (l'étape d'abandon isole chaque export).
 */
async function isolatedStep<T>(
  uow: UnitOfWork,
  step: PurgeStep,
  failures: PurgeStepFailure[],
  run: () => Promise<T>,
  savepoint: 'purge_step' | 'purge_item' = 'purge_step',
): Promise<T | undefined> {
  const point = sql.raw(savepoint);
  await sql`SAVEPOINT ${point}`.execute(uow);
  try {
    return await run();
  } catch (error) {
    try {
      await sql`ROLLBACK TO SAVEPOINT ${point}`.execute(uow);
    } catch {
      throw error;
    }
    failures.push({ step, message: messageOf(error) });
    return undefined;
  }
}

async function days(uow: UnitOfWork, key: string, at: Date, fallback: number): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function runAnalyticsPurge(
  uow: UnitOfWork,
  deps: {
    readonly clock: Clock;
    readonly idGenerator: IdGenerator;
    readonly storage: ChunkStorage;
  },
): Promise<PurgeOutcome> {
  const now = deps.clock.now();
  const queryLogDays = await days(
    uow,
    QUERY_LOG_RETENTION_KEY,
    now,
    DEFAULT_QUERY_LOG_RETENTION_DAYS,
  );
  const fileDays = await days(
    uow,
    EXPORT_FILE_RETENTION_KEY,
    now,
    DEFAULT_EXPORT_FILE_RETENTION_DAYS,
  );

  const failures: PurgeStepFailure[] = [];

  // Journal : chaque étape rend SON compte ; celui d'une étape annulée ne remonte pas (ses suppressions sont annulées).
  const logCutoff = new Date(now.getTime() - queryLogDays * DAY_MS);
  const queryLogDeleted =
    (await isolatedStep(uow, 'journal', failures, async () => {
      let total = 0;
      for (let batch = 0; batch < QUERY_LOG_MAX_BATCHES; batch += 1) {
        const result = await uow
          .deleteFrom('analytics_query_log')
          .where('created_at', '<', logCutoff)
          .limit(QUERY_LOG_BATCH)
          .executeTakeFirst();
        const deleted = Number(result.numDeletedRows);
        total += deleted;
        if (deleted < QUERY_LOG_BATCH) break;
      }
      return total;
    })) ?? 0;

  const exportsExpired =
    (await isolatedStep(uow, 'expiration', failures, async () => {
      let total = 0;
      for (const job of await expiredDoneExports(uow, now, BATCH)) {
        await markExportExpired(uow, job.id);
        total += 1;
      }
      return total;
    })) ?? 0;

  // Fichiers : ceux que le stockage porte, jugés sur l'état de leur export (EX-2). Une clé inconnue de la base n'est
  // jamais supprimée ; un export `EXPIRED` garde son fichier `fileDays` jours après sa création, un `FAILED` n'en
  // garde aucun. Les suppressions de fichiers ne sont pas transactionnelles : le compte est tenu hors de l'étape (il
  // reflète les fichiers réellement supprimés même si l'étape échoue ensuite), et une clé qui résiste n'empêche pas les
  // suivantes (un seul échec consigné pour l'étape, avec le nombre de fichiers restants et la première cause).
  let exportFilesDeleted = 0;
  const filesBefore = new Date(now.getTime() - fileDays * DAY_MS);
  await isolatedStep(uow, 'fichiers', failures, async () => {
    const keys = (await deps.storage.listKeys(EXPORT_STORAGE_PREFIX)).slice(0, FILE_SCAN_MAX);
    let unremoved = 0;
    let firstCause: string | undefined;
    for (let start = 0; start < keys.length; start += FILE_STATE_BATCH) {
      const batch = keys.slice(start, start + FILE_STATE_BATCH);
      const states = await exportFileStates(
        uow,
        batch.flatMap((key) => exportIdOfStorageKey(key) ?? []),
      );
      for (const key of batch) {
        const id = exportIdOfStorageKey(key);
        const state = id === null ? undefined : states.get(id);
        if (state === undefined) continue;
        const obsolete =
          state.status === 'FAILED' ||
          (state.status === 'EXPIRED' && state.createdAt.getTime() < filesBefore.getTime());
        if (!obsolete) continue;
        try {
          await deps.storage.delete(key);
          exportFilesDeleted += 1;
        } catch (error) {
          unremoved += 1;
          if (firstCause === undefined) firstCause = messageOf(error);
        }
      }
    }
    if (unremoved > 0) {
      failures.push({
        step: 'fichiers',
        message: `${unremoved} fichier(s) non supprimé(s) (première cause : ${firstCause ?? 'inconnue'})`,
      });
    }
  });

  // Abandon, en dernier (verrou de la chaîne d'audit : en-tête). Un point de sauvegarde par export : un export
  // fautif n'annule ni ne retient les autres. Ordre du corps inchangé (EX-1) : mise à jour de la ligne, audit, puis
  // suppression du fichier partiel.
  const exportsAbandoned =
    (await isolatedStep(uow, 'abandon', failures, async () => {
      const { abandonHours } = await readExportSettings(uow, now);
      let total = 0;
      for (const job of await lockAbandonedExports(
        uow,
        new Date(now.getTime() - abandonHours * HOUR_MS),
        BATCH,
      )) {
        const abandoned = await isolatedStep(
          uow,
          'abandon',
          failures,
          async () => {
            await markExportFailed(uow, {
              id: job.id,
              errorCode: 'EXPORT_ABANDONED',
              durationMs: 0,
              finishedAt: now,
            });
            // Une fin sans calcul est tout de même auditée (INV-ANA-01) : au nom du demandeur, motif dans le code d'erreur.
            await recordAudit(uow, deps, {
              occurredAt: now,
              actorUserId: job.requestedBy,
              actorRoles: [],
              action: 'analytics.export.abandoned',
              entityType: 'ANALYTICS_EXPORT',
              entityId: job.id,
              after: {
                dataset: job.dataset,
                format: job.format,
                status: 'FAILED',
                error_code: 'EXPORT_ABANDONED',
              },
              result: 'FAILED',
              errorCode: 'EXPORT_ABANDONED',
            });
            // Le fichier partiel part après la mise à jour de la ligne, jamais avant (EX-1).
            await deps.storage.delete(exportStorageKey(job.id));
            return true;
          },
          'purge_item',
        );
        if (abandoned === true) total += 1;
      }
      return total;
    })) ?? 0;

  return {
    queryLogDeleted,
    exportsExpired,
    exportFilesDeleted,
    exportsAbandoned,
    failedSteps: failures,
  };
}
