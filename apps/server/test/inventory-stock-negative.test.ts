/**
 * AV-215, INV-STK-05, BR-STK-018 (P5-22) : toute sortie physique hors ligne qui rend un solde négatif —
 * perte, consommation, expédition, pas seulement la vente — est appliquée **et** ouvre le conflit
 * `STOCK_NEGATIVE` (posé par `recordStockMove`, un par sortie), au nom du responsable du stock de
 * l'emplacement, rattaché au document source, avec l'avertissement renvoyé à l'appareil. Les identifiants
 * de `details` sont canoniques (minuscules), même si la charge utile les porte en majuscules : c'est par
 * eux que l'inventaire ferme les conflits du couple. La vente directe garde son propre conflit, un par
 * ligne (aucun doublon). Application complète, vrai service de synchronisation, rôles du seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { verifyStockLedger } from '../src/modules/inventory/application/public/index.js';
import { closeStockNegativeConflicts } from '../src/modules/inventory/application/stock-negative-conflicts.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { OfflineDevice } from './device-harness.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { PosWorld, PRICE, warningsOf, type Actor, type Sellable } from './pos-world.js';

const DAY = '2026-10-04';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('STOCK_NEGATIVE pour toute sortie physique hors ligne (AV-215, INV-STK-05)', () => {
  let world: PosWorld;
  let seller: Actor;
  let tablet: OfflineDevice;
  let product: Sellable;

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('07:00'), sellers: 1 });
    seller = world.sellers[0]!;
    tablet = world.tablet(seller);
    product = await world.product();
    await world.stockIn(product.id, 5, at('07:00'));
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('18:00'));
    } finally {
      await closeTestDb();
    }
  });

  const negativeConflicts = () =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['entity_type', 'entity_id', 'owner_role', 'applied', 'status', 'site_id', 'details'])
      .where('conflict_type', '=', 'STOCK_NEGATIVE')
      .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) = ${product.id}`)
      .orderBy('created_at')
      .execute();
  const details = (row: { details: unknown }) =>
    (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<
      string,
      unknown
    >;

  it('perte, consommation et expédition saisies hors ligne au-delà du stock : appliquées, un conflit chacune, l’avertissement renvoyé', async () => {
    const upper = product.id.toUpperCase();
    // Perte de 4 (le produit est en majuscules dans la charge utile), consommation de 3, expédition de 2.
    const loss = tablet.enqueue(seller.userId, {
      type: 'inventory.loss.declare',
      aggregateType: 'STOCK_LOSS',
      occurredAt: at('09:00'),
      payload: {
        locationId: world.counter,
        productId: upper,
        quantityBase: 4,
        unitCode: 'PIECE',
        quantity: 4,
        category: 'CASSE',
        comment: 'Cartons tombés',
      },
    });
    const consumption = tablet.enqueue(seller.userId, {
      type: 'inventory.consumption.record',
      aggregateType: 'STOCK_CONSUMPTION',
      occurredAt: at('09:30'),
      payload: {
        locationId: world.counter,
        productId: product.id,
        quantityBase: 3,
        unitCode: 'PIECE',
        quantity: 3,
        costObjectType: 'SITE',
        costObjectId: world.siteP,
        costType: 'AUTRE_INTRANT',
      },
    });
    const dispatch = tablet.enqueue(seller.userId, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: freshUuid(),
      occurredAt: at('10:00'),
      payload: {
        fromLocationId: world.counter,
        toLocationId: world.store,
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 2 }],
      },
    });
    world.setNow(at('11:00'));
    await tablet.syncUntilSettled(seller.userId);

    // Stock : 5 − 4 − 3 − 2 = −4, chaque fait appliqué (BR-STK-018).
    expect(await world.onHand(product.id)).toBe(-4);
    // La perte laisse 1 : ni négatif, ni avertissement de stock.
    expect(warningsOf(tablet.resultOf(loss.command_id))).not.toContain('STOCK_NEGATIVE');
    expect(tablet.resultOf(loss.command_id)?.status).toMatch(/^APPLIED/);
    for (const envelope of [consumption, dispatch]) {
      const result = tablet.resultOf(envelope.command_id);
      expect(result?.status, `${envelope.command_type} ${JSON.stringify(result)}`).toBe(
        'APPLIED_WITH_WARNINGS',
      );
      expect(warningsOf(result), envelope.command_type).toContain('STOCK_NEGATIVE');
    }
    // La consommation (1 − 3 = −2) et l'expédition (−2 − 2 = −4) ouvrent chacune leur conflit.
    const rows = await negativeConflicts();
    expect(rows.map((row) => row.entity_type)).toEqual(
      rows.map((row) => String(details(row)['sourceDocType'])),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ owner_role: 'MAGASINIER', applied: 1, status: 'OPEN' });
      expect(row.site_id).toEqual(toBin(world.siteP));
      expect(details(row)).toMatchObject({
        locationId: world.counter.toLowerCase(),
        productId: product.id.toLowerCase(),
        capturedOffline: true,
        userId: seller.userId,
      });
    }
  });

  it('perte au-delà du stock, produit en majuscules : le conflit porte les identifiants canoniques', async () => {
    const loss = tablet.enqueue(seller.userId, {
      type: 'inventory.loss.declare',
      aggregateType: 'STOCK_LOSS',
      occurredAt: at('11:30'),
      payload: {
        locationId: world.counter,
        productId: product.id.toUpperCase(),
        quantityBase: 1,
        unitCode: 'PIECE',
        quantity: 1,
        category: 'CASSE',
        comment: 'Encore une casse',
      },
    });
    world.setNow(at('12:00'));
    await tablet.syncUntilSettled(seller.userId);
    expect(warningsOf(tablet.resultOf(loss.command_id))).toContain('STOCK_NEGATIVE');
    const rows = await negativeConflicts();
    expect(rows).toHaveLength(3);
    expect(details(rows.at(-1)!)).toMatchObject({
      locationId: world.counter.toLowerCase(),
      productId: product.id.toLowerCase(),
      moveType: expect.stringMatching(/^LOSS/),
    });
  });

  it('INV-STK-05 : le solde négatif est expliqué ; régularisé, l’inventaire ferme tous les conflits du couple', async () => {
    const ledger = await db
      .transaction()
      .execute((trx) => verifyStockLedger(trx, { productIds: [product.id] }));
    expect(ledger.negativeBreaches).toEqual([]);

    // Un apport remet le solde à zéro ou plus : la fermeture par l'inventaire trouve les trois conflits.
    await world.stockIn(product.id, 10, at('12:30'));
    const closed = await db.transaction().execute((trx) =>
      closeStockNegativeConflicts(trx, {
        locationId: world.counter,
        productId: product.id,
        resolvedBy: world.magP.userId,
        resolvedAt: new Date(at('12:45')),
        countId: freshUuid(),
      }),
    );
    expect(closed).toBe(3);
    expect((await negativeConflicts()).every((row) => row.status === 'RESOLVED')).toBe(true);
  });

  it('vente directe hors ligne au-delà du stock : un seul conflit, celui de la vente (par ligne), aucun doublon', async () => {
    const sold = await world.product('Produit vendu à découvert');
    await world.stockIn(sold.id, 1, at('07:00'));
    const sale = tablet.enqueue(seller.userId, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt: at('13:00'),
      payload: {
        fromLocationId: world.counter,
        lines: [world.line(sold, 3)],
        payments: [
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 3 * PRICE,
            reference: `OM${freshUuid().slice(-12)}`,
            cashAccountId: world.mobileAcc,
          },
        ],
      },
    });
    world.setNow(at('13:30'));
    await tablet.syncUntilSettled(seller.userId);
    expect(warningsOf(tablet.resultOf(sale.command_id))).toContain('STOCK_NEGATIVE');
    const rows = await db
      .selectFrom('sync_sync_conflicts')
      .select(['entity_type', 'entity_id'])
      .where('conflict_type', '=', 'STOCK_NEGATIVE')
      .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) = ${sold.id}`)
      .execute();
    expect(rows).toEqual([{ entity_type: 'SALE', entity_id: toBin(sale.aggregate_id) }]);
    // Le solde de 1 − 3 = −2 est rendu au stock pour l'hygiène des autres balayages (pas d'effet sur le test).
    await world.stockIn(sold.id, 2, at('13:45'));
  });
});
