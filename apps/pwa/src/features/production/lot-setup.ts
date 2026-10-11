/**
 * ECR-PRD-04 « Nouveau lot / mise en place / entrée » (responsable de production ; D07, SM-PRODUCTION-
 * LOT ; BR-PRD-001, -002, -004 ; AV-099, AV-111, AV-112) : logique pure.
 *
 * - Nouveau lot (`production.lot.create`, agrégat `PRODUCTION_LOT`) : ferme, type de lot, produit
 *   biologique actif suivi par lot de l'espèce du type (`lotAcceptsProductSpecies`, comme le serveur),
 *   bâtiment ou case principal de la ferme, lot lié facultatif de la même ferme et de la même espèce,
 *   fournisseur, souche, dates prévues. Le numéro `LOT-…` est donné par le serveur.
 * - Entrée (`production.lot.record_entry`, agrégat `LOT_ENTRY`) sur un lot planifié, actif ou en vente,
 *   y compris un lot créé sur l'appareil et pas encore envoyé (la commande dépend alors de sa
 *   création, ADR-051 §11) : depuis le stock de la ferme, depuis une réception d'achat comptabilisée de
 *   la ferme, depuis un autre lot (transfert), par sevrage, ou naissance ; sortes admises selon
 *   `checkLotEntry` (packages/domain), comme le serveur. Têtes entières.
 */
import {
  acceptsDailyEntries,
  acceptsLotEntries,
  checkLotEntry,
  DomainError,
  lotAcceptsProductSpecies,
  lotTypeProfile,
  PRODUCTION_LOT_TYPES,
  speciesGroupOfProduct,
  type LotEntrySourceKind,
  type ProductionLotStatus,
  type ProductionLotType,
} from '@gic/domain';
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import type {
  GoodsReceiptData,
  LocationData,
  ProductData,
  ProductionLotData,
  SiteData,
} from '../sales/types.js';

export { PRODUCTION_LOT_TYPES };
export const LOT_SOURCE_KINDS: readonly LotEntrySourceKind[] = [
  'INTERNAL_STOCK',
  'PURCHASE',
  'TRANSFER',
  'WEANING',
  'BIRTH',
];
export const MAX_STRAIN = 100;
export const MAX_LOT_NOTES = 4000;
/** Réceptions d'où l'on met en place (`PLACEABLE_RECEIPT_STATUSES` du serveur). */
const PLACEABLE_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'POSTED',
  'POSTED_PENDING_REVIEW',
]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Fermes actives connues de l'appareil, par nom. */
export function farms(sites: Iterable<SiteData>): SiteData[] {
  return [...sites]
    .filter((site) => site.site_type === 'FERME' && site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Produits admis pour un type de lot (BR-PRD-001). */
export function lotProducts(
  products: readonly ProductData[],
  lotType: ProductionLotType,
): ProductData[] {
  return products
    .filter(
      (product) =>
        product.stock_family === 'BIOLOGIQUE' &&
        product.lot_tracking !== 'NONE' &&
        product.status === 'ACTIVE' &&
        lotAcceptsProductSpecies(lotType, product.species ?? null),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Lots liables (AV-099) : ouverts, de la même ferme et de la même espèce. */
export function parentCandidates(
  lots: readonly ProductionLotData[],
  siteId: string,
  lotType: ProductionLotType,
): ProductionLotData[] {
  const species = lotTypeProfile(lotType).species;
  return lots
    .filter(
      (lot) =>
        lot.site_id === siteId &&
        lot.status !== 'CLOSED' &&
        lot.status !== 'CANCELLED' &&
        lotTypeProfile(lot.lot_type as ProductionLotType).species === species,
    )
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
}

export interface LotDraft {
  readonly siteId: string;
  readonly lotType: ProductionLotType;
  readonly productId: string;
  readonly mainLocationId: string;
  readonly parentLotId: string;
  readonly supplierId: string;
  readonly strain: string;
  readonly plannedStartDate: string;
  readonly plannedEndDate: string;
  readonly notes: string;
}

export type LotIssue = 'FARM_REQUIRED' | 'PRODUCT_REQUIRED' | 'LOCATION_REQUIRED' | 'DATES_INVALID';

export function checkLotDraft(draft: LotDraft): LotIssue[] {
  const issues: LotIssue[] = [];
  if (!draft.siteId) issues.push('FARM_REQUIRED');
  if (!draft.productId) issues.push('PRODUCT_REQUIRED');
  if (!draft.mainLocationId) issues.push('LOCATION_REQUIRED');
  const start = draft.plannedStartDate;
  const end = draft.plannedEndDate;
  if (
    (start && !DATE_ONLY.test(start)) ||
    (end && !DATE_ONLY.test(end)) ||
    (start && end && end < start)
  ) {
    issues.push('DATES_INVALID');
  }
  return issues;
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export function lotCreatePayload(draft: LotDraft) {
  const strain = optionalText(draft.strain);
  const notes = optionalText(draft.notes);
  return {
    lotType: draft.lotType,
    productId: draft.productId,
    mainLocationId: draft.mainLocationId,
    ...(draft.parentLotId ? { parentLotId: draft.parentLotId } : {}),
    ...(draft.supplierId ? { supplierId: draft.supplierId } : {}),
    ...(strain ? { strain } : {}),
    ...(draft.plannedStartDate ? { plannedStartDate: draft.plannedStartDate } : {}),
    ...(draft.plannedEndDate ? { plannedEndDate: draft.plannedEndDate } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Lot qui reçoit une entrée : téléchargé, ou créé sur l'appareil et pas encore retéléchargé. */
export interface EntryLot {
  readonly id: string;
  /** Numéro du lot ; nul tant que le serveur ne l'a pas donné. */
  readonly lotCode: string | null;
  readonly lotType: ProductionLotType;
  readonly productId: string;
  readonly siteId: string;
  readonly mainLocationId: string;
  readonly parentLotId: string | null;
  readonly status: ProductionLotStatus;
  /** Commande de création encore sur l'appareil : l'entrée en dépend. */
  readonly createCommandId: string | null;
}

interface CreatePayloadLike {
  readonly lotType?: string;
  readonly productId?: string;
  readonly mainLocationId?: string;
  readonly parentLotId?: string;
}

/** Lots qui acceptent une entrée (planifiés, actifs, en vente), y compris ceux créés sur l'appareil. */
export function entryLots(
  refs: Pick<SalesReferences, 'productionLots' | 'outbox' | 'productionPulledAt' | 'locations'>,
): EntryLot[] {
  const known = new Set(refs.productionLots.map((lot) => lot.id));
  const sites = new Map(refs.locations.map((location) => [location.id, location.site_id]));
  const downloaded: EntryLot[] = refs.productionLots
    .filter((lot) => acceptsLotEntries(lot.status as ProductionLotStatus))
    .map((lot) => ({
      id: lot.id,
      lotCode: lot.lot_code,
      lotType: lot.lot_type as ProductionLotType,
      productId: lot.product_id,
      siteId: lot.site_id,
      mainLocationId: lot.main_location_id,
      parentLotId: lot.parent_lot_id ?? null,
      status: lot.status as ProductionLotStatus,
      createCommandId: null,
    }));
  const pending: EntryLot[] = [];
  for (const command of refs.outbox) {
    if (command.command_type !== 'production.lot.create') continue;
    if (known.has(command.aggregate_id)) continue;
    if (!stillInFlight(command, refs.productionPulledAt)) continue;
    const payload = command.payload as CreatePayloadLike;
    const siteId = payload.mainLocationId ? sites.get(payload.mainLocationId) : undefined;
    if (!payload.lotType || !payload.productId || !payload.mainLocationId || !siteId) continue;
    pending.push({
      id: command.aggregate_id,
      lotCode: command.server_refs?.lotCode ?? null,
      lotType: payload.lotType as ProductionLotType,
      productId: payload.productId,
      siteId,
      mainLocationId: payload.mainLocationId,
      parentLotId: payload.parentLotId ?? null,
      status: 'PLANNED',
      createCommandId:
        command.status === 'SYNCED' || command.status === 'SYNCED_WITH_WARNING'
          ? null
          : command.command_id,
    });
  }
  return [...downloaded, ...pending].sort((a, b) =>
    (a.lotCode ?? '').localeCompare(b.lotCode ?? '', 'fr'),
  );
}

const entryAllowed = (input: Parameters<typeof checkLotEntry>[0]): boolean => {
  try {
    checkLotEntry(input);
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
};

/** Lots d'où faire passer des têtes (transfert, sevrage) : actifs, même ferme, admis par le domaine. */
export function sourceLots(
  lots: readonly ProductionLotData[],
  lot: EntryLot,
  kind: 'TRANSFER' | 'WEANING',
): ProductionLotData[] {
  return lots
    .filter(
      (candidate) =>
        candidate.id !== lot.id &&
        candidate.site_id === lot.siteId &&
        acceptsDailyEntries(candidate.status as ProductionLotStatus) &&
        entryAllowed({
          lotType: lot.lotType,
          sourceKind: kind,
          sourceLotType: candidate.lot_type as ProductionLotType,
          sameLot: false,
        }),
    )
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
}

/** Sortes d'entrée proposées pour ce lot. */
export function allowedKinds(
  lot: EntryLot,
  lots: readonly ProductionLotData[],
): LotEntrySourceKind[] {
  const parent = lot.parentLotId
    ? lots.find((candidate) => candidate.id === lot.parentLotId)
    : undefined;
  return LOT_SOURCE_KINDS.filter((kind) => {
    if (kind === 'TRANSFER' || kind === 'WEANING') return sourceLots(lots, lot, kind).length > 0;
    return entryAllowed({
      lotType: lot.lotType,
      sourceKind: kind,
      parentLotType: (parent?.lot_type as ProductionLotType | undefined) ?? null,
    });
  });
}

/** Animaux en stock sur la ferme du lot, de la même espèce, hors têtes d'un lot de production. */
export interface StockSource {
  readonly locationId: string;
  readonly productId: string;
  /** Lots de stock (fournisseur, incubation) avec leur quantité ; vide si non suivi par lot. */
  readonly lots: readonly {
    readonly lotId: string;
    readonly lotCode: string;
    readonly quantity: number;
  }[];
  readonly quantity: number;
}

export function stockSources(
  refs: Pick<SalesReferences, 'stock' | 'locations' | 'products' | 'productionLots'>,
  lot: EntryLot,
): StockSource[] {
  const lotProduct = refs.products.find((product) => product.id === lot.productId);
  const group = speciesGroupOfProduct(lotProduct?.species ?? null);
  const farm = new Set(
    refs.locations
      .filter((location) => location.site_id === lot.siteId && !location.is_virtual)
      .map((location) => location.id),
  );
  const biological = new Map(
    refs.products
      .filter(
        (product) =>
          product.stock_family === 'BIOLOGIQUE' &&
          group !== null &&
          speciesGroupOfProduct(product.species ?? null) === group,
      )
      .map((product) => [product.id, product]),
  );
  const productionStockLots = new Set(
    refs.productionLots.map((candidate) => candidate.stock_lot_id),
  );
  const sources: StockSource[] = [];
  for (const balance of refs.stock.values()) {
    if (!farm.has(balance.location_id) || !biological.has(balance.product_id)) continue;
    const lots = (balance.lots ?? [])
      .filter((stockLot) => stockLot.lot_id !== null && !productionStockLots.has(stockLot.lot_id))
      .map((stockLot) => ({
        lotId: stockLot.lot_id as string,
        lotCode: stockLot.lot_code ?? '',
        quantity: Number(stockLot.qty_on_hand),
      }))
      .filter((stockLot) => stockLot.quantity > 0);
    const inProduction = (balance.lots ?? [])
      .filter((stockLot) => stockLot.lot_id !== null && productionStockLots.has(stockLot.lot_id))
      .reduce((sum, stockLot) => sum + Number(stockLot.qty_on_hand), 0);
    const quantity = Math.round((Number(balance.qty_on_hand) - inProduction) * 1000) / 1000;
    if (quantity <= 0) continue;
    sources.push({
      locationId: balance.location_id,
      productId: balance.product_id,
      lots,
      quantity,
    });
  }
  return sources;
}

/** Réceptions comptabilisées de la ferme qui portent des animaux de l'espèce du lot. */
export function placementReceipts(
  refs: Pick<SalesReferences, 'goodsReceipts' | 'locations' | 'products'>,
  lot: EntryLot,
): GoodsReceiptData[] {
  const lotProduct = refs.products.find((product) => product.id === lot.productId);
  const group = speciesGroupOfProduct(lotProduct?.species ?? null);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const sites = new Map(
    refs.locations.map((location: LocationData) => [location.id, location.site_id]),
  );
  return refs.goodsReceipts
    .filter(
      (receipt) =>
        PLACEABLE_RECEIPT_STATUSES.has(receipt.status) &&
        sites.get(receipt.location_id) === lot.siteId &&
        receipt.lines.some((line) => {
          const product = products.get(line.product_id);
          return (
            product?.stock_family === 'BIOLOGIQUE' &&
            group !== null &&
            speciesGroupOfProduct(product.species ?? null) === group &&
            Number(line.qty_accepted_base) > 0
          );
        }),
    )
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export interface EntryDraft {
  readonly kind: LotEntrySourceKind;
  readonly quantityText: string;
  readonly toLocationId: string;
  /** Stock : emplacement et produit d'origine (`emplacement|produit`), lot de stock facultatif. */
  readonly stockSource: string;
  readonly sourceStockLotId: string;
  /** Achat : réception et produit d'origine. */
  readonly goodsReceiptId: string;
  readonly receiptProductId: string;
  /** Transfert, sevrage : lot et emplacement d'origine. */
  readonly sourceProductionLotId: string;
  readonly sourceLocationId: string;
  /** Naissance : mort-nés. */
  readonly stillbornText: string;
  readonly avgWeightText: string;
}

export const EMPTY_ENTRY: EntryDraft = {
  kind: 'INTERNAL_STOCK',
  quantityText: '',
  toLocationId: '',
  stockSource: '',
  sourceStockLotId: '',
  goodsReceiptId: '',
  receiptProductId: '',
  sourceProductionLotId: '',
  sourceLocationId: '',
  stillbornText: '',
  avgWeightText: '',
};

export type EntryIssue =
  'QUANTITY_INVALID' | 'SOURCE_REQUIRED' | 'STILLBORN_INVALID' | 'WEIGHT_INVALID';

const wholeCount = (text: string, allowZero: boolean): number | null => {
  const normalized = text.trim().replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return (allowZero ? value >= 0 : value > 0) && value <= 1_000_000_000 ? value : null;
};

export interface EntryCheck {
  readonly issues: readonly EntryIssue[];
  readonly quantity: number | null;
  readonly stillborn: number | null;
  readonly avgWeightG: number | null;
}

export function checkEntry(draft: EntryDraft): EntryCheck {
  const issues: EntryIssue[] = [];
  const quantity = wholeCount(draft.quantityText, false);
  if (quantity === null) issues.push('QUANTITY_INVALID');
  let stillborn: number | null = null;
  if (draft.kind === 'BIRTH' && draft.stillbornText.trim()) {
    stillborn = wholeCount(draft.stillbornText, true);
    if (stillborn === null) issues.push('STILLBORN_INVALID');
  }
  let avgWeightG: number | null = null;
  if (draft.avgWeightText.trim()) {
    const normalized = draft.avgWeightText.trim().replace(',', '.');
    avgWeightG = /^\d+(\.\d{1,1})?$/.test(normalized) ? Number(normalized) : null;
    if (avgWeightG === null || avgWeightG <= 0 || avgWeightG > 1_000_000) {
      issues.push('WEIGHT_INVALID');
      avgWeightG = null;
    }
  }
  const sourceMissing =
    (draft.kind === 'INTERNAL_STOCK' && !draft.stockSource) ||
    (draft.kind === 'PURCHASE' && (!draft.goodsReceiptId || !draft.receiptProductId)) ||
    ((draft.kind === 'TRANSFER' || draft.kind === 'WEANING') &&
      (!draft.sourceProductionLotId || !draft.sourceLocationId));
  if (sourceMissing) issues.push('SOURCE_REQUIRED');
  return { issues, quantity, stillborn, avgWeightG };
}

/** Charge utile de `production.lot.record_entry` (champs de la sorte choisie seulement). */
export function entryPayload(lot: EntryLot, draft: EntryDraft, check: EntryCheck) {
  const [sourceLocationId, sourceProductId] = draft.stockSource.split('|');
  return {
    productionLotId: lot.id,
    sourceKind: draft.kind,
    quantity: check.quantity as number,
    ...(draft.toLocationId ? { toLocationId: draft.toLocationId } : {}),
    ...(draft.kind === 'INTERNAL_STOCK'
      ? {
          sourceLocationId,
          sourceProductId,
          ...(draft.sourceStockLotId ? { sourceStockLotId: draft.sourceStockLotId } : {}),
        }
      : {}),
    ...(draft.kind === 'PURCHASE'
      ? { goodsReceiptId: draft.goodsReceiptId, sourceProductId: draft.receiptProductId }
      : {}),
    ...(draft.kind === 'TRANSFER' || draft.kind === 'WEANING'
      ? {
          sourceProductionLotId: draft.sourceProductionLotId,
          sourceLocationId: draft.sourceLocationId,
        }
      : {}),
    ...(draft.kind === 'BIRTH' && check.stillborn ? { stillbornQty: check.stillborn } : {}),
    ...(check.avgWeightG !== null ? { avgWeightG: check.avgWeightG } : {}),
  };
}

/** Commandes de l'outbox dont une entrée sur ce lot doit attendre la création. */
export const entryDependsOn = (lot: EntryLot): string[] =>
  lot.createCommandId ? [lot.createCommandId] : [];
