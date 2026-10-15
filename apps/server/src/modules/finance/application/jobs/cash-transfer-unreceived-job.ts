/**
 * `finance.cash_transfers.unreceived_check` (P5-15 ; AV-158 : alerte à 48 h ; D13 §7.1
 * `CASH_TRANSFER_NOT_RECEIVED` ; P9-07 : passe de détection à identité, ADR-071 §3). Publie un événement
 * `CashTransferUnreceived` par remise **envoyée et jamais reçue ni annulée** depuis plus de
 * `finance.cash_transfer_unreceived_hours` heures (48 par défaut, une valeur invalide revient au défaut),
 * puis le marqueur de fin de passe : l'alerte d'état se résout quand la remise n'est plus revue
 * (reçue, annulée, écart clos). La tâche est horaire : un événement par remise et par passe, le
 * compteur d'occurrences compte des heures. Aucune remise n'est modifiée.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, isTransferUnreceived, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { cashTransferUnreceivedHoursAt } from '../cash-transfer-support.js';

export const CASH_TRANSFER_UNRECEIVED_JOB_TYPE = 'finance.cash_transfers.unreceived_check';

@Injectable()
export class CashTransferUnreceivedJob implements OnModuleInit {
  private readonly logger = new Logger(CashTransferUnreceivedJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CASH_TRANSFER_UNRECEIVED_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('CASH_TRANSFER_NOT_RECEIVED', passSlotOf(payload, now));
      const hours = await cashTransferUnreceivedHoursAt(uow, now);
      const threshold = new Date(now.getTime() - hours * 3_600_000);
      const late = await uow
        .selectFrom('finance_cash_transfers')
        .select([
          'id',
          'doc_number',
          'site_id',
          'from_account_id',
          'to_account_id',
          'amount_sent_xaf',
          'sent_at',
          'sent_by',
          'carrier_user_id',
          'carrier_name',
        ])
        .where('status', '=', 'SENT')
        .where('sent_at', '<=', threshold)
        .orderBy('sent_at')
        .execute();
      let published = 0;
      for (const transfer of late) {
        // Filet : même règle que l'appareil et l'indicateur « en transit » (bord inclus).
        if (!isTransferUnreceived(transfer.sent_at, now, hours)) continue;
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'CashTransferUnreceived',
          producerModule: 'finance',
          aggregateType: 'CASH_TRANSFER',
          aggregateId: fromBin(transfer.id),
          occurredAt: now,
          passId,
          payload: {
            transfer_id: fromBin(transfer.id),
            doc_number: transfer.doc_number,
            from_account_id: fromBin(transfer.from_account_id),
            to_account_id: fromBin(transfer.to_account_id),
            amount_sent_xaf: Number(transfer.amount_sent_xaf),
            sent_at: transfer.sent_at.toISOString(),
            sent_by: fromBin(transfer.sent_by),
            carrier_user_id: fromBinOrNull(transfer.carrier_user_id),
            carrier_name: transfer.carrier_name,
            hours_elapsed: Math.floor((now.getTime() - transfer.sent_at.getTime()) / 3_600_000),
            unreceived_hours: hours,
            site_id: fromBinOrNull(transfer.site_id),
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'finance',
        alertType: 'CASH_TRANSFER_NOT_RECEIVED',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Remises de fonds non reçues depuis ${hours} h signalées (${today}) : ${published}.`,
      );
    });
  }
}
