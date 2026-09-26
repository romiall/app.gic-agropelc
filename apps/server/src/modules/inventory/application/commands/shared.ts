/**
 * Utilitaires partagés par les gestionnaires de commande `inventory` (transferts, pertes,
 * inventaires) : lecture de `organization.locations`/`organization.sites` (dépendance
 * autorisée par le graphe, même précédent que `record-move.ts::loadLocation` — lecture directe
 * plutôt qu'une API publique dédiée, `organization` n'en exposant pas encore).
 */
import type { Transaction } from 'kysely';
import { isClockSkewSuspect } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
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
export async function virtualLocationId(uow: Transaction<DB>, locationType: string): Promise<string> {
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

/** Traduit une `InventoryMoveError` (P2-03) en `CommandHandlerOutcome` REJECTED, pour que
 * chaque gestionnaire de commande n'ait pas à répéter ce mappage. */
export async function tryRecordMove(
  fn: () => Promise<readonly RecordedMove[]>,
): Promise<MoveOutcome> {
  try {
    return { ok: true, moves: await fn() };
  } catch (error) {
    if (error instanceof InventoryMoveError) {
      return { ok: false, outcome: { status: 'REJECTED', errorCode: error.code, messageFr: error.message } };
    }
    throw error;
  }
}

export interface CommandOrigin {
  readonly deviceId: string | null;
  readonly receivedAt: Date;
  readonly clockSuspect: boolean;
}

/** `[STD-ORIGIN]` : `sync_command_inbox` est déjà écrite quand le gestionnaire s'exécute
 * (command-pipeline.service.ts) — même précédent que `attachments/attachment-commands.ts`. */
export async function loadCommandOrigin(
  uow: Transaction<DB>,
  commandId: string,
): Promise<CommandOrigin> {
  const row = await uow
    .selectFrom('sync_command_inbox')
    .select(['device_id', 'received_at', 'clock_skew_ms'])
    .where('command_id', '=', toBin(commandId))
    .executeTakeFirstOrThrow();
  return {
    deviceId: row.device_id ? fromBin(row.device_id) : null,
    receivedAt: row.received_at,
    clockSuspect: isClockSkewSuspect(row.clock_skew_ms),
  };
}
