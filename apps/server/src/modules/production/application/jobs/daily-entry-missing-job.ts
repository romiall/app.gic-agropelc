/**
 * `production.lots.daily_entry_check` (P9-09 ; D13 §7.1 `DAILY_ENTRY_MISSING`, D07 §14, BR-PRD-008 ;
 * AV-462) : chaque jour à 10:00 (heure de Douala), publie un événement `DailyEntryMissing` par lot en
 * cours **sans aucune saisie la veille**, puis le marqueur de fin de passe, qui résout l'alerte des lots
 * qui ont rattrapé leur saisie (une alerte d'état par lot : elle porte le **dernier** jour manquant).
 *
 * - **Jour examiné** : la veille du **créneau planifié** (le rattrapage d'un créneau manqué examine la
 *   veille du créneau, non celle de l'exécution) ; sans créneau lisible, la veille de l'instant courant.
 *   Un jour hors `production.daily_entry_working_days` (tous les jours par défaut : un élevage ne s'arrête
 *   pas) ne publie rien, pas même le marqueur : les alertes ouvertes persistent jusqu'au jour examiné
 *   suivant, comme `INACTIVE_COMMERCIAL`.
 * - **Lots examinés** : `ACTIVE` ou `SELLING`, mis en place **avant** le jour examiné (le jour de la mise
 *   en place compte une entrée de lot, non une saisie) et ayant des animaux en élevage à la fin du jour
 *   examiné (un lot en vente vidé par les ventes n'a plus rien à saisir).
 * - **Saisie du jour** (BR-PRD-008 : des commandes indépendantes, aucun en-tête) : au moins l'un des faits
 *   suivants **datés du jour examiné** (date du fait, non celle de la synchronisation, comme la fiche du
 *   lot) : mortalité comptée ou en attente, consommation d'intrant enregistrée, pesée non annulée,
 *   observation (dont « RAS », AV-117), collecte d'œufs non annulée. Une saisie rétroactive ou hors ligne
 *   synchronisée **avant** la passe est vue ; synchronisée après, elle ferme l'alerte à la passe suivante
 *   (accepté comme `INACTIVE_COMMERCIAL`, AV-444 ; au plus 24 h).
 * Aucun lot n'est modifié.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  addBusinessDays,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  dailyEntryExpected,
  dailyEntryWorkingDaysOrDefault,
  isoWeekdayOfBusinessDay,
  type Clock,
  type IdGenerator,
  type ProductionLotStatus,
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
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  costObjectConsumptionsByDay,
  lotHeadcount,
  productionLotMortalityByDay,
} from '../../../inventory/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const DAILY_ENTRY_MISSING_JOB_TYPE = 'production.lots.daily_entry_check';
export const DAILY_ENTRY_WORKING_DAYS_KEY = 'production.daily_entry_working_days';

interface LotToCheck {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
  readonly siteId: string;
  readonly stockLotId: string;
  readonly status: ProductionLotStatus;
  readonly startDay: string | null;
}

/**
 * Le lot a-t-il au moins une saisie datée du jour examiné ? Les sources de la production d'abord
 * (lecture par le lot), celles d'`inventory` par ses lectures publiques.
 */
export async function hasDailyEntryOn(
  uow: UnitOfWork,
  lotId: string,
  day: string,
): Promise<boolean> {
  const fromUtc = businessDayStartUtc(day);
  const toUtc = businessDayEndUtc(day);
  const lot = toBin(lotId);

  const observation = await uow
    .selectFrom('production_lot_observations')
    .select('id')
    .where('production_lot_id', '=', lot)
    .where('occurred_at', '>=', fromUtc)
    .where('occurred_at', '<', toUtc)
    .limit(1)
    .executeTakeFirst();
  if (observation !== undefined) return true;

  const weighing = await uow
    .selectFrom('production_lot_weighings')
    .select('id')
    .where('production_lot_id', '=', lot)
    .where('status', '<>', 'CANCELLED')
    .where('occurred_at', '>=', fromUtc)
    .where('occurred_at', '<', toUtc)
    .limit(1)
    .executeTakeFirst();
  if (weighing !== undefined) return true;

  // `collection_date` est le jour métier fourni par la commande (par défaut, celui du fait).
  const collection = await uow
    .selectFrom('production_egg_collections')
    .select('id')
    .where('production_lot_id', '=', lot)
    .where('status', '<>', 'CANCELLED')
    .where('collection_date', '=', new Date(`${day}T00:00:00.000Z`))
    .limit(1)
    .executeTakeFirst();
  if (collection !== undefined) return true;

  const deaths = await productionLotMortalityByDay(uow, {
    productionLotId: lotId,
    fromUtc,
    toUtc,
  });
  if (deaths.some((line) => line.countedQuantity + line.pendingQuantity > 0)) return true;

  const inputs = await costObjectConsumptionsByDay(uow, {
    costObjectType: 'PRODUCTION_LOT',
    costObjectId: lotId,
    fromUtc,
    toUtc,
  });
  return inputs.length > 0;
}

@Injectable()
export class DailyEntryMissingJob implements OnModuleInit {
  private readonly logger = new Logger(DailyEntryMissingJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DAILY_ENTRY_MISSING_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const slot = new Date(passSlotOf(payload, now));
      const examinedDay = addBusinessDays(
        businessDayOf(Number.isNaN(slot.getTime()) ? now : slot),
        -1,
      );
      const workingDays = dailyEntryWorkingDaysOrDefault(
        await currentSettingValue(uow, {
          key: DAILY_ENTRY_WORKING_DAYS_KEY,
          scopeType: 'GLOBAL',
          scopeId: null,
          at: now,
        }),
      );
      if (!workingDays.includes(isoWeekdayOfBusinessDay(examinedDay))) {
        // Jour sans saisie attendue : aucune alerte levée ni résolue (le marqueur résoudrait celle de la
        // veille d'un jour ouvré).
        this.logger.log(`Jour sans saisie attendue ${examinedDay} : contrôle sans objet.`);
        return;
      }
      const passId = detectionPassId('DAILY_ENTRY_MISSING', passSlotOf(payload, now));

      const rows = await uow
        .selectFrom('production_production_lots')
        .select(['id', 'lot_code', 'lot_type', 'site_id', 'stock_lot_id', 'status', 'start_date'])
        .where('status', 'in', ['ACTIVE', 'SELLING'])
        .where('start_date', 'is not', null)
        .where('start_date', '<', new Date(`${examinedDay}T00:00:00.000Z`))
        .orderBy('id', 'asc')
        .execute();
      const lots: LotToCheck[] = rows.map((row) => ({
        id: fromBin(row.id),
        lotCode: row.lot_code,
        lotType: row.lot_type,
        siteId: fromBin(row.site_id),
        stockLotId: fromBin(row.stock_lot_id),
        status: row.status as ProductionLotStatus,
        startDay: row.start_date === null ? null : row.start_date.toISOString().slice(0, 10),
      }));

      const endOfDay = new Date(businessDayEndUtc(examinedDay).getTime() - 1);
      let examined = 0;
      let published = 0;
      for (const lot of lots) {
        const endOfDayHeadcount = await lotHeadcount(uow, {
          lotId: lot.stockLotId,
          scope: 'REARING',
          at: endOfDay,
        });
        if (
          !dailyEntryExpected({
            status: lot.status,
            startDay: lot.startDay,
            examinedDay,
            endOfDayHeadcount,
          })
        ) {
          continue;
        }
        examined += 1;
        if (await hasDailyEntryOn(uow, lot.id, examinedDay)) continue;
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'DailyEntryMissing',
          producerModule: 'production',
          aggregateType: 'PRODUCTION_LOT',
          aggregateId: lot.id,
          occurredAt: now,
          passId,
          payload: {
            lot_id: lot.id,
            lot_label: lot.lotCode,
            lot_type: lot.lotType,
            missing_day: examinedDay,
            business_day: examinedDay,
            site_id: lot.siteId,
          },
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'production',
        alertType: 'DAILY_ENTRY_MISSING',
        passId,
        businessDay: examinedDay,
        occurredAt: now,
      });
      this.logger.log(
        `Saisies du jour manquantes le ${examinedDay} : ${published} lot(s) sur ${examined} examiné(s).`,
      );
    });
  }
}
