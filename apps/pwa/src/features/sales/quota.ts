/**
 * Quota d'appareil de l'utilisateur (ADR-033, BR-STK-013, AT-003) : sur un emplacement partagé, la
 * vente hors ligne n'est possible que dans le reste du quota du couple (utilisateur, appareil) ; le
 * stock libre ne s'y ajoute pas (seul le serveur le connaît). Le quota se lit dans le jeu
 * `allocations` (servi au seul appareil détenteur, de tous ses utilisateurs, AV-194).
 */
import type { SalesReferences } from './references.js';
import { stockKey } from './stock.js';
import type { AllocationData } from './types.js';

export interface DeviceQuota {
  readonly allocation: AllocationData;
  /**
   * Reste du quota net des sorties de l'utilisateur encore en attente sur (emplacement, produit),
   * comptées jusqu'au tirage du jeu `allocations` qui les inclut (ADR-037 §3).
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
  const pending = refs.quotaPending.get(stockKey(input.locationId, input.productId)) ?? 0;
  return {
    allocation,
    remaining: Math.round((Number(allocation.quantity_remaining) - pending) * 1000) / 1000,
    validUntil: allocation.valid_until ? new Date(allocation.valid_until) : null,
  };
}
