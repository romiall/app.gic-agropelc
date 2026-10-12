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
 *   étapes de l'appareil pas encore retéléchargées (tous auteurs). Le restant est borné par le solde
 *   réel du lot de stock du lot d'incubation (incubateur et éclosoir), net des mirages et pertes en
 *   attente : une perte accidentelle déclarée sur le lot (BR-INC-003) n'est pas reportée dans le jeu
 *   (S-38). Une étape attend le démarrage du lot sur l'appareil et les étapes encore en attente sur
 *   le même lot, de tout utilisateur de l'appareil (ADR-037 §11).
 * - Œufs à couver : disponible d'un lot désigné net de l'attente qui le désigne ; l'attente des lots
 *   engagés n'est pas retranchée une seconde fois du stock libre.
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
import { isWaiting, stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import {
  lotStockKey,
  pendingOnLots,
  pendingWithoutLot,
  settingValue,
  stockKey,
} from '../sales/stock.js';
import { scopeSiteIds } from '../stock/stock-view.js';
import type {
  IncubationBatchData,
  LocationData,
  ProductData,
  SettingData,
} from '../sales/types.js';

const INCUBATION_TYPES: ReadonlySet<string> = new Set(['INCUBATOR', 'HATCHER']);

/** Motif d'une annulation de lot d'incubation (perte totale), comme le serveur. */
export const MAX_CANCEL_COMMENT = 2000;

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
  /** Compteurs du jeu `production`, corrigés des étapes de l'appareil en attente (affichage). */
  readonly counters: IncubationCounters;
  /**
   * Compteurs de contrôle (mirage, éclosion) : restant borné en plus par le stock réel du lot, comme
   * le serveur compte les pertes du lot de stock (S-38).
   */
  readonly checkCounters: IncubationCounters;
  /** Écart entre le restant du jeu et le stock réel du lot (œufs), à confirmer. */
  readonly stockGap: number;
  /**
   * Plus aucun œuf du lot en stock alors que le jeu en annonce, avec des poussins du lot quelque part
   * (éclosion faite ailleurs) : données périmées.
   */
  readonly stockStale: boolean;
  /**
   * Plus aucun œuf du lot en stock, sans poussin du lot ni perte en attente : perte totale ; le lot se
   * clôt par annulation (`production.incubation.cancel`), pas par une éclosion.
   */
  readonly allLost: boolean;
  /** Étape d'un autre utilisateur de l'appareil encore en attente sur ce lot. */
  readonly otherAuthorWaiting: boolean;
  /** Étapes de l'appareil comptées dans les compteurs, pas encore confirmées. */
  readonly pendingSteps: number;
  /** Commande de démarrage encore sur l'appareil : une étape en dépend. */
  readonly startCommandId: string | null;
  /** Étapes du lot de cet utilisateur encore en attente : la suivante en dépend (ADR-037 §13). */
  readonly waitingStepIds: readonly string[];
  /**
   * Perte de l'appareil pas encore confirmée sur ce lot, ou sans lot désigné sur son incubateur ou son
   * éclosoir (le serveur peut la prendre sur ce lot) : l'éclosion attend.
   */
  readonly pendingLoss: boolean;
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

/**
 * Fermes ayant au moins un incubateur actif, celles du périmètre de l'appareil seulement quand il en
 * compte (les jeux `site` et `location` sont globaux, S-32 ; le périmètre se tire des jeux bornés).
 */
export function incubationFarms(
  refs: Pick<
    SalesReferences,
    | 'sites'
    | 'locations'
    | 'stock'
    | 'purchaseRequests'
    | 'purchaseOrders'
    | 'productionLots'
    | 'incubationBatches'
  >,
  userId: string,
): { readonly id: string; readonly name: string }[] {
  const scope = scopeSiteIds(refs, userId);
  const all = [...refs.sites.values()]
    .filter((site) => site.site_type === 'FERME' && site.status === 'ACTIVE')
    .filter((site) => incubators(refs.locations, site.id).length > 0);
  const scoped = all.filter((site) => scope.has(site.id));
  return (scoped.length > 0 ? scoped : all)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .map((site) => ({ id: site.id, name: site.name }));
}

/**
 * Œufs à couver en stock sur la ferme, hors incubateurs, éclosoirs et lots déjà engagés, nets des
 * opérations de l'appareil en attente sur l'emplacement.
 */
export interface EggSource {
  readonly locationId: string;
  readonly quantity: number;
  /** Lots désignables, quantité bornée par le disponible (l'attente n'est pas ventilée par lot). */
  readonly lots: readonly {
    readonly lotId: string;
    readonly lotCode: string;
    readonly quantity: number;
    /**
     * Prudente : moins aussi les sorties en attente sans lot désigné, que le serveur peut prendre sur
     * ce lot s'il est le plus ancien (avertissement seulement).
     */
    readonly cautious: number;
  }[];
  /**
   * « Le plus ancien d'abord » admis : faux quand le solde contient des œufs d'un lot engagé, que le
   * choix du serveur pourrait retenir (il refuserait alors le démarrage, même hors ligne).
   */
  readonly fifo: boolean;
}

export function eggSources(
  refs: Pick<
    SalesReferences,
    | 'stock'
    | 'locations'
    | 'productionLots'
    | 'incubationBatches'
    | 'pending'
    | 'pendingOut'
    | 'pendingLots'
  >,
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
    const onLot = (lotId: string) =>
      refs.pendingLots.get(lotStockKey(balance.location_id, eggProductId, lotId)) ?? 0;
    const lots = (balance.lots ?? [])
      .filter((lot) => lot.lot_id !== null && !engaged.has(lot.lot_id))
      .map((lot) => ({
        lotId: lot.lot_id as string,
        lotCode: lot.lot_code ?? '',
        quantity: Math.round((Number(lot.qty_on_hand) - onLot(lot.lot_id as string)) * 1000) / 1000,
      }))
      .filter((lot) => lot.quantity > 0);
    const engagedQty = (balance.lots ?? [])
      .filter((lot) => lot.lot_id !== null && engaged.has(lot.lot_id))
      .reduce((sum, lot) => sum + Number(lot.qty_on_hand), 0);
    // L'attente des lots engagés est déjà dans leur solde, retiré ci-dessus.
    const pending =
      (refs.pending.get(stockKey(balance.location_id, eggProductId)) ?? 0) -
      pendingOnLots(refs.pendingLots, balance.location_id, eggProductId, (lotId) =>
        engaged.has(lotId),
      );
    const quantity = Math.round((Number(balance.qty_on_hand) - engagedQty - pending) * 1000) / 1000;
    if (quantity <= 0) continue;
    const fifo = engagedQty <= 0;
    if (!fifo && lots.length === 0) continue;
    sources.push({
      locationId: balance.location_id,
      quantity,
      lots: lots.map((lot) => {
        const lotQuantity = Math.min(lot.quantity, quantity);
        // Au pire, les sorties sans lot désigné tombent toutes sur ce lot ; `quantity` en est déjà
        // net : elles ne se retranchent qu'une fois.
        const unlotted = pendingWithoutLot(refs, balance.location_id, eggProductId);
        return {
          ...lot,
          quantity: lotQuantity,
          cautious: Math.max(
            0,
            Math.round(Math.min(lot.quantity - unlotted, quantity) * 1000) / 1000,
          ),
        };
      }),
      fifo,
    });
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

/**
 * Lots d'incubation de l'appareil avec leurs compteurs corrigés des étapes en attente ; les lots
 * démarrés sur l'appareil et pas encore retéléchargés sont ceux de l'utilisateur (pas ceux d'un autre
 * utilisateur d'une tablette partagée).
 */
export function batchViews(
  refs: Pick<
    SalesReferences,
    'incubationBatches' | 'outbox' | 'productionPulledAt' | 'locations' | 'stock' | 'stockPulledAt'
  >,
  authorUserId: string,
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
      checkCounters: counterOf(batch),
      stockGap: 0,
      stockStale: false,
      allLost: false,
      otherAuthorWaiting: false,
      pendingSteps: 0,
      startCommandId: null,
      waitingStepIds: [],
      pendingLoss: false,
    });
  }
  const inFlight = refs.outbox.filter(
    (command) =>
      command.command_type.startsWith('production.incubation.') &&
      stillInFlight(command, refs.productionPulledAt),
  );
  for (const command of inFlight) {
    if (command.command_type !== 'production.incubation.start') continue;
    if (command.author_user_id !== authorUserId) continue;
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
      checkCounters: {
        eggsSet: payload.eggsSet,
        infertile: 0,
        earlyDead: 0,
        accidentalLoss: 0,
        unhatched: 0,
        hatchedViable: 0,
        hatchedNonviable: 0,
      },
      stockGap: 0,
      stockStale: false,
      allLost: false,
      otherAuthorWaiting: false,
      pendingSteps: 0,
      startCommandId: isAccepted(command) ? null : command.command_id,
      waitingStepIds: [],
      pendingLoss: false,
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
    // Une étape ne dépend que des étapes de son auteur : celles d'un autre utilisateur ne partent
    // qu'à sa reconnexion (ADR-037 §13) ; elles suspendent l'éclosion sur l'écran.
    const own = command.author_user_id === authorUserId;
    views.set(view.id, {
      ...next,
      checkCounters: next.counters,
      pendingSteps: view.pendingSteps + 1,
      waitingStepIds:
        isWaiting(command) && own
          ? [...view.waitingStepIds, command.command_id]
          : view.waitingStepIds,
      otherAuthorWaiting: view.otherAuthorWaiting || (isWaiting(command) && !own),
    });
  }
  // Restant borné par le solde réel du lot de stock (incubateur et éclosoir), net des mirages et
  // pertes pas encore dans le stock téléchargé : une perte accidentelle sur le lot n'est pas
  // reportée dans le jeu `production` (S-38), le serveur la compte (bilan de l'éclosion).
  const stockLots = new Map(refs.incubationBatches.map((batch) => [batch.id, batch.stock_lot_id]));
  const open = [...views.values()].filter(
    (view) => view.status === 'INCUBATING' || view.status === 'IN_HATCHER',
  );
  // Lots d'incubation ouverts par emplacement et produit d'œuf (perte sans lot désigné).
  const sharing = new Map<string, number>();
  for (const view of open) {
    for (const locationId of new Set(
      [view.incubatorLocationId, view.hatcherLocationId].filter((id): id is string => !!id),
    )) {
      const key = stockKey(locationId, view.eggProductId);
      sharing.set(key, (sharing.get(key) ?? 0) + 1);
    }
  }
  for (const view of open) {
    const lotId = stockLots.get(view.id);
    if (!lotId) continue;
    // Stock réel du lot, sur tout emplacement téléchargé (un transfert fait ailleurs a pu le déplacer
    // avant que le jeu `production` ne le dise).
    let known = false;
    let physical = 0;
    let chicksSeen = false;
    for (const balance of refs.stock.values()) {
      if (
        balance.product_id === view.chickProductId &&
        balance.lots?.some((lot) => lot.lot_id === lotId)
      ) {
        chicksSeen = true;
      }
      if (balance.product_id !== view.eggProductId) continue;
      const entry = balance.lots?.find((lot) => lot.lot_id === lotId);
      if (entry) {
        known = true;
        physical += Number(entry.qty_on_hand);
      }
    }
    const places = new Set(
      [view.incubatorLocationId, view.hatcherLocationId].filter((id): id is string => !!id),
    );
    let candled = 0;
    let lost = 0;
    let unlottedLoss = false;
    for (const command of refs.outbox) {
      if (!stillInFlight(command, refs.stockPulledAt)) continue;
      const payload = command.payload as StepPayload & {
        readonly lotId?: string;
        readonly locationId?: string;
        readonly productId?: string;
        readonly quantityBase?: number;
      };
      if (
        command.command_type === 'production.incubation.record_candling' &&
        payload.batchId === view.id
      ) {
        candled += (payload.infertile ?? 0) + (payload.earlyDead ?? 0);
      } else if (command.command_type === 'inventory.loss.declare') {
        if (payload.lotId === lotId) {
          lost += payload.quantityBase ?? 0;
        } else if (
          !payload.lotId &&
          payload.productId === view.eggProductId &&
          payload.locationId !== undefined &&
          places.has(payload.locationId)
        ) {
          // Sans lot désigné : le serveur peut la prendre sur ce lot ; retranchée s'il est seul.
          unlottedLoss = true;
          if (sharing.get(stockKey(payload.locationId, view.eggProductId)) === 1) {
            lost += payload.quantityBase ?? 0;
          }
        }
      }
    }
    const remaining = eggsRemaining(view.counters);
    const physicalRemaining = physical - candled - lost;
    const gap = known && physicalRemaining < remaining ? remaining - physicalRemaining : 0;
    // Restant du jeu, ou pertes déjà reportées au jeu (un transfert ou un mirage après la perte les
    // y fige, le restant tombe alors à zéro).
    const empty = known && physical <= 0 && (remaining > 0 || view.counters.accidentalLoss > 0);
    // Stock du lot vide sans poussins ni perte en attente : perte totale ; sinon éclosion faite
    // ailleurs, à resynchroniser.
    const allLost = empty && !chicksSeen && lost === 0 && !unlottedLoss;
    views.set(view.id, {
      ...view,
      checkCounters: {
        ...view.counters,
        accidentalLoss: view.counters.accidentalLoss + gap,
      },
      stockGap: gap,
      stockStale: empty && !allLost,
      allLost,
      pendingLoss: lost > 0 || unlottedLoss,
    });
  }
  return [...views.values()].sort((a, b) => (a.batchCode ?? '~').localeCompare(b.batchCode ?? '~'));
}

/** Bilan d'un mirage ou d'une éclosion refusé par le domaine : œufs comptés et œufs restants. */
export interface StepIssue {
  readonly counted: number;
  readonly remaining: number;
}

/** Contrôle d'une étape par le domaine (`INCUBATION_BALANCE_INVALID`) ; `null` si admise. */
function stepIssue(check: () => void, counted: number, batch: BatchView): StepIssue | null {
  try {
    check();
    return null;
  } catch (error) {
    if (error instanceof DomainError) {
      return { counted, remaining: eggsRemaining(batch.checkCounters) };
    }
    throw error;
  }
}

export const candlingError = (
  batch: BatchView,
  candling: { readonly infertile: number; readonly earlyDead: number },
) =>
  stepIssue(
    () => checkCandling(batch.checkCounters, candling),
    candling.infertile + candling.earlyDead,
    batch,
  );

export const hatchError = (
  batch: BatchView,
  hatch: {
    readonly unhatched: number;
    readonly hatchedViable: number;
    readonly hatchedNonviable: number;
  },
) =>
  stepIssue(
    () => checkHatch(batch.checkCounters, hatch),
    hatch.unhatched + hatch.hatchedViable + hatch.hatchedNonviable,
    batch,
  );

/** Espèce saisie librement : code en majuscules, comme les clés des durées (`POULE`). */
export const normalizeSpecies = (value: string): string => value.trim().toUpperCase();

export { eggsRemaining, hatchRates };

/** Nombre entier ≥ 0 saisi (vide : 0) ; `null` si invalide. */
export function parseEggCount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  if (normalized === '') return 0;
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= 1_000_000_000 ? value : null;
}

export const stepDependsOn = (batch: BatchView): string[] => [
  ...(batch.startCommandId ? [batch.startCommandId] : []),
  ...batch.waitingStepIds,
];
