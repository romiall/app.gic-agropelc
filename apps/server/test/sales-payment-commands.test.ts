/**
 * Encaissements clients hors vente (P4-08, D09 §7.1 BR-FIN-001 à 008, SM-CUSTOMER-PAYMENT, AV-056,
 * AV-135, AV-150) à travers le vrai pipeline : `sales.payment.record` (affectation automatique ou
 * explicite, crédit client, acompte plafonné, doublon de référence), décisions `PAYMENT_DUPLICATE` et
 * `PAYMENT_CANCELLATION`, `sales.payment.reallocate` et `sales.payment.refund` (Finance), rejeu.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import { verifyCashLedger } from '../src/modules/finance/application/public/index.js';
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

const NOW = '2026-10-11T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-11T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

interface Sellable {
  readonly id: string;
  readonly ruleId: string;
  readonly price: number;
  readonly unit: string;
}

interface RunOptions {
  readonly offline?: boolean;
  readonly commandId?: string;
  readonly baseVersion?: number | null;
  readonly deviceSeq?: number;
}

describe('sales.payment.* (P4-08)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let commercial: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let cashAccountId: string;
  let momoAccountId: string;
  let finance: Actor;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? (r.error?.code ?? r.status) : r.status);
  const refs = (r: Result): Record<string, string> =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS' ? (r.server_refs ?? {}) : {};
  const warningsOf = (r: Result) => (r.status === 'APPLIED_WITH_WARNINGS' ? r.warnings : []);

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
        command_id: options.commandId ?? freshUuid(),
        device_seq: options.deviceSeq ?? ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: options.baseVersion ?? null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
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

  // --- Fixtures ----------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function sellable(
    price: number,
    options: { readonly service?: boolean } = {},
  ): Promise<Sellable> {
    const unit = options.service ? 'FORFAIT' : 'PIECE';
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: options.service ? 'Frais de livraison' : 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: options.service ? 'SERVICE' : 'MARCHANDISE',
        base_unit_code: unit,
        pricing_mode: 'PER_UNIT',
        is_sellable: 1,
        created_by: toBin(admin.userId),
      })
      .execute();
    const ruleId = freshUuid();
    await db
      .insertInto('pricing_price_rules')
      .values({
        id: toBin(ruleId),
        code: `PR-${ruleId.slice(-12)}`,
        version: 1,
        product_id: toBin(id),
        unit_price_xaf: price,
        pricing_unit_code: unit,
        status: 'ACTIVE',
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
    return { id, ruleId, price, unit };
  }

  async function stock(productId: string, quantity: number, unitCost: number): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: storeId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date('2026-10-11T06:00:00.000Z'),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  async function newCustomer(options: { readonly credit?: boolean } = {}): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: 'PROSPECT',
        pipeline_step_id: toBin(stepId),
        display_name: 'Restaurant du port',
        phone_primary: `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        zone_id: toBin(zoneId),
        source_code: sourceCode,
        acquired_by_user_id: toBin(admin.userId),
        acquired_at: new Date('2026-01-01T00:00:00.000Z'),
        occurred_at: new Date('2026-01-01T00:00:00.000Z'),
        credit_allowed: options.credit ? 1 : 0,
        ...(options.credit ? { credit_limit_xaf: 1_000_000 } : {}),
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  const line = (product: Sellable, quantity: number) => ({
    productId: product.id,
    quantity,
    unitCode: product.unit,
    quantityBase: quantity,
    listUnitPriceXaf: product.price,
    priceRuleId: product.ruleId,
    unitPriceXaf: product.price,
  });

  // --- Commandes ----------------------------------------------------------------------------------

  const place = (
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly id?: string; readonly offline?: boolean; readonly actor?: Actor } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(
      options.actor ?? commercial,
      'sales.order.place',
      'SALES_ORDER',
      id,
      occurredAt,
      { fulfilmentLocationId: storeId, ...body },
      options.offline !== undefined ? { offline: options.offline } : {},
    ).then((result) => ({ id, result }));
  };

  /** Commande confirmée par le commercial ; la saisie doit réussir. */
  async function placed(
    body: Record<string, unknown>,
    occurredAt: string,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const placedOrder = await place(body, occurredAt);
    expect(placedOrder.result.status, JSON.stringify(placedOrder.result)).toMatch(/^APPLIED/);
    return placedOrder;
  }

  const confirmRemaining = (orderId: string, occurredAt: string) =>
    run(commercial, 'sales.order.confirm_remaining', 'SALES_ORDER', orderId, occurredAt, {});

  // --- Lectures ----------------------------------------------------------------------------------

  const orderRow = (id: string) =>
    db
      .selectFrom('sales_sales_orders')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const ordersSales = (orderId: string) =>
    db
      .selectFrom('sales_sales')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerOrderCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerDeliveryCommands(registry, idGenerator, sequences);
    registerPaymentCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const unit of ['PIECE', 'KG', 'FORFAIT']) {
      const exists = await db
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', unit)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_units')
          .values({ code: unit, name: unit, is_count: unit === 'KG' ? 0 : 1 })
          .execute();
      }
    }
    for (const channel of ['DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
      const exists = await db
        .selectFrom('catalog_sales_channels')
        .select('code')
        .where('code', '=', channel)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_sales_channels')
          .values({ code: channel, name: channel })
          .execute();
      }
    }
    const method = await db
      .selectFrom('finance_payment_methods')
      .select('code')
      .where('code', '=', 'ESPECES')
      .executeTakeFirst();
    if (!method) {
      await db
        .insertInto('finance_payment_methods')
        .values({
          code: 'ESPECES',
          label: 'Espèces',
          requires_reference: 0,
          default_account_type: 'CAISSE_UTILISATEUR',
        })
        .execute();
    }

    const sedentary = await roleId('COMMERCIAL_SEDENTAIRE');
    const financeRole = await roleId('FINANCE');
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      storeId = await insertTestLocation(trx, adminId, siteId, { locationType: 'STORE' });
      const actor = async (role: string) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, { scopeType: 'GLOBAL' });
        return { userId, deviceId };
      };
      commercial = await actor(sedentary);
      finance = await actor(financeRole);
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Divers',
          created_by: toBin(adminId),
        })
        .execute();
      stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(adminId),
        })
        .execute();
      sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(adminId),
        })
        .execute();
      cashAccountId = freshUuid();
      await trx
        .insertInto('finance_cash_accounts')
        .values({
          id: toBin(cashAccountId),
          code: `CPT-${cashAccountId.slice(-10)}`,
          name: 'Caisse du commercial',
          account_type: 'CAISSE_UTILISATEUR',
          holder_user_id: toBin(commercial.userId),
          responsible_user_id: toBin(adminId),
          created_by: toBin(adminId),
        })
        .execute();
      momoAccountId = freshUuid();
      await trx
        .insertInto('finance_cash_accounts')
        .values({
          id: toBin(momoAccountId),
          code: `MOMO-${momoAccountId.slice(-10)}`,
          name: 'Orange Money entreprise',
          account_type: 'MOBILE_MONEY',
          responsible_user_id: toBin(adminId),
          created_by: toBin(adminId),
        })
        .execute();
    });
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `SALE_CANCELLATION_${policyId.slice(-8)}`,
        operationType: 'SALE_CANCELLATION',
        requiresApproval: true,
        approverPermission: 'sales.sale_cancel.approve',
        approverScope: 'ALL',
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    for (const operationType of ['PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE']) {
      const id = freshUuid();
      const set = await run(admin, 'approvals.policy.set', 'CONTROL_POLICY', id, at('00:00:00'), {
        code: `${operationType}_${id.slice(-8)}`,
        operationType,
        requiresApproval: true,
        approverPermission: 'sales.payment.cancel',
        approverScope: 'ALL',
      });
      expect(set.status, JSON.stringify(set)).toBe('APPLIED');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // --- Encaissements -------------------------------------------------------------------------------

  const pay = (
    body: Record<string, unknown>,
    occurredAt: string,
    options: RunOptions & { readonly actor?: Actor; readonly id?: string } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(
      options.actor ?? commercial,
      'sales.payment.record',
      'CUSTOMER_PAYMENT',
      id,
      occurredAt,
      { methodCode: 'ESPECES', cashAccountId, ...body },
      options,
    ).then((result) => ({ id, result }));
  };
  const onPayment = (
    commandType: string,
    paymentId: string,
    occurredAt: string,
    body: Record<string, unknown>,
    actor: Actor = finance,
  ) => run(actor, commandType, 'CUSTOMER_PAYMENT', paymentId, occurredAt, body);
  const paymentRow = (id: string) =>
    db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const allocationsOfPayment = (id: string) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where('payment_id', '=', toBin(id))
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
  const approvalOfPayment = async (paymentId: string): Promise<string> => {
    const row = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(paymentId))
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  };
  const decide = (
    kind: 'approve' | 'reject',
    requestId: string,
    occurredAt: string,
    extra: Record<string, unknown> = {},
  ) =>
    run(
      finance,
      `approvals.request.${kind}`,
      'APPROVAL_REQUEST',
      requestId,
      occurredAt,
      kind === 'reject'
        ? { requestId, comment: 'Décision Finance', ...extra }
        : { requestId, ...extra },
    );

  /** Vente sur commande de `quantity` pièces à 1 000 XAF pour ce client, à crédit. */
  async function saleFor(customerId: string, quantity: number, occurredAt: string) {
    const product = await sellable(1000);
    await stock(product.id, quantity, 600);
    const { id } = await placed({ customerId, lines: [line(product, quantity)] }, occurredAt);
    const [sale] = await ordersSales(id);
    return { orderId: id, saleId: fromBin(sale!.id) };
  }

  // --- 1. Affectation automatique (BR-FIN-004) ----------------------------------------------------

  it('sans affectation : les ventes du client sont réglées de l’échéance la plus ancienne, le reste devient crédit', async () => {
    const customer = await newCustomer({ credit: true });
    const a = await saleFor(customer, 3, at('09:00:00'));
    const b = await saleFor(customer, 2, at('10:00:00'));

    const first = await pay({ customerId: customer, amountXaf: 4000 }, at('11:00:00'));
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    expect(refs(first.result)['docNumber']).toMatch(/^ENC-/);
    expect(await saleRow(a.saleId)).toMatchObject({
      amount_paid_xaf: 3000,
      payment_status: 'PAID',
    });
    expect(await saleRow(b.saleId)).toMatchObject({
      amount_paid_xaf: 1000,
      balance_due_xaf: 1000,
      payment_status: 'PARTIALLY_PAID',
    });
    expect(await paymentRow(first.id)).toMatchObject({ status: 'RECORDED', unallocated_xaf: 0 });
    expect((await allocationsOfPayment(first.id)).map((x) => x.amount_xaf)).toEqual([3000, 1000]);

    const second = await pay({ customerId: customer, amountXaf: 1500 }, at('12:00:00'));
    expect(second.result.status, JSON.stringify(second.result)).toBe('APPLIED');
    expect(await saleRow(b.saleId)).toMatchObject({ payment_status: 'PAID' });
    expect(await paymentRow(second.id)).toMatchObject({ unallocated_xaf: 500 });
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  // --- 2. Affectations explicites, acompte plafonné (AV-150) -------------------------------------

  it('affectations explicites à une vente et à une commande ; acompte plafonné au reste à vendre', async () => {
    const customer = await newCustomer({ credit: true });
    const sold = await saleFor(customer, 2, at('09:00:00'));
    const product = await sellable(1000);
    const { id: orderId } = await placed(
      { customerId: customer, lines: [line(product, 5)] },
      at('09:10:00'),
    );
    expect(await ordersSales(orderId)).toHaveLength(0);

    const mixed = await pay(
      {
        customerId: customer,
        amountXaf: 6000,
        allocations: [
          { saleId: sold.saleId, amountXaf: 2000 },
          { orderId, amountXaf: 4000 },
        ],
      },
      at('10:00:00'),
    );
    expect(mixed.result.status, JSON.stringify(mixed.result)).toBe('APPLIED');
    expect(await saleRow(sold.saleId)).toMatchObject({ payment_status: 'PAID' });
    expect((await orderRow(orderId)).advance_paid_xaf).toBe(4000);

    const over = await pay(
      { customerId: customer, amountXaf: 2000, allocations: [{ orderId, amountXaf: 2000 }] },
      at('10:05:00'),
    );
    expect(code(over.result)).toBe('ALLOCATION_EXCEEDS');

    // Hors ligne, l'argent reçu est un fait : la part au-delà du reste à vendre devient crédit.
    const offline = await pay(
      { customerId: customer, amountXaf: 2000, allocations: [{ orderId, amountXaf: 2000 }] },
      at('10:06:00'),
      { offline: true },
    );
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toEqual(['PAYMENT_UNALLOCATED']);
    expect((await orderRow(orderId)).advance_paid_xaf).toBe(5000);
    expect(await paymentRow(offline.id)).toMatchObject({ unallocated_xaf: 1000 });

    // L'acompte passe à la vente quand le reste est confirmé (BR-FIN-008).
    await stock(product.id, 5, 600);
    expect((await confirmRemaining(orderId, at('11:00:00'))).status).toBe('APPLIED');
    const [orderSale] = await ordersSales(orderId);
    expect(orderSale).toMatchObject({ total_xaf: 5000, amount_paid_xaf: 5000 });
    expect((await orderRow(orderId)).advance_paid_xaf).toBe(0);
  });

  it('validations : client requis, cible en double, d’un autre client, somme au-delà du montant — aucune écriture', async () => {
    const customer = await newCustomer({ credit: true });
    const other = await newCustomer({ credit: true });
    const sold = await saleFor(customer, 2, at('09:00:00'));
    const foreign = await saleFor(other, 1, at('09:01:00'));
    expect(code((await pay({ amountXaf: 1000 }, at('10:00:00'))).result)).toBe('CUSTOMER_REQUIRED');
    expect(
      code(
        (
          await pay(
            {
              customerId: customer,
              amountXaf: 2000,
              allocations: [
                { saleId: sold.saleId, amountXaf: 1000 },
                { saleId: sold.saleId, amountXaf: 1000 },
              ],
            },
            at('10:00:00'),
          )
        ).result,
      ),
    ).toBe('ALLOCATION_INVALID');
    expect(
      code(
        (
          await pay(
            {
              customerId: customer,
              amountXaf: 1000,
              allocations: [{ saleId: foreign.saleId, amountXaf: 1000 }],
            },
            at('10:00:00'),
          )
        ).result,
      ),
    ).toBe('ALLOCATION_TARGET_INVALID');
    expect(
      code(
        (
          await pay(
            {
              customerId: customer,
              amountXaf: 500,
              allocations: [{ saleId: sold.saleId, amountXaf: 1000 }],
            },
            at('10:00:00'),
          )
        ).result,
      ),
    ).toBe('ALLOCATION_EXCEEDS');
    expect(await saleRow(sold.saleId)).toMatchObject({ amount_paid_xaf: 0 });
  });

  // --- 3. Doublon de référence (BR-FIN-005, AV-056, AV-135) --------------------------------------

  it('référence déjà connue : mis de côté sans trésorerie ; la Finance corrige la référence et l’encaissement est affecté', async () => {
    const customer = await newCustomer({ credit: true });
    const s1 = await saleFor(customer, 1, at('09:00:00'));
    const s2 = await saleFor(customer, 2, at('09:05:00'));
    const reference = `OM ${freshUuid().slice(-8)}`;
    const momo = { methodCode: 'MOBILE_MONEY_ORANGE', cashAccountId: momoAccountId, reference };
    const original = await pay(
      {
        ...momo,
        customerId: customer,
        amountXaf: 1000,
        allocations: [{ saleId: s1.saleId, amountXaf: 1000 }],
      },
      at('10:00:00'),
    );
    expect(original.result.status, JSON.stringify(original.result)).toBe('APPLIED');

    const suspect = await pay(
      {
        ...momo,
        customerId: customer,
        amountXaf: 2000,
        allocations: [{ saleId: s2.saleId, amountXaf: 2000 }],
      },
      at('10:30:00'),
    );
    expect(suspect.result.status, JSON.stringify(suspect.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(suspect.result)).toContain('PAYMENT_SUSPECT_DUPLICATE');
    const row = await paymentRow(suspect.id);
    expect(row).toMatchObject({
      status: 'SUSPECT_DUPLICATE',
      cash_movement_id: null,
      unallocated_xaf: 0,
    });
    expect(fromBin(row.intended_sale_id!)).toBe(s2.saleId);
    expect(await allocationsOfPayment(suspect.id)).toHaveLength(0);
    expect(await saleRow(s2.saleId)).toMatchObject({ amount_paid_xaf: 0 });

    const requestId = await approvalOfPayment(suspect.id);
    expect(code(await decide('approve', requestId, at('11:00:00')))).toBe(
      'PAYMENT_REFERENCE_DUPLICATE',
    );
    const approved = await decide('approve', requestId, at('11:01:00'), {
      decisionData: { correctedReference: `${reference}9` },
    });
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const after = await paymentRow(suspect.id);
    expect(after.status).toBe('RECORDED');
    expect(after.cash_movement_id).not.toBeNull();
    expect(after.reference_normalized).toBe(`${reference}9`.replace(/\s/g, '').toUpperCase());
    expect(await saleRow(s2.saleId)).toMatchObject({ payment_status: 'PAID' });
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });

    // Un autre doublon, rejeté : aucun effet, statut terminal.
    const again = await pay(
      { ...momo, customerId: customer, amountXaf: 700, siteId },
      at('12:00:00'),
    );
    expect(again.result.status, JSON.stringify(again.result)).toBe('APPLIED_WITH_WARNINGS');
    const rejectedDecision = await decide(
      'reject',
      await approvalOfPayment(again.id),
      at('12:10:00'),
    );
    expect(rejectedDecision.status, JSON.stringify(rejectedDecision)).toBe('APPLIED');
    expect(await paymentRow(again.id)).toMatchObject({
      status: 'REJECTED',
      cash_movement_id: null,
    });
  });

  // --- 4. Annulation (BR-FIN-006) -----------------------------------------------------------------

  it('annulation validée : trésorerie inverse, affectations renversées, créance rouverte ; rejet : retour à RECORDED', async () => {
    const customer = await newCustomer({ credit: true });
    const sold = await saleFor(customer, 3, at('09:00:00'));
    const paid = await pay({ customerId: customer, amountXaf: 3000 }, at('10:00:00'));
    expect(paid.result.status).toBe('APPLIED');

    expect(
      code(
        await onPayment(
          'sales.payment.request_cancellation',
          paid.id,
          at('10:10:00'),
          {},
          commercial,
        ),
      ),
    ).toBe('REASON_REQUIRED');
    const requested = await onPayment(
      'sales.payment.request_cancellation',
      paid.id,
      at('10:10:00'),
      { comment: 'Saisi par erreur' },
      commercial,
    );
    expect(requested.status, JSON.stringify(requested)).toBe('APPLIED');
    expect(await paymentRow(paid.id)).toMatchObject({
      status: 'CANCELLATION_REQUESTED',
      cancel_comment: 'Saisi par erreur',
    });
    const approved = await decide('approve', await approvalOfPayment(paid.id), at('10:20:00'));
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    expect(await paymentRow(paid.id)).toMatchObject({ status: 'CANCELLED', unallocated_xaf: 0 });
    expect((await allocationsOfPayment(paid.id)).map((a) => [a.status, a.reversal_cause])).toEqual([
      ['REVERSED', 'PAYMENT_CANCELLED'],
    ]);
    expect(await saleRow(sold.saleId)).toMatchObject({
      amount_paid_xaf: 0,
      payment_status: 'UNPAID',
    });
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
    expect(
      code(
        await onPayment(
          'sales.payment.request_cancellation',
          paid.id,
          at('10:30:00'),
          { comment: 'Encore' },
          commercial,
        ),
      ),
    ).toBe('PAYMENT_ALREADY_CANCELLED');

    const kept = await pay({ customerId: customer, amountXaf: 1000 }, at('11:00:00'));
    await onPayment(
      'sales.payment.request_cancellation',
      kept.id,
      at('11:05:00'),
      { comment: 'Doute' },
      commercial,
    );
    expect((await decide('reject', await approvalOfPayment(kept.id), at('11:10:00'))).status).toBe(
      'APPLIED',
    );
    expect(await paymentRow(kept.id)).toMatchObject({
      status: 'RECORDED',
      cancel_comment: null,
      cancel_approval_request_id: null,
    });
    expect(await saleRow(sold.saleId)).toMatchObject({ amount_paid_xaf: 1000 });
  });

  // --- 5. Réaffectation et remboursement (Finance) -------------------------------------------------

  it('réaffectation : une part libérée d’une vente passe à une autre ; au-delà du crédit refusé ; réservé à la Finance', async () => {
    const customer = await newCustomer({ credit: true });
    const a = await saleFor(customer, 3, at('09:00:00'));
    const b = await saleFor(customer, 2, at('09:30:00'));
    const paid = await pay(
      {
        customerId: customer,
        amountXaf: 3000,
        allocations: [{ saleId: a.saleId, amountXaf: 3000 }],
      },
      at('10:00:00'),
    );
    const body = {
      release: [{ saleId: a.saleId, amountXaf: 2000 }],
      allocate: [{ saleId: b.saleId, amountXaf: 2000 }],
    };
    expect(
      (await onPayment('sales.payment.reallocate', paid.id, at('10:10:00'), body, commercial))
        .status,
    ).toBe('REJECTED');
    expect(
      code(
        await onPayment('sales.payment.reallocate', paid.id, at('10:15:00'), {
          allocate: [{ saleId: b.saleId, amountXaf: 500 }],
        }),
      ),
    ).toBe('ALLOCATION_EXCEEDS');
    const moved = await onPayment('sales.payment.reallocate', paid.id, at('10:20:00'), body);
    expect(moved.status, JSON.stringify(moved)).toBe('APPLIED');
    expect(await saleRow(a.saleId)).toMatchObject({ amount_paid_xaf: 1000 });
    expect(await saleRow(b.saleId)).toMatchObject({
      amount_paid_xaf: 2000,
      payment_status: 'PAID',
    });
    const allocations = await allocationsOfPayment(paid.id);
    expect(
      allocations
        .filter((x) => x.status === 'ACTIVE')
        .map((x) => x.amount_xaf)
        .sort(),
    ).toEqual([1000, 2000]);
    expect(allocations.find((x) => x.status === 'REVERSED')?.reversal_cause).toBe('REALLOCATED');
  });

  it('remboursement du crédit client : sortie de caisse, plafond du crédit, encaissement remboursé non annulable', async () => {
    const customer = await newCustomer({ credit: true });
    await saleFor(customer, 3, at('09:00:00'));
    const paid = await pay({ customerId: customer, amountXaf: 5000 }, at('10:00:00'));
    expect(await paymentRow(paid.id)).toMatchObject({ unallocated_xaf: 2000 });
    expect(
      code(await onPayment('sales.payment.refund', paid.id, at('10:10:00'), { amountXaf: 2500 })),
    ).toBe('REFUND_EXCEEDS_CREDIT');
    const refunded = await onPayment('sales.payment.refund', paid.id, at('10:20:00'), {
      amountXaf: 1500,
    });
    expect(refunded.status, JSON.stringify(refunded)).toBe('APPLIED');
    expect(await paymentRow(paid.id)).toMatchObject({ unallocated_xaf: 500, refunded_xaf: 1500 });
    const refundMoves = await db
      .selectFrom('finance_cash_movements')
      .selectAll()
      .where('source_doc_id', '=', toBin(paid.id))
      .where('movement_type', '=', 'REFUND')
      .execute();
    expect(refundMoves.map((m) => [m.direction, Number(m.amount_xaf)])).toEqual([['OUT', 1500]]);
    expect(
      code(
        await onPayment(
          'sales.payment.request_cancellation',
          paid.id,
          at('10:30:00'),
          { comment: 'Erreur' },
          commercial,
        ),
      ),
    ).toBe('PAYMENT_PARTIALLY_REFUNDED');
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  // --- 6. Rejeu ----------------------------------------------------------------------------------

  it('rejeu : même commande ou même identifiant d’encaissement → même numéro, un seul encaissement', async () => {
    const customer = await newCustomer({ credit: true });
    await saleFor(customer, 1, at('09:00:00'));
    const commandId = freshUuid();
    const id = freshUuid();
    const seq = ++deviceSeq;
    const first = await pay({ customerId: customer, amountXaf: 1000 }, at('10:00:00'), {
      commandId,
      id,
      deviceSeq: seq,
    });
    const replay = await pay({ customerId: customer, amountXaf: 1000 }, at('10:00:00'), {
      commandId,
      id,
      deviceSeq: seq,
    });
    const again = await pay({ customerId: customer, amountXaf: 1000 }, at('10:01:00'), { id });
    expect(refs(replay.result)['docNumber']).toBe(refs(first.result)['docNumber']);
    expect(refs(again.result)['docNumber']).toBe(refs(first.result)['docNumber']);
    expect(await allocationsOfPayment(id)).toHaveLength(1);
  });

  // --- 7. Revue adverse de P4-08 ------------------------------------------------------------------

  it('remboursé pendant la demande d’annulation (vente annulée en REFUND) : la validation est refusée, aucun double décaissement', async () => {
    const customer = await newCustomer({ credit: true });
    const sold = await saleFor(customer, 3, at('09:00:00'));
    const paid = await pay({ customerId: customer, amountXaf: 3000 }, at('09:01:00'));
    expect(
      (
        await onPayment(
          'sales.payment.request_cancellation',
          paid.id,
          at('09:02:00'),
          { comment: 'Doute' },
          commercial,
        )
      ).status,
    ).toBe('APPLIED');
    const cancelled = await run(
      commercial,
      'sales.sale.cancel',
      'SALE_CANCELLATION',
      freshUuid(),
      at('09:05:00'),
      { saleId: sold.saleId, comment: 'Erreur', paymentTreatment: 'REFUND' },
    );
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    expect(await paymentRow(paid.id)).toMatchObject({ refunded_xaf: 3000 });
    const decision = await decide('approve', await approvalOfPayment(paid.id), at('09:10:00'));
    expect(code(decision)).toBe('PAYMENT_PARTIALLY_REFUNDED');
    expect(await paymentRow(paid.id)).toMatchObject({ status: 'CANCELLATION_REQUESTED' });
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  it('acompte d’un encaissement dont l’annulation est demandée : la confirmation du reste passe, puis la validation renverse tout', async () => {
    const customer = await newCustomer({ credit: true });
    const product = await sellable(1000);
    const { id: orderId } = await placed(
      { customerId: customer, lines: [line(product, 2)] },
      at('09:00:00'),
    );
    const advance = await pay(
      { customerId: customer, amountXaf: 2000, allocations: [{ orderId, amountXaf: 2000 }] },
      at('09:01:00'),
    );
    await onPayment(
      'sales.payment.request_cancellation',
      advance.id,
      at('09:02:00'),
      { comment: 'Chèque refusé' },
      commercial,
    );
    await stock(product.id, 2, 600);
    const confirmed = await confirmRemaining(orderId, at('09:05:00'));
    expect(confirmed.status, JSON.stringify(confirmed)).toBe('APPLIED');
    const [sale] = await ordersSales(orderId);
    expect(sale).toMatchObject({ amount_paid_xaf: 2000 });
    expect(
      (await decide('approve', await approvalOfPayment(advance.id), at('09:10:00'))).status,
    ).toBe('APPLIED');
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({ amount_paid_xaf: 0 });
    expect(await paymentRow(advance.id)).toMatchObject({ status: 'CANCELLED' });
  });

  it('hors ligne, une cible devenue soldée : la part reste en crédit avec un avertissement et un conflit Finance', async () => {
    const customer = await newCustomer({ credit: true });
    const sold = await saleFor(customer, 1, at('09:00:00'));
    await pay({ customerId: customer, amountXaf: 1000 }, at('09:01:00'));
    const late = await pay(
      {
        customerId: customer,
        amountXaf: 1000,
        allocations: [{ saleId: sold.saleId, amountXaf: 1000 }],
      },
      at('08:30:00'),
      { offline: true },
    );
    expect(late.result.status, JSON.stringify(late.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(late.result)).toContain('PAYMENT_UNALLOCATED');
    expect(await paymentRow(late.id)).toMatchObject({ unallocated_xaf: 1000 });
    const conflicts = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'owner_role'])
      .where('entity_id', '=', toBin(late.id))
      .execute();
    expect(conflicts).toEqual([{ conflict_type: 'PAYMENT_UNALLOCATED', owner_role: 'FINANCE' }]);
  });

  it('doublon validé : les montants saisis sont rejoués ; référence trop longue refusée', async () => {
    const customer = await newCustomer({ credit: true });
    const s1 = await saleFor(customer, 2, at('09:00:00'));
    const reference = `MTN${freshUuid().slice(-8)}`;
    const momo = { methodCode: 'MOBILE_MONEY_ORANGE', cashAccountId: momoAccountId, reference };
    await pay({ ...momo, customerId: customer, amountXaf: 500, siteId }, at('09:01:00'));
    const suspect = await pay(
      {
        ...momo,
        customerId: customer,
        amountXaf: 2000,
        allocations: [{ saleId: s1.saleId, amountXaf: 1500 }],
      },
      at('09:02:00'),
    );
    expect(suspect.result.status).toBe('APPLIED_WITH_WARNINGS');
    const requestId = await approvalOfPayment(suspect.id);
    expect(
      code(
        await decide('approve', requestId, at('09:05:00'), {
          decisionData: { correctedReference: 'X'.repeat(81) },
        }),
      ),
    ).toBe('PAYMENT_REFERENCE_INVALID');
    const approved = await decide('approve', requestId, at('09:06:00'), {
      decisionData: { correctedReference: `${reference}B` },
    });
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    expect((await allocationsOfPayment(suspect.id)).map((a) => a.amount_xaf)).toEqual([1500]);
    expect(await paymentRow(suspect.id)).toMatchObject({
      status: 'RECORDED',
      unallocated_xaf: 500,
    });
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .select('status')
      .where('entity_id', '=', toBin(suspect.id))
      .executeTakeFirstOrThrow();
    expect(conflict.status).toBe('RESOLVED');
  });

  it('demande retirée : une nouvelle demande est possible ; commandes de la Finance en ligne seulement ; cible double refusée', async () => {
    const customer = await newCustomer({ credit: true });
    const a = await saleFor(customer, 2, at('09:00:00'));
    const paid = await pay({ customerId: customer, amountXaf: 3000 }, at('09:01:00'));
    await onPayment(
      'sales.payment.request_cancellation',
      paid.id,
      at('09:02:00'),
      { comment: 'Doute' },
      commercial,
    );
    const withdrawn = await run(
      commercial,
      'approvals.request.withdraw',
      'APPROVAL_REQUEST',
      await approvalOfPayment(paid.id),
      at('09:03:00'),
      { requestId: await approvalOfPayment(paid.id) },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn)).toBe('APPLIED');
    const again = await onPayment(
      'sales.payment.request_cancellation',
      paid.id,
      at('09:04:00'),
      { comment: 'Nouvelle demande' },
      commercial,
    );
    expect(again.status, JSON.stringify(again)).toBe('APPLIED');
    expect(
      code(
        await run(
          finance,
          'sales.payment.refund',
          'CUSTOMER_PAYMENT',
          paid.id,
          at('09:05:00'),
          { amountXaf: 100 },
          {
            offline: true,
          },
        ),
      ),
    ).toBe('ONLINE_REQUIRED');
    expect(
      code(
        await onPayment('sales.payment.reallocate', paid.id, at('09:06:00'), {
          allocate: [
            { saleId: a.saleId, amountXaf: 100 },
            { saleId: a.saleId, amountXaf: 100 },
          ],
        }),
      ),
    ).toBe('ALLOCATION_INVALID');
    expect(
      code(
        await onPayment('sales.payment.refund', paid.id, at('09:07:00'), {
          amountXaf: 100,
          cashAccountId,
        }),
      ),
    ).toBe('PAYMENT_STATUS_INVALID');
  });
});
