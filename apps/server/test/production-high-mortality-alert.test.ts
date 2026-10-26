/**
 * P9-09 : alerte `HIGH_MORTALITY` (D13 §7.1 « mortalité journalière > 0,5 % de l'effectif ou > 20 têtes »,
 * AV-121, AV-356, AV-411) — `HighMortalityDetected` publié par `production.mortality.record` quand le cumul
 * du jour métier **du fait** d'un lot atteint un seuil. Les saisies passent par le vrai pipeline de
 * commande (base partagée : fermes, produits et lots neufs ; seuils propres au site pour les cas
 * paramétrés, jamais globaux).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
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
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const DAY = '2026-10-26';
const PREVIOUS_DAY = '2026-10-25';
/** Mise en place des lots : avant le début de DAY (effectif en début de journée positif). */
const PLACED_AT = '2026-10-24T06:00:00.000Z';
const NOW = `${DAY}T20:00:00.000Z`;
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;

interface Farm {
  readonly siteId: string;
  readonly buildingId: string;
  readonly storeId: string;
  readonly manager: Actor;
  readonly chickLotId: string;
}

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('HIGH_MORTALITY : cumul du jour d’un lot, à la saisie (P9-09)', () => {
  let idGenerator: IdGenerator;
  let registry: CommandHandlerRegistry;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let productionManager: Actor;
  let farm: Farm;
  let tunedFarm: Farm;
  let chickId: string;
  let broilerId: string;
  let deviceSeq = 0;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean } = {},
  ): Promise<Result> {
    return pipeline.handle(
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
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function makeFarm(
    trx: UnitOfWork,
    zoneId: string,
    managerRole: string,
    stock: number,
    supplierId: string,
  ): Promise<Farm> {
    const siteId = await insertTestSite(trx, admin.userId, zoneId, { siteType: 'FERME' });
    const buildingId = await insertTestLocation(trx, admin.userId, siteId, {
      locationType: 'BUILDING',
    });
    const storeId = await insertTestLocation(trx, admin.userId, siteId);
    const userId = await insertTestUser(trx);
    const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
    await assignTestRole(trx, userId, managerRole, admin.userId, {
      scopeType: 'SITE',
      scopeSiteId: siteId,
    });
    const chickLotId = await ensureSupplierLot(
      trx,
      { idGenerator },
      {
        productId: chickId,
        supplierId,
        supplierLotRef: `PC-${freshUuid().slice(-8)}`,
        fallbackCode: `F:PC-${freshUuid().slice(-8)}`,
        expiryDate: null,
        originId: freshUuid(),
        fifoRankAt: new Date('2026-10-24T05:00:00.000Z'),
        createdBy: admin.userId,
      },
    );
    await recordStockMove(
      trx,
      { idGenerator },
      {
        productId: chickId,
        lotId: chickLotId,
        quantityBase: stock,
        fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
        toLocationId: storeId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 500,
        occurredAt: new Date('2026-10-24T05:00:00.000Z'),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin.userId,
        allowNegative: false,
      },
    );
    return { siteId, buildingId, storeId, manager: { userId, deviceId }, chickLotId };
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const farmManagerRole = await roleId('RESP_FERME');
    const productionRole = await roleId('RESP_PRODUCTION');
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);

      const userId = await insertTestUser(trx);
      productionManager = {
        userId,
        deviceId: await insertTestDevice(trx, userId, { status: 'ACTIVE' }),
      };
      await assignTestRole(trx, userId, productionRole, adminId);

      for (const [unit, name, isCount] of [['TETE', 'Tête', 1]] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name, is_count: isCount })
            .execute();
        }
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Élevage',
          created_by: toBin(adminId),
        })
        .execute();
      chickId = freshUuid();
      broilerId = freshUuid();
      const base = { category_id: toBin(categoryId), created_by: toBin(adminId) };
      await trx
        .insertInto('catalog_products')
        .values([
          {
            ...base,
            id: toBin(chickId),
            code: `PRD-${chickId.slice(-8)}`,
            name: 'Poussin d’un jour (chair)',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
          },
          {
            ...base,
            id: toBin(broilerId),
            code: `PRD-${broilerId.slice(-8)}`,
            name: 'Poulet de chair vif',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
          },
        ])
        .execute();
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      farm = await makeFarm(trx, zoneId, farmManagerRole, 30_000, supplierId);
      tunedFarm = await makeFarm(trx, zoneId, farmManagerRole, 5_000, supplierId);
    });
    // Seuils propres à la ferme réglée (jamais globaux : base partagée) : 3 têtes ou 50 %.
    for (const [key, value] of [
      ['production.high_mortality_alert_pct', 50],
      ['production.high_mortality_alert_heads', 3],
    ] as const) {
      await db
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key,
          value: jsonValue(value),
          scope_type: 'SITE',
          scope_id: toBin(tunedFarm.siteId),
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          is_client_visible: 0,
          reason: 'Réglage de test P9-09',
          created_by: toBin(admin.userId),
        })
        .execute();
    }
  });

  /** Lot de poulets de chair mis en place le `placedAt` avec `quantity` poussins ; code et identifiants. */
  async function placedLot(
    target: Farm,
    quantity: number,
    placedAt = PLACED_AT,
  ): Promise<{ id: string; code: string }> {
    const id = freshUuid();
    const created = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      id,
      placedAt,
      { lotType: 'POULET_CHAIR', productId: broilerId, mainLocationId: target.buildingId },
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    const placed = await run(
      target.manager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      placedAt,
      {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: chickId,
        sourceLocationId: target.storeId,
        sourceStockLotId: target.chickLotId,
        quantity,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    const row = await db
      .selectFrom('production_production_lots')
      .select('lot_code')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return { id, code: row.lot_code };
  }

  async function die(
    target: Farm,
    lotId: string,
    quantity: number,
    options: { readonly at?: string; readonly lossId?: string; readonly offline?: boolean } = {},
  ): Promise<{ result: Result; lossId: string }> {
    const lossId = options.lossId ?? freshUuid();
    const result = await run(
      target.manager,
      'production.mortality.record',
      'STOCK_LOSS',
      lossId,
      options.at ?? at('08:00'),
      { productionLotId: lotId, quantity },
      options.offline === undefined ? {} : { offline: options.offline },
    );
    expect(['APPLIED', 'APPLIED_WITH_WARNINGS'], JSON.stringify(result)).toContain(result.status);
    return { result, lossId };
  }

  async function mortalityEvents(lotId: string, days: readonly string[] = [DAY, PREVIOUS_DAY]) {
    const subjects = days.map((day) =>
      toBin(compositeSubjectId('HIGH_MORTALITY', { lot_id: lotId, business_day: day })),
    );
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'HighMortalityDetected')
        .where('aggregate_id', 'in', subjects)
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  it('la commande lit le cumul en lecture confirmée, sous le verrou du lot (concurrence, AV-411)', () => {
    expect(registry.resolve('production.mortality.record', 1)?.isolationLevel).toBe(
      'read committed',
    );
  });

  it('seuil absolu : 20 têtes n’alertent pas, la 21e oui (0,4 % de 5 000 : seul le seuil absolu joue)', async () => {
    const lot = await placedLot(farm, 5_000);
    await die(farm, lot.id, 12);
    await die(farm, lot.id, 8); // cumul 20 : « > 20 » strict
    expect(await mortalityEvents(lot.id)).toEqual([]);

    const last = await die(farm, lot.id, 1); // cumul 21
    const events = await mortalityEvents(lot.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.producerModule).toBe('production');
    expect(event!.aggregateType).toBe('LOT_DAY');
    expect(event!.payload).toEqual({
      lot_id: lot.id,
      lot_label: lot.code,
      business_day: DAY,
      site_id: farm.siteId,
      heads: 21,
      rate_pct: 0.42,
      reference_headcount: 5_000,
      cause: 'ABSOLUTE',
      threshold_pct: 0.5,
      threshold_heads: 20,
      last_loss_id: last.lossId,
      captured_offline: false,
    });
    // Un événement par saisie tant que le cumul reste au seuil (le compteur d'occurrences avance).
    await die(farm, lot.id, 2);
    const again = await mortalityEvents(lot.id);
    expect(again).toHaveLength(2);
    expect(again[1]!.payload).toMatchObject({ heads: 23, cause: 'ABSOLUTE' });
  });

  it('seuil relatif : 5 sur 1 000 (0,5 %) n’alerte pas, 6 sur 1 000 oui, sur l’effectif du début de journée', async () => {
    const lot = await placedLot(farm, 1_000);
    await die(farm, lot.id, 3);
    await die(farm, lot.id, 2); // cumul 5 : 0,5 %, strict
    expect(await mortalityEvents(lot.id)).toEqual([]);

    await die(farm, lot.id, 1); // cumul 6 : 0,6 % > 0,5 %
    const [event] = await mortalityEvents(lot.id);
    expect(event!.payload).toMatchObject({
      heads: 6,
      rate_pct: 0.6,
      reference_headcount: 1_000,
      cause: 'RELATIVE',
    });
  });

  it('les deux seuils dépassés : cause BOTH', async () => {
    const lot = await placedLot(farm, 1_000);
    await die(farm, lot.id, 25);
    const [event] = await mortalityEvents(lot.id);
    expect(event!.payload).toMatchObject({ heads: 25, rate_pct: 2.5, cause: 'BOTH' });
  });

  it('le jour métier est celui du fait : une saisie antidatée alimente l’alerte de son jour seulement', async () => {
    const lot = await placedLot(farm, 1_000);
    await die(farm, lot.id, 25, { at: at('09:00', PREVIOUS_DAY) });
    const before = await mortalityEvents(lot.id);
    expect(before).toHaveLength(1);
    expect(before[0]!.payload).toMatchObject({ business_day: PREVIOUS_DAY, heads: 25 });
    expect(before[0]!.aggregateId).toBe(
      compositeSubjectId('HIGH_MORTALITY', { lot_id: lot.id, business_day: PREVIOUS_DAY }),
    );

    // Aujourd'hui, une seule mort : le cumul du jour repart de zéro (0,1 %), aucun événement de plus.
    await die(farm, lot.id, 1);
    expect(await mortalityEvents(lot.id)).toHaveLength(1);
  });

  it('un lot mis en place le jour même : effectif de repli (après la saisie plus les morts du jour)', async () => {
    const lot = await placedLot(farm, 100, at('06:00'));
    await die(farm, lot.id, 1);
    const [event] = await mortalityEvents(lot.id);
    expect(event!.payload).toMatchObject({
      heads: 1,
      reference_headcount: 100,
      rate_pct: 1,
      cause: 'RELATIVE',
    });
  });

  it('les seuils du site priment sur les globaux ; le seuil absolu seul sans effectif de référence', async () => {
    const lot = await placedLot(tunedFarm, 1_000);
    await die(tunedFarm, lot.id, 3); // 0,3 % et 3 têtes : sous les seuils du site (3 têtes / 50 %)
    expect(await mortalityEvents(lot.id)).toEqual([]);
    await die(tunedFarm, lot.id, 1); // 4 têtes > 3
    const [event] = await mortalityEvents(lot.id);
    expect(event!.payload).toMatchObject({
      heads: 4,
      cause: 'ABSOLUTE',
      threshold_pct: 50,
      threshold_heads: 3,
    });
  });

  it('rejeu : la même saisie (même agrégat) ne publie pas une seconde fois', async () => {
    const lot = await placedLot(farm, 1_000);
    const { lossId } = await die(farm, lot.id, 30);
    expect(await mortalityEvents(lot.id)).toHaveLength(1);
    const replay = await run(
      farm.manager,
      'production.mortality.record',
      'STOCK_LOSS',
      lossId,
      at('08:00'),
      { productionLotId: lot.id, quantity: 30 },
    );
    expect(replay.status).toBe('APPLIED');
    expect(await mortalityEvents(lot.id)).toHaveLength(1);
  });

  it('une saisie refusée ne publie rien', async () => {
    const lot = await placedLot(farm, 1_000);
    // Emplacement d'une autre ferme : refusée avant toute écriture.
    const refused = await run(
      farm.manager,
      'production.mortality.record',
      'STOCK_LOSS',
      freshUuid(),
      at('08:00'),
      { productionLotId: lot.id, quantity: 30, locationId: tunedFarm.storeId },
    );
    expect(refused.status).toBe('REJECTED');
    expect(await mortalityEvents(lot.id)).toEqual([]);
  });

  it('lot clôturé, saisie hors ligne : le fait est appliqué (LOT_CLOSED) et l’alerte est publiée sans taux', async () => {
    const closed = freshUuid();
    await run(productionManager, 'production.lot.create', 'PRODUCTION_LOT', closed, PLACED_AT, {
      lotType: 'POULET_CHAIR',
      productId: broilerId,
      mainLocationId: farm.buildingId,
    });
    const entryId = freshUuid();
    await run(farm.manager, 'production.lot.record_entry', 'LOT_ENTRY', entryId, PLACED_AT, {
      productionLotId: closed,
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: chickId,
      sourceLocationId: farm.storeId,
      sourceStockLotId: farm.chickLotId,
      quantity: 5,
    });
    await run(
      productionManager,
      'production.lot.cancel_entry',
      'LOT_ENTRY',
      entryId,
      '2026-10-24T07:00:00.000Z',
      { comment: 'Erreur' },
    );
    const closing = await run(
      productionManager,
      'production.lot.close',
      'PRODUCTION_LOT',
      closed,
      '2026-10-24T08:00:00.000Z',
      {},
    );
    expect(closing.status, JSON.stringify(closing)).toBe('APPLIED');

    const { result } = await die(farm, closed, 25, { offline: true });
    expect(result).toMatchObject({ status: 'APPLIED_WITH_WARNINGS', warnings: ['LOT_CLOSED'] });
    const [event] = await mortalityEvents(closed);
    expect(event!.payload).toMatchObject({
      heads: 25,
      rate_pct: null,
      reference_headcount: 0,
      cause: 'ABSOLUTE',
      captured_offline: true,
    });
  });

  it('deux saisies simultanées du même lot : la seconde voit la première, le franchissement n’est pas manqué', async () => {
    const lot = await placedLot(farm, 1_000);
    // 5 + 5 = 10 > 0,5 % de 1 000 : aucune saisie seule n'atteint le seuil strict (5), leur somme oui.
    await Promise.all([die(farm, lot.id, 5), die(farm, lot.id, 5)]);
    const events = await mortalityEvents(lot.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...events.map((event) => Number(event.payload['heads'])))).toBe(10);
  });

  it('bornes du jour métier de Douala : 22:59:59.999Z est la veille, 23:00:00.000Z le jour même', async () => {
    const lot = await placedLot(farm, 1_000);
    await die(farm, lot.id, 25, { at: '2026-10-25T22:59:59.999Z' });
    await die(farm, lot.id, 25, { at: '2026-10-25T23:00:00.000Z' });
    const events = await mortalityEvents(lot.id);
    expect(events.map((event) => [event.payload['business_day'], event.payload['heads']])).toEqual([
      [PREVIOUS_DAY, 25],
      [DAY, 25],
    ]);
  });

  it('un lot mis en place le jour même : repli indépendant de l’ordre de saisie (aucune mort comptée deux fois)', async () => {
    const lot = await placedLot(farm, 50, at('06:00'));
    await die(farm, lot.id, 10, { at: at('14:00') });
    // Saisie hors ligne antérieure à la première, synchronisée ensuite : même effectif de référence.
    await die(farm, lot.id, 2, { at: at('08:00'), offline: true });
    const events = await mortalityEvents(lot.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ heads: 10, reference_headcount: 50, rate_pct: 20 });
    expect(events[1]!.payload).toMatchObject({ heads: 12, reference_headcount: 50, rate_pct: 24 });
  });

  it('statuts du cumul : une saisie sans validation (RECORDED) compte ; une saisie rejetée ne compte plus', async () => {
    // Politique du jour précédent sans validation : les saisies sont comptabilisées d'emblée.
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00', PREVIOUS_DAY),
      {
        code: `MORTALITY_${policyId.slice(-8)}`,
        operationType: 'MORTALITY',
        validFrom: at('00:00', PREVIOUS_DAY),
        validTo: `${PREVIOUS_DAY}T23:59:59.000Z`,
        requiresApproval: false,
        requiresPhoto: false,
        approverPermission: 'production.mortality.approve',
        approverScope: 'ALL',
        condition: { relativePct: 0, absoluteHeads: 0 },
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    const recordedLot = await placedLot(farm, 5_000);
    const recorded = await die(farm, recordedLot.id, 21, { at: at('09:00', PREVIOUS_DAY) });
    const row = await db
      .selectFrom('inventory_loss_declarations')
      .select('status')
      .where('id', '=', toBin(recorded.lossId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('RECORDED');
    const [event] = await mortalityEvents(recordedLot.id);
    expect(event!.payload).toMatchObject({ heads: 21, cause: 'ABSOLUTE' });

    // Jour courant (validation requise par la politique semée) : une saisie rejetée sort du cumul.
    const lot = await placedLot(farm, 5_000);
    const first = await die(farm, lot.id, 15);
    await die(farm, lot.id, 10); // cumul 25 : une alerte
    expect(await mortalityEvents(lot.id)).toHaveLength(1);
    const approval = await db
      .selectFrom('inventory_loss_declarations')
      .select(['approval_request_id', 'status'])
      .where('id', '=', toBin(first.lossId))
      .executeTakeFirstOrThrow();
    expect(approval.status).toBe('PENDING_APPROVAL');
    const requestId = fromBin(approval.approval_request_id!);
    const rejected = await run(
      productionManager,
      'approvals.request.reject',
      'APPROVAL_REQUEST',
      requestId,
      at('10:00'),
      { requestId, comment: 'Erreur de saisie' },
    );
    expect(rejected.status, JSON.stringify(rejected)).toBe('APPLIED');
    await die(farm, lot.id, 1); // 10 + 1 = 11 : sous le seuil, la saisie rejetée n'y est plus
    expect(await mortalityEvents(lot.id)).toHaveLength(1);
  });

  it('bout en bout : alerte critique levée par le consommateur, une alerte par lot et par jour', async () => {
    const lot = await placedLot(farm, 1_000);
    await die(farm, lot.id, 25, { at: at('09:00', PREVIOUS_DAY) });
    await die(farm, lot.id, 25);
    const events = await mortalityEvents(lot.id);
    expect(events).toHaveLength(2);
    await rolledBack(async (uow: UnitOfWork) => {
      for (const event of events) await handleAlertEvent(uow, event, { idGenerator });
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select(['severity', 'status', 'title', 'message', 'site_id', 'dedup_key'])
        .where('dedup_key', 'in', [
          `HIGH_MORTALITY:LOT_DAY:${lot.id}:${PREVIOUS_DAY}`,
          `HIGH_MORTALITY:LOT_DAY:${lot.id}:${DAY}`,
        ])
        .execute();
      // La deuxième journée d'une épidémie a sa propre alerte (non absorbée par celle de la veille).
      expect(alerts).toHaveLength(2);
      for (const alert of alerts) {
        expect(alert).toMatchObject({
          severity: 'CRITICAL',
          status: 'OPEN',
          title: 'Mortalité élevée',
        });
        expect(fromBin(alert.site_id as Buffer)).toBe(farm.siteId);
        expect(alert.message).toContain(lot.code);
        expect(alert.message).toContain('Têtes mortes : 25');
        expect(alert.message).toContain('Taux du jour (%) : 2,5');
      }
    });
  });
});
