/**
 * Consommation des quotas d'appareil par un mouvement de stock (P5-09 ; ADR-033 §4 à §7, BR-STK-011,
 * 013, 016, 017, 018, AV-025, AV-160, AV-161, INV-STK-10, INV-STK-11, INV-STK-19, INV-STK-20).
 * Interne à `inventory` : `recordStockMove` (public/record-move.ts) en est le seul appelant.
 *
 * - **Le couple** (utilisateur, appareil) vient de l'**inbox de commandes** et de l'auteur de la
 *   commande, jamais du contenu de la commande (ADR-033 §5) : un appareil modifié ne peut pas
 *   consommer le quota d'un autre (INV-STK-11).
 * - **Ordre de verrouillage** : soldes du couple (emplacement, produit), puis quotas. `recordStockMove`
 *   verrouille les soldes de toute sortie d'un emplacement partagé avant la première écriture, que le
 *   mouvement consomme un quota ou non : deux sorties du même couple se sérialisent sans interblocage.
 * - **En ligne**, pour le détenteur d'un quota ou quand des restes de quotas sont promis sur (emplacement,
 *   produit), ce qui dépasse le quota du couple et le stock libre est refusé sans effet ; un dépassement
 *   du seul quota que le stock libre couvre est une sortie normale (BR-VEN-018, P5-11). Sinon, le
 *   contrôle habituel par lot s'applique, message et code compris (`INSUFFICIENT_STOCK`, `LOT_REQUIRED`).
 * - **Hors ligne**, le fait est toujours appliqué (BR-SYN-007) : le quota est ramené à 0 au plus,
 *   l'excédent est pris sur le stock commun, un conflit informatif `ALLOCATION_EXCEEDED` le consigne.
 *   Une **vente** hors ligne d'un couple sans quota utilisable (aucun, ou échu) sur un emplacement
 *   partagé qui porte au moins un quota actif (même épuisé) ouvre aussi `ALLOCATION_EXCEEDED` (motif
 *   `ALLOCATION_MISSING` ou `ALLOCATION_EXPIRED`, miroir de `decideLocalConsumption`), selon
 *   `sales.offline_unallocated_sale_signal` (AV-166).
 * - Un quota révoqué, échu ou libéré n'est plus consommé : le fait est pris sur le stock commun ;
 *   `ALLOCATION_REVOKED_CONSUMED` n'est ouvert que pour un fait **hors ligne** dont l'`occurred_at`
 *   suit la révocation (BR-STK-014) : en ligne, le serveur décide sur son propre état. Un fait hors
 *   ligne **antérieur** à la révocation qui dépassait le reste du quota au moment de la révocation
 *   ouvre `ALLOCATION_EXCEEDED` (AT-003, AV-161).
 * - Un fait hors ligne d'un appareil qui n'est pas celui de la garde ouvre `CUSTODY_DEVICE_MISMATCH`
 *   (appliqué, jamais rejeté).
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  isAllocationExpired,
  isConsumedAfterRevocation,
  offlineAllocationSignal,
  parseUnallocatedSaleSignal,
  planQuotaConsumption,
  restorableQuantity,
  type ConsumerQuotaState,
  type IdGenerator,
  type UnallocatedSaleSignal,
} from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import { recordConflict } from '../../../platform/sync/conflicts.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import {
  activeQuotaSummary,
  activeRemainingMilli,
  loadAllocation,
  loadConsumerAllocations,
  milliToText,
  quantityToMilli,
  revokedRemainingMilli,
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
  /** Type du mouvement : seule une vente (`SALE`) porte le signal d'AV-166. */
  readonly moveType: string;
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
    /** Part de la sortie (en millièmes) que le quota couvre ; le reste vient du stock commun. */
    readonly quotaMilli: number,
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

/** Valeur d'un paramètre pour un site : réglage du site s'il existe, à défaut le réglage global. */
async function siteSetting(
  uow: Transaction<DB>,
  key: string,
  siteId: string | null,
  at: Date,
): Promise<unknown> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(uow, { key, scopeType: 'SITE', scopeId: siteId, at });
    if (bySite !== undefined && bySite !== null) return bySite;
  }
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

/** `sales.offline_over_allocation_allowed` (AV-025) : réglage du site, à défaut global, faux sinon. */
async function overAllocationAllowed(
  uow: Transaction<DB>,
  siteId: string | null,
  at: Date,
): Promise<boolean> {
  return (await siteSetting(uow, 'sales.offline_over_allocation_allowed', siteId, at)) === true;
}

/**
 * `sales.offline_unallocated_sale_signal` (AV-166) : réglage du site, à défaut global ; absent ou
 * inconnu, le défaut du domaine (`WHEN_ALLOCATED`, aussi la valeur semée).
 */
async function unallocatedSaleSignal(
  uow: Transaction<DB>,
  siteId: string | null,
  at: Date,
): Promise<UnallocatedSaleSignal> {
  return parseUnallocatedSaleSignal(
    await siteSetting(uow, 'sales.offline_unallocated_sale_signal', siteId, at),
  );
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
  const active = await activeQuotaSummary(uow, location.id, request.productId, { lock: true });
  const activeAll = active.remainingMilli;
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

  // Un quota échu n'est plus consommé : le fait est pris sur le stock commun (AV-161) ; une vente
  // hors ligne est en outre signalée (AV-166, plus bas).
  const expired =
    quotas.active !== undefined && isAllocationExpired(quotas.active.validUntil, request.occurredAt)
      ? quotas.active
      : undefined;
  const usable = expired === undefined ? quotas.active : undefined;

  // Quota révoqué (BR-STK-014, AV-161), pour un fait **hors ligne** seulement : en ligne, le serveur
  // décide sur son propre état et rien n'est imputé au quota révoqué. Un fait postérieur à la
  // révocation ouvre `ALLOCATION_REVOKED_CONSUMED` ; un fait antérieur, synchronisé après elle, n'est
  // signalé que s'il dépassait le reste du quota au moment de la révocation (AT-003, plus bas).
  const revoked = usable === undefined && expired === undefined ? quotas.lastRevoked : undefined;
  let revokedRemaining = 0;
  let revokedExceeded = false;
  if (request.capturedOffline && revoked?.revokedAt != null) {
    if (isConsumedAfterRevocation(request.occurredAt, revoked.revokedAt)) {
      warnings.add('ALLOCATION_REVOKED_CONSUMED');
      await openConflict(uow, deps, request, {
        type: 'ALLOCATION_REVOKED_CONSUMED',
        entityType: 'STOCK_ALLOCATION',
        entityId: revoked.id,
        details: {
          allocationId: revoked.id,
          revokedAt: revoked.revokedAt.toISOString(),
          quantity: milliToText(request.quantityMilli),
        },
      });
    } else {
      revokedRemaining = await revokedRemainingMilli(uow, revoked.id);
      revokedExceeded = request.quantityMilli > revokedRemaining;
    }
  }

  const plan = planQuotaConsumption({
    requested: request.quantityMilli / 1000,
    holdsQuota: usable !== undefined,
    quotaRemaining: usable ? usable.remainingMilli / 1000 : 0,
    freeStock: Math.max(0, onHand - activeAll) / 1000,
  });

  // Refus en ligne (BR-VEN-018, BR-STK-011) pour le détenteur d'un quota (même épuisé ou échu) ou
  // quand des restes de quotas sont promis sur (emplacement, produit) : sans aucun reste promis, le
  // stock libre est le stock entier et le contrôle habituel par lot de `recordSingleMove` décide,
  // message et code compris (P5-11).
  if (
    !request.allowNegative &&
    plan.shortfall > 0 &&
    (usable !== undefined || expired !== undefined || activeAll > 0)
  ) {
    if (usable !== undefined) {
      throw new AllocationRefusal(
        `Allocation dépassée : il vous reste ${milliToText(usable.remainingMilli)}, ${milliToText(request.quantityMilli)} demandé(s) et le stock libre ne couvre pas la différence.`,
        'ALLOCATION_EXCEEDED',
      );
    }
    if (expired !== undefined) {
      throw new AllocationRefusal(
        'Votre allocation a expiré : libérez-la ou faites-la renouveler ; le stock libre ne couvre pas la demande (BR-STK-011).',
        'INSUFFICIENT_STOCK',
      );
    }
    throw new AllocationRefusal(
      'Stock disponible insuffisant : le reste est alloué à d’autres appareils (BR-STK-011, BR-STK-017).',
      'INSUFFICIENT_STOCK',
    );
  }

  // Miroir serveur du blocage de l'appareil (AT-003, `offlineAllocationSignal` du domaine) : un fait
  // hors ligne que la tablette aurait dû bloquer est appliqué puis signalé. Au-delà du quota (AV-161) :
  // l'excédent est pris sur le stock commun ; de même pour un fait antérieur à la révocation du quota
  // qui dépassait son reste à cet instant. Vente sans quota utilisable (AV-166) : tout vient du stock
  // commun. En ligne, rien n'est signalé : un dépassement que le stock libre couvre est une sortie
  // normale (P5-11), le reste a été refusé ci-dessus.
  const quotaState: ConsumerQuotaState =
    usable !== undefined
      ? 'USABLE'
      : expired !== undefined
        ? 'EXPIRED'
        : revoked !== undefined
          ? 'REVOKED'
          : 'NONE';
  const isSale = request.moveType === 'SALE';
  const signal = offlineAllocationSignal({
    capturedOffline: request.capturedOffline,
    isSale,
    quota: quotaState,
    quotaExceeded: quotaState === 'REVOKED' ? revokedExceeded : plan.quotaExceeded,
    // Au moins un quota actif, quel que soit son reste : un quota épuisé reste actif (AV-166).
    locationHasActiveQuota: active.count > 0,
    // Paramètre lu seulement quand il peut décider (vente hors ligne sans quota utilisable).
    unallocatedSaleSignal:
      request.capturedOffline && isSale && (quotaState === 'NONE' || quotaState === 'EXPIRED')
        ? await unallocatedSaleSignal(uow, location.siteId, request.occurredAt)
        : 'NEVER',
  });
  if (signal !== null) {
    const allocation = usable ?? expired ?? revoked;
    warnings.add('ALLOCATION_EXCEEDED');
    await openConflict(uow, deps, request, {
      type: 'ALLOCATION_EXCEEDED',
      entityType: allocation !== undefined ? 'STOCK_ALLOCATION' : 'LOCATION',
      entityId: allocation !== undefined ? allocation.id : location.id,
      details: {
        reason: signal,
        allocationId: allocation?.id ?? null,
        ...(expired !== undefined ? { validUntil: expired.validUntil?.toISOString() ?? null } : {}),
        ...(revoked?.revokedAt != null ? { revokedAt: revoked.revokedAt.toISOString() } : {}),
        requested: milliToText(request.quantityMilli),
        // Quota révoqué : le reste qu'il avait au moment de la révocation.
        quotaRemaining: milliToText(usable?.remainingMilli ?? revokedRemaining),
        excess:
          usable !== undefined
            ? plan.excessOverQuota.toFixed(3)
            : revoked !== undefined
              ? milliToText(request.quantityMilli - revokedRemaining)
              : milliToText(request.quantityMilli),
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
 * silence). Un seul conflit ouvert par (emplacement, produit).
 *
 * Renvoie `true` si **cette sortie a causé ou aggravé** le dépassement, c'est-à-dire si elle a pris
 * une part (`fromFreeStockMilli`) hors du quota du couple et que le solde reste sous la somme des
 * restes : c'est cette sortie qui porte l'avertissement. Une sortie entièrement couverte par le quota
 * de son auteur ne change pas l'écart (le solde et les restes baissent de la même quantité) : elle
 * n'ouvre rien et ne reçoit aucun avertissement, même si un dépassement antérieur est encore ouvert.
 *
 * Lectures verrouillantes (P5-11) : une lecture simple verrait l'instantané de la transaction, sans
 * l'octroi ou la consommation d'un autre quota validés entre-temps (ordre : soldes, puis quotas ;
 * `recordStockMove` a verrouillé les soldes du couple avant sa première écriture).
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
    /** Part de la sortie (en millièmes) qui n'a pas été imputée au quota de son auteur. */
    readonly fromFreeStockMilli: number;
  },
): Promise<boolean> {
  if (input.location.custodyMode !== 'SHARED') return false;
  const onHand = await stockOnHandMilli(uow, input.location.id, input.productId, { lock: true });
  const activeAll = await activeRemainingMilli(uow, input.location.id, input.productId, {
    lock: true,
  });
  if (activeAll === 0) return false;
  if (onHand >= activeAll) return false;
  // Écart (Σ restes − solde) inchangé par une sortie couverte par le quota de son auteur.
  if (input.fromFreeStockMilli <= 0) return false;
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
