/**
 * Chargement de l'accueil par rôle (ECR-ADM-03 ; ADR-030) : `GET /api/v1/home` à l'ouverture, à
 * intervalle régulier tant que l'écran est visible, au retour du réseau et à la demande. Le serveur
 * valide déjà la réponse contre le contrat partagé ; la PWA ne répète pas cette validation (zod
 * alourdirait le premier chargement, NFR-05) et vérifie seulement la forme dont elle dépend.
 *
 * Hors ligne, l'écran garde la **dernière réponse reçue pendant la session** avec son heure de
 * calcul (BR-ANA-005) ; rien n'est persisté sur l'appareil à ce stade (ADR-030, Conséquences).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomeResponse } from '@gic/contracts';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { getSessionRuntime } from '../auth/session-runtime.js';
import { clock } from '../../platform/composition.js';
import { rememberNavigation } from '../navigation/navigation-store.js';

export const HOME_REFRESH_MS = 60_000;

export type HomeError = 'OFFLINE' | 'SESSION_INVALID' | 'SERVER_ERROR';

export interface HomeState {
  /** Dernière réponse reçue, conservée en cas d'échec d'un rafraîchissement. */
  readonly data: HomeResponse | undefined;
  readonly loading: boolean;
  readonly error: HomeError | undefined;
  readonly refresh: () => void;
}

function isHomeResponse(body: unknown): body is HomeResponse {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<HomeResponse>;
  return (
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.businessDay === 'string' &&
    Array.isArray(candidate.signals) &&
    Array.isArray(candidate.sections) &&
    typeof candidate.user === 'object' &&
    candidate.user !== null
  );
}

export function useHome(): HomeState {
  const [data, setData] = useState<HomeResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<HomeError | undefined>(undefined);
  // Évite qu'une réponse lente écrase une plus récente et qu'un démontage provoque une mise à jour.
  const sequence = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    const result = await authorizedRequest<unknown>(getDb(), '/api/v1/home', { method: 'GET' });
    if (!mounted.current || current !== sequence.current) return;
    if (result.ok && isHomeResponse(result.data)) {
      setData(result.data);
      setError(undefined);
      // Navigation par rôle utilisable hors ligne (ADR-036) ; un échec d'écriture locale n'empêche
      // pas l'affichage de l'accueil.
      const userId = getSessionRuntime()?.userId;
      if (userId) {
        void rememberNavigation(getDb(), clock, userId, result.data).catch(() => undefined);
      }
    } else if (result.ok) {
      setError('SERVER_ERROR');
    } else if (result.reason === 'OFFLINE') {
      setError('OFFLINE');
    } else if (result.reason === 'SESSION_INVALID') {
      setError('SESSION_INVALID');
    } else {
      setError('SERVER_ERROR');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Premier chargement différé d'un cycle : les mises à jour d'état viennent de la réponse
    // réseau, jamais du corps de l'effet (react-hooks/set-state-in-effect).
    const first = window.setTimeout(() => void load(), 0);

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refreshIfVisible, HOME_REFRESH_MS);
    window.addEventListener('online', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      mounted.current = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener('online', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [load]);

  // Chargement visible seulement à la demande : l'état initial est déjà « en chargement », et les
  // rafraîchissements périodiques se font sans clignotement.
  const refresh = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);
  return { data, loading, error, refresh };
}
