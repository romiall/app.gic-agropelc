/**
 * Utilitaires communs aux commandes de la production (D07-PRD) : ferme et emplacements
 * d'élevage, lot de production, portée d'autorisation (RC-04), origine de commande, rejets.
 * Les tables d'`organization` sont lues par clé (dépendance autorisée par le graphe, même
 * précédent que `procurement/commands/shared.ts`).
 */
import type { Transaction } from 'kysely';
import {
  DomainError,
  businessDayOf,
  type ProductionLotStatus,
  type ProductionLotType,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { InventoryMoveError } from '../../../inventory/application/public/index.js';

export type Uow = Transaction<DB>;

export function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

export const FORBIDDEN_SCOPE = rejected('FORBIDDEN_SCOPE', 'Ferme hors de votre périmètre.');

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Emplacements d'élevage (BR-PRD-003 : effectif en élevage). */
export const REARING_LOCATION_TYPES: readonly string[] = ['BUILDING', 'PEN'];

export interface FarmLocation {
  readonly id: string;
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteType: string;
  readonly locationType: string;
  readonly isActive: boolean;
}

/** Emplacement physique avec sa ferme ; `undefined` pour un emplacement inconnu ou virtuel. */
export async function loadLocation(
  uow: Uow,
  locationId: string,
): Promise<FarmLocation | undefined> {
  const row = await uow
    .selectFrom('organization_locations as l')
    .innerJoin('organization_sites as s', 's.id', 'l.site_id')
    .select([
      'l.id',
      'l.location_type',
      'l.is_virtual',
      'l.status',
      's.id as site_id',
      's.code',
      's.site_type',
    ])
    .where('l.id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row || row.is_virtual) return undefined;
  return {
    id: fromBin(row.id),
    siteId: fromBin(row.site_id),
    siteCode: row.code,
    siteType: row.site_type,
    locationType: row.location_type,
    isActive: row.status === 'ACTIVE',
  };
}

export interface LotRow {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: ProductionLotType;
  readonly productId: string;
  readonly stockLotId: string;
  readonly siteId: string;
  readonly mainLocationId: string;
  readonly parentLotId: string | null;
  readonly status: ProductionLotStatus;
  readonly startDate: Date | null;
  readonly initialQuantity: number | null;
  readonly version: number;
}

/** Lot de production, verrouillé pour la durée de la transaction. */
export async function loadLot(uow: Uow, lotId: string): Promise<LotRow | undefined> {
  const row = await uow
    .selectFrom('production_production_lots')
    .selectAll()
    .where('id', '=', toBin(lotId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    lotCode: row.lot_code,
    lotType: row.lot_type as ProductionLotType,
    productId: fromBin(row.product_id),
    stockLotId: fromBin(row.stock_lot_id),
    siteId: fromBin(row.site_id),
    mainLocationId: fromBin(row.main_location_id),
    parentLotId: fromBinOrNull(row.parent_lot_id),
    status: row.status as ProductionLotStatus,
    startDate: row.start_date,
    initialQuantity: row.initial_quantity === null ? null : Number(row.initial_quantity),
    version: row.version,
  };
}

export async function isAllowed(
  uow: Uow,
  userId: string,
  permissionCode: string,
  at: Date,
  siteId: string,
): Promise<boolean> {
  return (
    await evaluateAccess(uow, { userId, permissionCode, occurredAt: at, resource: { siteId } })
  ).allowed;
}

/** Année du numéro de document : celle du jour métier (Africa/Douala) de l'opération. */
export function documentYear(at: Date): number {
  return Number(businessDayOf(at).slice(0, 4));
}

/** `DomainError` ou refus d'`inventory` → rejet métier ; toute autre erreur est relancée. */
export function businessRejection(error: unknown): CommandHandlerOutcome {
  if (error instanceof DomainError) return rejected(error.code, error.message);
  if (error instanceof InventoryMoveError) return rejected(error.code, error.message);
  throw error;
}

export const milli = (value: number): number => Math.round(value * 1000);
export const fromMilli = (value: number): number => value / 1000;
