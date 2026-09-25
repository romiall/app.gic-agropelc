/**
 * Périmètre de téléchargement d'un appareil (06-offline-sync/02-synchronisation.md §5.2 :
 * « utilisateur, appareil, sites, zones, équipe, emplacements — depuis les affectations de
 * rôle actives »). Couche transport (`sync/`, comme `commands/`) : compose la table
 * `identity_user_role_assignments` directement (03-graphe-dependances.md note 1, lecture de
 * table), pas via `evaluateAccess` — ce n'est pas une décision d'autorisation (une
 * permission précise sur une ressource précise), seulement l'ensemble des périmètres que les
 * affectations de l'utilisateur atteignent, à `at` (RC-01), pour filtrer `sync_change_feed`.
 *
 * Emplacements (« emplacements » du §5.2) : hors périmètre ici — aucun gestionnaire n'écrit
 * encore de ligne `change_feed` avec `scope_type = LOCATION` (P0-11 n'émet que du GLOBAL) ;
 * ajouté quand un module (stock…) en aura besoin.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, toBin } from '../platform/kysely/uuid-columns.js';

export type DeviceScopeType = 'SITE' | 'ZONE' | 'TEAM' | 'USER' | 'DEVICE';

export interface DeviceScopeEntry {
  readonly scopeType: DeviceScopeType;
  readonly scopeId: string;
}

export async function computeDeviceScope(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
  deviceId: string,
  at: Date,
): Promise<readonly DeviceScopeEntry[]> {
  const entries: DeviceScopeEntry[] = [
    { scopeType: 'USER', scopeId: userId },
    { scopeType: 'DEVICE', scopeId: deviceId },
  ];

  const assignments = await executor
    .selectFrom('identity_user_role_assignments')
    .select([
      'scope_type',
      'scope_site_id',
      'scope_zone_id',
      'scope_team_id',
      'valid_from',
      'valid_to',
      'revoked_at',
    ])
    .where('user_id', '=', toBin(userId))
    .where('valid_from', '<=', at)
    .execute();

  for (const assignment of assignments) {
    if (assignment.valid_to !== null && assignment.valid_to <= at) continue;
    if (assignment.revoked_at !== null && assignment.revoked_at <= at) continue;
    switch (assignment.scope_type) {
      case 'SITE':
        if (assignment.scope_site_id) {
          entries.push({ scopeType: 'SITE', scopeId: fromBin(assignment.scope_site_id) });
        }
        break;
      case 'ZONE':
        if (assignment.scope_zone_id) {
          entries.push({ scopeType: 'ZONE', scopeId: fromBin(assignment.scope_zone_id) });
        }
        break;
      case 'TEAM':
        if (assignment.scope_team_id) {
          entries.push({ scopeType: 'TEAM', scopeId: fromBin(assignment.scope_team_id) });
        }
        break;
      // GLOBAL : aucune entrée propre — sync-pull.service.ts inclut toujours scope_type = GLOBAL.
    }
  }
  return entries;
}
