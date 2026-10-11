/**
 * ECR-PRD-01 « Lots actifs » et ECR-PRD-02 « SAISIE DU JOUR » (D07 ; BR-PRD-005, -008, -015) : logique
 * pure.
 *
 * - Saisie seulement sur un lot `ACTIVE` ou `SELLING` (`acceptsDailyEntries`) ; un lot clôturé entre-
 *   temps reçoit la saisie hors ligne avec un signalement.
 * - Effectif en élevage (INV-PRD-01) : soldes du lot de stock du lot de production sur les bâtiments
 *   et cases (`BUILDING`, `PEN`) du jeu `stock`, moins les mortalités de l'appareil en attente
 *   (comparées au tirage du jeu `stock`, qui porte l'effet de la mortalité). Le serveur contrôle le
 *   solde de l'emplacement choisi : la garde « plus de morts que l'effectif » porte sur ce bâtiment.
 * - Mortalité (`production.mortality.record`) : nombre entier de têtes, emplacement d'élevage, cause
 *   `LOSS` facultative ; validée selon la politique `MORTALITY` (photo non jointe par l'application,
 *   S-16). Intrant (`production.input.record`) : produit consommable, quantité convertie en unité de
 *   base, nature du coût. Pesée et observation sans effet sur le stock.
 * - Chaque saisie est une commande distincte : un rejet n'annule pas les autres (BR-PRD-008).
 */
import { acceptsDailyEntries, businessDayOf, type ProductionLotStatus } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import type { LocationData, ProductData, ProductionLotData } from '../sales/types.js';
import type { TransferLineCheck } from '../stock/transfer.js';

export const OBSERVATION_TYPES = [
  'SANITAIRE',
  'COMPORTEMENT',
  'ENVIRONNEMENT',
  'INCIDENT',
  'AUTRE',
] as const;
export const OBSERVATION_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export const INPUT_COST_TYPES = ['ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT'] as const;
export const MAX_DAILY_COMMENT = 2000;
export const MAX_OBSERVATION_TEXT = 4000;
const REARING_TYPES: ReadonlySet<string> = new Set(['BUILDING', 'PEN']);
/** Emplacements de la ferme où l'on ne stocke pas d'œufs collectés. */
const NOT_EGG_STORAGE: ReadonlySet<string> = new Set(['INCUBATOR', 'HATCHER', 'SLAUGHTERHOUSE']);
/** Mortalités qui ne comptent plus : retournées pour erreur de déclaration, annulées. */
const DROPPED_LOSS_STATUSES: ReadonlySet<string> = new Set(['REJECTED_RETURNED', 'CANCELLED']);
const LAYING_TYPES: ReadonlySet<string> = new Set(['PONDEUSE', 'REPRODUCTEUR_VOLAILLE']);

export const isDailyLot = (lot: Pick<ProductionLotData, 'status'>): boolean =>
  acceptsDailyEntries(lot.status as ProductionLotStatus);

export const laysEggs = (lot: Pick<ProductionLotData, 'lot_type'>): boolean =>
  LAYING_TYPES.has(lot.lot_type);

/** Lots où l'on saisit (actifs ou en vente), par code ; les lots planifiés à part. */
export function lotsOfDevice(lots: readonly ProductionLotData[]): {
  readonly daily: ProductionLotData[];
  readonly planned: ProductionLotData[];
} {
  const sorted = [...lots].sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
  return {
    daily: sorted.filter(isDailyLot),
    planned: sorted.filter((lot) => lot.status === 'PLANNED'),
  };
}

/** Bâtiments et cases de la ferme du lot (emplacements d'élevage). */
export function rearingLocations(
  locations: readonly LocationData[],
  lot: Pick<ProductionLotData, 'site_id'>,
): LocationData[] {
  return locations
    .filter(
      (location) =>
        location.site_id === lot.site_id &&
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        REARING_TYPES.has(location.location_type),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Emplacements physiques de la ferme du lot (magasin d'aliment, bâtiments…). */
export function farmLocations(
  locations: readonly LocationData[],
  lot: Pick<ProductionLotData, 'site_id'>,
): LocationData[] {
  return locations
    .filter(
      (location) =>
        location.site_id === lot.site_id && !location.is_virtual && location.status === 'ACTIVE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Emplacements de stockage des œufs collectés : ceux de la ferme hors incubateur, éclosoir et abattoir,
 * les magasins d'abord.
 */
export function eggStorageLocations(
  locations: readonly LocationData[],
  lot: Pick<ProductionLotData, 'site_id'>,
): LocationData[] {
  const stores = (location: LocationData) => (location.location_type === 'STORE' ? 0 : 1);
  return farmLocations(locations, lot)
    .filter((location) => !NOT_EGG_STORAGE.has(location.location_type))
    .sort((a, b) => stores(a) - stores(b));
}

interface MortalityPayload {
  readonly productionLotId?: string;
  readonly locationId?: string;
  readonly quantity?: number;
}

/**
 * Mortalités de l'appareil pas encore retéléchargées, par lot de production (ou par lot et
 * emplacement, clé `lot:emplacement`, si `byLocation`).
 */
export function pendingDeaths(
  outbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
  byLocation = false,
): Map<string, number> {
  const deaths = new Map<string, number>();
  for (const command of outbox) {
    if (command.command_type !== 'production.mortality.record') continue;
    if (!stillInFlight(command, pulledAt)) continue;
    const payload = command.payload as MortalityPayload;
    if (!payload.productionLotId || !payload.quantity) continue;
    const key = byLocation
      ? `${payload.productionLotId}:${payload.locationId ?? ''}`
      : payload.productionLotId;
    deaths.set(key, (deaths.get(key) ?? 0) + payload.quantity);
  }
  return deaths;
}

/** Têtes du lot de stock du lot sur les emplacements retenus ; `null` sans aucun solde connu. */
function lotHeads(
  refs: Pick<SalesReferences, 'stock'>,
  lot: ProductionLotData,
  keep: (locationId: string) => boolean,
): number | null {
  let found = false;
  let heads = 0;
  for (const balance of refs.stock.values()) {
    if (balance.product_id !== lot.product_id || !keep(balance.location_id)) continue;
    for (const stockLot of balance.lots ?? []) {
      if (stockLot.lot_id !== lot.stock_lot_id) continue;
      found = true;
      heads += Number(stockLot.qty_on_hand);
    }
  }
  return found ? heads : null;
}

/**
 * Effectif en élevage (INV-PRD-01) : têtes du lot de stock sur les bâtiments et cases, moins les
 * mortalités de l'appareil en attente ; `null` si l'appareil n'en détient aucun solde.
 */
export function rearingHeadcount(
  refs: Pick<SalesReferences, 'stock' | 'locations' | 'outbox' | 'stockPulledAt'>,
  lot: ProductionLotData,
): number | null {
  const rearing = new Set(
    refs.locations
      .filter((location) => REARING_TYPES.has(location.location_type))
      .map((location) => location.id),
  );
  const heads = lotHeads(refs, lot, (locationId) => rearing.has(locationId));
  if (heads === null) return null;
  const pending = pendingDeaths(refs.outbox, refs.stockPulledAt).get(lot.id) ?? 0;
  return Math.round((heads - pending) * 1000) / 1000;
}

/**
 * Têtes du lot sur un bâtiment ou une case (ce que le serveur contrôle pour une mortalité), moins les
 * mortalités de l'appareil en attente sur cet emplacement ; `null` sans solde connu.
 */
export function locationHeadcount(
  refs: Pick<SalesReferences, 'stock' | 'outbox' | 'stockPulledAt'>,
  lot: ProductionLotData,
  locationId: string,
): number | null {
  const heads = lotHeads(refs, lot, (candidate) => candidate === locationId);
  if (heads === null) return null;
  const pending =
    pendingDeaths(refs.outbox, refs.stockPulledAt, true).get(`${lot.id}:${locationId}`) ?? 0;
  return Math.round((heads - pending) * 1000) / 1000;
}

/** Âge du lot en jours (jour métier), depuis la première entrée ; `null` sans date de début. */
export function ageDays(lot: Pick<ProductionLotData, 'start_date'>, today: string): number | null {
  if (!lot.start_date) return null;
  const start = Date.UTC(
    Number(lot.start_date.slice(0, 4)),
    Number(lot.start_date.slice(5, 7)) - 1,
    Number(lot.start_date.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export type JournalKind = 'MORTALITY' | 'INPUT' | 'WEIGHING' | 'OBSERVATION' | 'EGGS';

export interface JournalEntry {
  readonly id: string;
  readonly kind: JournalKind;
  readonly at: string;
  readonly pending: boolean;
  /** Valeurs utiles au libellé (quantité, produit, poids, texte…). */
  readonly values: Readonly<Record<string, string | number>>;
}

const isToday = (iso: string, today: string): boolean => businessDayOf(new Date(iso)) === today;

/**
 * Journal du jour d'un lot : saisies téléchargées (hors annulées) et saisies de l'appareil pas encore
 * retéléchargées, la plus récente d'abord.
 */
export function todayJournal(
  refs: Pick<
    SalesReferences,
    | 'lotLosses'
    | 'lotConsumptions'
    | 'lotWeighings'
    | 'lotObservations'
    | 'eggCollections'
    | 'outbox'
    | 'productionPulledAt'
    | 'products'
  >,
  lotId: string,
  today: string,
): JournalEntry[] {
  const names = new Map(refs.products.map((product: ProductData) => [product.id, product.name]));
  const entries: JournalEntry[] = [];
  const known = new Set<string>();
  for (const loss of refs.lotLosses) {
    if (loss.production_lot_id !== lotId || loss.category !== 'MORTALITE') continue;
    known.add(loss.id);
    if (DROPPED_LOSS_STATUSES.has(loss.status) || !isToday(loss.occurred_at, today)) continue;
    entries.push({
      id: loss.id,
      kind: 'MORTALITY',
      at: loss.occurred_at,
      pending: false,
      values: { quantity: loss.quantity_base ?? 0, status: loss.status },
    });
  }
  for (const consumption of refs.lotConsumptions) {
    if (consumption.production_lot_id !== lotId) continue;
    known.add(consumption.id);
    if (consumption.status === 'CANCELLED' || !isToday(consumption.occurred_at, today)) continue;
    entries.push({
      id: consumption.id,
      kind: 'INPUT',
      at: consumption.occurred_at,
      pending: false,
      values: {
        product: names.get(consumption.product_id) ?? '',
        quantity: consumption.quantity ?? consumption.quantity_base ?? 0,
        unit: consumption.unit_code,
      },
    });
  }
  for (const weighing of refs.lotWeighings) {
    if (weighing.production_lot_id !== lotId) continue;
    known.add(weighing.id);
    if (weighing.status === 'CANCELLED' || !isToday(weighing.occurred_at, today)) continue;
    entries.push({
      id: weighing.id,
      kind: 'WEIGHING',
      at: weighing.occurred_at,
      pending: false,
      values: { sample: weighing.sample_size, weight: weighing.avg_weight_g },
    });
  }
  for (const observation of refs.lotObservations) {
    if (observation.production_lot_id !== lotId) continue;
    known.add(observation.id);
    if (!isToday(observation.occurred_at, today)) continue;
    entries.push({
      id: observation.id,
      kind: 'OBSERVATION',
      at: observation.occurred_at,
      pending: false,
      values: { type: observation.observation_type, text: observation.text },
    });
  }
  for (const collection of refs.eggCollections) {
    if (collection.production_lot_id !== lotId) continue;
    known.add(collection.id);
    if (collection.status === 'CANCELLED' || !isToday(collection.occurred_at, today)) continue;
    entries.push({
      id: collection.id,
      kind: 'EGGS',
      at: collection.occurred_at,
      pending: false,
      values: { collected: collection.collected_qty, marketable: collection.marketable_qty },
    });
  }
  const kinds: Readonly<Record<string, JournalKind>> = {
    'production.mortality.record': 'MORTALITY',
    'production.input.record': 'INPUT',
    'production.weighing.record': 'WEIGHING',
    'production.observation.record': 'OBSERVATION',
    'production.egg_collection.record': 'EGGS',
  };
  for (const command of refs.outbox) {
    const kind = kinds[command.command_type];
    if (!kind || known.has(command.aggregate_id)) continue;
    if (!stillInFlight(command, refs.productionPulledAt)) continue;
    const payload = command.payload as Record<string, unknown> & { productionLotId?: string };
    if (payload.productionLotId !== lotId || !isToday(command.occurred_at, today)) continue;
    entries.push({
      id: command.aggregate_id,
      kind,
      at: command.occurred_at,
      pending: true,
      values:
        kind === 'MORTALITY'
          ? { quantity: Number(payload.quantity ?? 0), status: '' }
          : kind === 'INPUT'
            ? {
                product: names.get(String(payload.productId)) ?? '',
                quantity: Number(payload.quantity ?? 0),
                unit: String(payload.unitCode ?? ''),
              }
            : kind === 'WEIGHING'
              ? { sample: Number(payload.sampleSize ?? 0), weight: Number(payload.avgWeightG ?? 0) }
              : kind === 'OBSERVATION'
                ? { type: String(payload.observationType ?? ''), text: String(payload.text ?? '') }
                : {
                    collected: Number(payload.collected ?? 0),
                    marketable:
                      Number(payload.collected ?? 0) -
                      Number(payload.broken ?? 0) -
                      Number(payload.nonconforming ?? 0) -
                      Number(payload.hatching ?? 0),
                  },
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** Nombre entier strictement positif ; `null` sinon. */
export function parseCount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= 1_000_000_000 ? value : null;
}

/** Décimal strictement positif (virgule ou point), au plus `decimals` décimales ; `null` sinon. */
export function parsePositive(text: string, max: number, decimals = 3): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= max ? value : null;
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export function mortalityPayload(input: {
  readonly lotId: string;
  readonly locationId: string;
  readonly quantity: number;
  readonly reasonCodeId: string;
  readonly comment: string;
}) {
  const comment = optionalText(input.comment);
  return {
    productionLotId: input.lotId,
    locationId: input.locationId,
    quantity: input.quantity,
    ...(input.reasonCodeId ? { reasonCodeId: input.reasonCodeId } : {}),
    ...(comment ? { comment } : {}),
  };
}

export function inputPayload(input: {
  readonly lotId: string;
  readonly locationId: string;
  readonly line: TransferLineCheck & { readonly quantity: number; readonly quantityBase: number };
  readonly costType: (typeof INPUT_COST_TYPES)[number];
}) {
  return {
    productionLotId: input.lotId,
    locationId: input.locationId,
    productId: input.line.draft.productId,
    quantityBase: input.line.quantityBase,
    unitCode: input.line.draft.unitCode,
    quantity: input.line.quantity,
    costType: input.costType,
  };
}

export function weighingPayload(input: {
  readonly lotId: string;
  readonly locationId: string;
  readonly sampleSize: number;
  readonly avgWeightG: number;
  readonly totalWeightKg: number | null;
}) {
  return {
    productionLotId: input.lotId,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    sampleSize: input.sampleSize,
    avgWeightG: input.avgWeightG,
    ...(input.totalWeightKg !== null ? { totalWeightKg: input.totalWeightKg } : {}),
    source: 'MANUAL' as const,
  };
}

export function observationPayload(input: {
  readonly lotId: string;
  readonly type: (typeof OBSERVATION_TYPES)[number];
  readonly severity: (typeof OBSERVATION_SEVERITIES)[number];
  readonly text: string;
}) {
  return {
    productionLotId: input.lotId,
    observationType: input.type,
    text: input.text.trim(),
    severity: input.severity,
  };
}

/** Intrants consommables sur un lot : `is_consumable`, hors famille biologique, actifs. */
export function consumableProducts(products: readonly ProductData[]): ProductData[] {
  return products
    .filter(
      (product) =>
        product.is_consumable === true &&
        product.stock_family !== 'BIOLOGIQUE' &&
        product.status === 'ACTIVE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
