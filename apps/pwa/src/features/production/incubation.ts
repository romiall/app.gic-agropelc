/**
 * ECR-PRD-06 « Incubation » (responsable de ferme, responsable de production ; D07 §7.4,
 * SM-INCUBATION ; BR-INC-001 à 009, INV-INC-01, AV-047) : logique pure.
 *
 * - Démarrage (`production.incubation.start`, agrégat `INCUBATION_BATCH`) : espèce aux durées
 *   paramétrées (`production.incubation_durations`), œufs à couver (produit paramétré
 *   `production.hatching_egg_product_code`, non biologique), poussin produit (volaille biologique
 *   suivie par lot), incubateur actif de la ferme, emplacement de stockage des œufs (ni incubateur, ni
 *   éclosoir), lot de stock des œufs facultatif (jamais celui d'un lot d'incubation ou de production),
 *   origine déclarée.
 * - Étapes (`.record_candling`, `.transfer_to_hatcher`, `.record_hatch`, agrégat `INCUBATION_EVENT`) :
 *   mirage et transfert sur un lot en incubateur, éclosion sur un lot en éclosoir ; bilans contrôlés
 *   par `checkCandling` et `checkHatch` (packages/domain), sur les compteurs du serveur corrigés des
 *   étapes de l'appareil pas encore retéléchargées. Une étape sur un lot démarré sur l'appareil
 *   attend son démarrage (ADR-051 §11).
 */
import {
  checkCandling,
  checkHatch,
  DomainError,
  eggsRemaining,
  hatchRates,
  speciesGroupOfProduct,
  type IncubationCounters,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import { settingValue } from '../sales/stock.js';
import type {
  IncubationBatchData,
  LocationData,
  ProductData,
  SettingData,
} from '../sales/types.js';

const INCUBATION_TYPES: ReadonlySet<string> = new Set(['INCUBATOR', 'HATCHER']);

/** Lot d'incubation vu de l'appareil : téléchargé, ou démarré ici et pas encore retéléchargé. */
export interface BatchView {
  readonly id: string;
  /** Numéro `INC-…` ; nul tant que le serveur ne l'a pas donné. */
  readonly batchCode: string | null;
  readonly siteId: string;
  readonly species: string;
  readonly eggProductId: string;
  readonly chickProductId: string;
  readonly incubatorLocationId: string;
  readonly hatcherLocationId: string | null;
  readonly status: string;
  readonly expectedCandlingDate: string | null;
  readonly expectedTransferDate: string | null;
  readonly expectedHatchDate: string | null;
  readonly counters: IncubationCounters;
  /** Étapes de l'appareil comptées dans les compteurs, pas encore confirmées. */
  readonly pendingSteps: number;
  /** Commande de démarrage encore sur l'appareil : une étape en dépend. */
  readonly startCommandId: string | null;
}

/** Espèces aux durées d'incubation paramétrées (clés de `production.incubation_durations`). */
export function incubationSpecies(settings: readonly SettingData[], now: Date): string[] {
  const value = settingValue(settings, 'production.incubation_durations', null, now);
  return value && typeof value === 'object'
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

/** Produit des œufs à couver paramétré (non biologique, actif) ; `undefined` sinon. */
export function hatchingEggProduct(
  products: readonly ProductData[],
  settings: readonly SettingData[],
  now: Date,
): ProductData | undefined {
  const code = settingValue(settings, 'production.hatching_egg_product_code', null, now);
  if (typeof code !== 'string' || !code.trim()) return undefined;
  return products.find(
    (product) =>
      product.code === code.trim() &&
      product.status === 'ACTIVE' &&
      product.stock_family !== 'BIOLOGIQUE',
  );
}

/** Poussins produits admis : volaille biologique suivie par lot, active. */
export function chickProducts(products: readonly ProductData[]): ProductData[] {
  return products
    .filter(
      (product) =>
        product.stock_family === 'BIOLOGIQUE' &&
        product.lot_tracking !== 'NONE' &&
        product.status === 'ACTIVE' &&
        speciesGroupOfProduct(product.species ?? null) === 'VOLAILLE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const activeFarmLocations = (locations: readonly LocationData[], siteId: string) =>
  locations
    .filter(
      (location) =>
        location.site_id === siteId && !location.is_virtual && location.status === 'ACTIVE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

export const incubators = (locations: readonly LocationData[], siteId: string): LocationData[] =>
  activeFarmLocations(locations, siteId).filter(
    (location) => location.location_type === 'INCUBATOR',
  );

export const hatchers = (locations: readonly LocationData[], siteId: string): LocationData[] =>
  activeFarmLocations(locations, siteId).filter((location) => location.location_type === 'HATCHER');

/** Fermes ayant au moins un incubateur actif. */
export function incubationFarms(
  refs: Pick<SalesReferences, 'sites' | 'locations'>,
): { readonly id: string; readonly name: string }[] {
  return [...refs.sites.values()]
    .filter((site) => site.site_type === 'FERME' && site.status === 'ACTIVE')
    .filter((site) => incubators(refs.locations, site.id).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .map((site) => ({ id: site.id, name: site.name }));
}

/** Œufs à couver en stock sur la ferme, hors incubateurs, éclosoirs et lots déjà engagés. */
export interface EggSource {
  readonly locationId: string;
  readonly quantity: number;
  readonly lots: readonly {
    readonly lotId: string;
    readonly lotCode: string;
    readonly quantity: number;
  }[];
}

export function eggSources(
  refs: Pick<SalesReferences, 'stock' | 'locations' | 'productionLots' | 'incubationBatches'>,
  siteId: string,
  eggProductId: string,
): EggSource[] {
  const storage = new Set(
    activeFarmLocations(refs.locations, siteId)
      .filter((location) => !INCUBATION_TYPES.has(location.location_type))
      .map((location) => location.id),
  );
  const engaged = new Set([
    ...refs.productionLots.map((lot) => lot.stock_lot_id),
    ...refs.incubationBatches.map((batch) => batch.stock_lot_id),
  ]);
  const sources: EggSource[] = [];
  for (const balance of refs.stock.values()) {
    if (balance.product_id !== eggProductId || !storage.has(balance.location_id)) continue;
    const lots = (balance.lots ?? [])
      .filter((lot) => lot.lot_id !== null && !engaged.has(lot.lot_id))
      .map((lot) => ({
        lotId: lot.lot_id as string,
        lotCode: lot.lot_code ?? '',
        quantity: Number(lot.qty_on_hand),
      }))
      .filter((lot) => lot.quantity > 0);
    const engagedQty = (balance.lots ?? [])
      .filter((lot) => lot.lot_id !== null && engaged.has(lot.lot_id))
      .reduce((sum, lot) => sum + Number(lot.qty_on_hand), 0);
    const quantity = Math.round((Number(balance.qty_on_hand) - engagedQty) * 1000) / 1000;
    if (quantity > 0) sources.push({ locationId: balance.location_id, quantity, lots });
  }
  return sources;
}

interface StepPayload {
  readonly batchId?: string;
  readonly infertile?: number;
  readonly earlyDead?: number;
  readonly hatcherLocationId?: string;
  readonly unhatched?: number;
  readonly hatchedViable?: number;
  readonly hatchedNonviable?: number;
}

interface StartPayload {
  readonly species?: string;
  readonly eggProductId?: string;
  readonly chickProductId?: string;
  readonly incubatorLocationId?: string;
  readonly eggsSet?: number;
}

const counterOf = (batch: IncubationBatchData): IncubationCounters => ({
  eggsSet: batch.eggs_set_qty,
  infertile: batch.infertile_qty,
  earlyDead: batch.early_dead_qty,
  accidentalLoss: batch.accidental_loss_qty,
  unhatched: 0,
  hatchedViable: 0,
  hatchedNonviable: 0,
});

const isAccepted = (command: OutboxCommand) =>
  command.status === 'SYNCED' || command.status === 'SYNCED_WITH_WARNING';

/** Lots d'incubation de l'appareil avec leurs compteurs corrigés des étapes en attente. */
export function batchViews(
  refs: Pick<SalesReferences, 'incubationBatches' | 'outbox' | 'productionPulledAt' | 'locations'>,
): BatchView[] {
  const sites = new Map(refs.locations.map((location) => [location.id, location.site_id]));
  const known = new Set(refs.incubationBatches.map((batch) => batch.id));
  const views = new Map<string, BatchView>();
  for (const batch of refs.incubationBatches) {
    views.set(batch.id, {
      id: batch.id,
      batchCode: batch.batch_code,
      siteId: batch.site_id,
      species: batch.species,
      eggProductId: batch.egg_product_id,
      chickProductId: batch.chick_product_id,
      incubatorLocationId: batch.incubator_location_id,
      hatcherLocationId: batch.hatcher_location_id,
      status: batch.status,
      expectedCandlingDate: batch.expected_candling_date,
      expectedTransferDate: batch.expected_transfer_date,
      expectedHatchDate: batch.expected_hatch_date,
      counters: counterOf(batch),
      pendingSteps: 0,
      startCommandId: null,
    });
  }
  const inFlight = refs.outbox.filter(
    (command) =>
      command.command_type.startsWith('production.incubation.') &&
      stillInFlight(command, refs.productionPulledAt),
  );
  for (const command of inFlight) {
    if (command.command_type !== 'production.incubation.start') continue;
    if (known.has(command.aggregate_id)) continue;
    const payload = command.payload as StartPayload;
    const siteId = payload.incubatorLocationId ? sites.get(payload.incubatorLocationId) : undefined;
    if (!siteId || !payload.eggsSet || !payload.incubatorLocationId) continue;
    views.set(command.aggregate_id, {
      id: command.aggregate_id,
      batchCode: command.server_refs?.batchCode ?? null,
      siteId,
      species: payload.species ?? '',
      eggProductId: payload.eggProductId ?? '',
      chickProductId: payload.chickProductId ?? '',
      incubatorLocationId: payload.incubatorLocationId,
      hatcherLocationId: null,
      status: 'INCUBATING',
      expectedCandlingDate: null,
      expectedTransferDate: null,
      expectedHatchDate: null,
      counters: {
        eggsSet: payload.eggsSet,
        infertile: 0,
        earlyDead: 0,
        accidentalLoss: 0,
        unhatched: 0,
        hatchedViable: 0,
        hatchedNonviable: 0,
      },
      pendingSteps: 0,
      startCommandId: isAccepted(command) ? null : command.command_id,
    });
  }
  for (const command of inFlight) {
    const payload = command.payload as StepPayload;
    const view = payload.batchId ? views.get(payload.batchId) : undefined;
    if (!view) continue;
    let next: BatchView = view;
    if (command.command_type === 'production.incubation.record_candling') {
      next = {
        ...view,
        counters: {
          ...view.counters,
          infertile: view.counters.infertile + (payload.infertile ?? 0),
          earlyDead: view.counters.earlyDead + (payload.earlyDead ?? 0),
        },
      };
    } else if (command.command_type === 'production.incubation.transfer_to_hatcher') {
      next = {
        ...view,
        status: 'IN_HATCHER',
        hatcherLocationId: payload.hatcherLocationId ?? null,
      };
    } else if (command.command_type === 'production.incubation.record_hatch') {
      next = {
        ...view,
        status: 'CLOSED',
        counters: {
          ...view.counters,
          unhatched: payload.unhatched ?? 0,
          hatchedViable: payload.hatchedViable ?? 0,
          hatchedNonviable: payload.hatchedNonviable ?? 0,
        },
      };
    } else {
      continue;
    }
    views.set(view.id, { ...next, pendingSteps: view.pendingSteps + 1 });
  }
  return [...views.values()].sort((a, b) => (a.batchCode ?? '~').localeCompare(b.batchCode ?? '~'));
}

/** Contrôle d'un mirage ou d'une éclosion par le domaine ; message du domaine si refusé. */
export function stepError(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error) {
    if (error instanceof DomainError) return error.message;
    throw error;
  }
}

export const candlingError = (
  batch: BatchView,
  candling: { readonly infertile: number; readonly earlyDead: number },
) => stepError(() => checkCandling(batch.counters, candling));

export const hatchError = (
  batch: BatchView,
  hatch: {
    readonly unhatched: number;
    readonly hatchedViable: number;
    readonly hatchedNonviable: number;
  },
) => stepError(() => checkHatch(batch.counters, hatch));

export { eggsRemaining, hatchRates };

/** Nombre entier ≥ 0 saisi (vide : 0) ; `null` si invalide. */
export function parseEggCount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  if (normalized === '') return 0;
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= 1_000_000_000 ? value : null;
}

export const stepDependsOn = (batch: BatchView): string[] =>
  batch.startCommandId ? [batch.startCommandId] : [];
