/**
 * Événements de détection d'alertes d'`inventory` (P9-08 ; ADR-061 §2 à §5 ; D13 §7.1 ; AV-355, AV-356).
 * Le module qui porte la donnée détecte et publie ; la corrélation, la déduplication et la résolution sont
 * l'affaire du consommateur `communication.alerts`, jamais importé ici.
 *
 * - **Sur transition** (`StockThresholdBreached`, `StockNegativeDetected`) : publiés dans la transaction
 *   du mouvement, par une lecture ponctuelle du seuil actif du couple — aucun seuil, aucun autre coût.
 * - **Sur fait** (`HighLossDetected`, `InventoryVarianceDetected`, `InventoryAdjusted`) : un événement par
 *   déclaration ou soumission ; le cumul du jour est celui du jour métier du fait.
 * - **Par passe planifiée** : les tâches du dossier `jobs/` ; elles partagent ici le sujet composite et les
 *   libellés (emplacement, produit) des messages.
 *
 * **Date de détection** : un fait saisi hors ligne porte la date où il s'est produit ; l'alerte, elle, est
 * détectée à l'application sur le serveur. Les événements d'état de ce module sont donc datés de l'instant
 * du serveur (`clock`, à défaut l'horloge du serveur) : l'escalade d'une alerte critique (4 h) compte
 * depuis sa détection, et un résolveur ne précède jamais la levée qu'il ferme (AV-407). Le **jour métier**
 * de la charge utile reste celui du fait (perte du jour, négatif du jour).
 */
import {
  businessDayOf,
  stockLevelChanges,
  stockThresholdStateOf,
  type Clock,
  type IdGenerator,
  type StockAlertLevel,
} from '@gic/domain';
import {
  compositeSubjectId,
  publishDetectionEvent,
} from '../../../platform/events/detection-events.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { findProduct } from '../../catalog/application/public/index.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import { quantityToMilli, stockOnHandMilli } from './allocation-ledger.js';

const PRODUCER = 'inventory';

/** Dépendances des publications : le générateur d'identifiants et, si l'appelant l'a, l'horloge. */
export interface InventoryAlertDeps {
  readonly idGenerator: IdGenerator;
  readonly clock?: Clock | undefined;
}

/** Instant de détection : horloge de l'appelant, à défaut celle du serveur (AV-407). */
export function detectionInstant(deps: { readonly clock?: Clock | undefined }): Date {
  return deps.clock?.now() ?? new Date();
}

// --- Libellés et paramètres -------------------------------------------------------------------------

export interface LocationAlertInfo {
  readonly name: string;
  readonly siteId: string | null;
  readonly locationType: string;
}

/** Nom, site et type d'un emplacement (lecture par clé primaire) ; `undefined` s'il est inconnu. */
export async function locationAlertInfo(
  uow: UnitOfWork,
  locationId: string,
): Promise<LocationAlertInfo | undefined> {
  const row = await uow
    .selectFrom('organization_locations')
    .select(['name', 'site_id', 'location_type'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) return undefined;
  return { name: row.name, siteId: fromBinOrNull(row.site_id), locationType: row.location_type };
}

/** Nom, site et type de plusieurs emplacements (une requête) ; les inconnus sont absents de la carte. */
export async function locationAlertInfos(
  uow: UnitOfWork,
  locationIds: readonly string[],
): Promise<ReadonlyMap<string, LocationAlertInfo>> {
  const result = new Map<string, LocationAlertInfo>();
  const ids = [...new Set(locationIds.map((id) => id.toLowerCase()))];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await uow
      .selectFrom('organization_locations')
      .select(['id', 'name', 'site_id', 'location_type'])
      .where(
        'id',
        'in',
        ids.slice(offset, offset + 500).map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) {
      result.set(fromBin(row.id), {
        name: row.name,
        siteId: fromBinOrNull(row.site_id),
        locationType: row.location_type,
      });
    }
  }
  return result;
}

/** Libellé d'un produit pour un message d'alerte ; son identifiant s'il est introuvable. */
export async function productAlertLabel(uow: UnitOfWork, productId: string): Promise<string> {
  return (await findProduct(uow, productId))?.name ?? productId;
}

/** Réglage du site, à défaut global (règle 8 : aucun seuil codé en dur ; repli au domaine). */
export async function siteThenGlobalSetting(
  uow: UnitOfWork,
  key: string,
  siteId: string | null,
  at: Date,
): Promise<unknown> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(uow, { key, scopeType: 'SITE', scopeId: siteId, at });
    if (bySite !== undefined) return bySite;
  }
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

// --- STOCK_LOW, STOCK_OUT : franchissement d'un seuil ------------------------------------------------

export interface StockLevelEventInput {
  readonly locationId: string;
  readonly productId: string;
  readonly level: StockAlertLevel;
  readonly breached: boolean;
  /** Disponible physique après le fait ou à la passe (peut être négatif). */
  readonly available: number;
  readonly thresholdQty: number;
  readonly targetQty: number;
  readonly locationLabel: string;
  readonly productLabel: string;
  readonly siteId: string | null;
  readonly businessDay: string;
  readonly occurredAt: Date;
  /** Passe planifiée (filet horaire) ; absente pour une transition sur mouvement. */
  readonly passId?: string | undefined;
  readonly commandId?: string | undefined;
}

/**
 * `StockThresholdBreached` : un niveau (`LOW` ou `OUT`) levé ou terminé pour un couple (emplacement,
 * produit). Sujet composite de l'alerte `STOCK_LOW` ou `STOCK_OUT` ; la résolution est l'événement inverse.
 */
export async function publishStockLevelEvent(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: StockLevelEventInput,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    location_id: input.locationId.toLowerCase(),
    product_id: input.productId.toLowerCase(),
    level: input.level,
    breached: input.breached,
    available: input.available,
    threshold: input.thresholdQty,
    target: input.targetQty,
    location_label: input.locationLabel,
    product_label: input.productLabel,
    site_id: input.siteId,
    business_day: input.businessDay,
  };
  return publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'StockThresholdBreached',
    producerModule: PRODUCER,
    aggregateType: 'STOCK_POSITION',
    aggregateId: compositeSubjectId(input.level === 'LOW' ? 'STOCK_LOW' : 'STOCK_OUT', payload),
    occurredAt: input.occurredAt,
    payload,
    ...(input.passId !== undefined ? { passId: input.passId } : {}),
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
  });
}

/** Variation signée du stock physique d'un emplacement pour un produit, causée par un mouvement. */
export interface StockEndpointDelta {
  readonly locationId: string;
  readonly quantity: number;
}

/**
 * Transitions de seuil des extrémités **physiques** d'un mouvement (AV-355) : pour chaque extrémité qui a
 * un seuil actif, l'état avant (disponible après − variation du mouvement) et l'état après (somme des
 * soldes du couple, lue après l'écriture) donnent les niveaux levés ou terminés. Sans seuil actif (cas le
 * plus fréquent), une seule lecture par clé et rien d'autre.
 *
 * La somme des soldes est une lecture simple : les verrous de l'ordre d'`inventory` (ADR-038) sont ceux
 * déjà pris par le mouvement et cette lecture n'en ajoute aucun ; l'instantané peut ignorer un autre
 * lot du couple modifié depuis le début de la transaction, que le filet horaire corrige (AV-355).
 */
export async function publishStockLevelTransitions(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: {
    readonly productId: string;
    readonly endpoints: readonly StockEndpointDelta[];
    /** Date du fait : le jour métier des événements. */
    readonly occurredAt: Date;
    readonly commandId?: string | undefined;
  },
): Promise<void> {
  const deltaMilli = new Map<string, number>();
  for (const endpoint of input.endpoints) {
    const key = endpoint.locationId.toLowerCase();
    deltaMilli.set(key, (deltaMilli.get(key) ?? 0) + quantityToMilli(endpoint.quantity));
  }
  if (deltaMilli.size === 0) return;
  const thresholds = await uow
    .selectFrom('inventory_stock_thresholds')
    .select(['location_id', 'min_qty_base', 'target_qty_base'])
    .where('product_id', '=', toBin(input.productId))
    .where(
      'location_id',
      'in',
      [...deltaMilli.keys()].map((id) => toBin(id)),
    )
    .where('is_active', '=', 1)
    .execute();
  if (thresholds.length === 0) return;

  const detectedAt = detectionInstant(deps);
  const businessDay = businessDayOf(input.occurredAt);
  for (const threshold of thresholds) {
    const locationId = fromBin(threshold.location_id);
    const afterMilli = await stockOnHandMilli(uow, locationId, input.productId);
    const beforeMilli = afterMilli - (deltaMilli.get(locationId) ?? 0);
    const minQty = Number(threshold.min_qty_base);
    const changes = stockLevelChanges(
      stockThresholdStateOf({ available: beforeMilli / 1000, minQty }),
      stockThresholdStateOf({ available: afterMilli / 1000, minQty }),
    );
    if (changes.length === 0) continue;
    const [location, productLabel] = await Promise.all([
      locationAlertInfo(uow, locationId),
      productAlertLabel(uow, input.productId),
    ]);
    for (const change of changes) {
      await publishStockLevelEvent(uow, deps, {
        locationId,
        productId: input.productId,
        level: change.level,
        breached: change.breached,
        available: afterMilli / 1000,
        thresholdQty: minQty,
        targetQty: Number(threshold.target_qty_base),
        locationLabel: location?.name ?? locationId,
        productLabel,
        siteId: location?.siteId ?? null,
        businessDay,
        occurredAt: detectedAt,
        ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      });
    }
  }
}

// --- POS_REPLENISH -------------------------------------------------------------------------------------

export interface ReplenishmentEventInput {
  readonly locationId: string;
  readonly productId: string;
  readonly locationLabel: string;
  readonly productLabel: string;
  readonly suggestedQuantity: number;
  readonly available: number;
  readonly minQuantity: number;
  readonly targetQuantity: number;
  readonly inTransitIn: number;
  readonly siteId: string | null;
  readonly sourceLocationId: string | null;
  readonly sourceLocationLabel: string | null;
  readonly businessDay: string;
  readonly occurredAt: Date;
  readonly passId: string;
}

/**
 * `ReplenishmentSuggested` : un point de vente dont la suggestion de réapprovisionnement
 * (cible − disponible − transit entrant) est positive (AV-402). Publié par la passe horaire, qui ferme
 * aussi les alertes qu'elle ne revoit plus (réapprovisionné, transit entrant suffisant).
 */
export async function publishReplenishmentSuggested(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: ReplenishmentEventInput,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    location_id: input.locationId.toLowerCase(),
    product_id: input.productId.toLowerCase(),
    location_label: input.locationLabel,
    product_label: input.productLabel,
    suggested_quantity: input.suggestedQuantity,
    available: input.available,
    min_quantity: input.minQuantity,
    target_quantity: input.targetQuantity,
    in_transit_in: input.inTransitIn,
    site_id: input.siteId,
    source_location_id: input.sourceLocationId,
    source_location_label: input.sourceLocationLabel,
    business_day: input.businessDay,
  };
  return publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'ReplenishmentSuggested',
    producerModule: PRODUCER,
    aggregateType: 'POS_PRODUCT',
    aggregateId: compositeSubjectId('POS_REPLENISH', payload),
    occurredAt: input.occurredAt,
    payload,
    passId: input.passId,
  });
}

/**
 * Transitions causées par un **changement de seuil** (`inventory.threshold.set`, AV-355) : changer le
 * minimum change l'état du couple sans aucun mouvement. Avant : l'ancien seuil (sans seuil, aucune alerte
 * ouverte : état correct) ; après : le nouveau, sur le solde physique courant.
 */
export async function publishThresholdSetTransitions(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: {
    readonly locationId: string;
    readonly productId: string;
    /** Minimum de l'ancien seuil actif ; `null` : aucun seuil actif avant. */
    readonly previousMinQty: number | null;
    readonly minQty: number;
    readonly targetQty: number;
    /** Date du fait : le jour métier des événements. */
    readonly factAt: Date;
    readonly commandId?: string | undefined;
  },
): Promise<void> {
  const available = (await stockOnHandMilli(uow, input.locationId, input.productId)) / 1000;
  const changes = stockLevelChanges(
    input.previousMinQty === null
      ? 'OK'
      : stockThresholdStateOf({ available, minQty: input.previousMinQty }),
    stockThresholdStateOf({ available, minQty: input.minQty }),
  );
  if (changes.length === 0) return;
  const [location, productLabel] = await Promise.all([
    locationAlertInfo(uow, input.locationId),
    productAlertLabel(uow, input.productId),
  ]);
  const detectedAt = detectionInstant(deps);
  for (const change of changes) {
    await publishStockLevelEvent(uow, deps, {
      locationId: input.locationId,
      productId: input.productId,
      level: change.level,
      breached: change.breached,
      available,
      thresholdQty: input.minQty,
      targetQty: input.targetQty,
      locationLabel: location?.name ?? input.locationId,
      productLabel,
      siteId: location?.siteId ?? null,
      businessDay: businessDayOf(input.factAt),
      occurredAt: detectedAt,
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    });
  }
}

// --- STOCK_NEGATIVE ----------------------------------------------------------------------------------

export interface StockNegativeEventInput {
  readonly locationId: string;
  readonly productId: string;
  /** Plus petit solde de lot négatif laissé par la sortie. */
  readonly balance: number;
  readonly lotId: string | null;
  readonly moveType: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly capturedOffline: boolean;
  /** Date du fait (jour métier de l'événement). */
  readonly factAt: Date;
  readonly commandId?: string | undefined;
}

/**
 * `StockNegativeDetected` : une sortie physique laisse un solde négatif (INV-STK-05, BR-STK-018). Un
 * événement par appel et par couple, quel que soit l'appelant qui ouvre le conflit de synchronisation.
 */
export async function publishStockNegativeEvent(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: StockNegativeEventInput,
): Promise<void> {
  const [location, productLabel] = await Promise.all([
    locationAlertInfo(uow, input.locationId),
    productAlertLabel(uow, input.productId),
  ]);
  const payload: Record<string, unknown> = {
    location_id: input.locationId.toLowerCase(),
    product_id: input.productId.toLowerCase(),
    negative: true,
    balance: input.balance,
    lot_id: input.lotId,
    location_label: location?.name ?? input.locationId,
    product_label: productLabel,
    site_id: location?.siteId ?? null,
    business_day: businessDayOf(input.factAt),
    move_type: input.moveType,
    source_doc_type: input.sourceDocType,
    source_doc_id: input.sourceDocId,
    captured_offline: input.capturedOffline,
  };
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'StockNegativeDetected',
    producerModule: PRODUCER,
    aggregateType: 'STOCK_POSITION',
    aggregateId: compositeSubjectId('STOCK_NEGATIVE', payload),
    occurredAt: detectionInstant(deps),
    payload,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
  });
}

// --- HIGH_LOSS : seuil absolu --------------------------------------------------------------------------

export interface HighLossEventInput {
  readonly locationId: string;
  readonly locationLabel: string;
  readonly siteId: string | null;
  readonly businessDay: string;
  /** Cumul du jour de l'emplacement (déclarations comptées, mortalité exclue : AV-403) ; `null` : plusieurs produits. */
  readonly lossQuantity: number | null;
  readonly lossValueXaf: number;
  readonly declarations: number;
  readonly thresholdXaf: number;
  readonly lastLossId: string;
  readonly commandId?: string | undefined;
}

/**
 * `HighLossDetected` (D13 §7.1 : valeur des pertes d'un emplacement sur un jour ≥ seuil). Mêmes clés
 * de message que `HighLossSalesShareDetected` (`sales`) : les deux producteurs partagent la même alerte
 * (emplacement × jour) et chacun remplace la charge utile à son tour.
 */
export async function publishHighLossEvent(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: HighLossEventInput,
): Promise<void> {
  const payload: Record<string, unknown> = {
    location_id: input.locationId.toLowerCase(),
    business_day: input.businessDay,
    location_label: input.locationLabel,
    site_id: input.siteId,
    loss_quantity: input.lossQuantity,
    loss_value_xaf: input.lossValueXaf,
    declarations: input.declarations,
    cause: 'ABSOLUTE',
    threshold_xaf: input.thresholdXaf,
    last_loss_id: input.lastLossId,
  };
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'HighLossDetected',
    producerModule: PRODUCER,
    aggregateType: 'LOSS_DAY',
    aggregateId: compositeSubjectId('HIGH_LOSS', payload),
    occurredAt: detectionInstant(deps),
    payload,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
  });
}

// --- INVENTORY_VARIANCE --------------------------------------------------------------------------------

export interface InventoryCountEventBase {
  readonly countId: string;
  readonly locationId: string;
  readonly siteId: string;
  readonly varianceQuantity: number;
  readonly varianceValueXaf: number;
  /** Date du fait (soumission ou décision) : le jour métier de l'événement. */
  readonly factAt: Date;
  readonly commandId?: string | undefined;
}

/**
 * `InventoryVarianceDetected` : un inventaire dont l'écart exige une validation (valeur ≥ seuil, ou animaux,
 * AV-108). Levé à la soumission, fermé par `InventoryAdjusted` à la comptabilisation approuvée.
 */
export async function publishInventoryVarianceEvent(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: InventoryCountEventBase & {
    readonly absVarianceValueXaf: number;
    readonly linesWithVariance: number;
    readonly animalVariance: boolean;
    readonly thresholdXaf: number;
    readonly approvalRequestId: string;
  },
): Promise<void> {
  const location = await locationAlertInfo(uow, input.locationId);
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'InventoryVarianceDetected',
    producerModule: PRODUCER,
    aggregateType: 'INVENTORY_COUNT',
    aggregateId: input.countId,
    occurredAt: detectionInstant(deps),
    payload: {
      count_id: input.countId,
      location_id: input.locationId,
      location_label: location?.name ?? input.locationId,
      site_id: input.siteId,
      variance_quantity: input.varianceQuantity,
      variance_value_xaf: input.varianceValueXaf,
      abs_variance_value_xaf: input.absVarianceValueXaf,
      lines_with_variance: input.linesWithVariance,
      animal_variance: input.animalVariance,
      threshold_xaf: input.thresholdXaf,
      approval_request_id: input.approvalRequestId,
      business_day: businessDayOf(input.factAt),
    },
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
  });
}

/**
 * `InventoryAdjusted` : les écarts d'un inventaire sont comptabilisés (`POSTED`), par la soumission sans
 * validation ou par la décision approuvée. Ferme l'alerte `INVENTORY_VARIANCE` du même inventaire.
 */
export async function publishInventoryAdjustedEvent(
  uow: UnitOfWork,
  deps: InventoryAlertDeps,
  input: InventoryCountEventBase,
): Promise<void> {
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'InventoryAdjusted',
    producerModule: PRODUCER,
    aggregateType: 'INVENTORY_COUNT',
    aggregateId: input.countId,
    occurredAt: detectionInstant(deps),
    payload: {
      count_id: input.countId,
      location_id: input.locationId,
      site_id: input.siteId,
      variance_quantity: input.varianceQuantity,
      variance_value_xaf: input.varianceValueXaf,
      status: 'POSTED',
      business_day: businessDayOf(input.factAt),
    },
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
  });
}
