/**
 * Position GPS relevée à l'ouverture d'un écran (visite, prise de service), puis à la demande.
 * `accuracyM` : rayon de précision en mètres, arrondi, ou `null` si le navigateur ne le donne pas.
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

export function useGeolocation(): {
  readonly position: DevicePosition | null;
  readonly state: GeolocationState;
  readonly locate: () => void;
  /** Oublie la position relevée et en relève une nouvelle (saisie suivante). */
  readonly reset: () => void;
} {
  const [position, setPosition] = useState<DevicePosition | null>(null);
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
            ? Math.round(result.coords.accuracy)
            : null,
        });
        setState('idle');
      },
      () => setState('unavailable'),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    if (hasGeolocation()) request();
  }, [request]);

  const locate = useCallback(() => {
    if (!hasGeolocation()) {
      setState('unavailable');
      return;
    }
    setState('locating');
    request();
  }, [request]);

  const reset = useCallback(() => {
    setPosition(null);
    locate();
  }, [locate]);

  return { position, state, locate, reset };
}
