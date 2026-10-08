/**
 * Quotas d'appareil, P5-08 (ADR-033, SM-ALLOCATION, BR-STK-011 à BR-STK-014, INV-STK-19, INV-STK-20) :
 * `inventory.allocation.grant | increase | revoke | release` à travers le vrai pipeline de commande,
 * le consommateur `inventory.allocation_revocation` et la tâche `inventory.allocations.expiry_daily`.
 * Même niveau que inventory-loss-commands.test.ts (pipeline réel, base MySQL réelle).
 *
 * Démontre : capacité d'octroi (Σ restes actifs ≤ stock, bord inclus), sérialisation de deux octrois
 * concurrents, octroi / augmentation / révocation en ligne seulement, rejeu sans double écriture,
 * conflit de version sur l'augmentation, libération par le seul détenteur depuis son appareil (écart
 * déclaré = avertissement et conflit, jamais corrigé en silence), quota échu libéré (`EXPIRED_RELEASED`),
 * `revocation_pending` posé puis levé sans aucun mouvement automatique, un événement d'échéance par
 * quota et par jour métier, et INV-STK-20 : Σ des entrées du registre = reste.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  allocationValidUntil,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import { toDomainEvent, type DomainEvent } from '../src/platform/events/domain-event.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { registerAllocationCommands } from '../src/modules/inventory/application/commands/allocation-commands.js';
import {
  ALLOCATION_REVOCATION_CONSUMER_NAME,
  registerAllocationRevocationConsumer,
} from '../src/modules/inventory/application/events/allocation-revocation-consumer.js';
import {
  ALLOCATION_EXPIRY_JOB_TYPE,
  AllocationExpiryJob,
} from '../src/modules/inventory/application/jobs/allocation-expiry-job.js';
import {
  recordStockMove,
  type RecordMoveDeps,
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
  insertTestProduct,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-08T09:00:00.000Z';

type Extra = Record<string, unknown>;

/** Un numéro de séquence distinct par commande : un appareil ne rejoue jamais le même. */
let nextDeviceSeq = 1;

function buildEnvelope(
  authorUserId: string,
  command: {
    readonly command_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
  },
  extra: Extra = {},
): Record<string, unknown> {
  const occurredAt = command.occurred_at ?? OCCURRED_AT;
  return {
    command_id: freshUuid(),
    device_seq: nextDeviceSeq++,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    client_created_at: occurredAt,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    aggregate_type: 'STOCK_ALLOCATION',
    ...command,
    occurred_at: occurredAt,
    ...extra,
  };
}

interface Holder {
  readonly userId: string;
  readonly deviceId: string;
}

describe('quotas d’appareil (P5-08, ADR-033)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let moveDeps: RecordMoveDeps;
  let admin: string;
  let manager: string;
  let managerDevice: string;
  let outsider: string;
  let outsiderDevice: string;
  let siteId: string;
  let storeA: string;
  let holderRole: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock as Clock);
    moveDeps = { idGenerator };
    const registry = new CommandHandlerRegistry();
    registerAllocationCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    manager = await db.transaction().execute((trx) => insertTestUser(trx));
    managerDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, manager, { status: 'ACTIVE' }));
    outsider = await db.transaction().execute((trx) => insertTestUser(trx));
    outsiderDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, outsider, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const otherSiteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const managerRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, managerRole, 'inventory.allocation.manage', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, manager, managerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      // Même droit, mais sur un autre site : la portée de l'emplacement le refuse (AV-162).
      await assignTestRole(trx, outsider, managerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: otherSiteId,
      });

      holderRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, holderRole, 'inventory.allocation.release', admin, {
        maxScope: 'OWN',
      });
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const managerCtx = () => ({
    authenticatedUserId: manager,
    authenticatedDeviceId: managerDevice,
    transport: 'ONLINE_API' as const,
  });
  const holderCtx = (holder: Holder) => ({
    authenticatedUserId: holder.userId,
    authenticatedDeviceId: holder.deviceId,
    transport: 'SYNC_PUSH' as const,
  });

  async function newHolder(): Promise<Holder> {
    return db.transaction().execute(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      await assignTestRole(trx, userId, holderRole, admin);
      return { userId, deviceId };
    });
  }

  async function newProduct(stock: number): Promise<string> {
    const productId = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
    if (stock > 0) await stockIn(productId, stock);
    return productId;
  }

  async function stockIn(productId: string, quantityBase: number): Promise<void> {
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        quantityBase,
        fromLocationId: fromBin(opening.id),
        toLocationId: storeA,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 500,
        occurredAt: new Date(OCCURRED_AT),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
  }

  function grant(
    holder: Holder,
    productId: string,
    quantityBase: number,
    payload: Extra = {},
    extra: Extra = {},
    author: string = manager,
  ) {
    const id = freshUuid();
    const envelope = buildEnvelope(
      author,
      {
        command_type: 'inventory.allocation.grant',
        aggregate_id: id,
        payload: {
          holderUserId: holder.userId,
          holderDeviceId: holder.deviceId,
          locationId: storeA,
          productId,
          quantityBase,
          ...payload,
        },
      },
      extra,
    );
    return { id, envelope };
  }

  async function grantOk(
    holder: Holder,
    productId: string,
    quantityBase: number,
    payload: Extra = {},
  ): Promise<string> {
    const { id, envelope } = grant(holder, productId, quantityBase, payload);
    const result = await pipeline.handle(envelope, managerCtx());
    expect(result.status).toBe('APPLIED');
    return id;
  }

  const rejectionCode = (result: { status: string; error?: { code: string } }) =>
    result.status === 'REJECTED' ? result.error?.code : undefined;

  async function quota(id: string) {
    return db
      .selectFrom('inventory_stock_allocations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  /** Entrées du registre dans l'ordre logique du cycle de vie (elles partagent l'instant d'octroi). */
  async function entries(id: string) {
    const order = ['GRANT', 'INCREASE', 'RESTORE', 'CONSUME', 'RELEASE', 'REVOKE'];
    const rows = await db
      .selectFrom('inventory_stock_allocation_entries')
      .select(['entry_type', 'quantity'])
      .where('allocation_id', '=', toBin(id))
      .execute();
    return rows.sort((a, b) => order.indexOf(a.entry_type) - order.indexOf(b.entry_type));
  }

  /** INV-STK-20 : le reste d'un quota est la somme signée de ses entrées. */
  async function expectLedgerMatchesRemaining(id: string): Promise<void> {
    const rows = await entries(id);
    const sumMilli = rows.reduce(
      (total, row) => total + Math.round(Number(row.quantity) * 1000),
      0,
    );
    const row = await quota(id);
    expect(sumMilli).toBe(Math.round(Number(row.quantity_remaining) * 1000));
  }

  async function conflictsOf(entityId: string, type: string) {
    return db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'applied', 'details'])
      .where('entity_id', '=', toBin(entityId))
      .where('conflict_type', '=', type)
      .execute();
  }

  describe('octroi', () => {
    it('crée le quota, son entrée GRANT et la validité par défaut (fin du jour métier, AV-160)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const { id, envelope } = grant(holder, productId, 40);
      const result = await pipeline.handle(envelope, managerCtx());
      expect(result.status).toBe('APPLIED');

      const row = await quota(id);
      expect(row.status).toBe('ACTIVE');
      expect(Number(row.quantity_granted)).toBe(40);
      expect(Number(row.quantity_remaining)).toBe(40);
      expect(row.revocation_pending).toBe(0);
      expect(row.valid_until?.toISOString()).toBe(
        allocationValidUntil(new Date(OCCURRED_AT)).toISOString(),
      );
      expect(fromBin(row.holder_device_id as Buffer)).toBe(holder.deviceId);
      expect(await entries(id)).toEqual([{ entry_type: 'GRANT', quantity: '40.000' }]);
      await expectLedgerMatchesRemaining(id);
    });

    it('durée en heures : validité = octroi + durée', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const id = await grantOk(holder, productId, 5, { validityHours: 3 });
      expect((await quota(id)).valid_until?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    });

    it('date de fin antérieure à l’octroi -> VALIDITY_INVALID', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const { envelope } = grant(holder, productId, 5, { validUntil: '2026-10-08T08:00:00.000Z' });
      const result = await pipeline.handle(envelope, managerCtx());
      expect(rejectionCode(result)).toBe('VALIDITY_INVALID');
    });

    it('capacité : Σ restes actifs ≤ stock, bord inclus (INV-STK-19)', async () => {
      const productId = await newProduct(100);
      const first = await newHolder();
      const second = await newHolder();
      await grantOk(first, productId, 70);

      const tooMuch = grant(second, productId, 31);
      const refused = await pipeline.handle(tooMuch.envelope, managerCtx());
      expect(rejectionCode(refused)).toBe('ALLOCATION_EXCEEDS_AVAILABLE');
      expect(
        await db
          .selectFrom('inventory_stock_allocations')
          .select('id')
          .where('id', '=', toBin(tooMuch.id))
          .executeTakeFirst(),
      ).toBeUndefined();

      const exact = grant(second, productId, 30);
      expect((await pipeline.handle(exact.envelope, managerCtx())).status).toBe('APPLIED');
      const third = await newHolder();
      const nothingLeft = grant(third, productId, 1);
      expect(rejectionCode(await pipeline.handle(nothingLeft.envelope, managerCtx()))).toBe(
        'ALLOCATION_EXCEEDS_AVAILABLE',
      );
    });

    it('le stock non alloué compte : un quota libéré rend sa quantité', async () => {
      const productId = await newProduct(50);
      const first = await newHolder();
      const second = await newHolder();
      const firstId = await grantOk(first, productId, 50);
      expect(
        rejectionCode(await pipeline.handle(grant(second, productId, 1).envelope, managerCtx())),
      ).toBe('ALLOCATION_EXCEEDS_AVAILABLE');

      const release = await pipeline.handle(
        buildEnvelope(first.userId, {
          command_type: 'inventory.allocation.release',
          aggregate_id: firstId,
          payload: { remainingBase: 50 },
        }),
        holderCtx(first),
      );
      expect(release.status).toBe('APPLIED');
      expect(
        (await pipeline.handle(grant(second, productId, 50).envelope, managerCtx())).status,
      ).toBe('APPLIED');
    });

    it('deux octrois concurrents sur le dernier stock : un seul passe (verrou des soldes)', async () => {
      const productId = await newProduct(100);
      const first = await newHolder();
      const second = await newHolder();
      const a = grant(first, productId, 60);
      const b = grant(second, productId, 60);
      const [resultA, resultB] = await Promise.all([
        pipeline.handle(a.envelope, managerCtx()),
        pipeline.handle(b.envelope, managerCtx()),
      ]);
      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual(['APPLIED', 'REJECTED']);
      const refused = resultA.status === 'REJECTED' ? resultA : resultB;
      expect(rejectionCode(refused)).toBe('ALLOCATION_EXCEEDS_AVAILABLE');

      const active = await db
        .selectFrom('inventory_stock_allocations')
        .select('quantity_remaining')
        .where('product_id', '=', toBin(productId))
        .where('status', '=', 'ACTIVE')
        .execute();
      const total = active.reduce((sum, row) => sum + Number(row.quantity_remaining), 0);
      expect(total).toBeLessThanOrEqual(100);
    });

    it('un second quota actif du même couple (détenteur, appareil, emplacement, produit) -> ALLOCATION_ALREADY_ACTIVE', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      await grantOk(holder, productId, 10);
      const again = grant(holder, productId, 5);
      expect(rejectionCode(await pipeline.handle(again.envelope, managerCtx()))).toBe(
        'ALLOCATION_ALREADY_ACTIVE',
      );
    });

    it('rejeu du même octroi (même quota, autre command_id) : aucune seconde entrée', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const first = grant(holder, productId, 20);
      expect((await pipeline.handle(first.envelope, managerCtx())).status).toBe('APPLIED');
      const replay = {
        ...first.envelope,
        command_id: freshUuid(),
      };
      expect((await pipeline.handle(replay, managerCtx())).status).toBe('APPLIED');
      expect(await entries(first.id)).toHaveLength(1);
      expect(Number((await quota(first.id)).quantity_granted)).toBe(20);
    });

    it('hors ligne -> ONLINE_ONLY (octroi, augmentation, révocation)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const offline = grant(holder, productId, 10, {}, { captured_offline: true });
      expect(rejectionCode(await pipeline.handle(offline.envelope, managerCtx()))).toBe(
        'ONLINE_ONLY',
      );

      const id = await grantOk(holder, productId, 10);
      for (const [commandType, payload, base] of [
        ['inventory.allocation.increase', { quantityBase: 1 }, 1],
        ['inventory.allocation.revoke', { reason: 'Test hors ligne' }, null],
      ] as const) {
        const result = await pipeline.handle(
          buildEnvelope(
            manager,
            { command_type: commandType, aggregate_id: id, payload },
            { captured_offline: true, base_version: base },
          ),
          managerCtx(),
        );
        expect(rejectionCode(result)).toBe('ONLINE_ONLY');
      }
      expect((await quota(id)).status).toBe('ACTIVE');
    });

    it('gestionnaire d’un autre site -> FORBIDDEN_SCOPE (portée de l’emplacement, AV-162)', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const { id, envelope } = grant(holder, productId, 10, {}, {}, outsider);
      const result = await pipeline.handle(envelope, {
        authenticatedUserId: outsider,
        authenticatedDeviceId: outsiderDevice,
        transport: 'ONLINE_API',
      });
      expect(rejectionCode(result)).toBe('FORBIDDEN_SCOPE');
      expect(
        await db
          .selectFrom('inventory_stock_allocations')
          .select('id')
          .where('id', '=', toBin(id))
          .executeTakeFirst(),
      ).toBeUndefined();
    });

    it('détenteur ou appareil inapte, emplacement non partagé ou virtuel : refus nommés', async () => {
      const productId = await newProduct(100);

      const blocked = await newHolder();
      await db
        .updateTable('identity_devices')
        .set({ status: 'BLOCKED' })
        .where('id', '=', toBin(blocked.deviceId))
        .execute();
      expect(
        rejectionCode(await pipeline.handle(grant(blocked, productId, 5).envelope, managerCtx())),
      ).toBe('ALLOCATION_HOLDER_INVALID');

      const suspended = await newHolder();
      await db
        .updateTable('identity_users')
        .set({ status: 'SUSPENDED', status_reason: 'Test' })
        .where('id', '=', toBin(suspended.userId))
        .execute();
      expect(
        rejectionCode(await pipeline.handle(grant(suspended, productId, 5).envelope, managerCtx())),
      ).toBe('ALLOCATION_HOLDER_INVALID');

      const holder = await newHolder();
      const exclusive = await db.transaction().execute(async (trx) => {
        const id = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
        await trx
          .updateTable('organization_locations')
          .set({ custody_mode: 'EXCLUSIVE_DEVICE', designated_device_id: toBin(holder.deviceId) })
          .where('id', '=', toBin(id))
          .execute();
        return id;
      });
      expect(
        rejectionCode(
          await pipeline.handle(
            grant(holder, productId, 5, { locationId: exclusive }).envelope,
            managerCtx(),
          ),
        ),
      ).toBe('ALLOCATION_LOCATION_NOT_SHARED');

      const virtual = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_OPENING')
        .executeTakeFirstOrThrow();
      expect(
        rejectionCode(
          await pipeline.handle(
            grant(holder, productId, 5, { locationId: fromBin(virtual.id) }).envelope,
            managerCtx(),
          ),
        ),
      ).toBe('ALLOCATION_LOCATION_INVALID');
    });
  });

  describe('augmentation', () => {
    function increase(id: string, quantityBase: number, baseVersion: number | null) {
      return buildEnvelope(
        manager,
        {
          command_type: 'inventory.allocation.increase',
          aggregate_id: id,
          payload: { quantityBase },
        },
        { base_version: baseVersion },
      );
    }

    it('version de base exigée, puis augmentation : quantités, version et entrée INCREASE', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantOk(holder, productId, 30);
      const version = (await quota(id)).version;

      expect(rejectionCode(await pipeline.handle(increase(id, 10, null), managerCtx()))).toBe(
        'BASE_VERSION_REQUIRED',
      );
      expect((await pipeline.handle(increase(id, 10, version), managerCtx())).status).toBe(
        'APPLIED',
      );

      const row = await quota(id);
      expect(Number(row.quantity_granted)).toBe(40);
      expect(Number(row.quantity_remaining)).toBe(40);
      expect(row.version).toBe(version + 1);
      expect((await entries(id)).map((e) => e.entry_type)).toEqual(['GRANT', 'INCREASE']);
      await expectLedgerMatchesRemaining(id);
    });

    it('double envoi sur la même version : le second n’est pas appliqué, conflit ouvert', async () => {
      const holder = await newHolder();
      const productId = await newProduct(100);
      const id = await grantOk(holder, productId, 30);
      const version = (await quota(id)).version;

      expect((await pipeline.handle(increase(id, 10, version), managerCtx())).status).toBe(
        'APPLIED',
      );
      const second = await pipeline.handle(increase(id, 10, version), managerCtx());
      expect(second.status).toBe('CONFLICT');

      expect(Number((await quota(id)).quantity_granted)).toBe(40); // une seule augmentation
      const conflicts = await conflictsOf(id, 'VERSION_CONFLICT');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.applied).toBe(0);
    });

    it('au-delà du stock non alloué -> ALLOCATION_EXCEEDS_AVAILABLE ; quota révoqué -> ALLOCATION_NOT_ACTIVE', async () => {
      const holder = await newHolder();
      const productId = await newProduct(50);
      const id = await grantOk(holder, productId, 30);
      const version = (await quota(id)).version;

      expect(rejectionCode(await pipeline.handle(increase(id, 21, version), managerCtx()))).toBe(
        'ALLOCATION_EXCEEDS_AVAILABLE',
      );
      expect((await pipeline.handle(increase(id, 20, version), managerCtx())).status).toBe(
        'APPLIED',
      );

      const revoke = buildEnvelope(manager, {
        command_type: 'inventory.allocation.revoke',
        aggregate_id: id,
        payload: { reason: 'Reprise du stock' },
      });
      expect((await pipeline.handle(revoke, managerCtx())).status).toBe('APPLIED');
      const after = (await quota(id)).version;
      expect(rejectionCode(await pipeline.handle(increase(id, 1, after), managerCtx()))).toBe(
        'ALLOCATION_NOT_ACTIVE',
      );
    });
  });

  describe('révocation', () => {
    it('ferme le quota, inscrit son reste (REVOKE), rend le stock ; le rejeu ne change rien', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      const id = await grantOk(holder, productId, 40);
      const envelope = buildEnvelope(manager, {
        command_type: 'inventory.allocation.revoke',
        aggregate_id: id,
        payload: { reason: 'Appareil repris' },
      });
      expect((await pipeline.handle(envelope, managerCtx())).status).toBe('APPLIED');

      const row = await quota(id);
      expect(row.status).toBe('REVOKED');
      expect(Number(row.quantity_remaining)).toBe(0);
      expect(row.revoke_reason).toBe('Appareil repris');
      expect(row.revoked_at).not.toBeNull();
      expect((await entries(id)).map((e) => [e.entry_type, e.quantity])).toEqual([
        ['GRANT', '40.000'],
        ['REVOKE', '-40.000'],
      ]);
      await expectLedgerMatchesRemaining(id);

      const replay = { ...envelope, command_id: freshUuid() };
      expect((await pipeline.handle(replay, managerCtx())).status).toBe('APPLIED');
      expect(await entries(id)).toHaveLength(2);

      // Le stock redevient allouable (aucun mouvement de stock n'a eu lieu).
      const other = await newHolder();
      expect(
        (await pipeline.handle(grant(other, productId, 40).envelope, managerCtx())).status,
      ).toBe('APPLIED');
    });

    it('un quota déjà libéré ne se révoque pas -> ALLOCATION_NOT_ACTIVE', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const id = await grantOk(holder, productId, 10);
      await pipeline.handle(
        buildEnvelope(holder.userId, {
          command_type: 'inventory.allocation.release',
          aggregate_id: id,
          payload: { remainingBase: 10 },
        }),
        holderCtx(holder),
      );
      const result = await pipeline.handle(
        buildEnvelope(manager, {
          command_type: 'inventory.allocation.revoke',
          aggregate_id: id,
          payload: { reason: 'Trop tard' },
        }),
        managerCtx(),
      );
      expect(rejectionCode(result)).toBe('ALLOCATION_NOT_ACTIVE');
    });
  });

  describe('libération', () => {
    function release(holder: Holder, id: string, remainingBase: number, extra: Extra = {}) {
      return buildEnvelope(
        holder.userId,
        {
          command_type: 'inventory.allocation.release',
          aggregate_id: id,
          payload: { remainingBase },
          ...(extra.occurred_at !== undefined ? { occurred_at: extra.occurred_at as string } : {}),
        },
        { captured_offline: true },
      );
    }

    it('par le détenteur depuis son appareil, hors ligne : fermé, reste inscrit, aucun conflit si le déclaré est juste', async () => {
      const holder = await newHolder();
      const productId = await newProduct(60);
      const id = await grantOk(holder, productId, 25);
      const result = await pipeline.handle(release(holder, id, 25), holderCtx(holder));
      expect(result.status).toBe('APPLIED');

      const row = await quota(id);
      expect(row.status).toBe('CLOSED');
      expect(row.close_cause).toBe('RELEASED');
      expect(Number(row.quantity_remaining)).toBe(0);
      expect(Number(row.release_declared_remaining)).toBe(25);
      expect((await entries(id)).map((e) => e.entry_type)).toEqual(['GRANT', 'RELEASE']);
      await expectLedgerMatchesRemaining(id);
      expect(await conflictsOf(id, 'ALLOCATION_RELEASE_MISMATCH')).toHaveLength(0);
    });

    it('reste déclaré différent de celui du serveur : libéré, avertissement et conflit — jamais corrigé en silence', async () => {
      const holder = await newHolder();
      const productId = await newProduct(60);
      const id = await grantOk(holder, productId, 25);
      const result = await pipeline.handle(release(holder, id, 20), holderCtx(holder));
      expect(result.status).toBe('APPLIED_WITH_WARNINGS');
      expect(result.status === 'APPLIED_WITH_WARNINGS' && result.warnings).toEqual([
        'ALLOCATION_RELEASE_MISMATCH',
      ]);

      const row = await quota(id);
      expect(row.status).toBe('CLOSED');
      expect(Number(row.release_declared_remaining)).toBe(20);
      const conflicts = await conflictsOf(id, 'ALLOCATION_RELEASE_MISMATCH');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.applied).toBe(1);
      const details = conflicts[0]?.details as Record<string, unknown>;
      expect(details['declaredRemaining']).toBe('20.000');
      expect(details['serverRemaining']).toBe('25.000');
      // L'entrée du registre porte le reste du serveur, pas le déclaré (ADR-033 §9).
      expect((await entries(id)).map((e) => e.quantity)).toEqual(['25.000', '-25.000']);
    });

    it('un autre utilisateur, ou le bon utilisateur depuis un autre appareil -> ALLOCATION_NOT_HOLDER', async () => {
      const holder = await newHolder();
      const stranger = await newHolder();
      const productId = await newProduct(30);
      const id = await grantOk(holder, productId, 30);

      const byStranger = await pipeline.handle(release(stranger, id, 30), holderCtx(stranger));
      expect(rejectionCode(byStranger)).toBe('ALLOCATION_NOT_HOLDER');

      const wrongDevice = await pipeline.handle(release(holder, id, 30), {
        authenticatedUserId: holder.userId,
        authenticatedDeviceId: stranger.deviceId,
        transport: 'SYNC_PUSH',
      });
      expect(rejectionCode(wrongDevice)).toBe('ALLOCATION_NOT_HOLDER');
      expect((await quota(id)).status).toBe('ACTIVE');
    });

    it('quota déjà révoqué par le serveur : le fait de l’appareil est accepté sans rien rouvrir', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      const id = await grantOk(holder, productId, 30);
      await pipeline.handle(
        buildEnvelope(manager, {
          command_type: 'inventory.allocation.revoke',
          aggregate_id: id,
          payload: { reason: 'Reprise' },
        }),
        managerCtx(),
      );
      const result = await pipeline.handle(release(holder, id, 30), holderCtx(holder));
      expect(result.status).toBe('APPLIED');
      expect((await quota(id)).status).toBe('REVOKED');
      expect(await entries(id)).toHaveLength(2);
    });

    it('après l’échéance : cause EXPIRED_RELEASED ; le serveur n’a rien libéré seul', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      const id = await grantOk(holder, productId, 30, { validityHours: 1 });
      clock.setTo(new Date('2026-10-08T11:00:00.000Z'));
      try {
        const result = await pipeline.handle(
          release(holder, id, 30, { occurred_at: '2026-10-08T11:00:00.000Z' }),
          holderCtx(holder),
        );
        expect(result.status).toBe('APPLIED');
        expect((await quota(id)).close_cause).toBe('EXPIRED_RELEASED');
      } finally {
        clock.setTo(new Date(OCCURRED_AT));
      }
    });
  });

  describe('consommateur inventory.allocation_revocation', () => {
    const registry = new EventConsumerRegistry();
    registerAllocationRevocationConsumer(
      registry,
      new Uuidv7Generator(new FixedClock(new Date(OCCURRED_AT))),
    );
    const handler = registry.resolve(ALLOCATION_REVOCATION_CONSUMER_NAME)!;

    async function publish(eventType: string, aggregateId: string): Promise<DomainEvent> {
      const eventId = freshUuid();
      await db
        .insertInto('platform_domain_events')
        .values({
          event_id: toBin(eventId),
          event_type: eventType,
          producer_module: 'identity',
          aggregate_type: 'TEST',
          aggregate_id: toBin(aggregateId),
          occurred_at: new Date(OCCURRED_AT),
          payload: jsonValue({}),
        })
        .execute();
      const row = await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_id', '=', toBin(eventId))
        .executeTakeFirstOrThrow();
      return toDomainEvent(row);
    }

    const handle = (event: DomainEvent) => db.transaction().execute((trx) => handler(trx, event));

    async function pendingEvents(id: string): Promise<number> {
      const rows = await db
        .selectFrom('platform_domain_events')
        .select('seq')
        .where('event_type', '=', 'AllocationRevocationPending')
        .where('aggregate_id', '=', toBin(id))
        .execute();
      return rows.length;
    }

    it('appareil bloqué : quotas actifs signalés une seule fois (rejouable), stock et reste intacts', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      const id = await grantOk(holder, productId, 40);
      const before = await quota(id);

      await db
        .updateTable('identity_devices')
        .set({ status: 'BLOCKED' })
        .where('id', '=', toBin(holder.deviceId))
        .execute();
      const event = await publish('identity.device.block', holder.deviceId);
      await handle(event);

      const flagged = await quota(id);
      expect(flagged.revocation_pending).toBe(1);
      expect(flagged.status).toBe('ACTIVE');
      expect(Number(flagged.quantity_remaining)).toBe(40); // aucun mouvement automatique
      expect(flagged.version).toBe(before.version + 1);
      expect(await pendingEvents(id)).toBe(1);

      await handle(event); // au moins une fois : la redélivrance ne republie rien
      expect(await pendingEvents(id)).toBe(1);
      expect((await quota(id)).version).toBe(before.version + 1);
      expect(await entries(id)).toHaveLength(1);
    });

    it('un quota libéré n’est pas signalé ; la révocation du responsable lève le signal', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      const open = await grantOk(holder, productId, 20);
      const other = await newHolder();
      const productB = await newProduct(40);
      const closed = await grantOk(
        { userId: holder.userId, deviceId: holder.deviceId },
        productB,
        5,
      );
      await pipeline.handle(
        buildEnvelope(holder.userId, {
          command_type: 'inventory.allocation.release',
          aggregate_id: closed,
          payload: { remainingBase: 5 },
        }),
        holderCtx(holder),
      );
      expect(other.userId).not.toBe(holder.userId);

      await handle(await publish('identity.device.declare_lost', holder.deviceId));
      expect((await quota(open)).revocation_pending).toBe(1);
      expect((await quota(closed)).revocation_pending).toBe(0);
      expect(await pendingEvents(closed)).toBe(0);

      const revoke = await pipeline.handle(
        buildEnvelope(manager, {
          command_type: 'inventory.allocation.revoke',
          aggregate_id: open,
          payload: { reason: 'Appareil perdu' },
        }),
        managerCtx(),
      );
      expect(revoke.status).toBe('APPLIED');
      const row = await quota(open);
      expect(row.status).toBe('REVOKED');
      expect(row.revocation_pending).toBe(0);
    });

    it('utilisateur désactivé puis appareil débloqué : le signal ne tombe que lorsque les deux sont en service', async () => {
      const holder = await newHolder();
      const productId = await newProduct(40);
      const id = await grantOk(holder, productId, 40);

      await db
        .updateTable('identity_users')
        .set({ status: 'DEACTIVATED', status_reason: 'Départ' })
        .where('id', '=', toBin(holder.userId))
        .execute();
      await handle(await publish('identity.user.deactivate', holder.userId));
      expect((await quota(id)).revocation_pending).toBe(1);

      // L'appareil, lui, est en service : son déblocage seul ne lève pas le signal de l'utilisateur.
      await handle(await publish('identity.device.unblock', holder.deviceId));
      expect((await quota(id)).revocation_pending).toBe(1);

      await db
        .updateTable('identity_users')
        .set({ status: 'ACTIVE', status_reason: null })
        .where('id', '=', toBin(holder.userId))
        .execute();
      await handle(await publish('identity.user.reactivate', holder.userId));
      const cleared = await quota(id);
      expect(cleared.revocation_pending).toBe(0);
      expect(cleared.status).toBe('ACTIVE');
      expect(Number(cleared.quantity_remaining)).toBe(40);
    });

    it('événement étranger au consommateur : sans effet', async () => {
      const holder = await newHolder();
      const productId = await newProduct(10);
      const id = await grantOk(holder, productId, 10);
      await handle(await publish('identity.device.rename', holder.deviceId));
      expect((await quota(id)).revocation_pending).toBe(0);
    });
  });

  describe('tâche inventory.allocations.expiry_daily', () => {
    function expiryHandler() {
      const jobs = new JobHandlerRegistry();
      new AllocationExpiryJob(clock, idGenerator, jobs).onModuleInit();
      return jobs.resolve(ALLOCATION_EXPIRY_JOB_TYPE)!;
    }

    async function expiredEvents(id: string): Promise<number> {
      const rows = await db
        .selectFrom('platform_domain_events')
        .select('seq')
        .where('event_type', '=', 'AllocationExpired')
        .where('aggregate_id', '=', toBin(id))
        .execute();
      return rows.length;
    }

    it('signale chaque quota échu une fois par jour métier, sans le modifier ni le libérer', async () => {
      const holder = await newHolder();
      const productId = await newProduct(30);
      const shortLived = await grantOk(holder, productId, 10, { validityHours: 1 });
      const other = await newHolder();
      const longLived = await grantOk(other, productId, 10, { validityHours: 10 });
      const run = expiryHandler();

      clock.setTo(new Date('2026-10-08T11:00:00.000Z'));
      try {
        await db.transaction().execute((trx) => run(trx, {}));
        expect(await expiredEvents(shortLived)).toBe(1);
        expect(await expiredEvents(longLived)).toBe(0);

        await db.transaction().execute((trx) => run(trx, {})); // rejouable le même jour
        expect(await expiredEvents(shortLived)).toBe(1);

        const row = await quota(shortLived);
        expect(row.status).toBe('ACTIVE');
        expect(Number(row.quantity_remaining)).toBe(10);
        expect(await entries(shortLived)).toHaveLength(1);

        // Le lendemain (jour métier suivant), un quota toujours actif est signalé de nouveau.
        clock.setTo(new Date('2026-10-09T11:00:00.000Z'));
        await db.transaction().execute((trx) => run(trx, {}));
        expect(await expiredEvents(shortLived)).toBe(2);
      } finally {
        clock.setTo(new Date(OCCURRED_AT));
      }
    });
  });
});
