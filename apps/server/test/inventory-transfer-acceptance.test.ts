/**
 * AT-017 (09-non-functional/03-plan-de-tests.md §6 ; BR-STK-024, reportée de P2) : « réception sans
 * document au PDV hors ligne, puis arrivée de l'expédition — rapprochement automatique ; transit à
 * zéro ». De bout en bout, avec le harnais multi-appareils (`OfflineDevice`) contre les vrais services
 * de synchronisation (`SyncPushService`, `SyncPullService`) : le PDV est configuré par
 * `organization.pos.configure` (`EXCLUSIVE_DEVICE`, tablette désignée), la tablette et le magasinier
 * saisissent hors ligne, puis synchronisent dans les deux ordres.
 *
 * « Transit à zéro » est vérifié à toutes les granularités : transit de la paire, transit de chaque
 * document en quantité, **par lot** et **en valeur** (XAF), solde de `V_TRANSIT` du produit, INV-STK-08
 * (`verifyTransferTransit`), conservation et projection (INV-STK-01, INV-STK-03 : `verifyStockLedger`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import {
  pairTransit,
  transferTransit,
  verifyStockLedger,
  verifyTransferTransit,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
} from './helpers.js';
import { NetworkDownError, OfflineDevice } from './device-harness.js';
import {
  at,
  balanceOf,
  conflictsOn,
  createTransferWorld,
  linesOf,
  movesOf,
  newLot,
  newProduct,
  send,
  stock,
  transferOf,
  transitOf,
  type TransferWorld,
} from './transfer-world.js';

describe('AT-017 — réception sans document au PDV hors ligne, puis arrivée de l’expédition', () => {
  let world: TransferWorld;
  let services: { push: SyncPushService; pull: SyncPullService };

  beforeAll(async () => {
    world = await createTransferWorld();
    registerPosCommands(world.registry);
    services = {
      push: new SyncPushService(world.pipeline, db, world.clock),
      pull: new SyncPullService(db),
    };
  });

  afterAll(async () => {
    await closeTestDb();
  });

  interface Scene {
    readonly store: string;
    readonly pos: string;
    readonly productId: string;
    readonly lotId: string;
    readonly tablet: OfflineDevice;
    readonly keeperDevice: OfflineDevice;
  }

  /**
   * Un PDV neuf (site `POINT_DE_VENTE`, emplacement de vente) configuré `EXCLUSIVE_DEVICE` avec sa
   * tablette désignée, approvisionné par le magasin ; 100 plateaux d'un lot en stock au magasin.
   */
  async function scene(): Promise<Scene> {
    const { pdvSite, salesLocation, store, tabletId, keeperDeviceId } = await db
      .transaction()
      .execute(async (trx) => {
        const site = await insertTestSite(trx, world.admin.userId, world.zoneId, {
          siteType: 'POINT_DE_VENTE',
        });
        const location = await insertTestLocation(trx, world.admin.userId, site, {
          locationType: 'POS',
        });
        const shop = await insertTestLocation(trx, world.admin.userId, world.storeSite, {
          locationType: 'STORE',
        });
        const tablet = await insertTestDevice(trx, world.seller.userId, { status: 'ACTIVE' });
        // Un appareil neuf du magasinier par scène : chaque harnais compte ses `device_seq` depuis 1.
        const keeperDevice = await insertTestDevice(trx, world.keeper.userId, { status: 'ACTIVE' });
        // Le vendeur lit le stock du PDV (périmètre du jeu `transfers`) et y reçoit la marchandise : la
        // portée des commandes de stock est contrôlée depuis P5-23 (AV-182), ce PDV est neuf à chaque scène.
        const role = await insertTestRole(trx, world.admin.userId, { allowedScopeTypes: ['SITE'] });
        for (const permission of ['inventory.stock.read', 'inventory.transfer.receive']) {
          await grantTestPermission(trx, role, permission, world.admin.userId, {
            maxScope: 'SITE',
          });
        }
        await assignTestRole(trx, world.seller.userId, role, world.admin.userId, {
          scopeType: 'SITE',
          scopeSiteId: site,
        });
        // Affectation écrite sans commande : le cache des droits n'en reçoit pas l'événement d'invalidation.
        invalidateUser(world.seller.userId);
        return {
          pdvSite: site,
          salesLocation: location,
          store: shop,
          tabletId: tablet,
          keeperDeviceId: keeperDevice,
        };
      });
    const configured = await send(
      world,
      world.admin,
      'organization.pos.configure',
      pdvSite,
      {
        salesLocationId: salesLocation,
        replenishmentSourceLocationId: store,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: tabletId,
      },
      { aggregateType: 'SITE', occurredAt: at('05:00') },
    );
    expect(configured.status, JSON.stringify(configured)).toBe('APPLIED');
    const location = await db
      .selectFrom('organization_locations')
      .select(['custody_mode', 'designated_device_id'])
      .where('id', '=', toBin(salesLocation))
      .executeTakeFirstOrThrow();
    expect(location.custody_mode).toBe('EXCLUSIVE_DEVICE');
    expect(fromBin(location.designated_device_id!)).toBe(tabletId);

    const productId = await newProduct(world, 'OPTIONAL');
    const lotId = await newLot(world, productId);
    await stock(world, productId, store, 100, { lotId, unitCostXaf: 2_500 });
    return {
      store,
      pos: salesLocation,
      productId,
      lotId,
      tablet: new OfflineDevice(services, tabletId, world.clock),
      keeperDevice: new OfflineDevice(services, keeperDeviceId, world.clock),
    };
  }

  /** Saisies hors ligne : la tablette reçoit sans document, le magasinier expédie. */
  function capture(s: Scene, received: number, dispatched: number) {
    const receiptId = freshUuid();
    const transferId = freshUuid();
    s.tablet.enqueue(world.seller.userId, {
      type: 'inventory.transfer.receive',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: receiptId,
      occurredAt: at('08:00'),
      payload: {
        fromLocationId: s.store,
        toLocationId: s.pos,
        lines: [{ productId: s.productId, unitCode: 'TETE', receivedQtyBase: received }],
      },
    });
    s.keeperDevice.enqueue(world.keeper.userId, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: transferId,
      occurredAt: at('06:30'),
      payload: {
        fromLocationId: s.store,
        toLocationId: s.pos,
        lines: [{ productId: s.productId, unitCode: 'TETE', quantityBase: dispatched }],
      },
    });
    return { receiptId, transferId };
  }

  /** Transit à zéro, à toutes les granularités. */
  async function expectTransitSettled(
    s: Scene,
    transferId: string,
    receiptId: string,
    transitBefore: { readonly qty: number; readonly valueXaf: number },
  ): Promise<void> {
    const pair = await pairTransit(db, { fromLocationId: s.store, toLocationId: s.pos });
    expect(pair.size).toBe(0);
    expect(await transferTransit(db, transferId)).toEqual([]);
    expect(await transferTransit(db, receiptId)).toEqual([]);
    expect(await transitOf(s.productId, s.lotId)).toEqual({ qty: 0, valueXaf: 0 });
    expect(await transitOf(s.productId)).toEqual(transitBefore);
    expect((await verifyTransferTransit(db, { transferIds: [transferId, receiptId] })).ok).toBe(
      true,
    );
    const ledger = await db
      .transaction()
      .execute((trx) => verifyStockLedger(trx, { productIds: [s.productId] }));
    expect(ledger.mismatches).toEqual([]);
    expect(ledger.conservationBreaches).toEqual([]);
    expect(await conflictsOn('TRANSFER_UNMATCHED', receiptId)).toHaveLength(0);
  }

  it('différé : la tablette synchronise d’abord (UNMATCHED), le magasinier ensuite — rapprochement, transit à zéro', async () => {
    const s = await scene();
    const transitBefore = await transitOf(s.productId);
    const { receiptId, transferId } = capture(s, 58, 58);

    const [receiptResult] = await s.tablet.sync(world.seller.userId);
    expect(receiptResult).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_UNMATCHED'],
    });
    expect((await transferOf(receiptId)).status).toBe('UNMATCHED');
    expect((await balanceOf(s.productId, s.pos)).qty).toBe(58);

    const [dispatchResult] = await s.keeperDevice.sync(world.keeper.userId);
    expect(dispatchResult).toMatchObject({
      status: 'APPLIED',
      server_refs: { matchedBlindReceiptId: receiptId },
    });
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
    expect((await transferOf(transferId)).status).toBe('RECEIVED');
    // Requalifiée au lot et à la valeur de l'expédition (AV-179).
    expect(await balanceOf(s.productId, s.pos, s.lotId)).toEqual({ qty: 58, valueXaf: 58 * 2_500 });
    expect(await balanceOf(s.productId, s.pos, null)).toEqual({ qty: 0, valueXaf: 0 });
    await expectTransitSettled(s, transferId, receiptId, transitBefore);

    // Le PDV voit, au téléchargement suivant, la réception rapprochée et le transfert reçu.
    await s.tablet.pullAll('transfers', world.seller.userId, world.clock.now());
    expect(s.tablet.localProjection.get(`transfers:STOCK_TRANSFER:${receiptId}`)).toMatchObject({
      status: 'MATCHED',
      matched_transfer_id: transferId,
    });
    expect(s.tablet.localProjection.get(`transfers:STOCK_TRANSFER:${transferId}`)).toMatchObject({
      status: 'RECEIVED',
    });
  });

  it('immédiat : le magasinier synchronise d’abord, la tablette ensuite — mêmes résultats', async () => {
    const s = await scene();
    const transitBefore = await transitOf(s.productId);
    const { receiptId, transferId } = capture(s, 58, 58);
    const [dispatchResult] = await s.keeperDevice.sync(world.keeper.userId);
    expect(dispatchResult?.status).toBe('APPLIED');
    const [receiptResult] = await s.tablet.sync(world.seller.userId);
    expect(receiptResult).toMatchObject({
      status: 'APPLIED',
      server_refs: { transferId: receiptId, matchedTransferId: transferId },
    });
    expect((await transferOf(transferId)).status).toBe('RECEIVED');
    expect(await balanceOf(s.productId, s.pos, s.lotId)).toEqual({ qty: 58, valueXaf: 58 * 2_500 });
    expect(await movesOf(receiptId)).toHaveLength(0);
    await expectTransitSettled(s, transferId, receiptId, transitBefore);
  });

  it('avec écart (58 expédiés, 57 reçus) jusqu’à la décision : CLOSED, transit à zéro, 1 plateau en perte', async () => {
    const s = await scene();
    const transitBefore = await transitOf(s.productId);
    const { receiptId, transferId } = capture(s, 57, 58);
    await s.tablet.sync(world.seller.userId);
    await s.keeperDevice.sync(world.keeper.userId);
    const transfer = await transferOf(transferId);
    expect(transfer.status).toBe('DISCREPANCY_PENDING');
    const [line] = await linesOf(transferId);
    expect(Number(line!.discrepancy_qty_base)).toBe(1);
    const requestId = fromBin(transfer.approval_request_id!);
    const approved = await send(
      world,
      world.approver,
      'approvals.request.approve',
      requestId,
      { requestId },
      {
        occurredAt: at('11:00'),
      },
    );
    expect(approved.status).toBe('APPLIED');
    expect((await transferOf(transferId)).status).toBe('CLOSED');
    const loss = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_LOSS')
      .executeTakeFirstOrThrow();
    expect(await balanceOf(s.productId, fromBin(loss.id), s.lotId)).toEqual({
      qty: 1,
      valueXaf: 2_500,
    });
    await expectTransitSettled(s, transferId, receiptId, transitBefore);
  });

  it('réponse perdue pendant l’envoi de la réception, puis renvoi : aucun doublon de document ni de mouvement', async () => {
    const s = await scene();
    const transitBefore = await transitOf(s.productId);
    const { receiptId, transferId } = capture(s, 58, 58);
    s.tablet.loseNextResponses(1);
    await expect(s.tablet.sync(world.seller.userId)).rejects.toBeInstanceOf(NetworkDownError);
    expect(s.tablet.pending(world.seller.userId)).toBe(1);
    const [replayed] = await s.tablet.sync(world.seller.userId);
    expect(replayed).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['TRANSFER_UNMATCHED'],
    });
    const documents = await db
      .selectFrom('inventory_stock_transfers')
      .select('id')
      .where('id', '=', toBin(receiptId))
      .execute();
    expect(documents).toHaveLength(1);
    expect(await movesOf(receiptId)).toHaveLength(1);
    await s.keeperDevice.sync(world.keeper.userId);
    expect((await transferOf(receiptId)).status).toBe('MATCHED');
    await expectTransitSettled(s, transferId, receiptId, transitBefore);
  });
});
