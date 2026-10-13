/**
 * Bandeau d'autonomie hors connexion (AV-009) : permanent au-delà de `offline.warning_hours`,
 * lecture seule au-delà de `offline.max_autonomy_hours` (les nouvelles opérations sont refusées par
 * `submitCommand`). Réévalué à chaque changement de la base locale (synchronisation, outbox).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { clock } from '../../platform/composition.js';
import { getDb } from '../../storage/db.js';
import { loadAutonomy } from './autonomy.js';

export function AutonomyBanner() {
  const { t } = useTranslation();
  const autonomy = useLiveQuery(() => loadAutonomy(getDb(), clock.now()), []);
  if (!autonomy || autonomy.level === 'OK') return null;
  const values = { hours: autonomy.hours ?? 0, max: autonomy.maxHours };
  return autonomy.level === 'READ_ONLY' ? (
    <p className="alert alert-error" role="alert">
      {t('sync.autonomy_read_only', values)}
    </p>
  ) : (
    <p className="home-banner" role="status">
      {t('sync.autonomy_warning', values)}
    </p>
  );
}
