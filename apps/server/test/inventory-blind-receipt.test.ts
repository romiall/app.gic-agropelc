/**
 * P5-16 — réception sans document (BR-STK-024 ; SM-TRANSFER `[*] → UNMATCHED → MATCHED` ; AV-177 à
 * AV-179, AV-181), à travers le **vrai** pipeline de commande, sur un PDV `EXCLUSIVE_DEVICE` :
 * rapprochement immédiat, différé (requalification au lot et à la valeur de l'expédition) et par le
 * balayage, choix entre plusieurs expéditions, excédent (BR-STK-021), politique d'écart absente,
 * garde d'appareil et emplacement non exclusif (AV-178), validations, idempotence, lot requis
 * (INV-STK-13), expédition multi-lots, lot biologique, délai paramétré et conflit `TRANSFER_UNMATCHED`,
 * concurrence, jeu `transfers`, garde de désactivation (INV-STK-07), transit des transferts (INV-STK-08).
 * Revue adverse : réception avec document d'un transfert qu'une réception sans document attend (21,
 * AV-180), excédent refusé en ligne et reçu après coup (22, BR-STK-021), quantité reçue bornée (23),
 * balayage isolé par paire en échec (24).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Change } from '@gic/contracts';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import {
  pairTransit,
  recordStockMove,
  transferTransit,
  verifyTransferTransit,
  lotHeadcount,
} from '../src/modules/inventory/application/public/index.js';
import { sweepUnmatchedTransfers } from '../src/modules/inventory/application/transfer-matching.js';
import { inventoryLocationDeactivationGuard } from '../src/modules/inventory/application/location-deactivation-guard.js';
import {
  UnmatchedTransferSweepJob,
  UNMATCHED_TRANSFER_SWEEP_JOB_TYPE,
} from '../src/modules/inventory/application/jobs/unmatched-transfer-sweep-job.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  withoutActivePolicies,
} from './helpers.js';
import {
  at,
  balanceOf,
  blindReceive,
  conflictsOn,
  createTransferWorld,
  dispatch,
  linesOf,
  movesOf,
  newLot,
  newPair,
  newProduct,
  send,
  setSiteSetting,
  stock,
  transferOf,
  transitOf,
  type Pair,
  type TransferWorld,
} from './transfer-world.js';

describe('réception sans document (P5-16, BR-STK-024)', () => {
  let world: TransferWorld;

  beforeAll(async () => {
    world = await createTransferWorld();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const sweep = (pairs: readonly Pair[], clockAt = at('12:00')) =>
    sweepUnmatchedTransfers(
      db,
      { idGenerator: world.idGenerator, clock: { now: () => new Date(clockAt) } },
      { pairs: pairs.map((p) => ({ fromLocationId: p.store, toLocationId: p.pos })) },
    );

  async function pairTransitOf(pair: Pair, productId: string): Promise<number> {
    return (
      (
        await pairTransit(db, { fromLocationId: pair.store, toLocationId: pair.pos, productId })
      ).get(productId) ?? 0
    );
  }

  /** Paire neuve d'un site magasin propre (paramètre de site sans effet sur les autres tests). */
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

  it('1 — hors ligne, aucune expédition connue : document BLIND_RECEIPT UNMATCHED imputé sur le transit de la paire', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);

    const { receiptId, result } = await blindReceive(world, pair, [
      { productId, receivedQtyBase: 58 },
    ]);
    expect(result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_UNMATCHED'],
      server_refs: { transferId: receiptId },
    });
    const row = await transferOf(receiptId);
    expect(row.transfer_kind).toBe('BLIND_RECEIPT');
    expect(row.status).toBe('UNMATCHED');
    expect(row.doc_number).toMatch(/^TRF-/);
    expect(fromBin(row.received_by!)).toBe(world.seller.userId);
    expect(row.matched_transfer_id).toBeNull();
    const moves = await movesOf(receiptId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ move_type: 'TRANSFER_RECEIPT', lot_id: null });
    expect(fromBin(moves[0]!.to_location_id)).toBe(pair.pos);
    expect((await balanceOf(productId, pair.pos)).qty).toBe(58);
    expect((await transitOf(productId)).qty).toBe(-58);
    expect(await pairTransitOf(pair, productId)).toBe(-58);
    expect(await conflictsOn('TRANSFER_UNMATCHED', receiptId)).toHaveLength(0);
    expect(await conflictsOn('CUSTODY_DEVICE_MISMATCH', pair.pos)).toHaveLength(0);
  });

  it('2 — rapprochement immédiat (expédition déjà appliquée, reçu = expédié) : RECEIVED, MATCHED, lot de l’expédition', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world, 'OPTIONAL');
    const lotId = await newLot(world, productId);
    await stock(world, productId, pair.store, 100, { lotId });
    const { transferId, result: dispatched } = await dispatch(world, pair, productId, 58);
    expect(dispatched.status).toBe('APPLIED');

    const { receiptId, result } = await blindReceive(world, pair, [
      { productId, receivedQtyBase: 58 },
    ]);
    expect(result).toMatchObject({
      status: 'APPLIED',
      server_refs: { transferId: receiptId, matchedTransferId: transferId },
    });
    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('RECEIVED');
    expect(fromBin(transfer.received_by!)).toBe(world.seller.userId);
    expect(transfer.received_at?.toISOString()).toBe(at('08:00'));
    const receipt = await transferOf(receiptId);
    expect(receipt.status).toBe('MATCHED');
    expect(fromBin(receipt.matched_transfer_id!)).toBe(transferId);
    expect(receipt.matched_at).not.toBeNull();
    expect(await movesOf(receiptId)).toHaveLength(0);
    const receipts = await movesOf(transferId, 'TRANSFER_RECEIPT');
    expect(receipts).toHaveLength(1);
    expect(fromBinOrNull(receipts[0]!.lot_id)).toBe(lotId);
    expect((await balanceOf(productId, pair.pos, lotId)).qty).toBe(58);
    expect(await pairTransitOf(pair, productId)).toBe(0);
    expect(await transferTransit(db, transferId)).toEqual([]);
    expect((await verifyTransferTransit(db, { transferIds: [transferId, receiptId] })).ok).toBe(
      true,
    );
  });

  it('3 — rapprochement immédiat avec écart (58 / 57) : DISCREPANCY_PENDING au nom du vendeur, puis CLOSED', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const { transferId } = await dispatch(world, pair, productId, 58);
    const { result } = await blindReceive(world, pair, [{ productId, receivedQtyBase: 57 }]);
    expect(result.status).toBe('APPLIED');

    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('DISCREPANCY_PENDING');
    const gap = await movesOf(transferId, 'TRANSFER_DISCREPANCY');
    expect(gap.map((m) => Number(m.quantity))).toEqual([1]);
    const requestId = fromBin(transfer.approval_request_id!);
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select(['requested_by', 'operation_type'])
      .where('id', '=', toBin(requestId))
      .executeTakeFirstOrThrow();
    expect(fromBin(request.requested_by)).toBe(world.seller.userId);

    const approved = await send(
      world,
      world.approver,
      'approvals.request.approve',
      requestId,
      {
        requestId,
      },
      { occurredAt: at('11:00') },
    );
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    expect((await transferOf(transferId)).status).toBe('CLOSED');
    expect((await movesOf(transferId, 'LOSS_CONFIRMATION')).map((m) => Number(m.quantity))).toEqual(
      [1],
    );
    expect(await transferTransit(db, transferId)).toEqual([]);
    expect((await verifyTransferTransit(db, { transferIds: [transferId] })).ok).toBe(true);
  });

  it('4 — rapprochement différé : la réception d’abord, l’expédition ensuite, sans transit résiduel', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100, { unitCostXaf: 700 });
    const { receiptId } = await blindReceive(world, pair, [{ productId, receivedQtyBase: 58 }], {
      occurredAt: at('08:00'),
    });
    const { transferId, result } = await dispatch(world, pair, productId, 58, {
      occurredAt: at('06:00'),
    });
    expect(result).toMatchObject({
      status: 'APPLIED',
      server_refs: { matchedBlindReceiptId: receiptId },
    });
    const receipt = await transferOf(receiptId);
    expect(receipt.status).toBe('MATCHED');
    expect(fromBin(receipt.matched_transfer_id!)).toBe(transferId);
    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('RECEIVED');
    expect(fromBin(transfer.received_by!)).toBe(world.seller.userId);
    expect(transfer.received_at?.toISOString()).toBe(at('08:00'));
    // Réception non rapprochée contre-passée au coût d'origine, transfert reçu au coût de l'expédition.
    const blindMoves = await movesOf(receiptId);
    expect(blindMoves.map((m) => [m.move_type, m.is_reversal])).toEqual([
      ['TRANSFER_RECEIPT', 0],
      ['TRANSFER_DISPATCH', 1],
    ]);
    expect(await transferTransit(db, receiptId)).toEqual([]);
    expect(await transferTransit(db, transferId)).toEqual([]);
    expect(await pairTransitOf(pair, productId)).toBe(0);
    expect(await balanceOf(productId, pair.pos)).toEqual({ qty: 58, valueXaf: 58 * 700 });
    expect((await balanceOf(productId, pair.store)).qty).toBe(42);
    expect((await verifyTransferTransit(db, { transferIds: [transferId, receiptId] })).ok).toBe(
      true,
    );
  });

  it('5 — différé avec écart (57 reçus pour 58) : écart daté de la réception et demandé par le réceptionnaire', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    await blindReceive(world, pair, [{ productId, receivedQtyBase: 57 }], {
      occurredAt: at('08:00'),
    });
    const { transferId } = await dispatch(world, pair, productId, 58, { occurredAt: at('09:30') });
    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('DISCREPANCY_PENDING');
    const [gap] = await movesOf(transferId, 'TRANSFER_DISCREPANCY');
    expect(Number(gap!.quantity)).toBe(1);
    expect(gap!.occurred_at.toISOString()).toBe(at('08:00'));
    expect(fromBin(gap!.created_by)).toBe(world.seller.userId);
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select(['requested_by', 'requested_at'])
      .where('id', '=', transfer.approval_request_id!)
      .executeTakeFirstOrThrow();
    expect(fromBin(request.requested_by)).toBe(world.seller.userId);
  });

  it('6 — différé, produit expédié absent de la réception : écart de toute la ligne', async () => {
    const pair = await newPair(world);
    const p1 = await newProduct(world);
    const p2 = await newProduct(world);
    await stock(world, p1, pair.store, 100);
    await stock(world, p2, pair.store, 100);
    await blindReceive(world, pair, [{ productId: p1, receivedQtyBase: 58 }]);
    const transferId = freshUuid();
    const result = await send(
      world,
      world.keeper,
      'inventory.transfer.dispatch',
      transferId,
      {
        fromLocationId: pair.store,
        toLocationId: pair.pos,
        lines: [
          { productId: p1, unitCode: 'TETE', quantityBase: 58 },
          { productId: p2, unitCode: 'TETE', quantityBase: 10 },
        ],
      },
      { occurredAt: at('09:00') },
    );
    expect(result.status).toBe('APPLIED');
    expect((await transferOf(transferId)).status).toBe('DISCREPANCY_PENDING');
    const lines = await linesOf(transferId);
    const byProduct = new Map(lines.map((l) => [fromBin(l.product_id), l]));
    expect(Number(byProduct.get(p1)!.received_qty_base)).toBe(58);
    expect(Number(byProduct.get(p2)!.received_qty_base)).toBe(0);
    expect(Number(byProduct.get(p2)!.discrepancy_qty_base)).toBe(10);
  });

  it('7 — pas de rapprochement : produit non expédié, autre paire ; excédent rapproché et signalé (BR-STK-021) ; mode EXACT', async () => {
    const pair = await newPair(world);
    const other = await newPair(world);
    const p1 = await newProduct(world);
    const p2 = await newProduct(world);
    await stock(world, p1, pair.store, 100);
    await stock(world, p1, other.store, 100);
    const { transferId } = await dispatch(world, pair, p1, 58);
    const unknownProduct = await blindReceive(world, pair, [{ productId: p2, receivedQtyBase: 3 }]);
    expect((await transferOf(unknownProduct.receiptId)).status).toBe('UNMATCHED');
    const otherPair = await blindReceive(world, other, [{ productId: p1, receivedQtyBase: 58 }]);
    expect((await transferOf(otherPair.receiptId)).status).toBe('UNMATCHED');
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');

    // Excédent (59 reçus pour 58) : rapproché, excédent reçu, conflit informatif au magasinier.
    const { receiptId, result } = await blindReceive(world, pair, [
      { productId: p1, receivedQtyBase: 59 },
    ]);
    expect(result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_OVER_RECEIVED'],
      server_refs: { matchedTransferId: transferId },
    });
    expect((await transferOf(transferId)).status).toBe('RECEIVED');
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
    const [over] = await conflictsOn('TRANSFER_OVER_RECEIVED', transferId);
    expect(over).toMatchObject({ owner_role: 'MAGASINIER', applied: 1, status: 'OPEN' });
    expect((await balanceOf(p1, pair.pos)).qty).toBe(59);
    // Le transit du transfert porte l'excédent, attendu par INV-STK-08 (−1).
    expect((await transferTransit(db, transferId)).map((l) => l.qty)).toEqual([-1]);
    expect((await verifyTransferTransit(db, { transferIds: [transferId] })).ok).toBe(true);

    // Mode EXACT réglé sur le site : un excédent ne rapproche plus.
    const exact = await pairOnOwnSite();
    await setSiteSetting(
      world,
      'inventory.blind_receipt_match_mode',
      exact.siteId,
      'EXACT',
      at('00:00'),
    );
    await stock(world, p1, exact.store, 100);
    const { transferId: exactTransfer } = await dispatch(world, exact, p1, 58);
    const exactOver = await blindReceive(world, exact, [{ productId: p1, receivedQtyBase: 59 }]);
    expect((await transferOf(exactOver.receiptId)).status).toBe('UNMATCHED');
    const exactSame = await blindReceive(world, exact, [{ productId: p1, receivedQtyBase: 58 }]);
    expect((await transferOf(exactSame.receiptId)).status).toBe('MATCHED');
    expect((await transferOf(exactTransfer)).status).toBe('RECEIVED');
  });

  it('8 — plusieurs expéditions de la paire : l’identique la plus ancienne, sinon la partielle la plus ancienne (AV-177)', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 500);
    const a = await dispatch(world, pair, productId, 60, { occurredAt: at('05:00') });
    const b = await dispatch(world, pair, productId, 58, { occurredAt: at('05:30') });
    const c = await dispatch(world, pair, productId, 58, { occurredAt: at('06:00') });
    const first = await blindReceive(world, pair, [{ productId, receivedQtyBase: 58 }]);
    expect(first.result).toMatchObject({ server_refs: { matchedTransferId: b.transferId } });
    const second = await blindReceive(world, pair, [{ productId, receivedQtyBase: 58 }]);
    expect(second.result).toMatchObject({ server_refs: { matchedTransferId: c.transferId } });
    const third = await blindReceive(world, pair, [{ productId, receivedQtyBase: 50 }]);
    expect(third.result).toMatchObject({ server_refs: { matchedTransferId: a.transferId } });
    expect((await transferOf(a.transferId)).status).toBe('DISCREPANCY_PENDING');
  });

  it('9 — politique d’écart absente : réception appliquée non rapprochée (jamais rejetée), puis rapprochée par le balayage', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const { transferId, receiptId } = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => {
        const sent = await dispatch(world, pair, productId, 58);
        const received = await blindReceive(world, pair, [{ productId, receivedQtyBase: 57 }]);
        expect(received.result.status).toBe('APPLIED_WITH_WARNINGS');
        expect((await transferOf(received.receiptId)).status).toBe('UNMATCHED');
        expect((await transferOf(sent.transferId)).status).toBe('DISPATCHED');
        // Le balayage ne rapproche pas tant que la politique manque.
        expect((await sweep([pair])).matched).toBe(0);
        return { transferId: sent.transferId, receiptId: received.receiptId };
      },
    );
    const swept = await sweep([pair]);
    expect(swept.matched).toBe(1);
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
    expect((await transferOf(transferId)).status).toBe('DISCREPANCY_PENDING');
    const events = await db
      .selectFrom('platform_domain_events')
      .select(['event_type'])
      .where('aggregate_id', '=', toBin(transferId))
      .where('event_type', 'like', 'StockTransfer%')
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['StockTransferDiscrepancyDetected']);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select('action')
      .where('entity_id', '=', toBin(transferId))
      .where('action', '=', 'inventory.transfer.auto_match')
      .execute();
    expect(audit).toHaveLength(1);
    // Rejouable : aucun second rapprochement.
    expect((await sweep([pair])).matched).toBe(0);
    expect(await pairTransitOf(pair, productId)).toBe(0);
  });

  it('10 — destination partagée : en ligne refusée sans effet ; hors ligne appliquée avec CUSTODY_DEVICE_MISMATCH (AV-178)', async () => {
    const pair = await newPair(world, { mode: 'SHARED' });
    const productId = await newProduct(world);
    const online = await blindReceive(world, pair, [{ productId, receivedQtyBase: 5 }], {
      offline: false,
    });
    expect(online.result).toMatchObject({
      status: 'REJECTED',
      error: { code: 'BLIND_RECEIPT_NOT_ALLOWED' },
    });
    expect(
      await db
        .selectFrom('inventory_stock_transfers')
        .select('id')
        .where('id', '=', toBin(online.receiptId))
        .executeTakeFirst(),
    ).toBeUndefined();
    expect((await balanceOf(productId, pair.pos)).qty).toBe(0);

    const offline = await blindReceive(world, pair, [{ productId, receivedQtyBase: 5 }]);
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_UNMATCHED', 'CUSTODY_DEVICE_MISMATCH'],
    });
    const [conflict] = await conflictsOn('CUSTODY_DEVICE_MISMATCH', pair.pos);
    expect(conflict).toMatchObject({ entity_type: 'LOCATION', applied: 1 });
    expect((conflict!.details as Record<string, unknown>)['reason']).toBe('LOCATION_NOT_EXCLUSIVE');
  });

  it('11 — appareil non désigné hors ligne : appliquée + DEVICE_NOT_DESIGNATED ; en ligne : aucune garde', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    const secondDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, world.seller.userId, { status: 'ACTIVE' }));
    const intruder = { userId: world.seller.userId, deviceId: secondDevice };
    const offline = await blindReceive(world, pair, [{ productId, receivedQtyBase: 4 }], {
      actor: intruder,
    });
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_UNMATCHED', 'CUSTODY_DEVICE_MISMATCH'],
    });
    const found = await conflictsOn('CUSTODY_DEVICE_MISMATCH', pair.pos);
    expect((found[0]!.details as Record<string, unknown>)['reason']).toBe('DEVICE_NOT_DESIGNATED');
    const online = await blindReceive(world, pair, [{ productId, receivedQtyBase: 4 }], {
      actor: intruder,
      offline: false,
    });
    expect(online.result).toMatchObject({ warnings: ['TRANSFER_UNMATCHED'] });
    expect(await conflictsOn('CUSTODY_DEVICE_MISMATCH', pair.pos)).toHaveLength(1);
  });

  it('12 — stock mobile EXCLUSIVE_USER : appareil principal sans conflit, autre appareil → DEVICE_NOT_PRIMARY', async () => {
    const custodian = world.keeper;
    await db
      .updateTable('identity_users')
      .set({ primary_device_id: toBin(custodian.deviceId) })
      .where('id', '=', toBin(custodian.userId))
      .execute();
    const pair = await newPair(world, {
      mode: 'EXCLUSIVE_USER',
      custodianUserId: custodian.userId,
    });
    const productId = await newProduct(world);
    const primary = await blindReceive(world, pair, [{ productId, receivedQtyBase: 2 }], {
      actor: custodian,
    });
    expect(primary.result).toMatchObject({ warnings: ['TRANSFER_UNMATCHED'] });
    const other = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, custodian.userId, { status: 'ACTIVE' }));
    const second = await blindReceive(world, pair, [{ productId, receivedQtyBase: 2 }], {
      actor: { userId: custodian.userId, deviceId: other },
    });
    expect(second.result).toMatchObject({
      warnings: ['TRANSFER_UNMATCHED', 'CUSTODY_DEVICE_MISMATCH'],
    });
    const found = await conflictsOn('CUSTODY_DEVICE_MISMATCH', pair.pos);
    expect((found[0]!.details as Record<string, unknown>)['reason']).toBe('DEVICE_NOT_PRIMARY');
  });

  it('13 — validations : emplacements, identifiant pris, produit et unité inconnus → REJECTED sans effet', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    const transit = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_TRANSIT')
      .executeTakeFirstOrThrow();
    const receive = (payload: Record<string, unknown>, aggregateId = freshUuid()) =>
      send(
        world,
        world.seller,
        'inventory.transfer.receive',
        aggregateId,
        {
          fromLocationId: pair.store,
          toLocationId: pair.pos,
          lines: [{ productId, unitCode: 'TETE', receivedQtyBase: 1 }],
          ...payload,
        },
        { offline: true, occurredAt: at('08:00') },
      );
    const codeOf = (r: Awaited<ReturnType<typeof receive>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;

    expect(codeOf(await receive({ fromLocationId: fromBin(transit.id) }))).toBe('LOCATION_INVALID');
    expect(codeOf(await receive({ fromLocationId: freshUuid() }))).toBe('LOCATION_INVALID');
    expect(codeOf(await receive({ fromLocationId: pair.pos }))).toMatch(/^VALIDATION_ERROR/);
    const { transferId } = await dispatch(world, pair, productId, 1, { offline: true });
    expect(codeOf(await receive({}, transferId))).toBe('TRANSFER_ID_TAKEN');
    expect(
      codeOf(
        await receive({
          lines: [{ productId: freshUuid(), unitCode: 'TETE', receivedQtyBase: 1 }],
        }),
      ),
    ).toBe('PRODUCT_INVALID');
    expect(
      codeOf(
        await receive({ lines: [{ productId, unitCode: 'XX-INCONNUE', receivedQtyBase: 1 }] }),
      ),
    ).toBe('UNIT_INVALID');
    expect(codeOf(await receive({ transferId: freshUuid() }))).toMatch(/^VALIDATION_ERROR/);
  });

  it('14 — idempotence : la même commande rejouée donne le même résultat, un document, un jeu de mouvements (INV-SYN-01)', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    const commandId = freshUuid();
    const receiptId = freshUuid();
    const deviceSeq = 900_000 + Math.floor(Math.random() * 100_000);
    const first = await blindReceive(world, pair, [{ productId, receivedQtyBase: 9 }], {
      commandId,
      receiptId,
      deviceSeq,
    });
    const replay = await blindReceive(world, pair, [{ productId, receivedQtyBase: 9 }], {
      commandId,
      receiptId,
      deviceSeq,
    });
    expect(replay.result).toEqual(first.result);
    expect(await movesOf(receiptId)).toHaveLength(1);
    expect((await balanceOf(productId, pair.pos)).qty).toBe(9);
  });

  describe('lots (INV-STK-13, AV-179)', () => {
    it('15a — produit REQUIRED en ligne : sans lot, refusé (LOT_REQUIRED) ; avec un lot indiqué, reçu sur ce lot', async () => {
      const pair = await newPair(world);
      const productId = await newProduct(world, 'REQUIRED');
      const lotId = await newLot(world, productId);
      const refused = await blindReceive(world, pair, [{ productId, receivedQtyBase: 5 }], {
        offline: false,
      });
      expect(refused.result).toMatchObject({ status: 'REJECTED', error: { code: 'LOT_REQUIRED' } });
      const accepted = await blindReceive(world, pair, [{ productId, receivedQtyBase: 5, lotId }], {
        offline: false,
      });
      expect(accepted.result.status).toBe('APPLIED_WITH_WARNINGS');
      const [move] = await movesOf(accepted.receiptId);
      expect(fromBinOrNull(move!.lot_id)).toBe(lotId);
      // Lot indiqué d'un autre produit : ignoré (indicatif), donc refus en ligne.
      const foreignLot = await newLot(world, await newProduct(world, 'REQUIRED'));
      const ignored = await blindReceive(
        world,
        pair,
        [{ productId, receivedQtyBase: 5, lotId: foreignLot }],
        {
          offline: false,
        },
      );
      expect(ignored.result).toMatchObject({ status: 'REJECTED', error: { code: 'LOT_REQUIRED' } });
    });

    it('15b — lot biologique, réception hors ligne sans lot puis expédition : requalifiée au lot de l’expédition, lot clôturable', async () => {
      const pair = await newPair(world);
      const productId = await newProduct(world, 'REQUIRED');
      const lotId = await newLot(world, productId, { originType: 'PRODUCTION_LOT' });
      await stock(world, productId, pair.store, 100, { lotId });
      const { receiptId } = await blindReceive(world, pair, [{ productId, receivedQtyBase: 58 }]);
      expect((await balanceOf(productId, pair.pos, null)).qty).toBe(58);
      const { transferId } = await dispatch(world, pair, productId, 58, {
        occurredAt: at('09:00'),
      });
      expect((await transferOf(receiptId)).status).toBe('MATCHED');
      expect((await balanceOf(productId, pair.pos, null)).qty).toBe(0);
      expect((await balanceOf(productId, pair.pos, lotId)).qty).toBe(58);
      expect((await transitOf(productId, lotId)).qty).toBe(0);
      expect((await transitOf(productId, null)).qty).toBe(0);
      expect(await transferTransit(db, transferId)).toEqual([]);
      expect(await lotHeadcount(db, { lotId, scope: 'UNSOLD' })).toBe(100);
      // Tout le lot sort (vente au PDV et au magasin) : effectif non vendu nul, lot clôturable.
      const customer = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_CUSTOMER')
        .executeTakeFirstOrThrow();
      for (const [from, qty] of [
        [pair.pos, 58],
        [pair.store, 42],
      ] as const) {
        await db.transaction().execute((trx) =>
          recordStockMove(
            trx,
            { idGenerator: world.idGenerator },
            {
              productId,
              lotId,
              quantityBase: qty,
              fromLocationId: from,
              toLocationId: fromBin(customer.id),
              moveType: 'SALE',
              occurredAt: new Date(at('10:00')),
              sourceDocType: 'SALE',
              sourceDocId: freshUuid(),
              createdBy: world.seller.userId,
              allowNegative: false,
            },
          ),
        );
      }
      expect(await lotHeadcount(db, { lotId, scope: 'UNSOLD' })).toBe(0);
    });

    it('15c — expédition multi-lots rapprochée sur-le-champ : un mouvement par lot, transit nul par lot et en valeur', async () => {
      const pair = await newPair(world);
      const productId = await newProduct(world, 'OPTIONAL');
      const lot1 = await newLot(world, productId, { rankAt: at('01:00', '2026-09-01') });
      const lot2 = await newLot(world, productId, { rankAt: at('01:00', '2026-09-02') });
      await stock(world, productId, pair.store, 30, { lotId: lot1, unitCostXaf: 400 });
      await stock(world, productId, pair.store, 40, { lotId: lot2, unitCostXaf: 600 });
      const { transferId } = await dispatch(world, pair, productId, 58);
      expect((await movesOf(transferId, 'TRANSFER_DISPATCH')).length).toBe(2);
      await blindReceive(world, pair, [{ productId, receivedQtyBase: 50 }]);
      const receipts = await movesOf(transferId, 'TRANSFER_RECEIPT');
      expect(receipts.map((m) => [fromBinOrNull(m.lot_id), Number(m.quantity)])).toEqual([
        [lot1, 30],
        [lot2, 20],
      ]);
      const gaps = await movesOf(transferId, 'TRANSFER_DISCREPANCY');
      expect(gaps.map((m) => [fromBinOrNull(m.lot_id), Number(m.quantity)])).toEqual([[lot2, 8]]);
      // Transit du transfert soldé par lot et en valeur : la valeur expédiée se retrouve, au franc
      // près, dans la destination et dans la perte en attente.
      expect(await transferTransit(db, transferId)).toEqual([]);
      const dispatched = (await movesOf(transferId, 'TRANSFER_DISPATCH')).reduce(
        (sum, m) => sum + Number(m.value_xaf),
        0,
      );
      const received = receipts.reduce((sum, m) => sum + Number(m.value_xaf), 0);
      const gapValue = gaps.reduce((sum, m) => sum + Number(m.value_xaf), 0);
      expect(received + gapValue).toBe(dispatched);
      expect((await balanceOf(productId, pair.pos)).valueXaf).toBe(received);
    });
  });

  it('16 — balayage : conflit TRANSFER_UNMATCHED au délai (paramètre du site), une seule fois, clos au rapprochement', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const old = await blindReceive(world, pair, [{ productId, receivedQtyBase: 7 }], {
      occurredAt: at('08:00', '2026-10-06'),
    });
    const recent = await blindReceive(world, pair, [{ productId, receivedQtyBase: 3 }], {
      occurredAt: at('11:00'),
    });
    const first = await sweep([pair]);
    expect(first).toMatchObject({ matched: 0, signalled: 1 });
    const [conflict] = await conflictsOn('TRANSFER_UNMATCHED', old.receiptId);
    expect(conflict).toMatchObject({
      owner_role: 'MAGASINIER',
      applied: 1,
      status: 'OPEN',
      entity_type: 'STOCK_TRANSFER',
    });
    expect(fromBin(conflict!.site_id!)).toBe(world.storeSite);
    expect((conflict!.details as Record<string, unknown>)['hours']).toBe(48);
    const events = () =>
      db
        .selectFrom('platform_domain_events')
        .select('event_type')
        .where('event_type', '=', 'StockTransferUnmatched')
        .where('aggregate_id', '=', toBin(old.receiptId))
        .execute();
    expect(await events()).toHaveLength(1);
    expect(await conflictsOn('TRANSFER_UNMATCHED', recent.receiptId)).toHaveLength(0);
    // Rejouable.
    expect((await sweep([pair])).signalled).toBe(0);
    expect(await conflictsOn('TRANSFER_UNMATCHED', old.receiptId)).toHaveLength(1);
    expect(await events()).toHaveLength(1);

    // Délai de 24 h réglé sur le seul site d'une autre paire.
    const short = await pairOnOwnSite();
    await setSiteSetting(
      world,
      'inventory.transfer_unmatched_hours',
      short.siteId,
      24,
      at('00:00', '2026-10-01'),
    );
    const short26h = await blindReceive(world, short, [{ productId, receivedQtyBase: 1 }], {
      occurredAt: at('10:00', '2026-10-08'),
    });
    expect((await sweep([short])).signalled).toBe(1);
    const [shortConflict] = await conflictsOn('TRANSFER_UNMATCHED', short26h.receiptId);
    expect((shortConflict!.details as Record<string, unknown>)['hours']).toBe(24);

    // L'expédition arrive : rapprochement, conflit clos (MERGE, référence du transfert).
    const { transferId } = await dispatch(world, pair, productId, 7, {
      occurredAt: at('09:00', '2026-10-06'),
    });
    expect((await transferOf(old.receiptId)).status).toBe('MATCHED');
    const [closed] = await conflictsOn('TRANSFER_UNMATCHED', old.receiptId);
    expect(closed).toMatchObject({ status: 'RESOLVED', resolution: 'MERGE' });
    expect(closed!.resolution_refs).toEqual([transferId]);
  });

  it('16b — la tâche inventory.transfers.unmatched_sweep s’enregistre et s’exécute par son gestionnaire', async () => {
    const registry = new JobHandlerRegistry();
    new UnmatchedTransferSweepJob(db, world.clock, world.idGenerator, registry).onModuleInit();
    const handler = registry.resolve(UNMATCHED_TRANSFER_SWEEP_JOB_TYPE)!;
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 10);
    const { receiptId } = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => {
        await dispatch(world, pair, productId, 10);
        return blindReceive(world, pair, [{ productId, receivedQtyBase: 9 }]);
      },
    );
    await db.transaction().execute((trx) => handler(trx, { scheduledFor: at('12:00') }));
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
  });

  it('17 — concurrence réception sans document / expédition de la même paire : un seul rapprochement, aucun transit résiduel', async () => {
    for (let round = 0; round < 3; round++) {
      const pair = await newPair(world);
      const productId = await newProduct(world);
      await stock(world, productId, pair.store, 100);
      const transferId = freshUuid();
      const receiptId = freshUuid();
      const dispatchCommand = freshUuid();
      const receiveCommand = freshUuid();
      // Renvoi à l'identique : même identifiant de commande **et** même `device_seq` (l'enveloppe entière est
      // hachée ; un autre `device_seq` serait refusé `COMMAND_ID_REUSED`, revue de P5-23) ; un numéro par tour,
      // unique pour l'appareil (la réception hors ligne le stocke).
      const runDispatch = () =>
        dispatch(world, pair, productId, 20, {
          transferId,
          commandId: dispatchCommand,
          deviceSeq: 9_000_000 + round * 2,
        });
      const runReceive = () =>
        blindReceive(world, pair, [{ productId, receivedQtyBase: 20 }], {
          receiptId,
          commandId: receiveCommand,
          deviceSeq: 9_000_001 + round * 2,
        });
      let [sent, received] = await Promise.all([runDispatch(), runReceive()]);
      // Un interblocage résiduel n'est qu'un « réessayer plus tard » : la commande est rejouée.
      for (let retry = 0; retry < 3 && sent.result.status === 'RETRY_LATER'; retry++)
        sent = await runDispatch();
      for (let retry = 0; retry < 3 && received.result.status === 'RETRY_LATER'; retry++) {
        received = await runReceive();
      }
      expect(sent.result.status, JSON.stringify(sent.result)).toMatch(/^APPLIED/);
      expect(received.result.status, JSON.stringify(received.result)).toMatch(/^APPLIED/);
      expect((await transferOf(receiptId)).status).toBe('MATCHED');
      expect((await transferOf(transferId)).status).toBe('RECEIVED');
      expect(await movesOf(transferId, 'TRANSFER_RECEIPT')).toHaveLength(1);
      expect(await pairTransitOf(pair, productId)).toBe(0);
      expect((await balanceOf(productId, pair.pos)).qty).toBe(20);
    }
  });

  it('18 — jeu transfers : le PDV reçoit la réception UNMATCHED puis MATCHED, et le transfert RECEIVED', async () => {
    const pull = new SyncPullService(db);
    const cursorRow = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirstOrThrow();
    const cursor = Number(cursorRow.seq ?? 0);
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 10);
    const { receiptId } = await blindReceive(world, pair, [{ productId, receivedQtyBase: 10 }]);
    const fetch = async (): Promise<readonly Change[]> =>
      (
        await pull.pull(
          { dataset: 'transfers', cursor, limit: 500 },
          {
            authenticatedUserId: world.seller.userId,
            authenticatedDeviceId: world.seller.deviceId,
            now: world.clock.now(),
          },
        )
      ).changes.filter((c) => c.scope_id === pair.pos);
    const before = (await fetch()).filter((c) => c.entity_id === receiptId);
    expect(before.at(-1)?.data).toMatchObject({
      status: 'UNMATCHED',
      transfer_kind: 'BLIND_RECEIPT',
    });
    const { transferId } = await dispatch(world, pair, productId, 10);
    const changes = await fetch();
    expect(changes.filter((c) => c.entity_id === receiptId).at(-1)?.data).toMatchObject({
      status: 'MATCHED',
      matched_transfer_id: transferId,
    });
    expect(changes.filter((c) => c.entity_id === transferId).at(-1)?.data).toMatchObject({
      status: 'RECEIVED',
    });
  });

  it('19 — garde de désactivation (INV-STK-07) : une réception UNMATCHED retient l’emplacement, plus après rapprochement', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await blindReceive(world, pair, [{ productId, receivedQtyBase: 6 }]);
    const guard = () =>
      db.transaction().execute((trx) => inventoryLocationDeactivationGuard(trx, pair.store));
    expect(await guard()).toMatchObject({ code: 'LOCATION_HAS_OPEN_TRANSFER' });
    await stock(world, productId, pair.store, 6);
    await dispatch(world, pair, productId, 6, { occurredAt: at('09:00') });
    expect((await balanceOf(productId, pair.store)).qty).toBe(0);
    expect(await guard()).toBeNull();
  });

  it('20 — INV-STK-08 : le contrôle du transit relève un transfert clos dont le transit n’est pas soldé ou dont les lignes retournées sont fausses', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    // Expédié, jamais reçu : présenté comme « reçu » par une écriture directe, son transit reste de 58.
    const { transferId: stuck } = await dispatch(world, pair, productId, 58);
    // Reçu normalement, puis présenté comme « retourné » sans ligne retournée.
    const { transferId: wrong } = await dispatch(world, pair, productId, 20);
    await send(
      world,
      world.seller,
      'inventory.transfer.receive',
      wrong,
      {
        transferId: wrong,
        lines: (await linesOf(wrong)).map((line) => ({
          transferLineId: fromBin(line.id),
          receivedQtyBase: 20,
        })),
      },
      { occurredAt: at('09:00') },
    );
    expect((await transferOf(wrong)).status).toBe('RECEIVED');
    expect((await verifyTransferTransit(db, { transferIds: [wrong] })).ok).toBe(true);

    try {
      await db
        .updateTable('inventory_stock_transfers')
        .set({ status: 'RECEIVED' })
        .where('id', '=', toBin(stuck))
        .execute();
      await db
        .updateTable('inventory_stock_transfers')
        .set({
          status: 'RETURNED',
          returned_by: toBin(world.keeper.userId),
          returned_at: new Date(at('10:00')),
          return_reason: 'écriture directe du test',
        })
        .where('id', '=', toBin(wrong))
        .execute();
      const verdict = await verifyTransferTransit(db, { transferIds: [stuck, wrong] });
      expect(verdict.ok).toBe(false);
      expect(verdict.breaches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            transferId: stuck,
            reason: 'TRANSIT_NOT_SETTLED',
            actualQty: 58,
          }),
          expect.objectContaining({
            transferId: wrong,
            reason: 'RETURNED_QTY_MISMATCH',
            expectedQty: 20,
          }),
        ]),
      );
    } finally {
      // La base d'essai est partagée : la réconciliation quotidienne relit tous les transferts clos.
      await db
        .updateTable('inventory_stock_transfers')
        .set({ status: 'DISPATCHED' })
        .where('id', '=', toBin(stuck))
        .execute();
      await db
        .updateTable('inventory_stock_transfers')
        .set({ status: 'RECEIVED', returned_by: null, returned_at: null, return_reason: null })
        .where('id', '=', toBin(wrong))
        .execute();
    }
    expect((await verifyTransferTransit(db, { transferIds: [stuck, wrong] })).ok).toBe(true);
  });

  /** Réception avec document d'un transfert expédié (une seule ligne). */
  async function receiveWithDocument(
    transferId: string,
    receivedQtyBase: number,
    options: { readonly offline?: boolean } = {},
  ) {
    const [line] = await linesOf(transferId);
    return send(
      world,
      world.seller,
      'inventory.transfer.receive',
      transferId,
      { transferId, lines: [{ transferLineId: fromBin(line!.id), receivedQtyBase }] },
      { offline: options.offline ?? false, occurredAt: at('09:00') },
    );
  }

  it('21 — réception avec document d’un transfert qu’une réception sans document attend : refusée en ligne, en quarantaine hors ligne, jamais comptée deux fois (AV-180)', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    // Aucune politique d'écart : la réception sans document de 8 sur 10 reste non rapprochée mais
    // imputée sur le transit de la paire (destination +8).
    const pending = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => {
        const sent = await dispatch(world, pair, productId, 10);
        const receipt = await blindReceive(world, pair, [{ productId, receivedQtyBase: 8 }]);
        expect((await transferOf(receipt.receiptId)).status).toBe('UNMATCHED');
        expect((await transferOf(sent.transferId)).status).toBe('DISPATCHED');
        return { ...sent, receiptId: receipt.receiptId };
      },
    );
    expect((await balanceOf(productId, pair.pos)).qty).toBe(8);

    // La réception « complète » avec le document n'a pas besoin de politique (aucun écart) : sans
    // garde, elle apporterait 10 unités de plus (18 pour 10 expédiées).
    const online = await receiveWithDocument(pending.transferId, 10);
    expect(online).toMatchObject({
      status: 'REJECTED',
      error: { code: 'TRANSFER_STATUS_INVALID' },
    });
    const offline = await receiveWithDocument(pending.transferId, 10, { offline: true });
    expect(offline.status).toBe('CONFLICT');
    const [conflict] = await conflictsOn('TRANSFER_OVER_RECEIVED', pending.transferId);
    expect(conflict).toMatchObject({ applied: 0, status: 'OPEN' });
    expect(conflict!.details as Record<string, unknown>).toMatchObject({
      reason: 'BLIND_RECEIPT_PENDING',
      blindReceiptId: pending.receiptId,
    });
    expect((await transferOf(pending.transferId)).status).toBe('DISPATCHED');
    expect(await movesOf(pending.transferId, 'TRANSFER_RECEIPT')).toHaveLength(0);
    expect((await balanceOf(productId, pair.pos)).qty).toBe(8);
    expect(await pairTransitOf(pair, productId)).toBe(2);

    // La politique existe (celle du monde de test, rétablie) : le balayage rapproche la réception,
    // le transfert passe en écart (8 sur 10) et le transit de la paire se solde.
    expect((await sweep([pair])).matched).toBe(1);
    expect((await transferOf(pending.receiptId)).status).toBe('MATCHED');
    expect((await transferOf(pending.transferId)).status).toBe('DISCREPANCY_PENDING');
    expect((await balanceOf(productId, pair.pos)).qty).toBe(8);
    expect(await pairTransitOf(pair, productId)).toBe(0);
    // Le transfert n'est plus à recevoir : la réception avec document est refusée comme toute seconde.
    expect(await receiveWithDocument(pending.transferId, 10)).toMatchObject({
      status: 'REJECTED',
      error: { code: 'TRANSFER_STATUS_INVALID' },
    });

    // Une réception sans document qui ne peut pas être celle de ce transfert (autre produit) ne le
    // bloque pas.
    const other = await newPair(world);
    const p1 = await newProduct(world);
    const p2 = await newProduct(world);
    await stock(world, p1, other.store, 100);
    const sent = await dispatch(world, other, p1, 10);
    const stranger = await blindReceive(world, other, [{ productId: p2, receivedQtyBase: 3 }]);
    expect((await transferOf(stranger.receiptId)).status).toBe('UNMATCHED');
    expect((await receiveWithDocument(sent.transferId, 10)).status).toBe('APPLIED');
    expect((await transferOf(sent.transferId)).status).toBe('RECEIVED');
  });

  it('22 — excédent d’une réception sans document rapprochée sur-le-champ : refusé en ligne (BR-STK-021), appliqué hors ligne ; rapproché après coup, reçu et signalé', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const { transferId } = await dispatch(world, pair, productId, 58);

    const over = await blindReceive(world, pair, [{ productId, receivedQtyBase: 59 }], {
      offline: false,
    });
    expect(over.result).toMatchObject({
      status: 'REJECTED',
      error: { code: 'TRANSFER_OVER_RECEIVED' },
    });
    expect(
      await db
        .selectFrom('inventory_stock_transfers')
        .select('id')
        .where('id', '=', toBin(over.receiptId))
        .executeTakeFirst(),
    ).toBeUndefined();
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
    expect((await balanceOf(productId, pair.pos)).qty).toBe(0);
    expect(await conflictsOn('TRANSFER_OVER_RECEIVED', transferId)).toHaveLength(0);

    // La quantité exacte, en ligne, est rapprochée sans difficulté.
    const exact = await blindReceive(world, pair, [{ productId, receivedQtyBase: 58 }], {
      offline: false,
    });
    expect(exact.result).toMatchObject({
      status: 'APPLIED',
      server_refs: { matchedTransferId: transferId },
    });

    // Rapprochement après coup : la réception (fait déjà appliqué, hors ligne) est reçue et signalée,
    // même quand l'expédition arrive en ligne.
    const late = await newPair(world);
    await stock(world, productId, late.store, 100);
    const receipt = await blindReceive(world, late, [{ productId, receivedQtyBase: 59 }]);
    const dispatched = await dispatch(world, late, productId, 58, { occurredAt: at('09:00') });
    expect(dispatched.result.status).toBe('APPLIED');
    expect((await transferOf(receipt.receiptId)).status).toBe('MATCHED');
    expect((await transferOf(dispatched.transferId)).status).toBe('RECEIVED');
    const [informative] = await conflictsOn('TRANSFER_OVER_RECEIVED', dispatched.transferId);
    expect(informative).toMatchObject({ applied: 1, status: 'OPEN' });
    expect((await balanceOf(productId, late.pos)).qty).toBe(59);
  });

  it('23 — réception avec document : une quantité reçue démesurée est refusée en validation (jamais rejouée sans fin)', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const { transferId } = await dispatch(world, pair, productId, 10);
    for (const received of [5e11, -1, 1.0005]) {
      const result = await receiveWithDocument(transferId, received, { offline: true });
      expect(result.status, String(received)).toBe('REJECTED');
      if (result.status === 'REJECTED') expect(result.error.code).toMatch(/^VALIDATION_ERROR/);
    }
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
    expect(await movesOf(transferId, 'TRANSFER_RECEIPT')).toHaveLength(0);
    expect((await receiveWithDocument(transferId, 10, { offline: true })).status).toBe('APPLIED');
  });

  it('24 — balayage : une paire en échec n’empêche pas les suivantes ; la tâche lève à la fin pour être rejouée', async () => {
    const poisoned = await newPair(world);
    const healthy = await newPair(world);
    const control = await newPair(world);
    const p1 = await newProduct(world);
    const p2 = await newProduct(world);
    const p0 = await newProduct(world);
    await stock(world, p1, poisoned.store, 100);
    await stock(world, p2, healthy.store, 100);
    await stock(world, p0, control.store, 100);
    const setup = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => ({
        bad: await dispatch(world, poisoned, p1, 58),
        badReceipt: await blindReceive(world, poisoned, [{ productId: p1, receivedQtyBase: 57 }]),
        good: await dispatch(world, healthy, p2, 58),
        goodReceipt: await blindReceive(world, healthy, [{ productId: p2, receivedQtyBase: 57 }]),
      }),
    );
    const holder = await dispatch(world, control, p0, 5);
    const holderReceipt = await blindReceive(world, control, [
      { productId: p0, receivedQtyBase: 5 },
    ]);
    expect((await transferOf(holderReceipt.receiptId)).status).toBe('MATCHED');

    // État corrompu à dessein : une autre réception tient déjà le transfert « bad » comme transfert
    // rapproché (UNIQUE matched_transfer_id) : son rapprochement échoue en erreur SQL déterministe.
    await db
      .updateTable('inventory_stock_transfers')
      .set({ matched_transfer_id: toBin(setup.bad.transferId) })
      .where('id', '=', toBin(holderReceipt.receiptId))
      .execute();
    try {
      const result = await sweep([poisoned, healthy]);
      expect(result.pairs).toBe(2);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.pair).toEqual({
        fromLocationId: poisoned.store,
        toLocationId: poisoned.pos,
      });
      expect(result.failures[0]!.message.length).toBeGreaterThan(0);
      // La paire saine, placée après la paire en échec, est rapprochée quand même.
      expect(result.matched).toBe(1);
      expect((await transferOf(setup.goodReceipt.receiptId)).status).toBe('MATCHED');
      expect((await transferOf(setup.good.transferId)).status).toBe('DISCREPANCY_PENDING');
      // La paire en échec n'a laissé aucun effet partiel (transaction annulée en entier).
      expect((await transferOf(setup.badReceipt.receiptId)).status).toBe('UNMATCHED');
      expect((await transferOf(setup.bad.transferId)).status).toBe('DISPATCHED');
      expect(await movesOf(setup.badReceipt.receiptId)).toHaveLength(1);
      expect(await pairTransitOf(poisoned, p1)).toBe(1);

      // La tâche, elle, lève à la fin (rejouée, 5 essais) après avoir traité toutes les paires.
      const registry = new JobHandlerRegistry();
      new UnmatchedTransferSweepJob(db, world.clock, world.idGenerator, registry).onModuleInit();
      const handler = registry.resolve(UNMATCHED_TRANSFER_SWEEP_JOB_TYPE)!;
      await expect(
        db.transaction().execute((trx) => handler(trx, { scheduledFor: at('12:00') })),
      ).rejects.toThrow(/paire\(s\) en échec/);
    } finally {
      await db
        .updateTable('inventory_stock_transfers')
        .set({ matched_transfer_id: toBin(holder.transferId) })
        .where('id', '=', toBin(holderReceipt.receiptId))
        .execute();
    }
    // Réparé : la paire en échec est rapprochée au balayage suivant, rien ne reste en suspens.
    const repaired = await sweep([poisoned]);
    expect(repaired).toMatchObject({ matched: 1, failures: [] });
    expect((await transferOf(setup.badReceipt.receiptId)).status).toBe('MATCHED');
    expect(await pairTransitOf(poisoned, p1)).toBe(0);
  });
});
