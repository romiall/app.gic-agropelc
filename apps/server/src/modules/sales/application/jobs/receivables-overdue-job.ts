/**
 * `sales.receivables.overdue_daily` (P4-09 ; BR-FIN-007 : « l'alerte `OVERDUE_RECEIVABLE` est levée
 * chaque jour à 07:00 » ; P9-07 : passe de détection à identité, ADR-061 §3) : publie un événement
 * `ReceivableOverdue` par vente dont l'échéance est dépassée et le solde dû positif, puis le marqueur de
 * fin de passe `AlertDetectionPassCompleted`. Le consommateur d'alertes (`communication`) lève ou met à
 * jour l'alerte de chaque vente revue, et **résout** celles que la passe ne revoit plus (créance réglée).
 *
 * - **Identité de passe** : le type d'alerte et le créneau planifié ; un rejeu du même créneau republie
 *   les mêmes identifiants d'événement (aucun doublon), un autre jour publie à nouveau chaque vente (le
 *   compteur d'occurrences de l'alerte avance d'un par jour de retard constaté).
 * - Aucune déduplication « par jour » : l'unicité de l'alerte ouverte est portée par la base.
 * - **Propriétaire de l'alerte** : le commercial attribué, à défaut le vendeur (`seller_user_id`, P9-25
 *   AL-3, AV-463), comme la portée par personne de `GET /receivables`.
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
    this.registry.register(RECEIVABLES_OVERDUE_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('OVERDUE_RECEIVABLE', passSlotOf(payload, now));
      const overdue = await listReceivables(uow, { today, overdueOnly: true });
      let published = 0;
      for (const line of overdue) {
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'ReceivableOverdue',
          producerModule: 'sales',
          aggregateType: 'SALE',
          aggregateId: line.saleId,
          occurredAt: now,
          passId,
          payload: {
            sale_id: line.saleId,
            doc_number: line.docNumber,
            customer_id: line.customerId,
            commercial_user_id: line.commercialUserId,
            seller_user_id: line.sellerUserId,
            site_id: line.siteId,
            zone_id: line.zoneId,
            due_date: line.dueDate,
            days_overdue: line.daysOverdue,
            bucket: line.bucket,
            balance_due_xaf: line.balanceDueXaf,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      // La passe a vu toutes les créances échues : ce qu'elle n'a pas revu est réglé (ADR-061 §3).
      await publishPassCompleted(uow, {
        producerModule: 'sales',
        alertType: 'OVERDUE_RECEIVABLE',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(`Créances échues signalées (${today}) : ${published}.`);
    });
  }
}
