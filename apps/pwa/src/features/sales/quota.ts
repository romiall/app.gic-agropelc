/**
 * Quota d'appareil de l'utilisateur (ADR-033, BR-STK-013, AT-003) : sur un emplacement partagé, la
 * vente hors ligne n'est possible que dans le reste du quota du couple (utilisateur, appareil) ; le
 * stock libre ne s'y ajoute pas (seul le serveur le connaît). Le quota se lit dans le jeu
 * `allocations` (servi au seul appareil détenteur, de tous ses utilisateurs, AV-194).
 */
import { isAllocationExpired, type LocalConsumptionBlock } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { isAccepted, isWaiting, stillInFlight } from './pending.js';
import type { SalesReferences } from './references.js';
import {
  localAvailable,
  offlineSaleDecision,
  pendingConsumption,
  settingValue,
  stockKey,
} from './stock.js';
import type {
  AllocationData,
  LocationData,
  ProductionLotData,
  StockTransferData,
} from './types.js';

/**
 * Commandes dont le mouvement consomme un quota au serveur : types `SALE`, `LOSS`, `LOSS_PENDING`,
 * `TRANSFER_DISPATCH` et `CONSUMPTION` passés avec `consumesAllocation` (`record-move.ts`). La
 * confirmation d'une commande, la livraison, le mouvement interne, le démarrage d'incubation et la
 * mise en place n'en consomment pas (BR-STK-013, ADR-033 §7).
 */
const QUOTA_COMMANDS: ReadonlySet<string> = new Set([
  'sales.sale.record',
  'inventory.loss.declare',
  'inventory.consumption.record',
  'inventory.transfer.dispatch',
  'production.input.record',
  'production.mortality.record',
]);

/**
 * Indice local posé sur une annulation jugée directe à la saisie (vendeur, délai) : tant qu'elle
 * attend sa réponse, le serveur rendra la quantité de la vente au quota encore actif (ADR-033 §8).
 * Transformée en demande, la vente reste décomptée jusqu'au tirage des quotas.
 */
export const EXPECTED_DIRECT_CANCEL = 'EXPECTED_DIRECT_CANCEL';

/**
 * Effet en attente d'une opération de l'appareil sur le quota de son auteur, pour un emplacement ×
 * produit : sortie (quantité positive) ou quantité rendue par une annulation directe (négative). La
 * date du fait décide, comme au serveur, si le quota la prend : un fait postérieur à l'échéance est
 * pris sur le stock commun (`isAllocationExpired`, AV-161).
 */
export interface QuotaPendingEntry {
  readonly occurredAt: string;
  readonly quantity: number;
}

/**
 * Annulation jugée directe à la saisie dont l'effet sur le quota n'est pas encore dans le jeu
 * `allocations` : en attente, ou acceptée sans avertissement (le serveur l'a appliquée, ADR-033 §8)
 * et pas encore ramenée par le tirage. Acceptée avec un avertissement, elle est devenue une demande
 * (`CANCEL_WINDOW_EXCEEDED`, `CANCEL_SESSION_CLOSED`) : la vente reste décomptée (DÉDUIT de
 * `cancel-commands.ts`).
 */
function directCancelInFlight(
  command: OutboxCommand,
  allocationsPulledAt: string | undefined,
): boolean {
  if (command.command_type !== 'sales.sale.cancel') return false;
  if (command.local_flags?.includes(EXPECTED_DIRECT_CANCEL) !== true) return false;
  if (isWaiting(command)) return true;
  return (
    isAccepted(command) &&
    (command.warnings ?? []).length === 0 &&
    stillInFlight(command, allocationsPulledAt)
  );
}

/**
 * Effets en attente sur les quotas, par auteur puis par emplacement × produit, comptés jusqu'au tirage
 * du jeu `allocations` qui les inclut (ADR-037 §3) : le quota appartient au couple (utilisateur,
 * appareil), seules les opérations de son détenteur le modifient. Une vente que son auteur annule
 * directement ne le réduit plus ; déjà ramenée par le tirage, la quantité vendue lui est rendue
 * (ADR-033 §8 : le serveur la rend au quota encore actif que la vente avait consommé).
 */
export function quotaPendingByAuthor(
  outbox: readonly OutboxCommand[],
  allocationsPulledAt: string | undefined,
  transfers: ReadonlyMap<string, StockTransferData>,
  productionLots: ReadonlyMap<string, ProductionLotData>,
  receiptLocations: ReadonlyMap<string, string>,
): ReadonlyMap<string, ReadonlyMap<string, readonly QuotaPendingEntry[]>> {
  const entries = new Map<string, Map<string, QuotaPendingEntry[]>>();
  const add = (author: string, key: string, entry: QuotaPendingEntry) => {
    const byKey = entries.get(author) ?? new Map<string, QuotaPendingEntry[]>();
    entries.set(author, byKey);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  };
  const cancelledDirect = new Set(
    outbox
      .filter((command) => directCancelInFlight(command, allocationsPulledAt))
      .map((command) => (command.payload as { readonly saleId?: string }).saleId)
      .filter((saleId): saleId is string => typeof saleId === 'string'),
  );
  for (const command of outbox) {
    if (!QUOTA_COMMANDS.has(command.command_type)) continue;
    const sale = command.command_type === 'sales.sale.record';
    if (sale && cancelledDirect.has(command.aggregate_id)) {
      // Vente ramenée par le tirage, puis annulée directement : le serveur rend au quota ce qu'elle
      // y avait pris. Vente encore en vol : écartée (prise puis rendue au serveur).
      if (isAccepted(command) && !stillInFlight(command, allocationsPulledAt)) {
        const payload = command.payload as {
          readonly fromLocationId?: string;
          readonly lines?: readonly {
            readonly productId?: string;
            readonly quantityBase?: number;
          }[];
        };
        for (const line of payload.lines ?? []) {
          if (!payload.fromLocationId || !line.productId || !line.quantityBase) continue;
          add(command.author_user_id, stockKey(payload.fromLocationId, line.productId), {
            occurredAt: command.occurred_at,
            quantity: -line.quantityBase,
          });
        }
      }
      continue;
    }
    if (!stillInFlight(command, allocationsPulledAt)) continue;
    const exits = pendingConsumption(
      [command],
      allocationsPulledAt,
      transfers,
      productionLots,
      receiptLocations,
      true,
    );
    for (const [key, quantity] of exits) {
      if (quantity > 0) {
        add(command.author_user_id, key, { occurredAt: command.occurred_at, quantity });
      }
    }
  }
  return entries;
}

/**
 * Reste d'un quota net des effets en attente de son détenteur sur (emplacement, produit) : seuls
 * comptent les faits antérieurs à son échéance (au serveur, un fait postérieur ne consomme pas un
 * quota échu, `allocation-consumption.ts`). Une quantité rendue par une annulation directe ne le
 * porte jamais au-delà de l'accordé : l'appareil ignore la part de la vente prise sur le stock libre.
 */
export function quotaRemaining(
  allocation: Pick<AllocationData, 'quantity_granted' | 'quantity_remaining' | 'valid_until'>,
  entries: readonly QuotaPendingEntry[] | undefined,
): number {
  const validUntil = allocation.valid_until ? new Date(allocation.valid_until) : null;
  let exitsMilli = 0;
  let returnedMilli = 0;
  for (const entry of entries ?? []) {
    if (isAllocationExpired(validUntil, new Date(entry.occurredAt))) continue;
    const milli = Math.round(entry.quantity * 1000);
    if (milli > 0) exitsMilli += milli;
    else returnedMilli -= milli;
  }
  const servedMilli = Math.round(Number(allocation.quantity_remaining) * 1000);
  const consumedMilli = Math.max(
    0,
    Math.round(Number(allocation.quantity_granted) * 1000) - servedMilli,
  );
  return (servedMilli + Math.min(returnedMilli, consumedMilli) - exitsMilli) / 1000;
}

export interface DeviceQuota {
  readonly allocation: AllocationData;
  /**
   * Reste du quota net des effets de l'utilisateur encore en attente sur (emplacement, produit),
   * comptés jusqu'au tirage du jeu `allocations` qui les inclut (ADR-037 §3, `quotaRemaining`).
   */
  readonly remaining: number;
  readonly validUntil: Date | null;
}

/**
 * Quota utilisable de l'utilisateur sur cet appareil pour (emplacement, produit) : actif, sans signal
 * de révocation (appareil bloqué ou perdu), et dont la libération n'est pas déjà saisie ; `null` sinon.
 * Plusieurs quotas du couple (un par lot indicatif, AV-160) : le plus ancien, comme le serveur qui
 * prend le premier quota actif du couple (DÉDUIT de `loadConsumerAllocations`).
 */
export function deviceQuota(
  refs: Pick<SalesReferences, 'allocations' | 'outbox' | 'quotaPending'>,
  input: {
    readonly userId: string | undefined;
    readonly deviceId: string | undefined;
    readonly locationId: string;
    readonly productId: string;
  },
): DeviceQuota | null {
  if (!input.userId || !input.deviceId) return null;
  // Libération saisie (en attente ou acceptée, pas encore sortie du jeu) : le quota n'est plus tenu.
  const released = new Set(
    refs.outbox
      .filter(
        (command) =>
          command.command_type === 'inventory.allocation.release' && command.status !== 'REJECTED',
      )
      .map((command) => command.aggregate_id),
  );
  const allocation = refs.allocations
    .filter(
      (candidate) =>
        candidate.status === 'ACTIVE' &&
        !candidate.revocation_pending &&
        candidate.holder_user_id === input.userId &&
        candidate.holder_device_id === input.deviceId &&
        candidate.location_id === input.locationId &&
        candidate.product_id === input.productId &&
        !released.has(candidate.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!allocation) return null;
  return {
    allocation,
    remaining: quotaRemaining(
      allocation,
      refs.quotaPending.get(input.userId)?.get(stockKey(input.locationId, input.productId)),
    ),
    validUntil: allocation.valid_until ? new Date(allocation.valid_until) : null,
  };
}

/** Nature d'une sortie de stock soumise à la garde hors ligne (le mouvement interne n'en est pas). */
export type ExitKind = 'SALE' | 'LOSS' | 'CONSUMPTION' | 'DISPATCH';

/**
 * AV-303 (défaut) : hors ligne, au-delà du quota du détenteur (emplacement partagé) ou du solde d'un
 * emplacement exclusif, la vente (AV-025), la consommation et l'expédition sont bloquées
 * (BR-STK-013) ; la perte, fait constaté, est seulement signalée (BR-STK-018 : le serveur l'applique
 * et ouvre le conflit), y compris sur un stock confié à un autre appareil. `BLOCK` alignerait la
 * perte sur les autres sorties.
 */
export const OFFLINE_LOSS_GUARD: 'BLOCK' | 'SIGNAL' = 'SIGNAL';

export interface ExitIssue {
  /** Produit concerné (vide pour un emplacement confié à un autre appareil). */
  readonly productId: string;
  readonly code: LocalConsumptionBlock | 'CUSTODY_DEVICE_MISMATCH';
  readonly available: number;
  readonly requested: number;
}

export interface ExitGuard {
  /** Sorties refusées sur l'appareil. */
  readonly blocks: readonly ExitIssue[];
  /** Sorties enregistrées, mais que le serveur signalera. */
  readonly signals: readonly ExitIssue[];
}

/**
 * Garde hors ligne d'une sortie de stock (BR-STK-013, AV-025, AV-303). Emplacement confié à un autre
 * appareil (`EXCLUSIVE_DEVICE`) : refusé (perte signalée) ; les autres gardes d'appareil du serveur
 * (appareil principal du détenteur d'un emplacement `EXCLUSIVE_USER`, appareil rattaché à un autre
 * site) ne sont pas contrôlées, faute de données servies à l'appareil (S-44). Sur un emplacement
 * partagé, le détenteur d'un quota sort dans son reste ; sans quota utilisable (absent ou échu), une
 * vente est refusée (AV-166), une autre sortie suit le contrôle habituel de l'écran : le serveur la
 * prend sur le stock commun (BR-STK-013 ne vise que le détenteur, AV-161). Sur un emplacement
 * exclusif, dans le solde local. Dépassement autorisé par le site
 * (`sales.offline_over_allocation_allowed`) : signalé.
 */
export function offlineExitGuard(
  refs: Pick<
    SalesReferences,
    'allocations' | 'outbox' | 'quotaPending' | 'stock' | 'pending' | 'settings'
  >,
  input: {
    readonly kind: ExitKind;
    readonly location: Pick<
      LocationData,
      'id' | 'site_id' | 'custody_mode' | 'designated_device_id'
    >;
    readonly requested: ReadonlyMap<string, number>;
    readonly userId: string | undefined;
    readonly deviceId: string | undefined;
    readonly now: Date;
  },
): ExitGuard {
  const blocks: ExitIssue[] = [];
  const signals: ExitIssue[] = [];
  const wanted = [...input.requested].filter(([, quantity]) => quantity > 0);
  if (wanted.length === 0) return { blocks, signals };
  const { location } = input;
  const lossSignalled = input.kind === 'LOSS' && OFFLINE_LOSS_GUARD === 'SIGNAL';
  if (
    location.custody_mode === 'EXCLUSIVE_DEVICE' &&
    location.designated_device_id !== input.deviceId
  ) {
    const issue = {
      productId: '',
      code: 'CUSTODY_DEVICE_MISMATCH' as const,
      available: 0,
      requested: 0,
    };
    (lossSignalled ? signals : blocks).push(issue);
    return { blocks, signals };
  }
  const overAllowed =
    settingValue(
      refs.settings,
      'sales.offline_over_allocation_allowed',
      location.site_id,
      input.now,
    ) === true;
  const shared =
    location.custody_mode !== 'EXCLUSIVE_USER' && location.custody_mode !== 'EXCLUSIVE_DEVICE';
  for (const [productId, quantity] of wanted) {
    const quota = shared
      ? deviceQuota(refs, {
          userId: input.userId,
          deviceId: input.deviceId,
          locationId: location.id,
          productId,
        })
      : null;
    if (
      shared &&
      input.kind !== 'SALE' &&
      (quota === null || isAllocationExpired(quota.validUntil, input.now))
    ) {
      continue;
    }
    const key = stockKey(location.id, productId);
    const decision = offlineSaleDecision({
      location,
      requested: quantity,
      available: localAvailable(
        refs.stock.get(key),
        location.custody_mode,
        refs.pending.get(key) ?? 0,
      ),
      quota,
      now: input.now,
      overAllocationAllowed: overAllowed,
    });
    if (!decision.allowed) {
      const issue = {
        productId,
        code: decision.code,
        available: decision.available,
        requested: quantity,
      };
      (lossSignalled ? signals : blocks).push(issue);
    } else if (decision.signalled) {
      signals.push({ productId, code: decision.signalled, available: 0, requested: quantity });
    }
  }
  return { blocks, signals };
}
