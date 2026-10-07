/**
 * `sales.receivables.overdue_daily` (P4-09 ; BR-FIN-007 : « l'alerte `OVERDUE_RECEIVABLE` est levée
 * chaque jour à 07:00 ») : publie un événement `ReceivableOverdue` par vente dont l'échéance est
 * dépassée et le solde dû positif. L'alerte elle-même (consommateur NOT) est l'objet de P9 ; la
 * planification à 07:00 relève du déploiement (P0-17), comme les autres tâches quotidiennes.
 * Rejouable : au plus un événement par vente et par jour métier.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, businessDayStartUtc, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { listReceivables } from '../public/receivables.js';

export const RECEIVABLES_OVERDUE_JOB_TYPE = 'sales.receivables.overdue_daily';

@Injectable()
export class ReceivablesOverdueJob implements OnModuleInit {
  private readonly logger = new Logger(ReceivablesOverdueJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(RECEIVABLES_OVERDUE_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const dayStart = businessDayStartUtc(today);
      const overdue = await listReceivables(uow, { today, overdueOnly: true });
      let published = 0;
      for (const line of overdue) {
        const already = await uow
          .selectFrom('platform_domain_events')
          .select('seq')
          .where('event_type', '=', 'ReceivableOverdue')
          .where('aggregate_id', '=', toBin(line.saleId))
          .where('occurred_at', '>=', dayStart)
          .executeTakeFirst();
        if (already) continue;
        await uow
          .insertInto('platform_domain_events')
          .values({
            event_id: toBin(this.idGenerator.newId()),
            event_type: 'ReceivableOverdue',
            producer_module: 'sales',
            aggregate_type: 'SALE',
            aggregate_id: toBin(line.saleId),
            occurred_at: now,
            payload: jsonValue({
              sale_id: line.saleId,
              doc_number: line.docNumber,
              customer_id: line.customerId,
              commercial_user_id: line.commercialUserId,
              site_id: line.siteId,
              due_date: line.dueDate,
              days_overdue: line.daysOverdue,
              bucket: line.bucket,
              balance_due_xaf: line.balanceDueXaf,
              business_day: today,
            }),
            command_id: null,
          })
          .execute();
        published += 1;
      }
      this.logger.log(`Créances échues signalées (${today}) : ${published}.`);
    });
  }
}
