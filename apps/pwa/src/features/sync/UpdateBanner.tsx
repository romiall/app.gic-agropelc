/**
 * Bandeau « nouvelle version disponible » (05-architecture/04-deploiement.md §4.3 ; ADR-052, AV-505).
 *
 * Le nouveau service worker n'est activé tout seul qu'une fois l'outbox vide (`platform/service-worker.ts`) : un
 * appareil dont la file est bloquée, ou qui reste chargé de longues opérations, ne recevrait jamais la mise à jour
 * qui le débloque avant d'être fermé complètement, ce que personne ne sait faire sans consigne. Le bandeau annonce
 * la version qui attend et offre de l'installer tout de suite ; il dit ce qu'il advient des opérations en attente
 * (elles restent dans la base locale et partent après la mise à jour : le serveur accepte les commandes de la
 * version précédente, BR-SYN-016) et de la saisie en cours (perdue).
 */
import { useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Banner, Button } from '../../components/ui/index.js';
import {
  applyUpdateNow,
  isUpdateWaiting,
  subscribeUpdateWaiting,
} from '../../platform/update-state.js';
import { getDb } from '../../storage/db.js';
import { countPending } from '../../sync/outbox.js';

export function UpdateBanner() {
  const { t } = useTranslation();
  const waiting = useSyncExternalStore(subscribeUpdateWaiting, isUpdateWaiting);
  const pending = useLiveQuery(() => countPending(getDb()), []) ?? 0;
  const [applying, setApplying] = useState(false);
  if (!waiting && !applying) return null;
  return (
    <Banner tone="info" role="status">
      <p>{t('sync.update_available')}</p>
      {pending > 0 ? <p>{t('sync.update_pending', { count: pending })}</p> : null}
      <Button
        variant="tonal"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          void applyUpdateNow().finally(() => setApplying(false));
        }}
      >
        {applying ? t('sync.update_applying') : t('sync.update_now')}
      </Button>
    </Banner>
  );
}
