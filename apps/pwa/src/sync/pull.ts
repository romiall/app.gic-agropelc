/**
 * Téléchargement incrémental depuis `GET /api/v1/sync/pull` (06-offline-sync/02-
 * synchronisation.md §5). Un appareil neuf appelle ce même point avec `cursor = 0` : pas de
 * code de chargement initial séparé (même remarque que `sync-pull.service.ts` côté serveur).
 *
 * Jeux de données : miroir exact de ce que le serveur publie (vérifié dans
 * `apps/server/src/modules/<module>/application/sync-changes.ts` et `command-pipeline.service.ts`), pas
 * encore le catalogue `me`/`org`/`catalog`/`pricing` de l'architecture cible
 * (01-architecture-offline.md §3.1) :
 * - référentiels et catalogue : repli générique du pipeline, jeu = `aggregate_type` en minuscules,
 *   portée `GLOBAL` (`product`, `price_rule`…), sauf les moyens de paiement (`catalog`, ADR-031) ;
 * - jeux à périmètre réel, émis par leur module (`stock`, `orders`, `cash`…).
 * Le coût standard (`product_standard_cost`) n'est volontairement pas téléchargé : aucun coût sur
 * l'appareil (RC-05). Un jeu dont l'utilisateur n'a pas le périmètre revient vide.
 */
import type { Change, PullResponse } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import type { GicDatabase, Projection } from '../storage/db.js';
import { authorizedRequest } from './api-client.js';

export const KNOWN_DATASETS = [
  // P0 : identité, organisation, paramètres, validations, pièces (repli générique `GLOBAL`).
  'user',
  'device',
  'role_assignment',
  'zone',
  'site',
  'location',
  'team',
  'team_membership',
  'setting',
  'control_policy',
  'approval_request',
  'attachment',
  // P1 : catalogue, tarifs, fournisseurs (repli générique `GLOBAL`) ; moyens de paiement (P4-11).
  'product_category',
  'product',
  'product_unit',
  'reason_code',
  'customer_category',
  'price_rule',
  'commercial_campaign',
  'supplier',
  'catalog',
  // P2 et P5 : stock, transferts, inventaires (`LOCATION`), quotas de l'appareil (`DEVICE`).
  'stock',
  'transfers',
  'counts',
  'allocations',
  // P3 : portefeuille, activité commerciale, pointage.
  'customers',
  'crm_activity',
  'fieldwork',
  // P6 et P7 : achats et réceptions du site, production des fermes.
  'procurement',
  'production',
  // P4 : commandes ouvertes, ventes et encaissements récents, caisses.
  'orders',
  'sales_recent',
  'cash',
  // Alertes, notifications, conflits et demandes de validation de l'utilisateur.
  'comms',
] as const;

export type KnownDataset = (typeof KNOWN_DATASETS)[number];

/**
 * Types d'entités dont la clé réelle inclut le périmètre de la ligne (`entity-projections.ts`) : un
 * solde de stock est identifié par produit × emplacement, alors que le flux ne porte que le produit
 * (`entity_id`) et l'emplacement en périmètre (`LOCATION`). Sans cela, les soldes d'un même produit
 * sur deux emplacements s'écraseraient sur l'appareil.
 */
const SCOPED_KEY_ENTITY_TYPES: ReadonlySet<string> = new Set(['STOCK_BALANCE']);

export function projectionKey(
  change: Pick<Change, 'dataset' | 'entity_type' | 'entity_id' | 'scope_id'>,
): string {
  return SCOPED_KEY_ENTITY_TYPES.has(change.entity_type)
    ? `${change.dataset}:${change.entity_type}:${change.scope_id ?? ''}:${change.entity_id}`
    : `${change.dataset}:${change.entity_type}:${change.entity_id}`;
}

function scopeKeyOf(change: {
  readonly scope_type: string;
  readonly scope_id: string | null;
}): string {
  return `${change.scope_type}:${change.scope_id ?? ''}`;
}

/** Périmètres déjà connus d'une projection (ligne antérieure au champ `scopes` comprise). */
function knownScopes(existing: Projection | undefined): readonly string[] {
  if (!existing) return [];
  return existing.scopes ?? [scopeKeyOf(existing)];
}

const PAGE_LIMIT = 500;

/**
 * Applique un changement (02-synchronisation.md §5.3) : `DELETE` retire l'entité ; `SCOPE_EXIT` ne
 * retire que le périmètre concerné, et l'entité seulement s'il n'en reste aucun (une commande
 * déplacée quitte l'ancien emplacement mais reste chez son titulaire) ; `UPSERT` remplace les
 * données et ajoute son périmètre.
 */
export async function applyChange(db: GicDatabase, change: Change): Promise<void> {
  const key = projectionKey(change);
  if (change.change_type === 'DELETE') {
    await db.projections.delete(key);
    return;
  }
  const existing = await db.projections.get(key);
  const scope = scopeKeyOf(change);
  if (change.change_type === 'SCOPE_EXIT') {
    if (!existing) return;
    const remaining = knownScopes(existing).filter((known) => known !== scope);
    if (remaining.length === 0) await db.projections.delete(key);
    else await db.projections.update(key, { scopes: remaining });
    return;
  }
  if (!change.data) return; // UPSERT sans donnée projetée (ex. paramètre non client-visible)
  const scopes = knownScopes(existing);
  await db.projections.put({
    key,
    dataset: change.dataset,
    entity_type: change.entity_type,
    entity_id: change.entity_id,
    scope_type: change.scope_type,
    scope_id: change.scope_id,
    scopes: scopes.includes(scope) ? scopes : [...scopes, scope],
    row_version: change.row_version,
    data: change.data,
    seq: change.seq,
  });
}

export type PullCycleResult =
  | { readonly outcome: 'SYNCED'; readonly changeCount: number }
  | { readonly outcome: 'OFFLINE' }
  | { readonly outcome: 'SESSION_INVALID' };

type PullDatasetResult =
  | { readonly ok: true; readonly changeCount: number }
  | { readonly ok: false; readonly reason: 'OFFLINE' | 'SESSION_INVALID' };

async function pullDataset(db: GicDatabase, dataset: string): Promise<PullDatasetResult> {
  let changeCount = 0;
  for (;;) {
    const cursorRow = await db.syncCursors.get(dataset);
    const cursor = cursorRow?.cursor ?? 0;
    const result = await authorizedRequest<PullResponse>(
      db,
      `/api/v1/sync/pull?dataset=${encodeURIComponent(dataset)}&cursor=${cursor}&limit=${PAGE_LIMIT}`,
      { method: 'GET' },
    );
    if (!result.ok) {
      // Seul un jeton de rafraîchissement invalide force la déconnexion locale (même choix
      // que `push.ts`) : une erreur HTTP du contrôleur est reportée comme `OFFLINE`.
      return {
        ok: false,
        reason: result.reason === 'SESSION_INVALID' ? 'SESSION_INVALID' : 'OFFLINE',
      };
    }

    for (const change of result.data.changes) await applyChange(db, change);
    changeCount += result.data.changes.length;
    await db.syncCursors.put({ dataset, cursor: result.data.next_cursor });
    if (!result.data.has_more) break;
  }
  return { ok: true, changeCount };
}

export async function runPullCycle(
  db: GicDatabase,
  deps: { readonly clock: Clock },
): Promise<PullCycleResult> {
  let total = 0;
  for (const dataset of KNOWN_DATASETS) {
    const result = await pullDataset(db, dataset);
    if (!result.ok) return { outcome: result.reason };
    total += result.changeCount;
  }
  await db.syncMeta.update('device', { last_sync_at: deps.clock.now().toISOString() });
  return { outcome: 'SYNCED', changeCount: total };
}
