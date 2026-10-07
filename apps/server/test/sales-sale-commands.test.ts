/**
 * Ventes directes (P4-04, D04-VEN §7.2, UC-VEN-01) à travers le vrai pipeline, avec les rôles réels
 * du seed (vendeur de PDV, commercial terrain, responsable de ferme) : prix et dérogation, lot FIFO
 * et coût figé, poids, conditionnement, attribution, canal, vente anonyme, crédit, encaissements
 * joints, doublon de paiement, produit désactivé et stock négatif hors ligne, idempotence.
 * Couvre AT-001, AT-002, AT-005 et AT-007 sur les lignes de vente.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, dueDateOf, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import {
  createStockLot,
  recordCostEntry,
  recordStockMove,
  setStockLotSellableFromRearing,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { cashAccountBalance } from '../src/modules/finance/application/public/index.js';
import { customerOutstandingXaf } from '../src/modules/sales/application/public/index.js';
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

interface Sellable {
  readonly id: string;
  readonly ruleId: string;
  readonly price: number;
  readonly unit: string;
}

describe('sales.sale.record (P4-04)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let seller: Actor;
  let otherSeller: Actor;
  let terrain: Actor;
  let farmer: Actor;
  let zoneId: string;
  let pdvSiteId: string;
  let otherSiteId: string;
  let farmSiteId: string;
  let posId: string;
  let storeId: string;
  let mobileId: string;
  let buildingId: string;
  let categoryId: string;
  let pdvCashId: string;
  let terrainCashId: string;
  let overrideReasonId: string;
  let stepId: string;
  let sourceCode: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);
  const warningsOf = (r: Result) => (r.status === 'APPLIED_WITH_WARNINGS' ? r.warnings : []);
  const docNumber = (r: Result) =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS'
      ? r.server_refs?.['docNumber']
      : undefined;

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

  // --- Fixtures ----------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function ensureUnit(unit: string, isCount: boolean): Promise<void> {
    const existing = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', unit)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto('catalog_units')
        .values({ code: unit, name: unit, is_count: isCount ? 1 : 0 })
        .execute();
    }
  }

  async function ensureChannel(channel: string): Promise<void> {
    const existing = await db
      .selectFrom('catalog_sales_channels')
      .select('code')
      .where('code', '=', channel)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto('catalog_sales_channels')
        .values({ code: channel, name: channel })
        .execute();
    }
  }

  async function ensurePaymentMethod(
    method: string,
    accountType: 'CAISSE_UTILISATEUR' | 'MOBILE_MONEY',
    requiresReference: boolean,
  ): Promise<void> {
    const existing = await db
      .selectFrom('finance_payment_methods')
      .select('code')
      .where('code', '=', method)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto('finance_payment_methods')
        .values({
          code: method,
          label: method,
          requires_reference: requiresReference ? 1 : 0,
          default_account_type: accountType,
        })
        .execute();
    }
  }

  async function newProduct(
    options: {
      readonly family?: 'MARCHANDISE' | 'SERVICE' | 'BIOLOGIQUE';
      readonly baseUnit?: string;
      readonly pricingMode?: 'PER_UNIT' | 'PER_WEIGHT';
      readonly lotTracking?: 'NONE' | 'REQUIRED';
      readonly sellable?: boolean;
    } = {},
  ): Promise<string> {
    const id = freshUuid();
    const family = options.family ?? 'MARCHANDISE';
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: family === 'SERVICE' ? 'Livraison' : 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: family,
        species: family === 'BIOLOGIQUE' ? 'PORC' : null,
        base_unit_code: options.baseUnit ?? 'PIECE',
        pricing_mode: options.pricingMode ?? 'PER_UNIT',
        lot_tracking: options.lotTracking ?? (family === 'BIOLOGIQUE' ? 'REQUIRED' : 'NONE'),
        is_sellable: options.sellable === false ? 0 : 1,
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  async function newRule(
    productId: string,
    price: number,
    options: {
      readonly code?: string;
      readonly version?: number;
      readonly validFrom?: string;
      readonly validTo?: string;
      readonly unit?: string;
    } = {},
  ): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('pricing_price_rules')
      .values({
        id: toBin(id),
        code: options.code ?? `PR-${id.slice(-12)}`,
        version: options.version ?? 1,
        product_id: toBin(productId),
        unit_price_xaf: price,
        pricing_unit_code: options.unit ?? 'PIECE',
        status: 'ACTIVE',
        valid_from: new Date(options.validFrom ?? '2026-01-01T00:00:00.000Z'),
        ...(options.validTo ? { valid_to: new Date(options.validTo) } : {}),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  /** Produit vendable à l'unité avec sa règle de prix. */
  async function sellable(
    price = 1000,
    options: Parameters<typeof newProduct>[0] = {},
  ): Promise<Sellable> {
    const unit = options.baseUnit ?? 'PIECE';
    const id = await newProduct(options);
    const ruleId = await newRule(id, price, {
      unit: options.pricingMode === 'PER_WEIGHT' ? 'KG' : unit,
    });
    return { id, ruleId, price, unit };
  }

  async function stock(
    productId: string,
    quantity: number,
    unitCost: number,
    options: { readonly location?: string; readonly lotId?: string } = {},
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          ...(options.lotId !== undefined ? { lotId: options.lotId } : {}),
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: options.location ?? posId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date('2026-10-06T06:00:00.000Z'),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  async function newLot(productId: string, rank: string, origin: 'COLLECTION' | 'PRODUCTION_LOT') {
    const originId = freshUuid();
    const lotId = await db.transaction().execute((trx) =>
      createStockLot(
        trx,
        { idGenerator },
        {
          originType: origin,
          originId,
          lotCode: `T-${originId.slice(-12)}`,
          productId,
          fifoRankAt: new Date(`2026-10-06T${rank}.000Z`),
          expiryDate: null,
          createdBy: admin.userId,
        },
      ),
    );
    return { lotId, originId };
  }

  async function newCustomer(
    options: {
      readonly stage?: 'PROSPECT' | 'CUSTOMER';
      readonly creditAllowed?: boolean;
      readonly creditLimitXaf?: number;
      readonly paymentTermsDays?: number;
      readonly mergedInto?: string;
      readonly owner?: string;
    } = {},
  ): Promise<string> {
    const id = freshUuid();
    const merged = options.mergedInto !== undefined;
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: merged ? 'MERGED' : (options.stage ?? 'PROSPECT'),
        ...(merged || options.stage === 'CUSTOMER' ? {} : { pipeline_step_id: toBin(stepId) }),
        ...(merged ? { merged_into_id: toBin(options.mergedInto!) } : {}),
        ...(options.stage === 'CUSTOMER' ? { first_sale_id: toBin(freshUuid()) } : {}),
        display_name: 'Boutique de test',
        phone_primary: `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        zone_id: toBin(zoneId),
        source_code: sourceCode,
        acquired_by_user_id: toBin(admin.userId),
        acquired_at: new Date('2026-01-01T00:00:00.000Z'),
        occurred_at: new Date('2026-01-01T00:00:00.000Z'),
        ...(options.owner ? { owner_user_id: toBin(options.owner) } : {}),
        credit_allowed: options.creditAllowed ? 1 : 0,
        ...(options.creditLimitXaf !== undefined
          ? { credit_limit_xaf: options.creditLimitXaf }
          : {}),
        ...(options.paymentTermsDays !== undefined
          ? { payment_terms_days: options.paymentTermsDays }
          : {}),
        created_by: toBin(admin.userId),
      })
      .execute();
    if (options.owner) {
      await db
        .insertInto('crm_customer_assignments')
        .values({
          id: toBin(freshUuid()),
          customer_id: toBin(id),
          user_id: toBin(options.owner),
          valid_from: new Date('2026-01-02T00:00:00.000Z'),
          assigned_by: toBin(admin.userId),
        })
        .execute();
    }
    return id;
  }

  // --- Lectures ----------------------------------------------------------------------------------

  const saleRow = (id: string) =>
    db
      .selectFrom('sales_sales')
      .selectAll()
      .select(sql<string | null>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due'))
      .where('id', '=', toBin(id))
      .executeTakeFirst();
  const saleLines = (id: string) =>
    db
      .selectFrom('sales_sale_lines')
      .selectAll()
      .where('sale_id', '=', toBin(id))
      .orderBy('line_no')
      .execute();
  const salePayments = (saleId: string) =>
    db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb(
            'id',
            'in',
            eb
              .selectFrom('sales_payment_allocations')
              .select('payment_id')
              .where('sale_id', '=', toBin(saleId)),
          ),
          eb('intended_sale_id', '=', toBin(saleId)),
        ]),
      )
      .orderBy('doc_number')
      .execute();
  const allocations = (saleId: string) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where('sale_id', '=', toBin(saleId))
      .execute();
  const saleMoves = (saleId: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('source_doc_type', '=', 'SALE')
      .where('source_doc_id', '=', toBin(saleId))
      .orderBy('recorded_at')
      .orderBy('id')
      .execute();
  const conflicts = async (saleId: string) =>
    (
      await db
        .selectFrom('sync_sync_conflicts')
        .select(['conflict_type', 'owner_role', 'applied', 'status'])
        .where('entity_id', '=', toBin(saleId))
        .orderBy('conflict_type')
        .execute()
    ).map((row) => row.conflict_type);
  const conflictRows = (entityId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'owner_role', 'applied', 'entity_type', 'status'])
      .where('entity_id', '=', toBin(entityId))
      .orderBy('conflict_type')
      .execute();
  const approvalRows = (subjectId: string) =>
    db
      .selectFrom('approvals_approval_requests')
      .select(['operation_type', 'status', 'amount_xaf'])
      .where('subject_id', '=', toBin(subjectId))
      .execute();
  const approvals = (subjectId: string) =>
    db
      .selectFrom('approvals_approval_requests')
      .select(['operation_type', 'status'])
      .where('subject_id', '=', toBin(subjectId))
      .execute();
  const onHand = async (productId: string, location = posId): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`COALESCE(SUM(qty_on_hand), 0)`.as('qty'))
      .where('location_id', '=', toBin(location))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.qty);
  };
  const flagsOf = (row: { readonly flags: unknown } | undefined): string[] =>
    (typeof row?.flags === 'string' ? JSON.parse(row.flags) : row?.flags) as string[];

  // --- Commande de test ---------------------------------------------------------------------------

  interface LineOptions {
    readonly quantity?: number;
    readonly quantityBase?: number;
    readonly unitCode?: string;
    readonly unitPrice?: number;
    readonly listPrice?: number | null;
    readonly discount?: number;
    readonly weightKg?: number;
    readonly reasonId?: string;
    readonly ruleId?: string | null;
  }

  const line = (product: Sellable, quantity: number, options: LineOptions = {}) => ({
    productId: product.id,
    quantity: options.quantity ?? quantity,
    unitCode: options.unitCode ?? product.unit,
    quantityBase: options.quantityBase ?? quantity,
    ...(options.weightKg !== undefined ? { weightKg: options.weightKg } : {}),
    listUnitPriceXaf: options.listPrice === undefined ? product.price : options.listPrice,
    ...(options.ruleId === null ? {} : { priceRuleId: options.ruleId ?? product.ruleId }),
    unitPriceXaf: options.unitPrice ?? product.price,
    ...(options.discount !== undefined ? { discountXaf: options.discount } : {}),
    ...(options.reasonId !== undefined ? { overrideReasonCodeId: options.reasonId } : {}),
  });

  async function sell(
    actor: Actor,
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly offline?: boolean; readonly id?: string; readonly commandId?: string } = {},
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = options.id ?? freshUuid();
    const result = await run(
      actor,
      'sales.sale.record',
      'SALE',
      id,
      occurredAt,
      { fromLocationId: posId, ...body },
      {
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
      },
    );
    return { id, result };
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerSaleCommands(registry, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const [unit, isCount] of [
      ['PIECE', true],
      ['TETE', true],
      ['KG', false],
      ['CARTON', true],
      ['FORFAIT', true],
    ] as const) {
      await ensureUnit(unit, isCount);
    }
    for (const channel of ['POINT_DE_VENTE', 'TERRAIN', 'SEDENTAIRE', 'DIRECT']) {
      await ensureChannel(channel);
    }
    await ensurePaymentMethod('ESPECES', 'CAISSE_UTILISATEUR', false);
    await ensurePaymentMethod('MOBILE_MONEY_ORANGE', 'MOBILE_MONEY', true);

    const roles = {
      seller: await roleId('VENDEUR_PDV'),
      terrain: await roleId('COMMERCIAL_TERRAIN'),
      farmer: await roleId('RESP_FERME'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);

      zoneId = await insertTestZone(trx, adminId);
      pdvSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'POINT_DE_VENTE' });
      otherSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'POINT_DE_VENTE' });
      farmSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      posId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'POS' });
      storeId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'STORE' });
      buildingId = await insertTestLocation(trx, adminId, farmSiteId, { locationType: 'BUILDING' });

      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      seller = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: pdvSiteId });
      otherSeller = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: otherSiteId });
      terrain = await actor(roles.terrain, { scopeType: 'ZONE', scopeZoneId: zoneId });
      farmer = await actor(roles.farmer, { scopeType: 'SITE', scopeSiteId: farmSiteId });

      mobileId = freshUuid();
      await trx
        .insertInto('organization_locations')
        .values({
          id: toBin(mobileId),
          site_id: toBin(pdvSiteId),
          code: mobileId.replace(/-/g, '').slice(-8).toUpperCase(),
          name: 'Stock mobile de test',
          location_type: 'MOBILE',
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: toBin(terrain.userId),
          created_by: toBin(adminId),
        })
        .execute();

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
      overrideReasonId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(overrideReasonId),
          code: `OVR-${overrideReasonId.slice(-8)}`,
          category: 'PRICE_OVERRIDE',
          label: 'Client fidèle',
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
      terrainCashId = freshUuid();
      for (const [id, type, extra] of [
        [pdvCashId, 'CAISSE_PDV', { site_id: toBin(pdvSiteId) }],
        [terrainCashId, 'CAISSE_UTILISATEUR', { holder_user_id: toBin(terrain.userId) }],
      ] as const) {
        await trx
          .insertInto('finance_cash_accounts')
          .values({
            id: toBin(id),
            code: `CPT-${id.slice(-10)}`,
            name: 'Caisse de test',
            account_type: type,
            ...extra,
            responsible_user_id: toBin(adminId),
            created_by: toBin(adminId),
          })
          .execute();
      }
    });

    for (const [operationType, approverPermission] of [
      ['PRICE_OVERRIDE', 'sales.price_override.approve'],
      ['CREDIT_LIMIT_EXCEEDED', 'sales.credit_limit_exceed.approve'],
      ['PAYMENT_DUPLICATE', 'sales.payment.cancel'],
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

  // --- Vente au comptant ---------------------------------------------------------------------------

  it('AT-001 : vente comptant au PDV — stock, coût figé, encaissement, affectation, numéros', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 600);
    const { id, result } = await sell(
      seller,
      {
        lines: [line(product, 2)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 2000 }],
      },
      at('09:00:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(docNumber(result)).toMatch(/^VTE-/);

    const sale = await saleRow(id);
    expect(sale).toMatchObject({
      status: 'CONFIRMED',
      sale_type: 'DIRECT',
      total_xaf: 2000,
      subtotal_xaf: 2000,
      discount_total_xaf: 0,
      amount_paid_xaf: 2000,
      balance_due_xaf: 0,
      payment_status: 'PAID',
      channel_code: 'POINT_DE_VENTE',
      captured_offline: 0,
    });
    expect(sale?.commercial_user_id).toBeNull();
    expect(sale?.due).toBeNull();
    expect(flagsOf(sale)).toEqual([]);

    const [saleLine] = await saleLines(id);
    expect(saleLine).toMatchObject({
      price_source: 'RULE',
      price_rule_version: 1,
      list_unit_price_xaf: 1000,
      unit_price_xaf: 1000,
      line_total_xaf: 2000,
      cost_xaf: 1200,
      unit_cost_xaf: 600,
    });
    expect(fromBin(saleLine!.price_rule_id!)).toBe(product.ruleId);

    const moves = await saleMoves(id);
    expect(moves).toHaveLength(1);
    expect(fromBin(moves[0]!.source_line_id!)).toBe(fromBin(saleLine!.id));
    expect(Number(moves[0]!.value_xaf)).toBe(1200);
    expect(await onHand(product.id)).toBe(8);

    const [payment] = await salePayments(id);
    expect(payment).toMatchObject({ status: 'RECORDED', amount_xaf: 2000, unallocated_xaf: 0 });
    expect(payment?.doc_number).toMatch(/^ENC-/);
    expect(fromBin(payment!.cash_account_id)).toBe(pdvCashId);
    expect(payment?.cash_movement_id).not.toBeNull();
    expect((await allocations(id)).map((a) => [a.status, a.amount_xaf])).toEqual([
      ['ACTIVE', 2000],
    ]);
    expect(await cashAccountBalance(db, pdvCashId)).toBeGreaterThanOrEqual(2000);
    expect(result.status === 'APPLIED' && result.server_refs?.['payment1']).toMatch(/^ENC-/);
  });

  it('AT-002 : le rejeu ne crée ni seconde vente, ni second mouvement, ni second encaissement', async () => {
    const product = await sellable(500);
    await stock(product.id, 5, 300);
    const commandId = freshUuid();
    const first = await sell(
      seller,
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 500 }] },
      at('09:05:00'),
      { commandId },
    );
    expect(first.result.status).toBe('APPLIED');
    // Même commande (même command_id, même contenu) : résultat stocké.
    const sameCommand = await pipeline.handle(
      {
        command_id: commandId,
        device_seq: deviceSeq,
        command_version: 1,
        command_type: 'sales.sale.record',
        aggregate_type: 'SALE',
        aggregate_id: first.id,
        author_user_id: seller.userId,
        base_version: null,
        depends_on: [],
        occurred_at: at('09:05:00'),
        client_created_at: at('09:05:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          fromLocationId: posId,
          lines: [line(product, 1)],
          payments: [{ methodCode: 'ESPECES', amountXaf: 500 }],
        },
      },
      {
        authenticatedUserId: seller.userId,
        authenticatedDeviceId: seller.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(sameCommand.status).toBe('APPLIED');
    // Autre command_id, même agrégat : le gestionnaire reconnaît la vente.
    const again = await sell(
      seller,
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 500 }] },
      at('09:05:00'),
      { id: first.id },
    );
    expect(again.result.status).toBe('APPLIED');
    expect(docNumber(again.result)).toBe(docNumber(first.result));
    expect(await saleMoves(first.id)).toHaveLength(1);
    expect(await salePayments(first.id)).toHaveLength(1);
    expect(await onHand(product.id)).toBe(4);
  });

  it('un lot FIFO entamé puis le suivant : un mouvement par lot, coût = somme des valeurs figées', async () => {
    const product = await sellable(1000, { lotTracking: 'REQUIRED' });
    const first = await newLot(product.id, '05:00:00', 'COLLECTION');
    const second = await newLot(product.id, '05:30:00', 'COLLECTION');
    await stock(product.id, 3, 100, { lotId: first.lotId });
    await stock(product.id, 5, 100, { lotId: second.lotId });
    const { id, result } = await sell(
      seller,
      { lines: [line(product, 5)], payments: [{ methodCode: 'ESPECES', amountXaf: 5000 }] },
      at('09:10:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const moves = await saleMoves(id);
    expect(moves.map((m) => [fromBin(m.lot_id!), Number(m.quantity), Number(m.value_xaf)])).toEqual(
      [
        [first.lotId, 3, 300],
        [second.lotId, 2, 200],
      ],
    );
    const [saleLine] = await saleLines(id);
    expect(saleLine).toMatchObject({ cost_xaf: 500, unit_cost_xaf: 100 });
  });

  it('un produit vendu au poids : quantité de tarification = poids pesé (AV-031)', async () => {
    const product = await sellable(2000, { baseUnit: 'TETE', pricingMode: 'PER_WEIGHT' });
    await stock(product.id, 2, 90_000);
    const { id, result } = await sell(
      seller,
      {
        lines: [line(product, 1, { weightKg: 85.5 })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 171_000 }],
      },
      at('09:15:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [saleLine] = await saleLines(id);
    expect(saleLine).toMatchObject({
      pricing_unit_code: 'KG',
      line_total_xaf: 171_000,
      unit_price_xaf: 2000,
    });
    expect(Number(saleLine!.pricing_quantity)).toBe(85.5);
    expect(Number(saleLine!.quantity_base)).toBe(1);
    // Sans poids pesé : refus de la ligne.
    const noWeight = await sell(seller, { lines: [line(product, 1)] }, at('09:16:00'));
    expect(code(noWeight.result)).toBe('WEIGHT_REQUIRED');
  });

  it('une ligne de service n’a aucun effet stock (BR-VEN-031)', async () => {
    const goods = await sellable(1000);
    const service = await sellable(500, { family: 'SERVICE', baseUnit: 'FORFAIT' });
    await stock(goods.id, 3, 400);
    const { id, result } = await sell(
      seller,
      {
        lines: [line(goods, 1), line(service, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1500 }],
      },
      at('09:20:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(await saleMoves(id)).toHaveLength(1);
    const lines = await saleLines(id);
    expect(lines.map((l) => l.cost_xaf)).toEqual([400, null]);
  });

  it('un conditionnement : quantité en unité de base recontrôlée, entier pour une unité comptée', async () => {
    const product = await sellable(1000);
    await db
      .insertInto('catalog_product_units')
      .values({
        id: toBin(freshUuid()),
        product_id: toBin(product.id),
        unit_code: 'CARTON',
        factor_to_base: '12',
        is_sales_unit: 1,
        is_count_unit: 1,
        created_by: toBin(admin.userId),
      })
      .execute();
    await stock(product.id, 60, 100);
    const ok = await sell(
      seller,
      {
        lines: [line(product, 2, { unitCode: 'CARTON', quantityBase: 24 })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 24_000 }],
      },
      at('09:25:00'),
    );
    expect(ok.result.status, JSON.stringify(ok.result)).toBe('APPLIED');
    expect(Number((await saleLines(ok.id))[0]!.quantity)).toBe(2);
    expect(Number((await saleLines(ok.id))[0]!.quantity_base)).toBe(24);
    const wrong = await sell(
      seller,
      { lines: [line(product, 2, { unitCode: 'CARTON', quantityBase: 23 })] },
      at('09:26:00'),
    );
    expect(code(wrong.result)).toBe('QUANTITY_BASE_MISMATCH');
    const fraction = await sell(seller, { lines: [line(product, 1.5)] }, at('09:27:00'));
    expect(code(fraction.result)).toBe('LINE_INVALID');
    const unknown = await sell(
      seller,
      { lines: [line(product, 1, { unitCode: 'KG' })] },
      at('09:28:00'),
    );
    expect(code(unknown.result)).toBe('UNIT_INVALID');
  });

  // --- Stock : refus en ligne, fait accompli hors ligne -----------------------------------------------

  it('en ligne, un stock insuffisant refuse la vente sans aucun effet', async () => {
    const product = await sellable(1000);
    await stock(product.id, 1, 100);
    const { id, result } = await sell(
      seller,
      { lines: [line(product, 3)], payments: [{ methodCode: 'ESPECES', amountXaf: 3000 }] },
      at('09:30:00'),
    );
    expect(code(result)).toBe('INSUFFICIENT_STOCK');
    expect(await saleRow(id)).toBeUndefined();
    expect(await saleMoves(id)).toHaveLength(0);
    expect(await onHand(product.id)).toBe(1);
  });

  it('BR-VEN-019 : hors ligne, la vente est appliquée en solde négatif avec le conflit STOCK_NEGATIVE', async () => {
    const product = await sellable(1000);
    await stock(product.id, 1, 100);
    const { id, result } = await sell(
      seller,
      { lines: [line(product, 3)], payments: [{ methodCode: 'ESPECES', amountXaf: 3000 }] },
      at('09:35:00'),
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(result)).toContain('STOCK_NEGATIVE');
    expect(await conflicts(id)).toEqual(['STOCK_NEGATIVE']);
    expect(flagsOf(await saleRow(id))).toContain('STOCK_NEGATIVE');
    expect(await onHand(product.id)).toBe(-2);
    expect((await saleRow(id))?.captured_offline).toBe(1);
  });

  // --- Prix ---------------------------------------------------------------------------------------

  it('AT-005, AT-007 : vente hors ligne à un prix devenu obsolète — acceptée au prix figé, règle et version conservées', async () => {
    const product = await newProduct();
    const code2 = `PR-${freshUuid().slice(-12)}`;
    const v1 = await newRule(product, 4500, {
      code: code2,
      version: 1,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-10-06T08:00:00.000Z',
    });
    const v2 = await newRule(product, 4800, {
      code: code2,
      version: 2,
      validFrom: '2026-10-06T08:00:00.000Z',
    });
    await stock(product, 10, 3000);
    const oldPrice: Sellable = { id: product, ruleId: v1, price: 4500, unit: 'PIECE' };

    // En ligne, avec le prix périmé : la vente est refusée, le catalogue doit être actualisé.
    const online = await sell(seller, { lines: [line(oldPrice, 1)] }, at('09:40:00'));
    expect(code(online.result)).toBe('PRICE_OUTDATED');

    // Hors ligne, saisie à 07:00 (règle v1 encore en vigueur) : aucun écart.
    const early = await sell(
      seller,
      { lines: [line(oldPrice, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 4500 }] },
      at('07:00:00'),
      { offline: true },
    );
    expect(early.result.status, JSON.stringify(early.result)).toBe('APPLIED');

    // Hors ligne, saisie à 09:00 au prix de l'ancienne règle : écart PRICE_MISMATCH.
    const late = await sell(
      seller,
      { lines: [line(oldPrice, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 4500 }] },
      at('09:41:00'),
      { offline: true },
    );
    expect(late.result.status, JSON.stringify(late.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(late.result)).toEqual(['PRICE_MISMATCH']);
    expect(await conflicts(late.id)).toEqual(['PRICE_MISMATCH']);
    expect(flagsOf(await saleRow(late.id))).toEqual(['PRICE_MISMATCH']);
    const [saleLine] = await saleLines(late.id);
    expect(saleLine).toMatchObject({
      unit_price_xaf: 4500,
      list_unit_price_xaf: 4500,
      price_rule_version: 1,
      line_total_xaf: 4500,
    });
    expect(fromBin(saleLine!.price_rule_id!)).toBe(v1);
    // En ligne, au prix courant : règle v2, version 2.
    const current = await sell(
      seller,
      {
        lines: [line({ ...oldPrice, ruleId: v2, price: 4800 }, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 4800 }],
      },
      at('09:42:00'),
    );
    expect(current.result.status, JSON.stringify(current.result)).toBe('APPLIED');
    expect((await saleLines(current.id))[0]).toMatchObject({
      price_rule_version: 2,
      unit_price_xaf: 4800,
    });
  });

  it('un vendeur de PDV sans droit de dérogation ne peut pas modifier le prix', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 100);
    const { result } = await sell(
      seller,
      { lines: [line(product, 1, { unitPrice: 900, reasonId: overrideReasonId })] },
      at('09:45:00'),
    );
    expect(code(result)).toBe('PRICE_OVERRIDE_NOT_PERMITTED');
    const discount = await sell(
      seller,
      { lines: [line(product, 1, { discount: 100, reasonId: overrideReasonId })] },
      at('09:46:00'),
    );
    expect(code(discount.result)).toBe('PRICE_OVERRIDE_NOT_PERMITTED');
  });

  it('BR-VEN-015 : dérogation d’un commercial terrain — dans le plafond (5 %), au-delà (validation), motif obligatoire', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 500, { location: mobileId });
    const asTerrain = (body: Record<string, unknown>, when: string, offline = false) =>
      sell(terrain, { fromLocationId: mobileId, ...body }, when, { offline });

    const within = await asTerrain(
      {
        lines: [line(product, 1, { unitPrice: 960, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 960 }],
      },
      at('10:00:00'),
    );
    expect(within.result.status, JSON.stringify(within.result)).toBe('APPLIED');
    expect((await saleLines(within.id))[0]).toMatchObject({
      price_source: 'MANUAL_OVERRIDE',
      list_unit_price_xaf: 1000,
      unit_price_xaf: 960,
      override_approval_request_id: null,
    });
    expect(await approvals(within.id)).toHaveLength(0);

    const over = await asTerrain(
      {
        lines: [line(product, 1, { unitPrice: 800, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 800 }],
      },
      at('10:05:00'),
    );
    expect(over.result.status, JSON.stringify(over.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(over.result)).toContain('PRICE_OVERRIDE_EXCEEDS_LIMIT');
    expect(await approvals(over.id)).toEqual([
      { operation_type: 'PRICE_OVERRIDE', status: 'PENDING' },
    ]);
    expect((await saleLines(over.id))[0]!.override_approval_request_id).not.toBeNull();

    const noReason = await asTerrain(
      { lines: [line(product, 1, { unitPrice: 960 })] },
      at('10:10:00'),
    );
    expect(code(noReason.result)).toBe('OVERRIDE_REASON_REQUIRED');
    const badReason = await asTerrain(
      { lines: [line(product, 1, { unitPrice: 960, reasonId: freshUuid() })] },
      at('10:11:00'),
    );
    expect(code(badReason.result)).toBe('OVERRIDE_REASON_INVALID');
    // Remise en XAF : même contrôle.
    const discounted = await asTerrain(
      {
        lines: [line(product, 2, { discount: 100, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1900 }],
      },
      at('10:12:00'),
    );
    expect(discounted.result.status, JSON.stringify(discounted.result)).toBe('APPLIED');
    expect((await saleRow(discounted.id))?.discount_total_xaf).toBe(100);
  });

  it('sans prix catalogue : refus sans dérogation, validation avec dérogation', async () => {
    const productId = await newProduct();
    const bare: Sellable = { id: productId, ruleId: freshUuid(), price: 700, unit: 'PIECE' };
    await stock(productId, 5, 100, { location: mobileId });
    const noRule = await sell(
      seller,
      { lines: [line(bare, 1, { listPrice: null, ruleId: null })] },
      at('10:20:00'),
    );
    expect(code(noRule.result)).toBe('PRICE_NOT_FOUND');
    const withOverride = await sell(
      terrain,
      {
        fromLocationId: mobileId,
        lines: [line(bare, 1, { listPrice: null, ruleId: null, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 700 }],
      },
      at('10:21:00'),
    );
    expect(withOverride.result.status, JSON.stringify(withOverride.result)).toBe(
      'APPLIED_WITH_WARNINGS',
    );
    expect(await approvals(withOverride.id)).toEqual([
      { operation_type: 'PRICE_OVERRIDE', status: 'PENDING' },
    ]);
  });

  // --- Produit, emplacement, portée ----------------------------------------------------------------------

  it('BR-VEN-030 : produit désactivé — refusé en ligne, accepté hors ligne avec PRODUCT_INACTIVE', async () => {
    const product = await sellable(1000, { sellable: false });
    await stock(product.id, 5, 100);
    const online = await sell(seller, { lines: [line(product, 1)] }, at('10:30:00'));
    expect(code(online.result)).toBe('PRODUCT_NOT_SELLABLE');
    const offline = await sell(
      seller,
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('10:31:00'),
      { offline: true },
    );
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toEqual(['PRODUCT_INACTIVE']);
    expect(await conflicts(offline.id)).toEqual(['PRODUCT_INACTIVE']);
  });

  it('portée et emplacement : autre site, magasin, emplacement virtuel, stock mobile d’autrui', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 100);
    await stock(product.id, 5, 100, { location: storeId });
    const otherSite = await sell(otherSeller, { lines: [line(product, 1)] }, at('10:40:00'));
    expect(code(otherSite.result)).toBe('FORBIDDEN_SCOPE');
    const store = await sell(
      seller,
      { fromLocationId: storeId, lines: [line(product, 1)] },
      at('10:41:00'),
    );
    expect(code(store.result)).toBe('LOCATION_NOT_SELLABLE');
    const virtual = await db.transaction().execute((trx) => virtualLocationId(trx, 'V_CUSTOMER'));
    const virt = await sell(
      seller,
      { fromLocationId: virtual, lines: [line(product, 1)] },
      at('10:42:00'),
    );
    expect(code(virt.result)).toBe('REFERENCE_INVALID');
    // Le stock mobile du commercial terrain n'est pas celui du vendeur de PDV.
    const mobile = await sell(
      seller,
      { fromLocationId: mobileId, lines: [line(product, 1)] },
      at('10:43:00'),
    );
    expect(code(mobile.result)).toBe('FORBIDDEN_SCOPE');
    expect(await onHand(product.id)).toBe(5);
  });

  it('BR-VEN-021 : le canal se déduit du contexte et le vendeur peut en choisir un autre', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 100);
    await stock(product.id, 10, 100, { location: mobileId });
    const pos = await sell(
      seller,
      { lines: [line(product, 1)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('11:00:00'),
    );
    expect((await saleRow(pos.id))?.channel_code).toBe('POINT_DE_VENTE');
    const field = await sell(
      terrain,
      {
        fromLocationId: mobileId,
        lines: [line(product, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }],
      },
      at('11:01:00'),
    );
    expect((await saleRow(field.id))?.channel_code).toBe('TERRAIN');
    // Un commercial terrain hors session de pointage : anomalie OUT_OF_SESSION (flag seulement).
    expect(flagsOf(await saleRow(field.id))).toContain('OUT_OF_SESSION');
    const chosen = await sell(
      seller,
      {
        channelCode: 'DIRECT',
        lines: [line(product, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }],
      },
      at('11:02:00'),
    );
    expect((await saleRow(chosen.id))?.channel_code).toBe('DIRECT');
    const unknown = await sell(
      seller,
      { channelCode: 'INCONNU', lines: [line(product, 1)] },
      at('11:03:00'),
    );
    expect(code(unknown.result)).toBe('CHANNEL_UNKNOWN');
  });

  // --- Client, attribution, conversion ---------------------------------------------------------------------

  it('BR-VEN-020, BR-CRM-010 : attribution au titulaire du client, conversion du prospect à la première vente', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 100);
    const owned = await newCustomer({ owner: terrain.userId });
    const { id, result } = await sell(
      seller,
      {
        customerId: owned,
        lines: [line(product, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }],
      },
      at('11:10:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const sale = await saleRow(id);
    expect(fromBin(sale!.commercial_user_id!)).toBe(terrain.userId);
    expect(fromBin(sale!.seller_user_id)).toBe(seller.userId);
    // Titulaire fixé : l'échéance existe pour tout client identifié, même soldé (AV-129).
    expect(sale?.due).toBe(dueDateOf(new Date(at('11:10:00')), 30));
    const customer = await db
      .selectFrom('crm_customers')
      .select(['stage', 'first_sale_id'])
      .where('id', '=', toBin(owned))
      .executeTakeFirstOrThrow();
    expect(customer.stage).toBe('CUSTOMER');
    expect(fromBin(customer.first_sale_id!)).toBe(id);

    // Sans titulaire : le vendeur seulement s'il a un rôle commercial.
    const free = await newCustomer();
    const bySeller = await sell(
      seller,
      {
        customerId: free,
        lines: [line(product, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }],
      },
      at('11:11:00'),
    );
    expect((await saleRow(bySeller.id))?.commercial_user_id).toBeNull();
    const unknownCustomer = await sell(
      seller,
      { customerId: freshUuid(), lines: [line(product, 1)] },
      at('11:12:00'),
    );
    expect(code(unknownCustomer.result)).toBe('CUSTOMER_UNKNOWN');
  });

  it('un compte fusionné : refusé en ligne, vendu sur l’identifiant d’origine hors ligne', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 100);
    const kept = await newCustomer({ stage: 'CUSTOMER' });
    const absorbed = await newCustomer({ mergedInto: kept });
    const online = await sell(
      seller,
      { customerId: absorbed, lines: [line(product, 1)] },
      at('11:20:00'),
    );
    expect(code(online.result)).toBe('CUSTOMER_MERGED');
    const offline = await sell(
      seller,
      {
        customerId: absorbed,
        lines: [line(product, 1)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }],
      },
      at('11:21:00'),
      { offline: true },
    );
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED');
    expect(fromBin((await saleRow(offline.id))!.customer_id!)).toBe(absorbed);
  });

  // --- Vente anonyme et crédit ------------------------------------------------------------------------------

  it('AV-027, AV-137 : vente anonyme — payée intégralement en ligne ; hors ligne, appliquée avec ANONYMOUS_UNPAID', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 100);
    const unpaid = await sell(seller, { lines: [line(product, 1)] }, at('11:30:00'));
    expect(code(unpaid.result)).toBe('ANONYMOUS_REQUIRES_FULL_PAYMENT');
    const partial = await sell(
      seller,
      { lines: [line(product, 2)], payments: [{ methodCode: 'ESPECES', amountXaf: 1000 }] },
      at('11:31:00'),
    );
    expect(code(partial.result)).toBe('ANONYMOUS_REQUIRES_FULL_PAYMENT');
    const offline = await sell(seller, { lines: [line(product, 1)] }, at('11:32:00'), {
      offline: true,
    });
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toEqual(['ANONYMOUS_UNPAID']);
    expect(await conflicts(offline.id)).toEqual(['ANONYMOUS_UNPAID']);
    expect(flagsOf(await saleRow(offline.id))).toEqual(['ANONYMOUS_UNPAID']);
    expect((await saleRow(offline.id))?.balance_due_xaf).toBe(1000);
  });

  it('BR-VEN-025, AV-028 : crédit dans le plafond, au-delà (refus en ligne, validation hors ligne), client non autorisé', async () => {
    const product = await sellable(1000);
    await stock(product.id, 200, 100);
    const customer = await newCustomer({
      creditAllowed: true,
      creditLimitXaf: 50_000,
      paymentTermsDays: 15,
    });
    const ok = await sell(
      seller,
      {
        customerId: customer,
        lines: [line(product, 20)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 5000 }],
      },
      at('12:00:00'),
    );
    expect(ok.result.status, JSON.stringify(ok.result)).toBe('APPLIED');
    const sale = await saleRow(ok.id);
    expect(sale).toMatchObject({
      amount_paid_xaf: 5000,
      balance_due_xaf: 15_000,
      payment_status: 'PARTIALLY_PAID',
    });
    expect(sale?.due).toBe(dueDateOf(new Date(at('12:00:00')), 15));
    expect(await customerOutstandingXaf(db, customer)).toBe(15_000);

    // 15 000 déjà dus + 40 000 > 50 000.
    const over = await sell(
      seller,
      { customerId: customer, lines: [line(product, 40)] },
      at('12:05:00'),
    );
    expect(code(over.result)).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(await customerOutstandingXaf(db, customer)).toBe(15_000);
    const offlineOver = await sell(
      seller,
      { customerId: customer, lines: [line(product, 40)] },
      at('12:06:00'),
      { offline: true },
    );
    expect(offlineOver.result.status, JSON.stringify(offlineOver.result)).toBe(
      'APPLIED_WITH_WARNINGS',
    );
    expect(warningsOf(offlineOver.result)).toEqual(['CREDIT_OVER_LIMIT']);
    expect(flagsOf(await saleRow(offlineOver.id))).toEqual(['CREDIT_OVER_LIMIT']);
    expect(await approvals(offlineOver.id)).toEqual([
      { operation_type: 'CREDIT_LIMIT_EXCEEDED', status: 'PENDING' },
    ]);

    const noCredit = await newCustomer({ creditAllowed: false });
    const refused = await sell(
      seller,
      { customerId: noCredit, lines: [line(product, 1)] },
      at('12:10:00'),
    );
    expect(code(refused.result)).toBe('CREDIT_NOT_ALLOWED');
    const offlineNoCredit = await sell(
      seller,
      { customerId: noCredit, lines: [line(product, 1)] },
      at('12:11:00'),
      { offline: true },
    );
    expect(warningsOf(offlineNoCredit.result)).toEqual(['CREDIT_OVER_LIMIT']);
    // Un client sans plafond défini : tout crédit dépasse.
    const noLimit = await newCustomer({ creditAllowed: true });
    const noLimitSale = await sell(
      seller,
      { customerId: noLimit, lines: [line(product, 1)] },
      at('12:12:00'),
    );
    expect(code(noLimitSale.result)).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  // --- Encaissements -------------------------------------------------------------------------------------------

  it('Σ des paiements au plus égale au total ; moyen inconnu, référence obligatoire, compte invalide', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 100);
    const customer = await newCustomer({ creditAllowed: true, creditLimitXaf: 100_000 });
    const body = (payments: unknown[]) => ({
      customerId: customer,
      lines: [line(product, 2)],
      payments,
    });
    const excess = await sell(
      seller,
      body([{ methodCode: 'ESPECES', amountXaf: 2500 }]),
      at('13:00:00'),
    );
    expect(code(excess.result)).toBe('PAYMENT_EXCEEDS_TOTAL');
    const unknown = await sell(
      seller,
      body([{ methodCode: 'TROC', amountXaf: 100 }]),
      at('13:01:00'),
    );
    expect(code(unknown.result)).toBe('PAYMENT_METHOD_INVALID');
    const noReference = await sell(
      seller,
      body([{ methodCode: 'MOBILE_MONEY_ORANGE', amountXaf: 1000, cashAccountId: pdvCashId }]),
      at('13:02:00'),
    );
    expect(code(noReference.result)).toBe('PAYMENT_REFERENCE_REQUIRED');
    // Une caisse de PDV ne reçoit pas un mobile money ; la caisse d'un autre utilisateur non plus.
    const wrongType = await sell(
      seller,
      body([
        {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 1000,
          reference: 'MP-1',
          cashAccountId: pdvCashId,
        },
      ]),
      at('13:03:00'),
    );
    expect(code(wrongType.result)).toBe('CASH_ACCOUNT_INVALID');
    const otherCash = await sell(
      seller,
      body([{ methodCode: 'ESPECES', amountXaf: 1000, cashAccountId: terrainCashId }]),
      at('13:04:00'),
    );
    expect(code(otherCash.result)).toBe('CASH_ACCOUNT_INVALID');
    expect(await onHand(product.id)).toBe(20);
  });

  it('AV-056 : même référence mobile money — l’encaissement en double est mis de côté, sans trésorerie ni affectation', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 100);
    const mobileMoneyId = freshUuid();
    await db
      .insertInto('finance_cash_accounts')
      .values({
        id: toBin(mobileMoneyId),
        code: `MM-${mobileMoneyId.slice(-10)}`,
        name: 'Orange Money de test',
        account_type: 'MOBILE_MONEY',
        responsible_user_id: toBin(admin.userId),
        created_by: toBin(admin.userId),
      })
      .execute();
    const reference = `MP${freshUuid().slice(-8).toUpperCase()}`;
    const payment = (spaced: boolean) => ({
      methodCode: 'MOBILE_MONEY_ORANGE',
      amountXaf: 1000,
      reference: spaced ? reference.toLowerCase().replace(/(.{3})/, '$1 ') : reference,
      cashAccountId: mobileMoneyId,
    });
    const customer = await newCustomer({ creditAllowed: true, creditLimitXaf: 100_000 });
    const first = await sell(
      seller,
      { customerId: customer, lines: [line(product, 1)], payments: [payment(false)] },
      at('13:10:00'),
    );
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    const balanceAfterFirst = await cashAccountBalance(db, mobileMoneyId);
    expect(balanceAfterFirst).toBe(1000);

    // Même référence, saisie avec des espaces et en minuscules : même transaction (INV-FIN-03).
    const second = await sell(
      seller,
      { customerId: customer, lines: [line(product, 1)], payments: [payment(true)] },
      at('13:11:00'),
    );
    expect(second.result.status, JSON.stringify(second.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(second.result)).toEqual(['PAYMENT_SUSPECT_DUPLICATE']);
    const [suspect] = await salePayments(second.id);
    expect(suspect).toMatchObject({
      status: 'SUSPECT_DUPLICATE',
      cash_movement_id: null,
      unallocated_xaf: 0,
    });
    expect(suspect?.duplicate_of_payment_id).not.toBeNull();
    expect(fromBin(suspect!.intended_sale_id!)).toBe(second.id);
    expect(await allocations(second.id)).toHaveLength(0);
    expect(await cashAccountBalance(db, mobileMoneyId)).toBe(balanceAfterFirst);
    // La vente reste enregistrée avec son reste dû (crédit client identifié).
    expect(await saleRow(second.id)).toMatchObject({ amount_paid_xaf: 0, balance_due_xaf: 1000 });
    expect(await conflicts(fromBin(suspect!.id))).toEqual(['PAYMENT_REFERENCE_DUPLICATE']);
    expect(await approvals(fromBin(suspect!.id))).toEqual([
      { operation_type: 'PAYMENT_DUPLICATE', status: 'PENDING' },
    ]);
    expect(flagsOf(await saleRow(second.id))).toEqual(['PAYMENT_SUSPECT_DUPLICATE']);

    // La même référence deux fois dans une seule vente est une erreur de saisie.
    const twice = await sell(
      seller,
      {
        customerId: customer,
        lines: [line(product, 2)],
        payments: [
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 1000,
            reference: 'DEUX-1',
            cashAccountId: mobileMoneyId,
          },
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 1000,
            reference: 'deux-1',
            cashAccountId: mobileMoneyId,
          },
        ],
      },
      at('13:12:00'),
    );
    expect(code(twice.result)).toBe('PAYMENT_REFERENCE_DUPLICATE');
  });

  it('plusieurs moyens de paiement sur une vente : un encaissement par moyen, affectés en entier', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 100);
    const accountId = freshUuid();
    await db
      .insertInto('finance_cash_accounts')
      .values({
        id: toBin(accountId),
        code: `MM-${accountId.slice(-10)}`,
        name: 'MTN MoMo de test',
        account_type: 'MOBILE_MONEY',
        responsible_user_id: toBin(admin.userId),
        created_by: toBin(admin.userId),
      })
      .execute();
    const { id, result } = await sell(
      seller,
      {
        lines: [line(product, 5)],
        payments: [
          { methodCode: 'ESPECES', amountXaf: 2000 },
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 3000,
            reference: `MM${freshUuid().slice(-8)}`,
            cashAccountId: accountId,
          },
        ],
      },
      at('13:20:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const payments = await salePayments(id);
    expect(payments.map((p) => [p.payment_method_code, p.amount_xaf, p.status])).toEqual(
      expect.arrayContaining([
        ['ESPECES', 2000, 'RECORDED'],
        ['MOBILE_MONEY_ORANGE', 3000, 'RECORDED'],
      ]),
    );
    expect(new Set(payments.map((p) => p.doc_number)).size).toBe(2);
    expect(await saleRow(id)).toMatchObject({ amount_paid_xaf: 5000, payment_status: 'PAID' });
    expect(await cashAccountBalance(db, accountId)).toBe(3000);
  });

  // --- Vente à la ferme ------------------------------------------------------------------------------------------

  it('BR-VEN-017 : vente à la ferme — seuls les lots « en vente » ; hors ligne, appliquée avec LOT_NOT_SELLABLE', async () => {
    const pig = await newProduct({
      family: 'BIOLOGIQUE',
      baseUnit: 'TETE',
      pricingMode: 'PER_UNIT',
    });
    const rule = await newRule(pig, 50_000, { unit: 'TETE' });
    const priced: Sellable = { id: pig, ruleId: rule, price: 50_000, unit: 'TETE' };
    const lot = await newLot(pig, '04:00:00', 'PRODUCTION_LOT');
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: pig,
          lotId: lot.lotId,
          quantityBase: 4,
          fromLocationId: await virtualLocationId(trx, 'V_PRODUCTION'),
          toLocationId: buildingId,
          moveType: 'PRODUCTION_OUTPUT',
          declaredUnitCostXaf: 10,
          occurredAt: new Date('2026-10-06T05:00:00.000Z'),
          sourceDocType: 'LOT_ENTRY',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
      await recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lot.originId,
          costType: 'ANIMAUX',
          amountXaf: 80_000,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: new Date('2026-10-06T05:30:00.000Z'),
          createdBy: admin.userId,
          comment: 'Test P4-04',
        },
      );
    });
    const farmSale = (when: string, quantity: number, offline = false) =>
      sell(
        farmer,
        {
          fromLocationId: buildingId,
          lines: [line(priced, quantity)],
          payments: [
            { methodCode: 'ESPECES', amountXaf: 50_000 * quantity, cashAccountId: farmCashId },
          ],
        },
        when,
        { offline },
      );
    const farmCashId = freshUuid();
    await db
      .insertInto('finance_cash_accounts')
      .values({
        id: toBin(farmCashId),
        code: `CPT-${farmCashId.slice(-10)}`,
        name: 'Caisse ferme',
        account_type: 'CAISSE_UTILISATEUR',
        holder_user_id: toBin(farmer.userId),
        responsible_user_id: toBin(admin.userId),
        created_by: toBin(admin.userId),
      })
      .execute();

    // Lot pas encore « en vente » : refusé en ligne, aucun effet.
    const refused = await farmSale(at('14:00:00'), 1);
    expect(code(refused.result)).toBe('LOT_NOT_SELLABLE');
    expect(await saleMoves(refused.id)).toHaveLength(0);
    // Hors ligne : les animaux sont partis, le fait est appliqué avec l'anomalie.
    const offline = await farmSale(at('14:01:00'), 1, true);
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toEqual(['LOT_NOT_SELLABLE']);
    expect(await conflicts(offline.id)).toEqual(['LOT_NOT_SELLABLE']);

    // Lot « en vente » : la vente est acceptée, le coût par tête vient du lot (dernière sortie exacte).
    await db.transaction().execute((trx) => setStockLotSellableFromRearing(trx, lot.lotId, true));
    const accepted = await farmSale(at('14:10:00'), 1);
    expect(accepted.result.status, JSON.stringify(accepted.result)).toBe('APPLIED');
    const [moved] = await saleMoves(accepted.id);
    expect(fromBin(moved!.lot_id!)).toBe(lot.lotId);
    // Plus que 2 têtes : en demander 5 dépasse le vendable (aucun autre lot) → stock insuffisant.
    const tooMany = await farmSale(at('14:11:00'), 5);
    expect(code(tooMany.result)).toBe('INSUFFICIENT_STOCK');
  });

  // --- Compléments de la revue adverse ----------------------------------------------------------------

  it('AT-001 : vente saisie hors ligne puis synchronisée — heure métier conservée, trésorerie exacte, audit', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 400);
    const cashBefore = (await cashAccountBalance(db, pdvCashId)) ?? 0;
    const { id, result } = await sell(
      seller,
      { lines: [line(product, 2)], payments: [{ methodCode: 'ESPECES', amountXaf: 2000 }] },
      at('11:47:00'),
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const sale = await saleRow(id);
    // Heure de la vente conservée (jamais l'heure de réception) ; réception tracée à part.
    expect(sale?.occurred_at.toISOString()).toBe(at('11:47:00'));
    expect(sale?.captured_offline).toBe(1);
    expect(sale?.received_at_server).not.toBeNull();
    expect(await cashAccountBalance(db, pdvCashId)).toBe(cashBefore + 2000);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select('action')
      .where('entity_id', '=', toBin(id))
      .execute();
    expect(audit.map((row) => row.action)).toContain('sales.sale.record');
  });

  it('la validation PRICE_OVERRIDE porte l’écart au prix catalogue', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 500, { location: mobileId });
    const over = await sell(
      terrain,
      {
        fromLocationId: mobileId,
        lines: [line(product, 1, { unitPrice: 800, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 800 }],
      },
      at('15:00:00'),
    );
    expect(over.result.status, JSON.stringify(over.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(await approvalRows(over.id)).toEqual([
      { operation_type: 'PRICE_OVERRIDE', status: 'PENDING', amount_xaf: 200 },
    ]);
  });

  it('les conflits portent le bon responsable, l’entité vendue et leur état', async () => {
    const product = await sellable(1000);
    await stock(product.id, 1, 100);
    const { id } = await sell(
      seller,
      { lines: [line(product, 3)], payments: [{ methodCode: 'ESPECES', amountXaf: 3000 }] },
      at('15:10:00'),
      { offline: true },
    );
    expect(await conflictRows(id)).toEqual([
      {
        conflict_type: 'STOCK_NEGATIVE',
        owner_role: 'MAGASINIER',
        applied: 1,
        entity_type: 'SALE',
        status: 'OPEN',
      },
    ]);
  });

  it('hors ligne, un manquant multi-lots est valorisé et deux lignes du même produit se servent sur le solde restant', async () => {
    const product = await sellable(1000, { lotTracking: 'REQUIRED' });
    const first = await newLot(product.id, '05:00:00', 'COLLECTION');
    const second = await newLot(product.id, '05:30:00', 'COLLECTION');
    await stock(product.id, 3, 100, { lotId: first.lotId });
    await stock(product.id, 5, 100, { lotId: second.lotId });
    const { id, result } = await sell(
      seller,
      {
        lines: [line(product, 6), line(product, 4)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 10_000 }],
      },
      at('15:20:00'),
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    const lines = await saleLines(id);
    // 8 en stock, 10 vendus : le manquant est valorisé au coût courant (100).
    expect(lines.map((l) => [Number(l.quantity_base), l.cost_xaf, l.unit_cost_xaf])).toEqual([
      [6, 600, 100],
      [4, 400, 100],
    ]);
    const moves = await saleMoves(id);
    expect(moves.reduce((sum, move) => sum + Number(move.quantity), 0)).toBe(10);
    expect(moves.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(1000);
    expect(await onHand(product.id)).toBe(-2);
  });

  it('une quantité hors de la plage numeric(14,3) est refusée par la validation, pas par une erreur SQL', async () => {
    const product = await sellable(1);
    const { result } = await sell(
      seller,
      { lines: [line(product, 2e11)], payments: [{ methodCode: 'ESPECES', amountXaf: 1 }] },
      at('15:30:00'),
    );
    expect(code(result)).toMatch(/^VALIDATION_ERROR/);
  });

  it('une référence de paiement avec des espaces Unicode exotiques est normalisée comme la base le contrôle', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 100);
    const accountId = freshUuid();
    await db
      .insertInto('finance_cash_accounts')
      .values({
        id: toBin(accountId),
        code: `MM-${accountId.slice(-10)}`,
        name: 'Orange Money de test',
        account_type: 'MOBILE_MONEY',
        responsible_user_id: toBin(admin.userId),
        created_by: toBin(admin.userId),
      })
      .execute();
    const { id, result } = await sell(
      seller,
      {
        lines: [line(product, 1)],
        payments: [
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 1000,
            reference: `MP${freshUuid().slice(-6)}\u0085 \u00a0Z`,
            cashAccountId: accountId,
          },
        ],
      },
      at('15:40:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect((await salePayments(id))[0]?.reference_normalized).toMatch(/^MP[0-9A-F]{6}Z$/);
  });

  it('hors ligne, l’absence de politique à la date de la vente ne rejette pas un fait accompli', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 100, { location: mobileId });
    // Saisie datée d'avant toute politique de contrôle en vigueur : le fait reste appliqué.
    const { id, result } = await sell(
      terrain,
      {
        fromLocationId: mobileId,
        lines: [line(product, 1, { unitPrice: 700, reasonId: overrideReasonId })],
        payments: [{ methodCode: 'ESPECES', amountXaf: 700 }],
      },
      '2026-01-05T09:00:00.000Z',
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    expect(await approvalRows(id)).toHaveLength(1);
  });
});
