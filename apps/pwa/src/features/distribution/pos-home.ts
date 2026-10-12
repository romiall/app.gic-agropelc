/**
 * Accueil du point de vente (ECR-DIS-01 ; WF-J2 ; BR-DIS-002, BR-DIS-003 ; ADR-033). Logique pure :
 * ventes du jour connues de l'appareil sur l'emplacement de vente, quotas de l'utilisateur sur cet
 * appareil (reste net de ses sorties en attente, échéance, révocation, libération saisie) et charge
 * utile de la libération (`inventory.allocation.release`).
 */
import { businessDayOf, isAllocationExpired } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { deviceQuota } from '../sales/quota.js';
import type { SaleView } from '../sales/recent-sales.js';
import type { SalesReferences } from '../sales/references.js';
import type { AllocationData } from '../sales/types.js';

/**
 * AV-308 (défaut) : ventes du jour de l'accueil du PDV, celles que l'appareil connaît (jeu
 * `sales_recent` du site et ventes saisies en attente), sur l'emplacement de vente, au jour métier de
 * Douala, annulées exclues. Le chiffre du serveur (tableau, ECR-DIS-04) inclut les autres téléphones
 * pas encore synchronisés.
 */
export interface TodaySales {
  readonly count: number;
  readonly netXaf: number;
  /** Encaissé avec ces ventes (hors encaissements de créances et acomptes). */
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
  /** Reste net des sorties en attente de l'utilisateur (le quota consommé en premier, AV-160). */
  readonly remaining: number;
  readonly validUntil: Date | null;
  readonly expired: boolean;
  /** Appareil signalé bloqué ou perdu : le quota ne se consomme plus (révocation à venir). */
  readonly revocationPending: boolean;
  /** Libération saisie sur l'appareil, pas encore sortie du jeu. */
  readonly releasing: boolean;
}

/**
 * Quotas actifs de l'utilisateur sur cet appareil, par emplacement puis produit. Le reste d'un quota
 * est celui de `deviceQuota` pour le quota que le serveur consomme en premier (le plus ancien du
 * couple) ; les autres quotas du même couple gardent leur reste servi.
 */
export function myQuotas(
  refs: Pick<SalesReferences, 'allocations' | 'outbox' | 'quotaPending'>,
  input: { readonly userId: string; readonly deviceId: string | undefined; readonly now: Date },
): MyQuota[] {
  if (!input.deviceId) return [];
  const releasing = new Set(
    refs.outbox
      .filter(
        (command: OutboxCommand) =>
          command.command_type === 'inventory.allocation.release' && command.status !== 'REJECTED',
      )
      .map((command) => command.aggregate_id),
  );
  return refs.allocations
    .filter(
      (allocation) =>
        allocation.status === 'ACTIVE' &&
        allocation.holder_user_id === input.userId &&
        allocation.holder_device_id === input.deviceId,
    )
    .map((allocation) => {
      const current = deviceQuota(refs, {
        userId: input.userId,
        deviceId: input.deviceId,
        locationId: allocation.location_id,
        productId: allocation.product_id,
      });
      const validUntil = allocation.valid_until ? new Date(allocation.valid_until) : null;
      return {
        allocation,
        remaining:
          current?.allocation.id === allocation.id
            ? current.remaining
            : Number(allocation.quantity_remaining),
        validUntil,
        expired: isAllocationExpired(validUntil, input.now),
        revocationPending: allocation.revocation_pending,
        releasing: releasing.has(allocation.id),
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
