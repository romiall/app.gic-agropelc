/**
 * Projections `/sync/pull` des jeux de vente et de trésorerie (P4-11 ; 01-architecture-offline.md
 * §3.1) : `orders` (commandes ouvertes : titulaire, équipe, emplacement de préparation),
 * `sales_recent` (ventes et encaissements des 7 derniers jours : utilisateur, PDV), `cash` (comptes
 * et soldes), encours client dans `customers`, moyens de paiement dans `catalog` (ADR-031).
 * Données écrites par le vrai pipeline avec les rôles réels du seed ; téléchargement par le vrai
 * `SyncPullService`.
 *
 * Les heures métier sont relatives à l'heure réelle : la fenêtre de 7 jours est évaluée par la base
 * (`UTC_TIMESTAMP`), au moment du téléchargement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { computeDeviceScope } from '../src/sync/device-scope.js';
import { codeEntityId } from '../src/platform/sync/code-entity-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
/** Heure métier `minutes` avant maintenant (ISO). */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const DAY_MINUTES = 24 * 60;
const PRICE = 1000;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('projections /sync/pull des jeux orders, sales_recent, cash (P4-11)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let comA: Actor;
  let comB: Actor;
  let manager: Actor;
  let venA: Actor;
  let magA: Actor;
  let siteA: string;
  let storeA: string;
  let storeB: string;
  let counterA: string;
  let productId: string;
  let ruleId: string;
  let custA: string;
  let custB: string;
  let cashA: string;
  let posA: string;
  let deliveredOrder: string;
  let openOrder: string;
  let orderB: string;
  let saleDelivered: string;
  let saleOpen: string;
  let saleB: string;
  let paymentA: string;
  let oldSale: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<Result> {
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
    return result;
  }

  async function pull(actor: Actor, dataset: string): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 2000 },
      { authenticatedUserId: actor.userId, authenticatedDeviceId: actor.deviceId, now: NOW },
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

  const idsOf = (changes: readonly Change[], entityType: string) =>
    new Set(changes.filter((c) => c.entity_type === entityType && c.data).map((c) => c.entity_id));

  /** Clés de coût d'une donnée projetée, à toute profondeur (RC-05 : aucune attendue). */
  function costKeys(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => costKeys(item));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
        ...(/cost|margin|value_xaf/i.test(key) ? [key] : []),
        ...costKeys(item),
      ]);
    }
    return [];
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  const line = (quantity: number) => ({
    productId,
    quantity,
    unitCode: 'PIECE',
    quantityBase: quantity,
    listUnitPriceXaf: PRICE,
    priceRuleId: ruleId,
    unitPriceXaf: PRICE,
  });

  async function placed(
    actor: Actor,
    customerId: string,
    location: string,
    quantity: number,
    occurredAt: string,
  ): Promise<{ readonly orderId: string; readonly saleId: string }> {
    const orderId = freshUuid();
    await run(actor, 'sales.order.place', 'SALES_ORDER', orderId, occurredAt, {
      customerId,
      fulfilmentLocationId: location,
      lines: [line(quantity)],
    });
    const sale = await db
      .selectFrom('sales_sales')
      .select('id')
      .where('order_id', '=', toBin(orderId))
      .executeTakeFirstOrThrow();
    return { orderId, saleId: fromBin(sale.id) };
  }

  beforeAll(async () => {
    clock = new FixedClock(NOW);
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
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);
    const high = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(high?.seq ?? 0);

    const roles = {
      sedentary: await roleId('COMMERCIAL_SEDENTAIRE'),
      manager: await roleId('RESP_COMMERCIAL'),
      seller: await roleId('VENDEUR_PDV'),
      keeper: await roleId('MAGASINIER'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      const siteB = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      storeA = await insertTestLocation(trx, adminId, siteA, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, adminId, siteB, { locationType: 'STORE' });
      counterA = await insertTestLocation(trx, adminId, siteA, { locationType: 'POS' });
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = { scopeType: 'GLOBAL' },
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      comA = await actor(roles.sedentary);
      comB = await actor(roles.sedentary);
      venA = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: siteA });
      magA = await actor(roles.keeper, { scopeType: 'SITE', scopeSiteId: siteA });
      // Responsable commercial (affectation d'équipe seulement) de l'équipe du commercial A.
      const managerId = await insertTestUser(trx);
      const team = await insertTestTeam(trx, managerId, adminId);
      await insertTestTeamMembership(trx, team, comA.userId, adminId);
      manager = {
        userId: managerId,
        deviceId: await insertTestDevice(trx, managerId, { status: 'ACTIVE' }),
      };
      await assignTestRole(trx, managerId, roles.manager, adminId, {
        scopeType: 'TEAM',
        scopeTeamId: team,
      });

      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', 'PIECE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'PIECE', name: 'Pièce', is_count: 1 })
          .execute();
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
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Divers',
          created_by: toBin(adminId),
        })
        .execute();
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-10)}`,
          name: 'Poulet de chair',
          category_id: toBin(categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'PIECE',
          pricing_mode: 'PER_UNIT',
          is_sellable: 1,
          created_by: toBin(adminId),
        })
        .execute();
      ruleId = freshUuid();
      await trx
        .insertInto('pricing_price_rules')
        .values({
          id: toBin(ruleId),
          code: `PR-${ruleId.slice(-12)}`,
          version: 1,
          product_id: toBin(productId),
          unit_price_xaf: PRICE,
          pricing_unit_code: 'PIECE',
          status: 'ACTIVE',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          approved_by: toBin(adminId),
          approved_at: new Date('2026-01-01T00:00:00.000Z'),
          created_by: toBin(adminId),
        })
        .execute();
      const supplier = await virtualLocationId(trx, 'V_SUPPLIER');
      for (const store of [storeA, storeB, counterA]) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            quantityBase: 50,
            fromLocationId: supplier,
            toLocationId: store,
            moveType: 'PURCHASE_RECEIPT',
            declaredUnitCostXaf: 600,
            occurredAt: new Date(ago(20 * DAY_MINUTES)),
            sourceDocType: 'GOODS_RECEIPT',
            sourceDocId: freshUuid(),
            createdBy: adminId,
            allowNegative: false,
          },
        );
      }
      const stepId = freshUuid();
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
      const sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(adminId),
        })
        .execute();
      const customer = async (owner: Actor): Promise<string> => {
        const id = freshUuid();
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
            credit_allowed: 1,
            credit_limit_xaf: 1_000_000,
            payment_terms_days: 30,
            created_by: toBin(adminId),
          })
          .execute();
        await trx
          .insertInto('crm_customer_assignments')
          .values({
            id: toBin(freshUuid()),
            customer_id: toBin(id),
            user_id: toBin(owner.userId),
            valid_from: new Date('2026-01-01T00:00:00.000Z'),
            assigned_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      custA = await customer(comA);
      custB = await customer(comB);
      const account = async (values: {
        readonly type: 'CAISSE_UTILISATEUR' | 'CAISSE_PDV';
        readonly holder?: Actor;
        readonly siteId?: string;
      }): Promise<string> => {
        const id = freshUuid();
        await trx
          .insertInto('finance_cash_accounts')
          .values({
            id: toBin(id),
            code: `CPT-${id.slice(-10)}`,
            name: 'Caisse',
            account_type: values.type,
            ...(values.holder ? { holder_user_id: toBin(values.holder.userId) } : {}),
            ...(values.siteId ? { site_id: toBin(values.siteId) } : {}),
            responsible_user_id: toBin(adminId),
            created_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      cashA = await account({ type: 'CAISSE_UTILISATEUR', holder: comA });
      posA = await account({ type: 'CAISSE_PDV', siteId: siteA });
    });

    // Vente directe du PDV il y a 10 jours, payée comptant : hors de la fenêtre de 7 jours.
    oldSale = freshUuid();
    await run(venA, 'sales.sale.record', 'SALE', oldSale, ago(10 * DAY_MINUTES), {
      fromLocationId: counterA,
      customerId: custA,
      lines: [line(1)],
      payments: [{ methodCode: 'ESPECES', amountXaf: PRICE, cashAccountId: posA }],
    });
    // Commandes du commercial A (l'une livrée, l'autre ouverte), du commercial B ; encaissement.
    ({ orderId: deliveredOrder, saleId: saleDelivered } = await placed(
      comA,
      custA,
      storeA,
      3,
      ago(180),
    ));
    ({ orderId: openOrder, saleId: saleOpen } = await placed(comA, custA, storeA, 2, ago(170)));
    ({ orderId: orderB, saleId: saleB } = await placed(comB, custB, storeB, 2, ago(160)));
    paymentA = freshUuid();
    await run(comA, 'sales.payment.record', 'CUSTOMER_PAYMENT', paymentA, ago(150), {
      customerId: custA,
      amountXaf: 1000,
      methodCode: 'ESPECES',
      cashAccountId: cashA,
    });
    const orderLine = await db
      .selectFrom('sales_sales_order_lines')
      .select('id')
      .where('order_id', '=', toBin(deliveredOrder))
      .executeTakeFirstOrThrow();
    await run(comA, 'sales.order.fulfil', 'DELIVERY_NOTE', freshUuid(), ago(140), {
      orderId: deliveredOrder,
      lines: [{ orderLineId: fromBin(orderLine.id), quantityBase: 3 }],
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('orders : le commercial reçoit ses commandes ouvertes ; une commande livrée sort du jeu', async () => {
    const changes = await pull(comA, 'orders');
    const open = latest(changes, 'SALES_ORDER', openOrder);
    expect(open?.change_type).toBe('UPSERT');
    expect(open?.scope_type).toBe('USER');
    expect(open?.data).toMatchObject({
      id: openOrder,
      status: 'CONFIRMED',
      customer_id: custA,
      fulfilment_location_id: storeA,
      total_estimated_xaf: 2 * PRICE,
    });
    expect((open?.data as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({
        quantity_base: 2,
        sold_quantity_base: 2,
        delivered_quantity_base: 0,
      }),
    ]);
    expect(costKeys(open?.data)).toEqual([]);
    const delivered = changes.filter(
      (c) => c.entity_type === 'SALES_ORDER' && c.entity_id === deliveredOrder,
    );
    expect(delivered[delivered.length - 1]?.change_type).toBe('SCOPE_EXIT');
    expect(idsOf(changes, 'SALES_ORDER').has(orderB)).toBe(false);
  });

  it('orders : le responsable d’équipe et le magasinier de l’emplacement la reçoivent aussi', async () => {
    const team = await pull(manager, 'orders');
    expect(latest(team, 'SALES_ORDER', openOrder)?.data).toMatchObject({ id: openOrder });
    expect(idsOf(team, 'SALES_ORDER').has(orderB)).toBe(false);

    const keeper = await pull(magA, 'orders');
    const atLocation = keeper.filter(
      (c) => c.entity_type === 'SALES_ORDER' && c.entity_id === openOrder && c.data,
    );
    expect(atLocation.map((c) => c.scope_type)).toContain('LOCATION');
    expect(idsOf(keeper, 'SALES_ORDER').has(orderB)).toBe(false);

    const other = await pull(comB, 'orders');
    expect([...idsOf(other, 'SALES_ORDER')]).toEqual([orderB]);
  });

  it('sales_recent : ventes et encaissements de 7 jours, de l’utilisateur ou du PDV, sans coût', async () => {
    const own = await pull(comA, 'sales_recent');
    const sales = idsOf(own, 'SALE');
    expect(sales.has(saleOpen)).toBe(true);
    expect(sales.has(saleDelivered)).toBe(true);
    expect(sales.has(saleB)).toBe(false);
    const sale = latest(own, 'SALE', saleOpen)?.data as Record<string, unknown>;
    expect(sale).toMatchObject({ order_id: openOrder, total_xaf: 2 * PRICE, status: 'CONFIRMED' });
    expect(costKeys(sale)).toEqual([]);
    const payment = latest(own, 'CUSTOMER_PAYMENT', paymentA)?.data as Record<string, unknown>;
    expect(payment).toMatchObject({ amount_xaf: 1000, payment_method_code: 'ESPECES' });
    expect(payment['allocations']).toEqual([
      expect.objectContaining({ sale_id: saleDelivered, amount_xaf: 1000 }),
    ]);
    // La vente payée par cet encaissement reçoit son nouvel état (montant payé).
    expect(latest(own, 'SALE', saleDelivered)?.data).toMatchObject({ amount_paid_xaf: 1000 });

    const pos = await pull(venA, 'sales_recent');
    const posSales = idsOf(pos, 'SALE');
    expect(posSales.has(saleOpen)).toBe(true);
    expect(posSales.has(saleB)).toBe(false);
    // Vente d'il y a 10 jours : hors de la fenêtre, jamais servie.
    expect(posSales.has(oldSale)).toBe(false);
    expect(idsOf(pos, 'CUSTOMER_PAYMENT').has(paymentA)).toBe(true);

    expect(idsOf(await pull(magA, 'sales_recent'), 'SALE').size).toBe(0);
  });

  it('cash : la caisse du commercial et celle du PDV, avec leur solde', async () => {
    const own = await pull(comA, 'cash');
    expect(latest(own, 'CASH_ACCOUNT', cashA)?.data).toMatchObject({
      id: cashA,
      account_type: 'CAISSE_UTILISATEUR',
      balance_xaf: 1000,
    });
    expect(idsOf(own, 'CASH_ACCOUNT').has(posA)).toBe(false);

    const pos = await pull(venA, 'cash');
    expect(latest(pos, 'CASH_ACCOUNT', posA)?.data).toMatchObject({
      account_type: 'CAISSE_PDV',
      balance_xaf: PRICE,
    });
    expect(idsOf(pos, 'CASH_ACCOUNT').has(cashA)).toBe(false);
    expect(idsOf(await pull(magA, 'cash'), 'CASH_ACCOUNT').size).toBe(0);
  });

  it('customers : l’encours du compte suit ses ventes et encaissements', async () => {
    const changes = await pull(comA, 'customers');
    // 3 + 2 pièces à crédit, 1 000 encaissés ; la vente comptant d'il y a 10 jours est soldée.
    expect(latest(changes, 'CUSTOMER', custA)?.data).toMatchObject({
      id: custA,
      outstanding_xaf: 5 * PRICE - 1000,
    });
  });

  it('catalog : les moyens de paiement, sous leur clé dérivée du code (ADR-031)', async () => {
    expect(codeEntityId('PAYMENT_METHOD', 'ESPECES')).toBe('a54b88b0-36c9-59e3-8d51-3464ef06b112');
    const response = await pullService.pull(
      { dataset: 'catalog', cursor: 0, limit: 2000 },
      { authenticatedUserId: venA.userId, authenticatedDeviceId: venA.deviceId, now: NOW },
    );
    expect(
      latest(response.changes, 'PAYMENT_METHOD', codeEntityId('PAYMENT_METHOD', 'ESPECES'))?.data,
    ).toMatchObject({ code: 'ESPECES', requires_reference: false, is_active: true });
  });

  it('le repli générique GLOBAL du pipeline ne sert aucune vente ni commande', async () => {
    for (const dataset of ['sale', 'sales_order', 'customer_payment', 'delivery_note']) {
      const changes = await pull(comB, dataset);
      expect(changes.filter((c) => c.data !== undefined)).toEqual([]);
    }
  });

  it('portée d’appareil : sites de vente et caisses par droit de lecture, emplacements des commandes', async () => {
    const sitesOf = async (actor: Actor, dataset: string) =>
      (await computeDeviceScope(db, actor.userId, actor.deviceId, NOW, dataset))
        .filter((entry) => entry.scopeType === 'SITE')
        .map((entry) => entry.scopeId);
    expect(await sitesOf(venA, 'sales_recent')).toEqual([siteA]);
    expect(await sitesOf(venA, 'cash')).toEqual([siteA]);
    expect(await sitesOf(magA, 'sales_recent')).toEqual([]);
    expect(await sitesOf(magA, 'cash')).toEqual([]);
    expect(await sitesOf(comA, 'sales_recent')).toEqual([]);
    const locations = (await computeDeviceScope(db, magA.userId, magA.deviceId, NOW, 'orders'))
      .filter((entry) => entry.scopeType === 'LOCATION')
      .map((entry) => entry.scopeId);
    expect(locations).toContain(storeA);
    expect(locations).not.toContain(storeB);
  });
});
