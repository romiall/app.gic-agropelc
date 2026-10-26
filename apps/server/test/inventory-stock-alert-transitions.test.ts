/**
 * P9-08 : détection sur mouvement des alertes de stock (AV-405, AV-457) — `StockThresholdBreached`
 * (`STOCK_LOW`, `STOCK_OUT`) aux extrémités physiques d'un mouvement, `StockNegativeDetected`
 * (`STOCK_NEGATIVE`), et les transitions d'un changement de seuil. Chaque cas tourne dans une transaction
 * annulée (les événements sont immuables, la base d'essai est partagée) ; le consommateur d'alertes est
 * appelé dans la même transaction pour vérifier la levée et la résolution de bout en bout.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import {
  InventoryMoveError,
  recordStockMove,
  type RecordMoveInput,
} from '../src/modules/inventory/application/public/index.js';
import { publishThresholdSetTransitions } from '../src/modules/inventory/application/inventory-alert-events.js';
import { lowestNegativeMove } from '../src/modules/inventory/application/public/record-move.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toDomainEvent, type DomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

// Poste de développement à mémoire comptée : chaque cas crée site, emplacements et produit.
vi.setConfig({ testTimeout: 120_000 });

/** Instant de détection (horloge du serveur) et date des faits, un autre jour métier. */
const DETECTED_AT = new Date('2026-10-15T09:00:00.000Z');
const FACT_AT = new Date('2026-10-10T14:00:00.000Z');
const clock = new FixedClock(DETECTED_AT);
const idGenerator = new Uuidv7Generator(clock);
const deps = { idGenerator, clock };

const virtual: Record<string, string> = {};

beforeAll(async () => {
  for (const type of ['V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PENDING_LOSS', 'V_LOSS']) {
    const row = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', type)
      .executeTakeFirstOrThrow();
    virtual[type] = fromBin(row.id);
  }
});

afterAll(closeTestDb);

async function world(uow: UnitOfWork) {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const site = await insertTestSite(uow, admin, zone);
  const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
  const other = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
  const product = await insertTestProduct(uow, admin);
  return { admin, site, store, other, product };
}

async function setThreshold(
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

type MoveOverrides = Omit<
  RecordMoveInput,
  'occurredAt' | 'sourceDocType' | 'sourceDocId' | 'createdBy' | 'allowNegative'
> &
  Partial<Pick<RecordMoveInput, 'allowNegative' | 'sourceDocType' | 'sourceDocId' | 'occurredAt'>>;

function mover(uow: UnitOfWork, admin: string) {
  return (input: MoveOverrides) =>
    recordStockMove(uow, deps, {
      occurredAt: FACT_AT,
      sourceDocType: 'INVENTORY_COUNT',
      sourceDocId: freshUuid(),
      createdBy: admin,
      allowNegative: false,
      ...input,
    });
}

/** Événements d'alerte de stock du couple, dans l'ordre de publication. */
async function stockEvents(uow: UnitOfWork, locationId: string, productId: string) {
  const subject = compositeSubjectId('STOCK_LOW', {
    location_id: locationId,
    product_id: productId,
  });
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('aggregate_id', '=', toBin(subject))
    .where('event_type', 'in', ['StockThresholdBreached', 'StockNegativeDetected'])
    .orderBy('seq')
    .execute();
  return rows.map((row) => toDomainEvent(row));
}

const levels = (events: readonly DomainEvent[]) =>
  events.map((event) => {
    const payload = event.payload as { level?: string; breached?: boolean };
    return event.eventType === 'StockNegativeDetected'
      ? 'NEGATIVE'
      : `${payload.level}:${payload.breached}`;
  });

async function consume(uow: UnitOfWork, events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) await handleAlertEvent(uow, event, { idGenerator });
}

async function alertOf(uow: UnitOfWork, type: string, locationId: string, productId: string) {
  return uow
    .selectFrom('communication_alerts')
    .select(['status', 'severity', 'occurrences', 'site_id', 'resolution_kind'])
    .where('dedup_key', '=', `${type}:STOCK_POSITION:${locationId}:${productId}`)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

describe('transitions de seuil sur mouvement (P9-08, AV-405)', () => {
  it('sortie puis entrées : un événement par franchissement, rien tant que l’état ne change pas', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await setThreshold(uow, admin, store, product, 10, 30);
      expect(await stockEvents(uow, store, product)).toEqual([]);

      const sale = (quantityBase: number) =>
        move({
          productId: product,
          quantityBase,
          fromLocationId: store,
          toLocationId: virtual.V_CUSTOMER!,
          moveType: 'SALE',
          sourceDocType: 'SALE',
        });
      await sale(3); // 12 → 9 : sous le minimum
      expect(levels(await stockEvents(uow, store, product))).toEqual(['LOW:true']);
      await sale(2); // 9 → 7 : toujours bas
      expect(levels(await stockEvents(uow, store, product))).toEqual(['LOW:true']);
      await sale(7); // 7 → 0 : rupture
      expect(levels(await stockEvents(uow, store, product))).toEqual([
        'LOW:true',
        'LOW:false',
        'OUT:true',
      ]);

      const receive = (quantityBase: number) =>
        move({
          productId: product,
          quantityBase,
          fromLocationId: virtual.V_SUPPLIER!,
          toLocationId: store,
          moveType: 'PURCHASE_RECEIPT',
          sourceDocType: 'GOODS_RECEIPT',
          declaredUnitCostXaf: 300,
        });
      await receive(4); // 0 → 4 : de la rupture au bas
      await receive(20); // 4 → 24 : retour à la normale
      // Les emplacements virtuels (`V_OPENING`, `V_SUPPLIER`, `V_CUSTOMER`) se vident ou se remplissent
      // sans cesse : ils ne portent jamais d'alerte de stock (ni solde négatif, ni seuil).
      for (const type of ['V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER']) {
        expect(await stockEvents(uow, virtual[type]!, product)).toEqual([]);
      }
      expect(levels(await stockEvents(uow, store, product))).toEqual([
        'LOW:true',
        'LOW:false',
        'OUT:true',
        'OUT:false',
        'LOW:true',
        'LOW:false',
      ]);
    }));

  it('seuil posé sur un stock vide : la première entrée met fin à la rupture signalée à la pose', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      await setThreshold(uow, admin, store, product, 10, 30);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      expect(levels(await stockEvents(uow, store, product))).toEqual(['OUT:false']);
    }));

  it('charge utile : disponible après, seuil, cible, libellés, site, jour métier du fait', () =>
    rolledBack(async (uow) => {
      const { admin, store, product, site } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await setThreshold(uow, admin, store, product, 10, 30);
      await move({
        productId: product,
        quantityBase: 4,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      const [event] = await stockEvents(uow, store, product);
      expect(event!.producerModule).toBe('inventory');
      expect(event!.payload).toEqual({
        location_id: store,
        product_id: product,
        level: 'LOW',
        breached: true,
        available: 8,
        threshold: 10,
        target: 30,
        location_label: 'Emplacement de test',
        product_label: 'Produit de test',
        site_id: site,
        // Le jour métier est celui du fait ; la détection est datée de l'horloge du serveur (AV-457).
        business_day: '2026-10-10',
      });
      expect(event!.occurredAt.toISOString()).toBe(DETECTED_AT.toISOString());
    }));

  it('sans seuil actif, ou avec un seuil remplacé : aucun événement', () =>
    rolledBack(async (uow) => {
      const { admin, store, other, product } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 5,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await move({
        productId: product,
        quantityBase: 5,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      expect(await stockEvents(uow, store, product)).toEqual([]);

      // Seuil désactivé (remplacé) : sans effet ; le seuil actif d'un autre emplacement non plus.
      await uow
        .insertInto('inventory_stock_thresholds')
        .values({
          id: toBin(freshUuid()),
          location_id: toBin(store),
          product_id: toBin(product),
          min_qty_base: '10',
          target_qty_base: '20',
          is_active: 0,
          created_by: toBin(admin),
        })
        .execute();
      await setThreshold(uow, admin, other, product, 10, 20);
      await move({
        productId: product,
        quantityBase: 6,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await move({
        productId: product,
        quantityBase: 6,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      expect(await stockEvents(uow, store, product)).toEqual([]);
    }));

  it('mouvement interne : les deux extrémités physiques sont évaluées', () =>
    rolledBack(async (uow) => {
      const { admin, store, other, product } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await setThreshold(uow, admin, store, product, 10, 30);
      await setThreshold(uow, admin, other, product, 10, 30);
      // `other` : de la rupture (0, seuil défini) vers l'état correct n'est pas une transition
      // observée tant qu'aucun mouvement ne l'a touché ; le premier mouvement la rend visible.
      await move({
        productId: product,
        quantityBase: 4,
        fromLocationId: store,
        toLocationId: other,
        moveType: 'INTERNAL_MOVE',
        sourceDocType: 'TRANSFER',
      });
      // store : 12 → 8 (bas) ; other : 0 → 4 (de la rupture au bas).
      expect(levels(await stockEvents(uow, store, product))).toEqual(['LOW:true']);
      expect(levels(await stockEvents(uow, other, product))).toEqual(['OUT:false', 'LOW:true']);
    }));

  it('plusieurs lots : une seule évaluation par appel, sur la somme des soldes du couple', () =>
    rolledBack(async (uow) => {
      const { admin, site, store } = await world(uow);
      void site;
      const product = await insertTestProduct(uow, admin, { lotTracking: 'OPTIONAL' });
      const move = mover(uow, admin);
      const lots: string[] = [];
      for (const rank of [1, 2]) {
        const lotId = freshUuid();
        lots.push(lotId);
        await uow
          .insertInto('inventory_stock_lots')
          .values({
            id: toBin(lotId),
            lot_code: `L-${lotId.slice(-12)}`,
            product_id: toBin(product),
            origin_type: 'SUPPLIER_LOT',
            fifo_rank_at: new Date(FACT_AT.getTime() + rank * 1000),
            created_by: toBin(admin),
          })
          .execute();
        await move({
          productId: product,
          lotId,
          quantityBase: 10,
          fromLocationId: virtual.V_SUPPLIER!,
          toLocationId: store,
          moveType: 'PURCHASE_RECEIPT',
          sourceDocType: 'GOODS_RECEIPT',
          declaredUnitCostXaf: 300,
        });
      }
      await setThreshold(uow, admin, store, product, 10, 30);
      expect(await stockEvents(uow, store, product)).toEqual([]);
      // 20 en stock sur deux lots ; la sortie de 15 traverse les deux lots (deux mouvements).
      const moves = await move({
        productId: product,
        quantityBase: 15,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      expect(moves.length).toBe(2);
      const events = await stockEvents(uow, store, product);
      expect(levels(events)).toEqual(['LOW:true']);
      expect((events[0]!.payload as { available: number }).available).toBe(5);
    }));

  it('hors ligne : le fait est appliqué, le solde négatif lève rupture ET solde négatif', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await setThreshold(uow, admin, store, product, 10, 30);
      await move({
        productId: product,
        quantityBase: 15,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
        allowNegative: true,
        capturedOffline: true,
      });
      const events = await stockEvents(uow, store, product);
      // De 12 à −3 : l'état passe directement de correct à rupture, puis le solde négatif est signalé.
      expect(levels(events)).toEqual(['OUT:true', 'NEGATIVE']);
      const negative = events.find((event) => event.eventType === 'StockNegativeDetected')!;
      expect(negative.payload).toMatchObject({
        negative: true,
        balance: -3,
        lot_id: null,
        move_type: 'SALE',
        source_doc_type: 'SALE',
        captured_offline: true,
        business_day: '2026-10-10',
      });
      expect(negative.occurredAt.toISOString()).toBe(DETECTED_AT.toISOString());
    }));

  it('sortie FIFO hors ligne sur deux lots : le manque est imputé au dernier lot, solde et lot_id reportés', () =>
    rolledBack(async (uow) => {
      const { admin, store } = await world(uow);
      const product = await insertTestProduct(uow, admin, { lotTracking: 'OPTIONAL' });
      const move = mover(uow, admin);
      const lots: string[] = [];
      for (const rank of [1, 2]) {
        const lotId = freshUuid();
        lots.push(lotId);
        await uow
          .insertInto('inventory_stock_lots')
          .values({
            id: toBin(lotId),
            lot_code: `L-${lotId.slice(-12)}`,
            product_id: toBin(product),
            origin_type: 'SUPPLIER_LOT',
            fifo_rank_at: new Date(FACT_AT.getTime() + rank * 1000),
            created_by: toBin(admin),
          })
          .execute();
        await move({
          productId: product,
          lotId,
          quantityBase: 10,
          fromLocationId: virtual.V_SUPPLIER!,
          toLocationId: store,
          moveType: 'PURCHASE_RECEIPT',
          sourceDocType: 'GOODS_RECEIPT',
          declaredUnitCostXaf: 300,
        });
      }
      // 25 pour 20 en stock : le lot 1 est vidé, le lot 2 aussi, puis −5 sur le lot 2.
      await move({
        productId: product,
        quantityBase: 25,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
        allowNegative: true,
        capturedOffline: true,
      });
      const [negative] = (await stockEvents(uow, store, product)).filter(
        (event) => event.eventType === 'StockNegativeDetected',
      );
      expect(negative!.payload).toMatchObject({ balance: -5, lot_id: lots[1] });
    }));

  it('une ligne de lot négative alors que le disponible du couple reste positif : STOCK_NEGATIVE est publié', () =>
    rolledBack(async (uow) => {
      const { admin, store } = await world(uow);
      const product = await insertTestProduct(uow, admin, { lotTracking: 'OPTIONAL' });
      const move = mover(uow, admin);
      const lotA = freshUuid();
      const lotB = freshUuid();
      for (const [lotId, rank] of [
        [lotA, 1],
        [lotB, 2],
      ] as const) {
        await uow
          .insertInto('inventory_stock_lots')
          .values({
            id: toBin(lotId),
            lot_code: `L-${lotId.slice(-12)}`,
            product_id: toBin(product),
            origin_type: 'SUPPLIER_LOT',
            fifo_rank_at: new Date(FACT_AT.getTime() + rank * 1000),
            created_by: toBin(admin),
          })
          .execute();
      }
      await move({
        productId: product,
        lotId: lotB,
        quantityBase: 20,
        fromLocationId: virtual.V_SUPPLIER!,
        toLocationId: store,
        moveType: 'PURCHASE_RECEIPT',
        sourceDocType: 'GOODS_RECEIPT',
        declaredUnitCostXaf: 300,
      });
      // Sortie hors ligne du lot A, qui n'a aucun stock : −3 sur A alors que B porte 20 (couple : 17).
      await move({
        productId: product,
        lotId: lotA,
        quantityBase: 3,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
        allowNegative: true,
        capturedOffline: true,
      });
      const events = await stockEvents(uow, store, product);
      expect(levels(events)).toEqual(['NEGATIVE']);
      expect(events[0]!.payload).toMatchObject({ balance: -3, lot_id: lotA });
    }));

  it('lowestNegativeMove : la ligne la plus négative, la première à égalité, rien sans ligne négative', () => {
    const rows = (...balances: number[]) =>
      balances.map((fromBalanceAfter, index) => ({ fromBalanceAfter, index }));
    expect(lowestNegativeMove(rows(2, 0, 1))).toBeUndefined();
    expect(lowestNegativeMove(rows(-2, 5, -5, -1))?.index).toBe(2);
    expect(lowestNegativeMove(rows(-3, -3))?.index).toBe(0);
    expect(lowestNegativeMove([])).toBeUndefined();
  });

  it('solde négatif sans seuil : STOCK_NEGATIVE seul ; mode CALLER : l’alerte est levée quand même', () =>
    rolledBack(async (uow) => {
      const { admin, store, other, product } = await world(uow);
      const move = mover(uow, admin);
      for (const [location, mode] of [
        [store, undefined],
        [other, 'CALLER' as const],
      ] as const) {
        await move({
          productId: product,
          quantityBase: 2,
          fromLocationId: virtual.V_OPENING!,
          toLocationId: location,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 300,
        });
        await move({
          productId: product,
          quantityBase: 5,
          fromLocationId: location,
          toLocationId: virtual.V_CUSTOMER!,
          moveType: 'SALE',
          sourceDocType: 'SALE',
          allowNegative: true,
          ...(mode !== undefined ? { stockNegativeConflict: mode } : {}),
        });
        expect(levels(await stockEvents(uow, location, product))).toEqual(['NEGATIVE']);
      }
    }));

  it('en ligne, un stock insuffisant est refusé : aucun événement', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      await setThreshold(uow, admin, store, product, 10, 30);
      await move({
        productId: product,
        quantityBase: 2,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      const before = await stockEvents(uow, store, product);
      await expect(
        move({
          productId: product,
          quantityBase: 5,
          fromLocationId: store,
          toLocationId: virtual.V_CUSTOMER!,
          moveType: 'SALE',
          sourceDocType: 'SALE',
        }),
      ).rejects.toBeInstanceOf(InventoryMoveError);
      expect(await stockEvents(uow, store, product)).toEqual(before);
    }));

  it('un mouvement dont les deux extrémités sont virtuelles ne lit aucun seuil ; une sortie physique en lit un', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 3,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      const reads = { count: 0 };
      const counted = uow.withPlugin({
        transformQuery(args) {
          if (JSON.stringify(args.node).includes('inventory_stock_thresholds')) reads.count += 1;
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const base = {
        productId: product,
        quantityBase: 1,
        occurredAt: FACT_AT,
        sourceDocType: 'LOSS' as const,
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      };
      await recordStockMove(counted, deps, {
        ...base,
        fromLocationId: store,
        toLocationId: virtual.V_PENDING_LOSS!,
        moveType: 'LOSS_PENDING',
      });
      expect(reads.count).toBe(1);
      await recordStockMove(counted, deps, {
        ...base,
        fromLocationId: virtual.V_PENDING_LOSS!,
        toLocationId: virtual.V_LOSS!,
        moveType: 'LOSS_CONFIRMATION',
      });
      expect(reads.count).toBe(1);
    }));
});

describe('changement de seuil (inventory.threshold.set, P9-08)', () => {
  it('un seuil créé sur un stock vide lève la rupture, un minimum relevé lève le bas, abaissé le résout', () =>
    rolledBack(async (uow) => {
      const { admin, store, product } = await world(uow);
      const move = mover(uow, admin);
      const input = (previousMinQty: number | null, minQty: number) => ({
        locationId: store,
        productId: product,
        previousMinQty,
        minQty,
        targetQty: minQty * 3,
        factAt: FACT_AT,
      });

      // Stock vide, premier seuil : rupture.
      await publishThresholdSetTransitions(uow, deps, input(null, 10));
      expect(levels(await stockEvents(uow, store, product))).toEqual(['OUT:true']);

      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      // 12 en stock : minimum 10 → correct ; relevé à 20 → bas ; abaissé à 5 → correct.
      await publishThresholdSetTransitions(uow, deps, input(10, 20));
      await publishThresholdSetTransitions(uow, deps, input(20, 5));
      // Même état avant et après : rien.
      await publishThresholdSetTransitions(uow, deps, input(5, 6));
      expect(levels(await stockEvents(uow, store, product))).toEqual([
        'OUT:true',
        'LOW:true',
        'LOW:false',
      ]);
    }));
});

describe('de bout en bout avec le consommateur d’alertes (P9-08)', () => {
  it('rupture critique levée puis résolue ; stock bas levé, passé en rupture puis résolu', () =>
    rolledBack(async (uow) => {
      const { admin, store, product, site } = await world(uow);
      const move = mover(uow, admin);
      await move({
        productId: product,
        quantityBase: 12,
        fromLocationId: virtual.V_OPENING!,
        toLocationId: store,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 300,
      });
      await setThreshold(uow, admin, store, product, 10, 30);
      await move({
        productId: product,
        quantityBase: 4,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      await consume(uow, await stockEvents(uow, store, product));
      expect(await alertOf(uow, 'STOCK_LOW', store, product)).toMatchObject({
        status: 'OPEN',
        severity: 'WARNING',
      });

      await move({
        productId: product,
        quantityBase: 8,
        fromLocationId: store,
        toLocationId: virtual.V_CUSTOMER!,
        moveType: 'SALE',
        sourceDocType: 'SALE',
      });
      const all = await stockEvents(uow, store, product);
      await consume(uow, all.slice(1));
      expect(await alertOf(uow, 'STOCK_LOW', store, product)).toMatchObject({
        status: 'RESOLVED',
        resolution_kind: 'CONDITION_CLEARED',
      });
      const out = await alertOf(uow, 'STOCK_OUT', store, product);
      expect(out).toMatchObject({ status: 'OPEN', severity: 'CRITICAL' });
      expect(fromBin(out!.site_id as Buffer)).toBe(site);

      await move({
        productId: product,
        quantityBase: 20,
        fromLocationId: virtual.V_SUPPLIER!,
        toLocationId: store,
        moveType: 'PURCHASE_RECEIPT',
        sourceDocType: 'GOODS_RECEIPT',
        declaredUnitCostXaf: 300,
      });
      const afterReceipt = await stockEvents(uow, store, product);
      await consume(uow, afterReceipt.slice(all.length));
      expect(await alertOf(uow, 'STOCK_OUT', store, product)).toMatchObject({
        status: 'RESOLVED',
      });
    }));
});
