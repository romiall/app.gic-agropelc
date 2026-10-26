/**
 * P9-08 : passes planifiées de détection d'`inventory` (ADR-061 §3) — filet horaire des seuils de stock
 * (`STOCK_LOW`, `STOCK_OUT`, `POS_REPLENISH`), transferts expédiés non reçus, lots bientôt périmés. Chaque
 * cas tourne dans une transaction annulée (événements immuables, base d'essai partagée) ; le consommateur
 * d'alertes est appelé dans la même transaction pour vérifier la levée et la résolution par marqueur.
 *
 * Les passes lisent **toute** la base d'essai (les seuils, les transferts et les lots d'autres fichiers) :
 * les assertions ne retiennent que les objets créés par le cas.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, businessDayOf } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  STOCK_THRESHOLD_SWEEP_JOB_TYPE,
  StockThresholdSweepJob,
} from '../src/modules/inventory/application/jobs/stock-threshold-sweep-job.js';
import {
  TRANSFER_NOT_RECEIVED_JOB_TYPE,
  TransferNotReceivedJob,
} from '../src/modules/inventory/application/jobs/transfer-not-received-job.js';
import {
  LOT_EXPIRING_JOB_TYPE,
  LotExpiringJob,
} from '../src/modules/inventory/application/jobs/lot-expiring-job.js';
import { INVENTORY_RECURRING_JOBS } from '../src/modules/inventory/application/jobs/inventory-recurring-jobs.js';
import { toDomainEvent, type DomainEvent } from '../src/platform/events/domain-event.js';
import { PASS_COMPLETED_EVENT } from '../src/platform/events/detection-events.js';
import { publishStockLevelEvent } from '../src/modules/inventory/application/inventory-alert-events.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

vi.setConfig({ testTimeout: 180_000 });

/**
 * 06:30 à Douala, jour métier du 10 novembre **2020** : volontairement dans le passé lointain. Les passes
 * de péremption et de transferts lisent toute la base partagée ; les lots et les transferts committés par
 * d'autres fichiers sont datés de 2026 et ne sont donc ni « périmés » ni « échus » ici. Ramener cette date
 * en 2026 ferait publier à ces passes des centaines d'événements (retard des consommateurs).
 */
const NOW = new Date('2020-11-10T05:30:00.000Z');
const TODAY = businessDayOf(NOW);
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);

afterAll(closeTestDb);

function handlerOf<T extends { onModuleInit(): void }>(
  jobType: string,
  build: (registry: JobHandlerRegistry) => T,
) {
  const registry = new JobHandlerRegistry();
  build(registry).onModuleInit();
  return registry.resolve(jobType)!;
}

const sweep = () =>
  handlerOf(
    STOCK_THRESHOLD_SWEEP_JOB_TYPE,
    (registry) => new StockThresholdSweepJob(clock, idGenerator, registry),
  );
const notReceived = () =>
  handlerOf(
    TRANSFER_NOT_RECEIVED_JOB_TYPE,
    (registry) => new TransferNotReceivedJob(clock, idGenerator, registry),
  );
const expiring = () =>
  handlerOf(LOT_EXPIRING_JOB_TYPE, (registry) => new LotExpiringJob(clock, idGenerator, registry));

async function world(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const site = await insertTestSite(uow, admin, zone);
  const otherSite = await insertTestSite(uow, admin, zone);
  const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
  const pos = await insertTestLocation(uow, admin, site, { locationType: 'POS' });
  const otherStore = await insertTestLocation(uow, admin, otherSite, { locationType: 'STORE' });
  return { admin, zone, site, otherSite, store, pos, otherStore };
}

/**
 * La passe lit tous les seuils actifs de la base d'essai partagée : sans cela, chaque exécution publierait
 * des centaines d'événements (autant de numéros de séquence repris par des tombstones) et ferait prendre du
 * retard aux consommateurs des autres fichiers. Transaction annulée : aucun seuil n'est réellement touché.
 */
async function quietThresholds(uow: UnitOfWork): Promise<void> {
  await uow
    .updateTable('inventory_stock_thresholds')
    .set({ is_active: 0 })
    .where('is_active', '=', 1)
    .execute();
}

async function threshold(
  uow: UnitOfWork,
  admin: string,
  locationId: string,
  productId: string,
  min: number,
  target: number,
): Promise<void> {
  await uow
    .insertInto('inventory_stock_thresholds')
    .values({
      id: toBin(freshUuid()),
      location_id: toBin(locationId),
      product_id: toBin(productId),
      min_qty_base: String(min),
      target_qty_base: String(target),
      is_active: 1,
      created_by: toBin(admin),
    })
    .execute();
}

async function putStock(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
  qty: number,
  lotKey: Buffer = Buffer.alloc(16),
): Promise<void> {
  await uow
    .insertInto('inventory_stock_balances')
    .values({
      location_id: toBin(locationId),
      product_id: toBin(productId),
      lot_key: lotKey,
      qty_on_hand: String(qty),
      value_xaf: 0,
      last_move_at: NOW,
      row_version: 1,
    })
    .execute();
}

async function setGlobalSetting(
  uow: UnitOfWork,
  admin: string,
  key: string,
  value: unknown,
): Promise<void> {
  await uow
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: jsonValue(value),
      scope_type: 'GLOBAL',
      scope_id: null,
      valid_from: new Date('2020-11-01T00:00:00.000Z'),
      is_client_visible: 0,
      reason: 'Réglage de test P9-08',
      created_by: toBin(admin),
    })
    .execute();
}

async function setSiteSetting(
  uow: UnitOfWork,
  admin: string,
  siteId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await uow
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: jsonValue(value),
      scope_type: 'SITE',
      scope_id: toBin(siteId),
      valid_from: new Date('2020-11-01T00:00:00.000Z'),
      is_client_visible: 0,
      reason: 'Réglage de test P9-08',
      created_by: toBin(admin),
    })
    .execute();
}

/** Événements d'un type, dans l'ordre, dont la charge utile satisfait le filtre. */
async function eventsOf(
  uow: UnitOfWork,
  eventType: string,
  keep: (payload: Record<string, unknown>) => boolean,
): Promise<DomainEvent[]> {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', eventType)
    .orderBy('seq', 'desc')
    .limit(5000)
    .execute();
  return rows
    .map((row) => toDomainEvent(row))
    .filter((event) => keep(event.payload as Record<string, unknown>))
    .reverse();
}

const markersOf = async (uow: UnitOfWork, alertType: string, passId?: string) =>
  (
    await eventsOf(uow, PASS_COMPLETED_EVENT, (payload) => payload['alert_type'] === alertType)
  ).filter(
    (event) => passId === undefined || (event.payload as { pass_id: string }).pass_id === passId,
  );

async function consume(uow: UnitOfWork, events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) await handleAlertEvent(uow, event, { idGenerator });
}

const countInserts = (uow: UnitOfWork) => {
  const inserts = { count: 0 };
  const counted = uow.withPlugin({
    transformQuery(args) {
      const node = args.node;
      if (
        node.kind === 'InsertQueryNode' &&
        node.into?.table.identifier.name === 'platform_domain_events'
      ) {
        inserts.count += 1;
      }
      return node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { counted, inserts };
};

describe('tâche inventory.alerts.stock_threshold_sweep (P9-08)', () => {
  it('inscrite à l’ordonnanceur : toutes les heures', () => {
    expect(INVENTORY_RECURRING_JOBS).toContainEqual({
      jobType: STOCK_THRESHOLD_SWEEP_JOB_TYPE,
      schedule: { kind: 'INTERVAL', intervalSeconds: 3600 },
    });
    expect(INVENTORY_RECURRING_JOBS).toContainEqual({
      jobType: LOT_EXPIRING_JOB_TYPE,
      schedule: { kind: 'DAILY', localTime: '06:00' },
    });
    expect(INVENTORY_RECURRING_JOBS).toContainEqual({
      jobType: TRANSFER_NOT_RECEIVED_JOB_TYPE,
      schedule: { kind: 'DAILY', localTime: '06:30' },
    });
  });

  it('publie chaque couple bas ou en rupture avec l’identité de passe, puis les trois marqueurs', () =>
    rolledBack(async (uow) => {
      const { admin, site, store } = await world(uow);
      await quietThresholds(uow);
      const low = await insertTestProduct(uow, admin);
      const out = await insertTestProduct(uow, admin);
      const fine = await insertTestProduct(uow, admin);
      await putStock(uow, store, low, 4);
      await putStock(uow, store, fine, 50);
      await threshold(uow, admin, store, low, 10, 30);
      await threshold(uow, admin, store, out, 10, 30); // aucun solde : rupture
      await threshold(uow, admin, store, fine, 10, 30);

      const slot = '2020-11-10T05:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot });
      const mine = (payload: Record<string, unknown>) => payload['location_id'] === store;
      const events = await eventsOf(uow, 'StockThresholdBreached', mine);
      const summary = events.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return [payload['product_id'], payload['level'], payload['breached']];
      });
      expect(summary).toEqual(
        expect.arrayContaining([
          [low, 'LOW', true],
          [out, 'OUT', true],
        ]),
      );
      expect(summary).toHaveLength(2);
      const lowEvent = events.find(
        (e) => (e.payload as { product_id: string }).product_id === low,
      )!;
      expect(lowEvent.payload).toMatchObject({
        available: 4,
        threshold: 10,
        target: 30,
        site_id: site,
        business_day: TODAY,
        pass_id: `STOCK_LOW:${slot}`,
      });
      expect(
        (
          events.find((e) => (e.payload as { product_id: string }).product_id === out)!.payload as {
            pass_id: string;
          }
        ).pass_id,
      ).toBe(`STOCK_OUT:${slot}`);
      for (const type of ['STOCK_LOW', 'STOCK_OUT', 'POS_REPLENISH']) {
        expect(await markersOf(uow, type, `${type}:${slot}`)).toHaveLength(1);
      }
    }));

  it('rejeu du même créneau : aucun INSERT ; un autre créneau republie', () =>
    rolledBack(async (uow) => {
      const { admin, store } = await world(uow);
      await quietThresholds(uow);
      const product = await insertTestProduct(uow, admin);
      await putStock(uow, store, product, 4);
      await threshold(uow, admin, store, product, 10, 30);
      const slot = '2020-11-10T05:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot });
      const { counted, inserts } = countInserts(uow);
      await sweep()(counted, { scheduledFor: slot });
      expect(inserts.count).toBe(0);
      // Un autre créneau republie exactement : l'événement du couple bas et les trois marqueurs.
      await sweep()(counted, { scheduledFor: '2020-11-10T06:00:00.000Z' });
      expect(inserts.count).toBe(4);
    }));

  it('point de vente : suggestion sous la cible (défaut), transit entrant déduit, sous le minimum au choix', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, pos } = await world(uow);
      await quietThresholds(uow);
      const bulk = await insertTestProduct(uow, admin);
      const covered = await insertTestProduct(uow, admin);
      const lowAndOut = await insertTestProduct(uow, admin);
      await putStock(uow, pos, bulk, 20); // correct (≥ 10) mais sous la cible 30
      await putStock(uow, pos, covered, 20); // cible couverte par le transit entrant
      await putStock(uow, pos, lowAndOut, 4);
      await threshold(uow, admin, pos, bulk, 10, 30);
      await threshold(uow, admin, pos, covered, 10, 30);
      await threshold(uow, admin, pos, lowAndOut, 10, 30);
      await threshold(uow, admin, store, bulk, 10, 30); // STORE : jamais de réapprovisionnement
      const partial = await insertTestProduct(uow, admin);
      const empty = await insertTestProduct(uow, admin);
      await putStock(uow, pos, partial, 20); // cible 30, 5 en transit : reste 5 à suggérer
      await threshold(uow, admin, pos, partial, 10, 30);
      await threshold(uow, admin, pos, empty, 10, 30); // aucun solde : rupture et suggestion pleine
      // Configuration du PDV : son magasin source (BR-DIS, `organization_points_of_sale`).
      await uow
        .insertInto('organization_points_of_sale')
        .values({
          site_id: toBin(site),
          sales_location_id: toBin(pos),
          replenishment_source_location_id: toBin(store),
          custody_mode: 'SHARED',
          created_by: toBin(admin),
        })
        .execute();

      // Un transfert expédié vers le PDV : 10 unités de `covered` en transit (cible 30 = 20 + 10).
      const transferId = freshUuid();
      await uow
        .insertInto('inventory_stock_transfers')
        .values({
          id: toBin(transferId),
          doc_number: `TRF-${transferId.slice(-8)}`,
          site_id: toBin(site),
          from_location_id: toBin(store),
          to_location_id: toBin(pos),
          status: 'DISPATCHED',
          dispatched_by: toBin(admin),
          dispatched_at: new Date(NOW.getTime() - 3_600_000),
          occurred_at: new Date(NOW.getTime() - 3_600_000),
          created_by: toBin(admin),
        })
        .execute();
      await uow
        .insertInto('inventory_stock_transfer_lines')
        .values({
          id: toBin(freshUuid()),
          transfer_id: toBin(transferId),
          product_id: toBin(covered),
          unit_code: 'TETE',
          dispatched_qty_base: '10',
        })
        .execute();
      await uow
        .insertInto('inventory_stock_transfer_lines')
        .values({
          id: toBin(freshUuid()),
          transfer_id: toBin(transferId),
          product_id: toBin(partial),
          unit_code: 'TETE',
          dispatched_qty_base: '5',
        })
        .execute();

      const mine = (payload: Record<string, unknown>) => payload['location_id'] === pos;
      await sweep()(uow, { scheduledFor: '2020-11-10T05:00:00.000Z' });
      const suggested = await eventsOf(uow, 'ReplenishmentSuggested', mine);
      const byProduct = new Map(
        suggested.map((event) => [
          (event.payload as { product_id: string }).product_id,
          event.payload as Record<string, unknown>,
        ]),
      );
      expect([...byProduct.keys()].sort()).toEqual([bulk, lowAndOut, partial, empty].sort());
      expect(byProduct.get(bulk)).toMatchObject({
        suggested_quantity: 10,
        available: 20,
        min_quantity: 10,
        target_quantity: 30,
        in_transit_in: 0,
        site_id: site,
        business_day: TODAY,
        location_label: 'Emplacement de test',
        // Magasin source du PDV (configuration du point de vente).
        source_location_id: store,
        source_location_label: 'Emplacement de test',
      });
      expect(byProduct.get(lowAndOut)).toMatchObject({ suggested_quantity: 26 });
      // Transit partiel : 30 − 20 − 5 = 5 ; le transit entrant est reporté dans la charge utile.
      expect(byProduct.get(partial)).toMatchObject({ suggested_quantity: 5, in_transit_in: 5 });
      // Point de vente à zéro : suggestion pleine, et la rupture est signalée par le même filet.
      expect(byProduct.get(empty)).toMatchObject({ suggested_quantity: 30, available: 0 });
      const posLevels = (
        await eventsOf(
          uow,
          'StockThresholdBreached',
          (p) => p['location_id'] === pos && p['product_id'] === empty,
        )
      ).map((event) => (event.payload as { level: string }).level);
      expect(posLevels).toEqual(['OUT']);
      // Aucun événement de réapprovisionnement pour un emplacement `STORE`.
      expect(
        await eventsOf(uow, 'ReplenishmentSuggested', (p) => p['location_id'] === store),
      ).toEqual([]);

      // `BELOW_MINIMUM` : seul le PDV réellement sous son minimum reste signalé.
      await setGlobalSetting(uow, admin, 'inventory.replenish_alert_scope', 'BELOW_MINIMUM');
      await sweep()(uow, { scheduledFor: '2020-11-10T06:00:00.000Z' });
      const second = (
        await eventsOf(
          uow,
          'ReplenishmentSuggested',
          (p) => mine(p) && String(p['pass_id']).endsWith('2020-11-10T06:00:00.000Z'),
        )
      ).map((event) => (event.payload as { product_id: string }).product_id);
      // Sous le minimum : le point de vente à zéro (rupture) et celui à 4 ; `partial` (20 ≥ 10) sort.
      expect([...second].sort()).toEqual([lowAndOut, empty].sort());
    }));

  it('relais : l’alerte levée par une transition est gardée par la passe puis résolue par son marqueur ; STOCK_OUT de même', () =>
    rolledBack(async (uow) => {
      const { admin, site, store } = await world(uow);
      await quietThresholds(uow);
      const product = await insertTestProduct(uow, admin);
      await putStock(uow, store, product, 4);
      await threshold(uow, admin, store, product, 10, 30);
      const mine = (payload: Record<string, unknown>) =>
        payload['location_id'] === store && payload['product_id'] === product;
      const alert = (type: string) =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'resolution_kind', 'last_pass_id', 'occurrences'])
          .where('dedup_key', '=', `${type}:STOCK_POSITION:${store}:${product}`)
          .executeTakeFirst();
      const seen = new Set<number>();
      const startSeq = Number(
        (
          await uow
            .selectFrom('platform_domain_events')
            .select(sql<string>`COALESCE(MAX(seq), 0)`.as('seq'))
            .executeTakeFirstOrThrow()
        ).seq,
      );
      const consumeNew = async () => {
        const fresh = [
          ...(await eventsOf(uow, 'StockThresholdBreached', mine)),
          ...(await markersOf(uow, 'STOCK_LOW')),
          ...(await markersOf(uow, 'STOCK_OUT')),
        ]
          .filter((event) => event.seq > startSeq && !seen.has(event.seq))
          .sort((a, b) => a.seq - b.seq);
        for (const event of fresh) seen.add(event.seq);
        await consume(uow, fresh);
      };

      // 1. Levée par une transition sur mouvement : aucune identité de passe.
      await publishStockLevelEvent(
        uow,
        { idGenerator, clock },
        {
          locationId: store,
          productId: product,
          level: 'LOW',
          breached: true,
          available: 4,
          thresholdQty: 10,
          targetQty: 30,
          locationLabel: 'Emplacement de test',
          productLabel: 'Produit de test',
          siteId: site,
          businessDay: TODAY,
          occurredAt: NOW,
        },
      );
      await consumeNew();
      expect(await alert('STOCK_LOW')).toMatchObject({
        status: 'OPEN',
        last_pass_id: null,
        occurrences: 1,
      });

      // 2. La passe revoit le couple (toujours bas) : elle le garde ouvert et prend l'identité.
      const slot1 = '2020-11-10T05:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot1 });
      await consumeNew();
      expect(await alert('STOCK_LOW')).toMatchObject({
        status: 'OPEN',
        last_pass_id: `STOCK_LOW:${slot1}`,
        occurrences: 2,
      });

      // 3. Rupture : la passe lève STOCK_OUT et résout STOCK_LOW (non revu).
      await uow
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '0' })
        .where('location_id', '=', toBin(store))
        .where('product_id', '=', toBin(product))
        .execute();
      const slot2 = '2020-11-10T06:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot2 });
      await consumeNew();
      expect(await alert('STOCK_LOW')).toMatchObject({
        status: 'RESOLVED',
        resolution_kind: 'PASS',
      });
      expect(await alert('STOCK_OUT')).toMatchObject({
        status: 'OPEN',
        last_pass_id: `STOCK_OUT:${slot2}`,
      });

      // 4. Stock rétabli : le marqueur résout STOCK_OUT.
      await uow
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '40' })
        .where('location_id', '=', toBin(store))
        .where('product_id', '=', toBin(product))
        .execute();
      await sweep()(uow, { scheduledFor: '2020-11-10T07:00:00.000Z' });
      await consumeNew();
      expect(await alert('STOCK_OUT')).toMatchObject({
        status: 'RESOLVED',
        resolution_kind: 'PASS',
      });
    }));

  it('POS_REPLENISH : levée par la passe, résolue par son marqueur quand le point de vente est réapprovisionné', () =>
    rolledBack(async (uow) => {
      const { admin, pos } = await world(uow);
      await quietThresholds(uow);
      const product = await insertTestProduct(uow, admin);
      await putStock(uow, pos, product, 20);
      await threshold(uow, admin, pos, product, 10, 30);
      const status = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'resolution_kind', 'severity'])
          .where('dedup_key', '=', `POS_REPLENISH:POS_PRODUCT:${pos}:${product}`)
          .executeTakeFirst();
      const mine = (payload: Record<string, unknown>) =>
        payload['location_id'] === pos && payload['product_id'] === product;

      const slot1 = '2020-11-10T05:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot1 });
      await consume(uow, [
        ...(await eventsOf(uow, 'ReplenishmentSuggested', mine)),
        ...(await markersOf(uow, 'POS_REPLENISH', `POS_REPLENISH:${slot1}`)),
      ]);
      expect(await status()).toMatchObject({ status: 'OPEN', severity: 'WARNING' });

      await uow
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '35' })
        .where('location_id', '=', toBin(pos))
        .where('product_id', '=', toBin(product))
        .execute();
      const slot2 = '2020-11-10T06:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot2 });
      await consume(uow, await markersOf(uow, 'POS_REPLENISH', `POS_REPLENISH:${slot2}`));
      expect(await status()).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
    }));

  it('bout en bout : levée par la passe, résolue par le marqueur de la passe suivante', () =>
    rolledBack(async (uow) => {
      const { admin, store } = await world(uow);
      await quietThresholds(uow);
      const product = await insertTestProduct(uow, admin);
      await putStock(uow, store, product, 4);
      await threshold(uow, admin, store, product, 10, 30);
      const mine = (payload: Record<string, unknown>) =>
        payload['location_id'] === store && payload['product_id'] === product;
      const lowKey = `STOCK_LOW:STOCK_POSITION:${store}:${product}`;
      const status = async () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'resolution_kind', 'last_pass_id'])
          .where('dedup_key', '=', lowKey)
          .executeTakeFirst();

      const slot1 = '2020-11-10T05:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot1 });
      const first = await eventsOf(uow, 'StockThresholdBreached', mine);
      await consume(uow, [...first, ...(await markersOf(uow, 'STOCK_LOW', `STOCK_LOW:${slot1}`))]);
      expect(await status()).toMatchObject({ status: 'OPEN', last_pass_id: `STOCK_LOW:${slot1}` });

      // Le stock remonte sans aucun mouvement observé par un événement : la passe suivante le constate.
      await uow
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '40' })
        .where('location_id', '=', toBin(store))
        .where('product_id', '=', toBin(product))
        .execute();
      const slot2 = '2020-11-10T06:00:00.000Z';
      await sweep()(uow, { scheduledFor: slot2 });
      await consume(uow, await markersOf(uow, 'STOCK_LOW', `STOCK_LOW:${slot2}`));
      expect(await status()).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
    }));
});

async function dispatchedTransfer(
  uow: UnitOfWork,
  input: {
    readonly admin: string;
    readonly siteId: string;
    readonly from: string;
    readonly to: string;
    readonly hoursAgo: number;
    readonly status?: string;
    readonly kind?: string;
  },
): Promise<string> {
  const id = freshUuid();
  const at = new Date(NOW.getTime() - input.hoursAgo * 3_600_000);
  const kind = input.kind ?? 'STANDARD';
  await uow
    .insertInto('inventory_stock_transfers')
    .values({
      id: toBin(id),
      doc_number: `TRF-${id.slice(-8)}`,
      site_id: toBin(input.siteId),
      transfer_kind: kind,
      from_location_id: toBin(input.from),
      to_location_id: toBin(input.to),
      status: input.status ?? 'DISPATCHED',
      dispatched_by: kind === 'BLIND_RECEIPT' ? null : toBin(input.admin),
      dispatched_at: kind === 'BLIND_RECEIPT' ? null : at,
      occurred_at: at,
      created_by: toBin(input.admin),
    })
    .execute();
  return id;
}

describe('tâche inventory.alerts.transfer_not_received_check (P9-08, AV-408)', () => {
  it('signale le transfert standard expédié au-delà du délai, avec ses destinataires ; marqueur', () =>
    rolledBack(async (uow) => {
      const { admin, site, otherSite, store, otherStore } = await world(uow);
      const recipient = await insertTestUser(uow);
      const mobile = freshUuid();
      await uow
        .insertInto('organization_locations')
        .values({
          id: toBin(mobile),
          site_id: toBin(otherSite),
          code: `MOB${mobile.slice(-8).toUpperCase()}`,
          name: 'Véhicule de test',
          location_type: 'MOBILE',
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: toBin(recipient),
          created_by: toBin(admin),
        })
        .execute();
      const late = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: mobile,
        hoursAgo: 72,
      });
      const boundary = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: otherStore,
        hoursAgo: 48,
      });
      const recent = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: otherStore,
        hoursAgo: 47,
      });
      const received = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: otherStore,
        hoursAgo: 90,
        status: 'RECEIVED',
      });
      const blind = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: otherStore,
        to: store,
        hoursAgo: 90,
        status: 'UNMATCHED',
        kind: 'BLIND_RECEIPT',
      });

      const slot = '2020-11-10T05:00:00.000Z';
      await notReceived()(uow, { scheduledFor: slot });
      const ids = new Set([late, boundary, recent, received, blind]);
      const events = await eventsOf(uow, 'StockTransferNotReceived', (payload) =>
        ids.has(String(payload['transfer_id'])),
      );
      expect(events.map((e) => (e.payload as { transfer_id: string }).transfer_id).sort()).toEqual(
        [late, boundary].sort(),
      );
      const lateEvent = events.find(
        (e) => (e.payload as { transfer_id: string }).transfer_id === late,
      )!;
      expect(lateEvent.aggregateId).toBe(late);
      expect(lateEvent.payload).toMatchObject({
        doc_number: `TRF-${late.slice(-8)}`,
        hours_elapsed: 72,
        threshold_hours: 48,
        sender_user_id: admin,
        recipient_user_id: recipient,
        // L'alerte est rattachée au site qui doit recevoir.
        site_id: otherSite,
        source_site_id: site,
        business_day: TODAY,
        pass_id: `TRANSFER_NOT_RECEIVED:${slot}`,
      });
      expect(
        (
          events.find((e) => (e.payload as { transfer_id: string }).transfer_id === boundary)!
            .payload as { recipient_user_id: unknown }
        ).recipient_user_id,
      ).toBeNull();
      expect(
        await markersOf(uow, 'TRANSFER_NOT_RECEIVED', `TRANSFER_NOT_RECEIVED:${slot}`),
      ).toHaveLength(1);
    }));

  it('délai du site de l’expéditeur : 24 h réglées ; rejeu du créneau sans insertion', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, otherStore } = await world(uow);
      const transfer = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: otherStore,
        hoursAgo: 30,
      });
      const mine = (payload: Record<string, unknown>) => payload['transfer_id'] === transfer;
      const slot = '2020-11-10T05:00:00.000Z';
      await notReceived()(uow, { scheduledFor: slot });
      expect(await eventsOf(uow, 'StockTransferNotReceived', mine)).toHaveLength(0);

      await setSiteSetting(uow, admin, site, 'inventory.transfer_not_received_hours', 24);
      await notReceived()(uow, { scheduledFor: '2020-11-10T05:00:01.000Z' });
      expect(await eventsOf(uow, 'StockTransferNotReceived', mine)).toHaveLength(1);

      const { counted, inserts } = countInserts(uow);
      await notReceived()(counted, { scheduledFor: '2020-11-10T05:00:01.000Z' });
      expect(inserts.count).toBe(0);
    }));

  it('bout en bout : levée, puis résolue par le marqueur quand le transfert est reçu', () =>
    rolledBack(async (uow) => {
      const { admin, site, store, otherStore } = await world(uow);
      const transfer = await dispatchedTransfer(uow, {
        admin,
        siteId: site,
        from: store,
        to: otherStore,
        hoursAgo: 60,
      });
      const mine = (payload: Record<string, unknown>) => payload['transfer_id'] === transfer;
      const status = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'resolution_kind', 'owner_user_id'])
          .where('dedup_key', '=', `TRANSFER_NOT_RECEIVED:${transfer}`)
          .executeTakeFirst();

      const slot1 = '2020-11-10T05:00:00.000Z';
      await notReceived()(uow, { scheduledFor: slot1 });
      await consume(uow, [
        ...(await eventsOf(uow, 'StockTransferNotReceived', mine)),
        ...(await markersOf(uow, 'TRANSFER_NOT_RECEIVED', `TRANSFER_NOT_RECEIVED:${slot1}`)),
      ]);
      const open = await status();
      expect(open).toMatchObject({ status: 'OPEN' });
      expect(fromBin(open!.owner_user_id as Buffer)).toBe(admin);

      await uow
        .updateTable('inventory_stock_transfers')
        .set({ status: 'RECEIVED', received_at: NOW, received_by: toBin(admin) })
        .where('id', '=', toBin(transfer))
        .execute();
      const slot2 = '2020-11-11T05:00:00.000Z';
      await notReceived()(uow, { scheduledFor: slot2 });
      await consume(
        uow,
        await markersOf(uow, 'TRANSFER_NOT_RECEIVED', `TRANSFER_NOT_RECEIVED:${slot2}`),
      );
      expect(await status()).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
    }));
});

async function lot(
  uow: UnitOfWork,
  admin: string,
  productId: string | null,
  expiry: string | null,
  options: { readonly status?: string } = {},
): Promise<string> {
  const id = freshUuid();
  await uow
    .insertInto('inventory_stock_lots')
    .values({
      id: toBin(id),
      lot_code: `L-${id.slice(-12)}`,
      product_id: productId === null ? null : toBin(productId),
      origin_type: 'SUPPLIER_LOT',
      expiry_date: expiry === null ? null : new Date(`${expiry}T00:00:00.000Z`),
      fifo_rank_at: NOW,
      status: options.status ?? 'OPEN',
      created_by: toBin(admin),
    })
    .execute();
  return id;
}

describe('tâche inventory.alerts.lot_expiring_daily (P9-08, AV-404)', () => {
  it('lots périmant dans l’horizon ou déjà périmés, avec du stock physique ; un événement par lot et site', () =>
    rolledBack(async (uow) => {
      const { admin, site, otherSite, store, otherStore } = await world(uow);
      const product = await insertTestProduct(uow, admin);
      const soon = await lot(uow, admin, product, '2020-11-20'); // J+10
      const boundary = await lot(uow, admin, product, '2020-11-25'); // J+15
      const beyond = await lot(uow, admin, product, '2020-11-26'); // J+16
      const expired = await lot(uow, admin, product, '2020-11-07'); // J−3
      const empty = await lot(uow, admin, product, '2020-11-12');
      const noDate = await lot(uow, admin, product, null);
      const closed = await lot(uow, admin, product, '2020-11-12', { status: 'CLOSED' });
      const twoSites = await lot(uow, admin, product, '2020-11-15');
      for (const [id, qty] of [
        [soon, 5],
        [boundary, 7],
        [beyond, 9],
        [expired, 2],
        [noDate, 4],
        [closed, 3],
      ] as const) {
        await putStock(uow, store, product, qty, toBin(id));
      }
      await putStock(uow, store, product, 0, toBin(empty));
      await putStock(uow, store, product, 3, toBin(twoSites));
      await putStock(uow, otherStore, product, 6, toBin(twoSites));

      const slot = '2020-11-10T05:00:00.000Z';
      await expiring()(uow, { scheduledFor: slot });
      const lots = new Set([soon, boundary, beyond, expired, empty, noDate, closed, twoSites]);
      const events = await eventsOf(uow, 'LotExpiringDetected', (payload) =>
        lots.has(String(payload['lot_id'])),
      );
      const keyOf = (event: DomainEvent) => {
        const payload = event.payload as { lot_id: string; site_id: string };
        return `${payload.lot_id}|${payload.site_id}`;
      };
      expect(events.map(keyOf).sort()).toEqual(
        [
          `${soon}|${site}`,
          `${boundary}|${site}`,
          `${expired}|${site}`,
          `${twoSites}|${site}`,
          `${twoSites}|${otherSite}`,
        ].sort(),
      );
      const soonEvent = events.find((event) => keyOf(event) === `${soon}|${site}`)!;
      expect(soonEvent.payload).toMatchObject({
        product_id: product,
        product_label: 'Produit de test',
        origin_type: 'SUPPLIER_LOT',
        expiry_date: '2020-11-20',
        days_left: 10,
        quantity: 5,
        business_day: TODAY,
        pass_id: `LOT_EXPIRING:${slot}`,
      });
      expect(
        (
          events.find((event) => keyOf(event) === `${expired}|${site}`)!.payload as {
            days_left: number;
          }
        ).days_left,
      ).toBe(-3);
      expect(await markersOf(uow, 'LOT_EXPIRING', `LOT_EXPIRING:${slot}`)).toHaveLength(1);
    }));

  it('lot multi-produits (collecte à plusieurs calibres) : un événement par produit, quantité et libellé du produit', () =>
    rolledBack(async (uow) => {
      const { admin, site, store } = await world(uow);
      const first = await insertTestProduct(uow, admin);
      const second = await insertTestProduct(uow, admin);
      const id = await lot(uow, admin, null, '2020-11-20');
      await putStock(uow, store, first, 3, toBin(id));
      await putStock(uow, store, second, 4, toBin(id));
      await expiring()(uow, { scheduledFor: '2020-11-10T05:00:00.000Z' });
      const events = await eventsOf(uow, 'LotExpiringDetected', (p) => p['lot_id'] === id);
      const byProduct = new Map(
        events.map((event) => [
          (event.payload as { product_id: string }).product_id,
          event.payload as Record<string, unknown>,
        ]),
      );
      expect([...byProduct.keys()].sort()).toEqual([first, second].sort());
      expect(byProduct.get(first)).toMatchObject({ quantity: 3, site_id: site });
      expect(byProduct.get(second)).toMatchObject({ quantity: 4, site_id: site });
      // Deux sujets distincts : le consommateur lève deux alertes, aucune charge utile n'écrase l'autre.
      await consume(uow, events);
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select('dedup_key')
        .where('dedup_key', 'in', [
          `LOT_EXPIRING:STOCK_LOT:${id}:${site}:${first}`,
          `LOT_EXPIRING:STOCK_LOT:${id}:${site}:${second}`,
        ])
        .execute();
      expect(alerts).toHaveLength(2);
    }));

  it('horizon réglable : 0 jour = périmant aujourd’hui ou déjà périmés ; stock virtuel ignoré', () =>
    rolledBack(async (uow) => {
      const { admin, store } = await world(uow);
      const product = await insertTestProduct(uow, admin);
      const today = await lot(uow, admin, product, TODAY);
      const tomorrow = await lot(uow, admin, product, '2020-11-11');
      await putStock(uow, store, product, 1, toBin(today));
      await putStock(uow, store, product, 1, toBin(tomorrow));
      const virtualRow = await uow
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_TRANSIT')
        .executeTakeFirstOrThrow();
      const inTransitOnly = await lot(uow, admin, product, TODAY);
      await putStock(uow, fromBin(virtualRow.id), product, 5, toBin(inTransitOnly));
      // L'emplacement « à livrer » d'un site est virtuel **et** rattaché à un site : seul le drapeau
      // virtuel l'exclut (le stock d'une vente en attente de livraison n'est pas à écouler par le magasinier).
      const site = await uow
        .selectFrom('organization_locations')
        .select('site_id')
        .where('id', '=', toBin(store))
        .executeTakeFirstOrThrow();
      const toDeliver = await insertTestLocation(uow, admin, fromBin(site.site_id!), {
        locationType: 'V_TO_DELIVER',
      });
      const toDeliverOnly = await lot(uow, admin, product, TODAY);
      await putStock(uow, toDeliver, product, 2, toBin(toDeliverOnly));

      await setGlobalSetting(uow, admin, 'inventory.lot_expiring_days', 0);
      await expiring()(uow, { scheduledFor: '2020-11-10T05:00:00.000Z' });
      const lots = new Set([today, tomorrow, inTransitOnly, toDeliverOnly]);
      const events = await eventsOf(uow, 'LotExpiringDetected', (payload) =>
        lots.has(String(payload['lot_id'])),
      );
      expect(events.map((event) => (event.payload as { lot_id: string }).lot_id)).toEqual([today]);
    }));

  it('bout en bout : levée, puis résolue quand le stock du lot disparaît', () =>
    rolledBack(async (uow) => {
      const { admin, site, store } = await world(uow);
      const product = await insertTestProduct(uow, admin);
      const id = await lot(uow, admin, product, '2020-11-20');
      await putStock(uow, store, product, 5, toBin(id));
      const mine = (payload: Record<string, unknown>) => payload['lot_id'] === id;
      const status = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'resolution_kind', 'severity'])
          .where('dedup_key', '=', `LOT_EXPIRING:STOCK_LOT:${id}:${site}:${product}`)
          .executeTakeFirst();

      const slot1 = '2020-11-10T05:00:00.000Z';
      await expiring()(uow, { scheduledFor: slot1 });
      await consume(uow, [
        ...(await eventsOf(uow, 'LotExpiringDetected', mine)),
        ...(await markersOf(uow, 'LOT_EXPIRING', `LOT_EXPIRING:${slot1}`)),
      ]);
      expect(await status()).toMatchObject({ status: 'OPEN', severity: 'WARNING' });

      await uow
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '0' })
        .where('product_id', '=', toBin(product))
        .where('lot_key', '=', toBin(id))
        .execute();
      const slot2 = '2020-11-11T05:00:00.000Z';
      await expiring()(uow, { scheduledFor: slot2 });
      await consume(uow, await markersOf(uow, 'LOT_EXPIRING', `LOT_EXPIRING:${slot2}`));
      expect(await status()).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
    }));
});
