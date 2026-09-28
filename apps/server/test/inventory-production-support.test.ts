/**
 * P7-02 — prérequis `inventory` de la production, à travers le vrai pipeline et l'API publique :
 * - mortalité (catégorie `MORTALITE`, tout point d'entrée) validée par la politique `MORTALITY`
 *   du Responsable production (AV-048, AV-119) : refus d'approbation par le Responsable ferme,
 *   approbation bloquée tant que la photo manque (AV-107), seuils de la politique, politique
 *   absente, mortalité d'un lot d'incubation (AV-113) ;
 * - consommation valorisée à 0 XAF : fait physique enregistré sans écriture de coût, nature
 *   conservée ; annulation ;
 * - écart d'inventaire sur des animaux : validation `ANIMAL_COUNT_ADJUSTMENT` quel que soit le
 *   montant (AV-108) ;
 * - frais généraux d'une ferme ventilés par espèce (AV-103, AV-104) : saisie, portée, refus,
 *   annulation, annulation refusée après répartition ;
 * - lots de stock de production, effectif d'un lot à un instant, têtes × jours (ADR-026).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { registerOverheadCommands } from '../src/modules/inventory/application/commands/overhead-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  costObjectBalance,
  createStockLot,
  lotHeadDays,
  lotHeadcount,
  recordCostEntry,
  recordStockMove,
  setStockLotStatus,
  virtualLocationId,
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
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-08';
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-02 : prérequis inventory de la production', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let finance: Actor;
  let farmId: string;
  let otherFarmId: string;
  let storeSiteId: string;
  let buildingId: string;
  let farmStoreId: string;
  let chickenId: string;
  let feedId: string;
  let productionLotId: string;
  let stockLotId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly attachmentIds?: readonly string[] } = {},
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
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [...(options.attachmentIds ?? [])],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  }

  async function setPolicy(
    operationType: string,
    occurredAt: string,
    extra: Record<string, unknown>,
  ): Promise<string> {
    const policyId = freshUuid();
    const result = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      occurredAt,
      {
        code: `${operationType}_${policyId.slice(-8)}`,
        operationType,
        validFrom: occurredAt,
        ...extra,
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return policyId;
  }

  async function lossRow(lossId: string) {
    return db
      .selectFrom('inventory_loss_declarations')
      .selectAll()
      .where('id', '=', toBin(lossId))
      .executeTakeFirstOrThrow();
  }

  async function approvalOf(approvalId: Buffer) {
    return db
      .selectFrom('approvals_approval_requests')
      .selectAll()
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow();
  }

  function mortality(quantity: number, extra: Record<string, unknown> = {}) {
    return {
      locationId: buildingId,
      productId: chickenId,
      lotId: stockLotId,
      productionLotId,
      quantityBase: quantity,
      unitCode: 'TETE',
      quantity,
      category: 'MORTALITE',
      ...extra,
    };
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerConsumptionCommands(registry, idGenerator);
    registerCountCommands(registry, decisions, idGenerator, sequences);
    registerOverheadCommands(registry, idGenerator);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      fin: await roleId('FINANCE'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      storeSiteId = await insertTestSite(trx, adminId, zoneId);
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      farmStoreId = await insertTestLocation(trx, adminId, farmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);
      finance = await actor(roles.fin);

      for (const [unit, name] of [
        ['TETE', 'Tête'],
        ['KG', 'Kilogramme'],
      ] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name, is_count: unit === 'TETE' ? 1 : 0 })
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
      chickenId = freshUuid();
      feedId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values([
          {
            id: toBin(chickenId),
            code: `PRD-${chickenId.slice(-8)}`,
            name: 'Poulet de chair vif',
            category_id: toBin(categoryId),
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
            created_by: toBin(adminId),
          },
          {
            id: toBin(feedId),
            code: `PRD-${feedId.slice(-8)}`,
            name: 'Aliment démarrage',
            category_id: toBin(categoryId),
            stock_family: 'INTRANT',
            base_unit_code: 'KG',
            lot_tracking: 'NONE',
            created_by: toBin(adminId),
          },
        ])
        .execute();

      // Lot de production (référence sans clé étrangère avant P7-04) et son lot de traçabilité,
      // 1 000 têtes mises en place la veille à 08:00.
      productionLotId = freshUuid();
      stockLotId = await createStockLot(
        trx,
        { idGenerator },
        {
          originType: 'PRODUCTION_LOT',
          originId: productionLotId,
          lotCode: `LOT-${productionLotId.slice(-12)}`,
          productId: chickenId,
          fifoRankAt: new Date(at('08:00:00', '2026-10-07')),
          expiryDate: null,
          createdBy: adminId,
        },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: chickenId,
          lotId: stockLotId,
          quantityBase: 1000,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: buildingId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 500,
          occurredAt: new Date(at('08:00:00', '2026-10-07')),
          sourceDocType: 'LOT_ENTRY',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('lots de stock de production ; effectif à un instant et têtes × jours (ADR-026)', async () => {
    expect(await lotHeadcount(db, { lotId: stockLotId, scope: 'REARING' })).toBe(1000);
    expect(
      await lotHeadcount(db, {
        lotId: stockLotId,
        scope: 'REARING',
        at: new Date(at('07:59:59', '2026-10-07')),
      }),
    ).toBe(0);
    // 07/10 (arrivée à 09:00 heure de Douala) et 08/10 : 1 000 têtes en fin de chaque jour.
    const headDays = await lotHeadDays(db, {
      lotId: stockLotId,
      scope: 'REARING',
      fromUtc: new Date('2026-10-06T23:00:00.000Z'),
      toUtc: new Date('2026-10-08T23:00:00.000Z'),
      days: ['2026-10-07', '2026-10-08'],
    });
    expect(headDays).toBe(2000);
    const lot = await db
      .selectFrom('inventory_stock_lots')
      .select(['origin_type', 'status'])
      .where('id', '=', toBin(stockLotId))
      .executeTakeFirstOrThrow();
    expect(lot).toEqual({ origin_type: 'PRODUCTION_LOT', status: 'OPEN' });
  });

  it('AV-048/AV-107 : toute mortalité validée par le Resp. production, approbation bloquée sans photo', async () => {
    await setPolicy('MORTALITY', at('06:00:00'), {
      requiresApproval: true,
      requiresPhoto: true,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
      condition: { relativePct: 0, absoluteHeads: 0 },
    });
    const lossId = freshUuid();
    const declared = await run(
      farmManager,
      'inventory.loss.declare',
      'STOCK_LOSS',
      lossId,
      at('07:00:00'),
      mortality(3),
    );
    expect(declared.status, JSON.stringify(declared)).toBe('APPLIED');
    const loss = await lossRow(lossId);
    expect(loss).toMatchObject({
      status: 'PENDING_APPROVAL',
      category: 'MORTALITE',
      requires_photo: 1,
    });
    const approval = await approvalOf(loss.approval_request_id!);
    expect(approval.operation_type).toBe('MORTALITY');
    const approvalId = fromBin(approval.id);
    expect(await lotHeadcount(db, { lotId: stockLotId, scope: 'REARING' })).toBe(997);

    // Le Responsable ferme n'a pas `production.mortality.approve` (AV-005).
    expect(
      code(
        await run(
          farmManager,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          approvalId,
          at('08:00:00'),
          { requestId: approvalId },
        ),
      ),
    ).toBe('APPROVER_NOT_ALLOWED');
    // Aucune photo reçue : approbation refusée, la déclaration reste en attente (AV-107).
    expect(
      code(
        await run(
          productionManager,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          approvalId,
          at('08:05:00'),
          { requestId: approvalId },
        ),
      ),
    ).toBe('ATTACHMENT_MISSING');
    expect((await lossRow(lossId)).status).toBe('PENDING_APPROVAL');

    const photo = freshUuid();
    await db
      .insertInto('attachments_attachments')
      .values({
        id: toBin(photo),
        owner_type: 'STOCK_LOSS',
        owner_id: toBin(lossId),
        kind: 'PHOTO',
        mime_type: 'image/jpeg',
        size_bytes: 2_000,
        uploaded_bytes: 2_000,
        sha256: 'b'.repeat(64),
        storage_key: `test/${photo}`,
        upload_status: 'AVAILABLE',
        captured_at: new Date(at('07:00:00')),
        occurred_at: new Date(at('07:00:00')),
        created_by: toBin(farmManager.userId),
      })
      .execute();
    expect(
      code(
        await run(
          productionManager,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          approvalId,
          at('08:10:00'),
          { requestId: approvalId },
        ),
      ),
    ).toBe('APPLIED');
    expect((await lossRow(lossId)).status).toBe('APPROVED');
    expect(await lotHeadcount(db, { lotId: stockLotId, scope: 'REARING' })).toBe(997);
  });

  it('seuils de la politique MORTALITY ; politique absente ; mortalité d’un lot d’incubation (AV-113)', async () => {
    // Politique plus récente avec seuils (0,5 % de l'effectif ou 20 têtes) : 2 têtes → enregistrée.
    await setPolicy('MORTALITY', at('09:00:00'), {
      requiresApproval: true,
      requiresPhoto: true,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
      condition: { relativePct: 0.5, absoluteHeads: 20 },
    });
    const small = freshUuid();
    expect(
      code(
        await run(
          farmManager,
          'inventory.loss.declare',
          'STOCK_LOSS',
          small,
          at('09:30:00'),
          mortality(2),
        ),
      ),
    ).toBe('APPLIED');
    expect((await lossRow(small)).status).toBe('RECORDED');
    const large = freshUuid();
    expect(
      code(
        await run(
          farmManager,
          'inventory.loss.declare',
          'STOCK_LOSS',
          large,
          at('09:35:00'),
          mortality(21),
        ),
      ),
    ).toBe('APPLIED');
    expect((await lossRow(large)).status).toBe('PENDING_APPROVAL');

    const incubationBatchId = freshUuid();
    const chicks = freshUuid();
    const incubationMortality = await run(
      farmManager,
      'inventory.loss.declare',
      'STOCK_LOSS',
      chicks,
      at('09:40:00'),
      {
        ...mortality(1, { productionLotId: undefined, incubationBatchId }),
      },
    );
    expect(code(incubationMortality)).toBe('APPLIED');
    expect(fromBin((await lossRow(chicks)).incubation_batch_id!)).toBe(incubationBatchId);

    // Sans aucune politique MORTALITY active : refus de configuration (AV-048).
    const active = await db
      .selectFrom('approvals_control_policies')
      .select('id')
      .where('operation_type', '=', 'MORTALITY')
      .where('status', '=', 'ACTIVE')
      .execute();
    await db
      .updateTable('approvals_control_policies')
      .set({ status: 'RETIRED', valid_to: new Date(at('00:00:00', '2020-01-01')) })
      .where('operation_type', '=', 'MORTALITY')
      .where('status', '=', 'ACTIVE')
      .execute();
    try {
      expect(
        code(
          await run(
            farmManager,
            'inventory.loss.declare',
            'STOCK_LOSS',
            freshUuid(),
            at('10:00:00'),
            mortality(1),
          ),
        ),
      ).toBe('CONTROL_POLICY_MISSING');
    } finally {
      for (const row of active) {
        await db
          .updateTable('approvals_control_policies')
          .set({ status: 'ACTIVE', valid_to: null })
          .where('id', '=', row.id)
          .execute();
      }
    }
  });

  it('consommation valorisée à 0 XAF : enregistrée sans écriture de coût, nature conservée, annulable', async () => {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: feedId,
          quantityBase: 100,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: farmStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 0,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'LOT_ENTRY',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
    const consumptionId = freshUuid();
    const recorded = await run(
      farmManager,
      'inventory.consumption.record',
      'CONSUMPTION',
      consumptionId,
      at('11:00:00'),
      {
        locationId: farmStoreId,
        productId: feedId,
        quantityBase: 25,
        unitCode: 'KG',
        quantity: 25,
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: productionLotId,
        costType: 'ALIMENT',
      },
    );
    expect(recorded.status, JSON.stringify(recorded)).toBe('APPLIED');
    const row = await db
      .selectFrom('inventory_consumptions')
      .select(['cost_type', 'value_xaf', 'status'])
      .where('id', '=', toBin(consumptionId))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ cost_type: 'ALIMENT', value_xaf: 0, status: 'RECORDED' });
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select('id')
      .where('source_doc_id', '=', toBin(consumptionId))
      .execute();
    const entries = await db
      .selectFrom('inventory_cost_entries')
      .select('id')
      .where(
        'source_id',
        'in',
        moves.map((m) => m.id),
      )
      .execute();
    expect(entries).toHaveLength(0);
    expect(
      code(
        await run(
          farmManager,
          'inventory.consumption.cancel',
          'CONSUMPTION',
          consumptionId,
          at('11:30:00'),
          { consumptionId },
        ),
      ),
    ).toBe('APPLIED');
  });

  it('AV-108 : un écart d’inventaire sur des animaux exige la validation du Resp. production', async () => {
    await setPolicy('ANIMAL_COUNT_ADJUSTMENT', at('06:00:00'), {
      requiresApproval: true,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
    });
    const countId = freshUuid();
    expect(
      code(
        await run(farmManager, 'inventory.count.open', 'INVENTORY_COUNT', countId, at('12:00:00'), {
          locationId: buildingId,
          countType: 'SPOT',
        }),
      ),
    ).toBe('APPLIED');
    const theoretical = await lotHeadcount(db, {
      lotId: stockLotId,
      scope: 'REARING',
      at: new Date(at('12:05:00')),
    });
    expect(
      code(
        await run(
          farmManager,
          'inventory.count.record_lines',
          'INVENTORY_COUNT',
          countId,
          at('12:10:00'),
          {
            countId,
            lines: [
              {
                productId: chickenId,
                lotId: stockLotId,
                countedAt: at('12:05:00'),
                countedQtyBase: theoretical - 1,
              },
            ],
          },
        ),
      ),
    ).toBe('APPLIED');
    expect(
      code(
        await run(
          farmManager,
          'inventory.count.submit',
          'INVENTORY_COUNT',
          countId,
          at('12:15:00'),
          { countId },
        ),
      ),
    ).toBe('APPLIED');
    const count = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status', 'approval_request_id'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(count.status).toBe('PENDING_APPROVAL'); // 1 tête × 500 XAF, sous le seuil en valeur
    const approval = await approvalOf(count.approval_request_id!);
    expect(approval.operation_type).toBe('ANIMAL_COUNT_ADJUSTMENT');
    const approvalId = fromBin(approval.id);
    expect(
      code(
        await run(
          farmManager,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          approvalId,
          at('12:20:00'),
          { requestId: approvalId },
        ),
      ),
    ).toBe('APPROVER_NOT_ALLOWED');
    expect(
      code(
        await run(
          productionManager,
          'approvals.request.approve',
          'APPROVAL_REQUEST',
          approvalId,
          at('12:25:00'),
          { requestId: approvalId },
        ),
      ),
    ).toBe('APPLIED');
    expect(
      (
        await db
          .selectFrom('inventory_inventory_counts')
          .select('status')
          .where('id', '=', toBin(countId))
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('POSTED');
  });

  it('AV-103/104 : frais généraux ventilés par espèce ; portée ; annulation refusée après répartition', async () => {
    const entryId = freshUuid();
    const recorded = await run(
      finance,
      'inventory.overhead.record',
      'OVERHEAD_ENTRY',
      entryId,
      at('13:00:00'),
      {
        siteId: farmId,
        label: 'Gardiennage d’octobre',
        lines: [
          { speciesGroup: 'VOLAILLE', amountXaf: 60_000 },
          { speciesGroup: 'PORC', amountXaf: 40_000 },
        ],
      },
    );
    expect(recorded.status, JSON.stringify(recorded)).toBe('APPLIED');
    const month = { from: new Date('2026-09-30T23:00:00.000Z'), at: new Date(at('23:00:00')) };
    expect(
      (
        await costObjectBalance(db, {
          costObjectType: 'SITE',
          costObjectId: farmId,
          speciesGroup: 'VOLAILLE',
          ...month,
        })
      ).netXaf,
    ).toBe(60_000);
    expect(
      (
        await costObjectBalance(db, {
          costObjectType: 'SITE',
          costObjectId: farmId,
          speciesGroup: 'PORC',
          ...month,
        })
      ).netXaf,
    ).toBe(40_000);

    const line = { speciesGroup: 'VOLAILLE', amountXaf: 1_000 };
    expect(
      code(
        await run(
          farmManager,
          'inventory.overhead.record',
          'OVERHEAD_ENTRY',
          freshUuid(),
          at('13:05:00'),
          { siteId: farmId, label: 'Électricité', lines: [line] },
        ),
      ),
    ).toBe('APPLIED');
    expect(
      code(
        await run(
          otherFarmManager,
          'inventory.overhead.record',
          'OVERHEAD_ENTRY',
          freshUuid(),
          at('13:05:00'),
          { siteId: farmId, label: 'x', lines: [line] },
        ),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code(
        await run(
          finance,
          'inventory.overhead.record',
          'OVERHEAD_ENTRY',
          freshUuid(),
          at('13:05:00'),
          { siteId: storeSiteId, label: 'x', lines: [line] },
        ),
      ),
    ).toBe('SITE_NOT_FARM');
    expect(
      code(
        await run(
          finance,
          'inventory.overhead.record',
          'OVERHEAD_ENTRY',
          freshUuid(),
          at('13:05:00'),
          { siteId: farmId, label: 'x', lines: [line, line] },
        ),
      ),
    ).toBe('SPECIES_DUPLICATE');

    const cancelled = await run(
      finance,
      'inventory.overhead.cancel',
      'OVERHEAD_ENTRY',
      entryId,
      at('14:00:00'),
      {
        entryId,
        comment: 'Saisie en double',
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    expect(
      (
        await costObjectBalance(db, {
          costObjectType: 'SITE',
          costObjectId: farmId,
          speciesGroup: 'PORC',
          ...month,
        })
      ).netXaf,
    ).toBe(0);

    // Mois de la volaille déjà réparti (écriture ALLOCATION) : l'annulation est refusée.
    const second = freshUuid();
    expect(
      code(
        await run(finance, 'inventory.overhead.record', 'OVERHEAD_ENTRY', second, at('15:00:00'), {
          siteId: farmId,
          label: 'Eau',
          lines: [line],
        }),
      ),
    ).toBe('APPLIED');
    await db.transaction().execute(async (trx) => {
      await recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'SITE',
          costObjectId: farmId,
          costType: 'FRAIS_GENERAUX',
          speciesGroup: 'VOLAILLE',
          amountXaf: 500,
          direction: 'CREDIT',
          sourceType: 'ALLOCATION',
          sourceId: freshUuid(),
          occurredAt: new Date(at('16:00:00')),
          createdBy: admin.userId,
        },
      );
    });
    expect(
      code(
        await run(finance, 'inventory.overhead.cancel', 'OVERHEAD_ENTRY', second, at('17:00:00'), {
          entryId: second,
          comment: 'Erreur',
        }),
      ),
    ).toBe('OVERHEAD_ALREADY_ALLOCATED');
  });

  it('clôture d’un lot de stock (seul le statut change)', async () => {
    const lotId = freshUuid();
    await db.transaction().execute(async (trx) => {
      await createStockLot(
        trx,
        { idGenerator },
        {
          lotId,
          originType: 'COLLECTION',
          originId: freshUuid(),
          lotCode: `COL-${lotId.slice(-12)}`,
          productId: null,
          fifoRankAt: new Date(at('06:00:00')),
          expiryDate: '2026-11-07',
          createdBy: admin.userId,
        },
      );
      await setStockLotStatus(trx, lotId, 'CLOSED');
    });
    const lot = await db
      .selectFrom('inventory_stock_lots')
      .select(['status', 'origin_type', 'expiry_date'])
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    expect(lot.status).toBe('CLOSED');
    expect(lot.origin_type).toBe('COLLECTION');
    expect(lot.expiry_date!.getDate()).toBe(7);
  });
});
