/**
 * Registre `job_type → gestionnaire` (P0-08 ; ADR-011, ADR-023 « table de tâches maison »).
 * Même schéma d'inversion de dépendance que `CommandHandlerRegistry` (platform/sync/
 * command-handler-registry.ts) : chaque module s'enregistre au démarrage, le worker ne
 * connaît aucun module métier. Un gestionnaire résout normalement (succès) ou lève
 * (échec — `job-runner.ts` gère la reprise/l'échec définitif, pas le gestionnaire lui-même).
 *
 * Un gestionnaire lève pour une erreur technique à rejouer. Celui dont l'objet métier doit refléter l'échec
 * définitif (l'export : sans cela sa ligne resterait `QUEUED` et compterait parmi les exports en cours) lit
 * `context` pour savoir qu'il tient le dernier essai (P9-25, PF-6, AV-469).
 */
import type { UnitOfWork } from '../unit-of-work.js';

/** Essai en cours d'une tâche : `attempt` vaut 1 au premier essai ; le dernier est `attempt >= maxAttempts`. */
export interface JobAttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Le troisième paramètre est optionnel : des essais appellent directement `resolve(type)!(uow, charge)`. */
export type JobHandler<P = unknown> = (
  uow: UnitOfWork,
  payload: P,
  context?: JobAttemptContext,
) => Promise<void>;

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
