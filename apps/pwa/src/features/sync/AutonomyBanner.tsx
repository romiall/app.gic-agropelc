/**
 * Bandeau d'autonomie hors connexion (AV-009) : permanent au-delà de `offline.warning_hours`,
 * lecture seule au-delà de `offline.max_autonomy_hours` (les nouvelles opérations sont refusées par
 * `enqueueCommand`). Réévalué à chaque synchronisation (état de l'appareil, paramètres), à chaque
 * minute et au retour de l'application au premier plan : l'application peut rester ouverte des jours.
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { getDb } from '../../storage/db.js';
import { loadAutonomy } from './autonomy.js';

/** Réévaluation périodique du bandeau (affichage seulement : les seuils sont des paramètres). */
const REFRESH_MS = 60_000;

export function AutonomyBanner() {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((value) => value + 1);
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const autonomy = useLiveQuery(() => loadAutonomy(getDb(), clock.now()), [tick]);
  if (!autonomy || autonomy.level === 'OK') return null;
  const values = { hours: autonomy.hours ?? 0, max: autonomy.maxHours };
  return autonomy.level === 'READ_ONLY' ? (
    <Banner tone="bad" role="alert">
      {t('sync.autonomy_read_only', values)}
    </Banner>
  ) : (
    <Banner tone="warn" role="status">
      {t('sync.autonomy_warning', values)}
    </Banner>
  );
}
