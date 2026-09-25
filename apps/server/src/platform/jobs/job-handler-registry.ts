/**
 * Registre `job_type → gestionnaire` (P0-08 ; ADR-011, ADR-023 « table de tâches maison »).
 * Même schéma d'inversion de dépendance que `CommandHandlerRegistry` (platform/sync/
 * command-handler-registry.ts) : chaque module s'enregistre au démarrage, le worker ne
 * connaît aucun module métier. Un gestionnaire résout normalement (succès) ou lève
 * (échec — `job-runner.ts` gère la reprise/l'échec définitif, pas le gestionnaire lui-même).
 */
import type { UnitOfWork } from '../unit-of-work.js';

export type JobHandler<P = unknown> = (uow: UnitOfWork, payload: P) => Promise<void>;

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register<P>(jobType: string, handler: JobHandler<P>): void {
    if (this.handlers.has(jobType)) {
      throw new Error(`Gestionnaire de tâche déjà enregistré : ${jobType}.`);
    }
    this.handlers.set(jobType, handler as JobHandler);
  }

  resolve(jobType: string): JobHandler | undefined {
    return this.handlers.get(jobType);
  }
}
