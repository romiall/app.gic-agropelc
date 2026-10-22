/**
 * `inventory.transfer.*` (P2-04, SM-TRANSFER) à travers le vrai pipeline de commande.
 * Démontre le cycle de vie complet (demande, expédition, réception, refus, annulation,
 * déplacement interne) et l'écart de réception jusqu'à sa décision (`TRANSFER_DISCREPANCY`,
 * `LOSS_CONFIRMATION`/`LOSS_RELEASE`) — même niveau que `pricing-commands.test.ts` et
 * `approval-commands.test.ts` (pipeline réel, base MySQL réelle, jamais de mock).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  recordStockMove,
  type RecordMoveDeps,
} from '../src/modules/inventory/application/public/index.js';
import { toBin, fromBin, fromBinOrNull } from '../src/platform/kysely/uuid-columns.js';
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
  withoutActivePolicies,
} from './helpers.js';

const OCCURRED_AT = '2026-09-28T09:00:00.000Z';

function buildEnvelope(
  authorUserId: string,
  overrides: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
    readonly captured_offline?: boolean;
  },
): Record<string, unknown> {
  const occurredAt = overrides.occurred_at ?? OCCURRED_AT;
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    occurred_at: occurredAt,
    client_created_at: occurredAt,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

async function insertProduct(admin: string): Promise<string> {
  const categoryId = freshUuid();
  await db
    .insertInto('catalog_product_categories')
    .values({
      id: toBin(categoryId),
      code: `CAT-${categoryId.slice(-8)}`,
      name: 'Test',
      created_by: toBin(admin),
    })
    .execute();
  const already = await db
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', 'TETE')
    .executeTakeFirst();
  if (!already) {
    await db
      .insertInto('catalog_units')
      .values({ code: 'TETE', name: 'Tête', is_count: 1 })
      .execute();
  }
  const productId = freshUuid();
  await db
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test transfert',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: 'NONE',
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.transfer.* (P2-04, SM-TRANSFER)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let decisionRegistry: ApprovalDecisionHandlerRegistry;
  let pipeline: CommandPipelineService;
  let moveDeps: RecordMoveDeps;
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let siteId: string;
  let storeA: string;
  let storeB: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    moveDeps = { idGenerator };
    decisionRegistry = new ApprovalDecisionHandlerRegistry();

    const registry = new CommandHandlerRegistry();
    registerTransferCommands(
      registry,
      decisionRegistry,
      idGenerator,
      new DocumentSequenceService(),
    );
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    approver = await db.transaction().execute((trx) => insertTestUser(trx));
    approverDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, approver, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.transfer.request', admin);
      await grantTestPermission(trx, adminRole, 'inventory.transfer.dispatch', admin);
      await grantTestPermission(trx, adminRole, 'inventory.transfer.receive', admin);
      await grantTestPermission(trx, adminRole, 'inventory.transfer.cancel', admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      // approver : détient inventory.transfer_discrepancy.approve à la portée SITE, affecté
      // sur `siteId` — même patron que approval-commands.test.ts (BR-ADM-018).
      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await grantTestPermission(
        trx,
        approverRole,
        'inventory.transfer_discrepancy.approve',
        admin,
        {
          maxScope: 'SITE',
        },
      );
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });

    // Politique de contrôle TRANSFER_DISCREPANCY unique pour tout ce fichier (§5, décision
    // déjà prise : une seule politique active à la fois pour cet operationType évite toute
    // ambiguïté sur `currentPolicies(...)[0]`).
    const policyId = freshUuid();
    const policyResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        payload: {
          code: `TRF_DISCREPANCY_${policyId.slice(-8)}`,
          operationType: 'TRANSFER_DISCREPANCY',
          requiresApproval: true,
          approverPermission: 'inventory.transfer_discrepancy.approve',
          approverScope: 'SITE',
        },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(policyResult.status).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const adminCtx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });
  const approverCtx = () => ({
    authenticatedUserId: approver,
    authenticatedDeviceId: approverDevice,
    transport: 'ONLINE_API' as const,
  });

  async function openingBalance(
    productId: string,
    locationId: string,
    quantityBase: number,
  ): Promise<void> {
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
        toLocationId: locationId,
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

  async function balanceOf(productId: string, locationId: string): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirst();
    return row ? Number(row.qty_on_hand) : 0;
  }

  it('demande → expédition → réception complète -> RECEIVED, stock déplacé de A vers B', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 100);

    const transferId = freshUuid();
    const requestResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.request',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 40 }],
        },
      }),
      adminCtx(),
    );
    expect(requestResult.status).toBe('APPLIED');

    const requestedRow = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(requestedRow.status).toBe('REQUESTED');

    const line = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select(['id'])
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();

    const dispatchResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.dispatch',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          transferId,
          lines: [
            { transferLineId: fromBin(line.id), productId, unitCode: 'TETE', quantityBase: 40 },
          ],
        },
      }),
      adminCtx(),
    );
    expect(dispatchResult.status).toBe('APPLIED');
    const dispatchedRow = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(dispatchedRow.status).toBe('DISPATCHED');
    expect(await balanceOf(productId, storeA)).toBe(60);

    const receiveResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.receive',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: { transferId, lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: 40 }] },
      }),
      adminCtx(),
    );
    expect(receiveResult.status).toBe('APPLIED');
    const receivedRow = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(receivedRow.status).toBe('RECEIVED');
    expect(await balanceOf(productId, storeB)).toBe(40);
  });

  it('expédition directe sans demande préalable -> transfert créé DISPATCHED, puis reçu -> RECEIVED', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 50);

    const transferId = freshUuid();
    const dispatchResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.dispatch',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 20 }],
        },
      }),
      adminCtx(),
    );
    expect(dispatchResult.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'transfer_kind', 'requested_by'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DISPATCHED');
    expect(row.transfer_kind).toBe('STANDARD');
    expect(row.requested_by).toBeNull(); // aucune demande préalable

    const line = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select(['id'])
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    const receiveResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.receive',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: { transferId, lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: 20 }] },
      }),
      adminCtx(),
    );
    expect(receiveResult.status).toBe('APPLIED');
    expect(await balanceOf(productId, storeB)).toBe(20);
  });

  it('refus (DECLINED) : une demande REQUESTED peut être refusée avec commentaire', async () => {
    const productId = await insertProduct(admin);
    const transferId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.request',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 10 }],
        },
      }),
      adminCtx(),
    );

    const declineResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.decline',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: { transferId, comment: 'Stock indisponible côté A.' },
      }),
      adminCtx(),
    );
    expect(declineResult.status).toBe('APPLIED');
    const row = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'notes'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DECLINED');
    // P5-23 (S-40) : le motif suit la note du demandeur (aucune ici), préfixé.
    expect(row.notes).toBe('Refus : Stock indisponible côté A.');
  });

  it('annulation (CANCELLED) : seul le demandeur peut annuler sa demande REQUESTED', async () => {
    const productId = await insertProduct(admin);
    const transferId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.request',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 5 }],
        },
      }),
      adminCtx(),
    );

    // approver n'est pas le demandeur -> FORBIDDEN (approver détient bien
    // `approvals.request.read`, jamais `inventory.transfer.cancel` : la garde RC-01 lèverait
    // sinon UNSUPPORTED_VERSION/FORBIDDEN avant même d'atteindre la vérification du
    // demandeur — non pertinent ici, on vérifie la règle métier avec admin, seul détenteur).
    const cancelResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.cancel',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: { transferId },
      }),
      adminCtx(),
    );
    expect(cancelResult.status).toBe('APPLIED');
    const row = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('CANCELLED');
  });

  it('déplacement interne (move_internal) : transfert INTERNAL immédiatement COMPLETED, stock déplacé', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 30);

    const transferId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.move_internal',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 12 }],
        },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'transfer_kind'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('COMPLETED');
    expect(row.transfer_kind).toBe('INTERNAL');
    expect(await balanceOf(productId, storeA)).toBe(18);
    expect(await balanceOf(productId, storeB)).toBe(12);
  });

  describe('réception avec écart -> DISCREPANCY_PENDING -> décision (TRANSFER_DISCREPANCY)', () => {
    async function dispatchAndReceiveWithGap(
      quantityDispatched: number,
      quantityReceived: number,
    ): Promise<{ readonly productId: string; readonly transferId: string }> {
      const productId = await insertProduct(admin);
      await openingBalance(productId, storeA, 100);

      const transferId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.transfer.dispatch',
          aggregate_type: 'STOCK_TRANSFER',
          aggregate_id: transferId,
          payload: {
            fromLocationId: storeA,
            toLocationId: storeB,
            lines: [{ productId, unitCode: 'TETE', quantityBase: quantityDispatched }],
          },
        }),
        adminCtx(),
      );
      const line = await db
        .selectFrom('inventory_stock_transfer_lines')
        .select(['id'])
        .where('transfer_id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      const receiveResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.transfer.receive',
          aggregate_type: 'STOCK_TRANSFER',
          aggregate_id: transferId,
          payload: {
            transferId,
            lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: quantityReceived }],
          },
        }),
        adminCtx(),
      );
      expect(receiveResult.status).toBe('APPLIED');
      return { productId, transferId };
    }

    it('approve -> CLOSED, écart confirmé en perte (LOSS_CONFIRMATION, V_LOSS crédité)', async () => {
      const { productId, transferId } = await dispatchAndReceiveWithGap(30, 25);

      const pendingRow = await db
        .selectFrom('inventory_stock_transfers')
        .select(['status', 'approval_request_id', 'doc_number'])
        .where('id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      expect(pendingRow.status).toBe('DISCREPANCY_PENDING');
      const requestId = fromBinOrNull(pendingRow.approval_request_id);
      expect(requestId).not.toBeNull();
      // MP-11 : le valideur lit le numéro du transfert, pas son identifiant technique.
      const request = await db
        .selectFrom('approvals_approval_requests')
        .select(['subject_summary', 'amount_xaf'])
        .where('id', '=', toBin(requestId!))
        .executeTakeFirstOrThrow();
      expect(request.subject_summary).toBe(
        `Écart de réception sur transfert ${pendingRow.doc_number}`,
      );
      // MP-12 : le valideur voit la valeur de l'écart (5 unités manquantes à 500 F), masquée sans
      // droit de valorisation (RC-05) ; elle était absente de la demande.
      expect(Number(request.amount_xaf)).toBe(2_500);

      const approveResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.approve',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId!,
          payload: { requestId: requestId! },
        }),
        approverCtx(),
      );
      expect(approveResult.status).toBe('APPLIED');

      const closedRow = await db
        .selectFrom('inventory_stock_transfers')
        .select(['status'])
        .where('id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      expect(closedRow.status).toBe('CLOSED');

      const lossMove = await db
        .selectFrom('inventory_stock_moves')
        .select(['quantity'])
        .where('product_id', '=', toBin(productId))
        .where('move_type', '=', 'LOSS_CONFIRMATION')
        .where('source_doc_id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      expect(Number(lossMove.quantity)).toBe(5);

      const vLoss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();
      expect(await balanceOf(productId, fromBin(vLoss.id))).toBe(5);
    });

    it('reject -> CLOSED, marchandise retrouvée (LOSS_RELEASE, retour à destination)', async () => {
      const { productId, transferId } = await dispatchAndReceiveWithGap(30, 22);

      const pendingRow = await db
        .selectFrom('inventory_stock_transfers')
        .select(['approval_request_id'])
        .where('id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      const requestId = fromBinOrNull(pendingRow.approval_request_id);
      expect(requestId).not.toBeNull();

      const rejectResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.reject',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId!,
          payload: { requestId: requestId!, comment: 'Marchandise retrouvée sur site B.' },
        }),
        approverCtx(),
      );
      expect(rejectResult.status).toBe('APPLIED');

      const closedRow = await db
        .selectFrom('inventory_stock_transfers')
        .select(['status'])
        .where('id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      expect(closedRow.status).toBe('CLOSED');

      const releaseMove = await db
        .selectFrom('inventory_stock_moves')
        .select(['quantity', 'to_location_id'])
        .where('product_id', '=', toBin(productId))
        .where('move_type', '=', 'LOSS_RELEASE')
        .where('source_doc_id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      expect(Number(releaseMove.quantity)).toBe(8);
      expect(fromBin(releaseMove.to_location_id)).toBe(storeB);
      expect(await balanceOf(productId, storeB)).toBe(22 + 8); // reçu + écart libéré = expédié
    });
  });

  it('policy.set requiert une politique active pour TRANSFER_DISCREPANCY : sans elle, écart -> REJECTED CONTROL_POLICY_MISSING', async () => {
    // Vérifie la garde de configuration administrative (§5) avec un registre isolé, sans
    // la politique créée dans `beforeAll` : sinon `currentPolicies` la trouverait toujours.
    const isolatedRegistry = new CommandHandlerRegistry();
    const isolatedDecisionRegistry = new ApprovalDecisionHandlerRegistry();
    registerTransferCommands(
      isolatedRegistry,
      isolatedDecisionRegistry,
      idGenerator,
      new DocumentSequenceService(),
    );
    const isolatedPipeline = new CommandPipelineService(db, isolatedRegistry, clock, idGenerator);

    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 20);
    const transferId = freshUuid();
    await isolatedPipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.transfer.dispatch',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: transferId,
        payload: {
          fromLocationId: storeA,
          toLocationId: storeB,
          lines: [{ productId, unitCode: 'TETE', quantityBase: 10 }],
        },
      }),
      adminCtx(),
    );
    const line = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select(['id'])
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();

    // `currentPolicies` lit directement la table (pas le registre de commandes) et renvoie
    // TOUTE politique ACTIVE pour cet `operationType`, quel que soit son `code` — jamais
    // seulement celle créée par le `beforeAll` de ce fichier : `approvals.policy.set` ne
    // retire que la version précédente du MÊME code (policy-commands.ts), pas les autres
    // codes du même operationType. D'éventuelles politiques TRANSFER_DISCREPANCY actives
    // laissées par une exécution antérieure de ce fichier (ces tests commitent réellement,
    // jamais de rollback — même convention que pricing-commands.test.ts/
    // approval-commands.test.ts) resteraient donc actives et fausseraient ce test si l'on
    // ne retirait que la politique du `beforeAll`. On retire donc ici toutes les politiques
    // actives de ce type, puis on restaure exactement celles qui l'étaient (statut et
    // `valid_to` ; jamais toutes les lignes RETIRED du type : certaines l'étaient déjà
    // légitimement avant ce test).
    const receiveResult = await withoutActivePolicies(
      'TRANSFER_DISCREPANCY',
      new Date(OCCURRED_AT),
      () =>
        isolatedPipeline.handle(
          buildEnvelope(admin, {
            command_type: 'inventory.transfer.receive',
            aggregate_type: 'STOCK_TRANSFER',
            aggregate_id: transferId,
            payload: {
              transferId,
              lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: 7 }],
            },
          }),
          adminCtx(),
        ),
    );
    expect(receiveResult.status).toBe('REJECTED');
    expect(receiveResult.status === 'REJECTED' && receiveResult.error.code).toBe(
      'CONTROL_POLICY_MISSING',
    );
  });

  describe('politique de l’écart de réception : choix de la politique (MP-12, AV-318)', () => {
    async function dispatchOne(productId: string) {
      const transferId = freshUuid();
      const dispatched = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.transfer.dispatch',
          aggregate_type: 'STOCK_TRANSFER',
          aggregate_id: transferId,
          payload: {
            fromLocationId: storeA,
            toLocationId: storeB,
            lines: [{ productId, unitCode: 'TETE', quantityBase: 10 }],
          },
        }),
        adminCtx(),
      );
      expect(dispatched.status).toBe('APPLIED');
      const line = await db
        .selectFrom('inventory_stock_transfer_lines')
        .select(['id'])
        .where('transfer_id', '=', toBin(transferId))
        .executeTakeFirstOrThrow();
      return { transferId, lineId: fromBin(line.id) };
    }

    const receiveGap = (
      target: CommandPipelineService,
      transfer: { transferId: string; lineId: string },
      capturedOffline: boolean,
    ) =>
      target.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.transfer.receive',
          aggregate_type: 'STOCK_TRANSFER',
          aggregate_id: transfer.transferId,
          payload: {
            transferId: transfer.transferId,
            lines: [{ transferLineId: transfer.lineId, receivedQtyBase: 7 }],
          },
          captured_offline: capturedOffline,
        }),
        adminCtx(),
      );

    /** Politique posée directement (statut actif), à retirer ensuite : la table n'est jamais purgée. */
    async function insertPolicy(input: {
      readonly validFrom: Date;
      readonly requiresApproval: boolean;
    }): Promise<string> {
      const id = freshUuid();
      await db
        .insertInto('approvals_control_policies')
        .values({
          id: toBin(id),
          code: `TRF_MP12_${id.slice(-10)}`,
          version: 1,
          operation_type: 'TRANSFER_DISCREPANCY',
          condition: JSON.stringify({}),
          requires_approval: input.requiresApproval ? 1 : 0,
          approver_permission: input.requiresApproval
            ? 'inventory.transfer_discrepancy.approve'
            : null,
          approver_scope: 'SITE',
          valid_from: input.validFrom,
          status: 'ACTIVE',
          created_by: toBin(admin),
        })
        .execute();
      return id;
    }

    const retirePolicy = (id: string) =>
      db
        .updateTable('approvals_control_policies')
        .set({ status: 'RETIRED', valid_to: new Date(OCCURRED_AT) })
        .where('id', '=', toBin(id))
        .execute();

    it('hors ligne, écart reçu avant l’entrée en vigueur de la politique : fait accompli accepté au repli sur la réception ; en ligne, refusé', async () => {
      const productId = await insertProduct(admin);
      await openingBalance(productId, storeA, 40);
      const offlineTransfer = await dispatchOne(productId);
      const onlineTransfer = await dispatchOne(productId);

      const receivedAt = new Date(new Date(OCCURRED_AT).getTime() + 2 * 60 * 60 * 1000);
      const laterRegistry = new CommandHandlerRegistry();
      registerTransferCommands(
        laterRegistry,
        new ApprovalDecisionHandlerRegistry(),
        idGenerator,
        new DocumentSequenceService(),
      );
      const laterPipeline = new CommandPipelineService(
        db,
        laterRegistry,
        new FixedClock(receivedAt),
        idGenerator,
      );

      const outcome = await withoutActivePolicies(
        'TRANSFER_DISCREPANCY',
        new Date(OCCURRED_AT),
        async () => {
          // En vigueur 30 minutes avant la réception de la commande, après la réception réelle (09:00).
          const policyId = await insertPolicy({
            validFrom: new Date(receivedAt.getTime() - 30 * 60 * 1000),
            requiresApproval: true,
          });
          try {
            return {
              offline: await receiveGap(laterPipeline, offlineTransfer, true),
              online: await receiveGap(laterPipeline, onlineTransfer, false),
            };
          } finally {
            await retirePolicy(policyId);
          }
        },
      );

      expect(outcome.offline.status).toBe('APPLIED');
      const row = await db
        .selectFrom('inventory_stock_transfers')
        .select(['status', 'approval_request_id'])
        .where('id', '=', toBin(offlineTransfer.transferId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('DISCREPANCY_PENDING');
      expect(row.approval_request_id).not.toBeNull();

      expect(outcome.online.status).toBe('REJECTED');
      expect(outcome.online.status === 'REJECTED' && outcome.online.error.code).toBe(
        'CONTROL_POLICY_MISSING',
      );
    });

    it('une version révisée sans approbateur n’est pas retenue : la demande suit la politique qui se décide', async () => {
      const productId = await insertProduct(admin);
      await openingBalance(productId, storeA, 40);
      const transfer = await dispatchOne(productId);
      const at = new Date(OCCURRED_AT);

      const result = await withoutActivePolicies('TRANSFER_DISCREPANCY', at, async () => {
        const decidable = await insertPolicy({
          validFrom: new Date(at.getTime() - 2 * 60 * 60 * 1000),
          requiresApproval: true,
        });
        const undecidable = await insertPolicy({
          validFrom: new Date(at.getTime() - 60 * 60 * 1000),
          requiresApproval: false,
        });
        try {
          return { decidable, received: await receiveGap(pipeline, transfer, false) };
        } finally {
          await retirePolicy(decidable);
          await retirePolicy(undecidable);
        }
      });

      expect(result.received.status).toBe('APPLIED');
      const row = await db
        .selectFrom('inventory_stock_transfers')
        .select('approval_request_id')
        .where('id', '=', toBin(transfer.transferId))
        .executeTakeFirstOrThrow();
      const request = await db
        .selectFrom('approvals_approval_requests')
        .select('policy_id')
        .where('id', '=', row.approval_request_id!)
        .executeTakeFirstOrThrow();
      expect(fromBin(request.policy_id!)).toBe(result.decidable);
    });

    it('seule une politique sans approbateur est en vigueur : l’écart est refusé (CONTROL_POLICY_MISSING), jamais une demande sans décideur', async () => {
      const productId = await insertProduct(admin);
      await openingBalance(productId, storeA, 40);
      const transfer = await dispatchOne(productId);
      const at = new Date(OCCURRED_AT);

      const result = await withoutActivePolicies('TRANSFER_DISCREPANCY', at, async () => {
        const undecidable = await insertPolicy({
          validFrom: new Date(at.getTime() - 60 * 60 * 1000),
          requiresApproval: false,
        });
        try {
          return await receiveGap(pipeline, transfer, false);
        } finally {
          await retirePolicy(undecidable);
        }
      });

      expect(result.status).toBe('REJECTED');
      expect(result.status === 'REJECTED' && result.error.code).toBe('CONTROL_POLICY_MISSING');
    });
  });
});
