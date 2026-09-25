/**
 * Instance unique du moteur de synchronisation, démarrée quand la session passe à
 * `unlocked` (`App.tsx`) et arrêtée à la déconnexion. Module-singleton (comme
 * `session-runtime.ts`) : accessible depuis un bouton d'écran (« forcer la synchronisation »)
 * sans faire transiter l'instance par les props React.
 */
import { getDb } from '../../storage/db.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { SyncEngine, type SyncEngineDeps } from '../../sync/engine.js';
import { tryApplyPendingUpdate } from '../../platform/service-worker.js';

let engine: SyncEngine | undefined;

export function startSyncEngine(deviceId: string, onSessionInvalid: () => void): SyncEngine {
  const deps: SyncEngineDeps = {
    db: getDb(),
    clock,
    idGenerator,
    deviceId,
    onSessionInvalid,
    onCycleComplete: () => void tryApplyPendingUpdate(),
  };
  engine = new SyncEngine(deps);
  engine.start();
  return engine;
}

export function stopSyncEngine(): void {
  engine?.stop();
  engine = undefined;
}

export function getSyncEngine(): SyncEngine | undefined {
  return engine;
}
