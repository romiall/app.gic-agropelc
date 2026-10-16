/**
 * `production.products.standard_cost_check` (P9-09 ; D13 §7.1 `STANDARD_COST_MISSING`, AV-124, ADR-027 ;
 * AV-463) : chaque jour à 07:45 (heure de Douala), publie un événement `StandardCostMissing` par produit
 * **entré en stock par la production récemment sans coût standard défini**, puis le marqueur de fin de
 * passe, qui résout l'alerte des produits dont le coût est défini ou sortis de la fenêtre de revue.
 *
 * - **Entrées valorisées au coût standard** (les deux seules, AV-124 : le reste suit le coût restant du
 *   lot) : les calibres et les œufs à couver d'une collecte non annulée, et les naissances de porcelets
 *   (entrée de lot `BIRTH`) non annulées.
 * - **Fenêtre de revue** : les entrées des `production.standard_cost_alert_lookback_days` derniers jours
 *   (30) ; un produit qui n'est plus produit sort de la revue et son alerte se ferme.
 * - **Condition** : aucun coût standard n'est défini **à l'instant de la passe**. Les versions de coût ne
 *   font que s'ajouter : « aucun coût maintenant » implique « aucun coût à la date de l'entrée » ; tester
 *   la date de l'entrée ferait renaître chaque nuit l'alerte d'un coût défini après coup (AV-463). Les
 *   entrées déjà valorisées sans coût standard ne sont pas revalorisées : l'écart reste dans le résultat
 *   du lot producteur (ADR-027).
 * - **Résolution immédiate** : `catalog.product_standard_cost.set` publie `StandardCostSet` ; cette passe
 *   la double (au plus 24 h) pour les produits sortis de la fenêtre.
 * Aucune entrée n'est modifiée.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import {
  addBusinessDays,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  standardCostAlertLookbackDaysOrDefault,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { findProduct, findStandardUnitCostXaf } from '../../../catalog/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const STANDARD_COST_MISSING_JOB_TYPE = 'production.products.standard_cost_check';
export const STANDARD_COST_LOOKBACK_KEY = 'production.standard_cost_alert_lookback_days';

/**
 * Produits entrés en stock par la production du jour `fromDay` au jour `toDay` (inclus), avec le dernier
 * jour d'entrée : calibres et œufs à couver des collectes non annulées, naissances non annulées.
 */
export async function recentStandardCostProducts(
  uow: UnitOfWork,
  fromDay: string,
  toDay: string,
): Promise<ReadonlyMap<string, string>> {
  const latest = new Map<string, string>();
  const keep = (productId: string, day: string): void => {
    const known = latest.get(productId);
    if (known === undefined || known < day) latest.set(productId, day);
  };
  const fromDate = new Date(`${fromDay}T00:00:00.000Z`);
  const toDate = new Date(`${toDay}T00:00:00.000Z`);
  const beforeUtc = businessDayEndUtc(toDay);

  const graded = await uow
    .selectFrom('production_egg_collection_lines as l')
    .innerJoin('production_egg_collections as c', 'c.id', 'l.collection_id')
    .select(['l.product_id', sql<Date>`MAX(c.collection_date)`.as('day')])
    .where('c.status', '<>', 'CANCELLED')
    .where('c.collection_date', '>=', fromDate)
    .where('c.collection_date', '<=', toDate)
    .groupBy('l.product_id')
    .execute();
  for (const row of graded) keep(fromBin(row.product_id), dayOfDateColumn(row.day));

  const hatching = await uow
    .selectFrom('production_egg_collections')
    .select(['hatching_product_id', sql<Date>`MAX(collection_date)`.as('day')])
    .where('status', '<>', 'CANCELLED')
    .where('hatching_qty', '>', 0)
    .where('hatching_product_id', 'is not', null)
    .where('collection_date', '>=', fromDate)
    .where('collection_date', '<=', toDate)
    .groupBy('hatching_product_id')
    .execute();
  for (const row of hatching) {
    if (row.hatching_product_id !== null)
      keep(fromBin(row.hatching_product_id), dayOfDateColumn(row.day));
  }

  const births = await uow
    .selectFrom('production_lot_entries')
    .select(['product_id', sql<Date>`MAX(occurred_at)`.as('at')])
    .where('source_kind', '=', 'BIRTH')
    .where('status', '<>', 'CANCELLED')
    .where('occurred_at', '>=', businessDayStartUtc(fromDay))
    .where('occurred_at', '<', beforeUtc)
    .groupBy('product_id')
    .execute();
  for (const row of births) keep(fromBin(row.product_id), businessDayOf(new Date(row.at)));

  return latest;
}

/** Jour métier `AAAA-MM-JJ` d'une colonne `DATE` (lue comme minuit UTC). */
function dayOfDateColumn(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

@Injectable()
export class StandardCostMissingJob implements OnModuleInit {
  private readonly logger = new Logger(StandardCostMissingJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(STANDARD_COST_MISSING_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const lookbackDays = standardCostAlertLookbackDaysOrDefault(
        await currentSettingValue(uow, {
          key: STANDARD_COST_LOOKBACK_KEY,
          scopeType: 'GLOBAL',
          scopeId: null,
          at: now,
        }),
      );
      const passId = detectionPassId('STANDARD_COST_MISSING', passSlotOf(payload, now));
      const recent = await recentStandardCostProducts(
        uow,
        addBusinessDays(today, -lookbackDays),
        today,
      );

      let published = 0;
      for (const [productId, entryDay] of [...recent].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if ((await findStandardUnitCostXaf(uow, productId, now)) !== undefined) continue;
        const product = await findProduct(uow, productId);
        const eventPayload: Record<string, unknown> = {
          product_id: productId,
          product_label: product?.name ?? productId,
          entry_day: entryDay,
          business_day: today,
        };
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'StandardCostMissing',
          producerModule: 'production',
          aggregateType: 'PRODUCT',
          aggregateId: compositeSubjectId('STANDARD_COST_MISSING', eventPayload),
          occurredAt: now,
          passId,
          payload: eventPayload,
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'production',
        alertType: 'STANDARD_COST_MISSING',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Coûts standard manquants (${lookbackDays} j ; ${today}) : ${published} produit(s) sur ${recent.size} entré(s).`,
      );
    });
  }
}
