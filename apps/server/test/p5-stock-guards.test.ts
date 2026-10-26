/**
 * P5-23 — gardes des commandes de stock (revue adverse, AV-182, AV-223, besoins S-20 et S-40), sur un PDV
 * complet (`PosWorld` : magasin du site S, comptoir partagé du site P, magasiniers de chaque site, vendeurs
 * du PDV) :
 * - portée des commandes de stock (AV-182 (a)) : la permission vaut à sa portée, sur l'une des extrémités ;
 * - quantités bornées à `numeric(14,3)` (S-20) ;
 * - refus motivé d'une demande, note du demandeur gardée ; expédition hors ligne d'une demande refusée
 *   (expédition directe et conflit) ou déjà expédiée (quarantaine) ; mouvement interne au même site et
 *   sous la garde de l'auteur (S-40, AV-223) ;
 * - quotas : un seul actif par couple quel que soit le lot ; fait hors ligne jugé sur le quota en vigueur
 *   à sa date ; rapprochement différé d'une réception sans document sans faux `STOCK_NEGATIVE`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '@gic/contracts';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';
import { tx } from './cash-transfer-fixtures.js';
import { PosWorld, PRICE, codeOf, warningsOf, type Actor, type Sellable } from './pos-world.js';

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

describe('P5-23 — gardes des commandes de stock', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let seller: Actor;
  let seller2: Actor;

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('2026-09-28', '06:00'), sellers: 2 });
    seller = world.sellers[0]!;
    seller2 = world.sellers[1]!;
  }, 120_000);

  afterAll(async () => {
    try {
      await world?.close(at('2026-10-03', '23:00'));
    } finally {
      await closeTestDb();
    }
  });

  const momo = (amountXaf: number) => ({
    methodCode: 'MOBILE_MONEY_ORANGE',
    amountXaf,
    reference: `OM${freshUuid().replace(/-/g, '').slice(-16)}`,
    cashAccountId: world.mobileAcc,
  });
  const mobileSale = (product: Sellable, quantity: number, occurredAt: string) => ({
    type: 'sales.sale.record',
    aggregateType: 'SALE',
    occurredAt,
    payload: {
      fromLocationId: world.counter,
      lines: [world.line(product, quantity)],
      payments: [momo(quantity * PRICE)],
    },
  });
  /** Événements `StockTransfer*` d'un transfert, dans l'ordre de publication (P9-11 (3/3), AV-480). */
  const transferEventsOf = async (transferId: string): Promise<string[]> =>
    (
      await db
        .selectFrom('platform_domain_events')
        .select('event_type')
        .where('aggregate_id', '=', toBin(transferId))
        .where('event_type', 'like', 'StockTransfer%')
        .orderBy('seq')
        .execute()
    ).map((row) => row.event_type);
  const conflicts = (type: string, entityId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['status', 'applied', 'details'])
      .where('conflict_type', '=', type)
      .where('entity_id', '=', toBin(entityId))
      .execute();
  const productConflicts = async (type: string, productId: string) =>
    (
      await db
        .selectFrom('sync_sync_conflicts')
        .select(['details'])
        .where('conflict_type', '=', type)
        .execute()
    ).filter((row) => {
      const details = (
        typeof row.details === 'string' ? JSON.parse(row.details) : row.details
      ) as Record<string, unknown>;
      return String(details['productId']).toLowerCase() === productId;
    });
  async function offline(
    actor: Actor,
    command: Parameters<PosWorld['online']>[1],
  ): Promise<CommandResult> {
    const tablet = world.tablet(actor);
    tablet.enqueue(actor.userId, command);
    const [result] = await tablet.sync(actor.userId);
    return result!;
  }

  it('AV-182 : portée des commandes de stock — hors du site, refus en ligne comme hors ligne ; une extrémité suffit pour un transfert', async () => {
    const day = '2026-09-28';
    world.setNow(at(day, '08:30'));
    const product = await world.product('Portée');
    await world.stockIn(product.id, 20, at(day, '07:00'));
    await world.stockIn(product.id, 20, at(day, '07:00'), world.store);
    const loss = () => ({
      type: 'inventory.loss.declare',
      aggregateType: 'LOSS_DECLARATION',
      occurredAt: at(day, '08:00'),
      payload: {
        locationId: world.counter,
        productId: product.id,
        quantityBase: 1,
        unitCode: 'PIECE',
        quantity: 1,
        category: 'CASSE',
        comment: 'Tombé',
      },
    });
    // Magasinier du site S sur le comptoir du site P.
    expect(codeOf(await world.online(world.magS, loss()))).toBe('FORBIDDEN_SCOPE');
    expect(codeOf(await offline(world.magS, loss()))).toBe('FORBIDDEN_SCOPE');
    await world.ok(world.magP, loss());
    // Demande du magasin S vers le comptoir P par le magasinier de P : la destination est dans sa portée.
    await world.ok(world.magP, {
      type: 'inventory.transfer.request',
      aggregateType: 'STOCK_TRANSFER',
      occurredAt: at(day, '08:05'),
      payload: {
        fromLocationId: world.store,
        toLocationId: world.counter,
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 5 }],
      },
    });
    // Inventaire du comptoir par le magasinier de S : hors portée.
    const count = await world.online(world.magS, {
      type: 'inventory.count.open',
      aggregateType: 'INVENTORY_COUNT',
      occurredAt: at(day, '08:10'),
      payload: { locationId: world.counter, countType: 'PARTIAL' },
    });
    expect(codeOf(count)).toBe('FORBIDDEN_SCOPE');
  });

  it('S-20 : une quantité au-delà de numeric(14,3) est refusée en validation, jamais rejouée', async () => {
    const product = await world.product('Borne');
    const result = await world.online(world.magP, {
      type: 'inventory.loss.declare',
      aggregateType: 'LOSS_DECLARATION',
      occurredAt: at('2026-09-28', '08:20'),
      payload: {
        locationId: world.counter,
        productId: product.id,
        quantityBase: 1e12,
        unitCode: 'PIECE',
        quantity: 1e12,
        category: 'CASSE',
      },
    });
    expect(codeOf(result)).toMatch(/^VALIDATION_ERROR/);
    expect(result.error?.message_fr).toContain('« quantityBase » : valeur trop grande');
  });

  it('S-40 : refus motivé qui garde la note du demandeur ; expédition hors ligne d’une demande refusée (expédition directe, conflit) ou déjà expédiée (quarantaine)', async () => {
    const day = '2026-09-28';
    world.setNow(at(day, '09:00'));
    const product = await world.product('Demande refusée');
    await world.stockIn(product.id, 30, at(day, '07:00'), world.store);
    const request = async (notes: string) => {
      const id = freshUuid();
      await world.ok(world.magP, {
        type: 'inventory.transfer.request',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: id,
        occurredAt: at(day, '09:00'),
        payload: {
          fromLocationId: world.store,
          toLocationId: world.counter,
          lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 5 }],
          notes,
        },
      });
      return id;
    };
    const declined = await request('Pour le marché du samedi');
    const decline = (comment?: string) =>
      world.online(world.magS, {
        type: 'inventory.transfer.decline',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: declined,
        occurredAt: at(day, '09:05'),
        payload: { transferId: declined, ...(comment !== undefined ? { comment } : {}) },
      });
    expect(codeOf(await decline())).toMatch(/^VALIDATION_ERROR/);
    expect((await decline('Stock réservé')).status).toBe('APPLIED');
    const declinedRow = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'notes'])
      .where('id', '=', toBin(declined))
      .executeTakeFirstOrThrow();
    expect(declinedRow).toEqual({
      status: 'DECLINED',
      notes: 'Pour le marché du samedi\nRefus : Stock réservé',
    });

    // Le magasinier de S avait expédié hors ligne avant le refus : la marchandise est partie.
    const dispatchOf = (transferId: string) => ({
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: transferId,
      occurredAt: at(day, '09:02'),
      payload: {
        transferId,
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 5 }],
      },
    });
    const late = await offline(world.magS, dispatchOf(declined));
    expect(late.status, JSON.stringify(late)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(late)).toContain('TRANSFER_REQUEST_CLOSED');
    const directId =
      late.status === 'APPLIED_WITH_WARNINGS' ? late.server_refs?.['transferId'] : undefined;
    expect(directId).toBeDefined();
    expect(directId).not.toBe(declined);
    const direct = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'from_location_id', 'to_location_id'])
      .where('id', '=', toBin(directId!))
      .executeTakeFirstOrThrow();
    expect([
      direct.status,
      fromBin(direct.from_location_id),
      fromBin(direct.to_location_id),
    ]).toEqual(['DISPATCHED', world.store, world.counter]);
    expect(await world.onHand(product.id, world.store)).toBe(25);
    expect(await conflicts('TRANSFER_REQUEST_CLOSED', directId!)).toHaveLength(1);
    // La demande refusée n'a publié que sa demande ; l'expédition directe qui la remplace publie la sienne,
    // sous son propre identifiant (notification du site destinataire).
    expect(await transferEventsOf(declined)).toEqual(['StockTransferRequested']);
    expect(await transferEventsOf(directId!)).toEqual(['StockTransferDispatched']);

    // Une demande expédiée en ligne puis « réexpédiée » hors ligne : quarantaine, sans effet.
    const shipped = await request('Seconde demande');
    await world.ok(world.magS, dispatchOf(shipped));
    expect(await world.onHand(product.id, world.store)).toBe(20);
    const twice = await offline(world.magS, dispatchOf(shipped));
    expect(twice.status, JSON.stringify(twice)).toBe('CONFLICT');
    expect(await world.onHand(product.id, world.store)).toBe(20);
    const quarantined = await conflicts('TRANSFER_DISPATCH_CONFLICT', shipped);
    expect(quarantined.map((row) => Number(row.applied))).toEqual([0]);
    // La quarantaine n'a rien expédié : aucun second « expédié », donc aucune notification de plus.
    expect(await transferEventsOf(shipped)).toEqual([
      'StockTransferRequested',
      'StockTransferDispatched',
    ]);
  });

  it('S-40 : mouvement interne au même site et sous la garde de l’auteur — autre site refusé ; stock mobile d’un autre refusé en ligne, signalé hors ligne', async () => {
    const day = '2026-09-28';
    world.setNow(at(day, '10:00'));
    const product = await world.product('Mouvement interne');
    await world.stockIn(product.id, 20, at(day, '07:00'));
    // Stock mobile du second vendeur, sur le site du PDV (garde exclusive).
    const mobile = freshUuid();
    await tx((trx) =>
      trx
        .insertInto('organization_locations')
        .values({
          id: toBin(mobile),
          site_id: toBin(world.siteP),
          code: mobile.replace(/-/g, '').slice(-8).toUpperCase(),
          name: 'Stock mobile',
          location_type: 'MOBILE',
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: toBin(seller2.userId),
          created_by: toBin(world.root),
        })
        .execute(),
    );
    const move = (toLocationId: string) => ({
      type: 'inventory.transfer.move_internal',
      aggregateType: 'STOCK_TRANSFER',
      occurredAt: at(day, '10:00'),
      payload: {
        fromLocationId: world.counter,
        toLocationId,
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 2 }],
      },
    });
    expect(codeOf(await world.online(world.magP, move(world.store)))).toBe('LOCATION_INVALID');
    expect(codeOf(await world.online(world.magP, move(mobile)))).toBe('INTERNAL_MOVE_CUSTODY');
    const accepted = await offline(world.magP, move(mobile));
    expect(accepted.status, JSON.stringify(accepted)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(accepted)).toContain('CUSTODY_DEVICE_MISMATCH');
    expect(await world.onHand(product.id, mobile)).toBe(2);
  });

  it('quotas : un seul quota actif par couple, quel que soit le lot (AV-160)', async () => {
    const day = '2026-09-29';
    world.setNow(at(day, '08:00'));
    const product = await world.product('Quota par lot');
    await world.stockIn(product.id, 40, at(day, '07:00'));
    const lotId = freshUuid();
    await tx((trx) =>
      trx
        .insertInto('inventory_stock_lots')
        .values({
          id: toBin(lotId),
          lot_code: `L-${lotId.slice(-8)}`,
          product_id: toBin(product.id),
          origin_type: 'SUPPLIER_LOT',
          fifo_rank_at: new Date(at(day, '07:00')),
          created_by: toBin(world.root),
        })
        .execute(),
    );
    await world.grant(seller, product.id, 10, at(day, '08:00'));
    const second = await world.online(world.magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      occurredAt: at(day, '08:01'),
      payload: {
        holderUserId: seller.userId,
        holderDeviceId: seller.deviceId,
        locationId: world.counter,
        productId: product.id,
        lotId,
        quantityBase: 10,
      },
    });
    expect(codeOf(second)).toBe('ALLOCATION_ALREADY_ACTIVE');
  });

  it('quotas : un fait hors ligne antérieur à l’octroi du quota actif est jugé sur le quota révoqué, pas imputé au nouveau', async () => {
    const day = '2026-09-30';
    world.setNow(at(day, '09:00'));
    const product = await world.product('Révoquer puis réaccorder');
    await world.stockIn(product.id, 40, at(day, '07:00'));
    const first = await world.grant(seller, product.id, 20, at(day, '09:00'));
    // La tablette vend hors ligne à 10:00, sur le premier quota.
    const tablet = world.tablet(seller);
    tablet.enqueue(seller.userId, mobileSale(product, 8, at(day, '10:00')));
    // Le magasinier réduit le quota : révocation, puis nouvel octroi de 5.
    world.setNow(at(day, '11:00'));
    expect((await world.revoke(first, at(day, '11:00'))).status).toMatch(/^APPLIED/);
    world.setNow(at(day, '11:05'));
    const second = await world.grant(seller, product.id, 5, at(day, '11:05'));
    // La tablette, toujours hors ligne, vend 4 à 12:00, puis synchronise.
    world.setNow(at(day, '12:30'));
    tablet.enqueue(seller.userId, mobileSale(product, 4, at(day, '12:00')));
    const results = await tablet.sync(seller.userId);
    expect(results.map((result) => result.status)).toEqual(['APPLIED', 'APPLIED']);
    // Seule la vente de 12:00 consomme le nouveau quota ; celle de 10:00, couverte par le premier au moment
    // de sa révocation (reste 20), ne signale rien.
    expect(await world.remainingOf(second)).toBe(1);
    expect(await productConflicts('ALLOCATION_EXCEEDED', product.id)).toEqual([]);
  });

  it('AV-211 : faits antérieurs à la révocation, synchronisés après elle, comparés en cumul au reste révoqué', async () => {
    const day = '2026-10-02';
    world.setNow(at(day, '09:00'));
    const product = await world.product('Cumul après révocation');
    await world.stockIn(product.id, 60, at(day, '07:00'));
    const quota = await world.grant(seller2, product.id, 25, at(day, '09:00'));
    const tablet = world.tablet(seller2);
    for (const hhmm of ['10:00', '10:10', '10:20']) {
      tablet.enqueue(seller2.userId, mobileSale(product, 10, at(day, hhmm)));
    }
    world.setNow(at(day, '11:00'));
    expect((await world.revoke(quota, at(day, '11:00'))).status).toMatch(/^APPLIED/);
    world.setNow(at(day, '11:30'));
    const results = await tablet.sync(seller2.userId);
    expect(results.map((result) => result.status)).toEqual([
      'APPLIED',
      'APPLIED',
      'APPLIED_WITH_WARNINGS',
    ]);
    expect(warningsOf(results[2])).toContain('ALLOCATION_EXCEEDED');
    // Chaque vente seule (10) tenait dans le reste révoqué (25) ; la troisième fait dépasser le cumul (30).
    expect(await productConflicts('ALLOCATION_EXCEEDED', product.id)).toHaveLength(1);
    const onQuota = await conflicts('ALLOCATION_EXCEEDED', quota);
    expect(onQuota).toHaveLength(1);
    const details = (
      typeof onQuota[0]!.details === 'string'
        ? JSON.parse(onQuota[0]!.details)
        : onQuota[0]!.details
    ) as Record<string, unknown>;
    expect([details['earlierAfterRevocation'], details['excess']]).toEqual(['20.000', '5.000']);
  });

  it('réception sans document rapprochée après des ventes : aucun faux STOCK_NEGATIVE (les entrées d’abord)', async () => {
    const day = '2026-10-01';
    world.setNow(at(day, '08:00'));
    const product = await world.product('Rapprochement différé');
    await world.stockIn(product.id, 30, at(day, '07:00'), world.store);
    // Le comptoir reçoit 10 sans document (hors ligne), puis en vend 6.
    const received = await offline(seller, {
      type: 'inventory.transfer.receive',
      aggregateType: 'STOCK_TRANSFER',
      occurredAt: at(day, '08:00'),
      payload: {
        fromLocationId: world.store,
        toLocationId: world.counter,
        lines: [{ productId: product.id, unitCode: 'PIECE', receivedQtyBase: 10 }],
      },
    });
    expect(received.status, JSON.stringify(received)).toMatch(/^APPLIED/);
    world.setNow(at(day, '09:00'));
    await world.ok(seller, mobileSale(product, 6, at(day, '09:00')));
    // L'expédition du magasin arrive : rapprochement différé (contre-passation et réception).
    world.setNow(at(day, '10:00'));
    const shipped = await world.ok(world.magS, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      occurredAt: at(day, '07:30'),
      payload: {
        fromLocationId: world.store,
        toLocationId: world.counter,
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 10 }],
      },
    });
    expect(shipped.status === 'APPLIED' || shipped.status === 'APPLIED_WITH_WARNINGS').toBe(true);
    expect(await world.onHand(product.id)).toBe(4);
    expect(await productConflicts('STOCK_NEGATIVE', product.id)).toEqual([]);
    expect(await productConflicts('ALLOCATION_OVERCOMMITTED', product.id)).toEqual([]);
  });
});
