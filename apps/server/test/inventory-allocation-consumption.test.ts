/**
 * Consommation des quotas d'appareil, P5-09 (ADR-033 §4 à §7, BR-STK-011, 013, 016, 017, 018, AV-025,
 * AV-160, AV-161, INV-STK-10, INV-STK-11, INV-STK-19, INV-STK-20) : `recordStockMove` avec
 * `consumesAllocation`, la garde d'appareil, `ALLOCATION_OVERCOMMITTED`, `lockSellableQuantity` et
 * les trois commandes d'`inventory` qui l'exercent (perte, consommation, transfert sortant) — ici le
 * transfert, à travers le vrai pipeline. Même niveau que inventory-allocation-commands.test.ts
 * (base MySQL réelle, commandes d'octroi du pipeline).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerAllocationCommands } from '../src/modules/inventory/application/commands/allocation-commands.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  InventoryMoveError,
  recordStockMove,
  type RecordMoveDeps,
  type RecordMoveInput,
} from '../src/modules/inventory/application/public/record-move.js';
import { lockSellableQuantity } from '../src/modules/inventory/application/public/stock-query.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestProduct,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-08T09:00:00.000Z';

let nextDeviceSeq = 1_000;

function buildEnvelope(
  authorUserId: string,
  command: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
  },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const occurredAt = command.occurred_at ?? OCCURRED_AT;
  return {
    command_id: freshUuid(),
    device_seq: nextDeviceSeq++,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    client_created_at: occurredAt,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...command,
    occurred_at: occurredAt,
    ...extra,
  };
}

interface Holder {
  readonly userId: string;
  readonly deviceId: string;
}

describe('consommation des quotas d’appareil (P5-09, ADR-033)', () => {
  const clock = new FixedClock(new Date(OCCURRED_AT));
  const idGenerator: IdGenerator = new Uuidv7Generator(clock);
  const moveDeps: RecordMoveDeps = { idGenerator };
  let pipeline: CommandPipelineService;
  let admin: string;
  let manager: string;
  let managerDevice: string;
  let siteId: string;
  let storeA: string;
  let storeB: string;
  let customerLocation: string;
  let holderRole: string;

  beforeAll(async () => {
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    registerAllocationCommands(registry, idGenerator);
    registerTransferCommands(
      registry,
      decisionRegistry,
      idGenerator,
      new DocumentSequenceService(),
    );
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    manager = await db.transaction().execute((trx) => insertTestUser(trx));
    managerDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, manager, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const managerRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, managerRole, 'inventory.allocation.manage', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, manager, managerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });

      holderRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, holderRole, 'inventory.allocation.release', admin, {
        maxScope: 'OWN',
      });
      await grantTestPermission(trx, holderRole, 'inventory.transfer.dispatch', admin);
    });
    const customer = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_CUSTOMER')
      .executeTakeFirstOrThrow();
    customerLocation = fromBin(customer.id);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const managerCtx = () => ({
    authenticatedUserId: manager,
    authenticatedDeviceId: managerDevice,
    transport: 'ONLINE_API' as const,
  });

  async function newHolder(): Promise<Holder> {
    return db.transaction().execute(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      await assignTestRole(trx, userId, holderRole, admin);
      return { userId, deviceId };
    });
  }

  async function newProduct(stock: number, location = storeA, lotTracking?: string) {
    const productId = await db
      .transaction()
      .execute((trx) => insertTestProduct(trx, admin, lotTracking ? { lotTracking } : {}));
    if (stock > 0) await stockIn(productId, stock, location);
    return productId;
  }

  async function stockIn(
    productId: string,
    quantityBase: number,
    location = storeA,
    lotId?: string,
  ): Promise<void> {
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        ...(lotId !== undefined ? { lotId } : {}),
        quantityBase,
        fromLocationId: fromBin(opening.id),
        toLocationId: location,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 500,
        occurredAt: new Date(OCCURRED_AT),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
  }

  async function grantQuota(
    holder: Holder,
    productId: string,
    quantityBase: number,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const id = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(manager, {
        command_type: 'inventory.allocation.grant',
        aggregate_type: 'STOCK_ALLOCATION',
        aggregate_id: id,
        payload: {
          holderUserId: holder.userId,
          holderDeviceId: holder.deviceId,
          locationId: storeA,
          productId,
          quantityBase,
          ...payload,
        },
      }),
      managerCtx(),
    );
    expect(result.status).toBe('APPLIED');
    return id;
  }

  /** Une sortie (vente) faite par le détenteur, comme fait de son appareil. */
  function sell(
    holder: Holder,
    productId: string,
    quantityBase: number,
    overrides: Partial<RecordMoveInput> = {},
  ) {
    const offline = overrides.capturedOffline ?? false;
    return db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        quantityBase,
        fromLocationId: storeA,
        toLocationId: customerLocation,
        moveType: 'SALE',
        occurredAt: new Date(OCCURRED_AT),
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: holder.userId,
        createdDeviceId: holder.deviceId,
        consumesAllocation: true,
        capturedOffline: offline,
        allowNegative: offline,
        ...overrides,
      }),
    );
  }

  async function quota(id: string) {
    return db
      .selectFrom('inventory_stock_allocations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function entries(id: string) {
    const order = ['GRANT', 'INCREASE', 'RESTORE', 'CONSUME', 'RELEASE', 'REVOKE'];
    const rows = await db
      .selectFrom('inventory_stock_allocation_entries')
      .select(['entry_type', 'quantity', 'stock_move_id'])
      .where('allocation_id', '=', toBin(id))
      .execute();
    return rows.sort((a, b) => order.indexOf(a.entry_type) - order.indexOf(b.entry_type));
  }

  async function balanceOf(productId: string, locationId = storeA): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  /** INV-STK-20 : reste = Σ entrées ; Σ CONSUME − Σ RESTORE = Σ quantités des mouvements portant le quota. */
  async function expectInvariants(id: string): Promise<void> {
    const rows = await entries(id);
    const sum = (types: string[]) =>
      rows
        .filter((row) => types.includes(row.entry_type))
        .reduce((total, row) => total + Math.round(Number(row.quantity) * 1000), 0);
    const row = await quota(id);
    expect(sum(['GRANT', 'INCREASE', 'RESTORE', 'CONSUME', 'RELEASE', 'REVOKE'])).toBe(
      Math.round(Number(row.quantity_remaining) * 1000),
    );
    expect(Number(row.quantity_remaining)).toBeGreaterThanOrEqual(0);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select('quantity')
      .where('allocation_id', '=', toBin(id))
      .execute();
    const moved = moves.reduce(
      (total, move) => total + Math.round(Number(move.quantity) * 1000),
      0,
    );
    // `0 −` : sans entrée CONSUME, `−0` n'égale pas `0` pour `toBe` (Object.is).
    expect(0 - sum(['CONSUME']) - sum(['RESTORE'])).toBe(moved);
  }

  async function conflicts(entityId: string, type: string) {
    return db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'applied', 'owner_role', 'details', 'status'])
      .where('entity_id', '=', toBin(entityId))
      .where('conflict_type', '=', type)
      .execute();
  }

  async function movesOf(productId: string) {
    return db
      .selectFrom('inventory_stock_moves')
      .select(['id', 'quantity', 'allocation_id', 'lot_id'])
      .where('product_id', '=', toBin(productId))
      .where('move_type', '=', 'SALE')
      .orderBy('quantity', 'desc')
      .execute();
  }

  describe('sortie d’un détenteur', () => {
    it('dans le quota : mouvement rattaché au quota, entrée CONSUME, reste diminué, solde diminué', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 40);

      const moves = await sell(holder, productId, 15);
      expect(moves).toHaveLength(1);
      expect(moves[0]?.allocationId).toBe(id);
      expect(moves[0]?.warnings).toBeUndefined();

      const row = await quota(id);
      expect(Number(row.quantity_remaining)).toBe(25);
      expect(Number(row.quantity_granted)).toBe(40);
      expect(row.status).toBe('ACTIVE');
      expect(await balanceOf(productId)).toBe(85);

      const consume = (await entries(id)).filter((entry) => entry.entry_type === 'CONSUME');
      expect(consume).toHaveLength(1);
      expect(consume[0]?.quantity).toBe('-15.000');
      expect(fromBin(consume[0]!.stock_move_id as Buffer)).toBe(moves[0]?.moveId);
      await expectInvariants(id);
    });

    it('au-delà du quota, avec du stock libre : scindé en une part du quota et une part du stock commun', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);

      const moves = await sell(holder, productId, 15);
      expect(moves.map((move) => [move.quantity, move.allocationId ?? null])).toEqual([
        [10, id],
        [5, null],
      ]);
      const row = await quota(id);
      expect(Number(row.quantity_remaining)).toBe(0);
      expect(row.status).toBe('ACTIVE'); // reste nul : actif jusqu'à libération ou révocation
      expect(await balanceOf(productId)).toBe(85);
      expect((await movesOf(productId)).map((move) => Number(move.quantity))).toEqual([10, 5]);
      await expectInvariants(id);
    });

    it('en ligne, au-delà du quota et du stock libre -> ALLOCATION_EXCEEDED sans aucun effet', async () => {
      const holder = await newHolder();
      const other = await newHolder();
      const productId = await newProduct(20);
      const id = await grantQuota(holder, productId, 15);
      const otherId = await grantQuota(other, productId, 5);

      await expect(sell(holder, productId, 16)).rejects.toMatchObject({
        code: 'ALLOCATION_EXCEEDED',
      });
      expect(await balanceOf(productId)).toBe(20);
      expect(Number((await quota(id)).quantity_remaining)).toBe(15);
      expect((await movesOf(productId)).length).toBe(0);

      // Exactement le quota : passe ; le quota de l'autre détenteur est intact (BR-STK-011).
      expect(await sell(holder, productId, 15)).toHaveLength(1);
      expect(Number((await quota(otherId)).quantity_remaining)).toBe(5);
      await expectInvariants(id);
    });

    it('hors ligne au-delà du quota : appliqué, quota à 0, excédent au stock commun, conflit ALLOCATION_EXCEEDED', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);

      const moves = await sell(holder, productId, 15, { capturedOffline: true });
      expect(moves.map((move) => [move.quantity, move.allocationId ?? null])).toEqual([
        [10, id],
        [5, null],
      ]);
      expect(moves[0]?.warnings).toEqual(['ALLOCATION_EXCEEDED']);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);
      expect(await balanceOf(productId)).toBe(85);

      const found = await conflicts(id, 'ALLOCATION_EXCEEDED');
      expect(found).toHaveLength(1);
      expect(found[0]?.applied).toBe(1);
      const details = found[0]?.details as Record<string, unknown>;
      expect(details['excess']).toBe('5.000');
      expect(details['quotaRemaining']).toBe('10.000');
      expect(details['signalled']).toBe(false);
      await expectInvariants(id);
    });

    it('hors ligne, sans stock libre : le solde devient négatif (BR-STK-018), le quota reste à 0 jamais négatif', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const id = await grantQuota(holder, productId, 10);

      const moves = await sell(holder, productId, 14, { capturedOffline: true });
      expect(moves.map((move) => move.quantity)).toEqual([10, 4]);
      expect(await balanceOf(productId)).toBe(-4);
      const row = await quota(id);
      expect(Number(row.quantity_remaining)).toBe(0);
      expect((await conflicts(id, 'ALLOCATION_EXCEEDED')).length).toBe(1);
      await expectInvariants(id);
    });

    it('FIFO sur plusieurs lots : le quota est consommé d’abord, lot par lot, sans scinder inutilement', async () => {
      const holder = await newHolder();
      const productId = await newProduct(0, storeA, 'OPTIONAL');
      const lot1 = freshUuid();
      const lot2 = freshUuid();
      await db.transaction().execute(async (trx) => {
        for (const [lotId, rank] of [
          [lot1, '2026-09-01'],
          [lot2, '2026-09-15'],
        ] as const) {
          await trx
            .insertInto('inventory_stock_lots')
            .values({
              id: toBin(lotId),
              lot_code: `L-${lotId.slice(-8)}`,
              product_id: toBin(productId),
              origin_type: 'SUPPLIER_LOT',
              fifo_rank_at: new Date(`${rank}T00:00:00.000Z`),
              created_by: toBin(admin),
            })
            .execute();
        }
      });
      await stockIn(productId, 6, storeA, lot1);
      await stockIn(productId, 10, storeA, lot2);
      const id = await grantQuota(holder, productId, 8);

      const moves = await sell(holder, productId, 12);
      expect(moves.map((move) => [move.lotId, move.quantity, move.allocationId ?? null])).toEqual([
        [lot1, 6, id],
        [lot2, 2, id],
        [lot2, 4, null],
      ]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);
      await expectInvariants(id);
    });
  });

  describe('le couple (utilisateur, appareil) et les opérations du serveur', () => {
    it('un autre appareil du même utilisateur ne consomme pas le quota (INV-STK-11)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 30);
      const otherDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, holder.userId, { status: 'ACTIVE' }));

      const moves = await sell({ userId: holder.userId, deviceId: otherDevice }, productId, 10);
      expect(moves.map((move) => move.allocationId ?? null)).toEqual([null]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(30);
      expect(await entries(id)).toHaveLength(1); // GRANT seul
    });

    it('sans `consumesAllocation` (opération du serveur : confirmation, livraison, régularisation) : aucun quota consommé', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 30);

      const moves = await sell(holder, productId, 10, { consumesAllocation: false });
      expect(moves[0]?.allocationId).toBeUndefined();
      expect(Number((await quota(id)).quantity_remaining)).toBe(30);
      expect(await balanceOf(productId)).toBe(90);
    });

    it('un utilisateur sans quota ne prend que le stock libre (BR-STK-011) ; sa vente hors ligne est appliquée et signalée (AV-166)', async () => {
      const holder = await newHolder();
      const stranger = await newHolder();
      const productId = await newProduct(20);
      const id = await grantQuota(holder, productId, 15);

      await expect(sell(stranger, productId, 6)).rejects.toMatchObject({
        code: 'INSUFFICIENT_STOCK',
      });
      expect(await sell(stranger, productId, 5)).toHaveLength(1);
      expect(Number((await quota(id)).quantity_remaining)).toBe(15);

      const offline = await sell(stranger, productId, 3, { capturedOffline: true });
      // Vente hors ligne sans quota sur un emplacement qui en porte (AV-166, défaut WHEN_ALLOCATED) :
      // appliquée, signalée ; le solde (12) passe sous le quota promis (15) : conflit informatif.
      expect(offline[0]?.warnings).toEqual(['ALLOCATION_EXCEEDED', 'ALLOCATION_OVERCOMMITTED']);
      expect(await balanceOf(productId)).toBe(12); // 20 − 5 − 3 : le quota du détenteur en est la plus grande part
      // Rien n'est imputé au quota du détenteur : le signal porte sur l'emplacement.
      expect(
        (await conflicts(id, 'ALLOCATION_EXCEEDED')).length +
          (await conflicts(id, 'ALLOCATION_REVOKED_CONSUMED')).length,
      ).toBe(0);
      const signal = (await conflicts(storeA, 'ALLOCATION_EXCEEDED')).filter(
        (row) => (row.details as Record<string, unknown>)['productId'] === productId,
      );
      expect(signal).toHaveLength(1);
      expect(signal[0]?.owner_role).toBe('MAGASINIER');
      expect(signal[0]?.details).toMatchObject({
        reason: 'ALLOCATION_MISSING',
        allocationId: null,
        quotaRemaining: '0.000',
        excess: '3.000',
        signalled: false,
        userId: stranger.userId,
        deviceId: stranger.deviceId,
      });
    });

    it('`lockSellableQuantity` ne vend pas ce qui est promis à un appareil (stock libre = Σ soldes − Σ restes)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      await grantQuota(holder, productId, 25);
      const sellable = await db
        .transaction()
        .execute((trx) =>
          lockSellableQuantity(trx, { locationId: storeA, custodyMode: 'SHARED', productId }),
        );
      expect(sellable).toBe(15);

      const exclusive = await db.transaction().execute((trx) =>
        lockSellableQuantity(trx, {
          locationId: storeA,
          custodyMode: 'EXCLUSIVE_DEVICE',
          productId,
        }),
      );
      expect(exclusive).toBe(40);
    });
  });

  describe('corrections de P5-11 (BR-VEN-018, AV-166)', () => {
    async function exceededAt(locationId: string, productId: string) {
      return (await conflicts(locationId, 'ALLOCATION_EXCEEDED')).filter(
        (row) => (row.details as Record<string, unknown>)['productId'] === productId,
      );
    }

    it('en ligne, au-delà du quota dans le stock libre : sortie normale, ni avertissement ni conflit', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);

      const moves = await sell(holder, productId, 15);
      expect(moves.map((move) => [move.quantity, move.allocationId ?? null])).toEqual([
        [10, id],
        [5, null],
      ]);
      expect(moves.every((move) => move.warnings === undefined)).toBe(true);
      expect(await conflicts(id, 'ALLOCATION_EXCEEDED')).toHaveLength(0);
      await expectInvariants(id);
    });

    it('sans aucun quota sur l’emplacement : même refus, même code et même message que sans quota', async () => {
      const stranger = await newHolder();
      const productId = await newProduct(4);
      const plain = sell(stranger, productId, 5, { consumesAllocation: false });
      await expect(plain).rejects.toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        message: 'Stock insuffisant sur l’emplacement source (BR-STK-017).',
      });
      await expect(sell(stranger, productId, 5)).rejects.toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        message: 'Stock insuffisant sur l’emplacement source (BR-STK-017).',
      });
      expect(await balanceOf(productId)).toBe(4);

      // Hors ligne, sans quota sur le produit (défaut WHEN_ALLOCATED) : aucun signal de quota.
      const offline = await sell(stranger, productId, 2, { capturedOffline: true });
      expect(offline[0]?.warnings).toBeUndefined();
      expect(await exceededAt(storeA, productId)).toHaveLength(0);
    });

    it('détenteur d’un quota échu, en ligne : refus au message explicite (sa propre allocation a expiré)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      await grantQuota(holder, productId, 30, { validityHours: 1 });

      await expect(
        sell(holder, productId, 5, { occurredAt: new Date('2026-10-08T11:00:00.000Z') }),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        message:
          'Votre allocation a expiré : libérez-la ou faites-la renouveler ; le stock libre ne couvre pas la demande (BR-STK-011).',
      });
    });

    it('vente hors ligne avec un quota échu : appliquée au stock commun, ALLOCATION_EXCEEDED motif ALLOCATION_EXPIRED (AV-166)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(50);
      const id = await grantQuota(holder, productId, 20, { validityHours: 1 });

      const moves = await sell(holder, productId, 5, {
        capturedOffline: true,
        occurredAt: new Date('2026-10-08T11:00:00.000Z'),
      });
      expect(moves[0]?.allocationId).toBeUndefined();
      expect(moves[0]?.warnings).toEqual(['ALLOCATION_EXCEEDED']);
      expect(Number((await quota(id)).quantity_remaining)).toBe(20);
      const found = await conflicts(id, 'ALLOCATION_EXCEEDED');
      expect(found).toHaveLength(1);
      expect(found[0]?.details).toMatchObject({
        reason: 'ALLOCATION_EXPIRED',
        allocationId: id,
        excess: '5.000',
        quotaRemaining: '0.000',
      });
      await expectInvariants(id);
    });

    it('le signal d’AV-166 ne concerne que la vente : une perte ou un transfert hors ligne sans quota n’est pas signalé', async () => {
      const holder = await newHolder();
      const stranger = await newHolder();
      const productId = await newProduct(40);
      await grantQuota(holder, productId, 10);
      const lossLocation = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();

      const moves = await sell(stranger, productId, 3, {
        capturedOffline: true,
        moveType: 'LOSS',
        toLocationId: fromBin(lossLocation.id),
        sourceDocType: 'LOSS',
      });
      expect(moves[0]?.warnings).toBeUndefined();
      expect(await exceededAt(storeA, productId)).toHaveLength(0);
    });

    it('concurrence : la seconde sortie du même couple voit le reste réel du quota (lecture verrouillante), refus ALLOCATION_EXCEEDED et non erreur SQL', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const id = await grantQuota(holder, productId, 10);

      await db.transaction().execute(async (trx) => {
        // Instantané de cette transaction pris AVANT la première vente (isolation répétable).
        await trx
          .selectFrom('inventory_stock_allocations')
          .select('quantity_remaining')
          .where('id', '=', toBin(id))
          .execute();
        await sell(holder, productId, 8); // autre transaction, validée
        await expect(
          recordStockMove(trx, moveDeps, {
            productId,
            quantityBase: 8,
            fromLocationId: storeA,
            toLocationId: customerLocation,
            moveType: 'SALE',
            occurredAt: new Date(OCCURRED_AT),
            sourceDocType: 'SALE',
            sourceDocId: freshUuid(),
            createdBy: holder.userId,
            createdDeviceId: holder.deviceId,
            consumesAllocation: true,
            capturedOffline: false,
            allowNegative: false,
          }),
        ).rejects.toMatchObject({ code: 'ALLOCATION_EXCEEDED' });
      });
      expect(Number((await quota(id)).quantity_remaining)).toBe(2);
      expect(await balanceOf(productId)).toBe(2);
      await expectInvariants(id);
    });

    it('concurrence : ALLOCATION_OVERCOMMITTED voit un octroi validé après l’instantané (lecture verrouillante)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(20);
      const lossLocation = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();

      const moves = await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('inventory_stock_allocations')
          .select('id')
          .where('product_id', '=', toBin(productId))
          .execute();
        await grantQuota(holder, productId, 15); // autre transaction, validée
        return recordStockMove(trx, moveDeps, {
          productId,
          quantityBase: 7,
          fromLocationId: storeA,
          toLocationId: fromBin(lossLocation.id),
          moveType: 'LOSS',
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        });
      });
      // 13 < 15 promis : le conflit est ouvert malgré l'instantané antérieur à l'octroi.
      expect(moves[0]?.warnings).toEqual(['ALLOCATION_OVERCOMMITTED']);
    });
  });

  describe('quota échu, révoqué : stock commun', () => {
    it('quota échu à l’`occurred_at` : pris sur le stock commun, sans conflit, reste inchangé', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 30, { validityHours: 1 });

      const moves = await sell(holder, productId, 10, {
        occurredAt: new Date('2026-10-08T11:00:00.000Z'),
      });
      expect(moves[0]?.allocationId).toBeUndefined();
      expect(Number((await quota(id)).quantity_remaining)).toBe(30);
      expect((await conflicts(id, 'ALLOCATION_EXCEEDED')).length).toBe(0);
      expect((await conflicts(id, 'ALLOCATION_REVOKED_CONSUMED')).length).toBe(0);
    });

    it('quota révoqué : un fait postérieur à la révocation ouvre ALLOCATION_REVOKED_CONSUMED, un fait antérieur non', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 30);
      clock.setTo(new Date('2026-10-08T10:00:00.000Z'));
      try {
        const revoke = await pipeline.handle(
          buildEnvelope(manager, {
            command_type: 'inventory.allocation.revoke',
            aggregate_type: 'STOCK_ALLOCATION',
            aggregate_id: id,
            payload: { reason: 'Reprise du stock' },
            occurred_at: '2026-10-08T10:00:00.000Z',
          }),
          managerCtx(),
        );
        expect(revoke.status).toBe('APPLIED');
      } finally {
        clock.setTo(new Date(OCCURRED_AT));
      }

      const early = await sell(holder, productId, 4, {
        capturedOffline: true,
        occurredAt: new Date('2026-10-08T09:30:00.000Z'),
      });
      expect(early[0]?.allocationId).toBeUndefined();
      expect(early[0]?.warnings).toBeUndefined();
      expect((await conflicts(id, 'ALLOCATION_REVOKED_CONSUMED')).length).toBe(0);

      const late = await sell(holder, productId, 6, {
        capturedOffline: true,
        occurredAt: new Date('2026-10-08T10:30:00.000Z'),
      });
      expect(late[0]?.warnings).toEqual(['ALLOCATION_REVOKED_CONSUMED']);
      const found = await conflicts(id, 'ALLOCATION_REVOKED_CONSUMED');
      expect(found).toHaveLength(1);
      expect(found[0]?.applied).toBe(1);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0); // la révocation l'a remis à zéro
      expect(await balanceOf(productId)).toBe(90);
    });
  });

  describe('ALLOCATION_OVERCOMMITTED', () => {
    it('une perte du serveur qui laisse le solde sous Σ restes ouvre un conflit, une seule fois', async () => {
      const holder = await newHolder();
      const productId = await newProduct(20);
      await grantQuota(holder, productId, 15);

      const lossLocation = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();
      const loss = (quantityBase: number) =>
        db.transaction().execute((trx) =>
          recordStockMove(trx, moveDeps, {
            productId,
            quantityBase,
            fromLocationId: storeA,
            toLocationId: fromBin(lossLocation.id),
            moveType: 'LOSS',
            occurredAt: new Date(OCCURRED_AT),
            sourceDocType: 'LOSS',
            sourceDocId: freshUuid(),
            createdBy: admin,
            allowNegative: false,
          }),
        );
      const overcommitted = () =>
        db
          .selectFrom('sync_sync_conflicts')
          .select(['applied', 'status', 'details'])
          .where('conflict_type', '=', 'ALLOCATION_OVERCOMMITTED')
          .where('entity_id', '=', toBin(storeA))
          .execute()
          .then((rows) =>
            rows.filter(
              (row) => (row.details as Record<string, unknown>)['productId'] === productId,
            ),
          );

      const first = await loss(4); // 16 ≥ 15 : rien
      expect(first[0]?.warnings).toBeUndefined();
      expect(await overcommitted()).toHaveLength(0);

      const second = await loss(3); // 13 < 15 : conflit
      expect(second[0]?.warnings).toEqual(['ALLOCATION_OVERCOMMITTED']);
      const found = await overcommitted();
      expect(found).toHaveLength(1);
      expect(found[0]?.applied).toBe(1);
      expect((found[0]?.details as Record<string, unknown>)['allocatedRemaining']).toBe('15.000');

      await loss(2); // toujours sous le total : pas de doublon tant que le conflit est ouvert
      expect(await overcommitted()).toHaveLength(1);
    });
  });

  describe('garde d’appareil (BR-STK-016, ADR-033 §2)', () => {
    async function exclusiveLocation(
      mode: 'EXCLUSIVE_DEVICE' | 'EXCLUSIVE_USER',
      designatedDeviceId: string | null,
      custodianUserId: string | null,
    ): Promise<string> {
      return db.transaction().execute(async (trx) => {
        const id = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
        await trx
          .updateTable('organization_locations')
          .set({
            custody_mode: mode,
            designated_device_id: designatedDeviceId === null ? null : toBin(designatedDeviceId),
            custodian_user_id: custodianUserId === null ? null : toBin(custodianUserId),
          })
          .where('id', '=', toBin(id))
          .execute();
        return id;
      });
    }

    async function guardConflicts(locationId: string) {
      return conflicts(locationId, 'CUSTODY_DEVICE_MISMATCH');
    }

    it('EXCLUSIVE_DEVICE : l’appareil désigné passe, un autre appareil hors ligne ouvre CUSTODY_DEVICE_MISMATCH', async () => {
      const designated = await newHolder();
      const intruder = await newHolder();
      const location = await exclusiveLocation('EXCLUSIVE_DEVICE', designated.deviceId, null);
      const productId = await newProduct(50, location);

      const own = await sell(designated, productId, 5, {
        fromLocationId: location,
        capturedOffline: true,
      });
      expect(own[0]?.warnings).toBeUndefined();
      expect(await guardConflicts(location)).toHaveLength(0);

      const foreign = await sell(intruder, productId, 5, {
        fromLocationId: location,
        capturedOffline: true,
      });
      expect(foreign[0]?.warnings).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      const found = await guardConflicts(location);
      expect(found).toHaveLength(1);
      expect(found[0]?.applied).toBe(1);
      expect((found[0]?.details as Record<string, unknown>)['reason']).toBe(
        'DEVICE_NOT_DESIGNATED',
      );
      expect(await balanceOf(productId, location)).toBe(40); // le fait est appliqué

      // En ligne, la garde ne s'applique pas (elle protège l'usage hors ligne).
      const online = await sell(intruder, productId, 5, { fromLocationId: location });
      expect(online[0]?.warnings).toBeUndefined();
      expect(await guardConflicts(location)).toHaveLength(1);
    });

    it('EXCLUSIVE_USER : seul l’appareil principal du détenteur est légitime hors ligne', async () => {
      const custodian = await newHolder();
      const secondDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, custodian.userId, { status: 'ACTIVE' }));
      await db
        .updateTable('identity_users')
        .set({ primary_device_id: toBin(custodian.deviceId) })
        .where('id', '=', toBin(custodian.userId))
        .execute();
      const location = await exclusiveLocation('EXCLUSIVE_USER', null, custodian.userId);
      const productId = await newProduct(50, location);

      const primary = await sell(custodian, productId, 5, {
        fromLocationId: location,
        capturedOffline: true,
      });
      expect(primary[0]?.warnings).toBeUndefined();

      const other = await sell({ userId: custodian.userId, deviceId: secondDevice }, productId, 5, {
        fromLocationId: location,
        capturedOffline: true,
      });
      expect(other[0]?.warnings).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      const found = await guardConflicts(location);
      expect((found[0]?.details as Record<string, unknown>)['reason']).toBe('DEVICE_NOT_PRIMARY');
    });

    it('appareil rattaché à un autre site : DEVICE_OTHER_SITE', async () => {
      const holder = await newHolder();
      const otherSite = await db.transaction().execute(async (trx) => {
        const zoneId = await insertTestZone(trx, admin);
        return insertTestSite(trx, admin, zoneId);
      });
      await db
        .updateTable('identity_devices')
        .set({ designated_site_id: toBin(otherSite) })
        .where('id', '=', toBin(holder.deviceId))
        .execute();
      const productId = await newProduct(50);

      const moves = await sell(holder, productId, 5, { capturedOffline: true });
      expect(moves[0]?.warnings).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      const found = await guardConflicts(storeA);
      expect(
        found.some(
          (row) => (row.details as Record<string, unknown>)['reason'] === 'DEVICE_OTHER_SITE',
        ),
      ).toBe(true);
    });
  });

  describe('transfert sortant à travers le pipeline', () => {
    function dispatch(holder: Holder, productId: string, quantityBase: number, offline: boolean) {
      return pipeline.handle(
        buildEnvelope(
          holder.userId,
          {
            command_type: 'inventory.transfer.dispatch',
            aggregate_type: 'STOCK_TRANSFER',
            aggregate_id: freshUuid(),
            payload: {
              fromLocationId: storeA,
              toLocationId: storeB,
              lines: [{ productId, unitCode: 'TETE', quantityBase }],
            },
          },
          { captured_offline: offline },
        ),
        {
          authenticatedUserId: holder.userId,
          authenticatedDeviceId: holder.deviceId,
          transport: offline ? ('SYNC_PUSH' as const) : ('ONLINE_API' as const),
        },
      );
    }

    it('dans le quota : appliqué, quota consommé ; au-delà en ligne : refus ; au-delà hors ligne : avertissement', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      const id = await grantQuota(holder, productId, 10);

      expect((await dispatch(holder, productId, 4, false)).status).toBe('APPLIED');
      expect(Number((await quota(id)).quantity_remaining)).toBe(6);

      // 6 restants + 20 libres = 26 disponibles pour ce détenteur : 27 est refusé en ligne.
      const refused = await dispatch(holder, productId, 27, false);
      expect(refused.status).toBe('REJECTED');
      expect(refused.status === 'REJECTED' && refused.error.code).toBe('ALLOCATION_EXCEEDED');
      expect(Number((await quota(id)).quantity_remaining)).toBe(6);

      const offline = await dispatch(holder, productId, 10, true);
      expect(offline.status).toBe('APPLIED_WITH_WARNINGS');
      expect(offline.status === 'APPLIED_WITH_WARNINGS' && offline.warnings).toEqual([
        'ALLOCATION_EXCEEDED',
      ]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);
      await expectInvariants(id);
    });
  });

  describe('concurrence octroi / sortie du même couple (reportée de P5-08)', () => {
    it('un octroi et une sortie qui se disputent le même stock : un seul passe, jamais de dépassement', async () => {
      const holder = await newHolder();
      const consumer = await newHolder();
      const productId = await newProduct(100);

      const grantId = freshUuid();
      const grantPromise = pipeline.handle(
        buildEnvelope(manager, {
          command_type: 'inventory.allocation.grant',
          aggregate_type: 'STOCK_ALLOCATION',
          aggregate_id: grantId,
          payload: {
            holderUserId: holder.userId,
            holderDeviceId: holder.deviceId,
            locationId: storeA,
            productId,
            quantityBase: 100,
          },
        }),
        managerCtx(),
      );
      const salePromise = sell(consumer, productId, 60).then(
        () => 'SOLD' as const,
        (error: unknown) =>
          error instanceof InventoryMoveError ? (error.code as string) : Promise.reject(error),
      );
      const [granted, sale] = await Promise.all([grantPromise, salePromise]);

      const grantOk = granted.status === 'APPLIED';
      const saleOk = sale === 'SOLD';
      expect(grantOk !== saleOk).toBe(true);
      if (!grantOk) {
        expect(granted.status === 'REJECTED' && granted.error.code).toBe(
          'ALLOCATION_EXCEEDS_AVAILABLE',
        );
      }
      if (!saleOk) expect(sale).toBe('INSUFFICIENT_STOCK');

      const onHand = await balanceOf(productId);
      const active = await db
        .selectFrom('inventory_stock_allocations')
        .select('quantity_remaining')
        .where('product_id', '=', toBin(productId))
        .where('status', '=', 'ACTIVE')
        .execute();
      const promised = active.reduce((sum, row) => sum + Number(row.quantity_remaining), 0);
      expect(promised).toBeLessThanOrEqual(onHand); // INV-STK-19
    });
  });

  describe('option « autorisée et signalée » du site (AV-025)', () => {
    it('le réglage `sales.offline_over_allocation_allowed` du site est porté par le conflit (`signalled`)', async () => {
      await db
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'sales.offline_over_allocation_allowed',
          value: jsonValue(true),
          scope_type: 'SITE',
          scope_id: toBin(siteId),
          valid_from: new Date('2026-10-01T00:00:00.000Z'),
          created_by: toBin(admin),
        })
        .execute();
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);

      await sell(holder, productId, 14, { capturedOffline: true });
      const found = await conflicts(id, 'ALLOCATION_EXCEEDED');
      expect(found).toHaveLength(1);
      expect((found[0]?.details as Record<string, unknown>)['signalled']).toBe(true);
    });
  });
});
