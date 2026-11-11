/**
 * Fiche de suivi de lot reportée (PP-B, FL ; REQ-303, AV-531) : chaque mesure d'une ligne de la fiche (mortalité, aliment,
 * pesée, observation) est une saisie du jour du lot que le serveur accepte, sous son propre agrégat et avec l'heure de son
 * jour. L'essai rejoue la **vraie** correspondance de la PWA (`report-commands.ts`, logique pure importée telle quelle)
 * dans le vrai pipeline (UC-PRD-03 à 06) :
 * - mortalité : déclaration `MORTALITE` du lot en attente de validation, commentaire portant le numéro de la pièce, effectif
 *   diminué, coût du lot inchangé (BR-PRD-013) ;
 * - aliment : consommation imputée au lot (nature `ALIMENT`), au coût du magasin ;
 * - pesée et observation : une ligne chacune, la mention de la pièce dans le texte de l'observation ;
 * - les cinq écritures ont des identifiants distincts (le premier est celui de la pièce) ;
 * - une ligne de plus de 72 h est refusée à qui n'a pas le droit de dépasser la fenêtre (AV-528) : une fiche hebdomadaire se
 *   reporte jour après jour, ou par un titulaire du droit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  costObjectBalance,
  ensureSupplierLot,
  lotHeadcount,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  buildReportCommands,
  type ReportCommand,
  type ResolvedSlip,
} from '../../pwa/src/features/pieces/report-commands.js';
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

const START_DAY = '2026-10-18';
const DAY = '2026-10-21';
const YESTERDAY = '2026-10-20';
const at = (day: string, hhmmss: string) => `${day}T${hhmmss}.000Z`;
const NOW = at(DAY, '20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('FL : fiche de suivi de lot reportée, saisies du jour dans le vrai pipeline', () => {
  let pipeline: CommandPipelineService;
  let farmManager: Actor;
  let productionManager: Actor;
  /** Saisit le jour sans le droit `sync.backdate.exceed` (accordé aux responsables de ferme et de production depuis Q23 B). */
  let plainRecorder: Actor;
  let buildingId: string;
  let farmStoreId: string;
  let feedId: string;
  let lossReasonId: string;
  let lotId: string;
  let stockLotId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  /**
   * Une commande « saisie hors ligne » : horodatée par l'appareil à `NOW`, comme l'outbox de la PWA. La mise en place du
   * lot, elle, est une saisie en ligne datée de l'instant même.
   */
  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    backdatedReason: string | null = null,
    setup = false,
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
        client_created_at: setup ? occurredAt : NOW,
        captured_offline: !setup,
        backdated_reason: backdatedReason,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: setup ? 'ONLINE_API' : 'SYNC_PUSH',
      },
    );
  }

  /** Rejoue les commandes de la PWA pour une pièce, dans l'ordre de la file de l'appareil. */
  async function replay(
    slip: ResolvedSlip,
    options: { readonly actor?: Actor; readonly reason?: string | null } = {},
  ): Promise<{ commands: readonly ReportCommand[]; results: readonly Result[] }> {
    const commands = buildReportCommands(slip, {
      paperRef: 'FL-000012',
      occurredAt: at(YESTERDAY, '11:00:00'),
      backdatedReason: options.reason ?? null,
      aggregateId: freshUuid(),
    });
    const results: Result[] = [];
    for (const command of commands) {
      results.push(
        await run(
          options.actor ?? farmManager,
          command.commandType,
          command.aggregateType,
          command.aggregateId,
          command.occurredAt,
          command.payload,
          command.backdatedReason,
        ),
      );
    }
    return { commands, results };
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
    const idGenerator: IdGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    let admin!: Actor;
    let chickId = '';
    let broilerId = '';
    let chickLotId = '';
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      const farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      farmStoreId = await insertTestLocation(trx, adminId, farmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      productionManager = await actor(roles.rpr);
      // Un rôle d'essai réduit à la saisie du jour : la fenêtre d'antidatage de 72 h s'y applique.
      const plainRole = await insertTestRole(trx, adminId, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, plainRole, 'production.daily.record', adminId);
      plainRecorder = await actor(plainRole, { scopeType: 'SITE', scopeSiteId: farmId });

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['KG', 'Kilogramme', 0],
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
      feedId = freshUuid();
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
          {
            ...base,
            id: toBin(feedId),
            code: `PRD-${feedId.slice(-8)}`,
            name: 'Aliment croissance',
            stock_family: 'INTRANT',
            base_unit_code: 'KG',
            lot_tracking: 'NONE',
            is_consumable: 1,
          },
        ])
        .execute();
      lossReasonId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(lossReasonId),
          code: `MAL-${lossReasonId.slice(-8)}`,
          category: 'LOSS',
          label: 'Maladie respiratoire',
          created_by: toBin(adminId),
        })
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
      chickLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: chickId,
          supplierId,
          supplierLotRef: `PC-${supplierId.slice(-6)}`,
          fallbackCode: `F:PC-${supplierId.slice(-6)}`,
          expiryDate: null,
          originId: freshUuid(),
          fifoRankAt: new Date(at(START_DAY, '05:00:00')),
          createdBy: adminId,
        },
      );
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lot, quantity, cost] of [
        [chickId, chickLotId, 1000, 500],
        [feedId, undefined, 1000, 300],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lot !== undefined ? { lotId: lot } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: farmStoreId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: cost,
            occurredAt: new Date(at(START_DAY, '05:00:00')),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: adminId,
            allowNegative: false,
          },
        );
      }
    });

    // Politique de validation de la mortalité (comme en production), valable pendant toute la période de l'essai.
    const policyId = freshUuid();
    const policy = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        author_user_id: admin.userId,
        base_version: null,
        depends_on: [],
        occurred_at: at(START_DAY, '00:00:00'),
        client_created_at: at(START_DAY, '00:00:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          code: `MORTALITY_${policyId.slice(-8)}`,
          operationType: 'MORTALITY',
          validFrom: at(START_DAY, '00:00:00'),
          validTo: at('2026-12-31', '23:59:59'),
          requiresApproval: true,
          requiresPhoto: true,
          approverPermission: 'production.mortality.approve',
          approverScope: 'ALL',
          condition: { relativePct: 0, absoluteHeads: 0 },
        },
      },
      {
        authenticatedUserId: admin.userId,
        authenticatedDeviceId: admin.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');

    // Lot de 100 poulets de chair mis en place le 18/10.
    lotId = freshUuid();
    const created = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      lotId,
      at(START_DAY, '06:00:00'),
      { lotType: 'POULET_CHAIR', productId: broilerId, mainLocationId: buildingId },
      null,
      true,
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      at(START_DAY, '06:00:00'),
      {
        productionLotId: lotId,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: chickId,
        sourceLocationId: farmStoreId,
        sourceStockLotId: chickLotId,
        quantity: 100,
      },
      null,
      true,
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    const lot = await db
      .selectFrom('production_production_lots')
      .select('stock_lot_id')
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    stockLotId = fromBin(lot.stock_lot_id);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const sheet = (): ResolvedSlip => ({
    type: 'FL',
    lotId,
    locationId: buildingId,
    feedLocationId: farmStoreId,
    days: [
      {
        date: YESTERDAY,
        occurredAt: at(YESTERDAY, '11:00:00'),
        mortality: { quantity: 3, reasonCodeId: lossReasonId },
        input: { productId: feedId, unitCode: 'KG', quantity: 45, quantityBase: 45 },
        weighing: { sampleSize: 20, avgWeightG: 1250 },
        observation: 'Vaccin Newcastle',
      },
      {
        date: DAY,
        occurredAt: at(DAY, '11:00:00'),
        input: { productId: feedId, unitCode: 'KG', quantity: 46, quantityBase: 46 },
      },
    ],
  });

  it('mortalité, aliment, pesée et observation de deux jours : cinq écritures acceptées, chacune sous son agrégat', async () => {
    const before = await costObjectBalance(db, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lotId,
    });
    const { commands, results } = await replay(sheet(), { reason: 'Fiche remplie sur place' });
    expect(commands).toHaveLength(5);
    results.forEach((result, index) => {
      expect(
        ['APPLIED', 'APPLIED_WITH_WARNINGS'],
        `${commands[index]!.commandType} : ${JSON.stringify(result)}`,
      ).toContain(result.status);
    });
    expect(new Set(commands.map((command) => command.aggregateId)).size).toBe(5);

    // Mortalité : déclaration du lot en attente de validation, numéro de la pièce dans le commentaire.
    const loss = await db
      .selectFrom('inventory_loss_declarations')
      .selectAll()
      .where('id', '=', toBin(commands[0]!.aggregateId))
      .executeTakeFirstOrThrow();
    expect(loss).toMatchObject({ category: 'MORTALITE', status: 'PENDING_APPROVAL' });
    expect(fromBin(loss.production_lot_id!)).toBe(lotId);
    expect(fromBin(loss.location_id)).toBe(buildingId);
    expect(JSON.stringify(loss)).toContain('Pièce papier FL-000012');
    expect(await lotHeadcount(db, { lotId: stockLotId, scope: 'REARING' })).toBe(97);

    // Aliment : deux consommations du lot (45 kg puis 46 kg à 300 XAF), nature ALIMENT ; le coût du lot augmente de leur valeur.
    const consumptions = await db
      .selectFrom('inventory_consumptions')
      .select(['cost_type', 'cost_object_type'])
      .where('cost_object_id', '=', toBin(lotId))
      .execute();
    expect(consumptions).toEqual([
      { cost_type: 'ALIMENT', cost_object_type: 'PRODUCTION_LOT' },
      { cost_type: 'ALIMENT', cost_object_type: 'PRODUCTION_LOT' },
    ]);
    const after = await costObjectBalance(db, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lotId,
    });
    expect(after.netXaf).toBe(before.netXaf + (45 + 46) * 300);

    // Pesée et observation.
    const weighing = await db
      .selectFrom('production_lot_weighings')
      .select(['sample_size', 'avg_weight_g', 'source', 'status'])
      .where('id', '=', toBin(commands[2]!.aggregateId))
      .executeTakeFirstOrThrow();
    expect(weighing).toEqual({
      sample_size: 20,
      avg_weight_g: '1250.0',
      source: 'MANUAL',
      status: 'RECORDED',
    });
    const observation = await db
      .selectFrom('production_lot_observations')
      .select(['observation_type', 'text', 'severity'])
      .where('id', '=', toBin(commands[3]!.aggregateId))
      .executeTakeFirstOrThrow();
    expect(observation).toEqual({
      observation_type: 'AUTRE',
      text: 'Pièce papier FL-000012 — Vaccin Newcastle',
      severity: 'INFO',
    });
  });

  it('une ligne de plus de 72 h est refusée à qui n’a pas le droit de dépasser la fenêtre (une ligne plus récente passe)', async () => {
    const old = at('2026-10-17', '11:00:00');
    const stale: ResolvedSlip = {
      type: 'FL',
      lotId,
      locationId: buildingId,
      days: [
        { date: '2026-10-17', occurredAt: old, weighing: { sampleSize: 10, avgWeightG: 900 } },
        {
          date: DAY,
          occurredAt: at(DAY, '12:00:00'),
          weighing: { sampleSize: 10, avgWeightG: 950 },
        },
      ],
    };
    // Le responsable de ferme (Q23 B) peut dépasser la fenêtre : le refus se joue avec un acteur qui n'a pas ce droit.
    const { results } = await replay(stale, {
      actor: plainRecorder,
      reason: 'Fiche de la semaine passée',
    });
    expect(code(results[0]!)).toBe('BACKDATE_EXCEEDED');
    expect(results[1]!.status, JSON.stringify(results[1])).toBe('APPLIED');
  });

  it('au-delà de 24 h, une ligne sans motif est refusée : le motif de la pièce est joint à chaque commande', async () => {
    const { results } = await replay(sheet(), { reason: null });
    // La ligne d'hier (33 h avant l'envoi) exige un motif ; celle d'aujourd'hui non.
    expect(code(results[0]!)).toBe('JUSTIFICATION_REQUIRED');
    expect(code(results[4]!)).not.toBe('JUSTIFICATION_REQUIRED');
  });
});
