/**
 * Activation du nouveau service worker après vidage de l'outbox (06-offline-sync/01-
 * architecture-offline.md §6 « Mise à jour de l'application ») : `registerType: 'prompt'`
 * (vite.config.ts) laisse ce module décider, plutôt qu'une activation automatique qui
 * interromprait un envoi en cours. `notifyOutboxDrained()` est appelé par le moteur de
 * synchronisation (`sync/engine.ts`) après chaque cycle réussi.
 */
import { registerSW } from 'virtual:pwa-register';
import { countPending } from '../sync/outbox.js';
import { getDb } from '../storage/db.js';

let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;
let updateWaiting = false;

export function initServiceWorker(): void {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateWaiting = true;
      void tryApplyPendingUpdate();
    },
  });
}

export async function tryApplyPendingUpdate(): Promise<void> {
  if (!updateWaiting || !applyUpdate) return;
  const pending = await countPending(getDb());
  if (pending === 0) {
    updateWaiting = false;
    await applyUpdate(true);
  }
}
