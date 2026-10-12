/**
 * Navigation par rôle mémorisée sur l'appareil (ADR-036) : à chaque réponse de l'accueil, les rôles
 * et les actions du jour de l'utilisateur sont conservés ; le menu les relit sans réseau. Un vendeur
 * qui ouvre l'application hors ligne garde ainsi accès à « + VENTE » (WF-J2), même si l'accueil,
 * calculé par le serveur, ne peut pas s'afficher.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { HomeResponse } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import { getDb, type GicDatabase, type NavigationRecord } from '../../storage/db.js';

export async function rememberNavigation(
  db: GicDatabase,
  clock: Clock,
  userId: string,
  response: Pick<HomeResponse, 'user' | 'sections'>,
): Promise<void> {
  const record: NavigationRecord = {
    user_id: userId,
    roles: [...response.user.roles],
    sections: response.sections.map((section) => ({
      role: section.role,
      roleLabel: section.roleLabel,
      actions: section.actions.map((action) => ({
        code: action.code,
        label: action.label,
        hint: action.hint,
        route: action.route,
        primary: action.primary,
      })),
    })),
    saved_at: clock.now().toISOString(),
  };
  await db.navigation.put(record);
}

/** Navigation mémorisée de l'utilisateur ; `null` s'il n'y en a pas, `undefined` pendant la lecture. */
export function useRememberedNavigation(
  userId: string | undefined,
): NavigationRecord | null | undefined {
  return useLiveQuery(
    async () => (userId ? ((await getDb().navigation.get(userId)) ?? null) : null),
    [userId],
  );
}
