/**
 * P9-09 : passes planifiées de `production` — `production.lots.daily_entry_check` (`DAILY_ENTRY_MISSING`,
 * D13 §7.1, D07 §14, AV-462) et `production.products.standard_cost_check` (`STANDARD_COST_MISSING`,
 * AV-124, AV-463). Les passes lisent la base partagée : horloge dans le passé lointain (aucun lot ni
 * collecte d'un autre fichier n'y est daté), transactions annulées, lots et entrées insérés directement.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as {
    currentSettingValue: (...args: unknown[]) => Promise<unknown>;
  };
  return { ...actual, currentSettingValue: vi.fn(actual.currentSettingValue) };
});

import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  DAILY_ENTRY_MISSING_JOB_TYPE,
  DailyEntryMissingJob,
  hasDailyEntryOn,
} from '../src/modules/production/application/jobs/daily-entry-missing-job.js';
import {
  STANDARD_COST_MISSING_JOB_TYPE,
  StandardCostMissingJob,
  recentStandardCostProducts,
} from '../src/modules/production/application/jobs/standard-cost-missing-job.js';
import {
  PRODUCTION_RECURRING_JOBS,
  ProductionRecurringJobs,
} from '../src/modules/production/application/jobs/production-recurring-jobs.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

/** 10:00 à Douala le mardi 12 mars 2019 : la veille est le lundi 11 (jour ISO 1). */
const NOW = new Date('2019-03-12T09:00:00.000Z');
const SLOT = NOW.toISOString();
const EXAMINED = '2019-03-11';
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);

const at = (hhmm: string, day = EXAMINED) => new Date(`${day}T${hhmm}:00.000Z`);

const settingsOverride = new Map<string, unknown>();
beforeEach(() => {
  settingsOverride.clear();
  const real = vi.mocked(currentSettingValue);
  real.mockImplementation(async (executor, input) => {
    const key = (input as { key: string }).key;
    if (settingsOverride.has(key)) return settingsOverride.get(key);
    // Réglages de la base partagée : aucun n'est daté de 2019, les défauts du domaine s'appliquent.
    return undefined;
  });
});

function dailyRunner(clockAt: FixedClock = clock) {
  const registry = new JobHandlerRegistry();
  new DailyEntryMissingJob(clockAt, idGenerator, registry).onModuleInit();
  return registry.resolve(DAILY_ENTRY_MISSING_JOB_TYPE)!;
}

function costRunner(clockAt: FixedClock = clock) {
  const registry = new JobHandlerRegistry();
  new StandardCostMissingJob(clockAt, idGenerator, registry).onModuleInit();
  return registry.resolve(STANDARD_COST_MISSING_JOB_TYPE)!;
}

async function world(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const site = await insertTestSite(uow, admin, zone, { siteType: 'FERME' });
  const building = await insertTestLocation(uow, admin, site, { locationType: 'BUILDING' });
  const product = await insertTestProduct(uow, admin, { lotTracking: 'REQUIRED' });
  const opening = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', 'V_OPENING')
    .executeTakeFirstOrThrow();

  async function stockLot(forProduct = product): Promise<string> {
    const id = freshUuid();
    await uow
      .insertInto('inventory_stock_lots')
      .values({
        id: toBin(id),
        lot_code: `L-${id.slice(-12)}`,
        product_id: toBin(forProduct),
        origin_type: 'SUPPLIER_LOT',
        fifo_rank_at: at('06:00', '2019-03-01'),
        status: 'OPEN',
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  /** Lot de production et ses `heads` têtes en élevage (mouvement d'ouverture dans le bâtiment). */
  async function lot(
    options: {
      readonly status?: string;
      readonly start?: string | null;
      readonly heads?: number;
      readonly headsAt?: string;
    } = {},
  ): Promise<{ id: string; code: string; stockLotId: string }> {
    const id = freshUuid();
    const stockLotId = await stockLot();
    const heads = options.heads ?? 100;
    if (heads > 0) {
      await uow
        .insertInto('inventory_stock_moves')
        .values({
          id: toBin(freshUuid()),
          product_id: toBin(product),
          lot_id: toBin(stockLotId),
          from_location_id: opening.id,
          to_location_id: toBin(building),
          quantity: String(heads),
          move_type: 'OPENING_BALANCE',
          unit_cost_xaf: 0,
          value_xaf: 0,
          occurred_at: new Date(options.headsAt ?? '2019-03-01T08:00:00.000Z'),
          source_doc_type: 'INVENTORY_COUNT',
          source_doc_id: toBin(freshUuid()),
          created_by: toBin(admin),
        })
        .execute();
    }
    const code = `T9-${id.slice(-12)}`;
    await uow
      .insertInto('production_production_lots')
      .values({
        id: toBin(id),
        lot_code: code,
        lot_type: 'POULET_CHAIR',
        product_id: toBin(product),
        stock_lot_id: toBin(stockLotId),
        site_id: toBin(site),
        main_location_id: toBin(building),
        status: options.status ?? 'ACTIVE',
        start_date:
          options.start === null
            ? null
            : new Date(`${options.start ?? '2019-03-01'}T00:00:00.000Z`),
        initial_quantity: String(heads),
        occurred_at: at('06:00', '2019-03-01'),
        created_by: toBin(admin),
        ...(options.status === 'CLOSED' ? { closed_at: at('06:00', '2019-03-05') } : {}),
      })
      .execute();
    return { id, code, stockLotId };
  }

  const entries = {
    observation: async (lotId: string, when: Date) => {
      await uow
        .insertInto('production_lot_observations')
        .values({
          id: toBin(freshUuid()),
          production_lot_id: toBin(lotId),
          observation_type: 'AUTRE',
          text: 'RAS',
          occurred_at: when,
          created_by: toBin(admin),
        })
        .execute();
    },
    weighing: async (lotId: string, when: Date, status = 'RECORDED') => {
      await uow
        .insertInto('production_lot_weighings')
        .values({
          id: toBin(freshUuid()),
          production_lot_id: toBin(lotId),
          avg_weight_g: '1500',
          sample_size: 10,
          occurred_at: when,
          status,
          created_by: toBin(admin),
          ...(status === 'CANCELLED' ? { cancelled_at: when, cancelled_by: toBin(admin) } : {}),
        })
        .execute();
    },
    eggCollection: async (
      lotId: string,
      _unusedLotStock: string,
      day: string,
      status = 'RECORDED',
      options: {
        readonly hatchingProduct?: string;
        readonly hatching?: number;
        readonly lines?: readonly string[];
      } = {},
    ): Promise<string> => {
      const id = freshUuid();
      const hatching = options.hatching ?? 0;
      const lines = options.lines ?? [];
      // Un lot de stock par collecte (`uq_production_egg_collections_stock_lot`).
      const collectionStockLot = await stockLot();
      await uow
        .insertInto('production_egg_collections')
        .values({
          id: toBin(id),
          doc_number: `COL-T-${id.slice(-10)}`,
          production_lot_id: toBin(lotId),
          site_id: toBin(site),
          collection_date: new Date(`${day}T00:00:00.000Z`),
          storage_location_id: toBin(building),
          stock_lot_id: toBin(collectionStockLot),
          collected_qty: 30 + hatching,
          marketable_qty: 30,
          hatching_qty: hatching,
          ...(options.hatchingProduct !== undefined
            ? { hatching_product_id: toBin(options.hatchingProduct) }
            : {}),
          occurred_at: new Date(`${day}T10:00:00.000Z`),
          status,
          created_by: toBin(admin),
          ...(status === 'CANCELLED'
            ? { cancelled_at: new Date(`${day}T11:00:00.000Z`), cancelled_by: toBin(admin) }
            : {}),
        })
        .execute();
      for (const lineProduct of lines) {
        await uow
          .insertInto('production_egg_collection_lines')
          .values({
            id: toBin(freshUuid()),
            collection_id: toBin(id),
            product_id: toBin(lineProduct),
            quantity: 30,
          })
          .execute();
      }
      return id;
    },
    mortality: async (lotId: string, when: Date, status = 'RECORDED') => {
      const id = freshUuid();
      await uow
        .insertInto('inventory_loss_declarations')
        .values({
          id: toBin(id),
          doc_number: `PRT-T-${id.slice(-8)}`,
          site_id: toBin(site),
          location_id: toBin(building),
          product_id: toBin(product),
          quantity_base: '2',
          unit_code: 'TETE',
          quantity: '2',
          category: 'MORTALITE',
          production_lot_id: toBin(lotId),
          declared_by: toBin(admin),
          status,
          unit_cost_xaf: 0,
          value_xaf: 0,
          occurred_at: when,
          created_by: toBin(admin),
        })
        .execute();
    },
    consumption: async (lotId: string, when: Date, status = 'RECORDED') => {
      await uow
        .insertInto('inventory_consumptions')
        .values({
          id: toBin(freshUuid()),
          cost_object_type: 'PRODUCTION_LOT',
          cost_object_id: toBin(lotId),
          product_id: toBin(product),
          location_id: toBin(building),
          quantity: '5',
          quantity_base: '5',
          unit_code: 'TETE',
          value_xaf: 0,
          occurred_at: when,
          status,
          recorded_by: toBin(admin),
          created_by: toBin(admin),
          ...(status === 'CANCELLED' ? { cancelled_at: when, cancelled_by: toBin(admin) } : {}),
        })
        .execute();
    },
  };

  return { admin, site, building, product, lot, stockLot, entries };
}

async function eventsOf(
  uow: UnitOfWork,
  eventType: string,
  keep: (payload: Record<string, unknown>) => boolean,
) {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', eventType)
    .orderBy('seq', 'desc')
    .limit(3000)
    .execute();
  return rows
    .map((row) => toDomainEvent(row))
    .filter((event) => keep(event.payload as Record<string, unknown>))
    .reverse();
}

const missingFor = (uow: UnitOfWork, lotIds: readonly string[]) =>
  eventsOf(uow, 'DailyEntryMissing', (payload) => lotIds.includes(String(payload['lot_id'])));

describe('production.lots.daily_entry_check (P9-09, AV-462)', () => {
  it('inscrite à l’ordonnanceur, chaque jour à 10:00 ; coût standard à 07:45', () => {
    expect(PRODUCTION_RECURRING_JOBS).toContainEqual({
      jobType: DAILY_ENTRY_MISSING_JOB_TYPE,
      schedule: { kind: 'DAILY', localTime: '10:00' },
    });
    expect(PRODUCTION_RECURRING_JOBS).toContainEqual({
      jobType: STANDARD_COST_MISSING_JOB_TYPE,
      schedule: { kind: 'DAILY', localTime: '07:45' },
    });
    const registry = new RecurringJobRegistry();
    new ProductionRecurringJobs(registry).onModuleInit();
    expect(registry.list()).toEqual(PRODUCTION_RECURRING_JOBS);
  });

  it('un lot en cours sans aucune saisie la veille : un événement par lot, marqueur en dernier', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const silent = await w.lot();
      await dailyRunner()(uow, { scheduledFor: SLOT });

      const events = await missingFor(uow, [silent.id]);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event!.producerModule).toBe('production');
      expect(event!.aggregateType).toBe('PRODUCTION_LOT');
      expect(event!.aggregateId).toBe(silent.id);
      expect(event!.payload).toEqual({
        lot_id: silent.id,
        lot_label: silent.code,
        lot_type: 'POULET_CHAIR',
        missing_day: EXAMINED,
        business_day: EXAMINED,
        site_id: w.site,
        pass_id: `DAILY_ENTRY_MISSING:${SLOT}`,
      });
      // Le marqueur de la passe est publié après les sujets, avec le jour examiné.
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `DAILY_ENTRY_MISSING:${SLOT}`,
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'DAILY_ENTRY_MISSING',
        business_day: EXAMINED,
      });
      expect(markers[0]!.seq).toBeGreaterThan(event!.seq);

      // Rejeu du même créneau : ni sujet ni marqueur de plus.
      await dailyRunner()(uow, { scheduledFor: SLOT });
      expect(await missingFor(uow, [silent.id])).toHaveLength(1);
    }));

  it('chaque nature de saisie du jour examiné compte : observation, pesée, collecte, mortalité, intrant', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const silent = await w.lot();
      const observed = await w.lot();
      const weighed = await w.lot();
      const collected = await w.lot();
      const dead = await w.lot();
      const pendingDead = await w.lot();
      const fed = await w.lot();
      await w.entries.observation(observed.id, at('08:00'));
      await w.entries.weighing(weighed.id, at('09:00'));
      await w.entries.eggCollection(collected.id, collected.stockLotId, EXAMINED);
      await w.entries.mortality(dead.id, at('10:00'), 'RECORDED');
      await w.entries.mortality(pendingDead.id, at('10:30'), 'PENDING_APPROVAL');
      await w.entries.consumption(fed.id, at('11:00'));
      await dailyRunner()(uow, { scheduledFor: SLOT });

      const all = [silent, observed, weighed, collected, dead, pendingDead, fed].map((l) => l.id);
      const events = await missingFor(uow, all);
      expect(events.map((event) => event.aggregateId)).toEqual([silent.id]);
    }));

  it('une saisie annulée, d’un autre jour ou hors des bornes du jour métier ne compte pas', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const cancelledWeighing = await w.lot();
      const cancelledCollection = await w.lot();
      const cancelledConsumption = await w.lot();
      const cancelledDeath = await w.lot();
      const dayBefore = await w.lot();
      const dayAfter = await w.lot();
      const justBefore = await w.lot();
      const startOfDay = await w.lot();
      await w.entries.weighing(cancelledWeighing.id, at('09:00'), 'CANCELLED');
      await w.entries.eggCollection(
        cancelledCollection.id,
        cancelledCollection.stockLotId,
        EXAMINED,
        'CANCELLED',
      );
      await w.entries.consumption(cancelledConsumption.id, at('11:00'), 'CANCELLED');
      await w.entries.mortality(cancelledDeath.id, at('10:00'), 'CANCELLED');
      await w.entries.observation(dayBefore.id, at('12:00', '2019-03-10'));
      await w.entries.observation(dayAfter.id, at('12:00', '2019-03-12'));
      // Jour métier de Douala : UTC+1 — 22:59 UTC la veille est encore la veille, 23:00 UTC est le jour.
      await w.entries.observation(justBefore.id, new Date('2019-03-10T22:59:59.000Z'));
      await w.entries.observation(startOfDay.id, new Date('2019-03-10T23:00:00.000Z'));
      await dailyRunner()(uow, { scheduledFor: SLOT });

      const ids = [
        cancelledWeighing,
        cancelledCollection,
        cancelledConsumption,
        cancelledDeath,
        dayBefore,
        dayAfter,
        justBefore,
      ].map((l) => l.id);
      expect((await missingFor(uow, ids)).map((event) => event.aggregateId).sort()).toEqual(
        [...ids].sort(),
      );
      expect(await missingFor(uow, [startOfDay.id])).toEqual([]);
    }));

  it('lots non examinés : planifié, clos, mis en place le jour même ou après, sans date, sans animal', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const active = await w.lot();
      const selling = await w.lot({ status: 'SELLING' });
      const planned = await w.lot({ status: 'PLANNED' });
      const closed = await w.lot({ status: 'CLOSED' });
      const placedToday = await w.lot({ start: EXAMINED });
      const placedLater = await w.lot({ start: '2019-03-12' });
      const noStart = await w.lot({ start: null });
      const emptied = await w.lot({ heads: 0 });
      // Animaux arrivés après la fin du jour examiné : aucun effectif à la fin du jour.
      const arrivedAfter = await w.lot({ headsAt: '2019-03-12T07:00:00.000Z' });
      await dailyRunner()(uow, { scheduledFor: SLOT });

      const all = [
        active,
        selling,
        planned,
        closed,
        placedToday,
        placedLater,
        noStart,
        emptied,
        arrivedAfter,
      ];
      const events = await missingFor(
        uow,
        all.map((l) => l.id),
      );
      expect(events.map((event) => event.aggregateId).sort()).toEqual(
        [active.id, selling.id].sort(),
      );
    }));

  it('le créneau manqué examine la veille du créneau, non celle de l’exécution (rattrapage)', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const silent = await w.lot();
      // Exécutée le 12 à 09:00, pour le créneau du 10 mars 10:00 : la veille du créneau est le 9.
      await dailyRunner()(uow, { scheduledFor: '2019-03-10T09:00:00.000Z' });
      const [event] = await missingFor(uow, [silent.id]);
      expect(event!.payload).toMatchObject({ missing_day: '2019-03-09' });
    }));

  it('jour sans saisie attendue (réglage) : ni sujet ni marqueur ; un jour attendu est examiné', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const silent = await w.lot();
      // Lundi (1) examiné ; seuls mardi et mercredi sont des jours de saisie.
      settingsOverride.set('production.daily_entry_working_days', ['2', '3']);
      await dailyRunner()(uow, { scheduledFor: SLOT });
      expect(await missingFor(uow, [silent.id])).toEqual([]);
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `DAILY_ENTRY_MISSING:${SLOT}`,
      );
      expect(markers).toEqual([]);

      settingsOverride.set('production.daily_entry_working_days', ['1']);
      await dailyRunner()(uow, { scheduledFor: SLOT });
      expect(await missingFor(uow, [silent.id])).toHaveLength(1);
    }));

  it('bout en bout : alerte levée, puis fermée par le marqueur de la passe suivante quand la saisie est rattrapée', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const catching = await w.lot();
      await dailyRunner()(uow, { scheduledFor: SLOT });
      const [event] = await missingFor(uow, [catching.id]);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'severity', 'title', 'message'])
          .where('dedup_key', '=', `DAILY_ENTRY_MISSING:${catching.id}`)
          .executeTakeFirstOrThrow();
      expect(await alert()).toMatchObject({
        status: 'OPEN',
        severity: 'WARNING',
        title: 'Saisie du jour manquante',
      });
      expect((await alert()).message).toContain(catching.code);

      // La ferme rattrape la saisie de la veille ; une passe du même jour examiné, un autre créneau.
      await w.entries.observation(catching.id, at('15:00'));
      const later = '2019-03-12T09:30:00.000Z';
      await dailyRunner()(uow, { scheduledFor: later });
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `DAILY_ENTRY_MISSING:${later}`,
      );
      expect(markers).toHaveLength(1);
      await handleAlertEvent(uow, markers[0]!, { idGenerator });
      expect(await alert()).toMatchObject({ status: 'RESOLVED' });
    }));

  it('hasDailyEntryOn : la lecture du jour est bornée au jour métier du lot', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const one = await w.lot();
      await w.entries.mortality(one.id, at('10:00'));
      expect(await hasDailyEntryOn(uow, one.id, EXAMINED)).toBe(true);
      expect(await hasDailyEntryOn(uow, one.id, '2019-03-10')).toBe(false);
      expect(await hasDailyEntryOn(uow, freshUuid(), EXAMINED)).toBe(false);
    }));
});

describe('production.products.standard_cost_check (P9-09, AV-463)', () => {
  const TODAY = '2019-03-12';
  const costSlot = new Date('2019-03-12T06:45:00.000Z');
  const costClock = new FixedClock(costSlot);

  async function setStandardCost(
    uow: UnitOfWork,
    admin: string,
    productId: string,
    unitCostXaf: number,
    validFrom: Date,
  ): Promise<void> {
    await uow
      .insertInto('catalog_product_standard_costs')
      .values({
        id: toBin(freshUuid()),
        product_id: toBin(productId),
        unit_cost_xaf: unitCostXaf,
        valid_from: validFrom,
        created_by: toBin(admin),
      })
      .execute();
  }

  const missing = (uow: UnitOfWork, productIds: readonly string[]) =>
    eventsOf(uow, 'StandardCostMissing', (payload) =>
      productIds.includes(String(payload['product_id'])),
    );

  it('produit entré par collecte ou naissance sans coût standard : un événement par produit', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const grade = await insertTestProduct(uow, w.admin);
      const second = await insertTestProduct(uow, w.admin);
      const hatching = await insertTestProduct(uow, w.admin);
      const piglet = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      // Deux collectes du même calibre : le dernier jour d'entrée est retenu.
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-05', 'RECORDED', {
        lines: [grade, second],
      });
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-10', 'RECORDED', {
        lines: [grade],
        hatchingProduct: hatching,
        hatching: 12,
      });
      await uow
        .insertInto('production_lot_entries')
        .values({
          id: toBin(freshUuid()),
          production_lot_id: toBin(lot.id),
          entry_type: 'BIRTH',
          source_kind: 'BIRTH',
          product_id: toBin(piglet),
          quantity_base: '8',
          to_location_id: toBin(w.building),
          occurred_at: at('09:00', '2019-03-11'),
          created_by: toBin(w.admin),
        })
        .execute();
      await costRunner(costClock)(uow, { scheduledFor: costSlot.toISOString() });

      const events = await missing(uow, [grade, second, hatching, piglet]);
      expect(events).toHaveLength(4);
      const byProduct = new Map(
        events.map((event) => [String(event.payload['product_id']), event]),
      );
      expect(byProduct.get(grade)!.payload).toMatchObject({
        entry_day: '2019-03-10',
        business_day: TODAY,
        product_label: 'Produit de test',
      });
      expect(byProduct.get(second)!.payload).toMatchObject({ entry_day: '2019-03-05' });
      expect(byProduct.get(hatching)!.payload).toMatchObject({ entry_day: '2019-03-10' });
      expect(byProduct.get(piglet)!.payload).toMatchObject({ entry_day: '2019-03-11' });
      for (const event of events) {
        expect(event.producerModule).toBe('production');
        expect(event.aggregateType).toBe('PRODUCT');
        expect(event.aggregateId).toBe(
          compositeSubjectId('STANDARD_COST_MISSING', { product_id: event.payload['product_id'] }),
        );
      }
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `STANDARD_COST_MISSING:${costSlot.toISOString()}`,
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'STANDARD_COST_MISSING',
        business_day: TODAY,
      });
      expect(markers[0]!.seq).toBeGreaterThan(Math.max(...events.map((event) => event.seq)));
    }));

  it('un coût standard en vigueur (même à 0 XAF) ferme la condition ; un coût futur ne compte pas encore', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const priced = await insertTestProduct(uow, w.admin);
      const free = await insertTestProduct(uow, w.admin);
      const future = await insertTestProduct(uow, w.admin);
      const late = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-10', 'RECORDED', {
        lines: [priced, free, future, late],
      });
      await setStandardCost(uow, w.admin, priced, 25, new Date('2019-01-01T00:00:00.000Z'));
      await setStandardCost(uow, w.admin, free, 0, new Date('2019-01-01T00:00:00.000Z'));
      await setStandardCost(uow, w.admin, future, 25, new Date('2019-03-13T00:00:00.000Z'));
      // Défini après l'entrée : « aucun coût à la date de l'entrée » ne doit pas rouvrir l'alerte
      // chaque nuit (AV-463 : on teste l'instant de la passe).
      await setStandardCost(uow, w.admin, late, 25, new Date('2019-03-11T12:00:00.000Z'));
      await costRunner(costClock)(uow, { scheduledFor: costSlot.toISOString() });

      const events = await missing(uow, [priced, free, future, late]);
      expect(events.map((event) => event.payload['product_id'])).toEqual([future]);
    }));

  it('fenêtre de revue : entrées annulées, hors fenêtre ou postérieures ignorées ; bornes incluses', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const cancelled = await insertTestProduct(uow, w.admin);
      const old = await insertTestProduct(uow, w.admin);
      const boundary = await insertTestProduct(uow, w.admin);
      const todayEntry = await insertTestProduct(uow, w.admin);
      const later = await insertTestProduct(uow, w.admin);
      const notBirth = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-10', 'CANCELLED', {
        lines: [cancelled],
      });
      // 30 jours avant le 12 mars : le 10 février (inclus) ; le 9 février est hors fenêtre.
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-02-09', 'RECORDED', {
        lines: [old],
      });
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-02-10', 'RECORDED', {
        lines: [boundary],
      });
      await w.entries.eggCollection(lot.id, lot.stockLotId, TODAY, 'RECORDED', {
        lines: [todayEntry],
      });
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-13', 'RECORDED', {
        lines: [later],
      });
      // Une entrée de lot qui n'est pas une naissance n'est pas valorisée au coût standard.
      await uow
        .insertInto('production_lot_entries')
        .values({
          id: toBin(freshUuid()),
          production_lot_id: toBin(lot.id),
          entry_type: 'PLACEMENT',
          source_kind: 'INTERNAL_STOCK',
          product_id: toBin(notBirth),
          quantity_base: '8',
          to_location_id: toBin(w.building),
          occurred_at: at('09:00', '2019-03-11'),
          created_by: toBin(w.admin),
        })
        .execute();
      await costRunner(costClock)(uow, { scheduledFor: costSlot.toISOString() });

      const all = [cancelled, old, boundary, todayEntry, later, notBirth];
      const events = await missing(uow, all);
      expect(events.map((event) => event.payload['product_id']).sort()).toEqual(
        [boundary, todayEntry].sort(),
      );
    }));

  it('la fenêtre est un paramètre : 7 jours, valeur invalide revenant à 30', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const recent = await insertTestProduct(uow, w.admin);
      const tenDays = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-08', 'RECORDED', {
        lines: [recent],
      });
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-02', 'RECORDED', {
        lines: [tenDays],
      });
      settingsOverride.set('production.standard_cost_alert_lookback_days', 7);
      await costRunner(costClock)(uow, { scheduledFor: '2019-03-12T06:45:00.000Z' });
      expect(
        (await missing(uow, [recent, tenDays])).map((event) => event.payload['product_id']),
      ).toEqual([recent]);

      settingsOverride.set('production.standard_cost_alert_lookback_days', -3);
      await costRunner(costClock)(uow, { scheduledFor: '2019-03-12T06:46:00.000Z' });
      const second = await eventsOf(
        uow,
        'StandardCostMissing',
        (payload) =>
          [recent, tenDays].includes(String(payload['product_id'])) &&
          payload['pass_id'] === 'STANDARD_COST_MISSING:2019-03-12T06:46:00.000Z',
      );
      expect(second.map((event) => event.payload['product_id']).sort()).toEqual(
        [recent, tenDays].sort(),
      );
    }));

  it('recentStandardCostProducts : un produit présent par plusieurs sources garde son dernier jour', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const both = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-04', 'RECORDED', {
        lines: [both],
      });
      await uow
        .insertInto('production_lot_entries')
        .values({
          id: toBin(freshUuid()),
          production_lot_id: toBin(lot.id),
          entry_type: 'BIRTH',
          source_kind: 'BIRTH',
          product_id: toBin(both),
          quantity_base: '3',
          to_location_id: toBin(w.building),
          occurred_at: at('23:30', '2019-03-09'), // 00:30 le 10 à Douala
          created_by: toBin(w.admin),
        })
        .execute();
      const found = await recentStandardCostProducts(uow, '2019-03-01', TODAY);
      expect(found.get(both)).toBe('2019-03-10');
    }));

  it('bout en bout : alerte levée, fermée par StandardCostSet ou par le marqueur de la passe suivante', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const eggs = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      await w.entries.eggCollection(lot.id, lot.stockLotId, '2019-03-10', 'RECORDED', {
        lines: [eggs],
      });
      await costRunner(costClock)(uow, { scheduledFor: costSlot.toISOString() });
      const [event] = await missing(uow, [eggs]);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'severity', 'title', 'message'])
          .where('dedup_key', '=', `STANDARD_COST_MISSING:PRODUCT:${eggs}`)
          .executeTakeFirstOrThrow();
      expect(await alert()).toMatchObject({
        status: 'OPEN',
        severity: 'WARNING',
        title: 'Coût standard manquant',
      });
      expect((await alert()).message).toContain('Produit de test');

      // Résolution immédiate : l'événement publié par `catalog.product_standard_cost.set`.
      const registry = new CommandHandlerRegistry();
      registerProductCommands(registry, idGenerator);
      const setCost = registry.resolve('catalog.product_standard_cost.set', 1)!;
      const costId = freshUuid();
      const envelope = {
        command_id: freshUuid(),
        aggregate_id: costId,
        author_user_id: w.admin,
        occurred_at: '2019-03-12T07:00:00.000Z',
        payload: { productId: eggs, unitCostXaf: 40 },
      };
      expect(await setCost.handler(uow, envelope as never)).toEqual({ status: 'APPLIED' });
      const [set] = await eventsOf(
        uow,
        'StandardCostSet',
        (payload) => payload['product_id'] === eggs,
      );
      expect(set).toBeDefined();
      expect(set!.aggregateId).toBe(costId);
      // Rejeu : la version existe, aucun second événement.
      expect(await setCost.handler(uow, envelope as never)).toEqual({ status: 'APPLIED' });
      expect(
        await eventsOf(uow, 'StandardCostSet', (payload) => payload['product_id'] === eggs),
      ).toHaveLength(1);
      await handleAlertEvent(uow, set!, { idGenerator });
      expect(await alert()).toMatchObject({ status: 'RESOLVED' });
    }));

  it('l’alerte d’un produit sorti de la fenêtre est fermée par le marqueur de la passe suivante', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const eggs = await insertTestProduct(uow, w.admin);
      const lot = await w.lot();
      const collection = await w.entries.eggCollection(
        lot.id,
        lot.stockLotId,
        '2019-03-10',
        'RECORDED',
        {
          lines: [eggs],
        },
      );
      await costRunner(costClock)(uow, { scheduledFor: costSlot.toISOString() });
      const [event] = await missing(uow, [eggs]);
      await handleAlertEvent(uow, event!, { idGenerator });

      // La collecte est annulée : plus d'entrée à revoir ; la passe suivante ne republie pas le produit.
      await uow
        .updateTable('production_egg_collections')
        .set({
          status: 'CANCELLED',
          cancelled_at: at('12:00', '2019-03-12'),
          cancelled_by: toBin(w.admin),
        })
        .where('id', '=', toBin(collection))
        .execute();
      const next = '2019-03-12T06:50:00.000Z';
      await costRunner(costClock)(uow, { scheduledFor: next });
      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === `STANDARD_COST_MISSING:${next}`,
      );
      await handleAlertEvent(uow, markers[0]!, { idGenerator });
      const row = await uow
        .selectFrom('communication_alerts')
        .select('status')
        .where('dedup_key', '=', `STANDARD_COST_MISSING:PRODUCT:${eggs}`)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('RESOLVED');
    }));
});
