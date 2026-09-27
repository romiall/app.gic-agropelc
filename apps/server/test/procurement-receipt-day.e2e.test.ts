/**
 * P6-08 — « Réception partielle avec rejet ; doublon en quarantaine » (plan de développement §4,
 * P6 : tests E2E ; WF-J8 ; D08 §14 « deux magasiniers réceptionnent le même BC hors ligne »).
 * Deux appareils virtuels (`sync-harness.ts`) du même magasin téléchargent le BC livrable, le
 * réceptionnent hors ligne, puis envoient leur file par le vrai protocole (`SyncPushService` →
 * pipeline → gestionnaires `procurement`, `inventory`, `approvals`) ; le responsable des achats
 * tranche les quarantaines ; les appareils retéléchargent le jeu `procurement`.
 *
 * Démontre : seule la quantité acceptée entre en stock (AT-023) ; le même bon de livraison saisi
 * deux fois part en quarantaine sans effet stock (AT-024, INV-APP-03) ; la réception concurrente
 * qui dépasse le reliquat aussi (AV-095, défaut) ; le rejeu d'une file est idempotent ; la
 * décision comptabilise la réception réelle, l'excédent est tracé (INV-APP-02) ; le BC reçu sort
 * des appareils (`SCOPE_EXIT`). Heures relatives à l'heure réelle (fenêtre de 30 jours des
 * réceptions évaluée par la base).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { RawCommandEnvelope } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/procurement/application/commands/order-commands.js';
import { registerReceiptCommands } from '../src/modules/procurement/application/commands/receipt-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { VirtualDevice } from './sync-harness.js';
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
let onlineSeq = 0;

describe('P6-08 : réception partielle avec rejet, doublon et dépassement en quarantaine', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let deviceA: VirtualDevice;
  let deviceB: VirtualDevice;
  let magA: string;
  let magB: string;
  let buyer: { readonly userId: string; readonly deviceId: string };
  let admin: { readonly userId: string; readonly deviceId: string };
  let storeId: string;
  let supplierId: string;
  let productId: string;
  let reasonId: string;
  let orderId: string;
  let orderLineId: string;
  let receiptA: string;
  let duplicateA: string;
  let receiptB: string;
  let queueA: RawCommandEnvelope[];
  let queueB: RawCommandEnvelope[];
  const unitCode = 'SAC';
  const note = `BL-${freshUuid().slice(-8)}`;

  async function online(
    actor: { readonly userId: string; readonly deviceId: string },
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++onlineSeq,
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
  }

  function receiptEnvelope(
    device: VirtualDevice,
    author: string,
    receiptId: string,
    occurredAt: string,
    line: Record<string, unknown>,
  ): RawCommandEnvelope {
    return {
      command_id: freshUuid(),
      device_seq: device.nextSeq(),
      command_type: 'procurement.receipt.record',
      command_version: 1,
      author_user_id: author,
      aggregate_type: 'GOODS_RECEIPT',
      aggregate_id: receiptId,
      base_version: null,
      depends_on: [],
      occurred_at: occurredAt,
      client_created_at: occurredAt,
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {
        purchaseOrderId: orderId,
        supplierId,
        locationId: storeId,
        supplierDeliveryNoteRef: note,
        lines: [{ poLineId: orderLineId, productId, unitCode, ...line }],
      },
    };
  }

  async function stock(): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(storeId))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  async function receiptStatus(id: string) {
    const row = await db
      .selectFrom('procurement_goods_receipts')
      .select(['status', 'approval_request_id'])
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return {
      status: row.status,
      approvalId: row.approval_request_id ? fromBin(row.approval_request_id) : null,
    };
  }

  async function orderLine() {
    return db
      .selectFrom('procurement_purchase_order_lines')
      .selectAll()
      .where('id', '=', toBin(orderLineId))
      .executeTakeFirstOrThrow();
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
    registerOrderCommands(registry, decisions, idGenerator, sequences);
    registerReceiptCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    const services = {
      push: new SyncPushService(pipeline, db, clock),
      pull: new SyncPullService(db),
    };

    const roles = { mag: await roleId('MAGASINIER'), ach: await roleId('RESP_ACHATS') };
    let deviceIdA = '';
    let deviceIdB = '';
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      const siteId = await insertTestSite(trx, adminId, zoneId);
      storeId = await insertTestLocation(trx, adminId, siteId);
      magA = await insertTestUser(trx);
      deviceIdA = await insertTestDevice(trx, magA, { status: 'ACTIVE' });
      await assignTestRole(trx, magA, roles.mag, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      magB = await insertTestUser(trx);
      deviceIdB = await insertTestDevice(trx, magB, { status: 'ACTIVE' });
      await assignTestRole(trx, magB, roles.mag, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      const buyerId = await insertTestUser(trx);
      buyer = {
        userId: buyerId,
        deviceId: await insertTestDevice(trx, buyerId, { status: 'ACTIVE' }),
      };
      await assignTestRole(trx, buyerId, roles.ach, adminId);

      supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Provenderie du Nkam',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
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
          name: 'Aliment démarrage',
          category_id: toBin(categoryId),
          stock_family: 'INTRANT',
          base_unit_code: unitCode,
          is_purchasable: 1,
          created_by: toBin(adminId),
        })
        .execute();
      reasonId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(reasonId),
          code: `REJ-${reasonId.slice(-8)}`,
          category: 'REJECTION',
          label: 'Sacs éventrés',
          created_by: toBin(adminId),
        })
        .execute();
    });
    deviceA = new VirtualDevice(
      services,
      { authenticatedUserId: magA, authenticatedDeviceId: deviceIdA },
      clock,
    );
    deviceB = new VirtualDevice(
      services,
      { authenticatedUserId: magB, authenticatedDeviceId: deviceIdB },
      clock,
    );

    // La veille, en ligne : politique de quarantaine, BC de 50 sacs envoyé au fournisseur.
    const policyId = freshUuid();
    expect(
      (
        await online(admin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, ago(30 * 60), {
          code: `RECEIPT_QUARANTINE_${policyId.slice(-8)}`,
          operationType: 'RECEIPT_QUARANTINE',
          requiresApproval: true,
          approverPermission: 'procurement.receipt_exception.approve',
          approverScope: 'ALL',
        })
      ).status,
    ).toBe('APPLIED');
    orderId = freshUuid();
    for (const [type, payload] of [
      [
        'create',
        {
          supplierId,
          deliveryLocationId: storeId,
          lines: [{ productId, unitCode, orderedQtyBase: 50, unitPriceXaf: 1_000 }],
        },
      ],
      ['submit', {}],
      ['mark_sent', {}],
    ] as const) {
      const result = await online(
        buyer,
        `procurement.order.${type}`,
        'PURCHASE_ORDER',
        orderId,
        ago(20 * 60),
        payload,
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    }
    orderLineId = fromBin(
      (
        await db
          .selectFrom('procurement_purchase_order_lines')
          .select('id')
          .where('order_id', '=', toBin(orderId))
          .executeTakeFirstOrThrow()
      ).id,
    );

    // Au petit matin, chaque appareil télécharge le jeu `procurement` (BC livrable, reliquat 50).
    await deviceA.pullAll('procurement', clock.now());
    await deviceB.pullAll('procurement', clock.now());

    // Hors ligne : A reçoit 30 sacs dont 2 éventrés, puis ressaisit par erreur le même bon ;
    // B, sans le savoir, réceptionne la même livraison (30 sacs) sur l'autre quai.
    receiptA = freshUuid();
    duplicateA = freshUuid();
    receiptB = freshUuid();
    queueA = [
      receiptEnvelope(deviceA, magA, receiptA, ago(180), {
        qtyDeliveredBase: 30,
        qtyRejectedBase: 2,
        rejectionReasonCodeId: reasonId,
      }),
      receiptEnvelope(deviceA, magA, duplicateA, ago(170), {
        qtyDeliveredBase: 30,
        qtyRejectedBase: 2,
        rejectionReasonCodeId: reasonId,
      }),
    ];
    queueB = [receiptEnvelope(deviceB, magB, receiptB, ago(175), { qtyDeliveredBase: 30 })];
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('les appareils ont le BC livrable avec son reliquat, sans prix', () => {
    for (const device of [deviceA, deviceB]) {
      const order = device.localProjection.get(`procurement:PURCHASE_ORDER:${orderId}`);
      expect(order).toMatchObject({ status: 'SENT' });
      expect((order!.lines as Record<string, unknown>[])[0]).toMatchObject({
        remaining_qty_base: 50,
      });
      expect((order!.lines as Record<string, unknown>[])[0]).not.toHaveProperty('unit_price_xaf');
    }
  });

  it('seule la quantité acceptée entre ; doublon et dépassement concurrent en quarantaine ; rejeu idempotent', async () => {
    const pushedA = await deviceA.pushUntilSettled(queueA);
    expect(pushedA.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED_WITH_WARNINGS']);
    const pushedB = await deviceB.pushUntilSettled(queueB);
    expect(pushedB.results.map((r) => r.status)).toEqual(['APPLIED_WITH_WARNINGS']);

    expect((await receiptStatus(receiptA)).status).toBe('POSTED');
    expect((await receiptStatus(duplicateA)).status).toBe('QUARANTINED');
    expect((await receiptStatus(receiptB)).status).toBe('QUARANTINED');
    expect(await stock()).toBe(28); // 30 livrés − 2 rejetés ; rien des quarantaines
    const line = await orderLine();
    expect(Number(line.accepted_qty_base)).toBe(28);

    // Réponse perdue : les mêmes files renvoyées ne créent rien de plus.
    const replayA = await deviceA.pushUntilSettled(queueA);
    expect(replayA.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED_WITH_WARNINGS']);
    await deviceB.pushUntilSettled(queueB);
    const receipts = await db
      .selectFrom('procurement_goods_receipts')
      .select('id')
      .where('purchase_order_id', '=', toBin(orderId))
      .execute();
    expect(receipts).toHaveLength(3);
    expect(await stock()).toBe(28);
  });

  it('le responsable des achats tranche : doublon rejeté, livraison réelle comptabilisée avec excédent tracé', async () => {
    const duplicate = await receiptStatus(duplicateA);
    const rejected = await online(
      buyer,
      'approvals.request.reject',
      'APPROVAL_REQUEST',
      duplicate.approvalId!,
      ago(60),
      {
        requestId: duplicate.approvalId,
        comment: 'Même bon de livraison saisi deux fois',
      },
    );
    expect(rejected.status).toBe('APPLIED');
    expect((await receiptStatus(duplicateA)).status).toBe('REJECTED');

    const concurrent = await receiptStatus(receiptB);
    const approved = await online(
      buyer,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      concurrent.approvalId!,
      ago(55),
      {
        requestId: concurrent.approvalId,
      },
    );
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    expect((await receiptStatus(receiptB)).status).toBe('POSTED');
    expect(await stock()).toBe(58);
    const line = await orderLine();
    expect(Number(line.accepted_qty_base)).toBe(58);
    expect(Number(line.excess_qty_base)).toBe(8); // INV-APP-02 : excédent tracé
    expect(line.status).toBe('RECEIVED');
    const [receiptLineB] = await db
      .selectFrom('procurement_goods_receipt_lines')
      .select('over_receipt_qty_base')
      .where('receipt_id', '=', toBin(receiptB))
      .execute();
    expect(Number(receiptLineB!.over_receipt_qty_base)).toBe(8);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select('source_doc_id')
      .where('source_doc_type', '=', 'GOODS_RECEIPT')
      .where('source_doc_id', 'in', [toBin(receiptA), toBin(duplicateA), toBin(receiptB)])
      .execute();
    expect(moves.map((m) => fromBin(m.source_doc_id)).sort()).toEqual([receiptA, receiptB].sort());
  });

  it('au retéléchargement, le BC reçu quitte les appareils et les réceptions du site arrivent', async () => {
    await deviceA.pullAll('procurement', clock.now());
    const local = deviceA.localProjection;
    expect(local.has(`procurement:PURCHASE_ORDER:${orderId}`)).toBe(false);
    expect(local.get(`procurement:GOODS_RECEIPT:${receiptA}`)).toMatchObject({
      status: 'POSTED',
      lines: [
        expect.objectContaining({
          qty_delivered_base: 30,
          qty_rejected_base: 2,
          qty_accepted_base: 28,
        }),
      ],
    });
    expect(local.get(`procurement:GOODS_RECEIPT:${duplicateA}`)).toMatchObject({
      status: 'REJECTED',
    });
    expect(local.get(`procurement:GOODS_RECEIPT:${receiptB}`)).toMatchObject({ status: 'POSTED' });
  });
});
