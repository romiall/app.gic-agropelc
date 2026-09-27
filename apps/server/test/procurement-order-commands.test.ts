/**
 * Bons de commande (P6-04, D08-APP, SM-PURCHASE-ORDER) à travers le vrai pipeline, avec les rôles
 * réels du seed (responsable des achats, Direction, magasinier demandeur) : création depuis une
 * DA approuvée (couverture, BR-APP-004) ou directe, brouillon modifiable, soumission avec seuil
 * d'approbation de la Direction (BR-APP-005, AV-051), envoi, annulation rétablissant la
 * couverture, refus (fournisseur inactif, emplacement, statut).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerRequestCommands } from '../src/modules/procurement/application/commands/request-commands.js';
import { registerOrderCommands } from '../src/modules/procurement/application/commands/order-commands.js';
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

describe('procurement.order.* (P6-04)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let storekeeper: Actor;
  let buyer: Actor;
  let director: Actor;
  let siteId: string;
  let storeId: string;
  let supplierId: string;
  let inactiveSupplierId: string;
  let productId: string;
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

  const order = (
    actor: Actor,
    id: string,
    type: string,
    occurredAt: string,
    payload: unknown = {},
  ) => run(actor, `procurement.order.${type}`, 'PURCHASE_ORDER', id, occurredAt, payload);

  async function createOrder(
    lines: readonly Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await order(buyer, id, 'create', at('09:00:00'), {
      supplierId,
      deliveryLocationId: storeId,
      expectedDeliveryDate: '2026-10-12',
      lines,
      ...overrides,
    });
    return { id, result };
  }

  async function orderRow(id: string) {
    return db
      .selectFrom('procurement_purchase_orders')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function lines(orderId: string) {
    return db
      .selectFrom('procurement_purchase_order_lines')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('line_no', 'asc')
      .execute();
  }

  /** DA soumise par le magasinier et approuvée par le responsable des achats. */
  async function approvedRequest(quantityBase: number): Promise<{ id: string; lineId: string }> {
    const id = freshUuid();
    const submitted = await run(
      storekeeper,
      'procurement.request.submit',
      'PURCHASE_REQUEST',
      id,
      at('07:00:00'),
      {
        siteId,
        justification: 'Aliment de la bande 12',
        lines: [{ productId, quantityBase, unitCode, quantity: quantityBase }],
      },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('APPLIED');
    const request = await db
      .selectFrom('procurement_purchase_requests')
      .select('approval_request_id')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    const approvalId = fromBin(request.approval_request_id!);
    const approved = await run(
      buyer,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      approvalId,
      at('07:30:00'),
      {
        requestId: approvalId,
      },
    );
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const line = await db
      .selectFrom('procurement_purchase_request_lines')
      .select('id')
      .where('request_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return { id, lineId: fromBin(line.id) };
  }

  async function requestState(requestId: string) {
    const request = await db
      .selectFrom('procurement_purchase_requests')
      .select('status')
      .where('id', '=', toBin(requestId))
      .executeTakeFirstOrThrow();
    const line = await db
      .selectFrom('procurement_purchase_request_lines')
      .select('ordered_qty_base')
      .where('request_id', '=', toBin(requestId))
      .executeTakeFirstOrThrow();
    return { status: request.status, ordered: Number(line.ordered_qty_base) };
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
    registerRequestCommands(registry, decisions, idGenerator, sequences);
    registerOrderCommands(registry, decisions, idGenerator, sequences);
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
    });

    for (const [operationType, approverPermission] of [
      ['PURCHASE_REQUEST', 'procurement.request.approve'],
      ['PURCHASE_ORDER', 'procurement.order.approve'],
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
      expect(policy.status).toBe('APPLIED');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('BR-APP-004 : BC depuis une DA approuvée — couverture partielle puis complète, reste à commander contrôlé', async () => {
    const request = await approvedRequest(100);
    const first = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 60,
        unitPriceXaf: 15_000,
        requestLineId: request.lineId,
      },
    ]);
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    const row = await orderRow(first.id);
    expect(row).toMatchObject({ status: 'DRAFT', total_xaf: 900_000 });
    expect(row.doc_number).toMatch(/^BC-.+-2026-\d{6}$/);
    expect(await requestState(request.id)).toEqual({ status: 'PARTIALLY_ORDERED', ordered: 60 });

    const tooMuch = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 50,
        unitPriceXaf: 15_000,
        requestLineId: request.lineId,
      },
    ]);
    expect(code(tooMuch.result)).toBe('REQUEST_QTY_EXCEEDED');
    const rest = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 40,
        unitPriceXaf: 15_000,
        requestLineId: request.lineId,
      },
    ]);
    expect(rest.result.status).toBe('APPLIED');
    expect(await requestState(request.id)).toEqual({ status: 'ORDERED', ordered: 100 });
    const again = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 1,
        unitPriceXaf: 15_000,
        requestLineId: request.lineId,
      },
    ]);
    expect(code(again.result)).toBe('REQUEST_NOT_ORDERABLE');
  });

  it('refus à la création : fournisseur inactif, emplacement inconnu, prix invalide', async () => {
    const line = { productId, unitCode, orderedQtyBase: 10, unitPriceXaf: 900 };
    expect(code((await createOrder([line], { supplierId: inactiveSupplierId })).result)).toBe(
      'SUPPLIER_INACTIVE',
    );
    expect(code((await createOrder([line], { deliveryLocationId: freshUuid() })).result)).toBe(
      'REFERENCE_INVALID',
    );
    expect(code((await createOrder([{ ...line, unitPriceXaf: 10.5 }])).result)).toMatch(
      /^VALIDATION_ERROR/,
    );
    expect(code((await createOrder([{ ...line, orderedQtyBase: 0.0001 }])).result)).toBe(
      'TOO_MANY_DECIMALS',
    );
  });

  it('BR-APP-005 / AV-051 : sous le seuil, approuvé d’office ; au-delà, validation de la Direction ; rejet → brouillon', async () => {
    const small = await createOrder([
      { productId, unitCode, orderedQtyBase: 20, unitPriceXaf: 15_000 },
    ]);
    expect(code(await order(buyer, small.id, 'submit', at('10:00:00')))).toBe('APPLIED');
    const smallRow = await orderRow(small.id);
    expect(smallRow.status).toBe('APPROVED');
    expect(smallRow.approved_at?.toISOString()).toBe(at('10:00:00'));
    expect(smallRow.approved_by).toBeNull(); // approbation d'office, sans approbateur

    const big = await createOrder([
      { productId, unitCode, orderedQtyBase: 100, unitPriceXaf: 15_000 },
    ]);
    expect(code(await order(buyer, big.id, 'submit', at('10:05:00')))).toBe('APPLIED');
    let bigRow = await orderRow(big.id);
    expect(bigRow.status).toBe('PENDING_APPROVAL');
    const approvalId = fromBin(bigRow.approval_request_id!);
    const byBuyer = await run(
      buyer,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      approvalId,
      at('10:30:00'),
      {
        requestId: approvalId,
      },
    );
    expect(code(byBuyer)).toBe('APPROVER_NOT_ALLOWED');
    const rejection = await run(
      director,
      'approvals.request.reject',
      'APPROVAL_REQUEST',
      approvalId,
      at('11:00:00'),
      {
        requestId: approvalId,
        comment: 'Négocier le prix avant envoi.',
      },
    );
    expect(code(rejection)).toBe('APPLIED');
    expect((await orderRow(big.id)).status).toBe('DRAFT');

    // Correction du brouillon puis nouvelle soumission, approuvée par la Direction.
    expect(
      code(
        await order(buyer, big.id, 'update', at('11:10:00'), {
          lines: [{ lineNo: 1, unitPriceXaf: 14_000 }],
        }),
      ),
    ).toBe('APPLIED');
    expect((await orderRow(big.id)).total_xaf).toBe(1_400_000);
    expect(code(await order(buyer, big.id, 'submit', at('11:20:00')))).toBe('APPLIED');
    bigRow = await orderRow(big.id);
    const second = fromBin(bigRow.approval_request_id!);
    expect(second).not.toBe(approvalId);
    expect(
      code(
        await run(
          director,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          second,
          at('11:30:00'),
          { requestId: second },
        ),
      ),
    ).toBe('APPLIED');
    bigRow = await orderRow(big.id);
    expect(bigRow.status).toBe('APPROVED');
    expect(fromBin(bigRow.approved_by!)).toBe(director.userId);
    expect(
      code(
        await order(buyer, big.id, 'update', at('11:40:00'), {
          lines: [{ lineNo: 1, orderedQtyBase: 90 }],
        }),
      ),
    ).toBe('ORDER_STATUS_INVALID');
  });

  it('brouillon : quantité et prix modifiés, ligne ajoutée, ligne annulée — total et couverture suivent', async () => {
    const request = await approvedRequest(50);
    const draft = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 30,
        unitPriceXaf: 1_000,
        requestLineId: request.lineId,
      },
      { productId, unitCode, orderedQtyBase: 5, unitPriceXaf: 2_000 },
    ]);
    const updated = await order(buyer, draft.id, 'update', at('12:00:00'), {
      expectedDeliveryDate: '2026-10-20',
      lines: [
        { lineNo: 1, orderedQtyBase: 20, unitPriceXaf: 1_100 },
        { lineNo: 2, cancel: true },
      ],
      addLines: [{ productId, unitCode, orderedQtyBase: 2.5, unitPriceXaf: 333 }],
    });
    expect(updated.status, JSON.stringify(updated)).toBe('APPLIED');
    const orderLines = await lines(draft.id);
    expect(orderLines.map((l) => [l.line_no, Number(l.ordered_qty_base), l.status])).toEqual([
      [1, 20, 'OPEN'],
      [2, 5, 'CANCELLED'],
      [3, 2.5, 'OPEN'],
    ]);
    expect((await orderRow(draft.id)).total_xaf).toBe(22_000 + 833);
    expect(await requestState(request.id)).toEqual({ status: 'PARTIALLY_ORDERED', ordered: 20 });
  });

  it('envoi, puis annulation sans réception : couverture de la DA rétablie ; clôture réservée au partiellement reçu', async () => {
    const request = await approvedRequest(10);
    const sent = await createOrder([
      {
        productId,
        unitCode,
        orderedQtyBase: 10,
        unitPriceXaf: 1_000,
        requestLineId: request.lineId,
      },
    ]);
    expect(code(await order(buyer, sent.id, 'mark_sent', at('13:00:00')))).toBe(
      'ORDER_STATUS_INVALID',
    );
    await order(buyer, sent.id, 'submit', at('13:00:00'));
    expect(code(await order(buyer, sent.id, 'mark_sent', at('13:05:00')))).toBe('APPLIED');
    const sentRow = await orderRow(sent.id);
    expect(sentRow.status).toBe('SENT');
    expect(sentRow.sent_at?.toISOString()).toBe(at('13:05:00'));
    expect(
      code(await order(buyer, sent.id, 'close_remaining', at('13:10:00'), { reason: 'Fin' })),
    ).toBe('ORDER_STATUS_INVALID');
    expect(await requestState(request.id)).toEqual({ status: 'ORDERED', ordered: 10 });
    expect(code(await order(buyer, sent.id, 'cancel', at('13:20:00'), {}))).toMatch(
      /^VALIDATION_ERROR/,
    );
    expect(
      code(
        await order(buyer, sent.id, 'cancel', at('13:20:00'), {
          comment: 'Fournisseur en rupture',
        }),
      ),
    ).toBe('APPLIED');
    const cancelled = await orderRow(sent.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancel_comment).toBe('Fournisseur en rupture');
    expect((await lines(sent.id)).every((l) => l.status === 'CANCELLED')).toBe(true);
    expect(await requestState(request.id)).toEqual({ status: 'APPROVED', ordered: 0 });
  });
});
