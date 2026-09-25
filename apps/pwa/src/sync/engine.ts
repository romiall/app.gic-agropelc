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

const PERIODIC_INTERVAL_MS = 30_000;
const MAX_PUSH_BATCHES_PER_CYCLE = 20; // borne de sécurité (outbox anormalement longue)

export type SyncCycleOutcome = 'SYNCED' | 'OFFLINE' | 'SESSION_INVALID' | 'NOTHING_TO_DO';

export interface SyncEngineDeps {
  readonly db: GicDatabase;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly deviceId: string;
  readonly onSessionInvalid: () => void;
  /** Appelé après chaque cycle (ex. tenter l'activation d'un service worker en attente). */
  readonly onCycleComplete?: (outcome: SyncCycleOutcome) => void;
}

export async function runSyncCycle(deps: SyncEngineDeps): Promise<SyncCycleOutcome> {
  let pushed = false;
  for (let i = 0; i < MAX_PUSH_BATCHES_PER_CYCLE; i++) {
    const result = await runPushCycle(deps.db, deps);
    if (result.outcome === 'NOTHING_TO_PUSH') break;
    if (result.outcome === 'OFFLINE') return 'OFFLINE';
    if (result.outcome === 'SESSION_INVALID') {
      deps.onSessionInvalid();
      return 'SESSION_INVALID';
    }
    pushed = true;
  }

  const pullResult = await runPullCycle(deps.db, deps);
  if (pullResult.outcome === 'OFFLINE') return pushed ? 'SYNCED' : 'OFFLINE';
  if (pullResult.outcome === 'SESSION_INVALID') {
    deps.onSessionInvalid();
    return 'SESSION_INVALID';
  }
  return pushed || pullResult.changeCount > 0 ? 'SYNCED' : 'NOTHING_TO_DO';
}

export class SyncEngine {
  private running: Promise<SyncCycleOutcome> | undefined;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private readonly onlineListener = () => void this.trigger();

  constructor(private readonly deps: SyncEngineDeps) {}

  start(): void {
    window.addEventListener('online', this.onlineListener);
    this.intervalId = setInterval(() => void this.trigger(), PERIODIC_INTERVAL_MS);
    void this.trigger();
  }

  stop(): void {
    window.removeEventListener('online', this.onlineListener);
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }

  /** Idempotent pendant un cycle en cours : renvoie le cycle déjà en vol. */
  trigger(): Promise<SyncCycleOutcome> {
    this.running ??= runSyncCycle(this.deps)
      .then((outcome) => {
        this.deps.onCycleComplete?.(outcome);
        return outcome;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
