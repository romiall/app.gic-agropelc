/**
 * Consommation des quotas d'appareil par un mouvement de stock (P5-09 ; ADR-033 §4 à §7, BR-STK-011,
 * 013, 016, 017, 018, AV-025, AV-160, AV-161, INV-STK-10, INV-STK-11, INV-STK-19, INV-STK-20).
 * Interne à `inventory` : `recordStockMove` (public/record-move.ts) en est le seul appelant.
 *
 * - **Le couple** (utilisateur, appareil) vient de l'**inbox de commandes** et de l'auteur de la
 *   commande, jamais du contenu de la commande (ADR-033 §5) : un appareil modifié ne peut pas
 *   consommer le quota d'un autre (INV-STK-11).
 * - **Ordre de verrouillage** : soldes du couple (emplacement, produit), puis quotas.
 * - **En ligne**, ce qui dépasse le quota et le stock libre est refusé sans effet ; **hors ligne**,
 *   le fait est toujours appliqué (BR-SYN-007) : le quota est ramené à 0 au plus, l'excédent est pris
 *   sur le stock commun, un conflit informatif `ALLOCATION_EXCEEDED` le consigne.
 * - Un quota révoqué, échu ou libéré n'est plus consommé : le fait est pris sur le stock commun ;
 *   `ALLOCATION_REVOKED_CONSUMED` n'est ouvert que si l'`occurred_at` suit la révocation.
 * - Un fait hors ligne d'un appareil qui n'est pas celui de la garde ouvre `CUSTODY_DEVICE_MISMATCH`
 *   (appliqué, jamais rejeté).
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  isAllocationExpired,
  isConsumedAfterRevocation,
  planQuotaConsumption,
  restorableQuantity,
  type IdGenerator,
} from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import { recordConflict } from '../../../platform/sync/conflicts.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import {
  activeRemainingMilli,
  loadAllocation,
  loadConsumerAllocations,
  milliToText,
  quantityToMilli,
  stockOnHandMilli,
  type AllocationState,
} from './allocation-ledger.js';

export type AllocationWarning =
  | 'ALLOCATION_EXCEEDED'
  | 'ALLOCATION_REVOKED_CONSUMED'
  | 'ALLOCATION_OVERCOMMITTED'
  | 'CUSTODY_DEVICE_MISMATCH';

/** Refus définitif d'une sortie en ligne (traduit en `InventoryMoveError` par `record-move.ts`). */
export class AllocationRefusal extends Error {
  constructor(
    message: string,
    public readonly code: 'ALLOCATION_EXCEEDED' | 'INSUFFICIENT_STOCK',
  ) {
    super(message);
    this.name = 'AllocationRefusal';
  }
}

/** Emplacement source, tel que lu par `record-move.ts`. */
export interface ConsumptionLocation {
  readonly id: string;
  readonly siteId: string | null;
  readonly siteType: string | null;
  readonly locationType: string;
  readonly custodyMode: string | null;
  readonly designatedDeviceId: string | null;
  readonly custodianUserId: string | null;
}

export interface ConsumptionRequest {
  readonly location: ConsumptionLocation;
  readonly productId: string;
  readonly quantityMilli: number;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: Date;
  readonly capturedOffline: boolean;
  readonly allowNegative: boolean;
  readonly commandId: string | null;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
}

/** Rôle chargé de résoudre une anomalie de stock d'un emplacement (AV-142, DÉDUIT). */
export function stockOwnerRole(locationType: string, siteType: string | null): string {
  if (locationType === 'MOBILE') return 'RESP_COMMERCIAL';
  return siteType === 'FERME' ? 'RESP_FERME' : 'MAGASINIER';
}

/**
 * Part de chaque morceau d'une sortie qui vient du quota, dans l'ordre de présentation : le quota
 * est consommé d'abord (BR-STK-013). L'objet est créé par `prepareQuotaConsumption`.
 */
export class QuotaConsumption {
  readonly warnings = new Set<AllocationWarning>();
  private left: number;

  constructor(
    /** Quota consommable (actif et non échu) ; absent : tout vient du stock commun. */
    readonly allocation: AllocationState | undefined,
    quotaMilli: number,
  ) {
    this.left = quotaMilli;
  }

  /** Part du morceau (en millièmes) qui est imputée au quota. */
  take(pieceMilli: number): number {
    const part = Math.min(pieceMilli, this.left);
    this.left -= part;
    return part;
  }
}

/** Un conflit informatif sur l'emplacement d'une sortie, au nom du responsable du stock. */
async function openConflict(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  request: ConsumptionRequest,
  conflict: {
    readonly type: AllocationWarning;
    readonly entityType: string;
    readonly entityId: string;
    readonly details: Record<string, unknown>;
  },
): Promise<void> {
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: request.commandId,
    conflictType: conflict.type,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    siteId: request.location.siteId,
    ownerRole: stockOwnerRole(request.location.locationType, request.location.siteType),
    applied: true,
    details: {
      ...conflict.details,
      userId: request.userId,
      deviceId: request.deviceId,
      locationId: request.location.id,
      productId: request.productId,
      sourceDocType: request.sourceDocType,
      sourceDocId: request.sourceDocId,
      occurredAt: request.occurredAt.toISOString(),
    },
  });
}

type CustodyReason = 'DEVICE_NOT_DESIGNATED' | 'DEVICE_NOT_PRIMARY' | 'DEVICE_OTHER_SITE';

/**
 * Garde d'appareil (BR-STK-016, ADR-033 §2) : un fait **hors ligne** n'est légitime que sur l'appareil
 * désigné d'un emplacement `EXCLUSIVE_DEVICE`, sur l'appareil principal du détenteur d'un
 * `EXCLUSIVE_USER`, et sur un appareil non rattaché à un autre site. Sinon le fait est appliqué et le
 * conflit `CUSTODY_DEVICE_MISMATCH` porte la raison.
 */
async function custodyMismatch(
  uow: Transaction<DB>,
  request: ConsumptionRequest,
): Promise<CustodyReason | null> {
  const { location, deviceId } = request;
  if (location.custodyMode === 'EXCLUSIVE_DEVICE') {
    if (location.designatedDeviceId !== null && location.designatedDeviceId !== deviceId) {
      return 'DEVICE_NOT_DESIGNATED';
    }
  } else if (location.custodyMode === 'EXCLUSIVE_USER' && location.custodianUserId !== null) {
    const custodian = await uow
      .selectFrom('identity_users')
      .select('primary_device_id')
      .where('id', '=', toBin(location.custodianUserId))
      .executeTakeFirst();
    const primary = fromBinOrNull(custodian?.primary_device_id ?? null);
    if (primary !== null && primary !== deviceId) return 'DEVICE_NOT_PRIMARY';
  }
  const device = await uow
    .selectFrom('identity_devices')
    .select('designated_site_id')
    .where('id', '=', toBin(deviceId))
    .executeTakeFirst();
  const attachedSite = fromBinOrNull(device?.designated_site_id ?? null);
  if (attachedSite !== null && location.siteId !== null && attachedSite !== location.siteId) {
    return 'DEVICE_OTHER_SITE';
  }
  return null;
}

/** `sales.offline_over_allocation_allowed` (AV-025) : réglage du site, à défaut global, faux sinon. */
async function overAllocationAllowed(
  uow: Transaction<DB>,
  siteId: string | null,
  at: Date,
): Promise<boolean> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(uow, {
      key: 'sales.offline_over_allocation_allowed',
      scopeType: 'SITE',
      scopeId: siteId,
      at,
    });
    if (typeof bySite === 'boolean') return bySite;
  }
  const global = await currentSettingValue(uow, {
    key: 'sales.offline_over_allocation_allowed',
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return global === true;
}

/**
 * Prépare la consommation d'une sortie d'un emplacement pour le couple (utilisateur, appareil) :
 * garde d'appareil, plan quota puis stock libre, refus en ligne, conflits hors ligne. Renvoie `null`
 * quand l'emplacement n'est pas partagé (aucun quota à consommer).
 */
export async function prepareQuotaConsumption(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  request: ConsumptionRequest,
): Promise<QuotaConsumption | null> {
  const { location } = request;
  const warnings = new Set<AllocationWarning>();

  if (request.capturedOffline) {
    const reason = await custodyMismatch(uow, request);
    if (reason !== null) {
      warnings.add('CUSTODY_DEVICE_MISMATCH');
      await openConflict(uow, deps, request, {
        type: 'CUSTODY_DEVICE_MISMATCH',
        entityType: 'LOCATION',
        entityId: location.id,
        details: { reason },
      });
    }
  }
  if (location.custodyMode !== 'SHARED') {
    if (warnings.size === 0) return null;
    const consumption = new QuotaConsumption(undefined, 0);
    for (const warning of warnings) consumption.warnings.add(warning);
    return consumption;
  }

  // Soldes d'abord, puis quotas (ordre de verrouillage, allocation-ledger.ts).
  const onHand = await stockOnHandMilli(uow, location.id, request.productId, { lock: true });
  const activeAll = await activeRemainingMilli(uow, location.id, request.productId, {
    lock: true,
  });
  const quotas = await loadConsumerAllocations(
    uow,
    {
      locationId: location.id,
      productId: request.productId,
      userId: request.userId,
      deviceId: request.deviceId,
    },
    { lock: true },
  );

  // Un quota échu n'est plus consommé (le fait est pris sur le stock commun, sans conflit).
  const usable =
    quotas.active !== undefined &&
    !isAllocationExpired(quotas.active.validUntil, request.occurredAt)
      ? quotas.active
      : undefined;

  if (
    usable === undefined &&
    quotas.lastRevoked?.revokedAt != null &&
    isConsumedAfterRevocation(request.occurredAt, quotas.lastRevoked.revokedAt)
  ) {
    warnings.add('ALLOCATION_REVOKED_CONSUMED');
    await openConflict(uow, deps, request, {
      type: 'ALLOCATION_REVOKED_CONSUMED',
      entityType: 'STOCK_ALLOCATION',
      entityId: quotas.lastRevoked.id,
      details: {
        allocationId: quotas.lastRevoked.id,
        revokedAt: quotas.lastRevoked.revokedAt.toISOString(),
        quantity: milliToText(request.quantityMilli),
      },
    });
  }

  const plan = planQuotaConsumption({
    requested: request.quantityMilli / 1000,
    holdsQuota: usable !== undefined,
    quotaRemaining: usable ? usable.remainingMilli / 1000 : 0,
    freeStock: Math.max(0, onHand - activeAll) / 1000,
  });

  if (!request.allowNegative && plan.shortfall > 0) {
    if (usable !== undefined) {
      throw new AllocationRefusal(
        `Allocation dépassée : il vous reste ${milliToText(usable.remainingMilli)}, ${milliToText(request.quantityMilli)} demandé(s) et le stock libre ne couvre pas la différence.`,
        'ALLOCATION_EXCEEDED',
      );
    }
    throw new AllocationRefusal(
      'Stock disponible insuffisant : le reste est alloué à d’autres appareils (BR-STK-011, BR-STK-017).',
      'INSUFFICIENT_STOCK',
    );
  }

  if (usable !== undefined && plan.quotaExceeded) {
    // Fait hors ligne au-delà du quota : appliqué, l'excédent pris sur le stock commun (AV-161).
    warnings.add('ALLOCATION_EXCEEDED');
    await openConflict(uow, deps, request, {
      type: 'ALLOCATION_EXCEEDED',
      entityType: 'STOCK_ALLOCATION',
      entityId: usable.id,
      details: {
        allocationId: usable.id,
        requested: milliToText(request.quantityMilli),
        quotaRemaining: milliToText(usable.remainingMilli),
        excess: plan.excessOverQuota.toFixed(3),
        takenFromFreeStock: plan.fromFreeStock.toFixed(3),
        shortfall: plan.shortfall.toFixed(3),
        signalled: await overAllocationAllowed(uow, location.siteId, request.occurredAt),
      },
    });
  }

  const consumption = new QuotaConsumption(usable, quantityToMilli(plan.fromQuota));
  for (const warning of warnings) consumption.warnings.add(warning);
  return consumption;
}

/**
 * INV-STK-19, ADR-033 §6 : après une sortie d'un emplacement partagé, un solde physique tombé sous la
 * somme des restes des quotas actifs ouvre `ALLOCATION_OVERCOMMITTED` (informatif, jamais corrigé en
 * silence). Un seul conflit ouvert par (emplacement, produit). Renvoie `true` s'il y a dépassement.
 */
export async function checkOvercommitted(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly location: ConsumptionLocation;
    readonly productId: string;
    readonly commandId: string | null;
    readonly occurredAt: Date;
    readonly sourceDocType: string;
    readonly sourceDocId: string;
  },
): Promise<boolean> {
  if (input.location.custodyMode !== 'SHARED') return false;
  const activeAll = await activeRemainingMilli(uow, input.location.id, input.productId);
  if (activeAll === 0) return false;
  const onHand = await stockOnHandMilli(uow, input.location.id, input.productId);
  if (onHand >= activeAll) return false;
  const already = await uow
    .selectFrom('sync_sync_conflicts')
    .select('id')
    .where('conflict_type', '=', 'ALLOCATION_OVERCOMMITTED')
    .where('status', '=', 'OPEN')
    .where('entity_id', '=', toBin(input.location.id))
    .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) = ${input.productId}`)
    .executeTakeFirst();
  if (!already) {
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: input.commandId,
      conflictType: 'ALLOCATION_OVERCOMMITTED',
      entityType: 'LOCATION',
      entityId: input.location.id,
      siteId: input.location.siteId,
      ownerRole: stockOwnerRole(input.location.locationType, input.location.siteType),
      applied: true,
      details: {
        productId: input.productId,
        stockOnHand: milliToText(onHand),
        allocatedRemaining: milliToText(activeAll),
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        occurredAt: input.occurredAt.toISOString(),
      },
    });
  }
  return true;
}

/** Part d'un retour qui est rendue à un quota encore actif (ADR-033 §8). */
export class QuotaRestoration {
  private left: number;

  constructor(
    readonly allocation: AllocationState,
    restoreMilli: number,
  ) {
    this.left = restoreMilli;
  }

  /** Part du morceau (en millièmes) qui est rendue au quota. */
  take(pieceMilli: number): number {
    const part = Math.min(pieceMilli, this.left);
    this.left -= part;
    return part;
  }
}

export interface RestorationRequest {
  readonly moveType: string;
  readonly toLocationId: string;
  readonly productId: string;
  readonly quantityMilli: number;
  /** Retour client : le mouvement `SALE` dont il consomme une part (ADR-029). */
  readonly originMoveId?: string;
  /** Inverse : le mouvement corrigé. */
  readonly reversesMoveId?: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
}

/**
 * ADR-033 §8 : un mouvement qui rend du stock à l'emplacement d'où un fait de l'appareil l'avait pris
 * — retour d'une vente, inverse d'un mouvement, libération d'une perte en attente — rend d'abord
 * la quantité au quota que ce fait avait consommé, **si ce quota est encore actif** et dans la limite
 * de ce qu'il y avait consommé, déduction faite de ce qui lui a déjà été restitué. Sinon (quota
 * libéré, révoqué, ou rien consommé) elle retourne au stock commun. `null` : rien à restituer.
 */
export async function prepareQuotaRestoration(
  uow: Transaction<DB>,
  request: RestorationRequest,
): Promise<QuotaRestoration | null> {
  let allocationId: string | null = null;
  let consumedMilli = 0;
  let restoredMilli = 0;

  if (request.originMoveId !== undefined || request.reversesMoveId !== undefined) {
    const sourceMoveId = (request.originMoveId ?? request.reversesMoveId)!;
    const move = await uow
      .selectFrom('inventory_stock_moves')
      .select(['allocation_id', 'quantity'])
      .where('id', '=', toBin(sourceMoveId))
      .executeTakeFirst();
    if (!move?.allocation_id) return null;
    allocationId = fromBin(move.allocation_id);
    consumedMilli = quantityToMilli(move.quantity);
    if (request.originMoveId !== undefined) {
      const done = await uow
        .selectFrom('inventory_stock_moves')
        .select(sql<string>`COALESCE(SUM(quantity), 0)`.as('quantity'))
        .where('origin_move_id', '=', toBin(request.originMoveId))
        .where('allocation_id', '=', move.allocation_id)
        .executeTakeFirstOrThrow();
      restoredMilli = quantityToMilli(done.quantity);
    }
  } else if (request.moveType === 'LOSS_RELEASE') {
    // Une perte en attente avait consommé le quota (`LOSS_PENDING`) ; son retrait ou son rejet le rend.
    const rows = await uow
      .selectFrom('inventory_stock_moves')
      .select(['move_type', 'allocation_id', sql<string>`SUM(quantity)`.as('quantity')])
      .where('source_doc_type', '=', request.sourceDocType as 'LOSS')
      .where('source_doc_id', '=', toBin(request.sourceDocId))
      .where('move_type', 'in', ['LOSS_PENDING', 'LOSS_RELEASE'])
      .where('allocation_id', 'is not', null)
      .groupBy(['move_type', 'allocation_id'])
      .execute();
    const pending = rows.find((row) => row.move_type === 'LOSS_PENDING');
    if (!pending?.allocation_id) return null;
    allocationId = fromBin(pending.allocation_id);
    consumedMilli = quantityToMilli(pending.quantity);
    const released = rows.find(
      (row) =>
        row.move_type === 'LOSS_RELEASE' && row.allocation_id?.equals(pending.allocation_id!),
    );
    restoredMilli = released ? quantityToMilli(released.quantity) : 0;
  } else {
    return null;
  }

  // Soldes d'abord (destination du retour), puis le quota : l'ordre de verrouillage d'`inventory`.
  await stockOnHandMilli(uow, request.toLocationId, request.productId, { lock: true });
  const allocation = await loadAllocation(uow, allocationId, { lock: true });
  if (!allocation || allocation.status !== 'ACTIVE') return null;
  const restore = quantityToMilli(
    restorableQuantity({
      consumed: consumedMilli / 1000,
      alreadyRestored: restoredMilli / 1000,
      requested: request.quantityMilli / 1000,
    }),
  );
  return restore > 0 ? new QuotaRestoration(allocation, restore) : null;
}
