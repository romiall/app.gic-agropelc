/**
 * Projections `/sync/pull` du stock (P2-06) : jeux `stock`, `transfers`, `counts` filtrés par
 * `LOCATION` (01-architecture-offline.md §3.1), alimentés par `inventory` via
 * `platform/sync/change-feed.ts`. Données écrites par le vrai pipeline de commande et par
 * `recordStockMove` ; téléchargement par le vrai `SyncPullService`.
 *
 * Démontre : un magasinier reçoit le stock des emplacements de son site et seulement eux ; un
 * transfert parvient aux deux extrémités ; un commercial (portée OWN) ne reçoit que son stock
 * mobile ; un utilisateur sans `inventory.stock.read` ne reçoit aucun emplacement ; le repli
 * générique GLOBAL du pipeline ne sert jamais une donnée de stock ; aucune mesure financière
 * n'est projetée (RC-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerThresholdCommands } from '../src/modules/inventory/application/commands/threshold-commands.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
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

const OCCURRED_AT = '2026-10-03T09:00:00.000Z';

describe('projections /sync/pull du stock (P2-06)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;

  let admin: string;
  let adminDevice: string;
  let magA: string;
  let magB: string;
  let seller: string;
  let sedentary: string;
  let userDevice: string;

  let storeA: string;
  let storeB: string;
  let mobile: string;
  let productId: string;
  let transferId: string;
  let thresholdId: string;
  let countId: string;

  async function command(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ): Promise<void> {
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
        occurred_at: OCCURRED_AT,
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
  }

  async function pull(userId: string, dataset: string): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 500 },
      { authenticatedUserId: userId, authenticatedDeviceId: userDevice, now: clock.now() },
    );
    return response.changes;
  }

  /** Dernier état reçu par entité et périmètre (l'appareil applique les upserts dans l'ordre). */
  function latest(changes: readonly Change[], entityType: string, scopeId: string) {
    const matching = changes.filter((c) => c.entity_type === entityType && c.scope_id === scopeId);
    return matching[matching.length - 1];
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
          declaredUnitCostXaf: 700,
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    const documentSequences = new DocumentSequenceService();
    registerTransferCommands(registry, decisionRegistry, idGenerator, documentSequences);
    registerThresholdCommands(registry);
    registerCountCommands(registry, decisionRegistry, idGenerator, documentSequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);

    let siteA = '';
    let siteB = '';
    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      magA = await insertTestUser(trx);
      magB = await insertTestUser(trx);
      seller = await insertTestUser(trx);
      sedentary = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      userDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });

      const zoneId = await insertTestZone(trx, admin);
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

      const adminRole = await insertTestRole(trx, admin);
      for (const code of [
        'inventory.transfer.dispatch',
        'inventory.transfer.receive',
        'inventory.threshold.manage',
        'inventory.count.perform',
      ]) {
        await grantTestPermission(trx, adminRole, code, admin);
      }
      await assignTestRole(trx, admin, adminRole, admin);

      const magRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, magRole, 'inventory.stock.read', admin, { maxScope: 'SITE' });
      await assignTestRole(trx, magA, magRole, admin, { scopeType: 'SITE', scopeSiteId: siteA });
      await assignTestRole(trx, magB, magRole, admin, { scopeType: 'SITE', scopeSiteId: siteB });

      const sellerRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, sellerRole, 'inventory.stock.read', admin, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, seller, sellerRole, admin);

      // Affectation globale, mais sans `inventory.stock.read` : aucun emplacement à télécharger.
      const sedentaryRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, sedentaryRole, 'inventory.transfer.request', admin);
      await assignTestRole(trx, sedentary, sedentaryRole, admin);

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
      if (!unit) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
      }
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-8)}`,
          name: 'Produit de test synchronisation',
          category_id: toBin(categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'TETE',
          lot_tracking: 'NONE',
          created_by: toBin(admin),
        })
        .execute();
    });

    const maxSeq = await db
      .selectFrom('sync_change_feed')
      .select(({ fn }) => fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(maxSeq?.seq ?? 0);

    await openingBalance(storeA, 10);
    await openingBalance(storeB, 4);
    await openingBalance(mobile, 3);

    transferId = freshUuid();
    await command('inventory.transfer.dispatch', 'STOCK_TRANSFER', transferId, {
      fromLocationId: storeA,
      toLocationId: storeB,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 2 }],
    });
    thresholdId = freshUuid();
    await command('inventory.threshold.set', 'STOCK_THRESHOLD', thresholdId, {
      locationId: storeA,
      productId,
      minQtyBase: 5,
      targetQtyBase: 20,
    });
    countId = freshUuid();
    await command('inventory.count.open', 'INVENTORY_COUNT', countId, {
      locationId: storeA,
      countType: 'SPOT',
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('stock : le magasinier du site A reçoit les soldes de son site seulement, sans valeur', async () => {
    const changes = await pull(magA, 'stock');
    const scopes = new Set(changes.map((c) => c.scope_id));
    expect(scopes.has(storeA)).toBe(true);
    expect(scopes.has(mobile)).toBe(true); // emplacement mobile rattaché au site A
    expect(scopes.has(storeB)).toBe(false);
    expect(changes.every((c) => c.scope_type === 'LOCATION')).toBe(true);

    const balance = latest(changes, 'STOCK_BALANCE', storeA)!;
    expect(balance.entity_id).toBe(productId);
    expect(Number(balance.data!.qty_on_hand)).toBe(8); // 10 − 2 expédiés (état courant)
    expect(balance.data!.lots).toHaveLength(1);
    expect(JSON.stringify(balance.data)).not.toMatch(/value_xaf|unit_cost/);

    const threshold = latest(changes, 'STOCK_THRESHOLD', storeA)!;
    expect(threshold.entity_id).toBe(thresholdId);
    expect(threshold.data!.is_active).toBe(true);
  });

  it('transfers : le transfert parvient à la source et à la destination', async () => {
    const fromSide = latest(await pull(magA, 'transfers'), 'STOCK_TRANSFER', storeA)!;
    expect(fromSide.entity_id).toBe(transferId);
    expect(fromSide.data!.status).toBe('DISPATCHED');
    expect(
      Number((fromSide.data!.lines as { dispatched_qty_base: string }[])[0]!.dispatched_qty_base),
    ).toBe(2);

    const toSide = latest(await pull(magB, 'transfers'), 'STOCK_TRANSFER', storeB)!;
    expect(toSide.entity_id).toBe(transferId);
  });

  it('réception : solde de la destination et statut du transfert mis à jour pour son magasinier', async () => {
    const line = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    await command('inventory.transfer.receive', 'STOCK_TRANSFER', transferId, {
      transferId,
      lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: 2 }],
    });

    const stock = await pull(magB, 'stock');
    expect(Number(latest(stock, 'STOCK_BALANCE', storeB)!.data!.qty_on_hand)).toBe(6);
    const transfers = await pull(magB, 'transfers');
    expect(latest(transfers, 'STOCK_TRANSFER', storeB)!.data!.status).toBe('RECEIVED');
  });

  it('counts : inventaire ouvert du périmètre, sans écart valorisé', async () => {
    const count = latest(await pull(magA, 'counts'), 'INVENTORY_COUNT', storeA)!;
    expect(count.entity_id).toBe(countId);
    expect(count.data!.status).toBe('IN_PROGRESS');
    expect(JSON.stringify(count.data)).not.toMatch(/variance_value_xaf|unit_cost/);
    expect(await pull(magB, 'counts')).toHaveLength(0);
  });

  it('portée OWN : le commercial ne reçoit que son stock mobile', async () => {
    const changes = await pull(seller, 'stock');
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.scope_id === mobile)).toBe(true);
    expect(Number(latest(changes, 'STOCK_BALANCE', mobile)!.data!.qty_on_hand)).toBe(3);
  });

  it('sans inventory.stock.read : aucun emplacement, donc aucune donnée de stock', async () => {
    expect(await pull(sedentary, 'stock')).toHaveLength(0);
    expect(await pull(sedentary, 'transfers')).toHaveLength(0);
  });

  it('le repli GLOBAL du pipeline ne sert jamais une donnée de stock', async () => {
    // Ligne générique écrite par le pipeline : dataset = aggregate_type en minuscules, GLOBAL.
    const generic = await pull(sedentary, 'stock_transfer');
    expect(generic.some((c) => c.entity_id === transferId)).toBe(false);
    const rows = await db
      .selectFrom('sync_change_feed')
      .select('scope_type')
      .where('dataset', '=', 'stock_transfer')
      .where('entity_id', '=', toBin(transferId))
      .execute();
    expect(rows.length).toBeGreaterThan(0); // la ligne existe bien, c'est la projection qui la refuse
  });
});
