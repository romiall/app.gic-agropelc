/**
 * P8-11 : synthèse de la valeur des pertes (`GET /losses/summary`, BR-FIN-044, KPI-FIN-08) et vue
 * d'ensemble financière (`GET /finance/overview`, KPI-FIN-01 à 06) — portée, valorisation masquée,
 * statuts comptés, dépenses par catégorie, refus. Application complète, jetons réels.
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
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';
import { newAccount, newActor, tx, fund, type Actor } from './cash-transfer-fixtures.js';

/** Jour propre à ce fichier : la vue d'ensemble lit toute la base sur la période. */
const DAY = '2026-07-21';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
let deviceSeq = 0;

describe('P8-11 : valeur des pertes et vue d’ensemble financière', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  const tokens = new Map<string, string>();
  let root: string;
  let fin: Actor;
  let rfe: Actor;
  let terrain: Actor;
  let admin: Actor;
  let ach: Actor;
  let site: string;
  let productA: string;
  let productB: string;

  const get = (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get(actor.userId)!}` },
    });

  async function loss(input: {
    readonly productId: string;
    readonly locationId: string;
    readonly category: string;
    readonly status: string;
    readonly quantity: number;
    readonly valueXaf: number;
  }): Promise<void> {
    const id = freshUuid();
    await db
      .insertInto('inventory_loss_declarations')
      .values({
        id: toBin(id),
        doc_number: `PER-T-${id.slice(-12)}`,
        site_id: toBin(site),
        location_id: toBin(input.locationId),
        product_id: toBin(input.productId),
        quantity_base: input.quantity.toFixed(3),
        unit_code: 'TETE',
        quantity: input.quantity.toFixed(3),
        category: input.category,
        declared_by: toBin(root),
        status: input.status,
        unit_cost_xaf: Math.round(input.valueXaf / input.quantity),
        value_xaf: input.valueXaf,
        occurred_at: new Date(at('09:00')),
        created_by: toBin(root),
      })
      .execute();
  }

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
    root = await tx((trx) => insertTestUser(trx));
    const zoneId = await tx((trx) => insertTestZone(trx, root));
    site = await tx((trx) => insertTestSite(trx, root, zoneId, { siteType: 'FERME' }));
    const location = await tx((trx) => insertTestLocation(trx, root, site));
    productA = await tx((trx) => insertTestProduct(trx, root));
    productB = await tx((trx) => insertTestProduct(trx, root));
    fin = await newActor('FINANCE', root);
    rfe = await newActor('RESP_FERME', root, { scopeType: 'SITE', scopeSiteId: site });
    terrain = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    admin = await newActor('ADMIN', root);
    ach = await newActor('RESP_ACHATS', root);
    for (const actor of [fin, rfe, terrain, admin, ach]) {
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
    await loss({
      productId: productA,
      locationId: location,
      category: 'CASSE',
      status: 'APPROVED',
      quantity: 4,
      valueXaf: 8_000,
    });
    await loss({
      productId: productA,
      locationId: location,
      category: 'CASSE',
      status: 'PENDING_APPROVAL',
      quantity: 1,
      valueXaf: 2_000,
    });
    await loss({
      productId: productB,
      locationId: location,
      category: 'DETERIORATION',
      status: 'REJECTED_UNJUSTIFIED',
      quantity: 2,
      valueXaf: 3_000,
    });
    await loss({
      productId: productB,
      locationId: location,
      category: 'DETERIORATION',
      status: 'REJECTED_RETURNED',
      quantity: 9,
      valueXaf: 99_000,
    });
    await loss({
      productId: productB,
      locationId: location,
      category: 'CASSE',
      status: 'CANCELLED',
      quantity: 9,
      valueXaf: 99_000,
    });
  });

  /** Dépenses du jour propre au fichier (vue d'ensemble) : trois paiements, deux catégories. */
  async function recordExpenses(): Promise<void> {
    const categories = new Map(
      (await db.selectFrom('finance_expense_categories').select(['id', 'code']).execute()).map(
        (row) => [row.code, fromBin(row.id)],
      ),
    );
    const bank = await newAccount({ type: 'BANQUE', responsible: fin.userId });
    await fund(app.get(ID_GENERATOR), bank, 1_000_000, at('05:00'), root);
    for (const [code, amountXaf] of [
      ['TRANSPORT', 7_000],
      ['TRANSPORT', 3_000],
      ['ENTRETIEN', 4_000],
      // Au-delà du seuil de validation (justificatif joint) : en attente, hors du total (KPI-FIN-04).
      ['DIVERS', 60_000],
    ] as const) {
      const result = await pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: ++deviceSeq,
          command_version: 1,
          command_type: 'finance.expense.record',
          aggregate_type: 'EXPENSE',
          aggregate_id: freshUuid(),
          author_user_id: fin.userId,
          base_version: null,
          depends_on: [],
          occurred_at: at('10:00'),
          client_created_at: at('10:00'),
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: amountXaf > 10_000 ? [freshUuid()] : [],
          payload: {
            categoryId: categories.get(code),
            amountXaf,
            description: code,
            siteId: site,
            paidNow: true,
            paidFromAccountId: bank,
          },
        },
        {
          authenticatedUserId: fin.userId,
          authenticatedDeviceId: fin.deviceId,
          transport: 'ONLINE_API',
        },
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    }
  }

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /losses/summary : par produit et par motif, en attente à part, rendues et annulées exclues', async () => {
    const byProduct = await get(
      fin,
      `/api/v1/losses/summary?from=${DAY}&to=${DAY}&group_by=product&site_id=${site}`,
    );
    expect(byProduct.statusCode, byProduct.body).toBe(200);
    expect(byProduct.json()).toMatchObject({
      group_by: 'product',
      total_value_xaf: 11_000,
      lines: [
        {
          productId: productA,
          declarations: 1,
          quantityBase: 4,
          valueXaf: 8_000,
          pendingQuantityBase: 1,
          pendingValueXaf: 2_000,
        },
        {
          productId: productB,
          declarations: 1,
          quantityBase: 2,
          valueXaf: 3_000,
          pendingValueXaf: 0,
        },
      ],
    });
    const byReason = await get(
      fin,
      `/api/v1/losses/summary?from=${DAY}&to=${DAY}&group_by=reason&site_id=${site}`,
    );
    expect(
      (byReason.json() as { lines: { category: string; valueXaf: number }[] }).lines.map((line) => [
        line.category,
        line.valueXaf,
      ]),
    ).toEqual([
      ['CASSE', 8_000],
      ['DETERIORATION', 3_000],
    ]);
  });

  it('GET /losses/summary : Resp. ferme sans valorisation (masquée), site exigé ; portée propre 404, sans droit 403', async () => {
    const masked = await get(rfe, `/api/v1/losses/summary?from=${DAY}&to=${DAY}&site_id=${site}`);
    expect(masked.statusCode, masked.body).toBe(200);
    expect(masked.json()).toMatchObject({
      total_value_xaf: null,
      lines: [
        { productId: productA, quantityBase: 4, valueXaf: null, pendingValueXaf: null },
        { productId: productB },
      ],
    });
    expect((await get(rfe, `/api/v1/losses/summary?from=${DAY}&to=${DAY}`)).statusCode).toBe(400);
    expect(
      (await get(rfe, `/api/v1/losses/summary?from=${DAY}&to=${DAY}&site_id=${freshUuid()}`))
        .statusCode,
    ).toBe(404);
    // Portée propre (AV-094) : pas de synthèse d'un site ; aucun droit : 403.
    expect(
      (await get(terrain, `/api/v1/losses/summary?from=${DAY}&to=${DAY}&site_id=${site}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await get(admin, `/api/v1/losses/summary?from=${DAY}&to=${DAY}&site_id=${site}`)).statusCode,
    ).toBe(403);
    expect((await get(fin, `/api/v1/losses/summary?from=${DAY}&to=2026-07-01`)).statusCode).toBe(
      400,
    );
  });

  it('GET /finance/overview : dépenses du jour par catégorie, encaissé distinct du CA ; 403 sans droit', async () => {
    // La vue lit toute la base sur la période : on mesure l'écart dû aux dépenses de ce passage.
    const read = async () => {
      const response = await get(fin, `/api/v1/finance/overview?from=${DAY}&to=${DAY}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const amountOf = (
      overview: { expenses: { byCategory: { code: string; amountXaf: number }[] } },
      code: string,
    ) => overview.expenses.byCategory.find((line) => line.code === code)?.amountXaf ?? 0;
    const before = await read();
    await recordExpenses();
    const body = await read();
    expect(body.expenses.totalXaf - before.expenses.totalXaf).toBe(14_000);
    expect(body.expenses.count - before.expenses.count).toBe(3);
    expect(amountOf(body, 'TRANSPORT') - amountOf(before, 'TRANSPORT')).toBe(10_000);
    expect(amountOf(body, 'ENTRETIEN') - amountOf(before, 'ENTRETIEN')).toBe(4_000);
    expect(body.expenses.pendingXaf - before.expenses.pendingXaf).toBe(60_000);
    expect(amountOf(body, 'DIVERS') - amountOf(before, 'DIVERS')).toBe(0);
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining([
        'revenue',
        'collected',
        'receivables',
        'expenses',
        'payables',
        'cash',
      ]),
    );
    expect(body.revenue).toHaveProperty('netRevenueXaf');
    expect(body.collected).toHaveProperty('amountXaf');
    expect(body.cash.totalXaf).toBe(
      Object.values(body.cash.byAccountType as Record<string, number>).reduce(
        (sum, value) => sum + value,
        0,
      ),
    );
    expect((await get(terrain, `/api/v1/finance/overview?from=${DAY}&to=${DAY}`)).statusCode).toBe(
      403,
    );
    expect(
      (await get(fin, '/api/v1/finance/overview?from=2026-07-22&to=2026-07-21')).statusCode,
    ).toBe(400);
  });

  it('revue de P8-14 : vue d’ensemble par bloc selon les droits, créances par tranche ; dates impossibles 400 ; pertes sans valorisation triées par quantité', async () => {
    const overview = (actor: Actor, from = DAY, to = DAY) =>
      get(actor, `/api/v1/finance/overview?from=${from}&to=${to}`);
    // Le Resp. achats lit dettes et dépenses, pas le CA, l'encaissé, les créances ni la trésorerie.
    const purchasing = await overview(ach);
    expect(purchasing.statusCode, purchasing.body).toBe(200);
    expect(purchasing.json()).toMatchObject({
      revenue: null,
      collected: null,
      receivables: null,
      cash: null,
      payables: { balanceXaf: expect.any(Number) },
      expenses: { totalXaf: expect.any(Number) },
    });
    const finance = await overview(fin);
    const receivables = (
      finance.json() as {
        receivables: { overdueXaf: number; buckets: Record<string, number> };
      }
    ).receivables;
    expect(Object.keys(receivables.buckets).sort()).toEqual(['0-30', '31-60', '61-90', '>90']);
    expect(Object.values(receivables.buckets).reduce((sum, value) => sum + value, 0)).toBe(
      receivables.overdueXaf,
    );
    expect((await overview(fin, '2026-02-30', '2026-03-01')).statusCode).toBe(400);
    expect(
      (await get(fin, `/api/v1/losses/summary?from=2026-02-30&to=2026-03-01&site_id=${site}`))
        .statusCode,
    ).toBe(400);

    // Beaucoup d'unités de peu de valeur : l'ordre par valeur et l'ordre par quantité diffèrent.
    const productC = await tx((trx) => insertTestProduct(trx, root));
    await loss({
      productId: productC,
      locationId: await tx((trx) => insertTestLocation(trx, root, site)),
      category: 'CASSE',
      status: 'APPROVED',
      quantity: 10,
      valueXaf: 1_000,
    });
    const order = async (actor: Actor) =>
      (
        (
          await get(
            actor,
            `/api/v1/losses/summary?from=${DAY}&to=${DAY}&site_id=${site}&group_by=product`,
          )
        ).json() as { lines: { productId: string }[] }
      ).lines.map((line) => line.productId);
    expect(await order(fin)).toEqual([productA, productB, productC]);
    expect(await order(rfe)).toEqual([productC, productA, productB]);
  });
});
