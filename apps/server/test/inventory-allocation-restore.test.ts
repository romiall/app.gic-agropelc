/**
 * Restitution des quotas d'appareil et réconciliation, P5-10 (ADR-033 §8 et §10, INV-STK-19,
 * INV-STK-20, AV-040, AT-049) : une annulation de vente, l'inverse d'un mouvement et la libération
 * d'une perte rendent la quantité au quota que le fait d'origine avait consommé — **si ce quota est
 * encore actif** —, sinon au stock commun ; `verifyStockLedger` contrôle le registre des quotas ;
 * l'inventaire d'un emplacement clôt les conflits `STOCK_NEGATIVE` qu'il régularise ; les seuils d'un
 * emplacement partagé se lisent sur le solde physique. Base MySQL réelle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { recordConflict } from '../src/platform/sync/conflicts.js';
import { registerAllocationCommands } from '../src/modules/inventory/application/commands/allocation-commands.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  recordStockMove,
  returnSoldGoods,
  reverseDocumentMoves,
  verifyStockLedger,
  type RecordMoveDeps,
  type RecordMoveInput,
} from '../src/modules/inventory/application/public/index.js';
import { listStockThresholds } from '../src/modules/inventory/application/public/document-query.js';
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
let nextDeviceSeq = 5_000;

function buildEnvelope(
  authorUserId: string,
  command: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
  },
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
  };
}

interface Holder {
  readonly userId: string;
  readonly deviceId: string;
}

describe('restitution des quotas et réconciliation (P5-10, ADR-033)', () => {
  const clock = new FixedClock(new Date(OCCURRED_AT));
  const idGenerator: IdGenerator = new Uuidv7Generator(clock);
  const moveDeps: RecordMoveDeps = { idGenerator };
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let manager: string;
  let managerDevice: string;
  let siteId: string;
  let storeA: string;
  let customerLocation: string;
  let pendingLossLocation: string;
  let lossLocation: string;
  let consumptionLocation: string;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerAllocationCommands(registry, idGenerator);
    registerCountCommands(
      registry,
      new ApprovalDecisionHandlerRegistry(),
      idGenerator,
      new DocumentSequenceService(),
    );
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    manager = await db.transaction().execute((trx) => insertTestUser(trx));
    managerDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, manager, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
      const managerRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, managerRole, 'inventory.allocation.manage', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, manager, managerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.count.perform', admin);
      await assignTestRole(trx, admin, adminRole, admin);
    });
    const virtual = async (type: string) =>
      fromBin(
        (
          await db
            .selectFrom('organization_locations')
            .select('id')
            .where('location_type', '=', type)
            .executeTakeFirstOrThrow()
        ).id,
      );
    customerLocation = await virtual('V_CUSTOMER');
    pendingLossLocation = await virtual('V_PENDING_LOSS');
    lossLocation = await virtual('V_LOSS');
    consumptionLocation = await virtual('V_CONSUMPTION');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const managerCtx = () => ({
    authenticatedUserId: manager,
    authenticatedDeviceId: managerDevice,
    transport: 'ONLINE_API' as const,
  });
  const adminCtx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });

  async function newHolder(): Promise<Holder> {
    return db.transaction().execute(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      return { userId, deviceId };
    });
  }

  async function newProduct(stock: number): Promise<string> {
    const productId = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
    if (stock > 0) {
      const opening = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_OPENING')
        .executeTakeFirstOrThrow();
      await db.transaction().execute((trx) =>
        recordStockMove(trx, moveDeps, {
          productId,
          quantityBase: stock,
          fromLocationId: fromBin(opening.id),
          toLocationId: storeA,
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
    return productId;
  }

  async function grantQuota(holder: Holder, productId: string, quantityBase: number) {
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
        },
      }),
      managerCtx(),
    );
    expect(result.status).toBe('APPLIED');
    return id;
  }

  /** Un fait de l'appareil qui prend du stock à `storeA` (vente, perte en attente, consommation). */
  function take(
    holder: Holder,
    productId: string,
    quantityBase: number,
    overrides: Partial<RecordMoveInput>,
  ) {
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
        capturedOffline: false,
        allowNegative: false,
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

  async function balanceOf(productId: string): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(storeA))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  const verify = (productId: string) =>
    db.transaction().execute((trx) => verifyStockLedger(trx, { productIds: [productId] }));

  /** Vente (réf. de ligne comprise) d'un détenteur ; renvoie de quoi la contre-passer. */
  async function sellLine(holder: Holder, productId: string, quantityBase: number) {
    const saleId = freshUuid();
    const saleLineId = freshUuid();
    const moves = await take(holder, productId, quantityBase, {
      sourceDocId: saleId,
      sourceLineId: saleLineId,
    });
    return { saleId, saleLineId, moves };
  }

  const cancelSale = (
    line: { saleId: string; saleLineId: string },
    quantityBase: number,
    createdBy = admin,
  ) =>
    db.transaction().execute((trx) =>
      returnSoldGoods(trx, moveDeps, {
        saleId: line.saleId,
        saleLineId: line.saleLineId,
        quantityBase,
        sourceDocId: freshUuid(),
        occurredAt: new Date(OCCURRED_AT),
        createdBy,
      }),
    );

  describe('annulation d’une vente (returnSoldGoods)', () => {
    it('quota actif : la quantité d’un retour partiel puis total revient au quota, plafonnée à sa consommation', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 20);
      const line = await sellLine(holder, productId, 10);
      expect(Number((await quota(id)).quantity_remaining)).toBe(10);

      await cancelSale(line, 4);
      expect(Number((await quota(id)).quantity_remaining)).toBe(14);
      await cancelSale(line, 6);
      const row = await quota(id);
      expect(Number(row.quantity_remaining)).toBe(20);
      expect(Number(row.quantity_granted)).toBe(20);
      expect(await balanceOf(productId)).toBe(100);

      const restore = (await entries(id)).filter((entry) => entry.entry_type === 'RESTORE');
      expect(restore.map((entry) => entry.quantity).sort()).toEqual(['4.000', '6.000']);
      expect((await verify(productId)).ok).toBe(true);
    });

    it('vente scindée (quota + stock commun) annulée en entier : seule la part du quota lui revient', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);
      const line = await sellLine(holder, productId, 15); // 10 du quota + 5 du stock commun
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);

      const returns = await cancelSale(line, 15);
      expect(returns.map((move) => move.quantity).sort((a, b) => a - b)).toEqual([5, 10]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(10);
      expect(await balanceOf(productId)).toBe(100);
      const verification = await verify(productId);
      expect(verification.ok).toBe(true);
      expect(verification.allocationBreaches).toEqual([]);
    });

    it('quota révoqué avant l’annulation : la quantité retourne au stock commun, aucune restitution', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);
      const line = await sellLine(holder, productId, 6);
      const revoke = await pipeline.handle(
        buildEnvelope(manager, {
          command_type: 'inventory.allocation.revoke',
          aggregate_type: 'STOCK_ALLOCATION',
          aggregate_id: id,
          payload: { reason: 'Reprise avant annulation' },
        }),
        managerCtx(),
      );
      expect(revoke.status).toBe('APPLIED');

      const before = await entries(id);
      await cancelSale(line, 6);
      expect(await entries(id)).toEqual(before);
      expect((await quota(id)).status).toBe('REVOKED');
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);
      expect(await balanceOf(productId)).toBe(100); // le stock est revenu, au pot commun
      expect((await verify(productId)).ok).toBe(true);
    });

    it('vente sans quota : aucun effet sur les quotas', async () => {
      const holder = await newHolder();
      const other = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(other, productId, 30);
      const line = await sellLine(holder, productId, 5); // détenteur sans quota : stock libre
      await cancelSale(line, 5);
      expect(Number((await quota(id)).quantity_remaining)).toBe(30);
      expect(await entries(id)).toHaveLength(1);
    });
  });

  describe('inverse d’un mouvement (reverseDocumentMoves)', () => {
    it('l’inverse d’une consommation rend la part du quota, pas celle du stock commun', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);
      const docId = freshUuid();
      const moves = await take(holder, productId, 14, {
        moveType: 'CONSUMPTION',
        toLocationId: consumptionLocation,
        sourceDocType: 'CONSUMPTION',
        sourceDocId: docId,
        costObjectType: 'SITE',
        costObjectId: siteId,
      });
      expect(moves.map((move) => move.quantity)).toEqual([10, 4]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);

      const reversed = await db.transaction().execute((trx) =>
        reverseDocumentMoves(trx, moveDeps, {
          sourceDocType: 'CONSUMPTION',
          sourceDocId: docId,
          occurredAt: new Date(OCCURRED_AT),
          createdBy: admin,
          allowNegative: false,
        }),
      );
      expect(reversed).toHaveLength(2);
      expect(Number((await quota(id)).quantity_remaining)).toBe(10);
      expect(await balanceOf(productId)).toBe(100);
      const verification = await verify(productId);
      expect(verification.ok).toBe(true);
    });
  });

  describe('libération d’une perte en attente (LOSS_RELEASE)', () => {
    it('le retrait d’une perte en attente rend d’abord le quota qu’elle avait consommé', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);
      const lossId = freshUuid();
      const pending = await take(holder, productId, 15, {
        moveType: 'LOSS_PENDING',
        toLocationId: pendingLossLocation,
        sourceDocType: 'LOSS',
        sourceDocId: lossId,
      });
      expect(pending.map((move) => move.quantity)).toEqual([10, 5]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(0);

      const released = await db.transaction().execute((trx) =>
        recordStockMove(trx, moveDeps, {
          productId,
          quantityBase: 15,
          fromLocationId: pendingLossLocation,
          toLocationId: storeA,
          moveType: 'LOSS_RELEASE',
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'LOSS',
          sourceDocId: lossId,
          createdBy: holder.userId,
          allowNegative: true,
        }),
      );
      expect(released.map((move) => [move.quantity, move.allocationId ?? null])).toEqual([
        [10, id],
        [5, null],
      ]);
      expect(Number((await quota(id)).quantity_remaining)).toBe(10);
      expect(await balanceOf(productId)).toBe(100);
      expect((await verify(productId)).ok).toBe(true);
    });

    it('une perte approuvée (LOSS_CONFIRMATION) ne rend rien au quota', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantQuota(holder, productId, 10);
      const lossId = freshUuid();
      await take(holder, productId, 8, {
        moveType: 'LOSS_PENDING',
        toLocationId: pendingLossLocation,
        sourceDocType: 'LOSS',
        sourceDocId: lossId,
      });
      await db.transaction().execute((trx) =>
        recordStockMove(trx, moveDeps, {
          productId,
          quantityBase: 8,
          fromLocationId: pendingLossLocation,
          toLocationId: lossLocation,
          moveType: 'LOSS_CONFIRMATION',
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'LOSS',
          sourceDocId: lossId,
          createdBy: admin,
          allowNegative: true,
        }),
      );
      expect(Number((await quota(id)).quantity_remaining)).toBe(2);
      expect((await verify(productId)).ok).toBe(true);
    });
  });

  describe('verifyStockLedger : le registre des quotas (INV-STK-19, INV-STK-20)', () => {
    it('détecte un reste qui n’est pas la somme de son registre, puis le répare', async () => {
      const holder = await newHolder();
      const productId = await newProduct(50);
      const id = await grantQuota(holder, productId, 20);
      await sellLine(holder, productId, 5);
      expect((await verify(productId)).ok).toBe(true);

      await db
        .updateTable('inventory_stock_allocations')
        .set({ quantity_remaining: '14.000' })
        .where('id', '=', toBin(id))
        .execute();
      try {
        const verification = await verify(productId);
        expect(verification.ok).toBe(false);
        expect(verification.allocationBreaches).toMatchObject([
          {
            allocationId: id,
            reason: 'REMAINING_NOT_LEDGER_SUM',
            remaining: 14,
            ledgerRemaining: 15,
          },
        ]);
      } finally {
        await db
          .updateTable('inventory_stock_allocations')
          .set({ quantity_remaining: '15.000' })
          .where('id', '=', toBin(id))
          .execute();
      }
      expect((await verify(productId)).ok).toBe(true);
    });

    it('Σ restes > Σ soldes : toléré tant qu’un conflit ALLOCATION_OVERCOMMITTED est ouvert, anomalie sinon', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      await grantQuota(holder, productId, 25);
      // Perte du serveur (sans consommer de quota) : le solde passe sous le quota promis.
      await db.transaction().execute((trx) =>
        recordStockMove(trx, moveDeps, {
          productId,
          quantityBase: 10,
          fromLocationId: storeA,
          toLocationId: lossLocation,
          moveType: 'LOSS',
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        }),
      );
      expect((await verify(productId)).ok).toBe(true); // conflit ouvert : expliqué
    });

    it('Σ restes > Σ soldes sans aucun conflit ouvert : anomalie de réconciliation (INV-STK-19)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      await grantQuota(holder, productId, 25);
      expect((await verify(productId)).ok).toBe(true);

      // Altération directe de la projection (hors registre, hors conflit) : le contrôle la voit.
      await db
        .updateTable('inventory_stock_balances')
        .set({ qty_on_hand: '20.000' })
        .where('location_id', '=', toBin(storeA))
        .where('product_id', '=', toBin(productId))
        .execute();
      try {
        const verification = await verify(productId);
        expect(verification.ok).toBe(false);
        expect(verification.overcommitBreaches).toEqual([
          { locationId: storeA, productId, stockOnHand: 20, allocatedRemaining: 25 },
        ]);
      } finally {
        await db
          .updateTable('inventory_stock_balances')
          .set({ qty_on_hand: '30.000' })
          .where('location_id', '=', toBin(storeA))
          .where('product_id', '=', toBin(productId))
          .execute();
      }
      expect((await verify(productId)).ok).toBe(true);
    });
  });

  describe('AT-049 : un solde négatif régularisé par l’inventaire', () => {
    it('le conflit STOCK_NEGATIVE de l’emplacement et du produit est clos par l’ajustement', async () => {
      const productId = await newProduct(2);
      const seller = await newHolder();
      // Vente hors ligne de 5 pour un stock de 2 : appliquée, solde −3 (BR-STK-018).
      const saleId = freshUuid();
      const moves = await take(seller, productId, 5, {
        sourceDocId: saleId,
        sourceLineId: freshUuid(),
        capturedOffline: true,
        allowNegative: true,
      });
      expect(await balanceOf(productId)).toBe(-3);
      expect(moves.length).toBeGreaterThan(0);
      // Le conflit que `sales.sale.record` consigne dans ce cas (même forme de `details`).
      await db.transaction().execute((trx) =>
        recordConflict(trx, {
          id: idGenerator.newId(),
          commandId: null,
          conflictType: 'STOCK_NEGATIVE',
          entityType: 'SALE',
          entityId: saleId,
          siteId,
          ownerRole: 'MAGASINIER',
          applied: true,
          details: { saleLineId: freshUuid(), productId, locationId: storeA, balancesAfter: [-3] },
        }),
      );
      const openBefore = await db
        .selectFrom('sync_sync_conflicts')
        .select('status')
        .where('entity_id', '=', toBin(saleId))
        .where('conflict_type', '=', 'STOCK_NEGATIVE')
        .executeTakeFirstOrThrow();
      expect(openBefore.status).toBe('OPEN');

      // Inventaire de l'emplacement : compté 0, théorique −3, écart +3 (gain), solde ramené à 0.
      const countId = freshUuid();
      const open = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.count.open',
          aggregate_type: 'INVENTORY_COUNT',
          aggregate_id: countId,
          payload: { locationId: storeA, countType: 'SPOT' },
        }),
        adminCtx(),
      );
      expect(open.status).toBe('APPLIED');
      for (const [commandType, payload] of [
        [
          'inventory.count.record_lines',
          { countId, lines: [{ productId, countedAt: OCCURRED_AT, countedQtyBase: 0 }] },
        ],
        ['inventory.count.submit', { countId }],
      ] as const) {
        const result = await pipeline.handle(
          buildEnvelope(admin, {
            command_type: commandType,
            aggregate_type: 'INVENTORY_COUNT',
            aggregate_id: countId,
            payload,
          }),
          adminCtx(),
        );
        expect(result.status).toBe('APPLIED');
      }

      expect(await balanceOf(productId)).toBe(0);
      const after = await db
        .selectFrom('sync_sync_conflicts')
        .select(['status', 'resolution', 'resolution_refs'])
        .where('entity_id', '=', toBin(saleId))
        .where('conflict_type', '=', 'STOCK_NEGATIVE')
        .executeTakeFirstOrThrow();
      expect(after.status).toBe('RESOLVED');
      expect(after.resolution).toBe('COMPENSATE');
      expect(after.resolution_refs).toEqual([countId]);
    });
  });

  describe('seuils d’un emplacement partagé (AV-040, ADR-033 §10)', () => {
    it('le seuil se lit sur le solde physique : un quota promis ne déclenche pas d’alerte de stock bas', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      await grantQuota(holder, productId, 35);
      await db
        .insertInto('inventory_stock_thresholds')
        .values({
          id: toBin(freshUuid()),
          location_id: toBin(storeA),
          product_id: toBin(productId),
          min_qty_base: '30.000',
          target_qty_base: '60.000',
          created_by: toBin(admin),
        })
        .execute();

      const [status] = await listStockThresholds(db, {
        locationId: storeA,
        custodyMode: 'SHARED',
        productId,
      });
      expect(status?.qtyAvailable).toBe(40); // physique : 40 ≥ 30, le quota n'est pas déduit
      expect(status?.state).toBe('OK');
    });
  });
});
