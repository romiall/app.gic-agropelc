/**
 * Position GPS relevée à l'ouverture d'un écran (visite, prise de service, vente d'un commercial), puis à la
 * demande. `accuracyM` : rayon de précision en mètres, au dixième (colonne `DECIMAL(8,1)` du serveur ; jamais
 * arrondi au mètre, BR-TER-012), ou `null` si le navigateur ne le donne pas. Un relevé en échec efface
 * la position : une position ancienne n'est jamais reprise pour un pointage ou une visite.
 *
 * `enabled: false` (AV-538) : aucun relevé, aucune demande d'autorisation de localisation ; le relevé démarre
 * dès que `enabled` passe à vrai (rôle connu après l'ouverture de l'écran).
 */
import { useCallback, useEffect, useState } from 'react';

export interface DevicePosition {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
}

export type GeolocationState = 'idle' | 'locating' | 'unavailable';

const GPS_TIMEOUT_MS = 15_000;

const hasGeolocation = (): boolean =>
  typeof navigator !== 'undefined' && navigator.geolocation !== undefined;

export function useGeolocation(options: { readonly enabled?: boolean } = {}): {
  readonly position: DevicePosition | null;
  readonly state: GeolocationState;
  readonly locate: () => void;
  /** Oublie la position relevée et en relève une nouvelle (saisie suivante). */
  readonly reset: () => void;
} {
  const enabled = options.enabled ?? true;
  const [position, setPosition] = useState<DevicePosition | null>(null);
  // Le premier relevé est « en cours » dès l'ouverture ; désactivé, l'état rendu est « idle » (voir le retour).
  const [state, setState] = useState<GeolocationState>(() =>
    hasGeolocation() ? 'locating' : 'unavailable',
  );

  const request = useCallback(() => {
    navigator.geolocation.getCurrentPosition(
      (result) => {
        setPosition({
          lat: result.coords.latitude,
          lng: result.coords.longitude,
          accuracyM: Number.isFinite(result.coords.accuracy)
            ? Math.round(result.coords.accuracy * 10) / 10
            : null,
        });
        setState('idle');
      },
      () => {
        setPosition(null);
        setState('unavailable');
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    if (enabled && hasGeolocation()) request();
  }, [enabled, request]);

  const locate = useCallback(() => {
    if (!enabled) return;
    if (!hasGeolocation()) {
      setState('unavailable');
      return;
    }
    setPosition(null);
    setState('locating');
    request();
  }, [enabled, request]);

  const reset = useCallback(() => {
    setPosition(null);
    locate();
  }, [locate]);

  // Désactivé (AV-538) : ni position ni relevé en cours, comme si l'écran n'avait rien demandé.
  return {
    position: enabled ? position : null,
    state: enabled ? state : 'idle',
    locate,
    reset,
  };
}
