/**
 * Ressource sur laquelle s'évalue la portée d'un conflit de synchronisation (P5-17, AV-191) : son site
 * et son titulaire — l'auteur de la commande qui l'a produit (inbox) ; pour un conflit système (sans
 * auteur), le détenteur de l'emplacement en cause s'il en a un (stock mobile : `details.fromLocationId`
 * ou `locationId`). Partagée par la file des conflits (`conflict-access.ts`) et l'accueil d'un rôle
 * d'équipe (`home-api/`) : un seul calcul, sans dépendance vers le catalogue des rôles.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import type { ConflictRecord } from '../platform/sync/conflicts.js';
import type { ResourceLocator } from '../modules/identity/application/public/index.js';
import { findStockLocation } from '../modules/inventory/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

function locationOfDetails(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  const candidate = record['fromLocationId'] ?? record['locationId'];
  return typeof candidate === 'string' ? candidate : null;
}

export async function conflictResource(
  executor: Executor,
  conflict: ConflictRecord,
): Promise<ResourceLocator> {
  let ownerUserId = conflict.authorUserId;
  if (ownerUserId === null) {
    const locationId = locationOfDetails(conflict.details);
    if (locationId !== null) {
      ownerUserId = (await findStockLocation(executor, locationId))?.custodianUserId ?? null;
    }
  }
  return {
    ...(conflict.siteId !== null ? { siteId: conflict.siteId } : {}),
    ...(ownerUserId !== null ? { ownerUserId } : {}),
  };
}
