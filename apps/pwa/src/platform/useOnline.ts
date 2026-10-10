/**
 * État du réseau vu par le navigateur (`navigator.onLine`), suivi par les événements `online` et
 * `offline`. Indicatif : il décide seulement de l'avertissement affiché et du blocage local de la
 * vente hors ligne (AV-025) ; le moteur de synchronisation constate lui-même l'échec d'un envoi.
 */
import { useEffect, useState } from 'react';

const current = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine);

export function useOnline(): boolean {
  const [online, setOnline] = useState(current);
  useEffect(() => {
    const update = () => setOnline(current());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
