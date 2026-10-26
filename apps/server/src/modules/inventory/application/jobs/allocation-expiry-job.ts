/**
 * `inventory.allocations.expiry_daily` (P5-08 ; ADR-033 §9, SM-ALLOCATION : « un quota atteint sa
 * date `valid_until` : l'appareil cesse de l'utiliser et émet la libération à la synchronisation
 * suivante ; le serveur ne libère jamais seul — alerte au responsable »). Aucun quota n'est modifié.
 *
 * P9-08 (ADR-061 §3, AV-410) : deux passes de détection d'état à identité, dans la même transaction.
 *
 * - **`AllocationExpired`** : un événement par quota **actif** dont la date de validité est atteinte, puis
 *   le marqueur de fin de passe qui résout les alertes des quotas libérés ou révoqués depuis. Plus de
 *   déduplication « par jour » : l'identité de passe (type, créneau) rend le rejeu du même créneau
 *   idempotent, et le compteur d'occurrences de l'alerte avance d'un par jour de retard constaté.
 * - **`AllocationRevocationPending`** (filet) : un événement par quota actif encore signalé
 *   `revocation_pending` (appareil bloqué ou perdu, utilisateur désactivé), avec le marqueur de sa passe.
 *   Le consommateur `inventory.allocation_revocation` publie déjà le fait au blocage ; ce filet couvre une
 *   règle d'alerte activée après coup et ferme les alertes dont la condition a disparu sans événement.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import { fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { productAlertLabel } from '../inventory-alert-events.js';

export const ALLOCATION_EXPIRY_JOB_TYPE = 'inventory.allocations.expiry_daily';

/** Motif de la révocation en attente d'après l'état de l'appareil ou de l'utilisateur du quota. */
function revocationReason(deviceStatus: string, userStatus: string): string {
  if (deviceStatus === 'LOST') return 'DEVICE_LOST';
  if (deviceStatus === 'BLOCKED') return 'DEVICE_BLOCKED';
  if (deviceStatus === 'RETIRED') return 'DEVICE_RETIRED';
  if (userStatus !== 'ACTIVE') return 'USER_DEACTIVATED';
  return 'REVOCATION_PENDING';
}

@Injectable()
export class AllocationExpiryJob implements OnModuleInit {
  private readonly logger = new Logger(AllocationExpiryJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(ALLOCATION_EXPIRY_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const slot = passSlotOf(payload, now);
      const expiredPass = detectionPassId('ALLOCATION_EXPIRED', slot);
      const pendingPass = detectionPassId('ALLOCATION_REVOCATION_PENDING', slot);
      const labels = new Map<string, string>();
      const labelOf = async (productId: string): Promise<string> => {
        const known = labels.get(productId);
        if (known !== undefined) return known;
        const label = await productAlertLabel(uow, productId);
        labels.set(productId, label);
        return label;
      };

      const expired = await uow
        .selectFrom('inventory_stock_allocations as a')
        .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
        .select([
          'a.id as id',
          'a.holder_user_id as holder_user_id',
          'a.holder_device_id as holder_device_id',
          'a.product_id as product_id',
          'a.location_id as location_id',
          'a.quantity_remaining as remaining',
          'a.valid_until as valid_until',
          'l.site_id as site_id',
          'l.name as location_name',
        ])
        .where('a.status', '=', 'ACTIVE')
        .where('a.valid_until', 'is not', null)
        .where('a.valid_until', '<=', now)
        .execute();
      let published = 0;
      for (const quota of expired) {
        const allocationId = fromBin(quota.id);
        const productId = fromBin(quota.product_id);
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'AllocationExpired',
          producerModule: 'inventory',
          aggregateType: 'STOCK_ALLOCATION',
          aggregateId: allocationId,
          occurredAt: now,
          passId: expiredPass,
          payload: {
            allocation_id: allocationId,
            holder_user_id: fromBin(quota.holder_user_id as Buffer),
            holder_device_id: fromBin(quota.holder_device_id as Buffer),
            product_id: productId,
            product_label: await labelOf(productId),
            location_id: fromBin(quota.location_id),
            location_label: quota.location_name,
            remaining: Number(quota.remaining),
            valid_until: quota.valid_until?.toISOString() ?? null,
            site_id: fromBinOrNull(quota.site_id),
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      // La passe a vu tous les quotas échus : ceux qu'elle ne revoit pas sont libérés ou révoqués.
      await publishPassCompleted(uow, {
        producerModule: 'inventory',
        alertType: 'ALLOCATION_EXPIRED',
        passId: expiredPass,
        businessDay: today,
        occurredAt: now,
      });

      const pending = await uow
        .selectFrom('inventory_stock_allocations as a')
        .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
        .innerJoin('identity_devices as d', 'd.id', 'a.holder_device_id')
        .innerJoin('identity_users as u', 'u.id', 'a.holder_user_id')
        .select([
          'a.id as id',
          'a.holder_user_id as holder_user_id',
          'a.holder_device_id as holder_device_id',
          'a.product_id as product_id',
          'a.location_id as location_id',
          'a.quantity_remaining as remaining',
          'l.site_id as site_id',
          'l.name as location_name',
          'd.status as device_status',
          'u.status as user_status',
        ])
        .where('a.status', '=', 'ACTIVE')
        .where('a.revocation_pending', '=', 1)
        .execute();
      let pendingPublished = 0;
      for (const quota of pending) {
        const allocationId = fromBin(quota.id);
        const productId = fromBin(quota.product_id);
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'AllocationRevocationPending',
          producerModule: 'inventory',
          aggregateType: 'STOCK_ALLOCATION',
          aggregateId: allocationId,
          occurredAt: now,
          passId: pendingPass,
          payload: {
            allocation_id: allocationId,
            reason: revocationReason(quota.device_status, quota.user_status),
            holder_user_id: fromBin(quota.holder_user_id as Buffer),
            holder_device_id: fromBin(quota.holder_device_id as Buffer),
            product_id: productId,
            product_label: await labelOf(productId),
            location_id: fromBin(quota.location_id),
            location_label: quota.location_name,
            remaining: Number(quota.remaining),
            site_id: fromBinOrNull(quota.site_id),
            business_day: today,
          },
        });
        if (inserted) pendingPublished += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'inventory',
        alertType: 'ALLOCATION_REVOCATION_PENDING',
        passId: pendingPass,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Quotas échus signalés (${today}) : ${published} ; révocations en attente : ${pendingPublished}.`,
      );
    });
  }
}
