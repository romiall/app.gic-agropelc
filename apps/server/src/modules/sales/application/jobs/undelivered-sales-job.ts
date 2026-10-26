/**
 * `sales.orders.undelivered_check` (P9-07 ; D13 §7.1 `SALE_UNDELIVERED`, AV-132, ADR-061 §3) : publie un
 * événement `SaleUndeliveredDetected` par vente sur commande confirmée dont une partie reste à livrer
 * depuis plus de `sales.undelivered_alert_days` jours (7 par défaut), puis le marqueur de fin de passe.
 * Une vente livrée en totalité, annulée ou redevenue récente n'est plus revue : l'alerte est résolue par
 * le marqueur.
 *
 * - **Ancienneté** : jours métier écoulés depuis la confirmation de la vente (AV-132) ou, si elle est
 *   postérieure, depuis la date de livraison demandée (AV-401) ; « plus de N jours » : exactement N jours
 *   n'alerte pas.
 * - **Passe** : globale (une identité pour tout le type), complète en une transaction.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  addBusinessDays,
  businessDayOf,
  businessPeriodDays,
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
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { listUndeliveredSales } from '../public/undelivered-sales.js';

export const UNDELIVERED_SALES_JOB_TYPE = 'sales.orders.undelivered_check';
export const UNDELIVERED_ALERT_DAYS_KEY = 'sales.undelivered_alert_days';
const DEFAULT_ALERT_DAYS = 7;

@Injectable()
export class UndeliveredSalesJob implements OnModuleInit {
  private readonly logger = new Logger(UndeliveredSalesJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(UNDELIVERED_SALES_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('SALE_UNDELIVERED', passSlotOf(payload, now));
      const setting = await currentSettingValue(uow, {
        key: UNDELIVERED_ALERT_DAYS_KEY,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: now,
      });
      // Réglage absent, nul (`null`), vide ou illisible : le défaut de 7 jours (jamais « 0 jour »).
      const days =
        typeof setting === 'number'
          ? setting
          : typeof setting === 'string' && setting.trim() !== ''
            ? Number(setting)
            : Number.NaN;
      const thresholdDays = Number.isInteger(days) && days >= 0 ? days : DEFAULT_ALERT_DAYS;

      // « Plus de N jours » : la vente de J−N a exactement N jours, elle n'alerte pas.
      const sales = await listUndeliveredSales(uow, {
        onOrBeforeDay: addBusinessDays(today, -(thresholdDays + 1)),
      });
      let published = 0;
      for (const sale of sales) {
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'SaleUndeliveredDetected',
          producerModule: 'sales',
          aggregateType: 'SALE',
          aggregateId: sale.saleId,
          occurredAt: now,
          passId,
          payload: {
            sale_id: sale.saleId,
            doc_number: sale.docNumber,
            order_id: sale.orderId,
            customer_id: sale.customerId,
            site_id: sale.siteId,
            zone_id: sale.zoneId,
            commercial_user_id: sale.commercialUserId,
            seller_user_id: sale.sellerUserId,
            days_undelivered: businessPeriodDays({ fromDay: sale.referenceDay, toDay: today }) - 1,
            threshold_days: thresholdDays,
            sale_day: sale.saleDay,
            requested_delivery_day: sale.requestedDeliveryDay,
            reference_day: sale.referenceDay,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'sales',
        alertType: 'SALE_UNDELIVERED',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(`Ventes confirmées non livrées signalées (${today}) : ${published}.`);
    });
  }
}
