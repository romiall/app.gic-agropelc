/**
 * Lectures HTTP des achats (P6-06, `procurement-api/`) de bout en bout : NestJS + Fastify,
 * `app.inject()` (même gabarit que crm-read.e2e.test.ts), documents écrits par le vrai pipeline
 * avec les rôles réels du seed.
 *
 * Démontre : portée SITE (magasiniers de deux sites) et ALL (responsable des achats), refus (403
 * sans droit, 404 hors portée, audité) ; masquage des prix et coûts sans
 * `inventory.valuation.read` (RC-05) ; reliquats des BC ; rapprochement d'un BC (commandé, livré,
 * rejeté, accepté, en quarantaine, reliquat, facturé) ; réceptions par période et pagination.
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

const DAY = '2026-09-22';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
  token: string;
}

describe('Lectures HTTP des achats (P6-06)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let mag: Actor;
  let magB: Actor;
  let buyer: Actor;
  let ven: Actor;
  let siteA: string;
  let siteB: string;
  let storeA: string;
  let storeB: string;
  let supplierId: string;
  let productId: string;
  let reasonId: string;
  let da1: string;
  let da2: string;
  let po1: string;
  let po1Line: string;
  let po2: string;
  let r1: string;
  let r2: string;
  const unitCode = 'SAC';

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

  async function sentOrder(locationId: string, quantity: number): Promise<string> {
    const id = freshUuid();
    await command(buyer, 'procurement.order.create', 'PURCHASE_ORDER', id, at('07:00:00'), {
      supplierId,
      deliveryLocationId: locationId,
      lines: [{ productId, unitCode, orderedQtyBase: quantity, unitPriceXaf: 1_000 }],
    });
    await command(buyer, 'procurement.order.submit', 'PURCHASE_ORDER', id, at('07:05:00'), {});
    await command(buyer, 'procurement.order.mark_sent', 'PURCHASE_ORDER', id, at('07:10:00'), {});
    return id;
  }

  async function submitRequest(actor: Actor, siteId: string): Promise<string> {
    const id = freshUuid();
    await command(actor, 'procurement.request.submit', 'PURCHASE_REQUEST', id, at('06:00:00'), {
      siteId,
      justification: 'Réassort aliment',
      lines: [{ productId, quantityBase: 40, unitCode, quantity: 40, estimatedUnitPriceXaf: 950 }],
    });
    return id;
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  const idsOf = (items: readonly { id: string }[]) => items.map((item) => item.id).sort();

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
    const jwtKeys = app.get(JWT_KEYS);

    const roles = {
      mag: await roleId('MAGASINIER'),
      ach: await roleId('RESP_ACHATS'),
      ven: await roleId('VENDEUR_PDV'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId), token: '' };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId);
      siteB = await insertTestSite(trx, adminId, zoneId);
      storeA = await insertTestLocation(trx, adminId, siteA);
      storeB = await insertTestLocation(trx, adminId, siteB);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId, token: '' };
      };
      mag = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteA });
      magB = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteB });
      buyer = await actor(roles.ach);
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: siteA });

      supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Provenderie du Moungo',
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
          name: 'Aliment ponte',
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
          label: 'Sacs mouillés',
          created_by: toBin(adminId),
        })
        .execute();
    });
    for (const actor of [admin, mag, magB, buyer, ven]) {
      actor.token = await signAccessToken(
        jwtKeys.privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
    }

    const policyId = freshUuid();
    await command(admin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, at('00:00:00'), {
      code: `PURCHASE_REQUEST_${policyId.slice(-8)}`,
      operationType: 'PURCHASE_REQUEST',
      requiresApproval: true,
      approverPermission: 'procurement.request.approve',
      approverScope: 'ALL',
    });
    const quarantinePolicy = freshUuid();
    await command(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      quarantinePolicy,
      at('00:00:00'),
      {
        code: `RECEIPT_QUARANTINE_${quarantinePolicy.slice(-8)}`,
        operationType: 'RECEIPT_QUARANTINE',
        requiresApproval: true,
        approverPermission: 'procurement.receipt_exception.approve',
        approverScope: 'ALL',
      },
    );

    da1 = await submitRequest(mag, siteA);
    da2 = await submitRequest(magB, siteB);
    po1 = await sentOrder(storeA, 20);
    po2 = await sentOrder(storeB, 5);
    const line = await db
      .selectFrom('procurement_purchase_order_lines')
      .select('id')
      .where('order_id', '=', toBin(po1))
      .executeTakeFirstOrThrow();
    po1Line = fromBin(line.id);
    const note = `BL-${freshUuid().slice(-8)}`;
    r1 = freshUuid();
    await command(mag, 'procurement.receipt.record', 'GOODS_RECEIPT', r1, at('09:00:00'), {
      purchaseOrderId: po1,
      supplierId,
      locationId: storeA,
      supplierDeliveryNoteRef: note,
      lines: [
        {
          poLineId: po1Line,
          productId,
          unitCode,
          qtyDeliveredBase: 12,
          qtyRejectedBase: 2,
          rejectionReasonCodeId: reasonId,
        },
      ],
    });
    // Même bon de livraison : quarantaine (BR-APP-012), visible au rapprochement sans compter.
    r2 = freshUuid();
    await command(mag, 'procurement.receipt.record', 'GOODS_RECEIPT', r2, at('10:00:00'), {
      purchaseOrderId: po1,
      supplierId,
      locationId: storeA,
      supplierDeliveryNoteRef: note,
      lines: [{ poLineId: po1Line, productId, unitCode, qtyDeliveredBase: 3 }],
    });
  });

  afterAll(async () => {
    await app?.close();
    await closeTestDb();
  });

  it('GET /purchase-requests : portée SITE par défaut (et ses propres DA), ALL filtrée par site ; fiche hors portée ⇒ 404', async () => {
    const own = await get(mag, '/api/v1/purchase-requests');
    expect(own.statusCode, own.body).toBe(200);
    const mine = own.json().purchase_requests as { id: string }[];
    expect(mine.map((r) => r.id)).toContain(da1);
    expect(mine.map((r) => r.id)).not.toContain(da2);

    const buyerView = await get(buyer, `/api/v1/purchase-requests?site_id=${siteB}`);
    expect(idsOf(buyerView.json().purchase_requests)).toEqual([da2]);

    const sheet = await get(mag, `/api/v1/purchase-requests/${da1}`);
    expect(sheet.statusCode).toBe(200);
    expect(sheet.json().purchase_request).toMatchObject({
      id: da1,
      status: 'SUBMITTED',
      siteId: siteA,
      estimatedTotalXaf: 38_000,
      lines: [{ productId, quantityBase: 40, orderedQtyBase: 0, remainingToOrderBase: 40 }],
    });
    expect((await get(mag, `/api/v1/purchase-requests/${da2}`)).statusCode).toBe(404);
    expect((await get(ven, '/api/v1/purchase-requests')).statusCode).toBe(403);
  });

  it('GET /purchase-orders : reliquats, portée SITE, prix masqués sans inventory.valuation.read (RC-05)', async () => {
    const buyerView = await get(buyer, `/api/v1/purchase-orders?site_id=${siteA}`);
    expect(buyerView.statusCode, buyerView.body).toBe(200);
    const [order] = buyerView.json().purchase_orders;
    expect(order).toMatchObject({ id: po1, status: 'PARTIALLY_RECEIVED', totalXaf: 20_000 });
    expect(order.lines[0]).toMatchObject({
      orderedQtyBase: 20,
      acceptedQtyBase: 10,
      remainingQtyBase: 10,
      unitPriceXaf: 1_000,
    });

    const magView = await get(mag, '/api/v1/purchase-orders');
    const visible = magView.json().purchase_orders as {
      id: string;
      totalXaf: number | null;
      lines: { unitPriceXaf: number | null; remainingQtyBase: number }[];
    }[];
    expect(visible.map((o) => o.id)).toContain(po1);
    expect(visible.map((o) => o.id)).not.toContain(po2);
    const masked = visible.find((o) => o.id === po1)!;
    expect(masked.totalXaf).toBeNull();
    expect(masked.lines[0]).toMatchObject({ unitPriceXaf: null, remainingQtyBase: 10 });

    const outside = await get(mag, `/api/v1/purchase-orders/${po2}`);
    expect(outside.statusCode).toBe(404);
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('actor_user_id', '=', toBin(mag.userId))
      .where('entity_id', '=', toBin(po2))
      .executeTakeFirstOrThrow();
    expect(denied).toEqual({ action: 'access.denied', result: 'DENIED' });
    expect((await get(ven, '/api/v1/purchase-orders')).statusCode).toBe(403);
  });

  it('GET /purchase-orders/{id}/matching : commandé, livré, rejeté, accepté, quarantaine, reliquat, facturé', async () => {
    const response = await get(buyer, `/api/v1/purchase-orders/${po1}/matching`);
    expect(response.statusCode, response.body).toBe(200);
    const { matching } = response.json();
    expect(matching.lines).toEqual([
      expect.objectContaining({
        poLineId: po1Line,
        orderedQtyBase: 20,
        deliveredQtyBase: 12,
        rejectedQtyBase: 2,
        acceptedQtyBase: 10,
        quarantinedQtyBase: 3,
        remainingQtyBase: 10,
        invoicedQtyBase: 0,
        orderedValueXaf: 20_000,
        acceptedValueXaf: 10_000,
        invoicedValueXaf: 0,
      }),
    ]);
    expect(matching.totals).toEqual({
      orderedValueXaf: 20_000,
      acceptedValueXaf: 10_000,
      invoicedValueXaf: 0,
      paidXaf: null,
    });
    const masked = (await get(mag, `/api/v1/purchase-orders/${po1}/matching`)).json().matching;
    expect(masked.lines[0]).toMatchObject({ acceptedQtyBase: 10, acceptedValueXaf: null });
    expect(masked.totals.orderedValueXaf).toBeNull();
  });

  it('GET /receipts : période, BC, pagination, coûts masqués ; fiche avec livré ≠ rejeté ≠ accepté', async () => {
    const magView = await get(mag, `/api/v1/receipts?from=${DAY}&to=${DAY}`);
    expect(magView.statusCode, magView.body).toBe(200);
    const receipts = magView.json().receipts as {
      id: string;
      status: string;
      totalAcceptedValueXaf: number | null;
    }[];
    expect(receipts.map((r) => r.id)).toEqual(expect.arrayContaining([r1, r2]));
    expect(receipts.find((r) => r.id === r2)!.status).toBe('QUARANTINED');
    expect(receipts.find((r) => r.id === r1)!.totalAcceptedValueXaf).toBeNull();
    expect((await get(magB, `/api/v1/receipts?from=${DAY}&to=${DAY}`)).json().receipts).toEqual([]);
    expect((await get(mag, '/api/v1/receipts?from=2026-02-30')).statusCode).toBe(400);

    const first = await get(buyer, `/api/v1/receipts?purchase_order_id=${po1}&limit=1`);
    const firstBody = first.json();
    expect(firstBody.receipts).toHaveLength(1);
    expect(firstBody.next_cursor).not.toBeNull();
    const second = (
      await get(
        buyer,
        `/api/v1/receipts?purchase_order_id=${po1}&limit=1&cursor=${firstBody.next_cursor}`,
      )
    ).json();
    expect(second.receipts).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(idsOf([...firstBody.receipts, ...second.receipts])).toEqual([r1, r2].sort());

    const sheet = (await get(buyer, `/api/v1/receipts/${r1}`)).json().receipt;
    expect(sheet).toMatchObject({ id: r1, status: 'POSTED', totalAcceptedValueXaf: 10_000 });
    expect(sheet.lines[0]).toMatchObject({
      qtyDeliveredBase: 12,
      qtyRejectedBase: 2,
      qtyAcceptedBase: 10,
      rejectionReasonCodeId: reasonId,
      unitCostXaf: 1_000,
    });
    expect((await get(magB, `/api/v1/receipts/${r1}`)).statusCode).toBe(404);
  });
});
