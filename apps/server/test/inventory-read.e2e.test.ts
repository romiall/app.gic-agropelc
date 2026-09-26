/**
 * Lectures HTTP du stock (P2-05, `inventory-api/`) de bout en bout : NestJS + Fastify,
 * `app.inject()` (même gabarit que audit-log.e2e.test.ts). Données écrites par le vrai
 * pipeline de commande (transfert, seuil, perte, consommation, inventaire) et par
 * `recordStockMove` (ouverture), sur une base réelle.
 *
 * Démontre : portée par site (RC-04) et par détenteur d'un emplacement `MOBILE` (01-rbac.md
 * §3), hors portée ⇒ 404 audité, droit absent ⇒ 403 audité (BR-AUD-004), montants masqués
 * sans `inventory.valuation.read` (RC-05, BR-STK-054), solde à date (stratégie stock §3.2),
 * disponible par zone (CM §62), pagination par curseur du registre, seuils BR-STK-051.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock, IdGenerator } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
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

const OPENING_AT = '2026-06-01T08:00:00.000Z';
const DISPATCH_AT = '2026-06-10T08:00:00.000Z';
const LATER_AT = '2026-06-12T08:00:00.000Z';
const OPENING_UNIT_COST_XAF = 500;

describe('Lectures HTTP du stock (P2-05)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;

  let admin: string;
  let adminDevice: string;
  let magA: string;
  let seller: string;
  let noRight: string;
  const tokens: Record<string, string> = {};

  let zoneId: string;
  let siteA: string;
  let siteB: string;
  let storeA: string;
  let storeB: string;
  let mobile: string;
  let productId: string;
  let transferId: string;
  let countId: string;

  async function get(user: string, url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens[user]}` } });
  }

  async function command(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function openingBalance(locationId: string, quantityBase: number): Promise<void> {
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase,
          fromLocationId: fromBin(opening.id),
          toLocationId: locationId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: OPENING_UNIT_COST_XAF,
          occurredAt: new Date(OPENING_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
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
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      magA = await insertTestUser(trx);
      seller = await insertTestUser(trx);
      noRight = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });

      zoneId = await insertTestZone(trx, admin);
      siteA = await insertTestSite(trx, admin, zoneId);
      siteB = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteA, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, admin, siteB, { locationType: 'STORE' });
      mobile = freshUuid();
      await trx
        .insertInto('organization_locations')
        .values({
          id: toBin(mobile),
          site_id: toBin(siteA),
          code: mobile.replace(/-/g, '').slice(-8).toUpperCase(),
          name: 'Stock mobile de test',
          location_type: 'MOBILE',
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: toBin(seller),
          created_by: toBin(admin),
        })
        .execute();

      // Direction : lecture, registre, valorisation en ALL + commandes nécessaires aux données.
      const adminRole = await insertTestRole(trx, admin);
      for (const code of [
        'inventory.stock.read',
        'inventory.ledger.read',
        'inventory.valuation.read',
        'inventory.transfer.dispatch',
        'inventory.threshold.manage',
        'inventory.loss.declare',
        'inventory.consumption.record',
        'inventory.count.perform',
      ]) {
        await grantTestPermission(trx, adminRole, code, admin);
      }
      await assignTestRole(trx, admin, adminRole, admin);

      // Magasinier du site A : portée SITE, sans valorisation (01-rbac.md §5.3, colonne MAG).
      const magRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, magRole, 'inventory.stock.read', admin, { maxScope: 'SITE' });
      await grantTestPermission(trx, magRole, 'inventory.ledger.read', admin, { maxScope: 'SITE' });
      await assignTestRole(trx, magA, magRole, admin, { scopeType: 'SITE', scopeSiteId: siteA });

      // Commercial terrain : stock OWN (son emplacement MOBILE uniquement).
      const sellerRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, sellerRole, 'inventory.stock.read', admin, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, seller, sellerRole, admin);

      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Test',
          created_by: toBin(admin),
        })
        .execute();
      const unit = await trx
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', 'TETE')
        .executeTakeFirst();
      if (!unit)
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-8)}`,
          name: 'Produit de test lecture',
          category_id: toBin(categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'TETE',
          lot_tracking: 'NONE',
          created_by: toBin(admin),
        })
        .execute();
    });

    for (const userId of [admin, magA, seller, noRight]) {
      tokens[userId] = await signAccessToken(
        jwtKeys.privateKey,
        { sub: userId, device_id: adminDevice, session_id: freshUuid() },
        clock.now(),
      );
    }

    await openingBalance(storeA, 10);
    await openingBalance(storeB, 4);
    await openingBalance(mobile, 3);

    transferId = freshUuid();
    await command('inventory.transfer.dispatch', 'STOCK_TRANSFER', transferId, DISPATCH_AT, {
      fromLocationId: storeA,
      toLocationId: storeB,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 2 }],
    });
    await command('inventory.threshold.set', 'STOCK_THRESHOLD', freshUuid(), LATER_AT, {
      locationId: storeB,
      productId,
      minQtyBase: 10,
      targetQtyBase: 30,
    });
    await command('inventory.loss.declare', 'LOSS_DECLARATION', freshUuid(), LATER_AT, {
      locationId: storeA,
      productId,
      quantityBase: 1,
      unitCode: 'TETE',
      quantity: 1,
      category: 'CASSE',
    });
    await command('inventory.consumption.record', 'CONSUMPTION', freshUuid(), LATER_AT, {
      locationId: storeA,
      productId,
      quantityBase: 1,
      unitCode: 'TETE',
      quantity: 1,
      costObjectType: 'SITE',
      costObjectId: siteA,
      costType: 'AUTRE_INTRANT',
    });
    countId = freshUuid();
    await command('inventory.count.open', 'INVENTORY_COUNT', countId, LATER_AT, {
      locationId: storeB,
      countType: 'SPOT',
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('sans Authorization : 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stock?location_id=${storeA}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('droit absent : 403, refus audité (BR-AUD-004)', async () => {
    const response = await get(noRight, `/api/v1/stock?location_id=${storeA}`);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'error_code'])
      .where('actor_user_id', '=', toBin(noRight))
      .where('action', '=', 'access.denied')
      .executeTakeFirstOrThrow();
    expect(denied.result).toBe('DENIED');
    expect(denied.error_code).toBe('FORBIDDEN');
  });

  it('paramètre manquant : 400 VALIDATION_ERROR', async () => {
    const response = await get(admin, '/api/v1/stock');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /stock — magasinier du site A : solde visible, montants masqués (RC-05)', async () => {
    const response = await get(magA, `/api/v1/stock?location_id=${storeA}`);
    expect(response.statusCode).toBe(200);
    const [line] = response.json().balances;
    // 10 (ouverture) − 2 (expédition) − 1 (perte, si RECORDED ou en attente : V_PENDING_LOSS
    // sort aussi du physique) − 1 (consommation) = 6.
    expect(line.productId).toBe(productId);
    expect(line.qtyOnHand).toBe(6);
    expect(line.qtyAvailable).toBe(6);
    expect(line.unitCostXaf).toBeNull();
    expect(line.valueXaf).toBeNull();
  });

  it('GET /stock — Direction : montants visibles (BR-STK-054 : solde × CMUP courant)', async () => {
    const response = await get(admin, `/api/v1/stock?location_id=${storeA}`);
    expect(response.statusCode).toBe(200);
    const [line] = response.json().balances;
    expect(line.unitCostXaf).toBe(OPENING_UNIT_COST_XAF);
    expect(line.valueXaf).toBe(6 * OPENING_UNIT_COST_XAF);
  });

  it('GET /stock — emplacement d’un autre site : 404 (hors portée = inexistant), refus audité', async () => {
    const response = await get(magA, `/api/v1/stock?location_id=${storeB}`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'error_code', 'entity_type'])
      .where('actor_user_id', '=', toBin(magA))
      .where('action', '=', 'access.denied')
      .executeTakeFirstOrThrow();
    expect(denied.result).toBe('DENIED');
    expect(denied.error_code).toBe('NOT_FOUND');
    expect(denied.entity_type).toBe('LOCATION');
  });

  it('GET /stock — portée OWN : le commercial ne voit que son emplacement MOBILE', async () => {
    const own = await get(seller, `/api/v1/stock?location_id=${mobile}`);
    expect(own.statusCode).toBe(200);
    expect(own.json().balances[0].qtyOnHand).toBe(3);
    const other = await get(seller, `/api/v1/stock?location_id=${storeA}`);
    expect(other.statusCode).toBe(404);
  });

  it('GET /stock/at — solde à date = Σ mouvements de occurred_at ≤ t (§3.2)', async () => {
    const before = await get(
      admin,
      `/api/v1/stock/at?location_id=${storeA}&at=2026-06-05T00:00:00.000Z`,
    );
    expect(before.statusCode).toBe(200);
    expect(before.json().balances[0].qtyOnHand).toBe(10);
    expect(before.json().balances[0].ledgerValueXaf).toBe(10 * OPENING_UNIT_COST_XAF);

    const afterDispatch = await get(
      magA,
      `/api/v1/stock/at?location_id=${storeA}&at=2026-06-11T00:00:00.000Z`,
    );
    expect(afterDispatch.json().balances[0].qtyOnHand).toBe(8);
    expect(afterDispatch.json().balances[0].ledgerValueXaf).toBeNull();
  });

  it('GET /stock/availability — Direction : toute la zone ; magasinier : son seul site', async () => {
    const all = await get(
      admin,
      `/api/v1/stock/availability?zone_id=${zoneId}&product_id=${productId}`,
    );
    expect(all.statusCode).toBe(200);
    // Emplacements commerciaux : A (6) + B (4) + mobile (3) = 13.
    expect(all.json().total_available).toBe(13);
    expect(all.json().locations).toHaveLength(3);

    const siteOnly = await get(
      magA,
      `/api/v1/stock/availability?zone_id=${zoneId}&product_id=${productId}`,
    );
    expect(siteOnly.statusCode).toBe(200);
    // Site A : magasin (6) + mobile rattaché au site A (3) ; le site B est filtré.
    expect(siteOnly.json().total_available).toBe(9);
    expect(
      (siteOnly.json().locations as { locationId: string }[]).map((l) => l.locationId).sort(),
    ).toEqual([storeA, mobile].sort());
  });

  it('GET /stock-moves — registre dans l’ordre métier, pagination par curseur', async () => {
    const first = await get(magA, `/api/v1/stock-moves?location_id=${storeA}&limit=1`);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.moves).toHaveLength(1);
    expect(firstBody.moves[0].moveType).toBe('OPENING_BALANCE');
    expect(firstBody.moves[0].direction).toBe('IN');
    expect(firstBody.moves[0].valueXaf).toBeNull();
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    const second = await get(
      magA,
      `/api/v1/stock-moves?location_id=${storeA}&limit=1&cursor=${firstBody.next_cursor}`,
    );
    expect(second.json().moves[0].moveType).toBe('TRANSFER_DISPATCH');
    expect(second.json().moves[0].direction).toBe('OUT');
    // AT-043 : remonter du mouvement au document, à l'auteur, à l'appareil et à la commande.
    expect(second.json().moves[0].sourceDocId).toBe(transferId);
    expect(second.json().moves[0].createdBy).toBe(admin);
    expect(second.json().moves[0].createdDeviceId).toBe(adminDevice);
    expect(second.json().moves[0].commandId).toEqual(expect.any(String));

    const all = await get(
      admin,
      `/api/v1/stock-moves?location_id=${storeA}&from=2026-06-01&to=2026-06-30`,
    );
    const types = (all.json().moves as { moveType: string }[]).map((m) => m.moveType);
    expect(types[0]).toBe('OPENING_BALANCE');
    expect(types).toContain('CONSUMPTION');
    expect(all.json().next_cursor).toBeNull();

    const badCursor = await get(admin, `/api/v1/stock-moves?location_id=${storeA}&cursor=abc`);
    expect(badCursor.statusCode).toBe(400);
  });

  it('GET /transfers et /transfers/{id} — visible depuis la source comme depuis la destination', async () => {
    const list = await get(admin, `/api/v1/transfers?location_id=${storeB}&direction=IN`);
    expect(list.statusCode).toBe(200);
    expect(list.json().transfers).toHaveLength(1);
    expect(list.json().transfers[0].status).toBe('DISPATCHED');

    // Le magasinier du site A n'a pas le site B, mais la source (A) est dans sa portée.
    const detail = await get(magA, `/api/v1/transfers/${transferId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().transfer.lines[0].dispatchedQtyBase).toBe(2);

    const missing = await get(admin, `/api/v1/transfers/${freshUuid()}`);
    expect(missing.statusCode).toBe(404);
  });

  it('GET /thresholds — BR-STK-051 : STOCK_LOW, transit entrant déduit de la suggestion', async () => {
    const response = await get(admin, `/api/v1/thresholds?location_id=${storeB}`);
    expect(response.statusCode).toBe(200);
    const [threshold] = response.json().thresholds;
    expect(threshold.qtyAvailable).toBe(4);
    expect(threshold.qtyInTransitIn).toBe(2);
    expect(threshold.state).toBe('STOCK_LOW');
    expect(threshold.suggestedQty).toBe(24); // 30 − 4 − 2
  });

  it('GET /losses et /consumptions — documents de l’emplacement, valeur masquée sans valorisation', async () => {
    const losses = await get(magA, `/api/v1/losses?location_id=${storeA}`);
    expect(losses.statusCode).toBe(200);
    expect(losses.json().losses).toHaveLength(1);
    expect(losses.json().losses[0].category).toBe('CASSE');
    expect(losses.json().losses[0].valueXaf).toBeNull();

    const consumptions = await get(
      admin,
      `/api/v1/consumptions?location_id=${storeA}&cost_object_type=SITE`,
    );
    expect(consumptions.statusCode).toBe(200);
    expect(consumptions.json().consumptions).toHaveLength(1);
    expect(consumptions.json().consumptions[0].valueXaf).toBe(OPENING_UNIT_COST_XAF);
  });

  it('GET /inventory-counts et /inventory-counts/{id}', async () => {
    const list = await get(admin, `/api/v1/inventory-counts?location_id=${storeB}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().inventory_counts).toHaveLength(1);

    const detail = await get(admin, `/api/v1/inventory-counts/${countId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().inventory_count.id).toBe(countId);
    expect(detail.json().inventory_count.lines).toEqual([]);

    // Inventaire du site B : hors portée du magasinier du site A.
    const outOfScope = await get(magA, `/api/v1/inventory-counts/${countId}`);
    expect(outOfScope.statusCode).toBe(404);
  });

  it('GET /costs — réservé à inventory.valuation.read (RC-05)', async () => {
    const forbidden = await get(
      magA,
      `/api/v1/costs?cost_object_type=SITE&cost_object_id=${siteA}`,
    );
    expect(forbidden.statusCode).toBe(403);

    const response = await get(
      admin,
      `/api/v1/costs?cost_object_type=SITE&cost_object_id=${siteA}`,
    );
    expect(response.statusCode).toBe(200);
    const [entry] = response.json().cost_entries;
    expect(entry.direction).toBe('DEBIT');
    expect(entry.costType).toBe('AUTRE_INTRANT');
    expect(entry.amountXaf).toBe(OPENING_UNIT_COST_XAF);
  });
});
