/**
 * Lectures en ligne des écrans de gestion (achats, objectifs, tarifs…) : la dernière donnée reçue reste
 * affichée pendant une relecture, une coupure ou un échec, mais elle est signalée « périmée » tant
 * qu'elle ne correspond pas à la dernière opération ; les actions s'y bloquent (une seconde opération
 * sur une liste périmée serait refusée, ou lèverait une exception en base). Un échec se relit par
 * `retry` ; un refus de droit (403, 404) se distingue d'une panne passagère.
 */
import { useEffect, useRef, useState } from 'react';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';

export type ReadResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly denied: boolean };

/** Lecture d'un chemin de l'API ; `denied` pour un refus de droit ou une ressource hors portée. */
export async function readPath<T>(path: string): Promise<ReadResult<T>> {
  const result = await authorizedRequest<T>(getDb(), path, { method: 'GET' });
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    denied: result.reason === 'HTTP_ERROR' && (result.status === 403 || result.status === 404),
  };
}

/** Pages réunies d'une ou plusieurs listes ; `more` si une liste a encore une suite non lue. */
export interface Pages<T> {
  readonly items: readonly T[];
  readonly more: boolean;
}

/**
 * Lit, pour chaque chemin, jusqu'à `maxPages` pages en suivant `next_cursor` (paramètre `cursor`),
 * et réunit les éléments du champ `field`.
 */
export async function readPages<T>(
  paths: readonly string[],
  field: string,
  maxPages: number,
): Promise<ReadResult<Pages<T>>> {
  const items: T[] = [];
  let more = false;
  for (const path of paths) {
    let cursor: string | null = null;
    let pages = 0;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const result: ReadResult<Record<string, unknown>> = await readPath<Record<string, unknown>>(
        cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path,
      );
      if (!result.ok) return result;
      items.push(...((result.data[field] as T[] | undefined) ?? []));
      const next: unknown = result.data.next_cursor;
      cursor = typeof next === 'string' && next ? next : null;
      pages += 1;
    } while (cursor !== null && pages < maxPages);
    if (cursor !== null) more = true;
  }
  return { ok: true, data: { items, more } };
}

export interface OnlineRead<T> {
  /** Dernière donnée lue pour cette clé (`undefined` avant la première réponse). */
  readonly data: T | undefined;
  /**
   * Donnée qui ne reflète pas encore la dernière opération : relecture en cours, hors ligne, ou
   * dernière lecture en échec. Les actions s'y bloquent.
   */
  readonly stale: boolean;
  /** Dernière lecture en échec (réseau ou serveur). */
  readonly failed: boolean;
  /** Refus de droit ou ressource hors portée (403, 404). */
  readonly denied: boolean;
  /** Relit (bouton « Réessayer »). */
  readonly retry: () => void;
}

/**
 * Lecture en ligne identifiée par `key` (le chemin, ou la liste des chemins) et relue à chaque
 * changement de `reloadKey` (réponse d'une opération), au retour du réseau et sur `retry`. `key` nul :
 * rien à lire. Après un retour du réseau ou un `retry`, la donnée d'avant reste « périmée » jusqu'à la
 * réponse de la relecture (elle a pu changer pendant la coupure).
 */
export function useOnlineRead<T>(
  key: string | null,
  load: (key: string) => Promise<ReadResult<T>>,
  online: boolean,
  reloadKey: string,
): OnlineRead<T> {
  // Dernier chargeur fourni, relu par l'effet de lecture (déclaré avant lui, il s'exécute avant).
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const [attempt, setAttempt] = useState(0);
  // Retours du réseau comptés pendant le rendu (état dérivé) : la donnée d'avant la coupure est
  // périmée dès le premier rendu en ligne, avant même que la relecture parte.
  const [connection, setConnection] = useState({ online, returns: 0 });
  if (connection.online !== online) {
    setConnection({ online, returns: connection.returns + (online ? 1 : 0) });
  }
  const returns =
    connection.online !== online ? connection.returns + (online ? 1 : 0) : connection.returns;
  const generation = `${returns}:${attempt}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly reloadKey: string;
    readonly generation: string;
    readonly data: T | undefined;
    readonly failed: boolean;
    readonly denied: boolean;
  }>();
  useEffect(() => {
    if (!key || !online) return;
    let cancelled = false;
    void loader.current(key).then((result) => {
      if (cancelled) return;
      setState((current) =>
        result.ok
          ? { key, reloadKey, generation, data: result.data, failed: false, denied: false }
          : {
              key,
              reloadKey,
              generation,
              data: current?.key === key ? current.data : undefined,
              failed: true,
              denied: result.denied,
            },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, reloadKey, generation]);
  const same = key !== null && state?.key === key;
  return {
    data: same ? state.data : undefined,
    stale:
      key !== null &&
      (!same ||
        state.reloadKey !== reloadKey ||
        state.generation !== generation ||
        state.failed ||
        !online),
    failed: same && state.failed,
    denied: same && state.denied,
    retry: () => setAttempt((value) => value + 1),
  };
}
