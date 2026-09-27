/**
 * Projections `/sync/pull` du jeu `procurement` (P6-07 ; 01-architecture-offline.md §3.1 : « BC
 * livrables sur le site, fournisseurs actifs (liste courte), DA de l'utilisateur », filtres
 * `SITE`, `USER`), alimentées par `procurement` via `platform/sync/change-feed.ts`. Données
 * écrites par le vrai pipeline avec les rôles réels du seed ; téléchargement par le vrai
 * `SyncPullService`.
 *
 * Démontre : le magasinier reçoit les BC livrables de son site avec leurs reliquats (sans prix,
 * RC-05), jamais ceux d'un autre site ; un BC entièrement reçu sort de l'appareil
 * (`SCOPE_EXIT`) ; ses DA et pas celles des autres ; les réceptions de son site des 30 derniers
 * jours, sans coût ; la liste courte des fournisseurs actifs (désactivation → `SCOPE_EXIT`) ; le
 * repli générique `GLOBAL` du pipeline ne sert jamais un document d'achat.
 *
 * Les heures métier sont relatives à l'heure réelle : la fenêtre de 30 jours des réceptions est
 * évaluée par la base (`UTC_TIMESTAMP`), au moment du téléchargement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSupplierCommands } from '../src/modules/procurement/application/commands/supplier-commands.js';
import { registerRequestCommands } from '../src/modules/procurement/application/commands/request-commands.js';
import { registerOrderCommands } from '../src/modules/procurement/application/commands/order-commands.js';
import { registerReceiptCommands } from '../src/modules/procurement/application/commands/receipt-commands.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
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
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
/** Heure métier `minutes` avant maintenant (ISO). */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const DAY_MINUTES = 24 * 60;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('projections /sync/pull du jeu procurement (P6-07)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let admin: Actor;
  let mag: Actor;
  let magB: Actor;
  let buyer: Actor;
  let siteA: string;
  let siteB: string;
  let storeA: string;
  let storeB: string;
  let supplierId: string;
  let productId: string;
  const unitCode = 'SAC';

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function pull(actor: Actor, dataset = 'procurement'): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 2000 },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        now: clock.now(),
      },
    );
    return response.changes;
  }

  /** Dernier état reçu pour une entité (l'appareil applique les changements dans l'ordre). */
  function latest(changes: readonly Change[], entityType: string, entityId: string) {
    const matching = changes.filter(
      (c) => c.entity_type === entityType && c.entity_id === entityId,
    );
    return matching[matching.length - 1];
  }

  async function sentOrder(locationId: string, quantity: number, minutesAgo: number) {
    const id = freshUuid();
    await run(buyer, 'procurement.order.create', 'PURCHASE_ORDER', id, ago(minutesAgo), {
      supplierId,
      deliveryLocationId: locationId,
      lines: [{ productId, unitCode, orderedQtyBase: quantity, unitPriceXaf: 1_000 }],
    });
    await run(buyer, 'procurement.order.submit', 'PURCHASE_ORDER', id, ago(minutesAgo - 1), {});
    await run(buyer, 'procurement.order.mark_sent', 'PURCHASE_ORDER', id, ago(minutesAgo - 2), {});
    const line = await db
      .selectFrom('procurement_purchase_order_lines')
      .select('id')
      .where('order_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return { id, lineId: fromBin(line.id) };
  }

  async function receive(
    order: { readonly id: string; readonly lineId: string },
    quantity: number,
    occurredAt: string,
  ): Promise<string> {
    const id = freshUuid();
    await run(mag, 'procurement.receipt.record', 'GOODS_RECEIPT', id, occurredAt, {
      purchaseOrderId: order.id,
      supplierId,
      locationId: storeA,
      lines: [{ poLineId: order.lineId, productId, unitCode, qtyDeliveredBase: quantity }],
    });
    return id;
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerSupplierCommands(registry);
    registerRequestCommands(registry, decisions, idGenerator, sequences);
    registerOrderCommands(registry, decisions, idGenerator, sequences);
    registerReceiptCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);

    const roles = { mag: await roleId('MAGASINIER'), ach: await roleId('RESP_ACHATS') };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId);
      siteB = await insertTestSite(trx, adminId, zoneId);
      storeA = await insertTestLocation(trx, adminId, siteA);
      storeB = await insertTestLocation(trx, adminId, siteB);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      mag = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteA });
      magB = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteB });
      buyer = await actor(roles.ach);
      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', unitCode)
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: unitCode, name: 'Sac', is_count: 1 })
          .execute();
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Aliments',
          created_by: toBin(adminId),
        })
        .execute();
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-8)}`,
          name: 'Aliment finition',
          category_id: toBin(categoryId),
          stock_family: 'INTRANT',
          base_unit_code: unitCode,
          is_purchasable: 1,
          created_by: toBin(adminId),
        })
        .execute();
    });

    const maxSeq = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(maxSeq?.seq ?? 0);

    const policyId = freshUuid();
    await run(admin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, ago(60 * DAY_MINUTES), {
      code: `PURCHASE_REQUEST_${policyId.slice(-8)}`,
      operationType: 'PURCHASE_REQUEST',
      requiresApproval: true,
      approverPermission: 'procurement.request.approve',
      approverScope: 'ALL',
    });
    supplierId = freshUuid();
    await run(buyer, 'procurement.supplier.create', 'SUPPLIER', supplierId, ago(60 * DAY_MINUTES), {
      code: `F-${supplierId.slice(-10)}`,
      name: 'Provenderie de la Sanaga',
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('BC livrables du site avec reliquats, sans prix ; BC entièrement reçu → SCOPE_EXIT', async () => {
    const order = await sentOrder(storeA, 10, 120);
    const other = await sentOrder(storeB, 10, 110);

    let changes = await pull(mag);
    const sent = latest(changes, 'PURCHASE_ORDER', order.id);
    expect(sent?.change_type).toBe('UPSERT');
    expect(sent?.data).toMatchObject({ status: 'SENT', supplier_id: supplierId });
    const [line] = sent!.data!.lines as Record<string, unknown>[];
    expect(line).toMatchObject({
      ordered_qty_base: 10,
      accepted_qty_base: 0,
      remaining_qty_base: 10,
    });
    expect(line).not.toHaveProperty('unit_price_xaf');
    expect(sent!.data).not.toHaveProperty('total_xaf');
    expect(latest(changes, 'PURCHASE_ORDER', other.id)).toBeUndefined();
    expect(latest(await pull(magB), 'PURCHASE_ORDER', other.id)?.change_type).toBe('UPSERT');

    await receive(order, 4, ago(60));
    changes = await pull(mag);
    const partial = latest(changes, 'PURCHASE_ORDER', order.id);
    expect(partial?.data).toMatchObject({ status: 'PARTIALLY_RECEIVED' });
    expect((partial!.data!.lines as Record<string, unknown>[])[0]).toMatchObject({
      accepted_qty_base: 4,
      remaining_qty_base: 6,
    });
    expect(partial!.row_version).toBeGreaterThan(sent!.row_version);

    await receive(order, 6, ago(30));
    const done = latest(await pull(mag), 'PURCHASE_ORDER', order.id);
    expect(done?.change_type).toBe('SCOPE_EXIT');
    expect(done?.data).toBeUndefined();
  });

  it('DA de l’utilisateur seulement ; réceptions du site des 30 derniers jours, sans coût', async () => {
    const mine = freshUuid();
    const theirs = freshUuid();
    for (const [actor, id, siteId] of [
      [mag, mine, siteA],
      [magB, theirs, siteB],
    ] as const) {
      await run(actor, 'procurement.request.submit', 'PURCHASE_REQUEST', id, ago(100), {
        siteId,
        justification: 'Réassort',
        lines: [{ productId, quantityBase: 5, unitCode, quantity: 5 }],
      });
    }
    const changes = await pull(mag);
    expect(latest(changes, 'PURCHASE_REQUEST', mine)?.data).toMatchObject({
      status: 'SUBMITTED',
      requested_by: mag.userId,
      lines: [expect.objectContaining({ quantity_base: 5, ordered_qty_base: 0 })],
    });
    expect(latest(changes, 'PURCHASE_REQUEST', theirs)).toBeUndefined();

    const order = await sentOrder(storeA, 20, 45 * DAY_MINUTES);
    const old = await receive(order, 2, ago(40 * DAY_MINUTES));
    const recent = await receive(order, 3, ago(10));
    const afterReceipts = await pull(mag);
    expect(latest(afterReceipts, 'GOODS_RECEIPT', old)).toBeUndefined();
    const served = latest(afterReceipts, 'GOODS_RECEIPT', recent);
    expect(served?.data).toMatchObject({
      status: 'POSTED',
      purchase_order_id: order.id,
      lines: [expect.objectContaining({ qty_delivered_base: 3, qty_accepted_base: 3 })],
    });
    expect((served!.data!.lines as Record<string, unknown>[])[0]).not.toHaveProperty(
      'unit_cost_xaf',
    );
    expect(served!.data).not.toHaveProperty('total_accepted_value_xaf');
    expect(latest(await pull(magB), 'GOODS_RECEIPT', recent)).toBeUndefined();
  });

  it('fournisseurs actifs pour tous ; désactivation → SCOPE_EXIT ; repli GLOBAL jamais servi', async () => {
    const supplier = latest(await pull(mag), 'SUPPLIER', supplierId);
    expect(supplier?.data).toMatchObject({ id: supplierId, name: 'Provenderie de la Sanaga' });

    await run(buyer, 'procurement.supplier.deactivate', 'SUPPLIER', supplierId, ago(5), {});
    expect(latest(await pull(magB), 'SUPPLIER', supplierId)?.change_type).toBe('SCOPE_EXIT');

    // Lignes génériques du pipeline (jeu = type d'agrégat, portée GLOBAL) : aucune donnée.
    for (const dataset of ['purchase_order', 'goods_receipt', 'purchase_request']) {
      const generic = await pull(mag, dataset);
      expect(generic.filter((c) => c.data !== undefined)).toEqual([]);
    }
  });
});
