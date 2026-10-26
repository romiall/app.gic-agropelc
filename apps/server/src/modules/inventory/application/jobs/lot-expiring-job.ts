/**
 * `inventory.alerts.lot_expiring_daily` (P9-08 ; D13 §7.1 `LOT_EXPIRING` : « lot périmant sous 15 jours »,
 * planifiée, AV-454) : une passe quotidienne qui publie `LotExpiringDetected` pour chaque lot **ouvert**
 * dont la date de péremption est au plus à `inventory.lot_expiring_days` jours (15 par défaut), déjà
 * dépassée comprise, **et** dont du stock reste sur un emplacement physique, un événement par lot et par
 * site ; le marqueur de fin de passe résout les alertes des lots écoulés, transférés hors du site, clos ou
 * dont la date a été repoussée.
 *
 * - **Périmètre** (AV-454) : tout lot qui porte une date de péremption (réception fournisseur, collecte
 *   d'œufs, abattage), pas seulement le lot fournisseur : l'œuf périme aussi. Un lot biologique de
 *   production n'a pas de date de péremption (aucun signalement).
 * - **Sujet** : le lot **à un site** (un lot peut être réparti sur plusieurs sites, chaque magasinier voit
 *   le sien) ; le stock « en transit » (emplacement virtuel) n'est compté nulle part.
 * - **Un lot périmé avec du stock reste signalé** tant que le stock n'est pas sorti (perte déclarée,
 *   destruction) : l'alerte ne se ferme pas d'elle-même à la date dépassée.
 * - La date de péremption est une colonne `DATE` : lue en UTC (`formatDateColumn`), jamais décalée d'un jour.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  lotDaysLeft,
  lotExpiringDaysOrDefault,
  lotExpiringHorizonDay,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
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
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { formatDateColumn } from '../public/stock-query.js';
import { productAlertLabel } from '../inventory-alert-events.js';

export const LOT_EXPIRING_JOB_TYPE = 'inventory.alerts.lot_expiring_daily';
export const LOT_EXPIRING_DAYS_KEY = 'inventory.lot_expiring_days';

@Injectable()
export class LotExpiringJob implements OnModuleInit {
  private readonly logger = new Logger(LotExpiringJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(LOT_EXPIRING_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('LOT_EXPIRING', passSlotOf(payload, now));
      const days = lotExpiringDaysOrDefault(
        await currentSettingValue(uow, {
          key: LOT_EXPIRING_DAYS_KEY,
          scopeType: 'GLOBAL',
          scopeId: null,
          at: now,
        }),
      );
      const horizon = lotExpiringHorizonDay(today, days);

      const rows = await uow
        .selectFrom('inventory_stock_lots as l')
        .innerJoin('inventory_stock_balances as b', 'b.lot_key', 'l.id')
        .innerJoin('organization_locations as loc', 'loc.id', 'b.location_id')
        .select([
          'l.id as lot_id',
          'l.lot_code as lot_code',
          'l.origin_type as origin_type',
          'l.expiry_date as expiry_date',
          'loc.site_id as site_id',
          'b.product_id as product_id',
          sql<string>`SUM(b.qty_on_hand)`.as('quantity'),
        ])
        .where('l.expiry_date', 'is not', null)
        .where('l.expiry_date', '<=', sql<Date>`CAST(${horizon} AS DATE)`)
        .where('l.status', '=', 'OPEN')
        .where('b.qty_on_hand', '>', '0')
        .where('loc.is_virtual', '=', 0)
        .where('loc.site_id', 'is not', null)
        .groupBy([
          'l.id',
          'l.lot_code',
          'l.origin_type',
          'l.expiry_date',
          'loc.site_id',
          'b.product_id',
        ])
        .orderBy('l.expiry_date', 'asc')
        .execute();

      const labels = new Map<string, string>();
      let published = 0;
      for (const row of rows) {
        const expiry = formatDateColumn(row.expiry_date);
        const siteId = fromBinOrNull(row.site_id);
        if (expiry === null || siteId === null) continue;
        const lotId = fromBin(row.lot_id);
        const productId = fromBin(row.product_id);
        let productLabel = labels.get(productId);
        if (productLabel === undefined) {
          productLabel = await productAlertLabel(uow, productId);
          labels.set(productId, productLabel);
        }
        const eventPayload: Record<string, unknown> = {
          lot_id: lotId,
          lot_code: row.lot_code,
          product_id: productId,
          product_label: productLabel,
          origin_type: row.origin_type,
          expiry_date: expiry,
          days_left: lotDaysLeft(expiry, today),
          quantity: Number(row.quantity),
          site_id: siteId,
          business_day: today,
        };
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'LotExpiringDetected',
          producerModule: 'inventory',
          aggregateType: 'STOCK_LOT',
          aggregateId: compositeSubjectId('LOT_EXPIRING', eventPayload),
          occurredAt: now,
          passId,
          payload: eventPayload,
        });
        if (inserted) published += 1;
      }

      await publishPassCompleted(uow, {
        producerModule: 'inventory',
        alertType: 'LOT_EXPIRING',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Lots bientôt périmés (${today}, horizon ${horizon}) : ${published} signalé(s) sur ${rows.length}.`,
      );
    });
  }
}
