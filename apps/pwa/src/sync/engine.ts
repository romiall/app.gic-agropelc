/**
 * Orchestration push → pull (WF-16, squelette) : déclenchée au démarrage, au retour du
 * réseau (`online`), périodiquement, et manuellement (ECR-SYN-01 « forcer la
 * synchronisation »). Une seule exécution à la fois (`running`) : un déclenchement pendant un
 * cycle en cours attend la fin du cycle courant plutôt que d'en empiler un second.
 */
import type { Clock, IdGenerator } from '@gic/domain';
import type { GicDatabase } from '../storage/db.js';
import { runPushCycle } from './push.js';
import { runPullCycle } from './pull.js';
import { resetInterruptedPushes } from './outbox.js';

const PERIODIC_INTERVAL_MS = 30_000;
const MAX_PUSH_BATCHES_PER_CYCLE = 20; // borne de sécurité (outbox anormalement longue)

/**
 * `OFFLINE` : serveur injoignable (réseau). `SERVER_ERROR` : le serveur a répondu par une erreur
 * HTTP, il est joignable (ADR-037) ; les opérations repartiront au prochain cycle.
 */
export type SyncCycleOutcome =
  'SYNCED' | 'OFFLINE' | 'SERVER_ERROR' | 'SESSION_INVALID' | 'NOTHING_TO_DO';

export interface SyncEngineDeps {
  readonly db: GicDatabase;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly deviceId: string;
  /** Utilisateur de la session : titulaire des jeux téléchargés (ADR-037). */
  readonly userId?: string;
  readonly onSessionInvalid: () => void;
  /** Appelé après chaque cycle (ex. tenter l'activation d'un service worker en attente). */
  readonly onCycleComplete?: (outcome: SyncCycleOutcome) => void;
}

export async function runSyncCycle(deps: SyncEngineDeps): Promise<SyncCycleOutcome> {
  let pushed = false;
  let serverError = false;
  // Commandes bloquées (`COMMAND_STALLED`) déjà renvoyées pendant ce cycle : elles ne retiennent plus
  // la suite, mais ne repartent qu'au cycle suivant (pas de renvoi en boucle serrée, AV-217).
  const stalled = new Set<string>();
  for (let i = 0; i < MAX_PUSH_BATCHES_PER_CYCLE; i++) {
    const result = await runPushCycle(deps.db, deps, { skip: stalled });
    if (result.outcome === 'NOTHING_TO_PUSH') break;
    if (result.outcome === 'OFFLINE') return 'OFFLINE';
    if (result.outcome === 'SESSION_INVALID') {
      deps.onSessionInvalid();
      return 'SESSION_INVALID';
    }
    if (result.outcome === 'SERVER_ERROR') {
      // Le lot repartira au prochain cycle ; le tirage a lieu quand même (serveur joignable).
      serverError = true;
      break;
    }
    pushed = true;
    for (const commandId of result.stalled) stalled.add(commandId);
    // Rien de réglé (`RETRY_LATER` partout) : renvoyer aussitôt le même lot ne servirait à rien.
    if (result.settled === 0) break;
  }

  const pullResult = await runPullCycle(deps.db, {
    clock: deps.clock,
    ...(deps.userId ? { userId: deps.userId } : {}),
  });
  // Réseau perdu pendant le tirage : le serveur n'est plus joignable, même après un envoi réussi.
  if (pullResult.outcome === 'OFFLINE') return 'OFFLINE';
  if (pullResult.outcome === 'SESSION_INVALID') {
    deps.onSessionInvalid();
    return 'SESSION_INVALID';
  }
  if (serverError || pullResult.outcome === 'SERVER_ERROR') return 'SERVER_ERROR';
  return pushed || pullResult.changeCount > 0 ? 'SYNCED' : 'NOTHING_TO_DO';
}

export class SyncEngine {
  private running: Promise<SyncCycleOutcome> | undefined;
  /** Déclenchement reçu pendant un cycle : un nouveau cycle suit (une saisie part sans attendre). */
  private rerunRequested = false;
  private stopped = false;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private readonly onlineListener = () => void this.trigger();

  constructor(private readonly deps: SyncEngineDeps) {}

  start(): void {
    window.addEventListener('online', this.onlineListener);
    this.intervalId = setInterval(() => void this.trigger(), PERIODIC_INTERVAL_MS);
    void resetInterruptedPushes(this.deps.db)
      .catch(() => 0)
      .then(() => {
        if (!this.stopped) void this.trigger();
      });
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onlineListener);
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }

  /**
   * Un seul cycle à la fois : un déclenchement pendant un cycle en cours renvoie ce cycle et demande
   * qu'un nouveau le suive, pour qu'une opération saisie pendant un long tirage parte sans attendre
   * le déclenchement périodique.
   */
  trigger(): Promise<SyncCycleOutcome> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async loop(): Promise<SyncCycleOutcome> {
    let outcome: SyncCycleOutcome;
    do {
      this.rerunRequested = false;
      outcome = await runSyncCycle(this.deps);
      this.deps.onCycleComplete?.(outcome);
    } while (this.rerunRequested && !this.stopped && outcome !== 'SESSION_INVALID');
    return outcome;
  }
}
