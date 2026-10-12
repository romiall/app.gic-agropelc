/**
 * Quota d'appareil de l'utilisateur (ADR-033, BR-STK-013, AT-003) : sur un emplacement partagé, la
 * vente hors ligne n'est possible que dans le reste du quota du couple (utilisateur, appareil) ; le
 * stock libre ne s'y ajoute pas (seul le serveur le connaît). Le quota se lit dans le jeu
 * `allocations` (servi au seul appareil détenteur, de tous ses utilisateurs, AV-194).
 */
import type { LocalConsumptionBlock } from '@gic/domain';
import type { SalesReferences } from './references.js';
import { localAvailable, offlineSaleDecision, settingValue, stockKey } from './stock.js';
import type { AllocationData, LocationData } from './types.js';

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

/** Nature d'une sortie de stock soumise à la garde hors ligne. */
export type ExitKind = 'SALE' | 'LOSS' | 'CONSUMPTION' | 'DISPATCH';

/**
 * AV-303 (défaut) : hors ligne, au-delà du quota du détenteur (emplacement partagé) ou du solde d'un
 * emplacement exclusif, la vente (AV-025), la consommation et l'expédition sont bloquées
 * (BR-STK-013) ; la perte, fait constaté, est seulement signalée (BR-STK-018 : le serveur l'applique
 * et ouvre le conflit). `BLOCK` alignerait la perte sur les autres sorties.
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
 * Garde hors ligne d'une sortie de stock (BR-STK-013, AV-025, AV-303) : emplacement confié à un autre
 * appareil (`EXCLUSIVE_DEVICE`) refusé ; sur un emplacement partagé, le détenteur d'un quota sort dans
 * son reste (sans quota : une vente est refusée, une autre sortie suit le contrôle habituel de
 * l'écran, BR-STK-013 ne visant que le détenteur) ; sur un emplacement exclusif, dans le solde local.
 * Dépassement autorisé par le site (`sales.offline_over_allocation_allowed`) : signalé.
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
  if (
    location.custody_mode === 'EXCLUSIVE_DEVICE' &&
    location.designated_device_id !== input.deviceId
  ) {
    blocks.push({ productId: '', code: 'CUSTODY_DEVICE_MISMATCH', available: 0, requested: 0 });
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
    if (shared && quota === null && input.kind !== 'SALE') continue;
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
      if (input.kind === 'LOSS' && OFFLINE_LOSS_GUARD === 'SIGNAL') signals.push(issue);
      else blocks.push(issue);
    } else if (decision.signalled) {
      signals.push({ productId, code: decision.signalled, available: 0, requested: quantity });
    }
  }
  return { blocks, signals };
}
