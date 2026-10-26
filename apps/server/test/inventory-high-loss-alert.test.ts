/**
 * P9-08 : alerte `HIGH_LOSS` du seuil absolu (D13 §7.1, AV-406, AV-453) — `HighLossDetected` publié à la
 * déclaration d'une perte quand le cumul du jour métier du fait, pour l'emplacement, atteint
 * `inventory.high_loss_alert_xaf` ; lecture partagée `dayLossByLocation` (statuts comptés, mortalité
 * exclue). Les déclarations passent par le vrai pipeline de commande (base partagée : emplacement et
 * produit neufs par cas).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  dayLossByLocation,
  recordStockMove,
} from '../src/modules/inventory/application/public/index.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
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
  neutralizePolicy,
  withoutActivePolicies,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const DAY_ONE = '2026-10-20T10:00:00.000Z';
/** Veille de DAY_ONE : un fait daté du passé reste accepté (la date du futur est refusée). */
const DAY_EARLIER = '2026-10-19T10:00:00.000Z';

describe('HIGH_LOSS : seuil absolu, à la déclaration (P9-08)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let siteId: string;
  let openingLocation: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(DAY_ONE));
    idGenerator = new Uuidv7Generator(clock);
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    registerLossCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'inventory.loss.declare', admin);
      await grantTestPermission(trx, role, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, role, admin);
    });
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    openingLocation = fromBin(opening.id);
    // Seuil absolu du site commun à la suite (jamais global : base partagée) ; les réglages sont
    // versionnés par date de validité, une seule version suffit.
    await db
      .insertInto('organization_system_settings')
      .values({
        id: toBin(freshUuid()),
        key: 'inventory.high_loss_alert_xaf',
        value: jsonValue(10_000),
        scope_type: 'SITE',
        scope_id: toBin(siteId),
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        is_client_visible: 0,
        reason: 'Réglage de test P9-08',
        created_by: toBin(admin),
      })
      .execute();
  });

  const ctx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });

  async function freshStore(stock: number): Promise<{ store: string; product: string }> {
    const store = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, siteId, { locationType: 'STORE' }));
    const product = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId: product,
          quantityBase: stock,
          fromLocationId: openingLocation,
          toLocationId: store,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 500,
          occurredAt: new Date(DAY_ONE),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
    return { store, product };
  }

  async function declare(
    store: string,
    product: string,
    quantity: number,
    options: {
      readonly at?: string;
      readonly category?: string;
      readonly productionLotId?: string;
    } = {},
  ): Promise<string> {
    const lossId = freshUuid();
    const at = options.at ?? DAY_ONE;
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        command_type: 'inventory.loss.declare',
        aggregate_type: 'STOCK_LOSS',
        aggregate_id: lossId,
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        occurred_at: at,
        client_created_at: at,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          locationId: store,
          productId: product,
          quantityBase: quantity,
          unitCode: 'TETE',
          quantity,
          category: options.category ?? 'CASSE',
          comment: 'Casse en manutention.',
          ...(options.productionLotId !== undefined
            ? { productionLotId: options.productionLotId }
            : {}),
        },
      },
      ctx(),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return lossId;
  }

  async function highLossEvents(store: string) {
    const subjects = ['2026-10-19', '2026-10-20'].map((day) =>
      toBin(compositeSubjectId('HIGH_LOSS', { location_id: store, business_day: day })),
    );
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'HighLossDetected')
        .where('aggregate_id', 'in', subjects)
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  it('le cumul du jour franchit le seuil du site : un événement par déclaration ensuite', async () => {
    const { store, product } = await freshStore(100);

    await declare(store, product, 8); // 4 000
    await declare(store, product, 9); // cumul 8 500
    expect(await highLossEvents(store)).toEqual([]);

    const third = await declare(store, product, 5); // cumul 11 000 ≥ 10 000
    const events = await highLossEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]!.producerModule).toBe('inventory');
    expect(events[0]!.aggregateType).toBe('LOSS_DAY');
    expect(events[0]!.payload).toEqual({
      location_id: store,
      business_day: '2026-10-20',
      location_label: 'Emplacement de test',
      site_id: siteId,
      loss_quantity: 22,
      loss_value_xaf: 11_000,
      declarations: 3,
      cause: 'ABSOLUTE',
      threshold_xaf: 10_000,
      last_loss_id: third,
    });

    await declare(store, product, 1); // cumul 11 500
    const again = await highLossEvents(store);
    expect(again).toHaveLength(2);
    expect(again[1]!.payload).toMatchObject({ loss_value_xaf: 11_500, declarations: 4 });
  });

  it('un autre jour métier repart de zéro ; la perte d’un autre emplacement ne compte pas', async () => {
    const first = await freshStore(100);
    const second = await freshStore(100);
    await declare(first.store, first.product, 15); // 7 500 le jour courant
    await declare(second.store, second.product, 15); // autre emplacement
    await declare(first.store, first.product, 15, { at: DAY_EARLIER }); // 7 500 la veille (fait saisi après coup)
    expect(await highLossEvents(first.store)).toEqual([]);
    expect(await highLossEvents(second.store)).toEqual([]);
    // La veille passe le seuil avec une déclaration de plus : le jour métier est celui du fait.
    await declare(first.store, first.product, 6, { at: DAY_EARLIER }); // 10 500
    const events = await highLossEvents(first.store);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      business_day: '2026-10-19',
      loss_value_xaf: 10_500,
    });
  });

  it('sans réglage propre au site : défaut global de 50 000 XAF, borne atteinte comprise', async () => {
    // Site neuf, sans aucun réglage : la suite pose les siens sur le site commun.
    const zone = await db.transaction().execute((trx) => insertTestZone(trx, admin));
    const freshSite = await db.transaction().execute((trx) => insertTestSite(trx, admin, zone));
    const store = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, freshSite, { locationType: 'STORE' }));
    const product = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId: product,
          quantityBase: 300,
          fromLocationId: openingLocation,
          toLocationId: store,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 500,
          occurredAt: new Date(DAY_ONE),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
    await declare(store, product, 99); // 49 500 < 50 000
    expect(await highLossEvents(store)).toEqual([]);
    await declare(store, product, 1); // 50 000 : borne atteinte
    const events = await highLossEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ threshold_xaf: 50_000, loss_value_xaf: 50_000 });
  });

  it('la mortalité n’entre pas dans le cumul : une perte ordinaire ne franchit pas le seuil à cause d’elle', async () => {
    const { store, product } = await freshStore(100);
    // Mortalité déjà déclarée ce jour-là (déclaration insérée : le cumul d'une perte ordinaire l'ignore).
    const mortality = freshUuid();
    await db
      .insertInto('inventory_loss_declarations')
      .values({
        id: toBin(mortality),
        doc_number: `PRT-T-${mortality.slice(-8)}`,
        site_id: toBin(siteId),
        location_id: toBin(store),
        product_id: toBin(product),
        quantity_base: '50',
        unit_code: 'TETE',
        quantity: '50',
        category: 'MORTALITE',
        production_lot_id: toBin(freshUuid()),
        declared_by: toBin(admin),
        status: 'RECORDED',
        unit_cost_xaf: 500,
        value_xaf: 25_000,
        occurred_at: new Date(DAY_ONE),
        created_by: toBin(admin),
      })
      .execute();
    await declare(store, product, 4); // 2 000 XAF : sous le seuil de 10 000, avec ou sans la mortalité
    expect(await highLossEvents(store)).toEqual([]);
  });

  it('une déclaration de mortalité ne publie jamais l’alerte de perte, même si le cumul ordinaire l’atteint', async () => {
    const { store, product } = await freshStore(100);
    await declare(store, product, 25); // 12 500 XAF ≥ 10 000 : l'alerte est levée une fois
    expect(await highLossEvents(store)).toHaveLength(1);
    await withoutActivePolicies('MORTALITY', new Date(DAY_ONE), async () => {
      const policyId = freshUuid();
      const set = await pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: 1,
          command_version: 1,
          command_type: 'approvals.policy.set',
          aggregate_type: 'CONTROL_POLICY',
          aggregate_id: policyId,
          author_user_id: admin,
          base_version: null,
          depends_on: [],
          occurred_at: DAY_ONE,
          client_created_at: DAY_ONE,
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: [],
          payload: {
            code: `MORT_${policyId.slice(-8)}`,
            operationType: 'MORTALITY',
            requiresApproval: true,
            approverPermission: 'production.mortality.approve',
            approverScope: 'ALL',
          },
        },
        ctx(),
      );
      expect(set.status, JSON.stringify(set)).toBe('APPLIED');
      try {
        await declare(store, product, 3, { category: 'MORTALITE', productionLotId: freshUuid() });
        // Aucune alerte de plus : la mortalité a la sienne (`HIGH_MORTALITY`, production).
        expect(await highLossEvents(store)).toHaveLength(1);
      } finally {
        await neutralizePolicy(policyId);
      }
    });
  });

  it('bout en bout : alerte critique levée par le consommateur, valeur au coût absente du message', async () => {
    const { store, product } = await freshStore(100);
    await declare(store, product, 25); // 12 500
    const [event] = await highLossEvents(store);
    expect(event).toBeDefined();
    await rolledBack(async (uow: UnitOfWork) => {
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['severity', 'status', 'title', 'message', 'payload', 'site_id'])
        .where('dedup_key', '=', `HIGH_LOSS:LOSS_DAY:${store}:2026-10-20`)
        .executeTakeFirstOrThrow();
      expect(alert).toMatchObject({
        severity: 'CRITICAL',
        status: 'OPEN',
        title: 'Pertes anormales',
      });
      expect(fromBin(alert.site_id as Buffer)).toBe(siteId);
      // RC-05 : le rendu neutre du message ne porte jamais la valeur au coût.
      expect(alert.message).not.toContain('12 500');
      expect(alert.message).not.toContain('12500');
      expect(alert.message).toContain('Emplacement de test');
    });
  });
});

describe('dayLossByLocation (P9-08) : statuts comptés, catégories exclues', () => {
  it('compte constatées, en attente, non justifiées, en annulation ; ignore rendues et annulées ; exclut la mortalité', () =>
    rolledBack(async (uow) => {
      const admin = await insertTestUser(uow);
      const zone = await insertTestZone(uow, admin);
      const site = await insertTestSite(uow, admin, zone);
      const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
      const other = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
      const product = await insertTestProduct(uow, admin);
      let n = 0;
      const insert = async (
        location: string,
        status: string,
        valueXaf: number,
        options: { readonly category?: string; readonly at?: string } = {},
      ) => {
        n += 1;
        const id = freshUuid();
        await uow
          .insertInto('inventory_loss_declarations')
          .values({
            id: toBin(id),
            doc_number: `PRT-T-${id.slice(-8)}`,
            site_id: toBin(site),
            location_id: toBin(location),
            product_id: toBin(product),
            quantity_base: String(n),
            unit_code: 'TETE',
            quantity: String(n),
            category: options.category ?? 'CASSE',
            comment: 'x',
            declared_by: toBin(admin),
            status,
            unit_cost_xaf: 1,
            value_xaf: valueXaf,
            occurred_at: new Date(options.at ?? DAY_ONE),
            created_by: toBin(admin),
            ...(options.category === 'MORTALITE' ? { production_lot_id: toBin(freshUuid()) } : {}),
          })
          .execute();
      };
      // production_lot_id sans clé étrangère : référence libre (dictionnaire).
      await insert(store, 'RECORDED', 1_000);
      await insert(store, 'PENDING_APPROVAL', 2_000);
      await insert(store, 'APPROVED', 4_000);
      await insert(store, 'REJECTED_UNJUSTIFIED', 8_000);
      await insert(store, 'CANCELLATION_PENDING', 16_000);
      await insert(store, 'REJECTED_RETURNED', 32_000); // rendue : pas une perte
      await insert(store, 'CANCELLED', 64_000); // annulée
      await insert(store, 'RECORDED', 128_000, { category: 'MORTALITE' });
      await insert(store, 'RECORDED', 256_000, { at: DAY_EARLIER }); // autre jour métier
      await insert(other, 'RECORDED', 512_000);

      const day = (options: { excludeCategories?: readonly string[] } = {}) =>
        dayLossByLocation(uow, { businessDay: '2026-10-20', locationIds: [store], ...options });
      const [all] = await day();
      expect(all).toMatchObject({
        locationId: store,
        siteId: site,
        declarations: 6,
        valueXaf: 1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 128_000,
      });
      const [withoutMortality] = await day({ excludeCategories: ['MORTALITE'] });
      expect(withoutMortality).toMatchObject({
        declarations: 5,
        valueXaf: 1_000 + 2_000 + 4_000 + 8_000 + 16_000,
      });
      // Sans filtre d'emplacement : un emplacement par ligne, la plus lourde d'abord.
      const bySite = await dayLossByLocation(uow, {
        businessDay: '2026-10-20',
        siteIds: [site],
        excludeCategories: ['MORTALITE'],
      });
      expect(bySite.map((line) => line.locationId)).toEqual([other, store]);
      expect(await dayLossByLocation(uow, { businessDay: '2026-10-20', locationIds: [] })).toEqual(
        [],
      );
    }));
});

describe('dayLossByLocation (P9-08) : jour métier de Douala et quantité', () => {
  it('le jour métier est celui de Douala (UTC+1) : 23:30Z est le lendemain, 22:59:59Z la veille', () =>
    rolledBack(async (uow) => {
      const admin = await insertTestUser(uow);
      const zone = await insertTestZone(uow, admin);
      const site = await insertTestSite(uow, admin, zone);
      const store = await insertTestLocation(uow, admin, site, { locationType: 'STORE' });
      const first = await insertTestProduct(uow, admin);
      const second = await insertTestProduct(uow, admin);
      const insert = async (at: string, product: string, valueXaf: number, quantity: number) => {
        const id = freshUuid();
        await uow
          .insertInto('inventory_loss_declarations')
          .values({
            id: toBin(id),
            doc_number: `PRT-T-${id.slice(-8)}`,
            site_id: toBin(site),
            location_id: toBin(store),
            product_id: toBin(product),
            quantity_base: String(quantity),
            unit_code: 'TETE',
            quantity: String(quantity),
            category: 'CASSE',
            comment: 'x',
            declared_by: toBin(admin),
            status: 'RECORDED',
            unit_cost_xaf: 1,
            value_xaf: valueXaf,
            occurred_at: new Date(at),
            created_by: toBin(admin),
          })
          .execute();
      };
      // Jour du 20 octobre à Douala = [19 octobre 23:00Z, 20 octobre 23:00Z[.
      await insert('2026-10-19T22:59:59.000Z', first, 1, 1); // le 19
      await insert('2026-10-19T23:00:00.000Z', first, 10, 2); // le 20, borne basse
      await insert('2026-10-19T23:30:00.000Z', first, 100, 3); // le 20
      await insert('2026-10-20T22:59:59.000Z', first, 1_000, 4); // le 20, dernière seconde
      await insert('2026-10-20T23:00:00.000Z', first, 10_000, 5); // le 21
      const on = (businessDay: string) =>
        dayLossByLocation(uow, { businessDay, locationIds: [store] });
      const [day20] = await on('2026-10-20');
      expect(day20).toMatchObject({ declarations: 3, valueXaf: 1_110, quantityBase: 9 });
      expect((await on('2026-10-19'))[0]).toMatchObject({ declarations: 1, valueXaf: 1 });
      expect((await on('2026-10-21'))[0]).toMatchObject({ declarations: 1, valueXaf: 10_000 });

      // Deux produits le même jour : la valeur se cumule, la quantité (unités différentes) n'est pas publiée.
      await insert('2026-10-20T10:00:00.000Z', second, 500, 7);
      expect((await on('2026-10-20'))[0]).toMatchObject({
        declarations: 4,
        valueXaf: 1_610,
        quantityBase: null,
      });
    }));
});
