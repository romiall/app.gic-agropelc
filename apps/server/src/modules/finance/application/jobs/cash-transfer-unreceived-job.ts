/**
 * `finance.cash_transfers.unreceived_check` (P5-15 ; AV-158 : alerte à 48 h ; D13 §7.1
 * `CASH_TRANSFER_NOT_RECEIVED`). Publie un événement `CashTransferUnreceived` par remise **envoyée et
 * jamais reçue ni annulée** depuis plus de `finance.cash_transfer_unreceived_hours` heures (48 par
 * défaut, une valeur invalide revient au défaut), au plus un par remise et par jour métier
 * (rejouable). Même patron que `inventory.allocations.expiry_daily`. L'alerte elle-même (consommateur
 * NOT) relève de P9 ; la planification de l'ordonnanceur ou du déploiement. Aucune remise n'est
 * modifiée.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  businessDayStartUtc,
  isTransferUnreceived,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
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
    this.registry.register(CASH_TRANSFER_UNRECEIVED_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const dayStart = businessDayStartUtc(today);
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
        const already = await uow
          .selectFrom('platform_domain_events')
          .select('seq')
          .where('event_type', '=', 'CashTransferUnreceived')
          .where('aggregate_type', '=', 'CASH_TRANSFER')
          .where('aggregate_id', '=', transfer.id)
          .where('occurred_at', '>=', dayStart)
          .executeTakeFirst();
        if (already) continue;
        await uow
          .insertInto('platform_domain_events')
          .values({
            event_id: toBin(this.idGenerator.newId()),
            event_type: 'CashTransferUnreceived',
            producer_module: 'finance',
            aggregate_type: 'CASH_TRANSFER',
            aggregate_id: transfer.id,
            occurred_at: now,
            payload: jsonValue({
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
            }),
            command_id: null,
          })
          .execute();
        published += 1;
      }
      this.logger.log(
        `Remises de fonds non reçues depuis ${hours} h signalées (${today}) : ${published}.`,
      );
    });
  }
}
