/**
 * Vente et quotas d'appareil, P5-11 (BR-VEN-018, BR-VEN-027, BR-STK-011, 013, 016 ; ADR-028 §4,
 * ADR-033 §4 à §8 ; AV-025, AV-161, AV-163, AV-166 ; INV-STK-10, INV-STK-11, INV-STK-19, INV-STK-20),
 * à travers le vrai pipeline de commandes et, pour les faits hors ligne, le vrai service de
 * synchronisation avec le harnais multi-appareils (`OfflineDevice`) :
 *
 * - `sales.sale.record` consomme le quota du couple (auteur, appareil de l'inbox), puis le stock libre ;
 *   en ligne, refus sans effet au-delà ; hors ligne, fait appliqué et avertissements remontés ;
 * - AT-003 : la tablette bloque (`decideLocalConsumption`), un appareil modifié pousse quand même, le
 *   serveur applique et signale `ALLOCATION_EXCEEDED` (miroir `offlineAllocationSignal`) ;
 * - garde d'appareil, quota révoqué ou échu, tablette partagée, rejeu, concurrence, annulation ;
 * - aucune opération du serveur (confirmation, hausse, livraison, régularisation, annulation de
 *   commande) ne consomme ni n'entame un quota.
 *
 * Paiements : ventes à crédit seulement (aucune espèce au PDV, pour rester valides avec P5-14).
 * Hygiène de la base partagée : date fixe passée, réglages par site sur des sites neufs, quotas
 * restés actifs révoqués en fin de fichier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, decideLocalConsumption, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerAllocationCommands } from '../src/modules/inventory/application/commands/allocation-commands.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import {
  createStockLot,
  recordCostEntry,
  recordStockMove,
  setStockLotSellableFromRearing,
  verifyStockLedger,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { NetworkDownError, OfflineDevice } from './device-harness.js';
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
  freshPhone,
} from './helpers.js';

const DAY = '2026-10-09';
const NOW = `${DAY}T18:00:00.000Z`;
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
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

type Result = Awaited<ReturnType<CommandPipelineService['handle']>> | CommandResult;

describe('vente et quotas d’appareil (P5-11)', () => {
  const clock = new FixedClock(new Date(NOW));
  const idGenerator: IdGenerator = new Uuidv7Generator(clock);
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };

  let admin: Actor;
  let manager: Actor;
  let sellerA: Actor;
  let sellerB: Actor;
  let commercial: Actor;
  let terrain: Actor;
  let counter: Actor;
  let terrainSecondDevice: string;
  let zoneId: string;
  let pdvSiteId: string;
  let posId: string;
  let storeId: string;
  let exclusivePosId: string;
  let mobileId: string;
  let buildingId: string;
  let optionSeller: Actor;
  let optionPosId: string;
  let neverSeller: Actor;
  let neverPosId: string;
  let categoryId: string;
  let customerId: string;
  const granted: string[] = [];

  const code = (r: Result) => (r.status === 'REJECTED' ? r.error?.code : r.status);
  const warningsOf = (r: Result) =>
    r.status === 'APPLIED_WITH_WARNINGS' ? [...(r.warnings ?? [])] : [];
  const refsOf = (r: Result): Record<string, string> =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS'
      ? ((r as { server_refs?: Record<string, string> }).server_refs ?? {})
      : {};

  // --- Commandes ---------------------------------------------------------------------------------

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly commandId?: string } = {},
  ) {
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

  const line = (product: Sellable, quantity: number) => ({
    productId: product.id,
    quantity,
    unitCode: product.unit,
    quantityBase: quantity,
    listUnitPriceXaf: product.price,
    priceRuleId: product.ruleId,
    unitPriceXaf: product.price,
  });

  /** Vente à crédit d'une ligne (aucune espèce : indépendante des sessions de caisse de P5-14). */
  const saleBody = (locationId: string, product: Sellable, quantity: number) => ({
    fromLocationId: locationId,
    customerId,
    lines: [line(product, quantity)],
  });

  async function sellOnline(
    actor: Actor,
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly id?: string; readonly commandId?: string } = {},
  ) {
    const id = options.id ?? freshUuid();
    const result = await run(actor, 'sales.sale.record', 'SALE', id, occurredAt, body, options);
    return { id, result };
  }

  /** Vente saisie hors ligne sur `tablet` par `author`, puis synchronisée (vrai service de push). */
  async function sellOffline(
    tablet: OfflineDevice,
    author: string,
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly id?: string } = {},
  ) {
    const id = options.id ?? freshUuid();
    const envelope = tablet.enqueue(author, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: id,
      occurredAt,
      payload: body,
    });
    await tablet.sync(author);
    const result = tablet.resultOf(envelope.command_id);
    if (!result) throw new Error('Aucune réponse du serveur.');
    return { id, result, commandId: envelope.command_id };
  }

  /**
   * Une seule instance par appareil pour tout le fichier : son compteur `device_seq` est unique
   * (contrainte `(device_id, device_seq)` de l'inbox), comme sur un vrai appareil.
   */
  const tablets = new Map<string, OfflineDevice>();
  const tabletOf = (actor: Actor | string): OfflineDevice => {
    const deviceId = typeof actor === 'string' ? actor : actor.deviceId;
    let tablet = tablets.get(deviceId);
    if (!tablet) {
      tablet = new OfflineDevice(services, deviceId, clock);
      tablets.set(deviceId, tablet);
    }
    return tablet;
  };

  async function grant(
    holder: Actor,
    productId: string,
    quantityBase: number,
    options: {
      readonly locationId?: string;
      readonly validityHours?: number;
      readonly when?: string;
      readonly by?: Actor;
    } = {},
  ): Promise<string> {
    const id = freshUuid();
    const result = await run(
      options.by ?? manager,
      'inventory.allocation.grant',
      'STOCK_ALLOCATION',
      id,
      options.when ?? at('07:00:00'),
      {
        holderUserId: holder.userId,
        holderDeviceId: holder.deviceId,
        locationId: options.locationId ?? posId,
        productId,
        quantityBase,
        ...(options.validityHours !== undefined ? { validityHours: options.validityHours } : {}),
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    granted.push(id);
    return id;
  }

  async function revoke(id: string, when: string): Promise<void> {
    clock.setTo(new Date(when));
    try {
      const result = await run(
        manager,
        'inventory.allocation.revoke',
        'STOCK_ALLOCATION',
        id,
        when,
        {
          reason: 'Reprise du stock (test P5-11)',
        },
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    } finally {
      clock.setTo(new Date(NOW));
    }
  }

  // --- Données -----------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function ensureUnit(unit: string): Promise<void> {
    const exists = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', unit)
      .executeTakeFirst();
    if (!exists) {
      await db
        .insertInto('catalog_units')
        .values({ code: unit, name: unit, is_count: 1 })
        .execute();
    }
  }

  async function ensureChannel(channel: string): Promise<void> {
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

  async function sellable(
    price = 1000,
    options: { readonly biological?: boolean } = {},
  ): Promise<Sellable> {
    const id = freshUuid();
    const unit = options.biological ? 'TETE' : 'PIECE';
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: options.biological ? 'Porc charcutier' : 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: options.biological ? 'BIOLOGIQUE' : 'MARCHANDISE',
        species: options.biological ? 'PORC' : null,
        base_unit_code: unit,
        pricing_mode: 'PER_UNIT',
        lot_tracking: options.biological ? 'REQUIRED' : 'NONE',
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

  async function stock(productId: string, quantity: number, location = posId): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: location,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: 600,
          occurredAt: new Date(`${DAY}T05:00:00.000Z`),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  // --- Lectures ----------------------------------------------------------------------------------

  const quota = (id: string) =>
    db
      .selectFrom('inventory_stock_allocations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const remainingOf = async (id: string) => Number((await quota(id)).quantity_remaining);
  const entries = (id: string) =>
    db
      .selectFrom('inventory_stock_allocation_entries')
      .select(['entry_type', 'quantity', 'stock_move_id'])
      .where('allocation_id', '=', toBin(id))
      .execute();
  const entryTypes = async (id: string) => (await entries(id)).map((row) => row.entry_type).sort();
  const consumeEntriesOfProduct = async (productId: string) =>
    db
      .selectFrom('inventory_stock_allocation_entries')
      .innerJoin(
        'inventory_stock_allocations',
        'inventory_stock_allocations.id',
        'inventory_stock_allocation_entries.allocation_id',
      )
      .select(['inventory_stock_allocation_entries.entry_type as entry_type'])
      .where('inventory_stock_allocations.product_id', '=', toBin(productId))
      .where('inventory_stock_allocation_entries.entry_type', 'in', ['CONSUME', 'RESTORE'])
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
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirst();
  const flagsOf = (row: { readonly flags: unknown } | undefined): string[] =>
    (typeof row?.flags === 'string' ? JSON.parse(row.flags) : row?.flags) as string[];
  const saleMoves = (saleId: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('source_doc_type', '=', 'SALE')
      .where('source_doc_id', '=', toBin(saleId))
      .where('move_type', '=', 'SALE')
      .orderBy('quantity', 'desc')
      .execute();
  const movesByType = (productId: string, moveType: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('product_id', '=', toBin(productId))
      .where('move_type', '=', moveType as 'SALE')
      .execute();
  /** Conflits d'un type rattachés à un document source (`details.sourceDocId`). */
  const conflictsOf = (type: string, sourceDocId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['entity_type', 'entity_id', 'owner_role', 'applied', 'status', 'details'])
      .where('conflict_type', '=', type)
      .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.sourceDocId')) = ${sourceDocId}`)
      .execute();
  /** Conflits d'un type ouverts sur l'emplacement (`LOCATION`) pour un produit. */
  const locationConflicts = (type: string, locationId: string, productId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['entity_type', 'owner_role', 'applied', 'status', 'details'])
      .where('conflict_type', '=', type)
      .where('entity_type', '=', 'LOCATION')
      .where('entity_id', '=', toBin(locationId))
      .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) = ${productId}`)
      .execute();
  const details = (row: { readonly details: unknown } | undefined) =>
    (row?.details ?? {}) as Record<string, unknown>;

  /** INV-STK-20 : reste = Σ entrées, reste ≥ 0, consommation nette du registre = Σ mouvements portant le quota. */
  async function expectQuotaInvariants(id: string): Promise<void> {
    const rows = await entries(id);
    const milli = (value: unknown) => Math.round(Number(value) * 1000);
    const total = rows.reduce((sum, row) => sum + milli(row.quantity), 0);
    const row = await quota(id);
    expect(total).toBe(milli(row.quantity_remaining));
    expect(Number(row.quantity_remaining)).toBeGreaterThanOrEqual(0);
    expect(Number(row.quantity_remaining)).toBeLessThanOrEqual(Number(row.quantity_granted));
    const netConsumed = rows
      .filter((entry) => entry.entry_type === 'CONSUME' || entry.entry_type === 'RESTORE')
      .reduce((sum, entry) => sum - milli(entry.quantity), 0);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select(['quantity', 'move_type'])
      .where('allocation_id', '=', toBin(id))
      .execute();
    const netMoved = moves.reduce(
      (sum, move) =>
        sum + (move.move_type === 'CUSTOMER_RETURN' ? -milli(move.quantity) : milli(move.quantity)),
      0,
    );
    expect(netConsumed).toBe(netMoved);
  }

  /** INV-STK-10, 19, 20 et registre en partie double sur les produits du scénario. */
  async function expectLedgerOk(productIds: readonly string[]): Promise<void> {
    const verification = await db
      .transaction()
      .execute((trx) => verifyStockLedger(trx, { productIds }));
    expect(verification.allocationBreaches).toEqual([]);
    expect(verification.overcommitBreaches).toEqual([]);
    expect(verification.ok, JSON.stringify(verification)).toBe(true);
  }

  // --- Préparation -------------------------------------------------------------------------------

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerSaleCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerOrderCommands(registry, idGenerator, sequences);
    registerDeliveryCommands(registry, idGenerator, sequences);
    registerAllocationCommands(registry, idGenerator);
    registerCountCommands(registry, decisions, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    for (const unit of ['PIECE', 'TETE']) await ensureUnit(unit);
    for (const channel of ['POINT_DE_VENTE', 'TERRAIN', 'SEDENTAIRE', 'DIRECT']) {
      await ensureChannel(channel);
    }

    const roles = {
      seller: await roleId('VENDEUR_PDV'),
      storekeeper: await roleId('MAGASINIER'),
      sedentary: await roleId('COMMERCIAL_SEDENTAIRE'),
      terrain: await roleId('COMMERCIAL_TERRAIN'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      zoneId = await insertTestZone(trx, adminId);
      pdvSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'POINT_DE_VENTE' });
      const optionSiteId = await insertTestSite(trx, adminId, zoneId, {
        siteType: 'POINT_DE_VENTE',
      });
      const neverSiteId = await insertTestSite(trx, adminId, zoneId, {
        siteType: 'POINT_DE_VENTE',
      });
      const farmSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      posId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'POS' });
      storeId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'STORE' });
      optionPosId = await insertTestLocation(trx, adminId, optionSiteId, { locationType: 'POS' });
      neverPosId = await insertTestLocation(trx, adminId, neverSiteId, { locationType: 'POS' });
      buildingId = await insertTestLocation(trx, adminId, farmSiteId, {
        locationType: 'BUILDING',
      });

      const actor = async (
        role: string,
        assignments: readonly Parameters<typeof assignTestRole>[4][],
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        for (const options of assignments) {
          await assignTestRole(trx, userId, role, adminId, options);
        }
        return { userId, deviceId };
      };
      const site = (id: string) => ({ scopeType: 'SITE' as const, scopeSiteId: id });
      manager = await actor(roles.storekeeper, [
        site(pdvSiteId),
        site(optionSiteId),
        site(neverSiteId),
        site(farmSiteId),
      ]);
      sellerA = await actor(roles.seller, [site(pdvSiteId)]);
      sellerB = await actor(roles.seller, [site(pdvSiteId)]);
      optionSeller = await actor(roles.seller, [site(optionSiteId)]);
      neverSeller = await actor(roles.seller, [site(neverSiteId)]);
      commercial = await actor(roles.sedentary, [{ scopeType: 'GLOBAL' }]);
      terrain = await actor(roles.terrain, [{ scopeType: 'ZONE', scopeZoneId: zoneId }]);
      terrainSecondDevice = await insertTestDevice(trx, terrain.userId, { status: 'ACTIVE' });
      // Inventaire d'un emplacement (AT-049 de bout en bout) : rôle de test limité à `count.perform`.
      const countRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, countRole, 'inventory.count.perform', adminId);
      counter = await actor(countRole, [{ scopeType: 'GLOBAL' }]);

      // PDV mono-tablette : garde EXCLUSIVE_DEVICE, appareil désigné = la tablette du vendeur A.
      exclusivePosId = await insertTestLocation(trx, adminId, pdvSiteId, { locationType: 'POS' });
      await trx
        .updateTable('organization_locations')
        .set({ custody_mode: 'EXCLUSIVE_DEVICE', designated_device_id: toBin(sellerA.deviceId) })
        .where('id', '=', toBin(exclusivePosId))
        .execute();
      // Stock mobile du commercial terrain (garde EXCLUSIVE_USER), appareil principal défini.
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
      await trx
        .updateTable('identity_users')
        .set({ primary_device_id: toBin(terrain.deviceId) })
        .where('id', '=', toBin(terrain.userId))
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
          label: 'Terrain',
          created_by: toBin(adminId),
        })
        .execute();
      customerId = freshUuid();
      await trx
        .insertInto('crm_customers')
        .values({
          id: toBin(customerId),
          stage: 'PROSPECT',
          pipeline_step_id: toBin(stepId),
          display_name: 'Épicerie du marché',
          phone_primary: await freshPhone(),
          zone_id: toBin(zoneId),
          source_code: sourceCode,
          acquired_by_user_id: toBin(adminId),
          acquired_at: new Date('2026-01-01T00:00:00.000Z'),
          occurred_at: new Date('2026-01-01T00:00:00.000Z'),
          credit_allowed: 1,
          credit_limit_xaf: 1_000_000_000,
          created_by: toBin(adminId),
        })
        .execute();

      // Site « option » : vente hors ligne au-delà du quota autorisée et signalée (AV-025 (b)) et
      // signal de toute vente hors ligne sans quota (AV-166, ALWAYS). Site « never » : AV-166, NEVER.
      await trx
        .insertInto('organization_system_settings')
        .values([
          {
            id: toBin(freshUuid()),
            key: 'sales.offline_over_allocation_allowed',
            value: jsonValue(true),
            scope_type: 'SITE',
            scope_id: toBin(optionSiteId),
            valid_from: new Date('2026-10-01T00:00:00.000Z'),
            created_by: toBin(adminId),
          },
          {
            id: toBin(freshUuid()),
            key: 'sales.offline_unallocated_sale_signal',
            value: jsonValue('ALWAYS'),
            scope_type: 'SITE',
            scope_id: toBin(optionSiteId),
            valid_from: new Date('2026-10-01T00:00:00.000Z'),
            created_by: toBin(adminId),
          },
          {
            id: toBin(freshUuid()),
            key: 'sales.offline_unallocated_sale_signal',
            value: jsonValue('NEVER'),
            scope_type: 'SITE',
            scope_id: toBin(neverSiteId),
            valid_from: new Date('2026-10-01T00:00:00.000Z'),
            created_by: toBin(adminId),
          },
        ])
        .execute();
    });
  });

  afterAll(async () => {
    // Hygiène de la base partagée : aucun quota de ce fichier ne reste actif (tâche d'échéance,
    // balayages complets des autres fichiers).
    try {
      for (const id of granted) {
        if ((await quota(id)).status === 'ACTIVE') await revoke(id, at('17:59:00'));
      }
    } finally {
      await closeTestDb();
    }
  });

  // --- Vente directe en ligne ------------------------------------------------------------------------

  describe('en ligne : quota du couple, puis stock libre (BR-VEN-018)', () => {
    it('dans le quota : mouvement rattaché au quota, entrée CONSUME, couple lu dans l’inbox, jeu `allocations` publié', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 30);

      const { id: saleId, result } = await sellOnline(
        sellerA,
        saleBody(posId, product, 10),
        at('09:00:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      const [move] = await saleMoves(saleId);
      expect(fromBin(move!.created_by)).toBe(sellerA.userId);
      expect(fromBin(move!.created_device_id!)).toBe(sellerA.deviceId);
      expect(fromBin(move!.allocation_id!)).toBe(id);
      const consume = (await entries(id)).filter((entry) => entry.entry_type === 'CONSUME');
      expect(consume.map((entry) => entry.quantity)).toEqual(['-10.000']);
      expect(fromBin(consume[0]!.stock_move_id!)).toBe(fromBin(move!.id));
      expect(await remainingOf(id)).toBe(20);
      expect(await onHand(product.id)).toBe(90);
      expect(flagsOf(await saleRow(saleId))).toEqual([]);

      // Le nouveau reste est publié vers le seul appareil détenteur (jeu `allocations`, P5-08).
      const row = await quota(id);
      const feed = await db
        .selectFrom('sync_change_feed')
        .select(['scope_type', 'scope_id', 'row_version'])
        .where('dataset', '=', 'allocations')
        .where('entity_id', '=', toBin(id))
        .execute();
      expect(
        feed.some(
          (change) =>
            change.scope_type === 'DEVICE' &&
            fromBin(change.scope_id!) === sellerA.deviceId &&
            change.row_version === row.version,
        ),
      ).toBe(true);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('au-delà du quota, dans le stock libre : vente normale scindée, ni avertissement ni conflit', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 10);

      const { id: saleId, result } = await sellOnline(
        sellerA,
        saleBody(posId, product, 15),
        at('09:10:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      const moves = await saleMoves(saleId);
      expect(
        moves.map((m) => [Number(m.quantity), m.allocation_id ? fromBin(m.allocation_id) : null]),
      ).toEqual([
        [10, id],
        [5, null],
      ]);
      expect(await remainingOf(id)).toBe(0);
      expect(await conflictsOf('ALLOCATION_EXCEEDED', saleId)).toHaveLength(0);
      expect(flagsOf(await saleRow(saleId))).toEqual([]);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('au-delà du quota et du stock libre : REJECTED ALLOCATION_EXCEEDED sans aucun effet, numéro VTE non consommé', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const idA = await grant(sellerA, product.id, 15);
      const idB = await grant(sellerB, product.id, 5);

      const first = await sellOnline(sellerB, saleBody(posId, product, 1), at('09:20:00'));
      expect(first.result.status).toBe('APPLIED');
      const refused = await sellOnline(sellerA, saleBody(posId, product, 16), at('09:21:00'));
      expect(code(refused.result)).toBe('ALLOCATION_EXCEEDED');
      expect(refused.result.status === 'REJECTED' && refused.result.error?.message_fr).toMatch(
        /^Allocation dépassée : il vous reste 15\.000/,
      );
      expect(await saleRow(refused.id)).toBeUndefined();
      expect(await saleMoves(refused.id)).toHaveLength(0);
      expect(await remainingOf(idA)).toBe(15);
      expect(await onHand(product.id)).toBe(19);

      const exact = await sellOnline(sellerA, saleBody(posId, product, 15), at('09:22:00'));
      expect(exact.result.status).toBe('APPLIED');
      // Le refus n'a pas consommé de numéro : la vente suivante suit immédiatement la première.
      const seq = (r: Result) => Number(refsOf(r)['docNumber']!.split('-').at(-1));
      expect(seq(exact.result)).toBe(seq(first.result) + 1);
      expect(await remainingOf(idA)).toBe(0);
      expect(await remainingOf(idB)).toBe(4); // le quota de l'autre détenteur est intact (BR-STK-011)
      await expectQuotaInvariants(idA);
      await expectQuotaInvariants(idB);
      await expectLedgerOk([product.id]);
    });

    it('vendeur sans quota sur un PDV dont le stock est promis aux autres : stock libre seulement, sinon INSUFFICIENT_STOCK', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const idA = await grant(sellerA, product.id, 15);

      const refused = await sellOnline(sellerB, saleBody(posId, product, 6), at('09:30:00'));
      expect(code(refused.result)).toBe('INSUFFICIENT_STOCK');
      expect(refused.result.status === 'REJECTED' && refused.result.error?.message_fr).toContain(
        'alloué à d’autres appareils',
      );
      const free = await sellOnline(sellerB, saleBody(posId, product, 5), at('09:31:00'));
      expect(free.result.status).toBe('APPLIED');
      expect(await remainingOf(idA)).toBe(15);
      expect(await entryTypes(idA)).toEqual(['GRANT']);
      await expectLedgerOk([product.id]);
    });

    it('concurrence : deux ventes de 8 du même couple sur un quota de 10 sans stock libre → une seule passe, l’autre refusée (jamais RETRY_LATER)', async () => {
      const product = await sellable();
      await stock(product.id, 10);
      const id = await grant(sellerA, product.id, 10);

      const [one, two] = await Promise.all([
        sellOnline(sellerA, saleBody(posId, product, 8), at('09:40:00')),
        sellOnline(sellerA, saleBody(posId, product, 8), at('09:40:01')),
      ]);
      const codes = [code(one.result), code(two.result)].sort();
      expect(codes).toEqual(['ALLOCATION_EXCEEDED', 'APPLIED']);
      expect(await remainingOf(id)).toBe(2);
      expect(await onHand(product.id)).toBe(2);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });
  });

  // --- Hors ligne : fait accompli, AT-003 --------------------------------------------------------------

  describe('hors ligne : fait accompli et miroir serveur d’AT-003', () => {
    it('AT-003 : la tablette bloque au-delà du quota ; l’appareil modifié pousse quand même → appliquée + ALLOCATION_EXCEEDED', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 30);
      const row = await quota(id);

      // Ce que décide la tablette (même fonction que le serveur, ADR-021).
      const local = decideLocalConsumption({
        custodyMode: 'SHARED',
        requested: 31,
        localBalance: 0,
        holdsQuota: true,
        quotaRemaining: Number(row.quantity_remaining),
        quotaValidUntil: row.valid_until,
        now: new Date(at('10:00:00')),
        overAllocationAllowed: false,
      });
      expect(local).toEqual({
        allowed: false,
        code: 'ALLOCATION_EXCEEDED',
        messageFr: 'Allocation dépassée : il vous reste 30, 31 demandé(s).',
        available: 30,
      });

      // Appareil modifié : la vente refusée à l'écran est quand même poussée.
      const tablet = tabletOf(sellerA);
      const { id: saleId, result } = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 31),
        at('10:00:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(result)).toEqual(['ALLOCATION_EXCEEDED']);
      expect(flagsOf(await saleRow(saleId))).toEqual(['ALLOCATION_EXCEEDED']);
      expect(await remainingOf(id)).toBe(0);
      expect(await onHand(product.id)).toBe(69);
      const moves = await saleMoves(saleId);
      expect(
        moves.map((m) => [Number(m.quantity), m.allocation_id ? fromBin(m.allocation_id) : null]),
      ).toEqual([
        [30, id],
        [1, null],
      ]);
      const [conflict] = await conflictsOf('ALLOCATION_EXCEEDED', saleId);
      expect(conflict).toMatchObject({
        entity_type: 'STOCK_ALLOCATION',
        owner_role: 'MAGASINIER',
        applied: 1,
      });
      expect(fromBin(conflict!.entity_id)).toBe(id);
      expect(details(conflict)).toMatchObject({
        reason: 'ALLOCATION_EXCEEDED',
        allocationId: id,
        requested: '31.000',
        quotaRemaining: '30.000',
        excess: '1.000',
        signalled: false,
        userId: sellerA.userId,
        deviceId: sellerA.deviceId,
        sourceDocType: 'SALE',
      });
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('AT-003, option « autorisée et signalée » du site : la tablette laisse passer, le serveur signale (signalled = true)', async () => {
      const product = await sellable();
      await stock(product.id, 100, optionPosId);
      const id = await grant(optionSeller, product.id, 30, { locationId: optionPosId });
      const row = await quota(id);
      expect(
        decideLocalConsumption({
          custodyMode: 'SHARED',
          requested: 31,
          localBalance: 0,
          holdsQuota: true,
          quotaRemaining: Number(row.quantity_remaining),
          quotaValidUntil: row.valid_until,
          now: new Date(at('10:05:00')),
          overAllocationAllowed: true,
        }),
      ).toEqual({ allowed: true, signalled: 'ALLOCATION_EXCEEDED' });

      const { id: saleId, result } = await sellOffline(
        tabletOf(optionSeller),
        optionSeller.userId,
        saleBody(optionPosId, product, 31),
        at('10:05:00'),
      );
      expect(warningsOf(result)).toEqual(['ALLOCATION_EXCEEDED']);
      const [conflict] = await conflictsOf('ALLOCATION_EXCEEDED', saleId);
      expect(details(conflict)).toMatchObject({ reason: 'ALLOCATION_EXCEEDED', signalled: true });
      await expectQuotaInvariants(id);
    });

    it('INV-STK-10 : quota et stock libre épuisés hors ligne → reste ramené à 0 (jamais négatif), ALLOCATION_OVERCOMMITTED, puis STOCK_NEGATIVE', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const idA = await grant(sellerA, product.id, 10);
      const idB = await grant(sellerB, product.id, 8);
      const tablet = tabletOf(sellerA);

      // 10 du quota, 2 libres, 2 pris sur le stock promis à B.
      const first = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 14),
        at('10:10:00'),
      );
      expect(warningsOf(first.result)).toEqual(['ALLOCATION_EXCEEDED', 'ALLOCATION_OVERCOMMITTED']);
      expect(await remainingOf(idA)).toBe(0);
      expect(await remainingOf(idB)).toBe(8);
      expect(await onHand(product.id)).toBe(6);
      const [exceeded] = await conflictsOf('ALLOCATION_EXCEEDED', first.id);
      expect(details(exceeded)).toMatchObject({
        excess: '4.000',
        takenFromFreeStock: '2.000',
        shortfall: '2.000',
      });
      const overcommitted = await locationConflicts('ALLOCATION_OVERCOMMITTED', posId, product.id);
      expect(overcommitted).toHaveLength(1);
      expect(overcommitted[0]).toMatchObject({
        entity_type: 'LOCATION',
        owner_role: 'MAGASINIER',
        status: 'OPEN',
      });
      expect(flagsOf(await saleRow(first.id))).toEqual([
        'ALLOCATION_EXCEEDED',
        'ALLOCATION_OVERCOMMITTED',
      ]);
      await expectLedgerOk([product.id]);

      // Au-delà du stock physique : solde négatif, conflit de la vente ; un seul OVERCOMMITTED ouvert.
      const second = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 10),
        at('10:11:00'),
      );
      expect(warningsOf(second.result).sort()).toEqual([
        'ALLOCATION_EXCEEDED',
        'ALLOCATION_OVERCOMMITTED',
        'STOCK_NEGATIVE',
      ]);
      expect(await onHand(product.id)).toBe(-4);
      expect(await remainingOf(idA)).toBe(0);
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', posId, product.id)).toHaveLength(
        1,
      );
      const negative = await db
        .selectFrom('sync_sync_conflicts')
        .select(['entity_type', 'owner_role'])
        .where('conflict_type', '=', 'STOCK_NEGATIVE')
        .where('entity_id', '=', toBin(second.id))
        .execute();
      expect(negative).toEqual([{ entity_type: 'SALE', owner_role: 'MAGASINIER' }]);
      await expectQuotaInvariants(idA);
      await expectQuotaInvariants(idB);
      await expectLedgerOk([product.id]);
    });
  });

  // --- AV-166 : vente hors ligne sans quota utilisable ------------------------------------------------

  describe('AV-166 : vente hors ligne sans quota utilisable sur un emplacement partagé', () => {
    it('défaut WHEN_ALLOCATED : appareil modifié sans quota sur un PDV dont le stock est promis → appliquée et signalée (ALLOCATION_MISSING)', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const idB = await grant(sellerB, product.id, 10);
      expect(
        decideLocalConsumption({
          custodyMode: 'SHARED',
          requested: 5,
          localBalance: 0,
          holdsQuota: false,
          quotaRemaining: 0,
          quotaValidUntil: null,
          now: new Date(at('10:20:00')),
          overAllocationAllowed: false,
        }),
      ).toMatchObject({ allowed: false, code: 'ALLOCATION_MISSING' });

      const tablet = tabletOf(sellerA);
      const within = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 5),
        at('10:20:00'),
      );
      expect(warningsOf(within.result)).toEqual(['ALLOCATION_EXCEEDED']);
      const [signal] = await conflictsOf('ALLOCATION_EXCEEDED', within.id);
      expect(signal).toMatchObject({ entity_type: 'LOCATION', owner_role: 'MAGASINIER' });
      expect(fromBin(signal!.entity_id)).toBe(posId);
      expect(details(signal)).toMatchObject({
        reason: 'ALLOCATION_MISSING',
        allocationId: null,
        quotaRemaining: '0.000',
        excess: '5.000',
        takenFromFreeStock: '5.000',
        signalled: false,
      });
      expect(await remainingOf(idB)).toBe(10);

      // Au-delà du stock libre : le stock promis à B est entamé.
      const beyond = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 10),
        at('10:21:00'),
      );
      expect(warningsOf(beyond.result)).toEqual([
        'ALLOCATION_EXCEEDED',
        'ALLOCATION_OVERCOMMITTED',
      ]);
      expect(await remainingOf(idB)).toBe(10);
      expect(await entryTypes(idB)).toEqual(['GRANT']);
      await expectLedgerOk([product.id]);
    });

    it('défaut WHEN_ALLOCATED : aucun quota sur le produit à cet emplacement → appliquée sans signal de quota', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const { result } = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        saleBody(posId, product, 5),
        at('10:25:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      await expectLedgerOk([product.id]);
    });

    it('quota échu (sans l’option du site) : la tablette bloque ALLOCATION_EXPIRED ; poussée quand même → stock commun et signal ALLOCATION_EXPIRED', async () => {
      const product = await sellable();
      await stock(product.id, 50);
      const id = await grant(sellerA, product.id, 20, { validityHours: 1, when: at('08:00:00') });
      const row = await quota(id);
      expect(
        decideLocalConsumption({
          custodyMode: 'SHARED',
          requested: 5,
          localBalance: 0,
          holdsQuota: true,
          quotaRemaining: Number(row.quantity_remaining),
          quotaValidUntil: row.valid_until,
          now: new Date(at('10:30:00')),
          overAllocationAllowed: false,
        }),
      ).toMatchObject({ allowed: false, code: 'ALLOCATION_EXPIRED' });

      const { id: saleId, result } = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        saleBody(posId, product, 5),
        at('10:30:00'),
      );
      expect(warningsOf(result)).toEqual(['ALLOCATION_EXCEEDED']);
      expect((await saleMoves(saleId)).every((m) => m.allocation_id === null)).toBe(true);
      expect(await remainingOf(id)).toBe(20);
      const [signal] = await conflictsOf('ALLOCATION_EXCEEDED', saleId);
      expect(signal).toMatchObject({ entity_type: 'STOCK_ALLOCATION' });
      expect(details(signal)).toMatchObject({
        reason: 'ALLOCATION_EXPIRED',
        allocationId: id,
        signalled: false,
      });

      // En ligne, le détenteur d'un quota échu reçoit un refus explicite au-delà du stock libre.
      const refused = await sellOnline(sellerA, saleBody(posId, product, 30), at('10:31:00'));
      expect(code(refused.result)).toBe('INSUFFICIENT_STOCK');
      expect(refused.result.status === 'REJECTED' && refused.result.error?.message_fr).toMatch(
        /^Votre allocation a expiré/,
      );
      await expectQuotaInvariants(id);
    });

    it('site « autorisée et signalée » et ALWAYS : la tablette laisse passer (ALLOCATION_MISSING, ALLOCATION_EXPIRED), le serveur signale avec signalled = true', async () => {
      const product = await sellable();
      await stock(product.id, 50, optionPosId);
      expect(
        decideLocalConsumption({
          custodyMode: 'SHARED',
          requested: 4,
          localBalance: 0,
          holdsQuota: false,
          quotaRemaining: 0,
          quotaValidUntil: null,
          now: new Date(at('10:40:00')),
          overAllocationAllowed: true,
        }),
      ).toEqual({ allowed: true, signalled: 'ALLOCATION_MISSING' });
      // Aucun quota sur ce produit : signalé quand même (ALWAYS, réglage du site).
      const missing = await sellOffline(
        tabletOf(optionSeller),
        optionSeller.userId,
        saleBody(optionPosId, product, 4),
        at('10:40:00'),
      );
      expect(warningsOf(missing.result)).toEqual(['ALLOCATION_EXCEEDED']);
      expect(details((await conflictsOf('ALLOCATION_EXCEEDED', missing.id))[0])).toMatchObject({
        reason: 'ALLOCATION_MISSING',
        signalled: true,
      });

      const id = await grant(optionSeller, product.id, 10, {
        locationId: optionPosId,
        validityHours: 1,
        when: at('08:00:00'),
      });
      const expired = await sellOffline(
        tabletOf(optionSeller),
        optionSeller.userId,
        saleBody(optionPosId, product, 3),
        at('10:41:00'),
      );
      expect(warningsOf(expired.result)).toEqual(['ALLOCATION_EXCEEDED']);
      expect(details((await conflictsOf('ALLOCATION_EXCEEDED', expired.id))[0])).toMatchObject({
        reason: 'ALLOCATION_EXPIRED',
        allocationId: id,
        signalled: true,
      });
      await expectLedgerOk([product.id]);
    });

    it('site NEVER : vente hors ligne sans quota appliquée sans signal, même si le stock est promis à d’autres', async () => {
      const product = await sellable();
      await stock(product.id, 20, neverPosId);
      await grant(sellerB, product.id, 5, { locationId: neverPosId });
      const { id: saleId, result } = await sellOffline(
        tabletOf(neverSeller),
        neverSeller.userId,
        saleBody(neverPosId, product, 5),
        at('10:45:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      expect(await conflictsOf('ALLOCATION_EXCEEDED', saleId)).toHaveLength(0);
    });
  });

  // --- Garde d'appareil, révocation -----------------------------------------------------------------

  describe('garde d’appareil et quota révoqué (AV-163, AV-161)', () => {
    it('EXCLUSIVE_DEVICE : appareil non désigné hors ligne → appliquée + CUSTODY_DEVICE_MISMATCH (DEVICE_NOT_DESIGNATED) ; désigné ou en ligne : rien', async () => {
      const product = await sellable();
      await stock(product.id, 50, exclusivePosId);

      const foreign = await sellOffline(
        tabletOf(sellerB),
        sellerB.userId,
        saleBody(exclusivePosId, product, 5),
        at('11:00:00'),
      );
      expect(warningsOf(foreign.result)).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      expect(flagsOf(await saleRow(foreign.id))).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      const guard = await conflictsOf('CUSTODY_DEVICE_MISMATCH', foreign.id);
      expect(guard).toHaveLength(1); // une vente d'une ligne : un conflit (un par ligne de vente)
      expect(guard[0]).toMatchObject({
        entity_type: 'LOCATION',
        owner_role: 'MAGASINIER',
        applied: 1,
      });
      expect(details(guard[0])).toMatchObject({
        reason: 'DEVICE_NOT_DESIGNATED',
        deviceId: sellerB.deviceId,
        productId: product.id,
      });
      expect(await onHand(product.id, exclusivePosId)).toBe(45);

      const designated = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        saleBody(exclusivePosId, product, 5),
        at('11:01:00'),
      );
      expect(designated.result.status).toBe('APPLIED');
      const online = await sellOnline(
        sellerB,
        saleBody(exclusivePosId, product, 5),
        at('11:02:00'),
      );
      expect(online.result.status).toBe('APPLIED');
      expect(await conflictsOf('CUSTODY_DEVICE_MISMATCH', online.id)).toHaveLength(0);
    });

    it('stock mobile EXCLUSIVE_USER : vente hors ligne depuis un appareil qui n’est pas l’appareil principal → CUSTODY_DEVICE_MISMATCH (DEVICE_NOT_PRIMARY)', async () => {
      const product = await sellable();
      await stock(product.id, 30, mobileId);
      const other = await sellOffline(
        tabletOf(terrainSecondDevice),
        terrain.userId,
        saleBody(mobileId, product, 2),
        at('11:10:00'),
      );
      expect(warningsOf(other.result)).toEqual(['CUSTODY_DEVICE_MISMATCH']);
      expect(flagsOf(await saleRow(other.id))).toContain('CUSTODY_DEVICE_MISMATCH');
      expect(details((await conflictsOf('CUSTODY_DEVICE_MISMATCH', other.id))[0])).toMatchObject({
        reason: 'DEVICE_NOT_PRIMARY',
      });

      const primary = await sellOffline(
        tabletOf(terrain),
        terrain.userId,
        saleBody(mobileId, product, 2),
        at('11:11:00'),
      );
      expect(primary.result.status).toBe('APPLIED');
      expect(await conflictsOf('CUSTODY_DEVICE_MISMATCH', primary.id)).toHaveLength(0);
    });

    it('quota révoqué : fait postérieur à la révocation → ALLOCATION_REVOKED_CONSUMED ; antérieur → rien ; jamais d’entrée sur le quota révoqué', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 30);
      await revoke(id, at('12:00:00'));
      const tablet = tabletOf(sellerA);

      const early = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 4),
        at('11:30:00'),
      );
      expect(early.result.status, JSON.stringify(early.result)).toBe('APPLIED');
      const late = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 6),
        at('12:30:00'),
      );
      expect(warningsOf(late.result)).toEqual(['ALLOCATION_REVOKED_CONSUMED']);
      expect(flagsOf(await saleRow(late.id))).toEqual(['ALLOCATION_REVOKED_CONSUMED']);
      const found = await conflictsOf('ALLOCATION_REVOKED_CONSUMED', late.id);
      expect(found).toHaveLength(1);
      expect(fromBin(found[0]!.entity_id)).toBe(id);
      expect(await entryTypes(id)).toEqual(['GRANT', 'REVOKE']);
      expect(await remainingOf(id)).toBe(0);
      expect(await onHand(product.id)).toBe(90);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });
  });

  // --- Couple (utilisateur, appareil) -----------------------------------------------------------------

  describe('INV-STK-11 : un quota n’est consommé que par son couple', () => {
    it('tablette partagée : la vente du second vendeur ne touche pas le quota du premier ; le contenu de la commande ne désigne aucun quota', async () => {
      const product = await sellable();
      await stock(product.id, 30);
      const id = await grant(sellerA, product.id, 10);
      const tablet = tabletOf(sellerA); // tablette de A, partagée avec B (AV-007)

      const byB = await sellOffline(
        tablet,
        sellerB.userId,
        // Un appareil modifié qui tenterait de désigner le quota de A : champ ignoré.
        { ...saleBody(posId, product, 5), allocationId: id },
        at('13:00:00'),
      );
      expect(byB.result.status).not.toBe('REJECTED');
      expect((await saleMoves(byB.id)).every((m) => m.allocation_id === null)).toBe(true);
      expect(await remainingOf(id)).toBe(10);
      expect(await entryTypes(id)).toEqual(['GRANT']);

      const byA = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 4),
        at('13:01:00'),
      );
      expect(byA.result.status).toBe('APPLIED');
      expect(fromBin((await saleMoves(byA.id))[0]!.allocation_id!)).toBe(id);
      expect(await remainingOf(id)).toBe(6);
      await expectQuotaInvariants(id);
    });

    it('le même vendeur sur un autre appareil : stock libre, le quota du premier appareil reste intact', async () => {
      const product = await sellable();
      await stock(product.id, 30);
      const id = await grant(sellerA, product.id, 10);
      const otherDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, sellerA.userId, { status: 'ACTIVE' }));

      const { id: saleId, result } = await sellOnline(
        { userId: sellerA.userId, deviceId: otherDevice },
        saleBody(posId, product, 5),
        at('13:10:00'),
      );
      expect(result.status).toBe('APPLIED');
      const [move] = await saleMoves(saleId);
      expect(move!.allocation_id).toBeNull();
      expect(fromBin(move!.created_device_id!)).toBe(otherDevice);
      expect(await remainingOf(id)).toBe(10);
    });
  });

  // --- Rejeu ---------------------------------------------------------------------------------------

  it('AT-002 avec quota : réponse perdue puis renvoi, puis même vente sous un autre command_id → une seule consommation', async () => {
    const product = await sellable();
    await stock(product.id, 30);
    const id = await grant(sellerA, product.id, 10);
    const tablet = tabletOf(sellerA);
    const saleId = freshUuid();
    const spec = {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: saleId,
      occurredAt: at('13:20:00'),
      payload: saleBody(posId, product, 4),
    };
    const envelope = tablet.enqueue(sellerA.userId, spec);
    tablet.loseNextResponses(1);
    await expect(tablet.sync(sellerA.userId)).rejects.toBeInstanceOf(NetworkDownError);
    const [replayed] = await tablet.sync(sellerA.userId);
    expect(replayed?.command_id).toBe(envelope.command_id);
    expect(replayed?.status).toBe('APPLIED');
    const docNumber = refsOf(replayed!)['docNumber'];

    const second = tablet.enqueue(sellerA.userId, spec);
    const [again] = await tablet.sync(sellerA.userId);
    expect(again?.command_id).toBe(second.command_id);
    expect(again?.status).toBe('APPLIED');
    expect(refsOf(again!)['docNumber']).toBe(docNumber);

    expect((await entries(id)).filter((entry) => entry.entry_type === 'CONSUME')).toHaveLength(1);
    expect(await remainingOf(id)).toBe(6);
    expect(await onHand(product.id)).toBe(26);
    await expectQuotaInvariants(id);
  });

  // --- Annulation ---------------------------------------------------------------------------------------

  describe('annulation d’une vente directe (BR-VEN-027, ADR-033 §8)', () => {
    const cancel = (saleId: string, occurredAt: string) =>
      run(sellerA, 'sales.sale.cancel', 'SALE_CANCELLATION', freshUuid(), occurredAt, { saleId });

    it('quota encore actif : la quantité revient au quota (RESTORE plafonné), la part du stock commun au stock commun', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 20);
      const whole = await sellOnline(sellerA, saleBody(posId, product, 6), at('14:00:00'));
      expect(whole.result.status).toBe('APPLIED');
      expect(await remainingOf(id)).toBe(14);
      const cancelled = await cancel(whole.id, at('14:05:00'));
      expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
      expect(await remainingOf(id)).toBe(20);
      expect(await onHand(product.id)).toBe(100);
      const returns = await movesByType(product.id, 'CUSTOMER_RETURN');
      expect(
        returns.map((m) => [Number(m.quantity), m.allocation_id ? fromBin(m.allocation_id) : null]),
      ).toEqual([[6, id]]);

      // Ligne scindée (20 du quota, 6 du stock commun) : seule la part consommée revient au quota.
      const split = await sellOnline(sellerA, saleBody(posId, product, 26), at('14:10:00'));
      expect(split.result.status).toBe('APPLIED');
      expect(await remainingOf(id)).toBe(0);
      expect((await saleMoves(split.id)).map((m) => Number(m.quantity))).toEqual([20, 6]);
      const cancelledSplit = await cancel(split.id, at('14:12:00'));
      expect(cancelledSplit.status, JSON.stringify(cancelledSplit)).toBe('APPLIED');
      expect(await remainingOf(id)).toBe(20);
      expect(await onHand(product.id)).toBe(100);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('quota révoqué depuis : retour au stock commun, registre du quota inchangé', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 20);
      const sale = await sellOnline(sellerA, saleBody(posId, product, 6), at('14:20:00'));
      expect(sale.result.status).toBe('APPLIED');
      await revoke(id, at('14:21:00'));
      const before = await entryTypes(id);
      const cancelled = await cancel(sale.id, at('14:22:00'));
      expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
      expect(await entryTypes(id)).toEqual(before);
      expect(await remainingOf(id)).toBe(0);
      expect(await onHand(product.id)).toBe(100);
      const returns = await movesByType(product.id, 'CUSTOMER_RETURN');
      expect(returns.every((m) => m.allocation_id === null)).toBe(true);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });
  });

  // --- Opérations du serveur : aucun quota ----------------------------------------------------------------

  describe('commandes : opérations du serveur, aucun quota consommé ni entamé (ADR-028 §4, ADR-033 §7)', () => {
    const place = (
      productId: Sellable,
      quantity: number,
      occurredAt: string,
      location = storeId,
    ) => {
      const id = freshUuid();
      return run(commercial, 'sales.order.place', 'SALES_ORDER', id, occurredAt, {
        customerId,
        fulfilmentLocationId: location,
        lines: [line(productId, quantity)],
      }).then((result) => ({ id, result }));
    };
    const orderLines = (orderId: string) =>
      db
        .selectFrom('sales_sales_order_lines')
        .selectAll()
        .where('order_id', '=', toBin(orderId))
        .orderBy('line_no')
        .execute();
    const soldOf = async (orderId: string) =>
      (await orderLines(orderId)).map((row) => Number(row.sold_quantity_base));
    const orderSaleIds = async (orderId: string) =>
      (
        await db
          .selectFrom('sales_sales')
          .select('id')
          .where('order_id', '=', toBin(orderId))
          .execute()
      ).map((row) => fromBin(row.id));

    it('confirmation sur un magasin partagé : vend le stock libre seulement, le reste en attente, quota intact, puis confirm_remaining après libération', async () => {
      const product = await sellable();
      await stock(product.id, 10, storeId);
      const id = await grant(sellerA, product.id, 6, { locationId: storeId });

      const { id: orderId, result } = await place(product, 10, at('15:00:00'));
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      expect(await soldOf(orderId)).toEqual([4]);
      expect(await remainingOf(id)).toBe(6);
      expect(await onHand(product.id, storeId)).toBe(6);
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', storeId, product.id)).toHaveLength(
        0,
      );
      const [saleId] = await orderSaleIds(orderId);
      expect((await saleMoves(saleId!)).every((m) => m.allocation_id === null)).toBe(true);
      expect(flagsOf(await saleRow(saleId!))).toEqual([]);

      // Le détenteur libère son quota (fait de son appareil) : le stock rendu se vend au reste confirmé.
      const released = await run(
        sellerA,
        'inventory.allocation.release',
        'STOCK_ALLOCATION',
        id,
        at('15:10:00'),
        {
          remainingBase: 6,
        },
      );
      expect(released.status, JSON.stringify(released)).toBe('APPLIED');
      const remaining = await run(
        commercial,
        'sales.order.confirm_remaining',
        'SALES_ORDER',
        orderId,
        at('15:11:00'),
        {},
      );
      expect(remaining.status, JSON.stringify(remaining)).toBe('APPLIED');
      expect(await soldOf(orderId)).toEqual([10]);
      expect(await onHand(product.id, storeId)).toBe(0);
      expect(await consumeEntriesOfProduct(product.id)).toEqual([]);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('hausse d’une commande : la vente complémentaire est limitée au stock libre', async () => {
      const product = await sellable();
      await stock(product.id, 10, storeId);
      const id = await grant(sellerA, product.id, 6, { locationId: storeId });
      const { id: orderId, result } = await place(product, 3, at('15:20:00'));
      expect(result.status).toBe('APPLIED');
      expect(await soldOf(orderId)).toEqual([3]);
      const [orderLine] = await orderLines(orderId);
      const raised = await run(
        commercial,
        'sales.order.update',
        'SALES_ORDER',
        orderId,
        at('15:21:00'),
        {
          lines: [{ orderLineId: fromBin(orderLine!.id), quantity: 8, quantityBase: 8 }],
        },
      );
      expect(raised.status, JSON.stringify(raised)).toBe('APPLIED');
      expect(await soldOf(orderId)).toEqual([4]);
      expect(await remainingOf(id)).toBe(6);
      expect(await onHand(product.id, storeId)).toBe(6);
      expect(await consumeEntriesOfProduct(product.id)).toEqual([]);
      await expectLedgerOk([product.id]);
    });

    it('livraison partielle puis totale, annulation d’une autre commande vendue : aucun mouvement ni entrée de quota', async () => {
      const product = await sellable();
      await stock(product.id, 20, storeId);
      const id = await grant(sellerA, product.id, 5, { locationId: storeId });
      const { id: orderId } = await place(product, 6, at('15:30:00'));
      const [orderLine] = await orderLines(orderId);
      const fulfil = (quantityBase: number, when: string) =>
        run(commercial, 'sales.order.fulfil', 'DELIVERY_NOTE', freshUuid(), when, {
          orderId,
          lines: [{ orderLineId: fromBin(orderLine!.id), quantityBase }],
        });
      expect((await fulfil(2, at('15:31:00'))).status).toBe('APPLIED');
      expect((await fulfil(4, at('15:32:00'))).status).toBe('APPLIED');
      const deliveries = await movesByType(product.id, 'DELIVERY');
      expect(deliveries.map((m) => Number(m.quantity)).sort()).toEqual([2, 4]);
      expect(deliveries.every((m) => m.allocation_id === null)).toBe(true);

      const { id: cancelledId } = await place(product, 4, at('15:33:00'));
      expect(await soldOf(cancelledId)).toEqual([4]);
      const cancelled = await run(
        commercial,
        'sales.order.cancel',
        'SALES_ORDER',
        cancelledId,
        at('15:34:00'),
        {
          comment: 'Client absent',
        },
      );
      expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
      const returns = await movesByType(product.id, 'CUSTOMER_RETURN');
      expect(returns.map((m) => Number(m.quantity))).toEqual([4]);
      expect(returns.every((m) => m.allocation_id === null)).toBe(true);
      expect(await consumeEntriesOfProduct(product.id)).toEqual([]);
      expect(await remainingOf(id)).toBe(5);
      expect(await onHand(product.id, storeId)).toBe(14);
      await expectLedgerOk([product.id]);
    });

    it('régularisation d’une livraison hors ligne : aucune consommation ; le stock promis entamé remonte ALLOCATION_OVERCOMMITTED', async () => {
      const product = await sellable();
      await stock(product.id, 10, storeId);
      const id = await grant(sellerA, product.id, 6, { locationId: storeId });
      const { id: orderId } = await place(product, 4, at('15:40:00'));
      expect(await soldOf(orderId)).toEqual([4]);
      const [orderLine] = await orderLines(orderId);

      const late = await run(
        commercial,
        'sales.order.fulfil',
        'DELIVERY_NOTE',
        freshUuid(),
        at('15:45:00'),
        { orderId, lines: [{ orderLineId: fromBin(orderLine!.id), quantityBase: 10 }] },
        { offline: true },
      );
      expect(late.status, JSON.stringify(late)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(late)).toEqual(
        expect.arrayContaining(['ORDER_OVER_FULFILMENT', 'ALLOCATION_OVERCOMMITTED']),
      );
      expect(warningsOf(late)).not.toContain('STOCK_NEGATIVE');
      const regularisation = await db
        .selectFrom('sales_sales')
        .selectAll()
        .where('doc_number', '=', refsOf(late)['regularisationSaleDocNumber']!)
        .executeTakeFirstOrThrow();
      expect(flagsOf(regularisation)).toEqual([
        'ORDER_OVER_FULFILMENT',
        'ALLOCATION_OVERCOMMITTED',
      ]);
      expect(
        (await saleMoves(fromBin(regularisation.id))).every((m) => m.allocation_id === null),
      ).toBe(true);
      expect(await consumeEntriesOfProduct(product.id)).toEqual([]);
      expect(await remainingOf(id)).toBe(6);
      expect(await onHand(product.id, storeId)).toBe(0);
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', storeId, product.id)).toHaveLength(
        1,
      );
      await expectLedgerOk([product.id]);
    });

    it('confirmation depuis un bâtiment d’élevage partagé : plafonnée au stock libre, aucun ALLOCATION_OVERCOMMITTED (correction P5-11)', async () => {
      const pig = await sellable(50_000, { biological: true });
      const originId = freshUuid();
      const lotId = await db.transaction().execute(async (trx) => {
        const created = await createStockLot(
          trx,
          { idGenerator },
          {
            originType: 'PRODUCTION_LOT',
            originId,
            lotCode: `T-${originId.slice(-12)}`,
            productId: pig.id,
            fifoRankAt: new Date(`${DAY}T04:00:00.000Z`),
            expiryDate: null,
            createdBy: admin.userId,
          },
        );
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId: pig.id,
            lotId: created,
            quantityBase: 10,
            fromLocationId: await virtualLocationId(trx, 'V_PRODUCTION'),
            toLocationId: buildingId,
            moveType: 'PRODUCTION_OUTPUT',
            declaredUnitCostXaf: 10,
            occurredAt: new Date(`${DAY}T05:00:00.000Z`),
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
            costObjectId: originId,
            costType: 'ANIMAUX',
            amountXaf: 200_000,
            direction: 'DEBIT',
            sourceType: 'MANUAL',
            sourceId: freshUuid(),
            occurredAt: new Date(`${DAY}T05:30:00.000Z`),
            createdBy: admin.userId,
            comment: 'Test P5-11',
          },
        );
        await setStockLotSellableFromRearing(trx, created, true);
        return created;
      });
      const id = await grant(sellerA, pig.id, 6, { locationId: buildingId });

      const { id: orderId, result } = await place(pig, 10, at('16:00:00'), buildingId);
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      expect(await soldOf(orderId)).toEqual([4]);
      expect(await onHand(pig.id, buildingId)).toBe(6);
      expect(await remainingOf(id)).toBe(6);
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', buildingId, pig.id)).toHaveLength(
        0,
      );
      const [saleId] = await orderSaleIds(orderId);
      const moves = await saleMoves(saleId!);
      expect(moves.map((m) => fromBin(m.lot_id!))).toEqual([lotId]);
      await expectLedgerOk([pig.id]);
    });
  });
  // --- Corrections de la revue adverse de P5-11 ------------------------------------------------------------

  describe('corrections de la revue adverse (P5-11)', () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** Une transaction concurrente qui tient les soldes du couple (emplacement, produit) jusqu'à `release()`. */
    async function holdBalances(productId: string, locationId: string) {
      let ready!: () => void;
      let open!: () => void;
      const held = new Promise<void>((resolve) => (ready = resolve));
      const gate = new Promise<void>((resolve) => (open = resolve));
      const done = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('inventory_stock_balances')
          .select('qty_on_hand')
          .where('location_id', '=', toBin(locationId))
          .where('product_id', '=', toBin(productId))
          .forUpdate()
          .execute();
        ready();
        await gate;
      });
      await Promise.race([held, done]);
      return {
        release: async () => {
          open();
          await done;
        },
      };
    }

    /** Les soldes du couple sont-ils verrouillés par une autre transaction ? (`NOWAIT`, sans attendre). */
    async function balancesLocked(productId: string, locationId: string): Promise<boolean> {
      try {
        await db
          .transaction()
          .execute((trx) =>
            trx
              .selectFrom('inventory_stock_balances')
              .select('qty_on_hand')
              .where('location_id', '=', toBin(locationId))
              .where('product_id', '=', toBin(productId))
              .forUpdate()
              .noWait()
              .execute(),
          );
        return false;
      } catch (error) {
        if ((error as { errno?: number }).errno !== 3572) throw error; // ER_LOCK_NOWAIT_ERR
        return true;
      }
    }

    it('ALLOCATION_OVERCOMMITTED : seule la vente qui cause ou aggrave le dépassement le reçoit ; une vente en ligne dans son propre quota sur un emplacement déjà en dépassement reste APPLIED', async () => {
      const product = await sellable();
      await stock(product.id, 20);
      const idA = await grant(sellerA, product.id, 10);
      const idB = await grant(sellerB, product.id, 8);
      // Une perte du serveur ramène le solde à 15 sous les 18 promis : le conflit est ouvert.
      await db.transaction().execute(async (trx) => {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId: product.id,
            quantityBase: 5,
            fromLocationId: posId,
            toLocationId: await virtualLocationId(trx, 'V_LOSS'),
            moveType: 'LOSS',
            occurredAt: new Date(`${DAY}T06:00:00.000Z`),
            sourceDocType: 'LOSS',
            sourceDocId: freshUuid(),
            createdBy: admin.userId,
            allowNegative: false,
          },
        );
      });
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', posId, product.id)).toHaveLength(
        1,
      );

      // A vend 2 en ligne dans son quota : solde 13, restes 16, écart inchangé (3), rien n'est pris à B.
      const own = await sellOnline(sellerA, saleBody(posId, product, 2), at('09:50:00'));
      expect(own.result.status, JSON.stringify(own.result)).toBe('APPLIED');
      expect(flagsOf(await saleRow(own.id))).toEqual([]);
      expect(await remainingOf(idA)).toBe(8);
      expect(await remainingOf(idB)).toBe(8);
      expect(await onHand(product.id)).toBe(13);
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', posId, product.id)).toHaveLength(
        1,
      );

      // Hors ligne, A vend 10 : 8 de son quota, 2 du stock promis à B → il aggrave l'écart, il est signalé.
      const worsening = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        saleBody(posId, product, 10),
        at('09:51:00'),
      );
      expect(warningsOf(worsening.result)).toContain('ALLOCATION_OVERCOMMITTED');
      expect(flagsOf(await saleRow(worsening.id))).toContain('ALLOCATION_OVERCOMMITTED');
      expect(await locationConflicts('ALLOCATION_OVERCOMMITTED', posId, product.id)).toHaveLength(
        1,
      );
      await expectQuotaInvariants(idA);
      await expectQuotaInvariants(idB);
      await expectLedgerOk([product.id]);
    });

    it('quota révoqué, vente EN LIGNE après la révocation : vente normale sur le stock libre, APPLIED, ni conflit ni drapeau (BR-STK-014)', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 30);
      await revoke(id, at('12:10:00'));

      for (const when of ['12:40:00', '12:41:00']) {
        const sale = await sellOnline(sellerA, saleBody(posId, product, 5), at(when));
        expect(sale.result.status, JSON.stringify(sale.result)).toBe('APPLIED');
        expect(flagsOf(await saleRow(sale.id))).toEqual([]);
        expect(await conflictsOf('ALLOCATION_REVOKED_CONSUMED', sale.id)).toHaveLength(0);
        expect((await saleMoves(sale.id)).every((m) => m.allocation_id === null)).toBe(true);
      }
      expect(await onHand(product.id)).toBe(90);
      expect(await entryTypes(id)).toEqual(['GRANT', 'REVOKE']);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('quota révoqué, vente hors ligne ANTÉRIEURE à la révocation : normale dans le reste du quota, ALLOCATION_EXCEEDED au-delà (AT-003)', async () => {
      const product = await sellable();
      await stock(product.id, 100);
      const id = await grant(sellerA, product.id, 30);
      await revoke(id, at('12:20:00')); // reste du quota à la révocation : 30
      const tablet = tabletOf(sellerA);

      const within = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 4),
        at('12:00:00'),
      );
      expect(within.result.status, JSON.stringify(within.result)).toBe('APPLIED');

      const beyond = await sellOffline(
        tablet,
        sellerA.userId,
        saleBody(posId, product, 31),
        at('12:01:00'),
      );
      expect(beyond.result.status, JSON.stringify(beyond.result)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(beyond.result)).toEqual(['ALLOCATION_EXCEEDED']);
      expect(flagsOf(await saleRow(beyond.id))).toEqual(['ALLOCATION_EXCEEDED']);
      const [conflict] = await conflictsOf('ALLOCATION_EXCEEDED', beyond.id);
      expect(conflict).toMatchObject({ entity_type: 'STOCK_ALLOCATION', applied: 1 });
      expect(fromBin(conflict!.entity_id)).toBe(id);
      // En cumul (AV-211, P5-23) : 4 déjà appliqués + 31 pour un reste de 30 → 5 de trop dans ce fait.
      expect(details(conflict)).toMatchObject({
        reason: 'ALLOCATION_EXCEEDED',
        allocationId: id,
        requested: '31.000',
        quotaRemaining: '30.000',
        earlierAfterRevocation: '4.000',
        excess: '5.000',
      });
      expect(await conflictsOf('ALLOCATION_REVOKED_CONSUMED', beyond.id)).toHaveLength(0);
      expect((await saleMoves(beyond.id)).every((m) => m.allocation_id === null)).toBe(true);
      expect(await entryTypes(id)).toEqual(['GRANT', 'REVOKE']);
      expect(await onHand(product.id)).toBe(65);
      await expectQuotaInvariants(id);
      await expectLedgerOk([product.id]);
    });

    it('quota épuisé mais encore actif : la vente hors ligne d’un couple sans quota est signalée (AV-166, WHEN_ALLOCATED compte les quotas actifs)', async () => {
      const product = await sellable();
      await stock(product.id, 40);
      const idB = await grant(sellerB, product.id, 10);
      const exhaust = await sellOnline(sellerB, saleBody(posId, product, 10), at('12:50:00'));
      expect(exhaust.result.status).toBe('APPLIED');
      const row = await quota(idB);
      expect(row.status).toBe('ACTIVE');
      expect(Number(row.quantity_remaining)).toBe(0);

      const { id: saleId, result } = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        saleBody(posId, product, 5),
        at('12:51:00'),
      );
      expect(warningsOf(result)).toEqual(['ALLOCATION_EXCEEDED']); // rien n'est promis : pas de dépassement
      const [signal] = await conflictsOf('ALLOCATION_EXCEEDED', saleId);
      expect(signal).toMatchObject({ entity_type: 'LOCATION' });
      expect(details(signal)).toMatchObject({ reason: 'ALLOCATION_MISSING', excess: '5.000' });
      await expectQuotaInvariants(idB);
      await expectLedgerOk([product.id]);
    });

    it('confirmation de commande : soldes et quotas sont verrouillés dans l’ordre des produits, non des lignes (aucun interblocage avec une vente directe)', async () => {
      const one = await sellable();
      const two = await sellable();
      const [low, high] = one.id < two.id ? [one, two] : [two, one];
      await stock(low.id, 10, storeId);
      await stock(high.id, 10, storeId);

      // Une transaction concurrente tient le produit « bas » (une vente directe l'aurait verrouillé en
      // premier). La commande, dont les lignes sont dans l'ordre inverse (haut, bas), doit s'arrêter sur
      // ce verrou sans avoir pris le produit « haut » : sinon elle s'interbloquerait avec la vente.
      const hold = await holdBalances(low.id, storeId);
      const orderId = freshUuid();
      const placing = run(commercial, 'sales.order.place', 'SALES_ORDER', orderId, at('16:30:00'), {
        customerId,
        fulfilmentLocationId: storeId,
        lines: [line(high, 3), line(low, 3)],
      });
      let highLocked: boolean;
      try {
        await sleep(1_500);
        highLocked = await balancesLocked(high.id, storeId);
      } finally {
        await hold.release();
      }
      const result = await placing;
      expect(highLocked).toBe(false);
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      const lines = await db
        .selectFrom('sales_sales_order_lines')
        .select(['product_id', 'sold_quantity_base'])
        .where('order_id', '=', toBin(orderId))
        .execute();
      expect(lines.map((row) => Number(row.sold_quantity_base))).toEqual([3, 3]);
      expect(await onHand(high.id, storeId)).toBe(7);
      expect(await onHand(low.id, storeId)).toBe(7);
    });

    /** AT-049 : vente hors ligne réelle → `STOCK_NEGATIVE` → inventaire de l'emplacement → conflit clos. */
    async function stockNegativeClosedByCount(
      productIdInSale: (productId: string) => string,
    ): Promise<void> {
      const product = await sellable();
      await stock(product.id, 2);
      const body = saleBody(posId, product, 5);
      const { id: saleId, result } = await sellOffline(
        tabletOf(sellerA),
        sellerA.userId,
        {
          ...body,
          lines: body.lines.map((row) => ({ ...row, productId: productIdInSale(product.id) })),
        },
        at('13:30:00'),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(result)).toContain('STOCK_NEGATIVE');
      expect(await onHand(product.id)).toBe(-3);
      const negative = () =>
        db
          .selectFrom('sync_sync_conflicts')
          .select(['status', 'resolution', 'resolution_refs', 'details'])
          .where('conflict_type', '=', 'STOCK_NEGATIVE')
          .where('entity_id', '=', toBin(saleId))
          .executeTakeFirstOrThrow();
      const opened = await negative();
      expect(opened.status).toBe('OPEN');
      // Les clés que l'inventaire compare pour clore le conflit (texte exact, minuscules).
      expect(details(opened)).toMatchObject({ productId: product.id, locationId: posId });

      // Inventaire de l'emplacement : compté 0, théorique −3, écart +3, solde ramené à 0.
      const countId = freshUuid();
      for (const [commandType, payload] of [
        ['inventory.count.open', { locationId: posId, countType: 'SPOT' }],
        [
          'inventory.count.record_lines',
          {
            countId,
            lines: [{ productId: product.id, countedAt: at('17:00:00'), countedQtyBase: 0 }],
          },
        ],
        ['inventory.count.submit', { countId }],
      ] as const) {
        const step = await run(
          counter,
          commandType,
          'INVENTORY_COUNT',
          countId,
          at('17:00:00'),
          payload,
        );
        expect(step.status, JSON.stringify(step)).toBe('APPLIED');
      }
      expect(await onHand(product.id)).toBe(0);
      const closed = await negative();
      expect(closed.status).toBe('RESOLVED');
      expect(closed.resolution).toBe('COMPENSATE');
      expect(closed.resolution_refs).toEqual([countId]);
      await expectLedgerOk([product.id]);
    }

    it('AT-049 de bout en bout : la vente hors ligne réelle ouvre STOCK_NEGATIVE, l’inventaire de l’emplacement le clôt (COMPENSATE, référence de l’inventaire)', () =>
      stockNegativeClosedByCount((productId) => productId));

    it('AT-049 : un identifiant de produit en majuscules dans la commande de vente n’empêche pas la clôture (le conflit porte l’identifiant du catalogue, en minuscules)', () =>
      stockNegativeClosedByCount((productId) => productId.toUpperCase()));
  });
});
