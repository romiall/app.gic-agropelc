/**
 * Bandeau « appareil en attente d'approbation » (MP-06 ; AV-228 : l'écran d'attente restait à faire ;
 * BR-ADM-007). Tant que cet appareil est `PENDING`, ses opérations attendent l'approbation : le bandeau
 * donne son code court, à communiquer au responsable (ou à l'installateur, `db:approve-device`, AV-254).
 *
 * État courant : la fiche de l'appareil publiée à lui seul (jeu `device`, lue par son identifiant), à
 * défaut l'état reçu à la connexion ; code court : même ordre (une fiche n'existe qu'après une première
 * décision sur l'appareil).
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../components/ui/index.js';
import { getDb } from '../../storage/db.js';
import { getProjected } from '../../storage/projections.js';
import { useAuth } from '../auth/AuthContext.js';

interface DeviceProjection {
  readonly status?: string;
  readonly short_code?: string;
}

export function DeviceApprovalBanner() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  // `undefined` : lecture en cours ; `null` : absent. Rien n'est affiché avant les deux lectures, pour ne
  // pas montrer un bandeau sans code qui se corrigerait l'instant d'après.
  const projection = useLiveQuery(
    () =>
      deviceId
        ? getProjected<DeviceProjection>(getDb(), 'device', 'DEVICE', deviceId).then(
            (row) => row ?? null,
          )
        : Promise.resolve(null),
    [deviceId],
  );
  const session = useLiveQuery(
    () =>
      getDb()
        .session.get('current')
        .then((row) => row ?? null),
    [],
  );
  if (state.status !== 'unlocked' || projection === undefined || session === undefined) return null;
  const status = projection?.status ?? session?.device_status ?? state.deviceStatus;
  if (status !== 'PENDING' || dismissed) return null;
  const code = projection?.short_code ?? session?.device_short_code;
  // Refermable pour la session en cours : il revient à la prochaine ouverture tant que l'appareil attend.
  return (
    <Banner tone="warn" role="status" onDismiss={() => setDismissed(true)}>
      {code ? t('devices.pending_banner', { code }) : t('devices.pending_banner_no_code')}
    </Banner>
  );
}
