/**
 * P4-13 — tests d'acceptation des ventes (09-non-functional/03-plan-de-tests.md, parts P4), à
 * travers le vrai pipeline avec les rôles réels du seed :
 * - AT-008 (WF-02) : commande, acompte, vente du disponible, livraison partielle, vente et livraison
 *   du reste, solde affecté — statut de la commande à chaque étape ;
 * - AT-009 : annulation directe dans les 15 minutes — stock rendu, remboursement, CA négatif daté de
 *   l'annulation (au jour métier suivant quand l'annulation passe minuit à Douala) ;
 * - AT-010 : annulation hors délai — demande de validation, auto-validation refusée, validation
 *   par un autre utilisateur ;
 * - AT-011 : première vente à un prospect — conversion en client et KPI « nouveaux clients » ;
 * - AT-018 (WF-06) : 50 poulets affectés au stock mobile d'un commercial ; ventes, perte, retour —
 *   solde mobile nul ;
 * - AT-030 : même référence mobile money saisie deux fois — second encaissement mis de côté, sans
 *   effet de trésorerie ;
 * - AT-032 : créance échue — événement `ReceivableOverdue` (l'alerte `OVERDUE_RECEIVABLE` est en P9)
 *   et règlement affecté aux plus anciennes.
 * AT-001, AT-002, AT-005, AT-007 : sales-sale-commands.test.ts ; AT-033 (part P4) :
 * sales-read.e2e.test.ts ; AT-026 et AT-052 (parts P4) : production-acceptance.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  businessDayEndUtc,
  businessDayStartUtc,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import {
  RECEIVABLES_OVERDUE_JOB_TYPE,
  ReceivablesOverdueJob,
} from '../src/modules/sales/application/jobs/receivables-overdue-job.js';
import { periodRevenue } from '../src/modules/sales/application/public/index.js';
import { commercialEffort } from '../src/modules/crm/application/public/index.js';
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

const DAY = '2026-10-20';
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
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

describe('P4-13 : tests d’acceptation des ventes (parts P4)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let policyAdmin: Actor;
  let sed: Actor;
  let sed2: Actor;
  let terrain: Actor;
  let keeper: Actor;
  let seller: Actor;
  let siteManager: Actor;
  let direction: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let counterId: string;
  let mobileId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let sedCash: string;
  let terrainCash: string;
  let posCash: string;
  let momoAccount: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? (r.error?.code ?? r.status) : r.status);

  function run(
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

  async function ok(...args: Parameters<typeof run>): Promise<Result> {
    const result = await run(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function sellable(price: number): Promise<Sellable> {
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: 'MARCHANDISE',
        base_unit_code: 'PIECE',
        pricing_mode: 'PER_UNIT',
        is_sellable: 1,
        created_by: toBin(policyAdmin.userId),
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
        pricing_unit_code: 'PIECE',
        status: 'ACTIVE',
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        approved_by: toBin(policyAdmin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(policyAdmin.userId),
      })
      .execute();
    return { id, ruleId, price, unit: 'PIECE' };
  }

  async function stock(
    productId: string,
    quantity: number,
    occurredAt = '2026-08-01T06:00:00.000Z',
    locationId = storeId,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: locationId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: 600,
          occurredAt: new Date(occurredAt),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: policyAdmin.userId,
          allowNegative: false,
        },
      );
    });
  }

  async function newCustomer(owner: Actor, options: { readonly credit?: boolean } = {}) {
    const id = freshUuid();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('crm_customers')
        .values({
          id: toBin(id),
          stage: 'PROSPECT',
          pipeline_step_id: toBin(stepId),
          display_name: 'Restaurant du port',
          phone_primary: `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
          zone_id: toBin(zoneId),
          source_code: sourceCode,
          acquired_by_user_id: toBin(owner.userId),
          owner_user_id: toBin(owner.userId),
          acquired_at: new Date('2026-01-01T00:00:00.000Z'),
          occurred_at: new Date('2026-01-01T00:00:00.000Z'),
          credit_allowed: options.credit ? 1 : 0,
          ...(options.credit ? { credit_limit_xaf: 1_000_000, payment_terms_days: 30 } : {}),
          created_by: toBin(policyAdmin.userId),
        })
        .execute();
      await trx
        .insertInto('crm_customer_assignments')
        .values({
          id: toBin(freshUuid()),
          customer_id: toBin(id),
          user_id: toBin(owner.userId),
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          assigned_by: toBin(policyAdmin.userId),
        })
        .execute();
    });
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

  const onHand = async (productId: string, locationId: string): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select((eb) => eb.fn.sum<string>('qty_on_hand').as('q'))
      .where('product_id', '=', toBin(productId))
      .where('location_id', '=', toBin(locationId))
      .executeTakeFirst();
    return Number(row?.q ?? 0);
  };
  const balanceOf = async (accountId: string): Promise<number> =>
    Number(
      (
        await db
          .selectFrom('finance_cash_accounts')
          .select('balance_xaf')
          .where('id', '=', toBin(accountId))
          .executeTakeFirstOrThrow()
      ).balance_xaf,
    );
  const orderRow = (id: string) =>
    db
      .selectFrom('sales_sales_orders')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const salesOf = (orderId: string) =>
    db
      .selectFrom('sales_sales')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
  const orderLineOf = async (orderId: string) =>
    fromBin(
      (
        await db
          .selectFrom('sales_sales_order_lines')
          .select('id')
          .where('order_id', '=', toBin(orderId))
          .executeTakeFirstOrThrow()
      ).id,
    );

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerSaleCommands(registry, idGenerator, sequences);
    registerOrderCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerDeliveryCommands(registry, idGenerator, sequences);
    registerPaymentCommands(registry, decisions, idGenerator, sequences);
    registerTransferCommands(registry, decisions, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      sedentary: await roleId('COMMERCIAL_SEDENTAIRE'),
      terrain: await roleId('COMMERCIAL_TERRAIN'),
      keeper: await roleId('MAGASINIER'),
      seller: await roleId('VENDEUR_PDV'),
      direction: await roleId('DIRECTION'),
      siteManager: await roleId('RESP_FERME'),
    };
    await db.transaction().execute(async (trx) => {
      const rootId = await insertTestUser(trx);
      policyAdmin = { userId: rootId, deviceId: await insertTestDevice(trx, rootId) };
      const policyRole = await insertTestRole(trx, rootId);
      await grantTestPermission(trx, policyRole, 'approvals.policy.manage', rootId);
      await assignTestRole(trx, rootId, policyRole, rootId);
      zoneId = await insertTestZone(trx, rootId);
      siteId = await insertTestSite(trx, rootId, zoneId, { siteType: 'MAGASIN' });
      storeId = await insertTestLocation(trx, rootId, siteId, { locationType: 'STORE' });
      counterId = await insertTestLocation(trx, rootId, siteId, { locationType: 'POS' });
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = { scopeType: 'GLOBAL' },
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, rootId, options);
        return { userId, deviceId };
      };
      sed = await actor(roles.sedentary);
      sed2 = await actor(roles.sedentary);
      terrain = await actor(roles.terrain, { scopeType: 'ZONE', scopeZoneId: zoneId });
      keeper = await actor(roles.keeper, { scopeType: 'SITE', scopeSiteId: siteId });
      seller = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: siteId });
      direction = await actor(roles.direction);
      // Responsable de site : vend, annule les siennes et valide les annulations de son site.
      siteManager = await actor(roles.siteManager, { scopeType: 'SITE', scopeSiteId: siteId });
      mobileId = freshUuid();
      await trx
        .insertInto('organization_locations')
        .values({
          id: toBin(mobileId),
          site_id: toBin(siteId),
          code: mobileId.replace(/-/g, '').slice(-8).toUpperCase(),
          name: 'Stock mobile de Paul',
          location_type: 'MOBILE',
          custodian_user_id: toBin(terrain.userId),
          created_by: toBin(rootId),
        })
        .execute();

      for (const unit of ['PIECE', 'KG']) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name: unit, is_count: unit === 'KG' ? 0 : 1 })
            .execute();
        }
      }
      for (const channel of ['DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
        if (
          !(await trx
            .selectFrom('catalog_sales_channels')
            .select('code')
            .where('code', '=', channel)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_sales_channels')
            .values({ code: channel, name: channel })
            .execute();
        }
      }
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Divers',
          created_by: toBin(rootId),
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
          created_by: toBin(rootId),
        })
        .execute();
      sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(rootId),
        })
        .execute();
      const account = async (values: {
        readonly type: 'CAISSE_UTILISATEUR' | 'CAISSE_PDV' | 'MOBILE_MONEY';
        readonly holder?: Actor;
        readonly site?: string;
      }) => {
        const id = freshUuid();
        await trx
          .insertInto('finance_cash_accounts')
          .values({
            id: toBin(id),
            code: `CPT-${id.slice(-10)}`,
            name: 'Compte',
            account_type: values.type,
            ...(values.holder ? { holder_user_id: toBin(values.holder.userId) } : {}),
            ...(values.site ? { site_id: toBin(values.site) } : {}),
            responsible_user_id: toBin(rootId),
            created_by: toBin(rootId),
          })
          .execute();
        return id;
      };
      sedCash = await account({ type: 'CAISSE_UTILISATEUR', holder: sed });
      terrainCash = await account({ type: 'CAISSE_UTILISATEUR', holder: terrain });
      posCash = await account({ type: 'CAISSE_PDV', site: siteId });
      momoAccount = await account({ type: 'MOBILE_MONEY' });
    });
    // Politiques du test (la plus récente l'emporte) : annulation de vente et doublon d'encaissement.
    for (const [operationType, approverPermission] of [
      ['SALE_CANCELLATION', 'sales.sale_cancel.approve'],
      ['PAYMENT_DUPLICATE', 'sales.payment.cancel'],
    ] as const) {
      const id = freshUuid();
      await ok(
        policyAdmin,
        'approvals.policy.set',
        'CONTROL_POLICY',
        id,
        at('00:00:00', '2026-08-01'),
        {
          code: `${operationType}_${id.slice(-8)}`,
          operationType,
          requiresApproval: true,
          approverPermission,
          approverScope: 'ALL',
        },
      );
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-008 (WF-02) : commande, acompte, vente du disponible, livraison partielle, reste, solde', async () => {
    const product = await sellable(1000);
    await stock(product.id, 6);
    const customer = await newCustomer(sed, { credit: true });
    const orderId = freshUuid();
    // 10 commandés, 6 disponibles : vente des 6 à la confirmation, acompte de 3 000 transféré.
    await ok(sed, 'sales.order.place', 'SALES_ORDER', orderId, at('08:00:00'), {
      customerId: customer,
      fulfilmentLocationId: storeId,
      lines: [line(product, 10)],
      advancePayments: [{ methodCode: 'ESPECES', amountXaf: 3000, cashAccountId: sedCash }],
    });
    const [first] = await salesOf(orderId);
    expect(first).toMatchObject({ total_xaf: 6000, amount_paid_xaf: 3000 });
    expect(await orderRow(orderId)).toMatchObject({ status: 'CONFIRMED' });
    expect(await onHand(product.id, storeId)).toBe(0);
    const orderLineId = await orderLineOf(orderId);

    // Livraison partielle de 4 par le magasinier.
    await ok(keeper, 'sales.order.fulfil', 'DELIVERY_NOTE', freshUuid(), at('10:00:00'), {
      orderId,
      lines: [{ orderLineId, quantityBase: 4 }],
    });
    expect(await orderRow(orderId)).toMatchObject({ status: 'PARTIALLY_FULFILLED' });

    // Réapprovisionnement, vente du reste, livraison du reste.
    await stock(product.id, 4, at('11:00:00'));
    await ok(sed, 'sales.order.confirm_remaining', 'SALES_ORDER', orderId, at('11:30:00'), {});
    const sales = await salesOf(orderId);
    expect(sales.map((s) => Number(s.total_xaf))).toEqual([6000, 4000]);
    await ok(keeper, 'sales.order.fulfil', 'DELIVERY_NOTE', freshUuid(), at('14:00:00'), {
      orderId,
      lines: [{ orderLineId, quantityBase: 6 }],
    });
    expect(await orderRow(orderId)).toMatchObject({ status: 'FULFILLED' });
    const orderLine = await db
      .selectFrom('sales_sales_order_lines')
      .selectAll()
      .where('id', '=', toBin(orderLineId))
      .executeTakeFirstOrThrow();
    expect([orderLine.sold_quantity_base, orderLine.delivered_quantity_base].map(Number)).toEqual([
      10, 10,
    ]);

    // Solde : 7 000 affectés de la vente la plus ancienne à la plus récente.
    await ok(sed, 'sales.payment.record', 'CUSTOMER_PAYMENT', freshUuid(), at('16:00:00'), {
      customerId: customer,
      methodCode: 'ESPECES',
      amountXaf: 7000,
      cashAccountId: sedCash,
    });
    for (const sale of await salesOf(orderId)) {
      expect(sale).toMatchObject({ payment_status: 'PAID', balance_due_xaf: 0 });
    }
  });

  it('AT-009 : annulation directe dans les 15 minutes — stock rendu, remboursement, CA négatif daté de l’annulation', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, undefined, counterId);
    const customer = await newCustomer(sed);
    const saleId = freshUuid();
    // 23:55 à Douala le 19, annulée à 00:05 le 20 : dix minutes, deux jours métier.
    const soldAt = '2026-10-19T22:55:00.000Z';
    const cancelledAt = '2026-10-19T23:05:00.000Z';
    await ok(seller, 'sales.sale.record', 'SALE', saleId, soldAt, {
      fromLocationId: counterId,
      customerId: customer,
      lines: [line(product, 2)],
      payments: [{ methodCode: 'ESPECES', amountXaf: 2000, cashAccountId: posCash }],
    });
    const cashAfterSale = await balanceOf(posCash);
    await ok(seller, 'sales.sale.cancel', 'SALE_CANCELLATION', freshUuid(), cancelledAt, {
      saleId,
      comment: 'Erreur de saisie',
      paymentTreatment: 'REFUND',
    });
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLED', cancelled_xaf: 2000 });
    expect(await onHand(product.id, counterId)).toBe(5);
    expect(await balanceOf(posCash)).toBe(cashAfterSale - 2000);
    const day = (d: string) => ({ fromUtc: businessDayStartUtc(d), toUtc: businessDayEndUtc(d) });
    expect(
      await periodRevenue(db, { ...day('2026-10-19'), customerIds: [customer] }),
    ).toMatchObject({ grossRevenueXaf: 2000, cancelledXaf: 0, netRevenueXaf: 2000 });
    expect(
      await periodRevenue(db, { ...day('2026-10-20'), customerIds: [customer] }),
    ).toMatchObject({ grossRevenueXaf: 0, cancelledXaf: 2000, netRevenueXaf: -2000 });
  });

  it('AT-010 : annulation hors délai — demande, auto-validation refusée, validation par un autre', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, undefined, counterId);
    const customer = await newCustomer(sed);
    const saleId = freshUuid();
    await ok(siteManager, 'sales.sale.record', 'SALE', saleId, at('08:00:00'), {
      fromLocationId: counterId,
      customerId: customer,
      lines: [line(product, 1)],
      payments: [{ methodCode: 'ESPECES', amountXaf: 1000, cashAccountId: posCash }],
    });
    // Une heure plus tard : au-delà des 15 minutes, l'annulation devient une demande.
    await ok(siteManager, 'sales.sale.cancel', 'SALE_CANCELLATION', freshUuid(), at('09:00:00'), {
      saleId,
      comment: 'Client mécontent',
      paymentTreatment: 'REFUND',
    });
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLATION_REQUESTED' });
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select(['id', 'requested_by'])
      .where('operation_type', '=', 'SALE_CANCELLATION')
      .where('requested_by', '=', toBin(siteManager.userId))
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    const requestId = fromBin(request.id);
    // Le demandeur, qui détient pourtant le droit de valider, ne valide pas sa propre demande
    // (séparation des tâches, INV-ADM-02).
    const self = await run(
      siteManager,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      requestId,
      at('09:05:00'),
      { requestId },
    );
    expect(code(self)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLATION_REQUESTED' });
    await ok(
      direction,
      'approvals.request.approve',
      'APPROVAL_REQUEST',
      requestId,
      at('10:00:00'),
      { requestId, decisionOption: 'REFUND' },
    );
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLED' });
  });

  it('AT-011 : première vente à un prospect — conversion en client et KPI « nouveaux clients »', async () => {
    const product = await sellable(1000);
    await stock(product.id, 2);
    const prospect = await newCustomer(sed2, { credit: true });
    const before = await commercialEffort(db, {
      userId: sed2.userId,
      fromUtc: businessDayStartUtc(DAY),
      toUtc: businessDayEndUtc(DAY),
    });
    const orderId = freshUuid();
    await ok(sed2, 'sales.order.place', 'SALES_ORDER', orderId, at('12:00:00'), {
      customerId: prospect,
      fulfilmentLocationId: storeId,
      lines: [line(product, 2)],
    });
    const [sale] = await salesOf(orderId);
    const customer = await db
      .selectFrom('crm_customers')
      .select(['stage', 'first_sale_id'])
      .where('id', '=', toBin(prospect))
      .executeTakeFirstOrThrow();
    expect(customer.stage).toBe('CUSTOMER');
    expect(fromBin(customer.first_sale_id!)).toBe(fromBin(sale!.id));
    const after = await commercialEffort(db, {
      userId: sed2.userId,
      fromUtc: businessDayStartUtc(DAY),
      toUtc: businessDayEndUtc(DAY),
    });
    expect(after.newCustomers - before.newCustomers).toBe(1);
  });

  it('AT-018 (WF-06) : 50 poulets au stock mobile ; 44 vendus, 2 perdus, 4 rendus — solde mobile nul', async () => {
    const product = await sellable(3500);
    await stock(product.id, 50);
    const cashBefore = await balanceOf(terrainCash);
    // Le magasinier transfère 50 poulets ; le commercial les reçoit et en devient responsable.
    const outbound = freshUuid();
    await ok(keeper, 'inventory.transfer.dispatch', 'STOCK_TRANSFER', outbound, at('06:30:00'), {
      fromLocationId: storeId,
      toLocationId: mobileId,
      lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 50 }],
    });
    const outLine = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(outbound))
      .executeTakeFirstOrThrow();
    await ok(terrain, 'inventory.transfer.receive', 'STOCK_TRANSFER', outbound, at('07:00:00'), {
      transferId: outbound,
      lines: [{ transferLineId: fromBin(outLine.id), receivedQtyBase: 50 }],
    });
    expect(await onHand(product.id, mobileId)).toBe(50);

    // Ventes de la journée depuis le stock exclusif, payées comptant.
    for (const [time, quantity] of [
      ['10:00:00', 24],
      ['15:00:00', 20],
    ] as const) {
      await ok(terrain, 'sales.sale.record', 'SALE', freshUuid(), at(time), {
        fromLocationId: mobileId,
        lines: [line(product, quantity)],
        payments: [
          { methodCode: 'ESPECES', amountXaf: quantity * 3500, cashAccountId: terrainCash },
        ],
      });
    }
    // Deux morts déclarés ; le soir, 4 rendus au magasin. Marchandise sans lot de production : perte
    // simple (AV-152 ; `MORTALITE` exige un lot).
    await ok(terrain, 'inventory.loss.declare', 'STOCK_LOSS', freshUuid(), at('16:00:00'), {
      locationId: mobileId,
      productId: product.id,
      quantityBase: 2,
      unitCode: 'PIECE',
      quantity: 2,
      category: 'DETERIORATION',
      comment: 'Deux poulets morts en tournée.',
    });
    const back = freshUuid();
    await ok(terrain, 'inventory.transfer.dispatch', 'STOCK_TRANSFER', back, at('18:00:00'), {
      fromLocationId: mobileId,
      toLocationId: storeId,
      lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 4 }],
    });
    const backLine = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(back))
      .executeTakeFirstOrThrow();
    await ok(keeper, 'inventory.transfer.receive', 'STOCK_TRANSFER', back, at('18:30:00'), {
      transferId: back,
      lines: [{ transferLineId: fromBin(backLine.id), receivedQtyBase: 4 }],
    });

    expect(await onHand(product.id, mobileId)).toBe(0);
    expect(await onHand(product.id, storeId)).toBe(4);
    expect(await balanceOf(terrainCash)).toBe(cashBefore + 44 * 3500);
  });

  it('AT-030 : même référence mobile money saisie deux fois — second encaissement mis de côté, sans trésorerie', async () => {
    const customer = await newCustomer(sed, { credit: true });
    const reference = `MP${Date.now()}`;
    const momoBefore = await balanceOf(momoAccount);
    const first = freshUuid();
    await ok(sed, 'sales.payment.record', 'CUSTOMER_PAYMENT', first, at('09:00:00'), {
      customerId: customer,
      siteId,
      methodCode: 'MOBILE_MONEY_ORANGE',
      amountXaf: 5000,
      reference,
      cashAccountId: momoAccount,
    });
    const second = freshUuid();
    const duplicate = await ok(
      sed,
      'sales.payment.record',
      'CUSTOMER_PAYMENT',
      second,
      at('09:30:00'),
      {
        customerId: customer,
        siteId,
        methodCode: 'MOBILE_MONEY_ORANGE',
        amountXaf: 5000,
        reference: ` ${reference.toLowerCase()} `,
        cashAccountId: momoAccount,
      },
    );
    expect(duplicate.status).toBe('APPLIED_WITH_WARNINGS');
    const rows = await db
      .selectFrom('sales_customer_payments')
      .select(['id', 'status', 'cash_movement_id', 'duplicate_of_payment_id'])
      .where('id', 'in', [toBin(first), toBin(second)])
      .execute();
    const byId = new Map(rows.map((row) => [fromBin(row.id), row]));
    expect(byId.get(first)).toMatchObject({ status: 'RECORDED' });
    expect(byId.get(second)).toMatchObject({ status: 'SUSPECT_DUPLICATE', cash_movement_id: null });
    expect(fromBin(byId.get(second)!.duplicate_of_payment_id!)).toBe(first);
    expect(await balanceOf(momoAccount)).toBe(momoBefore + 5000);
  });

  it('AT-032 : créance échue — événement ReceivableOverdue ; règlement affecté aux plus anciennes', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3);
    const customer = await newCustomer(sed, { credit: true });
    const older = freshUuid();
    const newer = freshUuid();
    // Conditions de 30 jours : échéances au 01/10 et au 15/10.
    await ok(sed, 'sales.order.place', 'SALES_ORDER', older, '2026-09-01T09:00:00.000Z', {
      customerId: customer,
      fulfilmentLocationId: storeId,
      lines: [line(product, 1)],
    });
    await ok(sed, 'sales.order.place', 'SALES_ORDER', newer, '2026-09-15T09:00:00.000Z', {
      customerId: customer,
      fulfilmentLocationId: storeId,
      lines: [line(product, 2)],
    });
    const [olderSale] = await salesOf(older);
    const [newerSale] = await salesOf(newer);

    // La tâche du 10/10 : seule la vente échue le 01/10 est signalée.
    const jobs = new JobHandlerRegistry();
    const jobClock = new FixedClock(new Date('2026-10-10T06:00:00.000Z'));
    new ReceivablesOverdueJob(jobClock, new Uuidv7Generator(jobClock), jobs).onModuleInit();
    const handler = jobs.resolve(RECEIVABLES_OVERDUE_JOB_TYPE)!;
    await db.transaction().execute((trx) => handler(trx, {}));
    const events = await db
      .selectFrom('platform_domain_events')
      .select('aggregate_id')
      .where('event_type', '=', 'ReceivableOverdue')
      .where('aggregate_id', 'in', [olderSale!.id, newerSale!.id])
      .execute();
    expect(events.map((event) => fromBin(event.aggregate_id))).toEqual([fromBin(olderSale!.id)]);

    // Un règlement de 1 500 solde d'abord la plus ancienne.
    await ok(sed, 'sales.payment.record', 'CUSTOMER_PAYMENT', freshUuid(), at('09:00:00'), {
      customerId: customer,
      methodCode: 'ESPECES',
      amountXaf: 1500,
      cashAccountId: sedCash,
    });
    expect(await saleRow(fromBin(olderSale!.id))).toMatchObject({ payment_status: 'PAID' });
    expect(await saleRow(fromBin(newerSale!.id))).toMatchObject({
      payment_status: 'PARTIALLY_PAID',
      amount_paid_xaf: 500,
    });
  });
});
