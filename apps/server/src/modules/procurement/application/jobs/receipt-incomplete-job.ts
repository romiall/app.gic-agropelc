/**
 * `procurement.orders.receipt_incomplete_check` (P9-09 ; D13 §7.1 `RECEIPT_INCOMPLETE`, BR-APP-015 ;
 * AV-410, AV-464) : chaque jour à 07:15 (heure de Douala, après le changement de jour métier), publie un
 * événement `ReceiptIncompleteDetected` par bon de commande **encore en cours de réception** (`SENT`,
 * `PARTIALLY_RECEIVED`) qui présente un reliquat et dont la date prévue est dépassée de plus de
 * `procurement.receipt_incomplete_alert_days` jours (2) ou qui porte une quantité rejetée, puis le
 * marqueur de fin de passe, qui résout les alertes des bons revenus à reliquat nul, clôturés, annulés ou
 * redevenus dans les délais.
 *
 * C'est le second producteur du même état : la détection **sur réception**
 * (`receipt-alert-events.ts#signalReceiptIncomplete`) publie à chaque changement des quantités du bon ; la
 * passe évalue la **même condition** sur tous les bons ouverts — une alerte levée sur réception n'est donc
 * pas fermée à tort par le marqueur, et le retard est détecté sans réception.
 * Aucun bon n'est modifié.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import {
  evaluateOrders,
  listOpenOrderIds,
  receiptIncompletePassId,
  receiptIncompletePayload,
  receiptIncompleteThresholdDays,
} from '../receipt-alert-events.js';

export const RECEIPT_INCOMPLETE_JOB_TYPE = 'procurement.orders.receipt_incomplete_check';

@Injectable()
export class ReceiptIncompleteJob implements OnModuleInit {
  private readonly logger = new Logger(ReceiptIncompleteJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(RECEIPT_INCOMPLETE_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const thresholdDays = await receiptIncompleteThresholdDays(uow, now);
      const passId = receiptIncompletePassId(passSlotOf(payload, now));

      const orderIds = await listOpenOrderIds(uow);
      const infos = await evaluateOrders(uow, orderIds, { today, thresholdDays });
      let published = 0;
      for (const info of infos) {
        if (!info.state.incomplete) continue;
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'ReceiptIncompleteDetected',
          producerModule: 'procurement',
          aggregateType: 'PURCHASE_ORDER',
          aggregateId: info.orderId,
          occurredAt: now,
          passId,
          payload: receiptIncompletePayload(info, { thresholdDays, trigger: 'PASS', today }),
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'procurement',
        alertType: 'RECEIPT_INCOMPLETE',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Réceptions incomplètes (${today}, délai ${thresholdDays} j) : ${published} bon(s) sur ${infos.length} ouvert(s).`,
      );
    });
  }
}
