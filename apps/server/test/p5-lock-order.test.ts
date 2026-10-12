/**
 * Ordre de verrouillage global (P5-22, ADR-038) éprouvé en concurrence, sur l'application complète (vrai
 * pipeline, isolation réelle de chaque commande) : aucune paire d'opérations concurrentes ne s'interbloque
 * (un interblocage serait rendu `RETRY_LATER` par l'étape 7 du pipeline), et la course d'AV-185 ne laisse
 * plus passer une annulation directe dont la session de caisse vient d'être close.
 *
 * Deux scénarios sont **déterministes** : une transaction de test retient la ressource où l'on veut
 * arrêter la première opération (ligne de solde de `V_CUSTOMER`, compteur `ANV`), la seconde opération
 * démarre, puis la ressource est rendue — l'ordre des verrous est ainsi imposé, sans dépendre du hasard.
 * Les autres paires sont jouées en tours concurrents (`Promise.all`), sur des entités neuves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import type { CommandResult } from '@gic/contracts';
import {
  verifyCashSessions,
  verifyCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import type { DB } from '../src/platform/kysely/database.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { PosWorld, PRICE, codeOf, warningsOf, type Actor, type Sellable } from './pos-world.js';

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retried = (results: readonly CommandResult[]) =>
  results.filter((result) => result.status === 'RETRY_LATER');

/** Une transaction de test qui tient un verrou jusqu'à `release()`. */
async function hold(lock: (trx: Transaction<DB>) => Promise<unknown>) {
  let ready!: () => void;
  let open!: () => void;
  const held = new Promise<void>((resolve) => (ready = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  const done = db.transaction().execute(async (trx) => {
    await lock(trx);
    ready();
    await gate;
  });
  await Promise.race([held, done]);
  return {
    release: async () => {
      open();
      await done;
    },
  };
}

describe('ordre de verrouillage global (P5-22, ADR-038)', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let seller: Actor;
  let seq = 0;

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('2026-09-28', '06:00'), sellers: 1 });
    seller = world.sellers[0]!;
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('2026-10-03', '23:00'));
    } finally {
      await closeTestDb();
    }
  });

  /** Enveloppe construite une fois, pour pouvoir la renvoyer à l'identique. */
  function envelopeOf(
    actor: Actor,
    command: {
      type: string;
      aggregateType: string;
      aggregateId?: string;
      occurredAt: string;
      payload: unknown;
    },
  ) {
    seq += 1;
    return {
      command_id: freshUuid(),
      device_seq: 2_000_000 + seq,
      command_version: 1,
      command_type: command.type,
      aggregate_type: command.aggregateType,
      aggregate_id: command.aggregateId ?? freshUuid(),
      author_user_id: actor.userId,
      base_version: null,
      depends_on: [],
      occurred_at: command.occurredAt,
      client_created_at: command.occurredAt,
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: command.payload,
    };
  }
  const handle = (actor: Actor, envelope: ReturnType<typeof envelopeOf>) =>
    world.pipeline.handle(envelope, {
      authenticatedUserId: actor.userId,
      authenticatedDeviceId: actor.deviceId,
      transport: 'ONLINE_API',
    });

  const mobileSale = (
    items: readonly (readonly [Sellable, number])[],
    occurredAt: string,
    from = world,
  ) => ({
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    occurredAt,
    payload: {
      fromLocationId: from.counter,
      lines: items.map(([product, quantity]) => from.line(product, quantity)),
      payments: [
        {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: items.reduce((sum, [, quantity]) => sum + quantity * PRICE, 0),
          reference: `OM${freshUuid().replace(/-/g, '').slice(-16)}`,
          cashAccountId: from.mobileAcc,
        },
      ],
    },
  });
  const cashSale = (product: Sellable, quantity: number, occurredAt: string, saleId?: string) => ({
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    ...(saleId !== undefined ? { aggregateId: saleId } : {}),
    occurredAt,
    payload: {
      fromLocationId: world.counter,
      lines: [world.line(product, quantity)],
      payments: [{ methodCode: 'ESPECES', amountXaf: quantity * PRICE }],
    },
  });
  const openSession = (session: string, occurredAt: string) =>
    world.ok(seller, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt,
      payload: { cashAccountId: world.posAcc, countedXaf: 0 },
    });
  const closeSession = (session: string, occurredAt: string, countedXaf: number) => ({
    type: 'finance.cash_session.close',
    aggregateType: 'CASH_SESSION',
    aggregateId: session,
    occurredAt,
    payload: { countedXaf },
  });

  it('octroi contre vente de deux produits (cycle 1a de D04 §15) : la vente prend les soldes de tous ses produits avant le premier quota — aucun interblocage', async () => {
    const day = '2026-09-28';
    world.setNow(at(day, '08:00'));
    const p1 = await world.product('Ordre P1');
    const p2 = await world.product('Ordre P2');
    expect(p1.id < p2.id).toBe(true);
    await world.stockIn(p1.id, 50, at(day, '07:00'));
    await world.stockIn(p2.id, 50, at(day, '07:00'));
    // Une première vente de P1 crée sa ligne de solde à `V_CUSTOMER`, que la transaction de test retiendra.
    await world.ok(seller, mobileSale([[p1, 1]], at(day, '08:00')));
    const customerLocation = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_CUSTOMER')
      .executeTakeFirstOrThrow();

    world.setNow(at(day, '09:00'));
    const holder = await hold((trx) =>
      trx
        .selectFrom('inventory_stock_balances')
        .select('qty_on_hand')
        .where('location_id', '=', customerLocation.id)
        .where('product_id', '=', toBin(p1.id))
        .forUpdate()
        .execute(),
    );
    // La vente [P1, P2] s'arrête à la ligne de P1 de `V_CUSTOMER` ; l'octroi sur P2 démarre pendant ce temps.
    const sale = world.online(
      seller,
      mobileSale(
        [
          [p1, 1],
          [p2, 1],
        ],
        at(day, '09:00'),
      ),
    );
    await sleep(500);
    const quotaId = freshUuid();
    const grant = world.online(world.magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: quotaId,
      occurredAt: at(day, '09:00'),
      payload: {
        holderUserId: seller.userId,
        holderDeviceId: seller.deviceId,
        locationId: world.counter,
        productId: p2.id,
        quantityBase: 10,
      },
    });
    world.granted.push(quotaId);
    await sleep(500);
    await holder.release();
    const results = await Promise.all([sale, grant]);
    expect(retried(results), JSON.stringify(results)).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(['APPLIED', 'APPLIED']);
    await world.expectStockLedgerOk([p1.id, p2.id]);
  });

  it('AV-185 (AV-221) : une clôture validée pendant une annulation directe la fait renvoyer ; au renvoi, la demande au lieu d’un remboursement hors session', async () => {
    const day = '2026-09-29';
    world.setNow(at(day, '09:00'));
    const product = await world.product('Annulé pendant la clôture');
    await world.stockIn(product.id, 10, at(day, '07:00'));
    const session = freshUuid();
    await openSession(session, at(day, '09:00'));
    world.setNow(at(day, '09:55'));
    const saleId = freshUuid();
    await world.ok(seller, cashSale(product, 1, at(day, '09:55'), saleId));

    // Le compteur ANV du site est retenu : l'annulation s'y arrête, après sa première lecture de la condition.
    const holder = await hold(async (trx) => {
      await sql`INSERT INTO platform_document_sequences (doc_type, site_id, year, next_value)
                VALUES ('ANV', ${toBin(world.siteP)}, 2026, 1)
                ON DUPLICATE KEY UPDATE next_value = next_value`.execute(trx);
      await sql`SELECT next_value FROM platform_document_sequences
                WHERE doc_type = 'ANV' AND site_id = ${toBin(world.siteP)} AND year = 2026
                FOR UPDATE`.execute(trx);
    });
    world.setNow(at(day, '10:05'));
    const cancellation = envelopeOf(seller, {
      type: 'sales.sale.cancel',
      aggregateType: 'SALE_CANCELLATION',
      occurredAt: at(day, '10:05'),
      payload: { saleId, comment: 'Erreur de saisie' },
    });
    const first = handle(seller, cancellation);
    await sleep(500);
    // Pendant ce temps, la caisse est close à 10:00 : la vente de 09:55 y est comptée.
    await world.ok(seller, closeSession(session, at(day, '10:00'), PRICE));
    await holder.release();
    const firstResult = await first;
    expect(firstResult, JSON.stringify(firstResult)).toMatchObject({ status: 'RETRY_LATER' });

    // Au renvoi identique : la clôture validée est vue, l'annulation devient une demande (BR-VEN-028).
    const second = await handle(seller, cancellation);
    expect(second.status, JSON.stringify(second)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(second)).toContain('CANCEL_SESSION_CLOSED');
    const doc = await db
      .selectFrom('sales_sale_cancellations')
      .select('status')
      .where('id', '=', toBin(cancellation.aggregate_id))
      .executeTakeFirstOrThrow();
    expect(doc.status).toBe('REQUESTED');
    const refunds = await db
      .selectFrom('finance_cash_movements')
      .select('id')
      .where('source_doc_id', '=', toBin(cancellation.aggregate_id))
      .execute();
    expect(refunds).toEqual([]);
    expect((await verifyCashSessions(db, { sessionIds: [session] })).breaches).toEqual([]);
  });

  it('révocation contre vente du même couple (cycle 1b), en tours concurrents : jamais d’interblocage', async () => {
    const day = '2026-09-28';
    for (let round = 0; round < 5; round++) {
      world.setNow(at(day, `1${round}:00`));
      const product = await world.product(`Révoqué ${round}`);
      await world.stockIn(product.id, 50, at(day, '07:00'));
      const quota = await world.grant(seller, product.id, 20, at(day, `1${round}:00`));
      const results = await Promise.all([
        world.revoke(quota, at(day, `1${round}:05`)),
        world.online(seller, mobileSale([[product, 2]], at(day, `1${round}:05`))),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      await world.expectStockLedgerOk([product.id]);
    }
  });

  it('premières ventes concurrentes d’un produit neuf depuis deux PDV (ligne `V_CUSTOMER` absente) : jamais d’interblocage', async () => {
    const day = '2026-09-28';
    const other = await PosWorld.create({ now: at(day, '06:00'), sellers: 1 });
    try {
      for (let round = 0; round < 5; round++) {
        world.setNow(at(day, `16:0${round}`));
        const product = await world.product(`Neuf ${round}`);
        await world.stockIn(product.id, 10, at(day, '07:00'));
        await other.stockIn(product.id, 10, at(day, '07:00'));
        const results = await Promise.all([
          world.online(seller, mobileSale([[product, 1]], at(day, `16:0${round}`))),
          other.online(
            other.sellers[0]!,
            mobileSale([[product, 1]], at(day, `16:0${round}`), other),
          ),
        ]);
        expect(retried(results), JSON.stringify(results)).toEqual([]);
        await world.expectStockLedgerOk([product.id]);
      }
    } finally {
      await other.close(at('2026-10-03', '23:00'));
    }
  });

  it('clôture de caisse contre encaissement en espèces, en tours concurrents : jamais d’interblocage, l’écart reste juste (INV-FIN-11)', async () => {
    for (const day of ['2026-09-30', '2026-10-01', '2026-10-02']) {
      world.setNow(at(day, '08:00'));
      const product = await world.product(`Caisse ${day}`);
      await world.stockIn(product.id, 10, at(day, '07:00'));
      const session = freshUuid();
      await openSession(session, at(day, '08:00'));
      world.setNow(at(day, '12:00'));
      const results = await Promise.all([
        world.online(seller, cashSale(product, 2, at(day, '11:50'))),
        world.online(seller, closeSession(session, at(day, '12:00'), 2 * PRICE)),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect((await verifyCashSessions(db, { sessionIds: [session] })).breaches).toEqual([]);
    }
  });

  it('envoi d’une remise contre annulation d’une autre depuis la même caisse, en tours concurrents : jamais d’interblocage', async () => {
    // Un jour propre : une session et une vente en espèces alimentent la caisse du PDV.
    const day = '2026-10-03';
    world.setNow(at(day, '08:00'));
    const product = await world.product('Remise');
    await world.stockIn(product.id, 20, at(day, '07:00'));
    await openSession(freshUuid(), at(day, '08:00'));
    world.setNow(at(day, '09:00'));
    await world.ok(seller, cashSale(product, 10, at(day, '09:00')));
    world.setNow(at(day, '14:00'));
    const transfers: string[] = [];
    const send = (id: string, hhmm: string) =>
      world.online(seller, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: id,
        occurredAt: at(day, hhmm),
        payload: { fromAccountId: world.posAcc, toAccountId: world.central, amountXaf: 100 },
      });
    for (let round = 0; round < 4; round++) {
      const first = freshUuid();
      const second = freshUuid();
      transfers.push(first, second);
      const sent = await send(first, `13:${round}0`);
      expect(sent.status, JSON.stringify(sent)).toMatch(/^APPLIED/);
      const results = await Promise.all([
        send(second, `13:${round}5`),
        world.online(seller, {
          type: 'finance.cash_transfer.cancel',
          aggregateType: 'CASH_TRANSFER',
          aggregateId: first,
          occurredAt: at(day, `13:${round}5`),
          payload: { reason: 'Remise refaite' },
        }),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(results.map((result) => codeOf(result) ?? result.status)).not.toContain('SERVER_BUSY');
    }
    const check = await db
      .transaction()
      .execute((trx) => verifyCashTransfers(trx, { transferIds: transfers }));
    expect(check.mismatches).toEqual([]);
  });
});
