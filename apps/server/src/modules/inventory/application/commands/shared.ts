/**
 * Utilitaires partagés par les gestionnaires de commande `inventory` (transferts, pertes,
 * inventaires) : lecture de `organization.locations`/`organization.sites` (dépendance
 * autorisée par le graphe, même précédent que `record-move.ts::loadLocation` — lecture directe
 * plutôt qu'une API publique dédiée, `organization` n'en exposant pas encore).
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CommandEnvelope, WarningCode } from '@gic/contracts';
import type {
  CommandHandler,
  CommandHandlerOutcome,
} from '../../../../platform/sync/command-handler-registry.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { InventoryMoveError, type RecordedMove } from '../public/record-move.js';

export interface LocationSite {
  readonly locationId: string;
  readonly siteId: string;
  readonly codeSite: string;
}

export async function loadLocationSite(
  uow: Transaction<DB>,
  locationId: string,
): Promise<LocationSite> {
  const row = await uow
    .selectFrom('organization_locations')
    .innerJoin('organization_sites', 'organization_sites.id', 'organization_locations.site_id')
    .select(['organization_locations.site_id as site_id', 'organization_sites.code as code'])
    .where('organization_locations.id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) throw new Error(`Emplacement introuvable : ${locationId}.`);
  if (!row.site_id) throw new Error(`Emplacement virtuel sans site : ${locationId}.`);
  return { locationId, siteId: fromBin(row.site_id), codeSite: row.code };
}

const virtualLocationCache = new Map<string, string>();

/** Emplacement virtuel (D06 §7.7) : une seule ligne par `location_type` (db/seeds/
 * virtual-locations.ts, `uq_organization_locations_active_virtual_type`) — mise en cache par
 * process, la ligne n'est jamais recréée après le seed initial. */
export async function virtualLocationId(
  uow: Transaction<DB>,
  locationType: string,
): Promise<string> {
  const cached = virtualLocationCache.get(locationType);
  if (cached) return cached;
  const row = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', locationType)
    .executeTakeFirstOrThrow();
  const id = fromBin(row.id);
  virtualLocationCache.set(locationType, id);
  return id;
}

export type MoveOutcome =
  | { readonly ok: true; readonly moves: readonly RecordedMove[] }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/**
 * Avertissements de quota et de garde (P5-09) portés par les mouvements d'une opération : de quoi
 * répondre `APPLIED_WITH_WARNINGS`. Vide quand aucun quota n'est en jeu.
 */
export function allocationWarnings(moves: readonly RecordedMove[]): readonly WarningCode[] {
  return [...new Set(moves.flatMap((move) => move.warnings ?? []))];
}

/** Traduit une `InventoryMoveError` (P2-03) en `CommandHandlerOutcome` REJECTED, pour que
 * chaque gestionnaire de commande n'ait pas à répéter ce mappage. */
export async function tryRecordMove(
  fn: () => Promise<readonly RecordedMove[]>,
): Promise<MoveOutcome> {
  try {
    return { ok: true, moves: await fn() };
  } catch (error) {
    if (error instanceof InventoryMoveError) {
      return {
        ok: false,
        outcome: { status: 'REJECTED', errorCode: error.code, messageFr: error.message },
      };
    }
    throw error;
  }
}

/** `[STD-ORIGIN]` : lecture partagée par tous les modules (platform/sync/command-origin.ts). */
export { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
export type { CommandOrigin } from '../../../../platform/sync/command-origin.js';

// --- Portée des commandes de stock (P5-23, AV-182) ------------------------------------------------

const FORBIDDEN_STOCK_SCOPE: CommandHandlerOutcome = {
  status: 'REJECTED',
  errorCode: 'FORBIDDEN_SCOPE',
  messageFr: 'Emplacement hors de votre périmètre (site ou stock dont vous avez la garde).',
};

/**
 * AV-182 (a) : la permission d'une commande de stock vaut **à sa portée** (RBAC §5.4), pas seulement par
 * sa présence. La ressource est l'emplacement — son site, et son titulaire pour un stock sous garde
 * exclusive (portée `OWN` : stock mobile d'un commercial). Une commande à deux extrémités (transfert)
 * est permise dès qu'**une** d'elles est dans la portée (un retour peut être déclaré par le destinataire).
 * Les emplacements virtuels ne font pas ressource. Contrôle d'autorisation : refus en ligne comme hors
 * ligne (RC-01, BR-SYN-007 ne s'applique qu'aux états métier).
 */
export async function stockScopeAllowed(
  uow: Transaction<DB>,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly occurredAt: Date;
    readonly locationIds: readonly string[];
  },
): Promise<boolean> {
  const ids = [...new Set(input.locationIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return true;
  const rows = await uow
    .selectFrom('organization_locations')
    .select(['id', 'site_id', 'custodian_user_id', 'is_virtual'])
    .where(
      'id',
      'in',
      ids.map((id) => toBin(id)),
    )
    .execute();
  const physical = rows.filter((row) => !row.is_virtual);
  if (physical.length === 0) return true;
  for (const row of physical) {
    const access = await evaluateAccess(uow, {
      userId: input.userId,
      permissionCode: input.permissionCode,
      occurredAt: input.occurredAt,
      resource: {
        ...(row.site_id !== null ? { siteId: fromBin(row.site_id) } : {}),
        ...(row.custodian_user_id !== null ? { ownerUserId: fromBin(row.custodian_user_id) } : {}),
      },
    });
    if (access.allowed) return true;
  }
  return false;
}

/**
 * Enveloppe un gestionnaire de commande de stock du contrôle de portée (AV-182) : `locate` désigne les
 * emplacements de la commande ; un document introuvable (liste vide) est laissé au gestionnaire.
 */
export function withStockScope<P>(
  permissionCode: string,
  locate: (uow: Transaction<DB>, envelope: CommandEnvelope<P>) => Promise<readonly string[]>,
  handler: CommandHandler<P>,
): CommandHandler<P> {
  return async (uow, envelope) => {
    const locationIds = await locate(uow, envelope);
    const allowed = await stockScopeAllowed(uow, {
      userId: envelope.author_user_id,
      permissionCode,
      occurredAt: new Date(envelope.occurred_at),
      locationIds,
    });
    return allowed ? handler(uow, envelope) : FORBIDDEN_STOCK_SCOPE;
  };
}

/** Extrémités d'un transfert (vide s'il est inconnu). */
export async function transferLocations(
  uow: Transaction<DB>,
  transferId: string,
): Promise<readonly string[]> {
  const row = await uow
    .selectFrom('inventory_stock_transfers')
    .select(['from_location_id', 'to_location_id'])
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  return row ? [fromBin(row.from_location_id), fromBin(row.to_location_id)] : [];
}

/** Emplacement d'un document de stock à un seul emplacement (perte, consommation, inventaire). */
export async function documentLocation(
  uow: Transaction<DB>,
  table: 'inventory_loss_declarations' | 'inventory_consumptions' | 'inventory_inventory_counts',
  id: string,
): Promise<readonly string[]> {
  const row = await uow
    .selectFrom(table)
    .select('location_id')
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row ? [fromBin(row.location_id)] : [];
}
