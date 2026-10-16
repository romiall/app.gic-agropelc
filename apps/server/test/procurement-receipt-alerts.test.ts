/**
 * P9-09 : alertes d'achats **sur fait**, à travers le vrai pipeline (D13 §7.1, BR-APP-015, BR-APP-012 ;
 * AV-410, AV-464, AV-465) :
 * - `RECEIPT_INCOMPLETE` : à chaque changement des quantités acceptées d'un bon de commande (réception
 *   comptabilisée, quarantaine approuvée, annulation de réception), `ReceiptIncompleteDetected` si le bon
 *   a un reliquat et une date prévue dépassée de plus de 2 jours ou une quantité rejetée, sinon
 *   `ReceiptIncompleteCleared` ;
 * - `DUPLICATE_SUSPECTED` côté réception : `GoodsReceiptQuarantined` à la mise en quarantaine,
 *   `GoodsReceiptQuarantineDecided` à la décision (approuvée ou rejetée).
 * Le jour « courant » est celui du serveur (horloge système) : les dates prévues sont choisies très en
 * arrière (retard) ou très en avant (dans les délais), jamais près d'aujourd'hui.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/procurement/application/commands/order-commands.js';
import { registerReceiptCommands } from '../src/modules/procurement/application/commands/receipt-commands.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
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

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const NOW = '2026-10-06T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-06T${hhmmss}.000Z`;
/** Date prévue largement dépassée (plusieurs années de retard). */
const LATE = '2020-01-15';
/** Date prévue lointaine : jamais en retard. */
const ON_TIME = '2099-01-15';
const unitCode = 'SAC';
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('RECEIPT_INCOMPLETE et quarantaine : détection sur fait (P9-09)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let storekeeper: Actor;
  let buyer: Actor;
  let director: Actor;
  let siteId: string;
  let storeId: string;
  let supplierId: string;
  let categoryId: string;
  let rejectionReasonId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<Result> {
    return pipeline.handle(
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
  }

  const order = (actor: Actor, id: string, type: string, occurredAt: string, payload = {}) =>
    run(actor, `procurement.order.${type}`, 'PURCHASE_ORDER', id, occurredAt, payload);
  const approve = (actor: Actor, requestId: string, occurredAt: string) =>
    run(actor, 'approvals.request.approve', 'APPROVAL_REQUEST', requestId, occurredAt, {
      requestId,
    });
  const reject = (actor: Actor, requestId: string, occurredAt: string) =>
    run(actor, 'approvals.request.reject', 'APPROVAL_REQUEST', requestId, occurredAt, {
      requestId,
      comment: 'Doublon confirmé',
    });

  async function newProduct(): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-8)}`,
        name: 'Aliment croissance',
        category_id: toBin(categoryId),
        stock_family: 'INTRANT',
        base_unit_code: unitCode,
        is_purchasable: 1,
        lot_tracking: 'NONE',
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  /** BC envoyé, 100 unités à 100 XAF (sous le seuil de photo), date prévue choisie. */
  async function sentOrder(
    productId: string,
    expectedDeliveryDate: string,
  ): Promise<{ readonly id: string; readonly lineId: string }> {
    const id = freshUuid();
    const created = await order(buyer, id, 'create', at('08:00:00'), {
      supplierId,
      deliveryLocationId: storeId,
      expectedDeliveryDate,
      lines: [{ productId, unitCode, orderedQtyBase: 100, unitPriceXaf: 100 }],
    });
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    expect(code(await order(buyer, id, 'submit', at('08:05:00')))).toBe('APPLIED');
    const row = await db
      .selectFrom('procurement_purchase_orders')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    if (row.status === 'PENDING_APPROVAL') {
      expect(code(await approve(director, fromBin(row.approval_request_id!), at('08:10:00')))).toBe(
        'APPLIED',
      );
    }
    expect(code(await order(buyer, id, 'mark_sent', at('08:15:00')))).toBe('APPLIED');
    const [line] = await db
      .selectFrom('procurement_purchase_order_lines')
      .select('id')
      .where('order_id', '=', toBin(id))
      .execute();
    return { id, lineId: fromBin(line!.id) };
  }

  async function receive(
    po: { readonly id: string; readonly lineId: string },
    productId: string,
    delivered: number,
    rejected: number,
    occurredAt: string,
    note?: string,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(
      storekeeper,
      'procurement.receipt.record',
      'GOODS_RECEIPT',
      id,
      occurredAt,
      {
        purchaseOrderId: po.id,
        supplierId,
        locationId: storeId,
        ...(note !== undefined ? { supplierDeliveryNoteRef: note } : {}),
        lines: [
          {
            poLineId: po.lineId,
            productId,
            unitCode,
            qtyDeliveredBase: delivered,
            ...(rejected > 0
              ? { qtyRejectedBase: rejected, rejectionReasonCodeId: rejectionReasonId }
              : {}),
          },
        ],
      },
    );
    return { id, result };
  }

  async function incompleteEvents(orderId: string) {
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', 'in', ['ReceiptIncompleteDetected', 'ReceiptIncompleteCleared'])
        .where('aggregate_id', '=', toBin(orderId))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  async function quarantineEvents(receiptId: string) {
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', 'in', ['GoodsReceiptQuarantined', 'GoodsReceiptQuarantineDecided'])
        .where('aggregate_id', '=', toBin(receiptId))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  async function approvalOf(receiptId: string): Promise<string> {
    const row = await db
      .selectFrom('procurement_goods_receipts')
      .select('approval_request_id')
      .where('id', '=', toBin(receiptId))
      .executeTakeFirstOrThrow();
    return fromBin(row.approval_request_id!);
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerOrderCommands(registry, decisions, idGenerator, sequences);
    registerReceiptCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      mag: await roleId('MAGASINIER'),
      ach: await roleId('RESP_ACHATS'),
      dir: await roleId('DIRECTION'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId);
      storeId = await insertTestLocation(trx, adminId, siteId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      storekeeper = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteId });
      buyer = await actor(roles.ach);
      director = await actor(roles.dir);

      supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Provenderie du Littoral',
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
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Aliments',
          created_by: toBin(adminId),
        })
        .execute();
      rejectionReasonId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(rejectionReasonId),
          code: `REJ-${rejectionReasonId.slice(-8)}`,
          category: 'REJECTION',
          label: 'Sacs déchirés',
          created_by: toBin(adminId),
        })
        .execute();
    });

    for (const [operationType, approverPermission] of [
      ['PURCHASE_ORDER', 'procurement.order.approve'],
      ['RECEIPT_QUARANTINE', 'procurement.receipt_exception.approve'],
      ['RECEIPT_CANCELLATION', 'procurement.receipt.cancel'],
    ] as const) {
      const policyId = freshUuid();
      const policy = await run(
        admin,
        'approvals.policy.set',
        'CONTROL_POLICY',
        policyId,
        at('00:00:00'),
        {
          code: `${operationType}_${policyId.slice(-8)}`,
          operationType,
          requiresApproval: true,
          approverPermission,
          approverScope: 'ALL',
        },
      );
      expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    }
  });

  it('réception partielle sans rejet dans les délais : l’état « complet » est publié, aucune alerte', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    const first = await receive(po, productId, 60, 0, at('09:00:00'));
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    const events = await incompleteEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual(['ReceiptIncompleteCleared']);
    expect(events[0]!.payload).toMatchObject({ po_id: po.id, trigger: 'RECEIPT' });
  });

  it('une quantité rejetée avec reliquat lève l’alerte (raison REJECTED), la réception du reste la ferme', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    await receive(po, productId, 50, 5, at('09:00:00')); // accepté 45, rejeté 5, reliquat 55
    const [detected] = await incompleteEvents(po.id);
    expect(detected!.eventType).toBe('ReceiptIncompleteDetected');
    expect(detected!.producerModule).toBe('procurement');
    expect(detected!.aggregateType).toBe('PURCHASE_ORDER');
    expect(detected!.payload).toMatchObject({
      po_id: po.id,
      supplier_label: 'Provenderie du Littoral',
      site_id: siteId,
      expected_delivery_date: ON_TIME,
      days_late: null,
      threshold_days: 2,
      reason: 'REJECTED',
      rejected: 5,
      remaining_lines: 1,
      po_status: 'PARTIALLY_RECEIVED',
      trigger: 'RECEIPT',
    });
    // Aucune valeur au coût dans la charge utile (RC-05).
    expect(Object.keys(detected!.payload as object)).not.toContain('total_accepted_value_xaf');

    await receive(po, productId, 55, 0, at('10:00:00')); // reliquat nul : BC reçu
    const events = await incompleteEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual([
      'ReceiptIncompleteDetected',
      'ReceiptIncompleteCleared',
    ]);
  });

  it('un bon en retard avec reliquat est signalé (raison OVERDUE, jours de retard), même sans rejet', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, LATE);
    await receive(po, productId, 40, 0, at('09:00:00'));
    const [event] = await incompleteEvents(po.id);
    expect(event!.eventType).toBe('ReceiptIncompleteDetected');
    expect(event!.payload).toMatchObject({
      expected_delivery_date: LATE,
      reason: 'OVERDUE',
      rejected: null,
      remaining_lines: 1,
    });
    expect(Number((event!.payload as { days_late: number }).days_late)).toBeGreaterThan(1000);
  });

  it('l’annulation d’une réception rétablit le reliquat : l’état est republié sans la réception annulée', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    // Réception complète avec 10 rejetés : accepté 90 sur 100 → reliquat 10 et rejet → alerte.
    const first = await receive(po, productId, 100, 10, at('09:00:00'));
    expect((await incompleteEvents(po.id)).map((e) => e.eventType)).toEqual([
      'ReceiptIncompleteDetected',
    ]);

    const cancellation = await run(
      storekeeper,
      'procurement.receipt.request_cancellation',
      'GOODS_RECEIPT',
      first.id,
      at('09:30:00'),
      { reason: 'Réception saisie sur le mauvais BC' },
    );
    expect(code(cancellation)).toBe('APPLIED');
    expect(code(await approve(buyer, await approvalOf(first.id), at('10:00:00')))).toBe('APPLIED');

    // Réception annulée : plus rien d'accepté, plus rien de rejeté ; le bon est dans les délais : « complet ».
    const events = await incompleteEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual([
      'ReceiptIncompleteDetected',
      'ReceiptIncompleteCleared',
    ]);
    expect(events[1]!.payload).toMatchObject({ trigger: 'RECEIPT_CANCELLATION' });
  });

  it('un bon en retard dont la réception est annulée redevient incomplet (jamais compté sur la réception annulée)', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, LATE);
    const first = await receive(po, productId, 100, 0, at('09:00:00')); // reçu en entier : complet
    expect((await incompleteEvents(po.id)).map((e) => e.eventType)).toEqual([
      'ReceiptIncompleteCleared',
    ]);
    await run(
      storekeeper,
      'procurement.receipt.request_cancellation',
      'GOODS_RECEIPT',
      first.id,
      at('09:30:00'),
      { reason: 'Erreur de quantité' },
    );
    expect(code(await approve(buyer, await approvalOf(first.id), at('10:00:00')))).toBe('APPLIED');
    const events = await incompleteEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual([
      'ReceiptIncompleteCleared',
      'ReceiptIncompleteDetected',
    ]);
    expect(events[1]!.payload).toMatchObject({
      reason: 'OVERDUE',
      trigger: 'RECEIPT_CANCELLATION',
      remaining_lines: 1,
    });
  });

  it('quarantaine d’un doublon : GoodsReceiptQuarantined avec ses raisons ; rejet : décision publiée', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    const note = `BL-${freshUuid().slice(-8)}`;
    await receive(po, productId, 10, 0, at('09:00:00'), note);
    const duplicate = await receive(po, productId, 10, 0, at('09:30:00'), note);
    expect(duplicate.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['RECEIPT_QUARANTINED'],
    });
    const receipt = await db
      .selectFrom('procurement_goods_receipts')
      .select(['doc_number', 'approval_request_id'])
      .where('id', '=', toBin(duplicate.id))
      .executeTakeFirstOrThrow();
    const [quarantined] = await quarantineEvents(duplicate.id);
    expect(quarantined!.eventType).toBe('GoodsReceiptQuarantined');
    expect(quarantined!.producerModule).toBe('procurement');
    expect(quarantined!.aggregateType).toBe('GOODS_RECEIPT');
    expect(quarantined!.payload).toMatchObject({
      kind: 'Réception',
      reference: receipt.doc_number,
      receipt_id: duplicate.id,
      purchase_order_id: po.id,
      supplier_label: 'Provenderie du Littoral',
      site_id: siteId,
      reasons: ['DUPLICATE_DELIVERY_NOTE'],
      supplier_delivery_note_ref: note,
      captured_offline: false,
    });
    expect((quarantined!.payload as { approval_request_id: string }).approval_request_id).toBe(
      fromBin(receipt.approval_request_id!),
    );
    // Aucune réception comptabilisée : le BC n'est pas réévalué par la quarantaine.
    expect((await incompleteEvents(po.id)).map((e) => e.eventType)).toEqual([
      'ReceiptIncompleteCleared',
    ]);

    expect(code(await reject(director, await approvalOf(duplicate.id), at('10:00:00')))).toBe(
      'APPLIED',
    );
    const events = await quarantineEvents(duplicate.id);
    expect(events.map((event) => event.eventType)).toEqual([
      'GoodsReceiptQuarantined',
      'GoodsReceiptQuarantineDecided',
    ]);
    expect(events[1]!.payload).toMatchObject({
      receipt_id: duplicate.id,
      decision: 'REJECTED',
      decided_by: director.userId,
    });
  });

  it('quarantaine approuvée : décision publiée, puis état du BC réévalué avec la réception comptabilisée', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    const note = `BL-${freshUuid().slice(-8)}`;
    await receive(po, productId, 10, 0, at('09:00:00'), note);
    const distinct = await receive(po, productId, 10, 2, at('09:30:00'), note); // quarantaine
    expect((await incompleteEvents(po.id)).length).toBe(1);
    expect(code(await approve(director, await approvalOf(distinct.id), at('10:00:00')))).toBe(
      'APPLIED',
    );
    const decided = (await quarantineEvents(distinct.id)).map((event) => event.eventType);
    expect(decided).toEqual(['GoodsReceiptQuarantined', 'GoodsReceiptQuarantineDecided']);
    // La réception confirmée porte 2 rejetés : le BC devient « incomplet » (rejet avec reliquat).
    const events = await incompleteEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual([
      'ReceiptIncompleteCleared',
      'ReceiptIncompleteDetected',
    ]);
    expect(events[1]!.payload).toMatchObject({ reason: 'REJECTED', rejected: 2 });
  });

  it('bout en bout : alertes levées puis fermées par le consommateur', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, ON_TIME);
    await receive(po, productId, 50, 5, at('09:00:00'));
    const note = `BL-${freshUuid().slice(-8)}`;
    await receive(po, productId, 5, 0, at('09:10:00'), note);
    const duplicate = await receive(po, productId, 5, 0, at('09:20:00'), note);
    expect(duplicate.result.status).toBe('APPLIED_WITH_WARNINGS');
    expect(code(await reject(director, await approvalOf(duplicate.id), at('10:00:00')))).toBe(
      'APPLIED',
    );
    const incomplete = await incompleteEvents(po.id);
    const quarantine = await quarantineEvents(duplicate.id);
    const detected = incomplete.find((event) => event.eventType === 'ReceiptIncompleteDetected')!;
    const quarantined = quarantine.find((event) => event.eventType === 'GoodsReceiptQuarantined')!;
    const decidedEvent = quarantine.find(
      (event) => event.eventType === 'GoodsReceiptQuarantineDecided',
    )!;

    await rolledBack(async (uow: UnitOfWork) => {
      const status = async (dedupKey: string) =>
        (
          await uow
            .selectFrom('communication_alerts')
            .select(['status', 'severity', 'title', 'message'])
            .where('dedup_key', '=', dedupKey)
            .executeTakeFirstOrThrow()
        ).status;
      await handleAlertEvent(uow, detected, { idGenerator });
      expect(await status(`RECEIPT_INCOMPLETE:${po.id}`)).toBe('OPEN');
      await handleAlertEvent(uow, quarantined, { idGenerator });
      expect(await status(`DUPLICATE_SUSPECTED:${duplicate.id}`)).toBe('OPEN');
      await handleAlertEvent(uow, decidedEvent, { idGenerator });
      expect(await status(`DUPLICATE_SUSPECTED:${duplicate.id}`)).toBe('RESOLVED');
      // L'état « complet » du BC (réception du reliquat) ferme l'alerte de réception incomplète.
      const cleared = {
        ...detected,
        eventType: 'ReceiptIncompleteCleared',
        eventId: freshUuid(),
        payload: { po_id: po.id, trigger: 'RECEIPT' },
      };
      await handleAlertEvent(uow, cleared, { idGenerator });
      expect(await status(`RECEIPT_INCOMPLETE:${po.id}`)).toBe('RESOLVED');
    });
  });
});
