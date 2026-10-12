/**
 * Monde de PDV des scénarios de bout en bout de P5-21 (journée hors ligne, trois tablettes AT-004,
 * appareil perdu AT-035, horloge décalée AT-036) : l'application complète (`AppModule`, tous les
 * gestionnaires de commandes, tous les consommateurs d'événements, HTTP) sous une **horloge fixe** que
 * le test avance lui-même (`overrideProvider(CLOCK)`), les rôles réels du seed et des données neuves à
 * chaque monde (sites, emplacements, comptes, produits, clients) : la base de test est partagée et
 * persistante, chaque scénario n'affirme que sur ses propres identifiants.
 *
 * - PDV `P` (`POINT_DE_VENTE`) configuré en garde `SHARED` sur son comptoir (BR-DIS-002, quotas
 *   d'appareil, ADR-033) ; magasin `S` (`MAGASIN`) qui l'approvisionne par transfert.
 * - Acteurs : administrateur (`ADMIN`), Finance, Direction, magasiniers de `P` et de `S`, vendeurs
 *   de `P` (`VENDEUR_PDV`, un appareil chacun).
 * - Caisse du PDV, caisse centrale et compte de mobile money, créés par les vraies commandes.
 * - Hygiène : tout quota resté actif est révoqué à la fermeture du monde.
 */
import { expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { FixedClock, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import {
  recordStockMove,
  verifyStockLedger,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  verifyCashLedger,
  verifyCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import { verifyCashSessionVariance } from '../src/modules/finance/application/cash-session-validation.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { OfflineDevice, type DeviceServices } from './device-harness.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import {
  db,
  freshPhone,
  freshUuid,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

export type { Actor } from './cash-transfer-fixtures.js';

/** Prix catalogue et coût d'achat des produits du monde (XAF). */
export const PRICE = 500;
export const UNIT_COST = 300;

export interface Sellable {
  readonly id: string;
  readonly ruleId: string;
  readonly price: number;
}

export interface WorldCommand {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly baseVersion?: number | null;
}

/** Statut, ou code d'erreur pour un refus. */
export const codeOf = (result: CommandResult | undefined): string | undefined =>
  result === undefined
    ? undefined
    : result.status === 'REJECTED' || result.status === 'CONFLICT'
      ? (result.error?.code ?? result.status)
      : result.status;

export const warningsOf = (result: CommandResult | undefined): readonly string[] =>
  result !== undefined && 'warnings' in result && result.warnings ? result.warnings : [];

/**
 * Application partagée par les mondes d'un même fichier : une seconde application Nest dans le même
 * processus réenregistrerait les commandes dans le registre commun. Fermée avec le dernier monde.
 */
let shared:
  | {
      readonly app: NestFastifyApplication;
      readonly clock: FixedClock;
      readonly idGenerator: IdGenerator;
      readonly pipeline: CommandPipelineService;
      readonly services: DeviceServices;
      users: number;
    }
  | undefined;

async function sharedApp(now: string) {
  if (shared === undefined) {
    const clock = new FixedClock(new Date(now));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    shared = {
      app,
      clock,
      idGenerator: app.get<IdGenerator>(ID_GENERATOR),
      pipeline: app.get(CommandPipelineService),
      services: { push: app.get(SyncPushService), pull: new SyncPullService(db) },
      users: 0,
    };
  }
  shared.users += 1;
  shared.clock.setTo(new Date(now));
  return shared;
}

/** Rend l'application partagée ; la ferme au dernier monde (y compris un monde dont la création a échoué). */
async function releaseShared(): Promise<void> {
  if (shared === undefined) return;
  shared.users -= 1;
  if (shared.users === 0) {
    const { app } = shared;
    shared = undefined;
    await app.close();
  }
}

export class PosWorld {
  readonly granted: string[] = [];
  private readonly tablets = new Map<string, OfflineDevice>();
  private seq = 0;

  private constructor(
    readonly app: NestFastifyApplication,
    readonly clock: FixedClock,
    readonly idGenerator: IdGenerator,
    readonly pipeline: CommandPipelineService,
    readonly services: DeviceServices,
    readonly root: string,
    readonly admin: Actor,
    readonly fin: Actor,
    readonly dir: Actor,
    readonly magP: Actor,
    readonly magS: Actor,
    readonly sellers: readonly Actor[],
    readonly zoneId: string,
    readonly siteP: string,
    readonly siteS: string,
    readonly counter: string,
    readonly store: string,
    readonly categoryId: string,
    public posAcc = '',
    public central = '',
    public mobileAcc = '',
  ) {}

  /**
   * Monte l'application et le monde. `now` : heure de l'horloge fixe au départ (passée : jamais
   * d'horloge serveur dans le futur sur la base partagée) ; `sellers` : nombre de vendeurs du PDV.
   */
  static async create(options: {
    readonly now: string;
    readonly sellers: number;
  }): Promise<PosWorld> {
    const app = await sharedApp(options.now);
    try {
      return await PosWorld.build(app, options);
    } catch (error) {
      await releaseShared();
      throw error;
    }
  }

  private static async build(
    { app, clock, idGenerator, pipeline, services }: NonNullable<typeof shared>,
    options: { readonly now: string; readonly sellers: number },
  ): Promise<PosWorld> {
    const root = await tx((trx) => insertTestUser(trx));
    const places = await tx(async (trx) => {
      const zoneId = await insertTestZone(trx, root);
      const siteP = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      const siteS = await insertTestSite(trx, root, zoneId, { siteType: 'MAGASIN' });
      const counter = await insertTestLocation(trx, root, siteP, { locationType: 'POS' });
      const store = await insertTestLocation(trx, root, siteS, { locationType: 'STORE' });
      for (const unit of ['PIECE']) {
        const exists = await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', unit)
          .executeTakeFirst();
        if (!exists) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name: 'Pièce', is_count: 1 })
            .execute();
        }
      }
      for (const channel of ['POINT_DE_VENTE', 'DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
        const exists = await trx
          .selectFrom('catalog_sales_channels')
          .select('code')
          .where('code', '=', channel)
          .executeTakeFirst();
        if (!exists) {
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
          name: 'Distribution',
          created_by: toBin(root),
        })
        .execute();
      return { zoneId, siteP, siteS, counter, store, categoryId };
    });
    const site = (siteId: string) => ({ scopeType: 'SITE' as const, scopeSiteId: siteId });
    const admin = await newActor('ADMIN', root);
    const fin = await newActor('FINANCE', root);
    const dir = await newActor('DIRECTION', root);
    const magP = await newActor('MAGASINIER', root, site(places.siteP));
    const magS = await newActor('MAGASINIER', root, site(places.siteS));
    const sellers: Actor[] = [];
    for (let i = 0; i < options.sellers; i++) {
      sellers.push(await newActor('VENDEUR_PDV', root, site(places.siteP)));
    }

    const world = new PosWorld(
      app,
      clock,
      idGenerator,
      pipeline,
      services,
      root,
      admin,
      fin,
      dir,
      magP,
      magS,
      sellers,
      places.zoneId,
      places.siteP,
      places.siteS,
      places.counter,
      places.store,
      places.categoryId,
    );
    const at = options.now;
    await world.ok(admin, {
      type: 'organization.pos.configure',
      aggregateType: 'SITE',
      aggregateId: places.siteP,
      occurredAt: at,
      payload: { salesLocationId: places.counter, custodyMode: 'SHARED' },
    });
    const account = async (payload: Record<string, unknown>) => {
      const id = freshUuid();
      await world.ok(fin, {
        type: 'finance.cash_account.create',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: id,
        occurredAt: at,
        payload: { code: `P521-${id.slice(-12)}`, name: 'Compte P5-21', ...payload },
      });
      return id;
    };
    world.posAcc = await account({
      accountType: 'CAISSE_PDV',
      siteId: places.siteP,
      responsibleUserId: sellers[0]?.userId ?? fin.userId,
    });
    world.central = await account({
      accountType: 'CAISSE_CENTRALE',
      responsibleUserId: fin.userId,
    });
    world.mobileAcc = await account({ accountType: 'MOBILE_MONEY', responsibleUserId: fin.userId });
    return world;
  }

  // --- Commandes ------------------------------------------------------------------------------------

  /** Commande en ligne (`/commands`) à travers le vrai pipeline. */
  online(actor: Actor, command: WorldCommand): Promise<CommandResult> {
    this.seq += 1;
    return this.pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1_000_000 + this.seq,
        command_version: 1,
        command_type: command.type,
        aggregate_type: command.aggregateType,
        aggregate_id: command.aggregateId ?? freshUuid(),
        author_user_id: actor.userId,
        base_version: command.baseVersion ?? null,
        depends_on: [],
        occurred_at: command.occurredAt,
        client_created_at: command.occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: command.payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  }

  async ok(actor: Actor, command: WorldCommand): Promise<CommandResult> {
    const result = await this.online(actor, command);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  }

  /** Une seule instance par appareil (contrainte `(device_id, device_seq)` de l'inbox). */
  tablet(actor: Actor): OfflineDevice {
    let tablet = this.tablets.get(actor.deviceId);
    if (!tablet) {
      tablet = new OfflineDevice(this.services, actor.deviceId, this.clock);
      this.tablets.set(actor.deviceId, tablet);
    }
    return tablet;
  }

  /** Jeton d'accès signé à l'heure de l'horloge fixe (le garde JWT lit la même horloge). */
  token(actor: Actor): Promise<string> {
    return signAccessToken(
      this.app.get(JWT_KEYS).privateKey,
      { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
      this.clock.now(),
    );
  }

  setNow(iso: string): void {
    this.clock.setTo(new Date(iso));
  }

  // --- Données --------------------------------------------------------------------------------------

  async product(name = 'Poulet de chair'): Promise<Sellable> {
    const id = freshUuid();
    const ruleId = freshUuid();
    await tx(async (trx) => {
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(id),
          code: `PRD-${id.slice(-10)}`,
          name,
          category_id: toBin(this.categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'PIECE',
          pricing_mode: 'PER_UNIT',
          is_sellable: 1,
          created_by: toBin(this.root),
        })
        .execute();
      await trx
        .insertInto('pricing_price_rules')
        .values({
          id: toBin(ruleId),
          code: `PR-${ruleId.slice(-12)}`,
          version: 1,
          product_id: toBin(id),
          unit_price_xaf: PRICE,
          pricing_unit_code: 'PIECE',
          status: 'ACTIVE',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          approved_by: toBin(this.root),
          approved_at: new Date('2026-01-01T00:00:00.000Z'),
          created_by: toBin(this.root),
        })
        .execute();
    });
    return { id, ruleId, price: PRICE };
  }

  /** Ligne de vente au prix catalogue. */
  line(product: Sellable, quantity: number) {
    return {
      productId: product.id,
      quantity,
      unitCode: 'PIECE',
      quantityBase: quantity,
      listUnitPriceXaf: product.price,
      priceRuleId: product.ruleId,
      unitPriceXaf: product.price,
    };
  }

  /** Entrée d'achat (coût `UNIT_COST`) sur un emplacement, datée `at`. */
  async stockIn(
    productId: string,
    quantity: number,
    at: string,
    location = this.counter,
  ): Promise<void> {
    await tx(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator: this.idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: location,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: UNIT_COST,
          occurredAt: new Date(at),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: this.root,
          allowNegative: false,
        },
      );
    });
  }

  /** Client à crédit de la zone du monde. */
  async customer(name = 'Restaurant du marché'): Promise<string> {
    const id = freshUuid();
    await tx(async (trx) => {
      const stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(this.root),
        })
        .execute();
      const sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Terrain',
          created_by: toBin(this.root),
        })
        .execute();
      await trx
        .insertInto('crm_customers')
        .values({
          id: toBin(id),
          stage: 'PROSPECT',
          pipeline_step_id: toBin(stepId),
          display_name: name,
          phone_primary: await freshPhone(),
          zone_id: toBin(this.zoneId),
          source_code: sourceCode,
          acquired_by_user_id: toBin(this.root),
          acquired_at: new Date('2026-01-01T00:00:00.000Z'),
          occurred_at: new Date('2026-01-01T00:00:00.000Z'),
          credit_allowed: 1,
          credit_limit_xaf: 1_000_000_000,
          payment_terms_days: 30,
          created_by: toBin(this.root),
        })
        .execute();
    });
    return id;
  }

  // --- Quotas ---------------------------------------------------------------------------------------

  async grant(
    holder: Actor,
    productId: string,
    quantityBase: number,
    at: string,
    options: { readonly validUntil?: string } = {},
  ): Promise<string> {
    const id = freshUuid();
    await this.ok(this.magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: id,
      occurredAt: at,
      payload: {
        holderUserId: holder.userId,
        holderDeviceId: holder.deviceId,
        locationId: this.counter,
        productId,
        quantityBase,
        ...(options.validUntil !== undefined ? { validUntil: options.validUntil } : {}),
      },
    });
    this.granted.push(id);
    return id;
  }

  revoke(id: string, at: string, by: Actor = this.magP): Promise<CommandResult> {
    return this.online(by, {
      type: 'inventory.allocation.revoke',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: id,
      occurredAt: at,
      payload: { reason: 'Reprise du stock (test P5-21)' },
    });
  }

  quota(id: string) {
    return db
      .selectFrom('inventory_stock_allocations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async remainingOf(id: string): Promise<number> {
    return Number((await this.quota(id)).quantity_remaining);
  }

  async onHand(productId: string, location = this.counter): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`COALESCE(SUM(qty_on_hand), 0)`.as('qty'))
      .where('location_id', '=', toBin(location))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.qty);
  }

  /** Conflits ouverts d'un type sur une entité. */
  conflicts(type: string, entityId: string) {
    return db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'entity_type', 'owner_role', 'applied', 'status', 'details'])
      .where('conflict_type', '=', type)
      .where('entity_id', '=', toBin(entityId))
      .execute();
  }

  /** Types des conflits portant sur les produits du scénario (détail `productId`) ou ses documents. */
  async conflictTypesOfProducts(productIds: readonly string[]): Promise<string[]> {
    if (productIds.length === 0) return [];
    const rows = await db
      .selectFrom('sync_sync_conflicts')
      .select('conflict_type')
      .where(
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(details, '$.productId')) IN (${sql.join(productIds)})`,
      )
      .execute();
    return rows.map((row) => row.conflict_type).sort();
  }

  /** Lignes d'inbox des commandes d'un appareil. */
  inbox(deviceId: string) {
    return db
      .selectFrom('sync_command_inbox')
      .select([
        'command_id',
        'command_type',
        'status',
        'error_code',
        'occurred_at',
        'clock_skew_ms',
        'device_seq',
      ])
      .where('device_id', '=', toBin(deviceId))
      .orderBy('device_seq')
      .execute();
  }

  // --- Invariants -----------------------------------------------------------------------------------

  /** Registre de stock et quotas (INV-STK-10, 19, 20) sur les produits du scénario. */
  async expectStockLedgerOk(productIds: readonly string[]): Promise<void> {
    const verification = await db
      .transaction()
      .execute((trx) => verifyStockLedger(trx, { productIds }));
    expect(verification.allocationBreaches, JSON.stringify(verification)).toEqual([]);
    expect(verification.overcommitBreaches).toEqual([]);
    expect(verification.negativeBreaches).toEqual([]);
    expect(verification.ok, JSON.stringify(verification)).toBe(true);
  }

  /** Registre de trésorerie, remises et écarts de session (INV-FIN-02, 05, 11) des comptes du monde. */
  async expectCashOk(sessionIds: readonly string[], transferIds: readonly string[]): Promise<void> {
    const ledger = await db
      .transaction()
      .execute((trx) =>
        verifyCashLedger(trx, { cashAccountIds: [this.posAcc, this.central, this.mobileAcc] }),
      );
    expect(ledger.ok, JSON.stringify(ledger)).toBe(true);
    const transfers = await db
      .transaction()
      .execute((trx) => verifyCashTransfers(trx, { transferIds }));
    expect(transfers.ok, JSON.stringify(transfers)).toBe(true);
    for (const sessionId of sessionIds) {
      const variance = await db
        .transaction()
        .execute((trx) => verifyCashSessionVariance(trx, sessionId));
      expect(variance.ok, JSON.stringify(variance)).toBe(true);
    }
  }

  // --- Fin ------------------------------------------------------------------------------------------

  /** Révoque les quotas restés actifs (hygiène de la base partagée), puis ferme l'application. */
  async close(revokeAt: string): Promise<void> {
    // Un test échoué peut laisser l'horloge avant l'heure de révocation : jamais de date future.
    if (this.clock.now().getTime() < new Date(revokeAt).getTime()) this.setNow(revokeAt);
    try {
      for (const id of this.granted) {
        const row = await this.quota(id);
        if (row.status === 'ACTIVE') {
          const result = await this.revoke(id, revokeAt);
          expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
        }
      }
    } finally {
      await releaseShared();
    }
  }

  /** Identifiant texte d'une colonne binaire (aide de lecture). */
  static id(value: Buffer): string {
    return fromBin(value);
  }
}
