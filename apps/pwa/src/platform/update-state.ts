/**
 * État « une nouvelle version de l'application attend » (06-offline-sync/01-architecture-offline.md §6 ;
 * 05-architecture/04-deploiement.md §4.3 : bandeau « nouvelle version disponible »). Module sans dépendance au
 * navigateur ni au plugin PWA, pour que l'état et le bandeau soient testables ; `service-worker.ts` y inscrit
 * l'activation du nouveau service worker et l'arrivée d'une version en attente.
 */
type Listener = () => void;
type Applier = (reloadPage?: boolean) => Promise<void>;

const listeners = new Set<Listener>();
let waiting = false;
let applier: Applier | undefined;

/** Inscrit la fonction qui active le nouveau service worker et recharge la page. */
export function setUpdateApplier(next: Applier | undefined): void {
  applier = next;
}

export function markUpdateWaiting(value: boolean): void {
  if (waiting === value) return;
  waiting = value;
  for (const listener of listeners) listener();
}

export function isUpdateWaiting(): boolean {
  return waiting;
}

export function subscribeUpdateWaiting(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mise à jour demandée par l'utilisateur, même si des opérations attendent d'être envoyées : l'outbox est dans la
 * base locale, elle survit au rechargement, et le serveur accepte les commandes de la version précédente
 * (BR-SYN-016). Seules les saisies non enregistrées d'un formulaire ouvert sont perdues. Rend faux si rien n'attend.
 */
export async function applyUpdateNow(): Promise<boolean> {
  if (!waiting || !applier) return false;
  markUpdateWaiting(false);
  try {
    await applier(true);
    return true;
  } catch (error) {
    // L'activation a échoué : la version attend toujours, l'offre est remise (sans quoi plus rien ne la proposerait
    // avant le prochain démarrage) et l'erreur ne remonte pas en rejet non traité.
    console.error('Mise à jour : l’activation de la nouvelle version a échoué', error);
    markUpdateWaiting(true);
    return false;
  }
}
