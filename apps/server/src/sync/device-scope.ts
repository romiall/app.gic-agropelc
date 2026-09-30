/**
 * Périmètre de téléchargement d'un appareil (06-offline-sync/02-synchronisation.md §5.2 :
 * « utilisateur, appareil, sites, zones, équipe, emplacements — depuis les affectations de
 * rôle actives »). Couche transport (`sync/`, comme `commands/`) : compose la table
 * `identity_user_role_assignments` directement (03-graphe-dependances.md note 1, lecture de
 * table), pas via `evaluateAccess` — ce n'est pas une décision d'autorisation (une
 * permission précise sur une ressource précise), seulement l'ensemble des périmètres que les
 * affectations de l'utilisateur atteignent, à `at` (RC-01), pour filtrer `sync_change_feed`.
 *
 * Emplacements (P2-06, jeux `stock`, `transfers`, `counts` filtrés par `LOCATION`) : contrairement
 * aux sites/zones, le stock n'est pas une donnée que toute affectation doit recevoir — un
 * commercial sédentaire affecté globalement n'a pas à télécharger le stock de tous les magasins
 * (01-architecture-offline.md §3.2). Les emplacements sont donc dérivés des seules affectations
 * dont le rôle porte `inventory.stock.read`, avec la même intersection « portée maximale ∩
 * périmètre de l'affectation » que les lectures HTTP (`scope-evaluation.ts`, 01-rbac.md §2-§3) :
 * `ALL` → tous les emplacements physiques ; `SITE`/`ZONE` → ceux du site ou des sites de la zone
 * (et sous-zones) de l'affectation, tous pour une affectation `GLOBAL` ; `OWN` → les emplacements
 * `MOBILE` dont l'utilisateur est le détenteur (01-rbac.md §3), dans ce même périmètre.
 *
 * Fermes (P7-12, jeu `production` filtré par `SITE`) : pour ce jeu, les lignes `SITE` ne vont
 * qu'aux fermes qu'atteint `production.lot.read`, avec la même intersection — `ALL` ou
 * affectation `GLOBAL` → toutes les fermes (le Responsable production, affecté globalement,
 * reçoit ainsi les lots de chaque ferme), `SITE`/`ZONE` → la ferme ou les fermes de la zone. Les
 * sites des autres affectations (un magasinier affecté à une ferme) n'y donnent pas accès.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, toBin } from '../platform/kysely/uuid-columns.js';

export type DeviceScopeType = 'SITE' | 'ZONE' | 'TEAM' | 'USER' | 'DEVICE' | 'LOCATION';

export interface DeviceScopeEntry {
  readonly scopeType: DeviceScopeType;
  readonly scopeId: string;
}

const STOCK_READ_PERMISSION = 'inventory.stock.read';

/** Jeux dont les lignes `SITE` sont réservées aux fermes qu'atteint une permission de lecture. */
const FARM_DATASET_PERMISSIONS: Readonly<Record<string, string>> = {
  production: 'production.lot.read',
};

type Executor = Kysely<DB> | Transaction<DB>;

function isActiveAt(
  row: { readonly valid_to: Date | null; readonly revoked_at: Date | null },
  at: Date,
): boolean {
  if (row.valid_to !== null && row.valid_to <= at) return false;
  if (row.revoked_at !== null && row.revoked_at <= at) return false;
  return true;
}

export async function computeDeviceScope(
  executor: Executor,
  userId: string,
  deviceId: string,
  at: Date,
  dataset?: string,
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
    if (!isActiveAt(assignment, at)) continue;
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

  for (const locationId of await stockLocationsInScope(executor, userId, at)) {
    entries.push({ scopeType: 'LOCATION', scopeId: locationId });
  }

  const farmPermission = dataset === undefined ? undefined : FARM_DATASET_PERMISSIONS[dataset];
  if (farmPermission === undefined) return entries;
  const scoped: DeviceScopeEntry[] = entries.filter((entry) => entry.scopeType !== 'SITE');
  for (const siteId of await farmSitesInScope(executor, userId, farmPermission, at)) {
    scoped.push({ scopeType: 'SITE', scopeId: siteId });
  }
  return scoped;
}

/** Affectations actives de l'utilisateur dont le rôle porte `permission`, avec sa portée maximale. */
async function activeGrants(executor: Executor, userId: string, permission: string, at: Date) {
  return (
    await executor
      .selectFrom('identity_user_role_assignments as ura')
      .innerJoin('identity_role_permissions as rp', 'rp.role_id', 'ura.role_id')
      .select([
        'rp.max_scope as max_scope',
        'ura.scope_type as scope_type',
        'ura.scope_site_id as scope_site_id',
        'ura.scope_zone_id as scope_zone_id',
        'ura.valid_to as valid_to',
        'ura.revoked_at as revoked_at',
      ])
      .where('ura.user_id', '=', toBin(userId))
      .where('rp.permission_code', '=', permission)
      .where('ura.valid_from', '<=', at)
      .execute()
  ).filter((grant) => isActiveAt(grant, at));
}

/** Fermes (`site_type = FERME`) qu'atteint `permission` (P7-12). */
async function farmSitesInScope(
  executor: Executor,
  userId: string,
  permission: string,
  at: Date,
): Promise<ReadonlySet<string>> {
  const sites = new Set<string>();
  for (const grant of await activeGrants(executor, userId, permission, at)) {
    // `OWN`, `TEAM` : aucune ferme n'est rattachée à un utilisateur ni à une équipe.
    if (grant.max_scope === 'OWN' || grant.max_scope === 'TEAM') continue;
    const everywhere = grant.max_scope === 'ALL' || grant.scope_type === 'GLOBAL';
    if (!everywhere && grant.scope_type === 'TEAM') continue;
    const rows = await executor
      .selectFrom('organization_sites')
      .select('id')
      .where('site_type', '=', 'FERME')
      .$if(!everywhere && grant.scope_type === 'SITE', (qb) =>
        qb.where('id', '=', grant.scope_site_id ?? Buffer.alloc(16)),
      )
      .$if(!everywhere && grant.scope_type === 'ZONE', (qb) =>
        qb.where((eb) =>
          eb(
            'zone_id',
            'in',
            eb
              .selectFrom('organization_zone_ancestors')
              .select('zone_id')
              .where('ancestor_id', '=', grant.scope_zone_id ?? Buffer.alloc(16)),
          ),
        ),
      )
      .execute();
    for (const row of rows) sites.add(fromBin(row.id));
  }
  return sites;
}

async function stockLocationsInScope(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<ReadonlySet<string>> {
  const grants = await activeGrants(executor, userId, STOCK_READ_PERMISSION, at);

  const locations = new Set<string>();
  for (const grant of grants) {
    // `TEAM` : aucune ressource de stock n'est rattachée à une équipe (01-rbac.md §5.3 n'accorde
    // jamais `inventory.stock.read` en TEAM) — rien à télécharger à ce titre.
    if (grant.max_scope === 'TEAM') continue;
    const ownOnly = grant.max_scope === 'OWN';
    const everywhere = grant.max_scope === 'ALL' || grant.scope_type === 'GLOBAL';
    if (!everywhere && grant.scope_type === 'TEAM') continue;

    const rows = await executor
      .selectFrom('organization_locations as l')
      .innerJoin('organization_sites as s', 's.id', 'l.site_id')
      .select('l.id as id')
      .where('l.is_virtual', '=', 0)
      .$if(ownOnly, (qb) =>
        qb.where('l.location_type', '=', 'MOBILE').where('l.custodian_user_id', '=', toBin(userId)),
      )
      .$if(!everywhere && grant.scope_type === 'SITE', (qb) =>
        qb.where('l.site_id', '=', grant.scope_site_id ?? Buffer.alloc(16)),
      )
      .$if(!everywhere && grant.scope_type === 'ZONE', (qb) =>
        qb.where((eb) =>
          eb(
            's.zone_id',
            'in',
            eb
              .selectFrom('organization_zone_ancestors')
              .select('zone_id')
              .where('ancestor_id', '=', grant.scope_zone_id ?? Buffer.alloc(16)),
          ),
        ),
      )
      .execute();
    for (const row of rows) locations.add(fromBin(row.id));
  }
  return locations;
}
