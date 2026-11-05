/**
 * AV-520 — rapprochement **manuel** et annulation d'une réception sans document (BR-STK-024, AV-177 ; SM-TRANSFER
 * `UNMATCHED → MATCHED | CANCELLED`), à travers le vrai pipeline, sur le monde de transferts de P5-16
 * (`transfer-world.ts`) : un PDV `EXCLUSIVE_DEVICE`, une réception saisie hors ligne par la tablette.
 *
 * - `inventory.transfer.match_blind` : le transfert choisi par la personne est reçu au lot et à la valeur de
 *   l'expédition, la réception sans document est contre-passée du transit de la paire, le conflit de délai est clos ;
 *   refusée hors ligne, hors paire, produit hors expédition, politique d'écart absente, réception ou transfert qui n'a
 *   plus le bon statut.
 * - `inventory.transfer.cancel_blind` : contre-passation exacte de la réception ; refusée si la marchandise a été
 *   vendue ou déplacée, ou si la réception est déjà rapprochée ; conflit de délai clos, alerte fermée par l'événement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pairTransit,
  recordStockMove,
  verifyTransferTransit,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, insertTestSite, withoutActivePolicies } from './helpers.js';
import {
  at,
  balanceOf,
  blindReceive,
  conflictsOn,
  createTransferWorld,
  dispatch,
  movesOf,
  newPair,
  newProduct,
  send,
  setSiteSetting,
  stock,
  transferOf,
  type Pair,
  type TransferWorld,
} from './transfer-world.js';

describe('rapprochement manuel et annulation d’une réception sans document (AV-520)', () => {
  let world: TransferWorld;

  beforeAll(async () => {
    world = await createTransferWorld();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** Paire neuve d'un site magasin propre (paramètre de site sans effet sur les autres essais). */
  async function pairOnOwnSite(): Promise<Pair & { readonly siteId: string }> {
    const siteId = await db
      .transaction()
      .execute((trx) => insertTestSite(trx, world.admin.userId, world.zoneId));
    const pair = await newPair(world);
    await db
      .updateTable('organization_locations')
      .set({ site_id: toBin(siteId) })
      .where('id', '=', toBin(pair.store))
      .execute();
    return { ...pair, siteId };
  }

  const matchManually = (
    receiptId: string,
    transferId: string,
    options: { readonly offline?: boolean; readonly actor?: typeof world.keeper } = {},
  ) =>
    send(
      world,
      options.actor ?? world.keeper,
      'inventory.transfer.match_blind',
      receiptId,
      { transferId },
      { occurredAt: at('10:00'), offline: options.offline ?? false },
    );

  const cancelReceipt = (receiptId: string, reason = 'Saisie sur le mauvais emplacement') =>
    send(
      world,
      world.keeper,
      'inventory.transfer.cancel_blind',
      receiptId,
      { reason },
      { occurredAt: at('10:00') },
    );

  const codeOf = (result: { status: string; error?: { code: string } | undefined }) =>
    result.error?.code ?? result.status;

  async function pairTransitOf(pair: Pair, productId: string): Promise<number> {
    return (
      (
        await pairTransit(db, { fromLocationId: pair.store, toLocationId: pair.pos, productId })
      ).get(productId) ?? 0
    );
  }

  it('mode EXACT : une réception de 57 pour 58 expédiés ne se rapproche pas seule ; le rapprochement manuel la reçoit (écart validé)', async () => {
    const own = await pairOnOwnSite();
    await setSiteSetting(
      world,
      'inventory.blind_receipt_match_mode',
      own.siteId,
      'EXACT',
      at('00:00'),
    );
    const productId = await newProduct(world);
    await stock(world, productId, own.store, 100);
    const { transferId } = await dispatch(world, own, productId, 58);
    const { receiptId } = await blindReceive(world, own, [{ productId, receivedQtyBase: 57 }]);
    expect((await transferOf(receiptId)).status).toBe('UNMATCHED');
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
    expect(await pairTransitOf(own, productId)).toBe(1);

    const result = await matchManually(receiptId, transferId);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'APPLIED',
      server_refs: { transferId, receiptId, status: 'DISCREPANCY_PENDING' },
    });
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
    expect((await transferOf(transferId)).status).toBe('DISCREPANCY_PENDING');
    // Le transit de la paire est soldé : la réception sans document est contre-passée, l'expédition est reçue.
    expect(await pairTransitOf(own, productId)).toBe(0);
    expect((await balanceOf(productId, own.pos)).qty).toBe(57);
    expect((await verifyTransferTransit(db, { transferIds: [transferId] })).ok).toBe(true);
    // Rejeu par une autre commande : la réception est déjà rapprochée.
    expect(codeOf(await matchManually(receiptId, transferId))).toBe('RECEIPT_STATUS_INVALID');
  });

  it('refus : hors ligne, hors paire, transfert qui n’est pas expédié, produit absent de l’expédition', async () => {
    const own = await pairOnOwnSite();
    await setSiteSetting(
      world,
      'inventory.blind_receipt_match_mode',
      own.siteId,
      'EXACT',
      at('00:00'),
    );
    const other = await newPair(world);
    const p1 = await newProduct(world);
    const p2 = await newProduct(world);
    await stock(world, p1, own.store, 100);
    await stock(world, p1, other.store, 100);
    const { transferId } = await dispatch(world, own, p1, 58);
    const otherDispatch = await dispatch(world, other, p1, 10);
    const { receiptId } = await blindReceive(world, own, [{ productId: p1, receivedQtyBase: 57 }]);

    // Hors ligne : en ligne seulement ; inconnu : introuvable.
    expect(codeOf(await matchManually(receiptId, transferId, { offline: true }))).toBe(
      'ONLINE_REQUIRED',
    );
    expect(codeOf(await matchManually('00000000-0000-7000-8000-00000000dead', transferId))).toBe(
      'NOT_FOUND',
    );
    // Transfert d'une autre paire.
    expect(codeOf(await matchManually(receiptId, otherDispatch.transferId))).toBe(
      'TRANSFER_PAIR_MISMATCH',
    );
    // Le transfert choisi doit être expédié (la réception sans document n'est pas un transfert).
    expect(codeOf(await matchManually(receiptId, receiptId))).toBe('NOT_FOUND');
    // Produit reçu absent de l'expédition : jamais rapproché, même à la main (AV-177).
    const unknown = await blindReceive(world, own, [{ productId: p2, receivedQtyBase: 3 }]);
    expect(codeOf(await matchManually(unknown.receiptId, transferId))).toBe(
      'RECEIPT_NOT_MATCHABLE',
    );
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
    expect((await transferOf(unknown.receiptId)).status).toBe('UNMATCHED');
    // Un transfert déjà reçu n'est plus rapprochable.
    const exact = await blindReceive(world, own, [{ productId: p1, receivedQtyBase: 58 }]);
    expect((await transferOf(exact.receiptId)).status).toBe('MATCHED');
    expect(codeOf(await matchManually(receiptId, transferId))).toBe('TRANSFER_STATUS_INVALID');
  });

  it('un écart sans politique de validation active est refusé (comme à l’automatique), sans écriture', async () => {
    const own = await pairOnOwnSite();
    await setSiteSetting(
      world,
      'inventory.blind_receipt_match_mode',
      own.siteId,
      'EXACT',
      at('00:00'),
    );
    const productId = await newProduct(world);
    await stock(world, productId, own.store, 100);
    const { transferId, receiptId } = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => {
        const sent = await dispatch(world, own, productId, 58);
        const received = await blindReceive(world, own, [{ productId, receivedQtyBase: 57 }]);
        const refused = await matchManually(received.receiptId, sent.transferId);
        expect(codeOf(refused)).toBe('CONTROL_POLICY_MISSING');
        return { transferId: sent.transferId, receiptId: received.receiptId };
      },
    );
    expect((await transferOf(receiptId)).status).toBe('UNMATCHED');
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
    expect(await pairTransitOf(own, productId)).toBe(1);
  });

  it('annulation : la réception est contre-passée du transit, le conflit de délai est clos, la marchandise sort de la destination', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    const { receiptId } = await blindReceive(world, pair, [{ productId, receivedQtyBase: 12 }]);
    expect((await transferOf(receiptId)).status).toBe('UNMATCHED');
    expect((await balanceOf(productId, pair.pos)).qty).toBe(12);
    expect(await pairTransitOf(pair, productId)).toBe(-12);

    // Motif exigé.
    expect(codeOf(await cancelReceipt(receiptId, ''))).toMatch(/^VALIDATION_ERROR/);
    const result = await cancelReceipt(receiptId);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'APPLIED',
      server_refs: { receiptId },
    });
    const cancelled = await transferOf(receiptId);
    expect(cancelled.status).toBe('CANCELLED');
    expect((await balanceOf(productId, pair.pos)).qty).toBe(0);
    expect(await pairTransitOf(pair, productId)).toBe(0);
    // Mouvements : l'entrée d'origine et son inverse exact (INV-STK-04).
    const moves = await movesOf(receiptId);
    expect(moves).toHaveLength(2);
    expect(moves.filter((m) => m.is_reversal === 1)).toHaveLength(1);
    // Déjà annulée : plus de seconde annulation par une autre commande.
    expect(codeOf(await cancelReceipt(receiptId))).toBe('RECEIPT_STATUS_INVALID');
    // L'événement qui ferme l'alerte `TRANSFER_UNMATCHED` est publié sous l'identifiant de la réception.
    const events = await db
      .selectFrom('platform_domain_events')
      .select(['event_type', 'producer_module'])
      .where('aggregate_id', '=', toBin(receiptId))
      .where('event_type', '=', 'BlindReceiptCancelled')
      .execute();
    expect(events).toEqual([{ event_type: 'BlindReceiptCancelled', producer_module: 'inventory' }]);
  });

  it('annulation refusée : réception déjà rapprochée, marchandise déjà sortie de la destination, hors ligne', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    // Rapprochée : l'annulation est réservée à une réception non rapprochée.
    const { transferId } = await dispatch(world, pair, productId, 20);
    const matched = await blindReceive(world, pair, [{ productId, receivedQtyBase: 20 }]);
    expect((await transferOf(matched.receiptId)).status).toBe('MATCHED');
    expect(codeOf(await cancelReceipt(matched.receiptId))).toBe('RECEIPT_STATUS_INVALID');
    expect((await transferOf(transferId)).status).toBe('RECEIVED');

    // Réception de 9 non rapprochée (aucune expédition en cours pour la paire).
    const used = await blindReceive(world, pair, [{ productId, receivedQtyBase: 9 }], {
      occurredAt: at('09:00'),
    });
    expect((await transferOf(used.receiptId)).status).toBe('UNMATCHED');
    // Marchandise déjà partie de la destination (vendue) : annulation refusée, sans écriture.
    const customer = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_CUSTOMER')
      .executeTakeFirstOrThrow();
    const onHand = (await balanceOf(productId, pair.pos)).qty;
    expect(onHand).toBe(29);
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator: world.idGenerator },
        {
          productId,
          quantityBase: 25,
          fromLocationId: pair.pos,
          toLocationId: fromBin(customer.id),
          moveType: 'SALE',
          occurredAt: new Date(at('09:30')),
          sourceDocType: 'SALE',
          sourceDocId: freshUuid(),
          createdBy: world.seller.userId,
          allowNegative: false,
        },
      ),
    );
    expect((await balanceOf(productId, pair.pos)).qty).toBe(4);
    const refused = await cancelReceipt(used.receiptId);
    expect(codeOf(refused)).toBe('RECEIPT_GOODS_USED');
    expect((await transferOf(used.receiptId)).status).toBe('UNMATCHED');
    expect((await balanceOf(productId, pair.pos)).qty).toBe(4);

    // Hors ligne : en ligne seulement ; inconnue : introuvable.
    const offline = await send(
      world,
      world.keeper,
      'inventory.transfer.cancel_blind',
      used.receiptId,
      { reason: 'x' },
      { occurredAt: at('10:00'), offline: true },
    );
    expect(codeOf(offline)).toBe('ONLINE_REQUIRED');
    expect(
      codeOf(
        await send(
          world,
          world.keeper,
          'inventory.transfer.cancel_blind',
          '00000000-0000-7000-8000-00000000dead',
          { reason: 'x' },
          { occurredAt: at('10:00') },
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await conflictsOn('TRANSFER_UNMATCHED', used.receiptId)).toEqual([]);
  });
});
