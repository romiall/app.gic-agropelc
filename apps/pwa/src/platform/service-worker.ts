/**
 * Activation du nouveau service worker après vidage de l'outbox (06-offline-sync/01-
 * architecture-offline.md §6 « Mise à jour de l'application ») : `registerType: 'prompt'`
 * (vite.config.ts) laisse ce module décider, plutôt qu'une activation automatique qui
 * interromprait un envoi en cours. `notifyOutboxDrained()` est appelé par le moteur de
 * synchronisation (`sync/engine.ts`) après chaque cycle réussi.
 *
 * Une version qui attend est annoncée par le bandeau « nouvelle version disponible »
 * (`features/sync/UpdateBanner.tsx`, état dans `update-state.ts`), qui offre aussi la mise à jour à la
 * demande : sans elle, un appareil dont la file est bloquée ne recevrait jamais la correction qui la débloque
 * avant d'être fermé complètement (ADR-052).
 */
import { registerSW } from 'virtual:pwa-register';
import { countPending } from '../sync/outbox.js';
import { getDb } from '../storage/db.js';
import { isUpdateWaiting, markUpdateWaiting, setUpdateApplier } from './update-state.js';

let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;

export function initServiceWorker(): void {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      markUpdateWaiting(true);
      void tryApplyPendingUpdate();
    },
  });
  setUpdateApplier(applyUpdate);
}

export async function tryApplyPendingUpdate(): Promise<void> {
  if (!isUpdateWaiting() || !applyUpdate) return;
  const pending = await countPending(getDb());
  if (pending === 0) {
    markUpdateWaiting(false);
    await applyUpdate(true);
  }
}
