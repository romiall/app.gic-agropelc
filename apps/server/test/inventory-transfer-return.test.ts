/**
 * P5-16 — retour à la source (BR-STK-025 ; SM-TRANSFER `DISPATCHED → RETURNED`) et courses entre
 * retour et réception (AV-183, BR-SYN-007), à travers le **vrai** pipeline : contre-passation exacte
 * de l'expédition (INV-STK-04, multi-lots compris), quota rendu (ADR-033 §8, INV-STK-20), transit
 * soldé (INV-STK-08), quarantaine des faits hors ligne contradictoires, refus en ligne, seconde
 * réception, réception au-delà de l'expédié hors ligne (BR-STK-021), concurrence, jeu `transfers`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Change } from '@gic/contracts';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import {
  transferTransit,
  verifyTransferTransit,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, withoutActivePolicies } from './helpers.js';
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
  stock,
  transferOf,
  type Pair,
  type TransferWorld,
} from './transfer-world.js';

describe('retour à la source et courses (P5-16, BR-STK-025, AV-183)', () => {
  let world: TransferWorld;

  beforeAll(async () => {
    world = await createTransferWorld();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const returnToSource = (
    transferId: string,
    options: {
      readonly offline?: boolean;
      readonly reason?: string;
      readonly actor?: TransferWorld['keeper'];
    } = {},
  ) =>
    send(
      world,
      options.actor ?? world.keeper,
      'inventory.transfer.return_to_source',
      transferId,
      {
        transferId,
        ...(options.reason !== '' ? { reason: options.reason ?? 'Camion en panne' } : {}),
      },
      { offline: options.offline ?? false, occurredAt: at('10:00') },
    );

  async function receiveDocumented(
    transferId: string,
    received: number,
    options: { readonly offline?: boolean } = {},
  ) {
    const [line] = await linesOf(transferId);
    return send(
      world,
      world.seller,
      'inventory.transfer.receive',
      transferId,
      { transferId, lines: [{ transferLineId: fromBin(line!.id), receivedQtyBase: received }] },
      { offline: options.offline ?? false, occurredAt: at('09:00') },
    );
  }

  const codeOf = (result: { status: string; error?: { code: string } }) =>
    result.status === 'REJECTED' ? result.error!.code : result.status;

  it('1 — DISPATCHED → RETURNED : un inverse exact par mouvement d’expédition (multi-lots), transit soldé', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world, 'OPTIONAL');
    const lot1 = await newLot(world, productId, { rankAt: at('01:00', '2026-09-01') });
    const lot2 = await newLot(world, productId, { rankAt: at('01:00', '2026-09-02') });
    await stock(world, productId, pair.store, 30, { lotId: lot1, unitCostXaf: 400 });
    await stock(world, productId, pair.store, 40, { lotId: lot2, unitCostXaf: 600 });
    const before = await balanceOf(productId, pair.store);
    const { transferId } = await dispatch(world, pair, productId, 58);

    const result = await returnToSource(transferId);
    expect(result.status).toBe('APPLIED');
    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('RETURNED');
    expect(fromBin(transfer.returned_by!)).toBe(world.keeper.userId);
    expect(transfer.returned_at?.toISOString()).toBe(at('10:00'));
    expect(transfer.return_reason).toBe('Camion en panne');

    const dispatched = await movesOf(transferId, 'TRANSFER_DISPATCH');
    const inverses = await movesOf(transferId, 'TRANSFER_RECEIPT');
    expect(inverses).toHaveLength(dispatched.length);
    for (const original of dispatched) {
      const inverse = inverses.find((m) => m.reverses_move_id?.equals(original.id));
      expect(inverse).toMatchObject({
        is_reversal: 1,
        quantity: original.quantity,
        value_xaf: original.value_xaf,
      });
      expect(fromBinOrNull(inverse!.lot_id)).toBe(fromBinOrNull(original.lot_id));
      expect(fromBin(inverse!.to_location_id)).toBe(pair.store);
    }
    expect(await balanceOf(productId, pair.store)).toEqual(before);
    expect(await transferTransit(db, transferId)).toEqual([]);
    const [line] = await linesOf(transferId);
    expect(Number(line!.returned_qty_base)).toBe(58);
    expect((await verifyTransferTransit(db, { transferIds: [transferId] })).ok).toBe(true);

    // Hors ligne : même effet.
    const offlineProduct = await newProduct(world);
    await stock(world, offlineProduct, pair.store, 10);
    const offline = await dispatch(world, pair, offlineProduct, 10);
    expect((await returnToSource(offline.transferId, { offline: true })).status).toBe('APPLIED');
    expect((await balanceOf(offlineProduct, pair.store)).qty).toBe(10);
  });

  it('2 — quota consommé à l’expédition rendu au retour s’il est actif (RESTORE), sinon stock commun', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 50);
    const grant = async (): Promise<string> => {
      const allocationId = freshUuid();
      const granted = await send(
        world,
        world.admin,
        'inventory.allocation.grant',
        allocationId,
        {
          holderUserId: world.keeper.userId,
          holderDeviceId: world.keeper.deviceId,
          locationId: pair.store,
          productId,
          quantityBase: 10,
        },
        { aggregateType: 'STOCK_ALLOCATION', occurredAt: at('05:00') },
      );
      expect(granted.status, JSON.stringify(granted)).toBe('APPLIED');
      return allocationId;
    };
    const remaining = async (allocationId: string) =>
      Number(
        (
          await db
            .selectFrom('inventory_stock_allocations')
            .select('quantity_remaining')
            .where('id', '=', toBin(allocationId))
            .executeTakeFirstOrThrow()
        ).quantity_remaining,
      );

    const active = await grant();
    const { transferId } = await dispatch(world, pair, productId, 6);
    expect(await remaining(active)).toBe(4);
    expect((await returnToSource(transferId)).status).toBe('APPLIED');
    expect(await remaining(active)).toBe(10);
    const restore = await db
      .selectFrom('inventory_stock_allocation_entries')
      .select('entry_type')
      .where('allocation_id', '=', toBin(active))
      .where('entry_type', '=', 'RESTORE')
      .execute();
    expect(restore).toHaveLength(1);

    // Quota révoqué entre l'expédition et le retour : la marchandise revient au stock commun.
    const revoked = await send(
      world,
      world.admin,
      'inventory.allocation.revoke',
      active,
      {
        reason: 'Fin de journée',
      },
      { aggregateType: 'STOCK_ALLOCATION', occurredAt: at('05:30') },
    );
    expect(revoked.status).toBe('APPLIED');
    const second = await grant();
    const again = await dispatch(world, pair, productId, 3);
    expect(await remaining(second)).toBe(7);
    await send(
      world,
      world.admin,
      'inventory.allocation.revoke',
      second,
      { reason: 'Révocation' },
      {
        aggregateType: 'STOCK_ALLOCATION',
        occurredAt: at('07:00'),
      },
    );
    expect((await returnToSource(again.transferId)).status).toBe('APPLIED');
    const inverses = await movesOf(again.transferId, 'TRANSFER_RECEIPT');
    expect(inverses.every((m) => m.allocation_id === null)).toBe(true);
    expect((await balanceOf(productId, pair.store)).qty).toBe(50);
  });

  it('3 — second retour : en ligne refusé, hors ligne sans effet (aucun second inverse, INV-STK-04)', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 10);
    const { transferId } = await dispatch(world, pair, productId, 5);
    expect((await returnToSource(transferId)).status).toBe('APPLIED');
    expect(codeOf(await returnToSource(transferId))).toBe('TRANSFER_STATUS_INVALID');
    expect((await returnToSource(transferId, { offline: true })).status).toBe('APPLIED');
    expect(await movesOf(transferId, 'TRANSFER_RECEIPT')).toHaveLength(1);
    expect((await balanceOf(productId, pair.store)).qty).toBe(10);
  });

  it('4 — statuts et natures non retournables, transfert introuvable', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 20);
    const requested = freshUuid();
    await send(world, world.keeper, 'inventory.transfer.request', requested, {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 2 }],
    });
    expect(codeOf(await returnToSource(requested))).toBe('TRANSFER_STATUS_INVALID');
    const internal = freshUuid();
    await send(world, world.keeper, 'inventory.transfer.move_internal', internal, {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 1 }],
    });
    expect(codeOf(await returnToSource(internal))).toBe('TRANSFER_STATUS_INVALID');
    const blind = await blindReceive(world, pair, [{ productId, receivedQtyBase: 1 }]);
    expect(codeOf(await returnToSource(blind.receiptId))).toBe('TRANSFER_STATUS_INVALID');
    const cancelled = freshUuid();
    await send(world, world.keeper, 'inventory.transfer.request', cancelled, {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 2 }],
    });
    await send(world, world.keeper, 'inventory.transfer.cancel', cancelled, {
      transferId: cancelled,
    });
    expect(codeOf(await returnToSource(cancelled))).toBe('TRANSFER_STATUS_INVALID');
    expect(codeOf(await returnToSource(freshUuid()))).toBe('NOT_FOUND');
  });

  it('5 — retour hors ligne après la réception (RECEIVED, DISCREPANCY_PENDING, CLOSED) : quarantaine, aucun mouvement', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const received = await dispatch(world, pair, productId, 10);
    expect((await receiveDocumented(received.transferId, 10)).status).toBe('APPLIED');
    const gap = await dispatch(world, pair, productId, 10);
    await receiveDocumented(gap.transferId, 8);
    const closed = await dispatch(world, pair, productId, 10);
    await receiveDocumented(closed.transferId, 9);
    const requestId = fromBin((await transferOf(closed.transferId)).approval_request_id!);
    await send(
      world,
      world.approver,
      'approvals.request.approve',
      requestId,
      { requestId },
      {
        occurredAt: at('11:00'),
      },
    );
    expect((await transferOf(closed.transferId)).status).toBe('CLOSED');

    for (const transferId of [received.transferId, gap.transferId, closed.transferId]) {
      const moves = (await movesOf(transferId)).length;
      expect(codeOf(await returnToSource(transferId))).toBe('TRANSFER_STATUS_INVALID');
      const offline = await returnToSource(transferId, { offline: true });
      expect(offline.status).toBe('CONFLICT');
      const [conflict] = await conflictsOn('TRANSFER_RETURN_CONFLICT', transferId);
      expect(conflict).toMatchObject({ applied: 0, owner_role: 'MAGASINIER', status: 'OPEN' });
      expect((conflict!.details as Record<string, unknown>)['reason']).toBe('RETURN_AFTER_RECEIPT');
      expect((await movesOf(transferId)).length).toBe(moves);
    }
  });

  it('6 — réception avec document après le retour, seconde réception, excédent hors ligne', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const returned = await dispatch(world, pair, productId, 10);
    await returnToSource(returned.transferId);
    expect(codeOf(await receiveDocumented(returned.transferId, 10))).toBe(
      'TRANSFER_STATUS_INVALID',
    );
    const late = await receiveDocumented(returned.transferId, 10, { offline: true });
    expect(late.status).toBe('CONFLICT');
    const [returnConflict] = await conflictsOn('TRANSFER_RETURN_CONFLICT', returned.transferId);
    expect((returnConflict!.details as Record<string, unknown>)['reason']).toBe(
      'RECEIVED_AFTER_RETURN',
    );
    expect((await balanceOf(productId, pair.pos)).qty).toBe(0);

    // Seconde réception hors ligne (deux appareils d'un même stock) : quarantaine, jamais deux fois.
    const twice = await dispatch(world, pair, productId, 10);
    expect((await receiveDocumented(twice.transferId, 10, { offline: true })).status).toBe(
      'APPLIED',
    );
    expect((await receiveDocumented(twice.transferId, 10, { offline: true })).status).toBe(
      'CONFLICT',
    );
    const [second] = await conflictsOn('TRANSFER_OVER_RECEIVED', twice.transferId);
    expect(second).toMatchObject({ applied: 0 });
    expect((await balanceOf(productId, pair.pos)).qty).toBe(10);

    // Au-delà de l'expédié : refusé en ligne, appliqué hors ligne et signalé (BR-STK-021).
    const over = await dispatch(world, pair, productId, 10);
    expect(codeOf(await receiveDocumented(over.transferId, 12))).toBe('TRANSFER_OVER_RECEIVED');
    const applied = await receiveDocumented(over.transferId, 12, { offline: true });
    expect(applied).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_OVER_RECEIVED'],
    });
    const [informative] = await conflictsOn('TRANSFER_OVER_RECEIVED', over.transferId);
    expect(informative).toMatchObject({ applied: 1, status: 'OPEN' });
    expect((await transferOf(over.transferId)).status).toBe('RECEIVED');
    expect((await verifyTransferTransit(db, { transferIds: [over.transferId] })).ok).toBe(true);
  });

  it('7 — réception sans document et retour : une réception en attente bloque le retour ; après le retour, elle reste non rapprochée', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 100);
    const pending = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(at('00:00')),
      async () => {
        const sent = await dispatch(world, pair, productId, 10);
        const receipt = await blindReceive(world, pair, [{ productId, receivedQtyBase: 9 }]);
        expect((await transferOf(receipt.receiptId)).status).toBe('UNMATCHED');
        return { ...sent, receiptId: receipt.receiptId };
      },
    );
    expect(codeOf(await returnToSource(pending.transferId))).toBe('TRANSFER_STATUS_INVALID');
    const quarantined = await returnToSource(pending.transferId, { offline: true });
    expect(quarantined.status).toBe('CONFLICT');
    const [conflict] = await conflictsOn('TRANSFER_RETURN_CONFLICT', pending.transferId);
    expect((conflict!.details as Record<string, unknown>)['blindReceiptId']).toBe(
      pending.receiptId,
    );
    expect((await transferOf(pending.transferId)).status).toBe('DISPATCHED');

    // Retour d'abord : une réception sans document arrivée ensuite ne le prend pas pour candidat.
    const other = await newPair(world);
    await stock(world, productId, other.store, 10);
    const sent = await dispatch(world, other, productId, 10);
    await returnToSource(sent.transferId);
    const after = await blindReceive(world, other, [{ productId, receivedQtyBase: 10 }]);
    expect((await transferOf(after.receiptId)).status).toBe('UNMATCHED');
  });

  it('8 — motif obligatoire ; permission inventory.transfer.dispatch exigée', async () => {
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 10);
    const { transferId } = await dispatch(world, pair, productId, 2);
    expect(codeOf(await returnToSource(transferId, { reason: '' }))).toMatch(/^VALIDATION_ERROR/);
    expect(codeOf(await returnToSource(transferId, { reason: '   ' }))).toMatch(
      /^VALIDATION_ERROR/,
    );
    expect(codeOf(await returnToSource(transferId, { actor: world.seller }))).toBe('FORBIDDEN');
    expect((await transferOf(transferId)).status).toBe('DISPATCHED');
  });

  it('9 — retour et réception concurrents : un seul effet', async () => {
    const pair: Pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 30);
    const { transferId } = await dispatch(world, pair, productId, 10);
    const [returned, received] = await Promise.all([
      returnToSource(transferId),
      receiveDocumented(transferId, 10),
    ]);
    const statuses = [returned.status, received.status].sort();
    expect(statuses).toEqual(['APPLIED', 'REJECTED']);
    const status = (await transferOf(transferId)).status;
    const receipts = await movesOf(transferId, 'TRANSFER_RECEIPT');
    if (status === 'RETURNED') {
      expect(receipts.every((m) => m.is_reversal === 1)).toBe(true);
      expect((await balanceOf(productId, pair.store)).qty).toBe(30);
    } else {
      expect(status).toBe('RECEIVED');
      expect(receipts.every((m) => m.is_reversal === 0)).toBe(true);
      expect((await balanceOf(productId, pair.pos)).qty).toBe(10);
    }
    expect(await transferTransit(db, transferId)).toEqual([]);
  });

  it('10 — jeu transfers : statut RETURNED et champs du retour aux deux extrémités', async () => {
    const pull = new SyncPullService(db);
    const cursorRow = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirstOrThrow();
    const cursor = Number(cursorRow.seq ?? 0);
    const pair = await newPair(world);
    const productId = await newProduct(world);
    await stock(world, productId, pair.store, 4);
    const { transferId } = await dispatch(world, pair, productId, 4);
    await returnToSource(transferId);
    const fetch = async (
      actor: TransferWorld['seller'],
      scopeId: string,
    ): Promise<readonly Change[]> =>
      (
        await pull.pull(
          { dataset: 'transfers', cursor, limit: 500 },
          {
            authenticatedUserId: actor.userId,
            authenticatedDeviceId: actor.deviceId,
            now: world.clock.now(),
          },
        )
      ).changes.filter((c) => c.scope_id === scopeId && c.entity_id === transferId);
    for (const [actor, scopeId] of [
      [world.seller, pair.pos],
      [world.keeper, pair.store],
    ] as const) {
      expect((await fetch(actor, scopeId)).at(-1)?.data).toMatchObject({
        status: 'RETURNED',
        returned_by: world.keeper.userId,
        return_reason: 'Camion en panne',
      });
    }
  });
});
