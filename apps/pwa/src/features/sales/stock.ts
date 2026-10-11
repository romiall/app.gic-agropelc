/**
 * Disponible local et blocage hors ligne de la vente (BR-VEN-018, AV-025 ; ADR-033).
 *
 * Disponible d'un emplacement = solde téléchargé (jeu `stock`) moins ce que l'appareil a déjà vendu
 * ou commandé sans confirmation du serveur (opérations de l'outbox en attente). Hors ligne, la décision
 * est celle de `decideLocalConsumption` (`packages/domain`), identique au miroir du serveur : sur un
 * emplacement à garde exclusive, le stock local suffit ; sur un emplacement partagé, il faut un quota
 * d'appareil. Le jeu `allocations` n'est pas encore servi par le serveur (lecteur prévu en P5-18,
 * besoin S-05) : l'appareil ne détient donc aucun quota et la vente hors ligne sur un emplacement
 * partagé est bloquée, sauf si le site autorise le dépassement (`sales.offline_over_allocation_allowed`).
 * En ligne, l'appareil ne bloque pas : le serveur décide.
 */
import {
  availableOnExclusive,
  availableOnShared,
  decideLocalConsumption,
  type LocalConsumptionDecision,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { isWaiting, stillInFlight } from './pending.js';
import type {
  LocationData,
  ProductionLotData,
  SettingData,
  StockBalanceData,
  StockTransferData,
} from './types.js';

const toMilli = (value: number): number => Math.round(value * 1000);
const fromMilli = (milli: number): number => milli / 1000;

export const stockKey = (locationId: string, productId: string): string =>
  `${locationId}:${productId}`;

interface StockPayloadLike {
  readonly fromLocationId?: string;
  readonly fulfilmentLocationId?: string;
  readonly locationId?: string;
  readonly productId?: string;
  readonly quantityBase?: number;
  readonly lines?: readonly { readonly productId?: string; readonly quantityBase?: number }[];
}

/**
 * Une opération acceptée par le serveur reste décomptée jusqu'à ce qu'un tirage complet du jeu
 * `stock`, commencé après son acceptation, ait ramené le solde qui l'inclut (01-architecture-offline.md
 * §4 : « le delta est retiré quand le pull a ramené l'état serveur qui l'inclut ») ; sinon un envoi
 * réussi suivi d'un tirage interrompu ferait réapparaître la quantité vendue (ADR-051).
 */
function stillPending(command: OutboxCommand, stockPulledAt: string | undefined): boolean {
  return stillInFlight(command, stockPulledAt);
}

/**
 * Quantités (unité de base, par `emplacement:produit`) que les opérations de l'appareil retirent
 * déjà de l'emplacement sans que le serveur l'ait encore confirmé :
 * - une vente directe, sur son emplacement source ;
 * - une commande passée, sur son emplacement de préparation : à sa confirmation, le serveur vend le
 *   disponible et le déplace vers l'emplacement virtuel « à livrer » (ADR-028 §1 et §4). L'appareil
 *   ne sait pas quelle part sera vendue : il compte toute la quantité commandée (choix prudent, qui
 *   peut sous-estimer le disponible jusqu'à la synchronisation, jamais le surestimer).
 * Une livraison ne consomme pas l'emplacement : la marchandise vendue l'a déjà quitté (« à livrer »).
 */
export function pendingConsumption(
  commands: readonly OutboxCommand[],
  stockPulledAt: string | undefined,
  transfers: ReadonlyMap<string, StockTransferData> = new Map(),
  productionLots: ReadonlyMap<string, Pick<ProductionLotData, 'product_id'>> = new Map(),
  /** Emplacement de chaque réception d'achat connue (mise en place depuis une réception). */
  receiptLocations: ReadonlyMap<string, string> = new Map(),
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of commands) {
    if (!stillPending(command, stockPulledAt)) continue;
    const payload = command.payload as StockPayloadLike;
    // Réception d'un transfert sur l'appareil : entrée sur l'emplacement de destination (quantité
    // négative : elle augmente le disponible local jusqu'au retéléchargement du stock).
    if (command.command_type === 'inventory.transfer.receive') {
      const receipt = command.payload as {
        readonly transferId?: string;
        readonly lines?: readonly {
          readonly transferLineId?: string;
          readonly receivedQtyBase?: number;
        }[];
      };
      // Réception sans document : entrée sur la destination déclarée, produit par produit.
      const blind = receipt as {
        readonly toLocationId?: string;
        readonly lines?: readonly {
          readonly productId?: string;
          readonly receivedQtyBase?: number;
        }[];
      };
      if (!receipt.transferId && blind.toLocationId) {
        for (const line of blind.lines ?? []) {
          if (!line.productId || !line.receivedQtyBase) continue;
          const key = stockKey(blind.toLocationId, line.productId);
          milli.set(key, (milli.get(key) ?? 0) - toMilli(line.receivedQtyBase));
        }
        continue;
      }
      const transfer = receipt.transferId ? transfers.get(receipt.transferId) : undefined;
      if (!transfer) continue;
      for (const line of receipt.lines ?? []) {
        const transferLine = transfer.lines.find(
          (candidate) => candidate.id === line.transferLineId,
        );
        if (!transferLine || !line.receivedQtyBase) continue;
        const key = stockKey(transfer.to_location_id, transferLine.product_id);
        milli.set(key, (milli.get(key) ?? 0) - toMilli(line.receivedQtyBase));
      }
      continue;
    }
    // Collecte d'œufs : les commercialisables par calibre entrent sur l'emplacement de stockage.
    if (command.command_type === 'production.egg_collection.record') {
      const collection = command.payload as {
        readonly storageLocationId?: string;
        readonly grades?: readonly { readonly productId?: string; readonly quantity?: number }[];
      };
      if (!collection.storageLocationId) continue;
      for (const grade of collection.grades ?? []) {
        if (!grade.productId || !grade.quantity) continue;
        const key = stockKey(collection.storageLocationId, grade.productId);
        milli.set(key, (milli.get(key) ?? 0) - toMilli(grade.quantity));
      }
      continue;
    }
    // Réception d'achat : la quantité acceptée (livré − rejeté) entre sur l'emplacement, sauf une
    // réception que le serveur met en quarantaine (aucun effet de stock avant décision, INV-APP-03) :
    // annoncée à la saisie hors ligne (dépassement, mode `QUARANTINE`) ou renvoyée par le serveur.
    if (command.command_type === 'procurement.receipt.record') {
      // La réponse du serveur fait foi une fois reçue : l'indice local ne vaut que pendant l'attente.
      if (
        (isWaiting(command) && command.local_flags?.includes('EXPECTED_QUARANTINE')) ||
        command.warnings?.includes('RECEIPT_QUARANTINED')
      ) {
        continue;
      }
      const receipt = command.payload as {
        readonly locationId?: string;
        readonly lines?: readonly {
          readonly productId?: string;
          readonly qtyDeliveredBase?: number;
          readonly qtyRejectedBase?: number;
        }[];
      };
      if (!receipt.locationId) continue;
      for (const line of receipt.lines ?? []) {
        if (!line.productId || !line.qtyDeliveredBase) continue;
        const accepted = toMilli(line.qtyDeliveredBase) - toMilli(line.qtyRejectedBase ?? 0);
        if (accepted <= 0) continue;
        const key = stockKey(receipt.locationId, line.productId);
        milli.set(key, (milli.get(key) ?? 0) - accepted);
      }
      continue;
    }
    // Mortalité saisie sur l'appareil : les têtes mortes quittent le bâtiment (produit du lot).
    // Les œufs à couver d'une collecte n'entrent pas ici (sous-estimation seulement).
    if (command.command_type === 'production.mortality.record') {
      const death = command.payload as {
        readonly productionLotId?: string;
        readonly locationId?: string;
        readonly quantity?: number;
      };
      const lot = death.productionLotId ? productionLots.get(death.productionLotId) : undefined;
      if (lot && death.locationId && death.quantity) {
        const key = stockKey(death.locationId, lot.product_id);
        milli.set(key, (milli.get(key) ?? 0) + toMilli(death.quantity));
      }
      continue;
    }
    // Démarrage d'une incubation (ECR-PRD-06) : les œufs à couver quittent leur emplacement de
    // stockage ; leur entrée dans l'incubateur n'est pas créditée ici.
    if (command.command_type === 'production.incubation.start') {
      const start = command.payload as {
        readonly sourceLocationId?: string;
        readonly eggProductId?: string;
        readonly eggsSet?: number;
      };
      if (start.sourceLocationId && start.eggProductId && start.eggsSet) {
        const key = stockKey(start.sourceLocationId, start.eggProductId);
        milli.set(key, (milli.get(key) ?? 0) + toMilli(start.eggsSet));
      }
      continue;
    }
    // Entrée dans un lot de production (ECR-PRD-04) : les animaux quittent leur emplacement d'origine
    // (stock, réception d'achat, autre lot) ; leur arrivée dans l'élevage n'est pas créditée ici.
    if (command.command_type === 'production.lot.record_entry') {
      const entry = command.payload as {
        readonly sourceKind?: string;
        readonly quantity?: number;
        readonly sourceLocationId?: string;
        readonly sourceProductId?: string;
        readonly goodsReceiptId?: string;
        readonly sourceProductionLotId?: string;
      };
      if (!entry.quantity) continue;
      let source: { locationId: string; productId: string } | null = null;
      if (
        entry.sourceKind === 'INTERNAL_STOCK' &&
        entry.sourceLocationId &&
        entry.sourceProductId
      ) {
        source = { locationId: entry.sourceLocationId, productId: entry.sourceProductId };
      } else if (entry.sourceKind === 'PURCHASE' && entry.goodsReceiptId && entry.sourceProductId) {
        const locationId = receiptLocations.get(entry.goodsReceiptId);
        if (locationId) source = { locationId, productId: entry.sourceProductId };
      } else if (
        (entry.sourceKind === 'TRANSFER' || entry.sourceKind === 'WEANING') &&
        entry.sourceLocationId &&
        entry.sourceProductionLotId
      ) {
        const lot = productionLots.get(entry.sourceProductionLotId);
        if (lot) source = { locationId: entry.sourceLocationId, productId: lot.product_id };
      }
      if (source) {
        const key = stockKey(source.locationId, source.productId);
        milli.set(key, (milli.get(key) ?? 0) + toMilli(entry.quantity));
      }
      continue;
    }
    // Perte déclarée sur l'appareil : sortie de l'emplacement (mise de côté si elle part en validation).
    // Consommation d'intrant : sortie de l'emplacement vers la consommation.
    if (
      command.command_type === 'inventory.loss.declare' ||
      command.command_type === 'inventory.consumption.record' ||
      command.command_type === 'production.input.record'
    ) {
      if (payload.locationId && payload.productId && payload.quantityBase) {
        const key = stockKey(payload.locationId, payload.productId);
        milli.set(key, (milli.get(key) ?? 0) + toMilli(payload.quantityBase));
      }
      continue;
    }
    // Mouvement interne : sortie de la source et entrée sur la destination (transfert aussitôt
    // terminé au serveur, sans transit).
    if (command.command_type === 'inventory.transfer.move_internal') {
      const move = command.payload as StockPayloadLike & { readonly toLocationId?: string };
      if (!move.fromLocationId || !move.toLocationId) continue;
      for (const line of move.lines ?? []) {
        if (!line.productId || !line.quantityBase) continue;
        const from = stockKey(move.fromLocationId, line.productId);
        const to = stockKey(move.toLocationId, line.productId);
        milli.set(from, (milli.get(from) ?? 0) + toMilli(line.quantityBase));
        milli.set(to, (milli.get(to) ?? 0) - toMilli(line.quantityBase));
      }
      continue;
    }
    // Expédition saisie sur l'appareil : sortie de la source (directe, ou celle de la demande).
    const dispatchSource =
      command.command_type === 'inventory.transfer.dispatch'
        ? (payload.fromLocationId ??
          transfers.get((command.payload as { transferId?: string }).transferId ?? '')
            ?.from_location_id)
        : undefined;
    const locationId =
      command.command_type === 'sales.sale.record'
        ? payload.fromLocationId
        : command.command_type === 'sales.order.place'
          ? payload.fulfilmentLocationId
          : dispatchSource;
    if (!locationId) continue;
    for (const line of payload.lines ?? []) {
      if (!line.productId || !line.quantityBase) continue;
      const key = stockKey(locationId, line.productId);
      milli.set(key, (milli.get(key) ?? 0) + toMilli(line.quantityBase));
    }
  }
  return new Map([...milli].map(([key, value]) => [key, fromMilli(value)]));
}

/** Disponible pour cet appareil sur l'emplacement, en unité de base (peut être négatif). */
export function localAvailable(
  balance: StockBalanceData | undefined,
  custodyMode: LocationData['custody_mode'],
  pending: number,
): number {
  // Sans solde téléchargé : seulement les opérations de l'appareil (une réception en attente ajoute).
  if (!balance) return fromMilli(-toMilli(pending)) || 0;
  const onHand = Number(balance.qty_on_hand);
  const reserved = Number(balance.qty_reserved);
  const allocated = Number(balance.qty_allocated);
  // Aucun quota d'appareil connu tant que le jeu `allocations` n'est pas servi (P5-18).
  const available =
    custodyMode === 'SHARED' || custodyMode === null
      ? availableOnShared(onHand, reserved, allocated, 0)
      : availableOnExclusive(onHand, reserved);
  return fromMilli(toMilli(available) - toMilli(pending)) || 0;
}

/**
 * Solde physique de l'emplacement diminué des opérations de l'appareil en attente : ce que le serveur
 * contrôle à coup sûr (`INSUFFICIENT_STOCK`) pour une perte ou une expédition. Le reste du quota propre
 * de l'appareil n'est pas connu (jeu `allocations`, S-05) : il ne sert pas à bloquer.
 */
export function physicalLeft(balance: StockBalanceData | undefined, pending: number): number {
  const onHand = balance ? Number(balance.qty_on_hand) : 0;
  return fromMilli(toMilli(onHand) - toMilli(pending)) || 0;
}

/** Valeur d'un paramètre visible du client : réglage du site, à défaut global, le plus récent. */
export function settingValue(
  settings: readonly SettingData[],
  key: string,
  siteId: string | null | undefined,
  now: Date,
): unknown {
  const effective = settings
    .filter((setting) => setting.key === key && new Date(setting.valid_from) <= now)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  const site = effective.find(
    (setting) => setting.scope_type === 'SITE' && siteId && setting.scope_id === siteId,
  );
  return (site ?? effective.find((setting) => setting.scope_type === 'GLOBAL'))?.value;
}

/** Décision locale pour une vente hors ligne de `requested` (unité de base) sur l'emplacement. */
export function offlineSaleDecision(input: {
  readonly location: Pick<LocationData, 'custody_mode'>;
  readonly requested: number;
  readonly available: number;
  readonly now: Date;
  readonly overAllocationAllowed: boolean;
}): LocalConsumptionDecision {
  return decideLocalConsumption({
    // Emplacement sans mode de garde renseigné : traité comme partagé (le plus prudent).
    custodyMode: input.location.custody_mode ?? 'SHARED',
    requested: input.requested,
    localBalance: Math.max(0, input.available),
    holdsQuota: false,
    quotaRemaining: 0,
    quotaValidUntil: null,
    now: input.now,
    overAllocationAllowed: input.overAllocationAllowed,
  });
}
