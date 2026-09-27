/**
 * Réceptions (P6-05, D08-APP, SM-RECEIPT) à travers le vrai pipeline, avec les rôles réels du seed
 * (magasinier, responsable des achats, Direction) : AT-023 (livré ≠ rejeté ≠ accepté, reliquat,
 * CMUP), AT-024 (bon de livraison en double → quarantaine sans effet stock), dépassement du
 * reliquat en ligne et hors ligne (AV-095, deux modes), réception sans BC en revue, lot
 * fournisseur, annulation par mouvements inverses et son refus quand le stock est consommé.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/procurement/application/commands/order-commands.js';
import { registerReceiptCommands } from '../src/modules/procurement/application/commands/receipt-commands.js';
import {
  recordStockMove,
  virtualLocationId,
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
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-06T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-06T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

interface RunOptions {
  readonly offline?: boolean;
  readonly attachmentIds?: readonly string[];
}

describe('procurement.receipt.* (P6-05)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let storekeeper: Actor;
  let otherStorekeeper: Actor;
  let buyer: Actor;
  let director: Actor;
  let siteId: string;
  let storeId: string;
  let otherStoreId: string;
  let supplierId: string;
  let inactiveSupplierId: string;
  let categoryId: string;
  let rejectionReasonId: string;
  const unitCode = 'SAC';

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: RunOptions = {},
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
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [...(options.attachmentIds ?? [])],
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
      comment: 'Refus de test',
    });

  interface ReceiptLine {
    readonly poLineId?: string;
    readonly productId: string;
    readonly qtyDeliveredBase: number;
    readonly qtyRejectedBase?: number;
    readonly rejectionReasonCodeId?: string;
    readonly unitCostXaf?: number;
    readonly supplierLotRef?: string;
    readonly expiryDate?: string;
  }

  async function receive(
    input: {
      readonly purchaseOrderId?: string;
      readonly supplier?: string;
      readonly locationId?: string;
      readonly note?: string;
      readonly lines: readonly ReceiptLine[];
    },
    occurredAt: string,
    options: RunOptions & { readonly actor?: Actor } = {},
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(
      options.actor ?? storekeeper,
      'procurement.receipt.record',
      'GOODS_RECEIPT',
      id,
      occurredAt,
      {
        ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
        supplierId: input.supplier ?? supplierId,
        locationId: input.locationId ?? storeId,
        ...(input.note ? { supplierDeliveryNoteRef: input.note } : {}),
        lines: input.lines.map((line) => ({ unitCode, ...line })),
      },
      options,
    );
    return { id, result };
  }

  async function newProduct(lotTracking: 'NONE' | 'REQUIRED' = 'NONE'): Promise<string> {
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
        lot_tracking: lotTracking,
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  /** BC envoyé au fournisseur (approuvé par la Direction au-delà du seuil, BR-APP-005). */
  async function sentOrder(
    productId: string,
    orderedQtyBase: number,
    unitPriceXaf: number,
    options: { readonly send?: boolean } = {},
  ): Promise<{ readonly id: string; readonly lineId: string }> {
    const id = freshUuid();
    const created = await order(buyer, id, 'create', at('08:00:00'), {
      supplierId,
      deliveryLocationId: storeId,
      expectedDeliveryDate: '2026-10-12',
      lines: [{ productId, unitCode, orderedQtyBase, unitPriceXaf }],
    });
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    expect(code(await order(buyer, id, 'submit', at('08:05:00')))).toBe('APPLIED');
    const row = await orderRow(id);
    if (row.status === 'PENDING_APPROVAL') {
      expect(code(await approve(director, fromBin(row.approval_request_id!), at('08:10:00')))).toBe(
        'APPLIED',
      );
    }
    if (options.send !== false) {
      expect(code(await order(buyer, id, 'mark_sent', at('08:15:00')))).toBe('APPLIED');
    }
    const [line] = await orderLines(id);
    return { id, lineId: fromBin(line!.id) };
  }

  async function orderRow(id: string) {
    return db
      .selectFrom('procurement_purchase_orders')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function orderLines(orderId: string) {
    return db
      .selectFrom('procurement_purchase_order_lines')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('line_no', 'asc')
      .execute();
  }

  async function receiptRow(id: string) {
    return db
      .selectFrom('procurement_goods_receipts')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirst();
  }

  async function receiptLines(id: string) {
    return db
      .selectFrom('procurement_goods_receipt_lines')
      .selectAll()
      .where('receipt_id', '=', toBin(id))
      .orderBy('created_at', 'asc')
      .execute();
  }

  async function approvalOf(receiptId: string) {
    const row = await receiptRow(receiptId);
    const approval = await db
      .selectFrom('approvals_approval_requests')
      .selectAll()
      .where('id', '=', row!.approval_request_id!)
      .executeTakeFirstOrThrow();
    return { id: fromBin(approval.id), row: approval };
  }

  async function stockAt(locationId: string, productId: string): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  async function cmup(productId: string): Promise<number> {
    const row = await db
      .selectFrom('inventory_product_valuations')
      .select('avg_unit_cost_xaf')
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.avg_unit_cost_xaf);
  }

  async function movesOf(receiptId: string) {
    return db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('source_doc_type', '=', 'GOODS_RECEIPT')
      .where('source_doc_id', '=', toBin(receiptId))
      .orderBy('occurred_at', 'asc')
      .execute();
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
      const otherSiteId = await insertTestSite(trx, adminId, zoneId);
      otherStoreId = await insertTestLocation(trx, adminId, otherSiteId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      storekeeper = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteId });
      otherStorekeeper = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: otherSiteId });
      buyer = await actor(roles.ach);
      director = await actor(roles.dir);

      supplierId = freshUuid();
      inactiveSupplierId = freshUuid();
      for (const [id, status] of [
        [supplierId, 'ACTIVE'],
        [inactiveSupplierId, 'INACTIVE'],
      ] as const) {
        await trx
          .insertInto('procurement_suppliers')
          .values({
            id: toBin(id),
            code: `F-${id.slice(-10)}`,
            name: 'Provenderie du Littoral',
            supplied_categories: JSON.stringify([]),
            status,
            created_by: toBin(adminId),
          })
          .execute();
      }
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
      ['RECEIPT_WITHOUT_PO', 'procurement.receipt_exception.approve'],
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

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-023 : livré 98, rejeté 3 → 95 acceptés en stock au prix du BC, reliquat 5, puis BC reçu', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, 100, 15_000);
    const line = {
      poLineId: po.lineId,
      productId,
      qtyDeliveredBase: 98,
      qtyRejectedBase: 3,
      rejectionReasonCodeId: rejectionReasonId,
    };
    const photo = freshUuid();

    // BR-APP-014 : 95 × 15 000 ≥ 100 000 XAF → photo du bon de livraison exigée.
    expect(
      code((await receive({ purchaseOrderId: po.id, lines: [line] }, at('09:00:00'))).result),
    ).toBe('PHOTO_REQUIRED');
    const withoutReason = { ...line, rejectionReasonCodeId: undefined };
    expect(
      code(
        (
          await receive({ purchaseOrderId: po.id, lines: [withoutReason] }, at('09:00:00'), {
            attachmentIds: [photo],
          })
        ).result,
      ),
    ).toBe('REJECTION_REASON_REQUIRED');

    const first = await receive(
      { purchaseOrderId: po.id, note: `BL-${po.id.slice(-6)}`, lines: [line] },
      at('09:00:00'),
      {
        attachmentIds: [photo],
      },
    );
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    expect(first.result).toMatchObject({
      server_refs: { docNumber: expect.stringMatching(/^REC-.+-2026-\d{6}$/) },
    });
    const receipt = await receiptRow(first.id);
    expect(receipt).toMatchObject({ status: 'POSTED', total_accepted_value_xaf: 1_425_000 });
    const [stored] = await receiptLines(first.id);
    expect(Number(stored!.qty_delivered_base)).toBe(98);
    expect(Number(stored!.qty_rejected_base)).toBe(3);
    expect(Number(stored!.qty_accepted_base)).toBe(95);
    expect(Number(stored!.unit_cost_xaf)).toBe(15_000);
    expect(stored!.stock_lot_id).toBeNull();

    // Seule la quantité acceptée entre, V_SUPPLIER → magasin, au prix du BC (BR-APP-007/008).
    expect(await stockAt(storeId, productId)).toBe(95);
    expect(await cmup(productId)).toBe(15_000);
    const [move] = await movesOf(first.id);
    expect(move).toMatchObject({ move_type: 'PURCHASE_RECEIPT', unit_cost_xaf: 15_000 });
    expect(Number(move!.quantity)).toBe(95);
    expect(fromBin(move!.from_location_id)).toBe(
      await db.transaction().execute((trx) => virtualLocationId(trx, 'V_SUPPLIER')),
    );

    let [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(95);
    expect(poLine!.status).toBe('OPEN');
    expect((await orderRow(po.id)).status).toBe('PARTIALLY_RECEIVED');

    // BR-APP-010 : en ligne, accepter 6 sur un reliquat de 5 est refusé, sans aucune écriture.
    const over = await receive(
      { purchaseOrderId: po.id, lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 6 }] },
      at('10:00:00'),
    );
    expect(code(over.result)).toBe('OVER_RECEIPT');
    expect(await receiptRow(over.id)).toBeUndefined();

    const rest = await receive(
      { purchaseOrderId: po.id, lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 5 }] },
      at('10:05:00'),
    );
    expect(code(rest.result)).toBe('APPLIED');
    expect(await stockAt(storeId, productId)).toBe(100);
    [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(100);
    expect(Number(poLine!.excess_qty_base)).toBe(0);
    expect(poLine!.status).toBe('RECEIVED');
    expect((await orderRow(po.id)).status).toBe('RECEIVED');
  });

  it('refus : BC non envoyé en ligne, fournisseur ou ligne étrangers, emplacement hors site ou hors portée', async () => {
    const productId = await newProduct();
    const approvedOnly = await sentOrder(productId, 10, 1_000, { send: false });
    const line = { poLineId: approvedOnly.lineId, productId, qtyDeliveredBase: 2 };
    expect(
      code(
        (await receive({ purchaseOrderId: approvedOnly.id, lines: [line] }, at('09:00:00'))).result,
      ),
    ).toBe('PO_NOT_RECEIVABLE');

    const po = await sentOrder(productId, 10, 1_000);
    const ok = { poLineId: po.lineId, productId, qtyDeliveredBase: 2 };
    expect(
      code(
        (
          await receive(
            { purchaseOrderId: po.id, supplier: inactiveSupplierId, lines: [ok] },
            at('09:00:00'),
          )
        ).result,
      ),
    ).toBe('SUPPLIER_MISMATCH');
    expect(
      code(
        (
          await receive(
            { purchaseOrderId: po.id, lines: [{ ...ok, poLineId: approvedOnly.lineId }] },
            at('09:00:00'),
          )
        ).result,
      ),
    ).toBe('PO_LINE_MISMATCH');
    expect(
      code(
        (
          await receive(
            { purchaseOrderId: po.id, lines: [{ ...ok, poLineId: undefined }] },
            at('09:00:00'),
          )
        ).result,
      ),
    ).toBe('PO_LINE_MISMATCH');
    // Magasinier du site : l'emplacement d'un autre site est hors de sa portée (SITE).
    expect(
      code(
        (
          await receive(
            { purchaseOrderId: po.id, locationId: otherStoreId, lines: [ok] },
            at('09:00:00'),
          )
        ).result,
      ),
    ).toBe('FORBIDDEN_SCOPE');
    // Magasinier de l'autre site : autorisé chez lui, mais le BC est livré ailleurs.
    expect(
      code(
        (
          await receive(
            { purchaseOrderId: po.id, locationId: otherStoreId, lines: [ok] },
            at('09:00:00'),
            {
              actor: otherStorekeeper,
            },
          )
        ).result,
      ),
    ).toBe('RECEIPT_LOCATION_INVALID');
    expect(await stockAt(storeId, productId)).toBe(0);
  });

  it('AT-024 : même bon de livraison deux fois → quarantaine sans effet stock ; rejet, puis réception distincte confirmée', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, 30, 1_000);
    const note = `BL-${freshUuid().slice(-8)}`;
    const line = { poLineId: po.lineId, productId, qtyDeliveredBase: 10 };

    const first = await receive({ purchaseOrderId: po.id, note, lines: [line] }, at('09:00:00'));
    expect(code(first.result)).toBe('APPLIED');
    expect(await stockAt(storeId, productId)).toBe(10);

    const duplicate = await receive(
      { purchaseOrderId: po.id, note, lines: [line] },
      at('09:30:00'),
    );
    expect(duplicate.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['RECEIPT_QUARANTINED'],
    });
    expect((await receiptRow(duplicate.id))!.status).toBe('QUARANTINED');
    // INV-APP-03 : aucun effet stock ni reliquat tant que la quarantaine n'est pas tranchée.
    expect(await stockAt(storeId, productId)).toBe(10);
    expect(await movesOf(duplicate.id)).toHaveLength(0);
    expect(Number((await orderLines(po.id))[0]!.accepted_qty_base)).toBe(10);
    const quarantine = await approvalOf(duplicate.id);
    expect(quarantine.row).toMatchObject({
      operation_type: 'RECEIPT_QUARANTINE',
      subject_type: 'GOODS_RECEIPT',
      status: 'PENDING',
    });

    expect(code(await reject(buyer, quarantine.id, at('10:00:00')))).toBe('APPLIED');
    expect((await receiptRow(duplicate.id))!.status).toBe('REJECTED');
    expect(await stockAt(storeId, productId)).toBe(10);

    // Une vraie seconde livraison sous le même numéro : confirmée distincte, elle est comptabilisée.
    const distinct = await receive({ purchaseOrderId: po.id, note, lines: [line] }, at('11:00:00'));
    expect(code(distinct.result)).toBe('APPLIED_WITH_WARNINGS');
    const second = await approvalOf(distinct.id);
    expect(code(await approve(buyer, second.id, at('11:30:00')))).toBe('APPLIED');
    const confirmed = await receiptRow(distinct.id);
    expect(confirmed).toMatchObject({
      status: 'POSTED',
      distinct_note_confirmed: 1,
      posted_note_key: null,
    });
    expect((await receiptRow(first.id))!.posted_note_key).not.toBeNull();
    expect(await stockAt(storeId, productId)).toBe(20);
    const [move] = await movesOf(distinct.id);
    expect(move!.occurred_at.toISOString()).toBe(at('11:00:00')); // heure physique de la réception
    expect(Number((await orderLines(po.id))[0]!.accepted_qty_base)).toBe(20);
    expect((await orderRow(po.id)).status).toBe('PARTIALLY_RECEIVED');
  });

  it('AV-095 (défaut QUARANTINE) : hors ligne, dépassement du reliquat → quarantaine, puis excédent tracé à la validation', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, 10, 1_000);
    const offline = await receive(
      { purchaseOrderId: po.id, lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 12 }] },
      at('09:00:00'),
      { offline: true },
    );
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['RECEIPT_QUARANTINED'],
    });
    expect((await receiptRow(offline.id))!.status).toBe('QUARANTINED');
    expect(Number((await receiptLines(offline.id))[0]!.over_receipt_qty_base)).toBe(2);
    expect(await stockAt(storeId, productId)).toBe(0);
    expect((await approvalOf(offline.id)).row.subject_summary).toContain('OVER_RECEIPT');

    expect(code(await approve(buyer, (await approvalOf(offline.id)).id, at('10:00:00')))).toBe(
      'APPLIED',
    );
    expect(await stockAt(storeId, productId)).toBe(12);
    const [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(12);
    expect(Number(poLine!.excess_qty_base)).toBe(2); // INV-APP-02
    expect(poLine!.status).toBe('RECEIVED');
    expect((await orderRow(po.id)).status).toBe('RECEIVED');
  });

  it('AV-095 (mode APPLY_WITH_REVIEW) : hors ligne, appliquée avec excédent tracé et conflit OVER_RECEIPT en revue', async () => {
    // Versions datées de 2022 : sans effet sur les autres tests (heures métier ≥ 2026).
    for (const [validFrom, value] of [
      ['2022-06-01T00:00:00.000Z', 'APPLY_WITH_REVIEW'],
      ['2022-06-02T00:00:00.000Z', 'QUARANTINE'],
    ] as const) {
      await db
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'procurement.offline_over_receipt_mode',
          value: JSON.stringify(value),
          scope_type: 'GLOBAL',
          valid_from: new Date(validFrom),
          is_client_visible: 1,
          reason: 'Test AV-095',
          created_by: toBin(admin.userId),
        })
        .execute();
    }
    const productId = await newProduct();
    const po = await sentOrder(productId, 10, 1_000);
    const offline = await receive(
      { purchaseOrderId: po.id, lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 12 }] },
      '2022-06-01T10:00:00.000Z',
      { offline: true },
    );
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['OVER_RECEIPT'],
    });
    expect((await receiptRow(offline.id))!.status).toBe('POSTED');
    expect(Number((await receiptLines(offline.id))[0]!.over_receipt_qty_base)).toBe(2);
    expect(await stockAt(storeId, productId)).toBe(12);
    const [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(12);
    expect(Number(poLine!.excess_qty_base)).toBe(2);
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .selectAll()
      .where('entity_type', '=', 'GOODS_RECEIPT')
      .where('entity_id', '=', toBin(offline.id))
      .executeTakeFirstOrThrow();
    expect(conflict).toMatchObject({
      conflict_type: 'OVER_RECEIPT',
      status: 'OPEN',
      applied: 1,
      owner_role: 'RESP_ACHATS',
    });
  });

  it('BR-APP-011 : réception sans BC — prix et photo exigés, stock immédiat, CMUP recalculé, revue du responsable des achats', async () => {
    const productId = await newProduct();
    const photo = freshUuid();
    const line = { productId, qtyDeliveredBase: 100, unitCostXaf: 15_000 };
    expect(
      code(
        (
          await receive({ lines: [{ productId, qtyDeliveredBase: 100 }] }, at('09:00:00'), {
            attachmentIds: [photo],
          })
        ).result,
      ),
    ).toBe('PRICE_REQUIRED');
    expect(
      code(
        (
          await receive(
            { lines: [{ ...line, qtyDeliveredBase: 1, unitCostXaf: 10 }] },
            at('09:00:00'),
          )
        ).result,
      ),
    ).toBe('PHOTO_REQUIRED');
    expect(
      code(
        (
          await receive({ supplier: inactiveSupplierId, lines: [line] }, at('09:00:00'), {
            attachmentIds: [photo],
          })
        ).result,
      ),
    ).toBe('SUPPLIER_INACTIVE');

    const first = await receive({ lines: [line] }, at('09:00:00'), { attachmentIds: [photo] });
    expect(code(first.result)).toBe('APPLIED');
    expect((await receiptRow(first.id))!.status).toBe('POSTED_PENDING_REVIEW');
    expect(await stockAt(storeId, productId)).toBe(100); // le stock entre sans attendre la revue
    expect(await cmup(productId)).toBe(15_000);
    const review = await approvalOf(first.id);
    expect(review.row).toMatchObject({
      operation_type: 'RECEIPT_WITHOUT_PO',
      amount_xaf: 1_500_000,
    });
    expect(review.row.required_attachment_ids).toEqual([photo]);

    // BR-ADM-020 : la photo doit être reçue avant la décision.
    expect(code(await approve(buyer, review.id, at('10:00:00')))).toBe('ATTACHMENT_MISSING');
    await db
      .insertInto('attachments_attachments')
      .values({
        id: toBin(photo),
        owner_type: 'GOODS_RECEIPT',
        owner_id: toBin(first.id),
        kind: 'DELIVERY_NOTE',
        mime_type: 'image/jpeg',
        size_bytes: 1_000,
        uploaded_bytes: 1_000,
        sha256: 'a'.repeat(64),
        storage_key: `test/${photo}`,
        upload_status: 'AVAILABLE',
        captured_at: new Date(at('09:00:00')),
        occurred_at: new Date(at('09:00:00')),
        created_by: toBin(storekeeper.userId),
      })
      .execute();
    expect(code(await approve(buyer, review.id, at('10:05:00')))).toBe('APPLIED');
    expect((await receiptRow(first.id))!.status).toBe('POSTED');

    // Seconde entrée à 18 000 : CMUP = (100 × 15 000 + 50 × 18 000) / 150 = 16 000 (BR-STK-053).
    const second = await receive(
      { lines: [{ productId, qtyDeliveredBase: 50, unitCostXaf: 18_000 }] },
      at('11:00:00'),
      {
        attachmentIds: [freshUuid()],
      },
    );
    expect(code(second.result)).toBe('APPLIED');
    expect(await cmup(productId)).toBe(16_000);
    expect(code(await reject(buyer, (await approvalOf(second.id)).id, at('11:30:00')))).toBe(
      'APPLIED',
    );
    expect((await receiptRow(second.id))!.status).toBe('REVIEW_REJECTED');
    expect(await stockAt(storeId, productId)).toBe(150); // fait physique : le stock reste
  });

  it('lot fournisseur : produit suivi par lot → lot F:{réf} créé puis réutilisé, lot interne à défaut de référence', async () => {
    const productId = await newProduct('REQUIRED');
    const po = await sentOrder(productId, 30, 1_000);
    const ref = `L-${freshUuid().slice(-8)}`;
    const first = await receive(
      {
        purchaseOrderId: po.id,
        lines: [
          {
            poLineId: po.lineId,
            productId,
            qtyDeliveredBase: 8,
            supplierLotRef: ref,
            expiryDate: '2027-01-31',
          },
        ],
      },
      at('09:00:00'),
    );
    expect(code(first.result)).toBe('APPLIED');
    const [line] = await receiptLines(first.id);
    const lot = await db
      .selectFrom('inventory_stock_lots')
      .selectAll()
      .where('id', '=', line!.stock_lot_id!)
      .executeTakeFirstOrThrow();
    expect(lot).toMatchObject({
      lot_code: `F:${ref}`,
      origin_type: 'SUPPLIER_LOT',
      supplier_lot_ref: ref,
    });
    expect(fromBin(lot.supplier_id!)).toBe(supplierId);
    expect(lot.expiry_date!.getFullYear()).toBe(2027);
    expect(lot.expiry_date!.getMonth()).toBe(0);
    expect(lot.expiry_date!.getDate()).toBe(31);
    expect((await movesOf(first.id))[0]!.lot_id).toEqual(line!.stock_lot_id);

    const again = await receive(
      {
        purchaseOrderId: po.id,
        lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 5, supplierLotRef: ref }],
      },
      at('10:00:00'),
    );
    expect(code(again.result)).toBe('APPLIED');
    expect((await receiptLines(again.id))[0]!.stock_lot_id).toEqual(line!.stock_lot_id);

    const anonymous = await receive(
      { purchaseOrderId: po.id, lines: [{ poLineId: po.lineId, productId, qtyDeliveredBase: 2 }] },
      at('11:00:00'),
    );
    expect(code(anonymous.result)).toBe('APPLIED');
    const internal = await db
      .selectFrom('inventory_stock_lots')
      .select(['lot_code', 'supplier_lot_ref'])
      .where('id', '=', (await receiptLines(anonymous.id))[0]!.stock_lot_id!)
      .executeTakeFirstOrThrow();
    expect(internal.supplier_lot_ref).toBeNull();
    expect(internal.lot_code).toMatch(/^F:REC-.+-1$/);
    expect(await stockAt(storeId, productId)).toBe(15);
  });

  it('BR-APP-013 : annulation validée → inverses au coût d’origine, reliquat rétabli ; refusée si le stock est consommé', async () => {
    const productId = await newProduct();
    const po = await sentOrder(productId, 20, 1_000);
    const line = { poLineId: po.lineId, productId, qtyDeliveredBase: 10 };
    const first = await receive({ purchaseOrderId: po.id, lines: [line] }, at('09:00:00'));
    expect(code(first.result)).toBe('APPLIED');
    const cancel = (receiptId: string, occurredAt: string) =>
      run(
        storekeeper,
        'procurement.receipt.request_cancellation',
        'GOODS_RECEIPT',
        receiptId,
        occurredAt,
        {
          reason: 'Réception saisie sur le mauvais BC',
        },
      );

    expect(code(await cancel(first.id, at('09:30:00')))).toBe('APPLIED');
    expect((await receiptRow(first.id))!.status).toBe('CANCELLATION_PENDING');
    const cancellation = await approvalOf(first.id);
    expect(cancellation.row.operation_type).toBe('RECEIPT_CANCELLATION');
    expect(code(await approve(buyer, cancellation.id, at('10:00:00')))).toBe('APPLIED');

    const cancelled = await receiptRow(first.id);
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancel_comment: 'Réception saisie sur le mauvais BC',
    });
    expect(fromBin(cancelled!.cancelled_by!)).toBe(storekeeper.userId);
    expect(fromBin(cancelled!.cancel_approval_request_id!)).toBe(cancellation.id);
    expect(cancelled!.cancelled_at!.toISOString()).toBe(at('10:00:00'));
    expect(await stockAt(storeId, productId)).toBe(0);
    const [entry, reversal] = await movesOf(first.id);
    expect(reversal).toMatchObject({ move_type: 'SUPPLIER_RETURN', unit_cost_xaf: 1_000 });
    expect(reversal!.reverses_move_id).toEqual(entry!.id);
    let [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(0);
    expect(poLine!.status).toBe('OPEN');
    expect((await orderRow(po.id)).status).toBe('SENT');
    expect(code(await cancel(first.id, at('10:30:00')))).toBe('RECEIPT_STATUS_INVALID');

    // Stock déjà en partie consommé : la décision est refusée, rien ne bouge.
    const second = await receive({ purchaseOrderId: po.id, lines: [line] }, at('11:00:00'));
    expect(code(await cancel(second.id, at('11:10:00')))).toBe('APPLIED');
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: 4,
          fromLocationId: storeId,
          toLocationId: await virtualLocationId(trx, 'V_LOSS'),
          moveType: 'LOSS',
          occurredAt: new Date(at('11:20:00')),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
    const refused = await approvalOf(second.id);
    expect(code(await approve(buyer, refused.id, at('11:30:00')))).toBe('STOCK_UNAVAILABLE');
    expect((await receiptRow(second.id))!.status).toBe('CANCELLATION_PENDING');
    expect((await approvalOf(second.id)).row.status).toBe('PENDING');
    expect(await stockAt(storeId, productId)).toBe(6);
    [poLine] = await orderLines(po.id);
    expect(Number(poLine!.accepted_qty_base)).toBe(10);

    expect(code(await reject(buyer, refused.id, at('11:40:00')))).toBe('APPLIED');
    expect((await receiptRow(second.id))!.status).toBe('POSTED');
  });
});
