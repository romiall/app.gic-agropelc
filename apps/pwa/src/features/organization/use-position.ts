/**
 * Position de l'appareil pour le géorepère d'une zone (ECR-ADM-06, AV-492) : « Ma position » remplit la
 * latitude et la longitude depuis le GPS du téléphone, à l'endroit où l'on se tient. Aucune carte (budget de
 * taille, NFR-05, et réseau faible) : les champs restent modifiables à la main.
 */
import { useState } from 'react';

export type PositionState =
  | { readonly status: 'IDLE' }
  | { readonly status: 'WAITING' }
  | { readonly status: 'ERROR'; readonly reason: 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' };

export interface Coordinates {
  readonly lat: number;
  readonly lng: number;
  /** Précision annoncée par le GPS, en mètres. */
  readonly accuracyM: number | null;
}

/** Demande la position courante ; `onFound` reçoit les coordonnées, l'état dit l'attente ou l'échec. */
export function useCurrentPosition(onFound: (position: Coordinates) => void) {
  const [state, setState] = useState<PositionState>({ status: 'IDLE' });
  const request = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'ERROR', reason: 'UNAVAILABLE' });
      return;
    }
    setState({ status: 'WAITING' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState({ status: 'IDLE' });
        onFound({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        });
      },
      (error) =>
        setState({
          status: 'ERROR',
          reason:
            error.code === error.PERMISSION_DENIED
              ? 'DENIED'
              : error.code === error.TIMEOUT
                ? 'TIMEOUT'
                : 'UNAVAILABLE',
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };
  return { state, request };
}
