/**
 * Sonde de disponibilité `GET /health/ready` (P9-25, PF-6 ; AV-469) : le jugement pur (`workerHealthProblem`, les
 * lectures de réglages à repli) puis les mesures sur la base partagée (`readJobBacklog`, `measureWorkerHealth`) en
 * assertions relatives : d'autres fichiers laissent des tâches et des positions de consommateurs, et la base n'est
 * jamais comptée en absolu. Les insertions se font dans une transaction annulée ; aucune horloge n'est déplacée.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_FAILED_JOBS_WINDOW_HOURS,
  DEFAULT_JOB_LAG_ALERT_SECONDS,
  MAX_FAILED_JOBS_WINDOW_HOURS,
  MAX_JOB_LAG_ALERT_SECONDS,
  failedJobsWindowHoursOrDefault,
  jobLagAlertSecondsOrDefault,
  measureWorkerHealth,
  workerHealthProblem,
  type WorkerHealthMeasures,
  type WorkerHealthThresholds,
} from '../src/health/worker-health.js';
import { readJobBacklog } from '../src/platform/jobs/job-status.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, freshUuid, withTestUow } from './helpers.js';

const THRESHOLDS: WorkerHealthThresholds = {
  lagEvents: 1000,
  lagSeconds: 300,
  jobLagSeconds: 600,
  failedJobsWindowHours: 24,
};
const CALM: WorkerHealthMeasures = {
  lagEvents: 0,
  lagSeconds: 0,
  oldestDueJobSeconds: 0,
  failedJobs: 0,
};

afterAll(async () => {
  await closeTestDb();
});

describe('workerHealthProblem (pur)', () => {
  it('sous les trois seuils : la sonde répond', () => {
    expect(workerHealthProblem(CALM, THRESHOLDS)).toBeNull();
    expect(
      workerHealthProblem(
        { lagEvents: 999, lagSeconds: 299, oldestDueJobSeconds: 599, failedJobs: 0 },
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  it('chaque mesure au-delà de son seuil refuse, avec un message qui la nomme', () => {
    expect(workerHealthProblem({ ...CALM, lagEvents: 1001 }, THRESHOLDS)).toMatch(
      /1001 événements/,
    );
    expect(workerHealthProblem({ ...CALM, lagSeconds: 301 }, THRESHOLDS)).toMatch(
      /consommateur attend depuis 301 s \(seuil 300 s\)/,
    );
    expect(workerHealthProblem({ ...CALM, oldestDueJobSeconds: 601 }, THRESHOLDS)).toMatch(
      /tâche due attend depuis 601 s \(seuil 600 s\)/,
    );
  });

  it('une valeur égale au seuil ne refuse pas', () => {
    expect(
      workerHealthProblem(
        { lagEvents: 1000, lagSeconds: 300, oldestDueJobSeconds: 600, failedJobs: 0 },
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  it('un grand nombre de tâches FAILED ne refuse jamais (information seulement)', () => {
    expect(workerHealthProblem({ ...CALM, failedJobs: 1_000_000 }, THRESHOLDS)).toBeNull();
  });

  it('les seuils lus à repli : 0, négatif, NaN, chaîne et null rendent le défaut ; un excès est plafonné', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '600', null, undefined]) {
      expect(jobLagAlertSecondsOrDefault(bad)).toBe(DEFAULT_JOB_LAG_ALERT_SECONDS);
      expect(failedJobsWindowHoursOrDefault(bad)).toBe(DEFAULT_FAILED_JOBS_WINDOW_HOURS);
    }
    expect(jobLagAlertSecondsOrDefault(120)).toBe(120);
    expect(failedJobsWindowHoursOrDefault(48)).toBe(48);
    expect(jobLagAlertSecondsOrDefault(Number.MAX_SAFE_INTEGER)).toBe(MAX_JOB_LAG_ALERT_SECONDS);
    expect(failedJobsWindowHoursOrDefault(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_FAILED_JOBS_WINDOW_HOURS,
    );
  });
});

describe('readJobBacklog et measureWorkerHealth sur la base partagée', () => {
  /** Une tâche d'un type unique ; `trx` est la transaction (annulée) de l'essai. */
  const insertJob = (
    trx: Parameters<Parameters<typeof withTestUow>[0]>[0],
    status: 'PENDING' | 'FAILED',
    runAt: Date,
  ) =>
    trx
      .insertInto('platform_jobs')
      .values({
        id: toBin(freshUuid()),
        job_type: `test.job.health.${freshUuid().slice(-12)}`,
        payload: jsonValue({}),
        run_at: runAt,
        status,
        attempts: status === 'FAILED' ? 5 : 0,
        max_attempts: 5,
      })
      .execute();

  it('une tâche due remonte l’ancienneté ; une tâche FAILED n’est comptée que dans la fenêtre ; une tâche future n’est jamais due', async () => {
    const now = new Date();
    const dueAt = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
    await withTestUow(async (trx) => {
      await insertJob(trx, 'PENDING', dueAt);
      await insertJob(trx, 'FAILED', new Date(now.getTime() - 60_000));
      await insertJob(trx, 'PENDING', new Date(now.getTime() + 3_600_000));

      const inWindow = await readJobBacklog(trx, { now, failedSince: dayAgo });
      // D'autres fichiers peuvent laisser des tâches plus anciennes : l'ancienneté est au moins celle de la nôtre
      // (la colonne peut arrondir la date à la seconde : une seconde de marge).
      expect(inWindow.oldestDueAt).not.toBeNull();
      expect(inWindow.oldestDueAt!.getTime()).toBeLessThanOrEqual(dueAt.getTime() + 1000);
      // La tâche future n'est jamais « due » : la plus ancienne due n'est pas postérieure à `now`.
      expect(inWindow.oldestDueAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(inWindow.failedJobs).toBeGreaterThanOrEqual(1);

      // Fenêtre vide (coupure = maintenant) : notre tâche FAILED, datée d'une minute plus tôt, n'y est pas.
      const emptyWindow = await readJobBacklog(trx, { now, failedSince: now });
      expect(inWindow.failedJobs - emptyWindow.failedJobs).toBeGreaterThanOrEqual(1);
    });
  });

  it('measureWorkerHealth : sans consommateur, ou avec un nom inconnu des positions, aucun retard ; l’ancienneté de la tâche due remonte', async () => {
    const now = new Date();
    const failedSince = new Date(now.getTime() - 24 * 3_600_000);
    await withTestUow(async (trx) => {
      // Plus d'une heure (marge de l'arrondi éventuel de la colonne).
      await insertJob(trx, 'PENDING', new Date(now.getTime() - 3_700_000));

      const none = await measureWorkerHealth(trx, { consumerNames: [], now, failedSince });
      expect(none.lagEvents).toBe(0);
      expect(none.lagSeconds).toBe(0);
      expect(none.oldestDueJobSeconds).toBeGreaterThanOrEqual(3600);

      const unknown = await measureWorkerHealth(trx, {
        consumerNames: [`consommateur-inconnu-${freshUuid()}`],
        now,
        failedSince,
      });
      expect(unknown.lagEvents).toBe(0);
      expect(unknown.lagSeconds).toBe(0);
      expect(unknown.oldestDueJobSeconds).toBeGreaterThanOrEqual(3600);
      expect(unknown.failedJobs).toBeGreaterThanOrEqual(0);
    });
  });
});
