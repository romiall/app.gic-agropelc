/**
 * Registre des tâches **récurrentes** (P5-16 ; 05-architecture/01-architecture-logicielle.md
 * « Ordonnanceur », 02-modules.md §1 `platform` : `recurringJobs.register`). Chaque module y inscrit
 * au démarrage le type de tâche qu'il veut voir déposé périodiquement, avec sa récurrence : un
 * intervalle fixe (`INTERVAL`, secondes) ou une heure locale quotidienne en Africa/Douala (`DAILY`,
 * `HH:MM`). Le gestionnaire de la tâche reste enregistré dans `JobHandlerRegistry` ; l'ordonnanceur
 * (`job-scheduler.ts`) ne fait que **déposer** la tâche au bon créneau. Même inversion de dépendance
 * que les autres registres : `platform` ne connaît aucun module métier.
 */
import { assertRecurringSchedule, type RecurringSchedule } from '@gic/domain';

export type { RecurringSchedule } from '@gic/domain';

export interface RecurringJob {
  readonly jobType: string;
  readonly schedule: RecurringSchedule;
}

export class RecurringJobRegistry {
  private readonly jobs = new Map<string, RecurringJob>();

  /** Une récurrence par type de tâche ; une forme invalide est refusée au démarrage. */
  register(job: RecurringJob): void {
    if (this.jobs.has(job.jobType)) {
      throw new Error(`Tâche récurrente déjà inscrite : ${job.jobType}.`);
    }
    assertRecurringSchedule(job.schedule);
    this.jobs.set(job.jobType, job);
  }

  get(jobType: string): RecurringJob | undefined {
    return this.jobs.get(jobType);
  }

  list(): readonly RecurringJob[] {
    return [...this.jobs.values()];
  }
}
