/**
 * AT-035 croisé avec le PDV (P5-21) : appareil déclaré perdu avec un quota en cours (SM-DEVICE,
 * INV-ADM-03, BR-ADM-006 ; SM-ALLOCATION, ADR-033 §9 ; INV-STK-10, 11, 19, 20), sur l'application
 * complète, le vrai service de synchronisation et le vrai consommateur d'événements.
 *
 * Matin : stock 100, quotas A 30, B 40, C 30 (aucun stock libre) ; session de caisse ouverte par B.
 * La tablette A vend hors ligne ; à midi, l'administrateur la déclare perdue. Attendu :
 * - le consommateur `inventory.allocation_revocation` met le quota de A en révocation, sans mouvement ;
 *   aucun nouvel octroi ni hausse pour l'appareil perdu ;
 * - poussés plus tard, les faits antérieurs à la perte sont appliqués, les postérieurs (ventes,
 *   libération) mis en quarantaine (`DEVICE_REVOKED`) sans aucun effet, rejouables à l'identique ;
 *   l'appareil efface ses données téléchargées et garde sa file ;
 * - la révocation par le magasinier rend le reste du quota au stock libre ; B et C sont intacts ;
 * - l'espèce des ventes en quarantaine se retrouve dans l'écart de clôture de la caisse, qui
 *   s'explique par l'inbox (statut `CONFLICT`), jamais par le registre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RawCommandEnvelope } from '@gic/contracts';
import { EVENT_CONSUMER_REGISTRY } from '../src/platform/events/event-consumer-registry.provider.js';
import type { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { ALLOCATION_REVOCATION_CONSUMER_NAME } from '../src/modules/inventory/application/events/allocation-revocation-consumer.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { PosWorld, PRICE, codeOf, type Actor, type Sellable } from './pos-world.js';

const DAY = '2026-10-06';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('AT-035 × PDV : appareil perdu avec un quota en cours', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let A: Actor;
  let B: Actor;
  let C: Actor;
  let product: Sellable;
  let other: Sellable;
  let customerB: string;
  const quotas = { A: '', B: '', C: '' };
  let session = '';

  const cashSale = (quantity: number, occurredAt: string) => ({
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    aggregateId: freshUuid(),
    occurredAt,
    payload: {
      fromLocationId: world.counter,
      lines: [world.line(product, quantity)],
      payments: [{ methodCode: 'ESPECES', amountXaf: quantity * PRICE }],
    },
  });

  const entries = (allocationId: string) =>
    db
      .selectFrom('inventory_stock_allocation_entries')
      .select(['entry_type', 'quantity'])
      .where('allocation_id', '=', toBin(allocationId))
      .execute();

  const pendingEvents = async (allocationId: string) =>
    (
      await db
        .selectFrom('platform_domain_events')
        .select('seq')
        .where('event_type', '=', 'AllocationRevocationPending')
        .where('aggregate_id', '=', toBin(allocationId))
        .execute()
    ).length;

  /** Le vrai consommateur, sur l'événement que le pipeline a écrit pour la commande de perte. */
  async function runRevocationConsumer(deviceId: string): Promise<void> {
    const registry = world.app.get<EventConsumerRegistry>(EVENT_CONSUMER_REGISTRY);
    const handler = registry.resolve(ALLOCATION_REVOCATION_CONSUMER_NAME);
    expect(handler, 'consommateur câblé dans l’application').toBeDefined();
    const row = await db
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('event_type', '=', 'identity.device.declare_lost')
      .where('aggregate_id', '=', toBin(deviceId))
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) => handler!(trx, toDomainEvent(row)));
  }

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('04:00'), sellers: 3 });
    [A, B, C] = world.sellers as [Actor, Actor, Actor];
    product = await world.product();
    other = await world.product('Œufs');
    customerB = await world.customer('Client de B');
    await world.stockIn(product.id, 100, at('05:00'));
    await world.stockIn(other.id, 50, at('05:00'));
    world.setNow(at('07:00'));
    quotas.A = await world.grant(A, product.id, 30, at('07:00'));
    quotas.B = await world.grant(B, product.id, 40, at('07:00'));
    quotas.C = await world.grant(C, product.id, 30, at('07:00'));
    world.setNow(at('08:00'));
    session = freshUuid();
    await world.ok(B, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at('08:00'),
      payload: { cashAccountId: world.posAcc, countedXaf: 0 },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('18:30'));
    } finally {
      await closeTestDb();
    }
  });

  it('perte à midi : antérieur appliqué, postérieur en quarantaine, quota révoqué par le responsable, écart de caisse expliqué par l’inbox', async () => {
    const tablet = world.tablet(A);
    // 09:30 : A vend 5 et synchronise ; 11:30 : A vend 7, la tablette reste hors ligne.
    const a1 = tablet.enqueue(A.userId, cashSale(5, at('09:30')));
    world.setNow(at('09:35'));
    await tablet.syncUntilSettled(A.userId);
    expect(tablet.resultOf(a1.command_id)?.status).toBe('APPLIED');
    const a2 = tablet.enqueue(A.userId, cashSale(7, at('11:30')));

    // 12:00 : l'administrateur déclare la tablette perdue ; le consommateur signale le quota.
    world.setNow(at('12:00'));
    await world.ok(world.admin, {
      type: 'identity.device.declare_lost',
      aggregateType: 'DEVICE',
      aggregateId: A.deviceId,
      occurredAt: at('12:00'),
      payload: { reason: 'Tablette volée au marché' },
    });
    await runRevocationConsumer(A.deviceId);
    expect(await world.quota(quotas.A)).toMatchObject({ status: 'ACTIVE', revocation_pending: 1 });
    expect(await pendingEvents(quotas.A)).toBe(1);
    await runRevocationConsumer(A.deviceId); // rejouable : rien de plus
    expect(await pendingEvents(quotas.A)).toBe(1);
    expect(await world.onHand(product.id)).toBe(95);

    // Aucun nouvel octroi ni hausse pour l'appareil perdu ; aucun stock libre pour B.
    world.setNow(at('12:05'));
    const regrant = await world.online(world.magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      occurredAt: at('12:05'),
      payload: {
        holderUserId: A.userId,
        holderDeviceId: A.deviceId,
        locationId: world.counter,
        productId: other.id,
        quantityBase: 5,
      },
    });
    expect(codeOf(regrant)).toBe('ALLOCATION_HOLDER_INVALID');
    const increase = await world.online(world.magP, {
      type: 'inventory.allocation.increase',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: quotas.A,
      occurredAt: at('12:05'),
      baseVersion: (await world.quota(quotas.A)).version,
      payload: { quantityBase: 5 },
    });
    expect(codeOf(increase)).toBe('ALLOCATION_HOLDER_INVALID');
    const bSale = (occurredAt: string) =>
      world.online(B, {
        type: 'sales.sale.record',
        aggregateType: 'SALE',
        occurredAt,
        payload: {
          fromLocationId: world.counter,
          customerId: customerB,
          lines: [world.line(product, 41)],
        },
      });
    // Détenteur d'un quota épuisable (40) sans stock libre : refus en ligne, sans effet (BR-VEN-018).
    expect(codeOf(await bSale(at('12:05')))).toBe('ALLOCATION_EXCEEDED');

    // L'après-midi, la tablette perdue enregistre encore deux ventes et sa libération.
    const a3 = tablet.enqueue(A.userId, cashSale(4, at('13:00')));
    const a4 = tablet.enqueue(A.userId, cashSale(2, at('14:00')));
    const freed = tablet.enqueue(A.userId, {
      type: 'inventory.allocation.release',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: quotas.A,
      occurredAt: at('16:00'),
      payload: { remainingBase: 12 },
    });

    // 16:30 : la file arrive. Le harnais appelle le service d'envoi sans le garde HTTP ; en réel,
    // l'envoi n'est possible que dans les 15 minutes du dernier jeton d'accès, les sessions étant
    // révoquées à la perte (AV-213). Antérieur appliqué, postérieur en quarantaine.
    world.setNow(at('16:30'));
    await tablet.syncUntilSettled(A.userId);
    expect(tablet.resultOf(a2.command_id)?.status).toBe('APPLIED');
    for (const envelope of [a3, a4, freed]) {
      expect(tablet.resultOf(envelope.command_id), envelope.command_type).toMatchObject({
        status: 'CONFLICT',
        error: { code: 'DEVICE_REVOKED' },
      });
    }
    // INV-ADM-03 : aucun effet (ni vente, ni mouvement, ni entrée de quota), charge utile gardée.
    for (const envelope of [a3, a4]) {
      expect(
        await db
          .selectFrom('sales_sales')
          .select('id')
          .where('id', '=', toBin(envelope.aggregate_id))
          .executeTakeFirst(),
      ).toBeUndefined();
      const inbox = await db
        .selectFrom('sync_command_inbox')
        .select(['status', 'error_code', 'payload'])
        .where('command_id', '=', toBin(envelope.command_id))
        .executeTakeFirstOrThrow();
      expect(inbox).toMatchObject({ status: 'CONFLICT', error_code: 'DEVICE_REVOKED' });
      expect(inbox.payload).toEqual(envelope.payload);
    }
    expect(await world.onHand(product.id)).toBe(88);
    expect(await world.quota(quotas.A)).toMatchObject({
      status: 'ACTIVE',
      revocation_pending: 1,
      quantity_remaining: '18.000',
    });
    // Rejeu à l'identique de la file en quarantaine : même résultat, toujours sans effet.
    const replay = await world.services.push.push(
      {
        device_id: A.deviceId,
        batch_id: freshUuid(),
        device_sent_at: world.clock.now().toISOString(),
        commands: [a3, a4] as RawCommandEnvelope[],
        pending_by_author: {},
      },
      { authenticatedUserId: A.userId, authenticatedDeviceId: A.deviceId },
    );
    expect(replay.results.map(codeOf)).toEqual(['DEVICE_REVOKED', 'DEVICE_REVOKED']);
    expect(await world.onHand(product.id)).toBe(88);

    // AV-213 (défaut actuel, figé ici) : le pull ne vérifie pas le statut de l'appareil — repartie de
    // zéro, la tablette perdue reçoit encore son quota (révocation en attente). L'effacement local
    // n'existe que dans le harnais (`wipeLocal`) ; il reste à coder dans la PWA.
    tablet.wipeLocal();
    await tablet.pullAll('allocations', A.userId, world.clock.now());
    expect(tablet.localProjection.has(`allocations:STOCK_ALLOCATION:${quotas.A}`)).toBe(true);
    tablet.wipeLocal();
    expect(tablet.localProjection.size).toBe(0);

    // 17:00 : le magasinier révoque ; le reste (18) revient au stock libre, sans mouvement.
    world.setNow(at('17:00'));
    expect((await world.revoke(quotas.A, at('17:00'))).status).toBe('APPLIED');
    expect(await world.quota(quotas.A)).toMatchObject({
      status: 'REVOKED',
      revocation_pending: 0,
      quantity_remaining: '0.000',
    });
    const revokeEntry = (await entries(quotas.A)).find((row) => row.entry_type === 'REVOKE');
    expect(Number(revokeEntry?.quantity)).toBe(-18);
    expect(await world.onHand(product.id)).toBe(88);
    // B vend 41 : son quota (40) puis une unité du stock libre rendu (INV-STK-11 : C intact).
    expect((await bSale(at('17:05'))).status).toBe('APPLIED');
    expect(await world.remainingOf(quotas.B)).toBe(0);
    expect(await world.remainingOf(quotas.C)).toBe(30);
    expect(await world.onHand(product.id)).toBe(47);

    // 18:00 : clôture de B. Le tiroir contient l'espèce des ventes en quarantaine : écart positif,
    // égal à ce que montrent les commandes en `CONFLICT` de l'inbox, jamais le registre.
    world.setNow(at('18:00'));
    const quarantinedCash = [a3, a4].reduce(
      (sum, envelope) =>
        sum + (envelope.payload as { payments: { amountXaf: number }[] }).payments[0]!.amountXaf,
      0,
    );
    expect(quarantinedCash).toBe(3_000);
    await world.ok(B, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at('18:00'),
      payload: { countedXaf: 6_000 + quarantinedCash },
    });
    const closed = await db
      .selectFrom('finance_cash_sessions')
      .select(['status', 'closing_expected_xaf', 'variance_xaf'])
      .where('id', '=', toBin(session))
      .executeTakeFirstOrThrow();
    expect(closed).toMatchObject({ status: 'PENDING_VALIDATION' });
    expect(Number(closed.closing_expected_xaf)).toBe(6_000);
    expect(Number(closed.variance_xaf)).toBe(quarantinedCash);

    await world.expectStockLedgerOk([product.id, other.id]);
    await world.expectCashOk([session], []);
  });

  it('AV-212 : un fait daté pendant la perte, poussé après le retrait, et un fait daté pendant un blocage, poussé après le déblocage, restent en quarantaine', async () => {
    // A, perdue depuis 12:00, est retirée à 18:05 : sa vente de 15:00, poussée ensuite, était appliquée
    // (le retrait réécrivait la date de statut). C est bloquée de 18:06 à 18:10 : sa vente de 18:08 aussi.
    world.setNow(at('18:05'));
    await world.ok(world.admin, {
      type: 'identity.device.retire',
      aggregateType: 'DEVICE',
      aggregateId: A.deviceId,
      occurredAt: at('18:05'),
      payload: { reason: 'Tablette jamais retrouvée' },
    });
    const tabletA = world.tablet(A);
    const lateA = tabletA.enqueue(A.userId, cashSale(3, at('15:00')));
    world.setNow(at('18:06'));
    await world.ok(world.admin, {
      type: 'identity.device.block',
      aggregateType: 'DEVICE',
      aggregateId: C.deviceId,
      occurredAt: at('18:06'),
      payload: { reason: 'Contrôle' },
    });
    const tabletC = world.tablet(C);
    const blockedC = tabletC.enqueue(C.userId, cashSale(2, at('18:08')));
    world.setNow(at('18:10'));
    await world.ok(world.admin, {
      type: 'identity.device.unblock',
      aggregateType: 'DEVICE',
      aggregateId: C.deviceId,
      occurredAt: at('18:10'),
      payload: {},
    });
    world.setNow(at('18:12'));
    const stockBefore = await world.onHand(product.id);
    const quotaC = await world.remainingOf(quotas.C);
    await tabletA.syncUntilSettled(A.userId);
    await tabletC.syncUntilSettled(C.userId);
    for (const [tablet, envelope] of [
      [tabletA, lateA],
      [tabletC, blockedC],
    ] as const) {
      expect(tablet.resultOf(envelope.command_id)).toMatchObject({
        status: 'CONFLICT',
        error: { code: 'DEVICE_REVOKED' },
      });
      expect(
        await db
          .selectFrom('sales_sales')
          .select('id')
          .where('id', '=', toBin(envelope.aggregate_id))
          .executeTakeFirst(),
      ).toBeUndefined();
    }
    // INV-ADM-03 : aucun effet sur le stock ni sur le quota de C.
    expect(await world.onHand(product.id)).toBe(stockBefore);
    expect(await world.remainingOf(quotas.C)).toBe(quotaC);
    await world.expectStockLedgerOk([product.id, other.id]);
  });
});
