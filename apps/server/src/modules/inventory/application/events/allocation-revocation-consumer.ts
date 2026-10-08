/**
 * Consommateur `inventory.allocation_revocation` (P5-08 ; ADR-033 §9, SM-ALLOCATION : « appareil
 * bloqué ou déclaré perdu : `revocation_pending`, alerte au responsable, aucun mouvement
 * automatique »). Il lit les événements de domaine d'`identity` (le `event_type` d'un événement de
 * commande est le type de la commande, voir le catalogue des événements) :
 *
 * - `identity.device.block`, `identity.device.declare_lost` : les quotas **actifs** de l'appareil
 *   passent en `revocation_pending` ;
 * - `identity.user.deactivate` : de même pour les quotas actifs de l'utilisateur (D06 : « allocations
 *   de l'utilisateur à régulariser, pas de mouvement automatique ») ;
 * - `identity.device.unblock`, `identity.user.reactivate` : le signal est levé, sauf si l'autre moitié
 *   du couple (l'utilisateur, ou l'appareil) reste elle-même hors service.
 *
 * Le serveur ne révoque ni ne libère jamais seul : le drapeau n'appelle que la décision d'un
 * responsable (`inventory.allocation.revoke`). Chaque quota nouvellement signalé publie
 * `AllocationRevocationPending` (l'alerte elle-même est l'objet de P9). Au moins une fois : rejouer
 * un événement ne change plus rien, donc ne publie plus rien.
 */
import { sql } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { EventConsumerRegistry } from '../../../../platform/events/event-consumer-registry.js';
import type { DomainEvent } from '../../../../platform/events/domain-event.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { allocationChange } from '../sync-changes.js';

export const ALLOCATION_REVOCATION_CONSUMER_NAME = 'inventory.allocation_revocation';

type HolderKind = 'DEVICE' | 'USER';

const SIGNALLING_EVENTS: Readonly<Record<string, { holder: HolderKind; reason: string }>> = {
  'identity.device.block': { holder: 'DEVICE', reason: 'DEVICE_BLOCKED' },
  'identity.device.declare_lost': { holder: 'DEVICE', reason: 'DEVICE_LOST' },
  'identity.user.deactivate': { holder: 'USER', reason: 'USER_DEACTIVATED' },
};

const CLEARING_EVENTS: Readonly<Record<string, HolderKind>> = {
  'identity.device.unblock': 'DEVICE',
  'identity.user.reactivate': 'USER',
};

export function registerAllocationRevocationConsumer(
  registry: EventConsumerRegistry,
  idGenerator: IdGenerator,
): void {
  registry.register(ALLOCATION_REVOCATION_CONSUMER_NAME, async (uow, event: DomainEvent) => {
    const signalling = SIGNALLING_EVENTS[event.eventType];
    if (signalling) {
      await flagQuotas(uow, idGenerator, event, signalling);
      return;
    }
    const clearing = CLEARING_EVENTS[event.eventType];
    if (clearing) await clearFlags(uow, event, clearing);
  });
}

async function flagQuotas(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  event: DomainEvent,
  signalling: { holder: HolderKind; reason: string },
): Promise<void> {
  const holderColumn = signalling.holder === 'DEVICE' ? 'a.holder_device_id' : 'a.holder_user_id';
  const quotas = await uow
    .selectFrom('inventory_stock_allocations as a')
    .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
    .select([
      'a.id as id',
      'a.holder_device_id as holder_device_id',
      'a.holder_user_id as holder_user_id',
      'a.product_id as product_id',
      'a.quantity_remaining as remaining',
      'a.version as version',
      'l.site_id as site_id',
    ])
    .where(holderColumn, '=', toBin(event.aggregateId))
    .where('a.status', '=', 'ACTIVE')
    .where('a.revocation_pending', '=', 0)
    .forUpdate()
    .execute();
  for (const quota of quotas) {
    await uow
      .updateTable('inventory_stock_allocations')
      .set({ revocation_pending: 1, version: sql`version + 1` })
      .where('id', '=', quota.id)
      .execute();
    await recordChanges(uow, [
      allocationChange(
        fromBin(quota.id),
        fromBin(quota.holder_device_id as Buffer),
        quota.version + 1,
      ),
    ]);
    await uow
      .insertInto('platform_domain_events')
      .values({
        event_id: toBin(idGenerator.newId()),
        event_type: 'AllocationRevocationPending',
        producer_module: 'inventory',
        aggregate_type: 'STOCK_ALLOCATION',
        aggregate_id: quota.id,
        occurred_at: event.occurredAt,
        payload: jsonValue({
          allocation_id: fromBin(quota.id),
          reason: signalling.reason,
          holder_user_id: fromBin(quota.holder_user_id as Buffer),
          holder_device_id: fromBin(quota.holder_device_id as Buffer),
          product_id: fromBin(quota.product_id),
          remaining: quota.remaining,
          site_id: quota.site_id === null ? null : fromBin(quota.site_id),
        }),
        command_id: null,
        causation_id: toBin(event.eventId),
      })
      .execute();
  }
}

/** Lève le signal des quotas de l'appareil (ou de l'utilisateur) dont l'autre moitié est en service. */
async function clearFlags(uow: UnitOfWork, event: DomainEvent, by: HolderKind): Promise<void> {
  const holderColumn = by === 'DEVICE' ? 'a.holder_device_id' : 'a.holder_user_id';
  const flagged = await uow
    .selectFrom('inventory_stock_allocations as a')
    .innerJoin('identity_users as u', 'u.id', 'a.holder_user_id')
    .innerJoin('identity_devices as d', 'd.id', 'a.holder_device_id')
    .select(['a.id as id', 'a.holder_device_id as holder_device_id', 'a.version as version'])
    .where(holderColumn, '=', toBin(event.aggregateId))
    .where('a.status', '=', 'ACTIVE')
    .where('a.revocation_pending', '=', 1)
    .where('u.status', '=', 'ACTIVE')
    .where('d.status', '=', 'ACTIVE')
    .forUpdate()
    .execute();
  for (const quota of flagged) {
    await uow
      .updateTable('inventory_stock_allocations')
      .set({ revocation_pending: 0, version: sql`version + 1` })
      .where('id', '=', quota.id)
      .execute();
    await recordChanges(uow, [
      allocationChange(
        fromBin(quota.id),
        fromBin(quota.holder_device_id as Buffer),
        quota.version + 1,
      ),
    ]);
  }
}
