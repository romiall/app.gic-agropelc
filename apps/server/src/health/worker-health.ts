/**
 * Mesure et jugement de la sonde de disponibilité `GET /health/ready` (P9-25, PF-6 ; AV-469, AV-425 « Limites » ;
 * 09-non-functional/02-observabilite.md §3 et §7). La sonde ne comptait que des événements : un worker arrêté avec
 * quelques événements en attente restait « prêt », et aucune tâche `FAILED` n'était vue de personne. Elle mesure
 * désormais, sans rien écrire :
 *
 * - le **retard en événements** du consommateur le plus en retard (seuil technique d'origine, 1 000) ;
 * - le **retard en secondes** du consommateur le plus en retard (`communication.consumer_lag_alert_seconds`, 300 s,
 *   le même réglage que l'alerte `CONSUMER_FAILED`) ;
 * - l'**âge de la plus ancienne tâche due** (`platform.job_lag_alert_seconds`, 600 s) : un worker arrêté, ou une voie
 *   saturée, la laisse vieillir ;
 * - le **nombre de tâches `FAILED`** sur `platform.failed_jobs_window_hours` (24 h) : rapporté, jamais un refus.
 *
 * Seuls les consommateurs actuellement enregistrés comptent : la ligne oubliée d'un consommateur renommé ou retiré
 * (ou, en test, un nom d'appareil éphémère) resterait figée à une position ancienne et fausserait la mesure pour
 * toujours. Limite assumée (AV-469) : sans battement de cœur, un worker arrêté sans événement ni tâche due reste
 * « prêt » jusqu'au premier travail en attente. Coût : environ neuf requêtes de lecture par appel, sans cache
 * (la sonde externe est annoncée à la minute) ; un 503 pour tâche due en retard dépasse le seul retard du worker.
 */
import { consumerLagAlertSecondsOrDefault, consumerLagSeconds } from '@gic/domain';
import type { Kysely, Transaction } from 'kysely';
import { readConsumerLags } from '../platform/events/consumer-status.js';
import { readJobBacklog } from '../platform/jobs/job-status.js';
import type { DB } from '../platform/kysely/database.js';
import { currentSettingValue } from '../modules/organization/application/public/index.js';

type ReadExecutor = Kysely<DB> | Transaction<DB>;

/** Retard en événements au-delà duquel la sonde refuse (constante technique d'origine, pas un seuil métier). */
export const WORKER_LAG_THRESHOLD_EVENTS = 1000;

export const CONSUMER_LAG_ALERT_SETTING_KEY = 'communication.consumer_lag_alert_seconds';
export const JOB_LAG_ALERT_SETTING_KEY = 'platform.job_lag_alert_seconds';
export const FAILED_JOBS_WINDOW_SETTING_KEY = 'platform.failed_jobs_window_hours';

/** Repli de l'âge toléré de la plus ancienne tâche due (AV-469 : un export en file derrière d'autres peut attendre). */
export const DEFAULT_JOB_LAG_ALERT_SECONDS = 600;
/** Plafond de l'âge toléré (dix ans, en secondes) : au-delà, la sonde ne refuserait jamais. */
export const MAX_JOB_LAG_ALERT_SECONDS = 315_360_000;
/** Repli de la fenêtre des tâches échouées (AV-469 : un jour). */
export const DEFAULT_FAILED_JOBS_WINDOW_HOURS = 24;
/** Plafond de la fenêtre (dix ans) : au-delà, l'instant de coupure serait invalide. */
export const MAX_FAILED_JOBS_WINDOW_HOURS = 87_600;

/** `platform.job_lag_alert_seconds` : un nombre fini strictement positif (plafonné), sinon 600. */
export function jobLagAlertSecondsOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_JOB_LAG_ALERT_SECONDS)
    : DEFAULT_JOB_LAG_ALERT_SECONDS;
}

/** `platform.failed_jobs_window_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function failedJobsWindowHoursOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_FAILED_JOBS_WINDOW_HOURS)
    : DEFAULT_FAILED_JOBS_WINDOW_HOURS;
}

export interface WorkerHealthThresholds {
  readonly lagEvents: number;
  /** `communication.consumer_lag_alert_seconds`. */
  readonly lagSeconds: number;
  /** `platform.job_lag_alert_seconds`. */
  readonly jobLagSeconds: number;
  /** `platform.failed_jobs_window_hours`. */
  readonly failedJobsWindowHours: number;
}

export interface WorkerHealthMeasures {
  /** Événements non encore atteints par le consommateur le plus en retard. */
  readonly lagEvents: number;
  /** Âge, en secondes, du plus ancien événement non traité par un consommateur enregistré. */
  readonly lagSeconds: number;
  /** Âge, en secondes, de la plus ancienne tâche due ; 0 si aucune n'est due. */
  readonly oldestDueJobSeconds: number;
  /** Tâches `FAILED` dans la fenêtre : information, jamais un refus. */
  readonly failedJobs: number;
}

/** Les seuils en vigueur à `at` (réglages globaux, repli documenté si absents ou invalides). */
export async function readWorkerHealthThresholds(
  executor: ReadExecutor,
  at: Date,
): Promise<WorkerHealthThresholds> {
  const setting = (key: string): Promise<unknown> =>
    currentSettingValue(executor, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return {
    lagEvents: WORKER_LAG_THRESHOLD_EVENTS,
    lagSeconds: consumerLagAlertSecondsOrDefault(await setting(CONSUMER_LAG_ALERT_SETTING_KEY)),
    jobLagSeconds: jobLagAlertSecondsOrDefault(await setting(JOB_LAG_ALERT_SETTING_KEY)),
    failedJobsWindowHours: failedJobsWindowHoursOrDefault(
      await setting(FAILED_JOBS_WINDOW_SETTING_KEY),
    ),
  };
}

/** Les quatre mesures de la sonde, à l'instant `now` ; `failedSince` borne basse des tâches échouées comptées. */
export async function measureWorkerHealth(
  executor: ReadExecutor,
  window: {
    readonly consumerNames: readonly string[];
    readonly now: Date;
    readonly failedSince: Date;
  },
): Promise<WorkerHealthMeasures> {
  let lagEvents = 0;
  let lagSeconds = 0;
  if (window.consumerNames.length > 0) {
    const events = await executor
      .selectFrom('platform_domain_events')
      .select(({ fn }) => fn.max('seq').as('maxSeq'))
      .executeTakeFirst();
    const maxSeq = Number(events?.maxSeq ?? 0);
    const registered = new Set(window.consumerNames);
    const lags = (await readConsumerLags(executor)).filter((lag) =>
      registered.has(lag.consumerName),
    );
    if (lags.length > 0) {
      const minLastSeq = Math.min(...lags.map((lag) => lag.lastSeq));
      lagEvents = Math.max(0, maxSeq - minLastSeq);
    }
    for (const lag of lags) {
      lagSeconds = Math.max(lagSeconds, consumerLagSeconds(lag.oldestPendingAt, window.now));
    }
  }
  const backlog = await readJobBacklog(executor, {
    now: window.now,
    failedSince: window.failedSince,
  });
  return {
    lagEvents,
    lagSeconds,
    oldestDueJobSeconds: consumerLagSeconds(backlog.oldestDueAt, window.now),
    failedJobs: backlog.failedJobs,
  };
}

/**
 * Pourquoi la sonde refuse, ou `null` si elle répond. Pure. Comparaisons strictement supérieures (une valeur égale
 * au seuil passe) ; les tâches `FAILED` ne produisent jamais de refus.
 */
export function workerHealthProblem(
  measures: WorkerHealthMeasures,
  thresholds: WorkerHealthThresholds,
): string | null {
  if (measures.lagEvents > thresholds.lagEvents) {
    return `Retard du worker : ${measures.lagEvents} événements non consommés.`;
  }
  if (measures.lagSeconds > thresholds.lagSeconds) {
    return (
      `Retard du worker : un consommateur attend depuis ${measures.lagSeconds} s ` +
      `(seuil ${thresholds.lagSeconds} s).`
    );
  }
  if (measures.oldestDueJobSeconds > thresholds.jobLagSeconds) {
    return (
      `Retard du worker : une tâche due attend depuis ${measures.oldestDueJobSeconds} s ` +
      `(seuil ${thresholds.jobLagSeconds} s).`
    );
  }
  return null;
}

/** Instant de coupure des tâches échouées comptées (`now` moins la fenêtre). */
export function failedJobsSince(now: Date, thresholds: WorkerHealthThresholds): Date {
  return new Date(now.getTime() - thresholds.failedJobsWindowHours * 3_600_000);
}
