/**
 * `inventory.alerts.transfer_not_received_check` (P9-08 ; D13 §7.1 `TRANSFER_NOT_RECEIVED` : « transfert
 * expédié non reçu depuis plus de 48 h », planifiée ; AV-408) : une passe quotidienne qui publie
 * `StockTransferNotReceived` pour chaque transfert **standard** expédié (`DISPATCHED`) dont le délai
 * `inventory.transfer_not_received_hours` (site de l'expéditeur, à défaut global, 48 h) est échu, puis le
 * marqueur de fin de passe qui **résout** les alertes des transferts reçus, annulés, refusés ou retournés
 * depuis (les commandes correspondantes résolvent aussi, au fil de l'eau).
 *
 * - Le délai compte depuis l'**expédition** (`dispatched_at`) : un transfert saisi hors ligne puis
 *   synchronisé porte l'heure à laquelle la marchandise est partie.
 * - Seuls les transferts `STANDARD` : la réception sans document a sa propre alerte
 *   (`TRANSFER_UNMATCHED`, BR-STK-024) et un transfert interne n'a pas de transit.
 * - **Site de l'alerte** : le site de **réception** (c'est là qu'on agit) ; l'expéditeur et le gardien
 *   exclusif de l'emplacement destinataire sont ses propriétaires (destinataires directs, D13).
 * - Une passe = une transaction, un événement par transfert en attente (volume borné par les transferts
 *   en transit) ; un rejeu du même créneau ne republie rien.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  elapsedHours,
  isTransferNotReceived,
  isValidTransferNotReceivedHours,
  transferNotReceivedHoursOrDefault,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { siteThenGlobalSetting } from '../../../organization/application/public/index.js';

export const TRANSFER_NOT_RECEIVED_JOB_TYPE = 'inventory.alerts.transfer_not_received_check';
export const TRANSFER_NOT_RECEIVED_HOURS_KEY = 'inventory.transfer_not_received_hours';

@Injectable()
export class TransferNotReceivedJob implements OnModuleInit {
  private readonly logger = new Logger(TransferNotReceivedJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(TRANSFER_NOT_RECEIVED_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('TRANSFER_NOT_RECEIVED', passSlotOf(payload, now));
      const pending = await uow
        .selectFrom('inventory_stock_transfers as t')
        .innerJoin('organization_locations as f', 'f.id', 't.from_location_id')
        .innerJoin('organization_locations as d', 'd.id', 't.to_location_id')
        .select([
          't.id as id',
          't.doc_number as doc_number',
          't.site_id as source_site_id',
          't.from_location_id as from_location_id',
          't.to_location_id as to_location_id',
          't.dispatched_by as dispatched_by',
          't.dispatched_at as dispatched_at',
          'f.name as from_name',
          'd.name as to_name',
          'd.site_id as to_site_id',
          'd.custody_mode as to_custody_mode',
          'd.custodian_user_id as to_custodian_user_id',
        ])
        .where('t.transfer_kind', '=', 'STANDARD')
        .where('t.status', '=', 'DISPATCHED')
        .where('t.dispatched_at', 'is not', null)
        .orderBy('t.dispatched_at', 'asc')
        .execute();

      const hoursBySite = new Map<string, number>();
      let published = 0;
      for (const transfer of pending) {
        const dispatchedAt = transfer.dispatched_at;
        if (dispatchedAt === null) continue;
        const sourceSiteId = fromBin(transfer.source_site_id);
        let hours = hoursBySite.get(sourceSiteId);
        if (hours === undefined) {
          hours = transferNotReceivedHoursOrDefault(
            await siteThenGlobalSetting(
              uow,
              TRANSFER_NOT_RECEIVED_HOURS_KEY,
              sourceSiteId,
              now,
              isValidTransferNotReceivedHours,
            ),
          );
          hoursBySite.set(sourceSiteId, hours);
        }
        if (!isTransferNotReceived(dispatchedAt, now, hours)) continue;
        const transferId = fromBin(transfer.id);
        const recipientUserId =
          transfer.to_custody_mode === 'EXCLUSIVE_USER' && transfer.to_custodian_user_id !== null
            ? fromBin(transfer.to_custodian_user_id)
            : null;
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'StockTransferNotReceived',
          producerModule: 'inventory',
          aggregateType: 'STOCK_TRANSFER',
          aggregateId: transferId,
          occurredAt: now,
          passId,
          payload: {
            transfer_id: transferId,
            doc_number: transfer.doc_number,
            hours_elapsed: elapsedHours(dispatchedAt, now),
            threshold_hours: hours,
            dispatched_at: dispatchedAt.toISOString(),
            from_location_id: fromBin(transfer.from_location_id),
            to_location_id: fromBin(transfer.to_location_id),
            from_location_label: transfer.from_name,
            to_location_label: transfer.to_name,
            sender_user_id:
              transfer.dispatched_by === null ? null : fromBin(transfer.dispatched_by),
            recipient_user_id: recipientUserId,
            // L'alerte est rattachée au site qui doit recevoir.
            site_id: transfer.to_site_id === null ? sourceSiteId : fromBin(transfer.to_site_id),
            source_site_id: sourceSiteId,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }

      await publishPassCompleted(uow, {
        producerModule: 'inventory',
        alertType: 'TRANSFER_NOT_RECEIVED',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Transferts expédiés non reçus (${today}) : ${published} signalé(s) sur ${pending.length} en transit.`,
      );
    });
  }
}
