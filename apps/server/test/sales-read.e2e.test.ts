/**
 * Lectures HTTP des ventes et de la trésorerie (P4-10, `sales-api/`, `finance-api/`) de bout en
 * bout : NestJS + Fastify, `app.inject()` (même gabarit que production-read.e2e.test.ts), documents
 * écrits par le vrai pipeline avec les rôles réels du seed.
 *
 * Démontre : portées OWN (commerciaux affectés globalement : leurs seuls documents), SITE (vendeur
 * d'un point de vente), ALL (Finance) ; refus (403 sans droit, 404 hors portée, audité) ; coût figé
 * des lignes masqué sans `inventory.valuation.read` (RC-05) ; reçu (BR-VEN-024) ; créances et leur
 * synthèse (BR-FIN-007) ; comptes de trésorerie et leurs mouvements ; volet ventes de la fiche
 * client (encours, dernières commandes et ventes, chacune sur sa propre portée) ; réalisé `CA` des
 * objectifs (P4-13). AT-033 (part P4) : un commercial ne lit pas la vente d'un autre (404 audité).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-05';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const PRICE = 1000;
const UNIT_COST = 600;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
  token: string;
}

describe('Lectures HTTP des ventes et de la trésorerie (P4-10)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let comA: Actor;
  let comB: Actor;
  let venA: Actor;
  let fin: Actor;
  let rpr: Actor;
  let siteA: string;
  let siteB: string;
  let storeA: string;
  let storeB: string;
  let custA: string;
  let custB: string;
  let cashA: string;
  let cashB: string;
  let posA: string;
  let orderA: string;
  let orderB: string;
  let saleA: string;
  let saleB: string;
  let paymentA: string;
  let deliveryA: string;

  async function get(actor: Actor, url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${actor.token}` } });
  }

  async function command(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
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

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  const idsOf = (items: readonly { id: string }[]) => items.map((item) => item.id);
  const saleOfOrder = async (orderId: string) =>
    fromBin(
      (
        await db
          .selectFrom('sales_sales')
          .select('id')
          .where('order_id', '=', toBin(orderId))
          .executeTakeFirstOrThrow()
      ).id,
    );

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);
    const idGenerator = app.get(ID_GENERATOR);
    const jwtKeys = app.get(JWT_KEYS);

    const roles = {
      sedentary: await roleId('COMMERCIAL_SEDENTAIRE'),
      seller: await roleId('VENDEUR_PDV'),
      finance: await roleId('FINANCE'),
      production: await roleId('RESP_PRODUCTION'),
    };
    let productId = '';
    let ruleId = '';
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      siteB = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      storeA = await insertTestLocation(trx, adminId, siteA, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, adminId, siteB, { locationType: 'STORE' });
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = { scopeType: 'GLOBAL' },
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId, token: '' };
      };
      comA = await actor(roles.sedentary);
      comB = await actor(roles.sedentary);
      venA = await actor(roles.seller, { scopeType: 'SITE', scopeSiteId: siteA });
      fin = await actor(roles.finance);
      rpr = await actor(roles.production);

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
      if (
        !(await trx
          .selectFrom('finance_payment_methods')
          .select('code')
          .where('code', '=', 'ESPECES')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('finance_payment_methods')
          .values({
            code: 'ESPECES',
            label: 'Espèces',
            requires_reference: 0,
            default_account_type: 'CAISSE_UTILISATEUR',
          })
          .execute();
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
      for (const storeId of [storeA, storeB]) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            quantityBase: 20,
            fromLocationId: supplier,
            toLocationId: storeId,
            moveType: 'PURCHASE_RECEIPT',
            declaredUnitCostXaf: UNIT_COST,
            occurredAt: new Date(at('06:00:00')),
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
      const customer = async (owner: Actor, name: string): Promise<string> => {
        const id = freshUuid();
        await trx
          .insertInto('crm_customers')
          .values({
            id: toBin(id),
            stage: 'PROSPECT',
            pipeline_step_id: toBin(stepId),
            display_name: name,
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
        // INV-CRM-02 : le titulaire dénormalisé est celui de l'attribution en cours.
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
      custA = await customer(comA, 'Restaurant du port');
      custB = await customer(comB, 'Hôtel de la gare');

      const cashAccount = async (values: {
        readonly name: string;
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
            name: values.name,
            account_type: values.type,
            ...(values.holder ? { holder_user_id: toBin(values.holder.userId) } : {}),
            ...(values.siteId ? { site_id: toBin(values.siteId) } : {}),
            responsible_user_id: toBin(adminId),
            created_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      cashA = await cashAccount({ name: 'Caisse A', type: 'CAISSE_UTILISATEUR', holder: comA });
      cashB = await cashAccount({ name: 'Caisse B', type: 'CAISSE_UTILISATEUR', holder: comB });
      posA = await cashAccount({ name: 'Caisse PDV A', type: 'CAISSE_PDV', siteId: siteA });
    });
    for (const actor of [comA, comB, venA, fin, rpr]) {
      actor.token = await signAccessToken(
        jwtKeys.privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
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
    // Commande du commercial A au magasin A (3 pièces), du commercial B au magasin B (2 pièces) :
    // chacune devient une vente à la confirmation (ADR-025).
    orderA = freshUuid();
    await command(comA, 'sales.order.place', 'SALES_ORDER', orderA, at('09:00:00'), {
      customerId: custA,
      fulfilmentLocationId: storeA,
      lines: [line(3)],
    });
    orderB = freshUuid();
    await command(comB, 'sales.order.place', 'SALES_ORDER', orderB, at('09:30:00'), {
      customerId: custB,
      fulfilmentLocationId: storeB,
      lines: [line(2)],
    });
    saleA = await saleOfOrder(orderA);
    saleB = await saleOfOrder(orderB);
    // Encaissement de 1 000 XAF par le commercial A : affecté à sa vente.
    paymentA = freshUuid();
    await command(comA, 'sales.payment.record', 'CUSTOMER_PAYMENT', paymentA, at('10:00:00'), {
      customerId: custA,
      amountXaf: 1000,
      methodCode: 'ESPECES',
      cashAccountId: cashA,
    });
    // Livraison partielle de la commande A (2 pièces sur 3).
    const orderLine = await db
      .selectFrom('sales_sales_order_lines')
      .select('id')
      .where('order_id', '=', toBin(orderA))
      .executeTakeFirstOrThrow();
    deliveryA = freshUuid();
    await command(comA, 'sales.order.fulfil', 'DELIVERY_NOTE', deliveryA, at('11:00:00'), {
      orderId: orderA,
      lines: [{ orderLineId: fromBin(orderLine.id), quantityBase: 2 }],
      recipientName: 'M. Essomba',
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  // --- Ventes -----------------------------------------------------------------------------------

  it('GET /sales : le commercial ne voit que ses ventes, le vendeur celles de son site, la Finance toutes', async () => {
    const own = await get(comA, '/api/v1/sales');
    expect(own.statusCode, own.body).toBe(200);
    expect(idsOf(own.json().sales)).toEqual([saleA]);

    const site = await get(venA, `/api/v1/sales?limit=200`);
    expect(site.statusCode, site.body).toBe(200);
    const siteIds = idsOf(site.json().sales);
    expect(siteIds).toContain(saleA);
    expect(siteIds).not.toContain(saleB);
    expect(site.json().sales.every((s: { siteId: string }) => s.siteId === siteA)).toBe(true);

    const all = await get(fin, `/api/v1/sales?customer_id=${custB}`);
    expect(all.statusCode, all.body).toBe(200);
    expect(idsOf(all.json().sales)).toEqual([saleB]);
    expect(all.json().sales[0]).toMatchObject({
      orderId: orderB,
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      totalXaf: 2 * PRICE,
      balanceDueXaf: 2 * PRICE,
      commercialUserId: comB.userId,
    });

    expect((await get(rpr, '/api/v1/sales')).statusCode).toBe(403);
    expect((await get(fin, `/api/v1/sales?from=${DAY}&to=2026-10-01`)).statusCode).toBe(400);
  });

  it('GET /sales : filtres et pagination par curseur', async () => {
    const first = await get(fin, `/api/v1/sales?site_id=${siteA}&limit=1`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().sales).toHaveLength(1);
    const partial = await get(
      fin,
      `/api/v1/sales?customer_id=${custA}&payment_status=PARTIALLY_PAID&from=${DAY}&to=${DAY}`,
    );
    expect(idsOf(partial.json().sales)).toEqual([saleA]);
    const paid = await get(fin, `/api/v1/sales?customer_id=${custA}&payment_status=PAID`);
    expect(paid.json().sales).toEqual([]);
    const byCommercial = await get(fin, `/api/v1/sales?commercial_user_id=${comB.userId}`);
    expect(idsOf(byCommercial.json().sales)).toEqual([saleB]);
  });

  it('GET /sales/{id} : lignes, encaissements ; coût masqué sans droit de valorisation (RC-05)', async () => {
    const asFinance = await get(fin, `/api/v1/sales/${saleA}`);
    expect(asFinance.statusCode, asFinance.body).toBe(200);
    const sale = asFinance.json().sale;
    expect(sale).toMatchObject({
      id: saleA,
      totalXaf: 3 * PRICE,
      amountPaidXaf: 1000,
      balanceDueXaf: 2000,
      paymentStatus: 'PARTIALLY_PAID',
    });
    expect(sale.lines).toHaveLength(1);
    expect(sale.lines[0]).toMatchObject({
      quantityBase: 3,
      unitPriceXaf: PRICE,
      lineTotalXaf: 3 * PRICE,
      deliveredBase: 2,
      unitCostXaf: UNIT_COST,
      costXaf: 3 * UNIT_COST,
    });
    expect(sale.payments).toEqual([
      expect.objectContaining({ paymentId: paymentA, amountXaf: 1000, status: 'ACTIVE' }),
    ]);

    const asCommercial = await get(comA, `/api/v1/sales/${saleA}`);
    expect(asCommercial.statusCode, asCommercial.body).toBe(200);
    expect(asCommercial.json().sale.lines[0]).toMatchObject({
      unitPriceXaf: PRICE,
      unitCostXaf: null,
      costXaf: null,
    });
  });

  it('AT-033 (part P4) — GET /sales/{id} hors portée ⇒ 404 audité ; sans droit ⇒ 403', async () => {
    const outside = await get(comA, `/api/v1/sales/${saleB}`);
    expect(outside.statusCode).toBe(404);
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('actor_user_id', '=', toBin(comA.userId))
      .where('entity_id', '=', toBin(saleB))
      .executeTakeFirstOrThrow();
    expect(denied).toEqual({ action: 'access.denied', result: 'DENIED' });
    expect((await get(venA, `/api/v1/sales/${saleB}`)).statusCode).toBe(404);
    expect((await get(comA, `/api/v1/sales/${freshUuid()}`)).statusCode).toBe(404);
    expect((await get(rpr, `/api/v1/sales/${saleA}`)).statusCode).toBe(403);
  });

  it('GET /sales/{id}/receipt : reçu sans coût, encaissements et reste dû', async () => {
    const response = await get(comA, `/api/v1/sales/${saleA}/receipt`);
    expect(response.statusCode, response.body).toBe(200);
    const receipt = response.json().receipt;
    expect(receipt.docNumber).toMatch(/^VTE-/);
    expect(receipt).toMatchObject({
      businessDay: DAY,
      customer: { id: custA, name: 'Restaurant du port' },
      seller: { id: comA.userId },
      totalXaf: 3 * PRICE,
      netTotalXaf: 3 * PRICE,
      amountPaidXaf: 1000,
      balanceDueXaf: 2000,
      payments: [expect.objectContaining({ methodCode: 'ESPECES', amountXaf: 1000 })],
    });
    expect(receipt.lines).toEqual([
      {
        productName: 'Poulet de chair',
        quantity: 3,
        unitCode: 'PIECE',
        unitPriceXaf: PRICE,
        discountXaf: 0,
        lineTotalXaf: 3 * PRICE,
      },
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(/cost/i);
    expect((await get(comB, `/api/v1/sales/${saleA}/receipt`)).statusCode).toBe(404);
  });

  // --- Commandes et livraisons ------------------------------------------------------------------

  it('GET /orders et /orders/{id} : restes à vendre et à livrer, ventes et livraisons de la commande', async () => {
    const own = await get(comA, '/api/v1/orders');
    expect(own.statusCode, own.body).toBe(200);
    expect(idsOf(own.json().orders)).toEqual([orderA]);

    const detail = await get(comA, `/api/v1/orders/${orderA}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const order = detail.json().order;
    expect(order).toMatchObject({
      id: orderA,
      status: 'PARTIALLY_FULFILLED',
      customerId: custA,
      siteId: siteA,
    });
    expect(order.lines[0]).toMatchObject({
      orderedBase: 3,
      soldBase: 3,
      deliveredBase: 2,
      pendingBase: 0,
      undeliveredBase: 1,
    });
    expect(idsOf(order.sales)).toEqual([saleA]);
    expect(idsOf(order.deliveries)).toEqual([deliveryA]);

    expect((await get(comA, `/api/v1/orders/${orderB}`)).statusCode).toBe(404);
    expect((await get(venA, `/api/v1/orders/${orderB}`)).statusCode).toBe(404);
    expect((await get(venA, `/api/v1/orders/${orderA}`)).statusCode).toBe(200);
  });

  it('GET /deliveries : bons de livraison de la portée', async () => {
    const response = await get(comA, `/api/v1/deliveries?order_id=${orderA}`);
    expect(response.statusCode, response.body).toBe(200);
    const [note] = response.json().deliveries;
    expect(note).toMatchObject({
      id: deliveryA,
      orderId: orderA,
      siteId: siteA,
      deliveredByUserId: comA.userId,
      recipientName: 'M. Essomba',
      lines: [expect.objectContaining({ quantityBase: 2 })],
    });
    expect(note.docNumber).toMatch(/^LIV-/);
    const other = await get(comB, `/api/v1/deliveries?order_id=${orderA}`);
    expect(other.json().deliveries).toEqual([]);
  });

  // --- Encaissements et créances ----------------------------------------------------------------

  it('GET /payments et /payments/{id} : encaissements du receveur, affectations', async () => {
    const own = await get(comA, '/api/v1/payments');
    expect(own.statusCode, own.body).toBe(200);
    expect(idsOf(own.json().payments)).toEqual([paymentA]);
    expect(own.json().payments[0]).toMatchObject({
      status: 'RECORDED',
      amountXaf: 1000,
      unallocatedXaf: 0,
      cashAccountId: cashA,
      receivedByUserId: comA.userId,
    });
    const detail = await get(comA, `/api/v1/payments/${paymentA}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().payment.allocations).toEqual([
      expect.objectContaining({ saleId: saleA, amountXaf: 1000, status: 'ACTIVE' }),
    ]);
    expect((await get(comB, '/api/v1/payments')).json().payments).toEqual([]);
    expect((await get(comB, `/api/v1/payments/${paymentA}`)).statusCode).toBe(404);
  });

  it('GET /receivables : créances par vente, ancienneté au jour demandé et synthèse', async () => {
    const own = await get(comA, `/api/v1/receivables?as_of=${DAY}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ as_of: DAY });
    expect(own.json().receivables).toEqual([
      expect.objectContaining({
        saleId: saleA,
        customerId: custA,
        balanceDueXaf: 2000,
        overdue: false,
      }),
    ]);
    expect(own.json().summary.totalXaf).toBe(2000);

    // Échéance à 30 jours (conditions du client) : 45 jours plus tard, la créance a 15 jours de
    // retard (tranche 0-30) ; `overdue_only` et `aging` ne retiennent que les échues.
    const late = await get(fin, `/api/v1/receivables?customer_id=${custA}&as_of=2026-11-19`);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().receivables).toEqual([
      expect.objectContaining({ saleId: saleA, overdue: true, daysOverdue: 15, bucket: '0-30' }),
    ]);
    const aging = await get(fin, `/api/v1/receivables?customer_id=${custA}&aging=31-60`);
    expect(aging.json().receivables).toEqual([]);
    const notYet = await get(
      fin,
      `/api/v1/receivables?customer_id=${custA}&overdue_only=true&as_of=${DAY}`,
    );
    expect(notYet.json().receivables).toEqual([]);

    const other = await get(comB, `/api/v1/receivables?customer_id=${custA}`);
    expect(other.json().receivables).toEqual([]);
    expect((await get(rpr, '/api/v1/receivables')).statusCode).toBe(403);
  });

  // --- Trésorerie -------------------------------------------------------------------------------

  it('GET /cash-accounts : caisse du détenteur, caisses du site, toutes pour la Finance', async () => {
    const own = await get(comA, '/api/v1/cash-accounts');
    expect(own.statusCode, own.body).toBe(200);
    expect(idsOf(own.json().cash_accounts)).toEqual([cashA]);

    const site = await get(venA, `/api/v1/cash-accounts?site_id=${siteA}`);
    expect(site.statusCode, site.body).toBe(200);
    expect(idsOf(site.json().cash_accounts)).toContain(posA);
    expect(idsOf(site.json().cash_accounts)).not.toContain(cashA);

    const all = await get(fin, '/api/v1/cash-accounts?account_type=CAISSE_UTILISATEUR');
    expect(idsOf(all.json().cash_accounts)).toEqual(expect.arrayContaining([cashA, cashB]));
    expect((await get(rpr, '/api/v1/cash-accounts')).statusCode).toBe(403);
  });

  it('GET /cash-accounts/{id}/movements : mouvements du compte, hors portée ⇒ 404', async () => {
    const response = await get(comA, `/api/v1/cash-accounts/${cashA}/movements?from=${DAY}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().cash_account).toMatchObject({ id: cashA });
    expect(response.json().movements).toEqual([
      expect.objectContaining({ amountXaf: 1000, direction: 'IN', businessDate: DAY }),
    ]);
    expect(response.json().next_cursor).toBeNull();
    expect((await get(comA, `/api/v1/cash-accounts/${cashB}/movements`)).statusCode).toBe(404);
    expect((await get(fin, `/api/v1/cash-accounts/${cashA}/movements`)).statusCode).toBe(200);
  });

  // --- Réalisé des objectifs ---------------------------------------------------------------------

  it('GET /performance/commercial : réalisé CA = ventes nettes attribuées au commercial (P4-09)', async () => {
    await db
      .insertInto('crm_sales_targets')
      .values({
        id: toBin(freshUuid()),
        target_type: 'USER',
        user_id: toBin(comA.userId),
        metric: 'CA',
        period_start: new Date(`${DAY}T00:00:00.000Z`),
        period_end: new Date(`${DAY}T00:00:00.000Z`),
        target_value: 10_000,
        created_by: toBin(comA.userId),
      })
      .execute();
    const response = await get(comA, `/api/v1/performance/commercial?from=${DAY}&to=${DAY}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().targets).toEqual([
      expect.objectContaining({ metric: 'CA', realized: 3 * PRICE }),
    ]);
  });

  // --- Fiche client -----------------------------------------------------------------------------

  it('GET /customers/{id} : volet ventes (encours, dernières commandes et ventes)', async () => {
    const response = await get(comA, `/api/v1/customers/${custA}`);
    expect(response.statusCode, response.body).toBe(200);
    const sales = response.json().sales;
    expect(sales.outstandingXaf).toBe(2000);
    expect(sales.receivables.totalXaf).toBe(2000);
    expect(idsOf(sales.recent_orders)).toEqual([orderA]);
    expect(idsOf(sales.recent_sales)).toEqual([saleA]);
  });
});
