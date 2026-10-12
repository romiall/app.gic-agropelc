/**
 * Joignabilité réelle du serveur (ADR-037). `navigator.onLine` ne dit que si l'appareil a une
 * interface réseau : sur un Wi-Fi sans accès Internet, il reste vrai. Le moteur de synchronisation
 * rapporte ici l'issue de chaque cycle ; l'appareil est tenu pour hors ligne dès qu'un cycle n'a pas
 * pu joindre le serveur, jusqu'au cycle suivant qui y parvient. Cet état décide du blocage local de la
 * vente hors ligne (AV-025), du bandeau « hors ligne » et de `captured_offline` (« état du réseau à la
 * saisie », 01-architecture-offline.md §5).
 */
export type SyncOutcome =
  'SYNCED' | 'OFFLINE' | 'SERVER_ERROR' | 'SESSION_INVALID' | 'NOTHING_TO_DO' | 'STOPPED';

type Listener = () => void;

let serverUnreachable = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Seul un échec réseau rend le serveur injoignable ; une erreur HTTP prouve qu'il répond. */
export function reportSyncOutcome(outcome: SyncOutcome): void {
  // Cycle interrompu (moteur arrêté, relève) : il ne dit rien de la joignabilité.
  if (outcome === 'STOPPED') return;
  const unreachable = outcome === 'OFFLINE';
  if (unreachable === serverUnreachable) return;
  serverUnreachable = unreachable;
  notify();
}

export function isEffectivelyOnline(): boolean {
  const interfaceUp = typeof navigator === 'undefined' ? true : navigator.onLine;
  return interfaceUp && !serverUnreachable;
}

/** Abonnement aux changements (événements `online`/`offline` du navigateur et issues des cycles). */
export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

/** Réservé aux tests : état initial. */
export function resetConnectivityForTests(): void {
  serverUnreachable = false;
}
