/**
 * Traitement d'une tâche (P0-08) : `SELECT … FOR UPDATE SKIP LOCKED` (ADR-011, ADR-023) —
 * plusieurs instances de worker peuvent appeler `claimAndProcessOne` en parallèle sans jamais
 * réclamer la même ligne. Le verrou de la ligne traitée est tenu pour la durée de la transaction :
 * succès ou échec, la ligne est toujours mise à jour avant COMMIT (pas de statut « en cours »
 * persistant distinct — voir platform.jobs, dictionnaire).
 *
 * Réclamation en deux temps (P9-25, PF-2). Un seul `SELECT … FOR UPDATE` filtré par voie (`job_type`
 * dans ou hors d'une liste) verrouillerait aussi les lignes parcourues puis rejetées par le filtre :
 * `job_type` n'est pas indexé (seul `ix_platform_jobs_poll` couvre `status, run_at`) et, sous
 * REPEATABLE READ, InnoDB garde le verrou de toute ligne parcourue jusqu'à la fin de la transaction,
 * c'est-à-dire de l'exécution du gestionnaire (120 s pour un export). Deux effets : une tâche courte
 * due, parcourue par la voie longue, restait verrouillée et la voie courte la sautait (`SKIP LOCKED`)
 * pendant tout le calcul ; et les verrous d'intervalle posés sur `ix_platform_jobs_poll` pouvaient
 * retarder le passage à `DONE` d'une autre tâche (effet probable, masqué en base d'essai par les
 * lignes `FAILED` qui s'intercalent dans l'index). La réclamation lit donc d'abord ses candidats
 * **sans verrou**, hors transaction (dix au plus, mêmes filtres, ordre `run_at`), puis verrouille,
 * candidat par candidat, la **seule ligne retenue** par clé primaire (`FOR UPDATE SKIP LOCKED`), en
 * revérifiant `status` et `run_at` sous le verrou (sans quoi une tâche terminée entre les deux
 * lectures par un autre worker serait rejouée). Aucune ligne rejetée n'est verrouillée : une voie ne
 * retient jamais les tâches de l'autre.
 *
 * Le gestionnaire reste dans la transaction de la réclamation, à l'isolement par défaut (REPEATABLE
 * READ) : les rapprochements de stock et de caisse (`inventory.ledger.reconcile_daily`,
 * `finance.cash.reconcile_daily`) lisent registre et soldes dans un même instantané, sinon ils
 * figeraient de faux écarts. READ COMMITTED est donc écarté (il aurait libéré les verrous des lignes
 * rejetées, mais au prix de cet instantané).
 *
 * Échec : jusqu'à `max_attempts` tentatives avec attente progressive (2^tentatives secondes),
 * puis `FAILED` et `last_error` rempli (08-api-events/02-catalogue-evenements.md §3 « 5
 * essais avec attente progressive »).
 *
 * Atomicité du gestionnaire (P5-16) : il s'exécute sous un point de sauvegarde ; s'il lève, ses
 * écritures sont annulées (`ROLLBACK TO SAVEPOINT`) **avant** que l'échec soit consigné et la
 * transaction validée. Sans cela, une tâche qui échoue au milieu laisserait un effet partiel validé,
 * puis le referait à la reprise (doublons).
 *
 * Transaction perdue (interblocage dont MySQL fait sa victime : toute la transaction, point de
 * sauvegarde compris, est annulée) : le point de sauvegarde n'existe plus. L'échec est alors consigné
 * dans une transaction courte **séparée** (la tâche compte une tentative et reste due), au lieu de
 * remonter jusqu'à la boucle du worker, qu'il arrêterait avec ses consommateurs d'événements.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../clock.provider.js';
import { DATABASE, type Database } from '../kysely/database.provider.js';
import { fromBin } from '../kysely/uuid-columns.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { JOB_HANDLER_REGISTRY, type JobHandlerRegistry } from './job-handler-registry.provider.js';

export type JobRunOutcome =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly jobId: string;
      readonly result: 'DONE' | 'RETRY' | 'FAILED';
    };

/**
 * `jobTypes` restreint la réclamation à ces types (utile à un worker spécialisé, ou pour
 * isoler une démonstration/un test des autres tâches en attente dans la même table
 * partagée) ; omis, n'importe quelle tâche due peut être réclamée. `excludeJobTypes` écarte ces types (la voie
 * courte du worker exclut les tâches longues, qu'une voie distincte réclame : `job-lanes.ts`, ADR-068 §3).
 */
export interface ClaimOptions {
  readonly jobTypes?: readonly string[];
  readonly excludeJobTypes?: readonly string[];
}

/**
 * Candidats lus sans verrou à chaque réclamation : borne technique (pas un seuil métier), égale au nombre de workers
 * concurrents qu'on accepte de sauter dans un même tour. Si tous sont tenus par d'autres workers, le tour rend
 * `claimed: false` et le suivant reprend ; sans effet avec un worker unique.
 */
const CLAIM_CANDIDATES = 10;

@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Réclame et traite une tâche due de la voie décrite par `options` (voir {@link ClaimOptions}) ; rend
   * `{ claimed: false }` si aucun candidat n'a pu être réclamé (réclamation en deux temps : en-tête du fichier).
   */
  async claimAndProcessOne(options: ClaimOptions = {}): Promise<JobRunOutcome> {
    for (const id of await this.dueCandidates(options)) {
      const outcome = await this.claimAndProcess(id);
      if (outcome !== null) return outcome;
    }
    return { claimed: false };
  }

  /**
   * Premier temps : identifiants des tâches dues de la voie, de la plus ancienne à la plus récente, **sans verrou**
   * (lecture simple sur le pool, hors transaction). Protégée : un essai y injecte un candidat périmé pour prouver
   * la revérification sous verrou.
   */
  protected async dueCandidates(options: ClaimOptions): Promise<Buffer[]> {
    let query = this.db
      .selectFrom('platform_jobs')
      .select('id')
      .where('status', '=', 'PENDING')
      .where('run_at', '<=', this.clock.now());
    if (options.jobTypes) {
      query = query.where('job_type', 'in', options.jobTypes);
    }
    if (options.excludeJobTypes !== undefined && options.excludeJobTypes.length > 0) {
      query = query.where('job_type', 'not in', options.excludeJobTypes);
    }
    const rows = await query
      .orderBy('run_at', 'asc')
      .orderBy('id', 'asc')
      .limit(CLAIM_CANDIDATES)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Second temps : verrouille la seule ligne `id` (clé primaire, `SKIP LOCKED` : un autre worker qui la tient la
   * fait sauter) en revérifiant `status` et `run_at` **sous le verrou**, puis traite la tâche dans cette même
   * transaction. Rend `null` si la ligne n'est plus à prendre (tenue, terminée ou différée entre les deux lectures).
   * Le gestionnaire garde l'isolement par défaut (REPEATABLE READ) : voir l'en-tête.
   */
  private async claimAndProcess(id: Buffer): Promise<JobRunOutcome | null> {
    return this.db.transaction().execute(async (trx): Promise<JobRunOutcome | null> => {
      const job = await trx
        .selectFrom('platform_jobs')
        .selectAll()
        .where('id', '=', id)
        .where('status', '=', 'PENDING')
        .where('run_at', '<=', this.clock.now())
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!job) return null;

      const jobId = fromBin(job.id);
      const handler = this.registry.resolve(job.job_type);
      if (!handler) {
        await this.recordFailure(
          trx,
          job,
          new Error(`Aucun gestionnaire enregistré pour « ${job.job_type} ».`),
        );
        return {
          claimed: true,
          jobId,
          result: job.attempts + 1 >= job.max_attempts ? 'FAILED' : 'RETRY',
        };
      }

      await sql`SAVEPOINT job_handler`.execute(trx);
      try {
        // Le dernier essai est `attempt >= maxAttempts` : la même condition que `FAILED` dans `recordFailure`.
        await handler(trx, job.payload, {
          attempt: job.attempts + 1,
          maxAttempts: job.max_attempts,
        });
        await trx
          .updateTable('platform_jobs')
          .set({ status: 'DONE', completed_at: this.clock.now() })
          .where('id', '=', job.id)
          .execute();
        return { claimed: true, jobId, result: 'DONE' };
      } catch (error) {
        try {
          await sql`ROLLBACK TO SAVEPOINT job_handler`.execute(trx);
        } catch {
          // Transaction déjà annulée par MySQL (interblocage) : ses verrous sont libérés, l'échec
          // se consigne hors d'elle ; si cette consignation échoue aussi (connexion perdue), l'erreur
          // d'origine remonte.
          try {
            await this.recordFailure(this.db, job, error);
          } catch {
            throw error;
          }
          return {
            claimed: true,
            jobId,
            result: job.attempts + 1 >= job.max_attempts ? 'FAILED' : 'RETRY',
          };
        }
        await this.recordFailure(trx, job, error);
        return {
          claimed: true,
          jobId,
          result: job.attempts + 1 >= job.max_attempts ? 'FAILED' : 'RETRY',
        };
      }
    });
  }

  private async recordFailure(
    trx: UnitOfWork | Database,
    job: { id: Buffer; job_type: string; attempts: number; max_attempts: number; run_at: Date },
    error: unknown,
  ): Promise<void> {
    const attempts = job.attempts + 1;
    const failed = attempts >= job.max_attempts;
    const backoffMs = 2 ** attempts * 1000;
    await trx
      .updateTable('platform_jobs')
      .set({
        attempts,
        status: failed ? 'FAILED' : 'PENDING',
        run_at: failed ? job.run_at : new Date(this.clock.now().getTime() + backoffMs),
        last_error: errorMessageOf(error),
      })
      .where('id', '=', job.id)
      .execute();
    // P9-25 (PF-6, AV-469) : un échec de tâche n'était vu de personne. Le journal porte le type, l'identifiant, le
    // numéro d'essai et la nature de l'erreur ; jamais la charge utile ni le message (il peut citer des valeurs :
    // clé dupliquée, chemin) ni la pile : le message complet reste dans `last_error`.
    const what = `Tâche « ${job.job_type} » (${fromBin(job.id)})`;
    if (failed) {
      this.logger.error(
        `${what} : échec définitif après ${attempts} essai(s) (${errorKindOf(error)}).`,
      );
    } else {
      this.logger.warn(
        `${what} : essai ${attempts}/${job.max_attempts} en échec (${errorKindOf(error)}), ` +
          `reprise dans ${backoffMs / 1000} s.`,
      );
    }
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nature d'une erreur pour le journal : son nom et, s'il existe, son code (MySQL, système), jamais son message. */
function errorKindOf(error: unknown): string {
  if (!(error instanceof Error)) return 'erreur non typée';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number'
    ? `${error.name}, code ${String(code)}`
    : error.name;
}
