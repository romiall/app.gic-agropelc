/**
 * Utilitaires communs aux commandes de la production (D07-PRD) : ferme et emplacements
 * d'élevage, lot de production, portée d'autorisation (RC-04), origine de commande, rejets.
 * Les tables d'`organization` sont lues par clé (dépendance autorisée par le graphe, même
 * précédent que `procurement/commands/shared.ts`).
 */
import type { Transaction } from 'kysely';
import type { CommandEnvelope } from '@gic/contracts';
import {
  DomainError,
  acceptsDailyEntries,
  businessDayOf,
  type IdGenerator,
  type ProductionLotStatus,
  type ProductionLotType,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
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

/**
 * Saisie hors ligne sur un lot qui n'accepte plus de saisie (clôturé, annulé, ou pas encore
 * démarré) : le fait est appliqué (BR-SYN-007) et un conflit informatif `LOT_CLOSED` est
 * consigné pour le Responsable production (matrice des conflits, « perte déclarée sur un lot
 * clôturé »).
 */
export async function recordLotClosedConflict(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly commandId: string;
    readonly lot: LotRow;
    readonly details: Record<string, unknown>;
  },
): Promise<CommandHandlerOutcome> {
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: input.commandId,
    conflictType: 'LOT_CLOSED',
    entityType: 'PRODUCTION_LOT',
    entityId: input.lot.id,
    siteId: input.lot.siteId,
    ownerRole: 'RESP_PRODUCTION',
    applied: true,
    details: { ...input.details, lotStatus: input.lot.status },
  });
  return { status: 'APPLIED_WITH_WARNINGS', warnings: ['LOT_CLOSED'] };
}

export const DAILY = 'production.daily.record';

export const LOT_NOT_FOUND = rejected('NOT_FOUND', 'Lot de production introuvable.');

/** Lot de la saisie, portée et état ; `closed` : saisie hors ligne sur un lot sans saisie. */
export async function dailyLot(
  uow: Uow,
  envelope: CommandEnvelope<{ readonly productionLotId: string }>,
  /** Contrôle propre à la saisie (type de lot…), avant l'état du lot : erreur la plus parlante. */
  precheck?: (lot: LotRow) => CommandHandlerOutcome | undefined,
): Promise<
  | { readonly ok: true; readonly lot: LotRow; readonly closed: boolean }
  | {
      readonly ok: false;
      readonly outcome: CommandHandlerOutcome;
    }
> {
  const lot = await loadLot(uow, envelope.payload.productionLotId);
  if (!lot) return { ok: false, outcome: LOT_NOT_FOUND };
  const at = new Date(envelope.occurred_at);
  if (!(await isAllowed(uow, envelope.author_user_id, DAILY, at, lot.siteId))) {
    return { ok: false, outcome: FORBIDDEN_SCOPE };
  }
  const refused = precheck?.(lot);
  if (refused) return { ok: false, outcome: refused };
  const closed = !acceptsDailyEntries(lot.status);
  if (closed && !envelope.captured_offline) {
    return {
      ok: false,
      outcome: rejected(
        'LOT_NOT_ACTIVE',
        'Saisie du jour sur un lot actif ou en vente seulement (D07 §8).',
      ),
    };
  }
  return { ok: true, lot, closed };
}

/** Emplacement physique actif de la ferme du lot (`SITE_MISMATCH` sinon). */
export async function farmLocation(
  uow: Uow,
  lot: LotRow,
  locationId: string,
  options: { readonly rearingOnly?: boolean } = {},
): Promise<CommandHandlerOutcome | undefined> {
  const location = await loadLocation(uow, locationId);
  if (!location || location.siteId !== lot.siteId) {
    return rejected('SITE_MISMATCH', 'Emplacement inconnu ou hors de la ferme du lot.');
  }
  if (options.rearingOnly && !REARING_LOCATION_TYPES.includes(location.locationType)) {
    return rejected('LOCATION_INVALID', 'Un bâtiment ou une case de la ferme du lot est attendu.');
  }
  return undefined;
}

/** Paramètre système global en vigueur à `at` (règle 8 : aucun seuil codé en dur). */
async function settingValue(uow: Uow, key: string, at: Date): Promise<unknown> {
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

export async function numberSetting(
  uow: Uow,
  key: string,
  at: Date,
  fallback: number,
): Promise<number> {
  const value = await settingValue(uow, key, at);
  const parsed = typeof value === 'number' ? value : Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : fallback;
}

export async function stringSetting(uow: Uow, key: string, at: Date): Promise<string> {
  const value = await settingValue(uow, key, at);
  return typeof value === 'string' ? value.trim() : '';
}

export async function stringListSetting(
  uow: Uow,
  key: string,
  at: Date,
): Promise<readonly string[]> {
  const value = await settingValue(uow, key, at);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
