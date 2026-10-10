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
import type { LocationData, SettingData, StockBalanceData } from './types.js';

const WAITING_STATUSES: ReadonlySet<string> = new Set(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']);

const toMilli = (value: number): number => Math.round(value * 1000);
const fromMilli = (milli: number): number => milli / 1000;

export const stockKey = (locationId: string, productId: string): string =>
  `${locationId}:${productId}`;

interface StockPayloadLike {
  readonly fromLocationId?: string;
  readonly fulfilmentLocationId?: string;
  readonly lines?: readonly { readonly productId?: string; readonly quantityBase?: number }[];
}

/**
 * Une opération acceptée par le serveur reste décomptée jusqu'à ce qu'un tirage complet du jeu
 * `stock`, commencé après son acceptation, ait ramené le solde qui l'inclut (01-architecture-offline.md
 * §4 : « le delta est retiré quand le pull a ramené l'état serveur qui l'inclut ») ; sinon un envoi
 * réussi suivi d'un tirage interrompu ferait réapparaître la quantité vendue (ADR-051).
 */
function stillPending(command: OutboxCommand, stockPulledAt: string | undefined): boolean {
  if (WAITING_STATUSES.has(command.status)) return true;
  if (command.status !== 'SYNCED' && command.status !== 'SYNCED_WITH_WARNING') return false;
  if (!command.synced_at) return false;
  return stockPulledAt === undefined || stockPulledAt < command.synced_at;
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
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of commands) {
    if (!stillPending(command, stockPulledAt)) continue;
    const payload = command.payload as StockPayloadLike;
    const locationId =
      command.command_type === 'sales.sale.record'
        ? payload.fromLocationId
        : command.command_type === 'sales.order.place'
          ? payload.fulfilmentLocationId
          : undefined;
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
  if (!balance) return pending > 0 ? fromMilli(-toMilli(pending)) : 0;
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
