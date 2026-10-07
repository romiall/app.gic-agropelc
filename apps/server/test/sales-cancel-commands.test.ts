/**
 * Annulation d'une vente directe (P4-05, D04 BR-VEN-027 et BR-VEN-028, ADR-028 §5, ADR-029, SM-SALE)
 * à travers le vrai pipeline : annulation directe dans le délai, transformation en demande hors
 * délai, décision (application ou rejet), contre-écriture de stock, chiffre d'affaires, libération
 * des paiements (remboursement ou crédit client), conversion du prospect annulée, idempotence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import {
  createStockLot,
  recordStockMove,
  verifyStockLedger,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  cashAccountBalance,
  verifyCashLedger,
} from '../src/modules/finance/application/public/index.js';
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

const NOW = '2026-10-07T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-07T${hhmmss}.000Z`;
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

describe('sales.sale.cancel / request_cancellation (P4-05)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let seller: Actor;
  let otherSeller: Actor;
  let finance: Actor;
  let zoneId: string;
  let pdvSiteId: string;
  let posId: string;
  let categoryId: string;
  let pdvCashId: string;
  let stepId: string;
  let sourceCode: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);
  const warningsOf = (r: Result) => (r.status === 'APPLIED_WITH_WARNINGS' ? r.warnings : []);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly commandId?: string } = {},
  ): Promise<Result> {
    return pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
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

  // --- Fixtures ---------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function ensureRef(table: 'catalog_units' | 'catalog_sales_channels', key: string) {
    const exists = await db
      .selectFrom(table)
      .select('code')
      .where('code', '=', key)
      .executeTakeFirst();
    if (exists) return;
    if (table === 'catalog_units') {
      await db.insertInto('catalog_units').values({ code: key, name: key, is_count: 1 }).execute();
    } else {
      await db.insertInto('catalog_sales_channels').values({ code: key, name: key }).execute();
    }
  }

  async function sellable(
    price: number,
    options: { readonly family?: 'MARCHANDISE' | 'SERVICE'; readonly baseUnit?: string } = {},
  ): Promise<Sellable> {
    const id = freshUuid();
    const unit = options.baseUnit ?? 'PIECE';
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: 'Produit de test',
        category_id: toBin(categoryId),
        stock_family: options.family ?? 'MARCHANDISE',
        base_unit_code: unit,
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

  async function stock(productId: string, quantity: number, unitCost: number, lotId?: string) {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          ...(lotId !== undefined ? { lotId } : {}),
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: posId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date('2026-10-07T06:00:00.000Z'),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  async function newLot(productId: string, rank: string) {
    const originId = freshUuid();
    return db.transaction().execute((trx) =>
      createStockLot(
        trx,
        { idGenerator },
        {
          originType: 'COLLECTION',
          originId,
          lotCode: `T-${originId.slice(-12)}`,
          productId,
          fifoRankAt: new Date(`2026-10-07T${rank}.000Z`),
          expiryDate: null,
          createdBy: admin.userId,
        },
      ),
    );
  }

  async function newCustomer(options: { readonly credit?: boolean } = {}): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: 'PROSPECT',
        pipeline_step_id: toBin(stepId),
        display_name: 'Boutique de test',
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

  async function sell(
    body: Record<string, unknown>,
    occurredAt: string,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(seller, 'sales.sale.record', 'SALE', id, occurredAt, {
      fromLocationId: posId,
      ...body,
    });
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return { id, result };
  }

  async function cancel(
    saleId: string,
    occurredAt: string,
    body: Record<string, unknown> = {},
    actor: Actor = seller,
    commandType = 'sales.sale.cancel',
    options: { readonly commandId?: string; readonly id?: string } = {},
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = options.id ?? freshUuid();
    const result = await run(
      actor,
      commandType,
      'SALE_CANCELLATION',
      id,
      occurredAt,
      { saleId, ...body },
      options.commandId !== undefined ? { commandId: options.commandId } : {},
    );
    return { id, result };
  }

  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
  const saleLines = (id: string) =>
    db
      .selectFrom('sales_sale_lines')
      .selectAll()
      .where('sale_id', '=', toBin(id))
      .orderBy('line_no')
      .execute();
  const cancellationRow = (id: string) =>
    db
      .selectFrom('sales_sale_cancellations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const payments = (saleId: string) =>
    db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where(
        'id',
        'in',
        db
          .selectFrom('sales_payment_allocations')
          .select('payment_id')
          .where('sale_id', '=', toBin(saleId)),
      )
      .execute();
  const allocations = (saleId: string) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where('sale_id', '=', toBin(saleId))
      .orderBy('allocated_at')
      .orderBy('id')
      .execute();
  const returnMoves = (cancellationId: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('source_doc_type', '=', 'SALE_CANCELLATION')
      .where('source_doc_id', '=', toBin(cancellationId))
      .execute();
  const onHand = async (productId: string): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`COALESCE(SUM(qty_on_hand), 0)`.as('qty'))
      .where('location_id', '=', toBin(posId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.qty);
  };

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerSaleCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const unit of ['PIECE', 'FORFAIT']) await ensureRef('catalog_units', unit);
    await ensureRef('catalog_sales_channels', 'POINT_DE_VENTE');
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

    const roles = {
      seller: await roleId('VENDEUR_PDV'),
      finance: await roleId('FINANCE'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      zoneId = await insertTestZone(trx, adminId);
      pdvSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'POINT_DE_VENTE' });
      posId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'POS' });
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      seller = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: pdvSiteId });
      otherSeller = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: pdvSiteId });
      finance = await actor(roles.finance, { scopeType: 'GLOBAL' });
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
          label: 'Terrain',
          created_by: toBin(adminId),
        })
        .execute();
      pdvCashId = freshUuid();
      await trx
        .insertInto('finance_cash_accounts')
        .values({
          id: toBin(pdvCashId),
          code: `CPT-${pdvCashId.slice(-10)}`,
          name: 'Caisse de test',
          account_type: 'CAISSE_PDV',
          site_id: toBin(pdvSiteId),
          responsible_user_id: toBin(adminId),
          created_by: toBin(adminId),
        })
        .execute();
    });

    for (const [operationType, approverPermission] of [
      ['SALE_CANCELLATION', 'sales.sale_cancel.approve'],
      ['PRICE_OVERRIDE', 'sales.price_override.approve'],
      ['CREDIT_LIMIT_EXCEEDED', 'sales.credit_limit_exceed.approve'],
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

  // --- Annulation directe -------------------------------------------------------------------------------

  it('annulation directe dans le délai : stock rendu, CA annulé, argent remboursé (vente anonyme)', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 600);
    const cashBefore = (await cashAccountBalance(db, pdvCashId)) ?? 0;
    const { id: saleId } = await sell(
      { lines: [line(product, 3)], payments: [{ methodCode: 'ESPECES', amountXaf: 3000 }] },
      at('09:00:00'),
    );
    expect(await onHand(product.id)).toBe(7);
    expect(await cashAccountBalance(db, pdvCashId)).toBe(cashBefore + 3000);

    const { id, result } = await cancel(saleId, at('09:10:00'));
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const doc = await cancellationRow(id);
    expect(doc).toMatchObject({
      status: 'APPLIED',
      cause: 'SALE_CANCELLATION',
      cancelled_total_xaf: 3000,
      released_payment_treatment: 'REFUND',
    });
    expect(doc.doc_number).toMatch(/^ANV-/);
    expect(doc.applied_at?.toISOString()).toBe(at('09:10:00'));

    // Vente : immuable sauf compteurs ; annulée, plus rien de payé.
    const sale = await saleRow(saleId);
    expect(sale).toMatchObject({
      status: 'CANCELLED',
      cancelled_xaf: 3000,
      amount_paid_xaf: 0,
      net_total_xaf: 0,
      payment_status: 'PAID',
    });
    const [saleLine] = await saleLines(saleId);
    expect(saleLine).toMatchObject({ cancelled_xaf: 3000 });
    expect(Number(saleLine!.cancelled_quantity_base)).toBe(3);

    // Stock : retour rattaché à la vente, à la valeur d'origine ; le solde est revenu.
    const returns = await returnMoves(id);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ move_type: 'CUSTOMER_RETURN' });
    expect(Number(returns[0]!.value_xaf)).toBe(1800);
    expect(await onHand(product.id)).toBe(10);

    // Argent : affectation renversée, remboursement en caisse, encaissement conservé en historique.
    const [alloc] = await allocations(saleId);
    expect(alloc).toMatchObject({ status: 'REVERSED', reversal_cause: 'SALE_CANCELLED' });
    const [payment] = await payments(saleId);
    expect(payment).toMatchObject({ status: 'RECORDED', refunded_xaf: 3000, unallocated_xaf: 0 });
    expect(await cashAccountBalance(db, pdvCashId)).toBe(cashBefore);
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  it('vente à un client : le sort de la part payée est exigé, crédit client ou remboursement', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 400);
    const customer = await newCustomer({ credit: true });
    const { id: saleId } = await sell(
      {
        customerId: customer,
        lines: [line(product, 2)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1500 }],
      },
      at('09:20:00'),
    );
    // 500 restent dus (crédit) ; annuler libère les 1 500 payés.
    const missing = await cancel(saleId, at('09:25:00'));
    expect(code(missing.result)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect((await saleRow(saleId)).status).toBe('CONFIRMED');
    expect(await onHand(product.id)).toBe(8);

    const credited = await cancel(saleId, at('09:26:00'), { paymentTreatment: 'CUSTOMER_CREDIT' });
    expect(credited.result.status, JSON.stringify(credited.result)).toBe('APPLIED');
    const [payment] = await payments(saleId);
    // Crédit client : l'argent reste dans la caisse, disponible pour une autre vente.
    expect(payment).toMatchObject({ refunded_xaf: 0, unallocated_xaf: 1500 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CANCELLED',
      amount_paid_xaf: 0,
      balance_due_xaf: 0,
    });
    expect((await cancellationRow(credited.id)).released_payment_treatment).toBe('CUSTOMER_CREDIT');
    // Le prospect converti par cette vente voit sa conversion signalée annulée.
    const customerRow = await db
      .selectFrom('crm_customers')
      .select(['stage', 'conversion_reverted'])
      .where('id', '=', toBin(customer))
      .executeTakeFirstOrThrow();
    expect(customerRow).toMatchObject({ stage: 'CUSTOMER', conversion_reverted: 1 });
  });

  it('une ligne de service ne rend aucun stock ; plusieurs lots sont rendus en entier', async () => {
    const goods = await sellable(1000);
    const service = await sellable(500, { family: 'SERVICE', baseUnit: 'FORFAIT' });
    const first = await newLot(goods.id, '05:00:00');
    const second = await newLot(goods.id, '05:30:00');
    await db
      .updateTable('catalog_products')
      .set({ lot_tracking: 'REQUIRED' })
      .where('id', '=', toBin(goods.id))
      .execute();
    await stock(goods.id, 3, 100, first);
    await stock(goods.id, 5, 100, second);
    const { id: saleId } = await sell(
      {
        lines: [line(goods, 6), line(service, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 6500 }],
      },
      at('09:30:00'),
    );
    expect(await onHand(goods.id)).toBe(2);
    const { id, result } = await cancel(saleId, at('09:32:00'));
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const returns = await returnMoves(id);
    // 6 têtes vendues en 3 + 3 : deux retours, un par lot d'origine, valeur d'origine exacte.
    expect(returns.reduce((sum, move) => sum + Number(move.quantity), 0)).toBe(6);
    expect(returns.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(600);
    expect(await onHand(goods.id)).toBe(8);
    const lines = await saleLines(saleId);
    expect(lines.map((l) => [l.cancelled_xaf, Number(l.cancelled_quantity_base)])).toEqual([
      [6000, 6],
      [500, 1],
    ]);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('une annulation déjà faite, une demande en cours, une vente inconnue, un autre vendeur', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const { id: saleId } = await sell(
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('09:40:00'),
    );
    expect(code((await cancel(freshUuid(), at('09:41:00'))).result)).toBe('NOT_FOUND');
    // Autre vendeur du même site : la portée « propre » n'est pas la sienne.
    expect(code((await cancel(saleId, at('09:41:00'), {}, otherSeller)).result)).toBe(
      'FORBIDDEN_SCOPE',
    );
    expect((await cancel(saleId, at('09:42:00'))).result.status).toBe('APPLIED');
    expect(code((await cancel(saleId, at('09:43:00'))).result)).toBe('SALE_ALREADY_CANCELLED');

    const other = await sell(
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('09:50:00'),
    );
    const requested = await cancel(
      other.id,
      at('09:51:00'),
      {},
      seller,
      'sales.sale.request_cancellation',
    );
    expect(requested.result.status, JSON.stringify(requested.result)).toBe('APPLIED');
    expect(code((await cancel(other.id, at('09:52:00'))).result)).toBe('SALE_STATUS_INVALID');
  });

  it('AT-002 (rejeu) : même commande ou même annulation rejouée — un seul document, un seul retour', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const { id: saleId } = await sell(
      { lines: [line(product, 2)], payments: [{ methodCode: 'ESPECES', amountXaf: 2000 }] },
      at('10:00:00'),
    );
    const first = await cancel(saleId, at('10:05:00'));
    expect(first.result.status).toBe('APPLIED');
    // Même agrégat, autre commande : le gestionnaire reconnaît le document.
    const again = await cancel(saleId, at('10:05:00'), {}, seller, 'sales.sale.cancel', {
      id: first.id,
    });
    expect(again.result.status).toBe('APPLIED');
    expect(await returnMoves(first.id)).toHaveLength(1);
    expect(await onHand(product.id)).toBe(10);
  });

  // --- Hors délai : demande et décision ------------------------------------------------------------------

  it('hors délai : annulation transformée en demande ; approuvée avec un remboursement, la vente est annulée à l’heure de la décision', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 500);
    const cashBefore = (await cashAccountBalance(db, pdvCashId)) ?? 0;
    const customer = await newCustomer({ credit: true });
    const { id: saleId } = await sell(
      {
        customerId: customer,
        lines: [line(product, 4)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 4000 }],
      },
      at('10:10:00'),
    );
    const { id, result } = await cancel(saleId, at('11:30:00'), { comment: 'Erreur de saisie' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(result)).toEqual(['CANCEL_WINDOW_EXCEEDED']);
    expect((await saleRow(saleId)).status).toBe('CANCELLATION_REQUESTED');
    const requested = await cancellationRow(id);
    expect(requested).toMatchObject({ status: 'REQUESTED', cancelled_total_xaf: 4000 });
    expect(requested.applied_at).toBeNull();
    // Aucun effet tant que la validation n'est pas rendue.
    expect(await onHand(product.id)).toBe(6);
    expect(await returnMoves(id)).toHaveLength(0);
    const approval = await db
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status', 'operation_type', 'amount_xaf'])
      .where('subject_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({
      status: 'PENDING',
      operation_type: 'SALE_CANCELLATION',
      amount_xaf: 4000,
    });

    // Sans le choix du sort de l'argent, l'approbation d'une vente payée est refusée : rien ne change.
    const noOption = await run(
      finance,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(approval.id),
      at('12:00:00'),
      {
        requestId: fromBin(approval.id),
      },
    );
    expect(code(noOption)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect((await cancellationRow(id)).status).toBe('REQUESTED');

    const approved = await run(
      finance,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      fromBin(approval.id),
      at('12:05:00'),
      {
        requestId: fromBin(approval.id),
        decisionOption: 'REFUND',
      },
    );
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const doc = await cancellationRow(id);
    expect(doc).toMatchObject({ status: 'APPLIED', released_payment_treatment: 'REFUND' });
    expect(doc.applied_at?.toISOString()).toBe(at('12:05:00'));
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLED', cancelled_xaf: 4000 });
    expect(await onHand(product.id)).toBe(10);
    expect(await cashAccountBalance(db, pdvCashId)).toBe(cashBefore);
  });

  it('une demande rejetée n’a aucun effet : la vente redevient confirmée', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 500);
    const { id: saleId } = await sell(
      { lines: [line(product, 2)], payments: [{ methodCode: 'ESPECES', amountXaf: 2000 }] },
      at('10:20:00'),
    );
    const { id } = await cancel(
      saleId,
      at('10:30:00'),
      {},
      seller,
      'sales.sale.request_cancellation',
    );
    expect((await saleRow(saleId)).status).toBe('CANCELLATION_REQUESTED');
    const approval = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    const rejected = await run(
      finance,
      'approvals.request.reject',
      'APPROVAL_REQUEST',
      fromBin(approval.id),
      at('10:40:00'),
      {
        requestId: fromBin(approval.id),
        comment: 'Vente conforme',
      },
    );
    expect(rejected.status, JSON.stringify(rejected)).toBe('APPLIED');
    expect((await cancellationRow(id)).status).toBe('REJECTED');
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 0,
      amount_paid_xaf: 2000,
    });
    expect(await onHand(product.id)).toBe(8);
    expect(await returnMoves(id)).toHaveLength(0);
    // Une nouvelle demande est de nouveau possible.
    const retry = await cancel(
      saleId,
      at('10:50:00'),
      {},
      seller,
      'sales.sale.request_cancellation',
    );
    expect(retry.result.status).toBe('APPLIED');
  });

  it('hors ligne, une annulation tardive est transformée en demande, jamais rejetée pour son état', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 500);
    const { id: saleId } = await sell(
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('10:55:00'),
    );
    const { result } = await cancel(saleId, at('15:00:00'));
    expect(result.status).toBe('APPLIED_WITH_WARNINGS');
    const offline = await run(
      seller,
      'sales.sale.request_cancellation',
      'SALE_CANCELLATION',
      freshUuid(),
      at('15:10:00'),
      { saleId },
      { offline: true },
    );
    // La vente est déjà en demande : état invalide, mais c'est une intention, pas un fait accompli.
    expect(code(offline)).toBe('SALE_STATUS_INVALID');
  });
});
