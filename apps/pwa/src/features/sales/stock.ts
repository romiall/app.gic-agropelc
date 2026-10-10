/**
 * Disponible local et blocage hors ligne de la vente (BR-VEN-018, AV-025 ; ADR-033).
 *
 * Disponible d'un emplacement = solde téléchargé (jeu `stock`) moins ce que l'appareil a déjà vendu
 * ou livré sans confirmation du serveur (commandes de l'outbox en attente). Hors ligne, la décision
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
import type { LocationData, SalesOrderData, SettingData, StockBalanceData } from './types.js';

const WAITING_STATUSES: ReadonlySet<string> = new Set(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']);

const toMilli = (value: number): number => Math.round(value * 1000);
const fromMilli = (milli: number): number => milli / 1000;

export const stockKey = (locationId: string, productId: string): string =>
  `${locationId}:${productId}`;

interface SalePayloadLike {
  readonly fromLocationId?: string;
  readonly lines?: readonly { readonly productId?: string; readonly quantityBase?: number }[];
}

interface FulfilPayloadLike {
  readonly orderId?: string;
  readonly lines?: readonly { readonly orderLineId?: string; readonly quantityBase?: number }[];
}

/**
 * Quantités (unité de base, par `emplacement:produit`) que les ventes et livraisons de l'appareil
 * retirent déjà du stock sans que le serveur l'ait encore confirmé.
 */
export function pendingConsumption(
  commands: readonly OutboxCommand[],
  orders: ReadonlyMap<string, SalesOrderData>,
): Map<string, number> {
  const milli = new Map<string, number>();
  const add = (locationId: string, productId: string, quantity: number) => {
    const key = stockKey(locationId, productId);
    milli.set(key, (milli.get(key) ?? 0) + toMilli(quantity));
  };
  for (const command of commands) {
    if (!WAITING_STATUSES.has(command.status)) continue;
    if (command.command_type === 'sales.sale.record') {
      const payload = command.payload as SalePayloadLike;
      for (const line of payload.lines ?? []) {
        if (payload.fromLocationId && line.productId && line.quantityBase) {
          add(payload.fromLocationId, line.productId, line.quantityBase);
        }
      }
    } else if (command.command_type === 'sales.order.fulfil') {
      const payload = command.payload as FulfilPayloadLike;
      const order = payload.orderId ? orders.get(payload.orderId) : undefined;
      if (!order) continue;
      for (const line of payload.lines ?? []) {
        const orderLine = order.lines.find((candidate) => candidate.id === line.orderLineId);
        if (orderLine && line.quantityBase) {
          add(order.fulfilment_location_id, orderLine.product_id, line.quantityBase);
        }
      }
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
  if (!balance) return fromMilli(-toMilli(pending));
  const onHand = Number(balance.qty_on_hand);
  const reserved = Number(balance.qty_reserved);
  const allocated = Number(balance.qty_allocated);
  // Aucun quota d'appareil connu tant que le jeu `allocations` n'est pas servi (P5-18).
  const available =
    custodyMode === 'SHARED' || custodyMode === null
      ? availableOnShared(onHand, reserved, allocated, 0)
      : availableOnExclusive(onHand, reserved);
  return fromMilli(toMilli(available) - toMilli(pending));
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
