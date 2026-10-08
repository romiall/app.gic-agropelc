/**
 * `inventory.allocations.expiry_daily` (P5-08 ; ADR-033 §9, SM-ALLOCATION : « un quota atteint sa
 * date `valid_until` : l'appareil cesse de l'utiliser et émet la libération à la synchronisation
 * suivante ; le serveur ne libère jamais seul — alerte au responsable »). Publie un événement
 * `AllocationExpired` par quota **actif** dont la date de validité est atteinte, au plus un par quota
 * et par jour métier (rejouable). L'alerte elle-même (consommateur NOT) est l'objet de P9 ; la
 * planification relève du déploiement (P0-17), comme les autres tâches quotidiennes. Aucun quota n'est
 * modifié.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, businessDayStartUtc, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';

export const ALLOCATION_EXPIRY_JOB_TYPE = 'inventory.allocations.expiry_daily';

@Injectable()
export class AllocationExpiryJob implements OnModuleInit {
  private readonly logger = new Logger(AllocationExpiryJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(ALLOCATION_EXPIRY_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const dayStart = businessDayStartUtc(today);
      const expired = await uow
        .selectFrom('inventory_stock_allocations as a')
        .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
        .select([
          'a.id as id',
          'a.holder_user_id as holder_user_id',
          'a.holder_device_id as holder_device_id',
          'a.product_id as product_id',
          'a.quantity_remaining as remaining',
          'a.valid_until as valid_until',
          'l.site_id as site_id',
        ])
        .where('a.status', '=', 'ACTIVE')
        .where('a.valid_until', 'is not', null)
        .where('a.valid_until', '<=', now)
        .execute();
      let published = 0;
      for (const quota of expired) {
        const already = await uow
          .selectFrom('platform_domain_events')
          .select('seq')
          .where('event_type', '=', 'AllocationExpired')
          .where('aggregate_id', '=', quota.id)
          .where('occurred_at', '>=', dayStart)
          .executeTakeFirst();
        if (already) continue;
        await uow
          .insertInto('platform_domain_events')
          .values({
            event_id: toBin(this.idGenerator.newId()),
            event_type: 'AllocationExpired',
            producer_module: 'inventory',
            aggregate_type: 'STOCK_ALLOCATION',
            aggregate_id: quota.id,
            occurred_at: now,
            payload: jsonValue({
              allocation_id: fromBin(quota.id),
              holder_user_id: fromBin(quota.holder_user_id as Buffer),
              holder_device_id: fromBin(quota.holder_device_id as Buffer),
              product_id: fromBin(quota.product_id),
              remaining: quota.remaining,
              valid_until: quota.valid_until?.toISOString() ?? null,
              site_id: quota.site_id === null ? null : fromBin(quota.site_id),
              business_day: today,
            }),
            command_id: null,
          })
          .execute();
        published += 1;
      }
      this.logger.log(`Quotas échus signalés (${today}) : ${published}.`);
    });
  }
}
