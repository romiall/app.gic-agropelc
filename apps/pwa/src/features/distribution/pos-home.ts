/**
 * Accueil du point de vente (ECR-DIS-01 ; WF-J2 ; BR-DIS-002, BR-DIS-003 ; ADR-033). Logique pure :
 * ventes du jour connues de l'appareil sur l'emplacement de vente, quotas de l'utilisateur sur cet
 * appareil (reste net de ses sorties en attente, échéance, révocation, libération saisie) et charge
 * utile de la libération (`inventory.allocation.release`).
 */
import { businessDayOf, isAllocationExpired } from '@gic/domain';
import { quotaRemaining } from '../sales/quota.js';
import type { SaleView } from '../sales/recent-sales.js';
import type { SalesReferences } from '../sales/references.js';
import { stockKey } from '../sales/stock.js';
import type { AllocationData } from '../sales/types.js';

/**
 * AV-308 (défaut) : ventes du jour de l'accueil du PDV, celles que l'appareil connaît (jeu
 * `sales_recent` du site et ventes saisies en attente), sur l'emplacement de vente, au jour métier de
 * Douala, annulées exclues. Le chiffre du serveur (tableau, ECR-DIS-04) inclut les autres téléphones
 * pas encore synchronisés. L'encaissé est celui qui est affecté à ces ventes, quelle que soit sa date :
 * l'acompte reporté sur la vente d'une commande confirmée (AV-033) et un règlement ultérieur y
 * figurent ; le tableau compte l'encaissé au jour du paiement (BR-DIS-010).
 */
export interface TodaySales {
  readonly count: number;
  readonly netXaf: number;
  /** Encaissé affecté à ces ventes, acomptes reportés et règlements ultérieurs compris. */
  readonly paidXaf: number;
  /** Ventes saisies sur l'appareil et pas encore envoyées. */
  readonly pendingCount: number;
}

export function todaySales(
  sales: readonly SaleView[],
  salesLocationId: string,
  now: Date,
): TodaySales {
  const today = businessDayOf(now);
  const kept = sales.filter(
    (sale) =>
      sale.fromLocationId === salesLocationId &&
      sale.status !== 'CANCELLED' &&
      sale.status !== 'REJECTED' &&
      businessDayOf(new Date(sale.occurredAt)) === today,
  );
  return {
    count: kept.length,
    netXaf: kept.reduce((sum, sale) => sum + sale.netTotalXaf, 0),
    paidXaf: kept.reduce((sum, sale) => sum + sale.amountPaidXaf, 0),
    pendingCount: kept.filter((sale) => sale.status === 'PENDING').length,
  };
}

/** Quota de l'utilisateur sur cet appareil, tel que l'accueil le montre. */
export interface MyQuota {
  readonly allocation: AllocationData;
  /**
   * Reste du quota : déclaré par la libération saisie ; sinon net des effets en attente de
   * l'utilisateur pour le quota consommé en premier (AV-160) ; reste servi pour les autres.
   */
  readonly remaining: number;
  readonly validUntil: Date | null;
  readonly expired: boolean;
  /** Appareil signalé bloqué ou perdu : le quota ne se consomme plus (révocation à venir). */
  readonly revocationPending: boolean;
  /** Libération saisie sur l'appareil, pas encore sortie du jeu. */
  readonly releasing: boolean;
}

/**
 * Quotas actifs de l'utilisateur sur cet appareil, par emplacement puis produit. Quota dont la
 * libération est saisie : le reste qu'elle déclare. Sinon, pour le quota que le serveur consomme en
 * premier (le plus ancien actif du couple, signal de révocation compris : `loadConsumerAllocations`
 * ne retient que le statut), le reste net des effets en attente de l'utilisateur (`quotaRemaining`) ;
 * les autres quotas du même couple gardent leur reste servi.
 */
export function myQuotas(
  refs: Pick<SalesReferences, 'allocations' | 'outbox' | 'quotaPending'>,
  input: { readonly userId: string; readonly deviceId: string | undefined; readonly now: Date },
): MyQuota[] {
  if (!input.deviceId) return [];
  // Libération saisie (en attente ou acceptée, pas encore sortie du jeu) : la dernière, par quota.
  const releasing = new Map<string, number>();
  for (const command of [...refs.outbox].sort((a, b) => a.device_seq - b.device_seq)) {
    if (command.command_type !== 'inventory.allocation.release') continue;
    if (command.status === 'REJECTED') continue;
    const declared = Number((command.payload as { readonly remainingBase?: number }).remainingBase);
    releasing.set(command.aggregate_id, Number.isFinite(declared) ? declared : 0);
  }
  const mine = refs.allocations
    .filter(
      (allocation) =>
        allocation.status === 'ACTIVE' &&
        allocation.holder_user_id === input.userId &&
        allocation.holder_device_id === input.deviceId,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const consumedFirst = new Map<string, string>();
  for (const allocation of mine) {
    const key = stockKey(allocation.location_id, allocation.product_id);
    if (!releasing.has(allocation.id) && !consumedFirst.has(key)) {
      consumedFirst.set(key, allocation.id);
    }
  }
  const pending = refs.quotaPending.get(input.userId);
  return mine
    .map((allocation): MyQuota => {
      const key = stockKey(allocation.location_id, allocation.product_id);
      const validUntil = allocation.valid_until ? new Date(allocation.valid_until) : null;
      const declared = releasing.get(allocation.id);
      return {
        allocation,
        remaining:
          declared !== undefined
            ? declared
            : consumedFirst.get(key) === allocation.id
              ? quotaRemaining(allocation, pending?.get(key))
              : Number(allocation.quantity_remaining),
        validUntil,
        expired: isAllocationExpired(validUntil, input.now),
        revocationPending: allocation.revocation_pending,
        releasing: declared !== undefined,
      };
    })
    .sort(
      (a, b) =>
        a.allocation.location_id.localeCompare(b.allocation.location_id) ||
        a.allocation.product_id.localeCompare(b.allocation.product_id) ||
        a.allocation.id.localeCompare(b.allocation.id),
    );
}

/**
 * Libération possible (AV-309, défaut) : quota actif de l'utilisateur, ni déjà libéré sur l'appareil ni
 * frappé d'un signal de révocation (le serveur le révoque, BR-STK-014). Le reste déclaré est celui que
 * l'appareil calcule (BR-STK-013) ; un écart avec le serveur ouvre `ALLOCATION_RELEASE_MISMATCH`.
 */
export function canRelease(quota: MyQuota): boolean {
  return !quota.releasing && !quota.revocationPending;
}

/** Charge utile de `inventory.allocation.release` : reste déclaré, jamais négatif, en millièmes. */
export function releasePayload(quota: Pick<MyQuota, 'remaining'>) {
  return { remainingBase: Math.max(0, Math.round(quota.remaining * 1000) / 1000) };
}
