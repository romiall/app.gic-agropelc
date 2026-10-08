/**
 * Lecture et écriture du registre d'un quota d'appareil (P5-08 ; ADR-033 §3, INV-STK-19, INV-STK-20).
 * Interne à `inventory` : les commandes de quota (`commands/allocation-commands.ts`) s'en servent, et
 * la consommation dans `recordStockMove` (P5-09) s'en servira. Toutes les quantités sont tenues en
 * **millièmes entiers** (ADR-013) : aucune addition en flottant.
 *
 * Ordre de verrouillage (ADR-032, ADR-033) : lignes de **solde** d'abord, puis **quotas**. Une
 * opération qui touche les deux ne lit jamais un quota avant d'avoir verrouillé les soldes du couple
 * (emplacement, produit) ; c'est ce qui rend l'octroi et une sortie concurrente sérialisables.
 */
import { sql } from 'kysely';
import { signedAllocationEntry, quantityFromDecimal, quantityMilliUnits } from '@gic/domain';
import type { AllocationEntryType, IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';
import { allocationChange } from './sync-changes.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../platform/kysely/uuid-columns.js';

/** Valeur décimale (chaîne de la base, ou nombre) en millièmes entiers. */
export function quantityToMilli(value: string | number): number {
  return quantityMilliUnits(quantityFromDecimal(Number(value)));
}

/** Millièmes entiers en texte `numeric(14,3)` (trois décimales, point). */
export function milliToText(milli: number): string {
  return (milli / 1000).toFixed(3);
}

export type AllocationStatus = 'ACTIVE' | 'CLOSED' | 'REVOKED';

export interface AllocationState {
  readonly id: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly holderUserId: string;
  readonly holderDeviceId: string;
  readonly status: AllocationStatus;
  readonly grantedMilli: number;
  readonly remainingMilli: number;
  readonly validUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationPending: boolean;
  readonly version: number;
}

/** Un quota ; `lock` le verrouille en écriture (après les soldes de son couple, voir l'en-tête). */
export async function loadAllocation(
  uow: UnitOfWork,
  allocationId: string,
  options: { readonly lock?: boolean } = {},
): Promise<AllocationState | undefined> {
  let query = uow
    .selectFrom('inventory_stock_allocations')
    .select([
      'id',
      'location_id',
      'product_id',
      'lot_id',
      'holder_user_id',
      'holder_device_id',
      'status',
      'quantity_granted',
      'quantity_remaining',
      'valid_until',
      'revoked_at',
      'revocation_pending',
      'version',
    ])
    .where('id', '=', toBin(allocationId));
  if (options.lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    locationId: fromBin(row.location_id),
    productId: fromBin(row.product_id),
    lotId: fromBinOrNull(row.lot_id),
    holderUserId: fromBin(row.holder_user_id as Buffer),
    holderDeviceId: fromBin(row.holder_device_id as Buffer),
    status: row.status as AllocationStatus,
    grantedMilli: quantityToMilli(row.quantity_granted),
    remainingMilli: quantityToMilli(row.quantity_remaining),
    validUntil: row.valid_until,
    revokedAt: row.revoked_at,
    revocationPending: row.revocation_pending === 1,
    version: row.version,
  };
}

/**
 * Σ des soldes du produit à l'emplacement, tous lots confondus. `lock` verrouille les lignes de
 * solde : à faire **avant** de lire ou d'écrire un quota du couple.
 */
export async function stockOnHandMilli(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
  options: { readonly lock?: boolean } = {},
): Promise<number> {
  let query = uow
    .selectFrom('inventory_stock_balances')
    .select('qty_on_hand')
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId));
  if (options.lock) query = query.forUpdate();
  const rows = await query.execute();
  return rows.reduce((total, row) => total + quantityToMilli(row.qty_on_hand), 0);
}

/** Σ des restes des quotas **actifs** du couple (emplacement, produit), le cas échéant hors l'un d'eux. */
export async function activeRemainingMilli(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
  options: { readonly lock?: boolean; readonly excludingId?: string } = {},
): Promise<number> {
  let query = uow
    .selectFrom('inventory_stock_allocations')
    .select(['id', 'quantity_remaining'])
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId))
    .where('status', '=', 'ACTIVE');
  if (options.excludingId !== undefined) {
    query = query.where('id', '<>', toBin(options.excludingId));
  }
  if (options.lock) query = query.forUpdate();
  const rows = await query.execute();
  return rows.reduce((total, row) => total + quantityToMilli(row.quantity_remaining), 0);
}

/**
 * Entrée du registre immuable d'un quota (`inventory_stock_allocation_entries`). Le signe suit le
 * type (`signedAllocationEntry` : GRANT, INCREASE, RESTORE positifs ; CONSUME, RELEASE, REVOKE
 * négatifs). Une entrée nulle n'existe pas : l'appelant n'écrit rien quand il n'y a rien à inscrire.
 */
export async function writeAllocationEntry(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly allocationId: string;
    readonly entryType: AllocationEntryType;
    readonly magnitudeMilli: number;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly commandId?: string | null;
    readonly stockMoveId?: string | null;
  },
): Promise<void> {
  const signed = signedAllocationEntry(input.entryType, input.magnitudeMilli / 1000);
  await uow
    .insertInto('inventory_stock_allocation_entries')
    .values({
      id: toBin(deps.idGenerator.newId()),
      allocation_id: toBin(input.allocationId),
      entry_type: input.entryType,
      quantity: signed.toFixed(3),
      stock_move_id: toBinOrNull(input.stockMoveId ?? null),
      occurred_at: input.occurredAt,
      command_id: toBinOrNull(input.commandId ?? null),
      created_by: toBin(input.createdBy),
    })
    .execute();
}

/**
 * Quotas d'un couple (utilisateur, appareil) sur un couple (emplacement, produit) : le quota actif
 * s'il existe, sinon le dernier révoqué (pour qualifier `ALLOCATION_REVOKED_CONSUMED`, ADR-033 §6).
 * `lock` verrouille le quota actif — à faire après les soldes du couple (ordre de verrouillage).
 */
export async function loadConsumerAllocations(
  uow: UnitOfWork,
  input: {
    readonly locationId: string;
    readonly productId: string;
    readonly userId: string;
    readonly deviceId: string;
  },
  options: { readonly lock?: boolean } = {},
): Promise<{
  readonly active: AllocationState | undefined;
  readonly lastRevoked: AllocationState | undefined;
}> {
  const base = () =>
    uow
      .selectFrom('inventory_stock_allocations')
      .select('id')
      .where('location_id', '=', toBin(input.locationId))
      .where('product_id', '=', toBin(input.productId))
      .where('holder_user_id', '=', toBin(input.userId))
      .where('holder_device_id', '=', toBin(input.deviceId));
  let activeQuery = base().where('status', '=', 'ACTIVE');
  if (options.lock) activeQuery = activeQuery.forUpdate();
  const activeRow = await activeQuery.executeTakeFirst();
  const active = activeRow ? await loadAllocation(uow, fromBin(activeRow.id)) : undefined;
  if (active) return { active, lastRevoked: undefined };
  const revokedRow = await base()
    .where('status', '=', 'REVOKED')
    .orderBy('revoked_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const lastRevoked = revokedRow ? await loadAllocation(uow, fromBin(revokedRow.id)) : undefined;
  return { active: undefined, lastRevoked };
}

/**
 * Consommation d'un quota par un mouvement (ADR-033 §5) : entrée `CONSUME` rattachée au mouvement et
 * reste diminué dans la même transaction. L'appelant a plafonné la quantité au reste (jamais négatif).
 */
export async function consumeFromAllocation(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly allocation: AllocationState;
    readonly quantityMilli: number;
    readonly stockMoveId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly commandId?: string | null;
  },
): Promise<void> {
  await writeAllocationEntry(uow, deps, {
    allocationId: input.allocation.id,
    entryType: 'CONSUME',
    magnitudeMilli: input.quantityMilli,
    occurredAt: input.occurredAt,
    createdBy: input.createdBy,
    commandId: input.commandId ?? null,
    stockMoveId: input.stockMoveId,
  });
  await uow
    .updateTable('inventory_stock_allocations')
    .set({
      quantity_remaining: sql`quantity_remaining - ${milliToText(input.quantityMilli)}`,
      updated_by: toBin(input.createdBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.allocation.id))
    .execute();
  const row = await uow
    .selectFrom('inventory_stock_allocations')
    .select('version')
    .where('id', '=', toBin(input.allocation.id))
    .executeTakeFirstOrThrow();
  await recordChanges(uow, [
    allocationChange(input.allocation.id, input.allocation.holderDeviceId, row.version),
  ]);
}

/**
 * Restitution d'une quantité à un quota encore actif (ADR-033 §8) : entrée `RESTORE` rattachée au
 * mouvement de retour et reste augmenté dans la même transaction. L'appelant a plafonné la quantité
 * à ce que le mouvement d'origine y avait consommé (`restorableQuantity`).
 */
export async function restoreToAllocation(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly allocation: AllocationState;
    readonly quantityMilli: number;
    readonly stockMoveId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly commandId?: string | null;
  },
): Promise<void> {
  await writeAllocationEntry(uow, deps, {
    allocationId: input.allocation.id,
    entryType: 'RESTORE',
    magnitudeMilli: input.quantityMilli,
    occurredAt: input.occurredAt,
    createdBy: input.createdBy,
    commandId: input.commandId ?? null,
    stockMoveId: input.stockMoveId,
  });
  await uow
    .updateTable('inventory_stock_allocations')
    .set({
      quantity_remaining: sql`quantity_remaining + ${milliToText(input.quantityMilli)}`,
      updated_by: toBin(input.createdBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.allocation.id))
    .execute();
  const row = await uow
    .selectFrom('inventory_stock_allocations')
    .select('version')
    .where('id', '=', toBin(input.allocation.id))
    .executeTakeFirstOrThrow();
  await recordChanges(uow, [
    allocationChange(input.allocation.id, input.allocation.holderDeviceId, row.version),
  ]);
}
