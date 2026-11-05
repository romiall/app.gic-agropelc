/**
 * `inventory.opening.post` (BR-STK-046, AV-517) à travers le vrai pipeline de commande : le stock d'ouverture d'un
 * emplacement est posé en un seul document (théorique nul, coût unitaire déclaré par ligne), toujours soumis à
 * validation ; l'approbation comptabilise un `OPENING_BALANCE` par ligne depuis `V_OPENING`, le rejet n'écrit aucun
 * mouvement. Un seul stock d'ouverture par emplacement tant qu'il n'est pas rejeté.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
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
} from './helpers.js';

const OCCURRED_AT = '2026-10-02T09:00:00.000Z';

function buildEnvelope(
  authorUserId: string,
  overrides: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
  },
): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    occurred_at: OCCURRED_AT,
    client_created_at: OCCURRED_AT,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

async function insertProduct(
  admin: string,
  options: {
    readonly stockFamily?: string;
    readonly lotTracking?: string;
    readonly species?: string;
    readonly status?: string;
  } = {},
): Promise<string> {
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
      name: 'Produit de test ouverture',
      category_id: toBin(categoryId),
      stock_family: options.stockFamily ?? 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: options.lotTracking ?? 'NONE',
      ...(options.species !== undefined ? { species: options.species } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.opening.post (BR-STK-046, AV-517)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let siteId: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    registerCountCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
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

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.opening.post', admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await grantTestPermission(trx, approverRole, 'inventory.count.approve', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });

    // Une politique INVENTORY_ADJUSTMENT active : le stock d'ouverture est toujours soumis à validation.
    const policyId = freshUuid();
    const policy = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        payload: {
          code: `INV_ADJ_${policyId.slice(-8)}`,
          operationType: 'INVENTORY_ADJUSTMENT',
          requiresApproval: true,
          approverPermission: 'inventory.count.approve',
          approverScope: 'SITE',
        },
      }),
      adminCtx(),
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
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

  const newStore = (): Promise<string> =>
    db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, siteId, { locationType: 'STORE' }));

  const post = (
    locationId: string,
    lines: readonly { productId: string; quantityBase: number; unitCostXaf: number }[],
    countId: string = freshUuid(),
  ) =>
    pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.opening.post',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { locationId, lines },
      }),
      adminCtx(),
    );

  const countRow = (countId: string) =>
    db
      .selectFrom('inventory_inventory_counts')
      .select([
        'status',
        'count_type',
        'approval_request_id',
        'doc_number',
        'variance_value_xaf',
        'posted_at',
      ])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();

  const balanceOf = async (productId: string, locationId: string): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirst();
    return row ? Number(row.qty_on_hand) : 0;
  };

  const decide = async (countId: string, decision: 'approve' | 'reject') => {
    const requestId = fromBinOrNull((await countRow(countId)).approval_request_id)!;
    return pipeline.handle(
      buildEnvelope(approver, {
        command_type: `approvals.request.${decision}`,
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        payload: decision === 'approve' ? { requestId } : { requestId, comment: 'À recompter.' },
      }),
      approverCtx(),
    );
  };

  it('pose le document en attente de validation, puis l’approbation comptabilise un OPENING_BALANCE par ligne', async () => {
    const locationId = await newStore();
    const eggs = await insertProduct(admin);
    const feed = await insertProduct(admin);
    const countId = freshUuid();
    const result = await post(
      locationId,
      [
        { productId: eggs, quantityBase: 100, unitCostXaf: 1000 },
        { productId: feed, quantityBase: 20.5, unitCostXaf: 2500 },
      ],
      countId,
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    const pending = await countRow(countId);
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', count_type: 'OPENING' });
    expect(Number(pending.variance_value_xaf)).toBe(151_250); // 100 × 1 000 + 20,5 × 2 500
    expect(pending.approval_request_id).not.toBeNull();
    // Aucun mouvement avant la décision.
    expect(await balanceOf(eggs, locationId)).toBe(0);
    const lines = await db
      .selectFrom('inventory_inventory_count_lines')
      .select([
        'product_id',
        'counted_qty_base',
        'theoretical_qty_base',
        'variance_qty_base',
        'unit_cost_xaf',
      ])
      .where('count_id', '=', toBin(countId))
      .execute();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Number(line.theoretical_qty_base)).toBe(0);
      expect(Number(line.variance_qty_base)).toBe(Number(line.counted_qty_base));
    }
    // RC-05 : le résumé servi au demandeur ne porte aucune valeur ; le montant reste dans `amount_xaf`.
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select(['subject_summary', 'amount_xaf', 'operation_type'])
      .where('id', '=', pending.approval_request_id!)
      .executeTakeFirstOrThrow();
    expect(request.subject_summary).toBe(`Stock d’ouverture ${pending.doc_number}`);
    expect(Number(request.amount_xaf)).toBe(151_250);
    expect(request.operation_type).toBe('INVENTORY_ADJUSTMENT');

    const approved = await decide(countId, 'approve');
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const posted = await countRow(countId);
    expect(posted.status).toBe('POSTED');
    expect(posted.posted_at).not.toBeNull();
    expect(await balanceOf(eggs, locationId)).toBe(100);
    expect(await balanceOf(feed, locationId)).toBe(20.5);

    const moves = await db
      .selectFrom('inventory_stock_moves as m')
      .innerJoin('organization_locations as f', 'f.id', 'm.from_location_id')
      .select(['m.move_type', 'm.quantity', 'm.unit_cost_xaf', 'f.location_type as from_type'])
      .where('m.source_doc_id', '=', toBin(countId))
      .orderBy('m.quantity', 'desc')
      .execute();
    expect(
      moves.map((move) => [
        move.move_type,
        move.from_type,
        Number(move.quantity),
        Number(move.unit_cost_xaf),
      ]),
    ).toEqual([
      ['OPENING_BALANCE', 'V_OPENING', 100, 1000],
      ['OPENING_BALANCE', 'V_OPENING', 20.5, 2500],
    ]);
    // Le coût déclaré devient le coût moyen pondéré du produit.
    const valuation = await db
      .selectFrom('inventory_product_valuations')
      .select('avg_unit_cost_xaf')
      .where('product_id', '=', toBin(eggs))
      .executeTakeFirstOrThrow();
    expect(Number(valuation.avg_unit_cost_xaf)).toBe(1000);
  });

  it('un seul stock d’ouverture par emplacement : en attente ou comptabilisé, un second est refusé', async () => {
    const locationId = await newStore();
    const product = await insertProduct(admin);
    const first = freshUuid();
    expect(
      (await post(locationId, [{ productId: product, quantityBase: 5, unitCostXaf: 10 }], first))
        .status,
    ).toBe('APPLIED');
    expect(
      await post(locationId, [{ productId: product, quantityBase: 6, unitCostXaf: 10 }]),
    ).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_ALREADY_EXISTS' },
    });
    expect((await decide(first, 'approve')).status).toBe('APPLIED');
    expect(
      await post(locationId, [{ productId: product, quantityBase: 6, unitCostXaf: 10 }]),
    ).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_ALREADY_EXISTS' },
    });
    expect(await balanceOf(product, locationId)).toBe(5); // le second n'a rien écrit.
  });

  it('un rejet n’écrit aucun mouvement et libère l’emplacement pour un nouveau stock d’ouverture', async () => {
    const locationId = await newStore();
    const product = await insertProduct(admin);
    const first = freshUuid();
    expect(
      (await post(locationId, [{ productId: product, quantityBase: 5, unitCostXaf: 10 }], first))
        .status,
    ).toBe('APPLIED');
    const rejected = await decide(first, 'reject');
    expect(rejected.status, JSON.stringify(rejected)).toBe('APPLIED');
    expect((await countRow(first)).status).toBe('REJECTED');
    expect(await balanceOf(product, locationId)).toBe(0);

    const second = freshUuid();
    expect(
      (await post(locationId, [{ productId: product, quantityBase: 8, unitCostXaf: 12 }], second))
        .status,
    ).toBe('APPLIED');
    expect((await decide(second, 'approve')).status).toBe('APPLIED');
    expect(await balanceOf(product, locationId)).toBe(8);
  });

  it('refus : emplacement virtuel ou inconnu, produit en double, inactif, animal ou suivi par lot obligatoire', async () => {
    const locationId = await newStore();
    const product = await insertProduct(admin);
    const line = { productId: product, quantityBase: 1, unitCostXaf: 1 };
    const virtual = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    expect(await post(fromBin(virtual.id), [line])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_LOCATION_INVALID' },
    });
    expect(await post(freshUuid(), [line])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'NOT_FOUND' },
    });
    expect(await post(locationId, [line, line])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_DUPLICATE_PRODUCT' },
    });
    const inactive = await insertProduct(admin, { status: 'INACTIVE' });
    expect(await post(locationId, [{ ...line, productId: inactive }])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'PRODUCT_INACTIVE' },
    });
    const lotted = await insertProduct(admin, { lotTracking: 'REQUIRED' });
    expect(await post(locationId, [{ ...line, productId: lotted }])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_PRODUCT_NOT_ALLOWED' },
    });
    const animal = await insertProduct(admin, {
      stockFamily: 'BIOLOGIQUE',
      lotTracking: 'REQUIRED',
      species: 'PORC',
    });
    expect(await post(locationId, [{ ...line, productId: animal }])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OPENING_PRODUCT_NOT_ALLOWED' },
    });
    expect(await post(locationId, [{ ...line, productId: freshUuid() }])).toMatchObject({
      status: 'REJECTED',
      error: { code: 'NOT_FOUND' },
    });
    // Rien n'a été posé sur cet emplacement après tous ces refus.
    const count = await db
      .selectFrom('inventory_inventory_counts')
      .select('id')
      .where('location_id', '=', toBin(locationId))
      .execute();
    expect(count).toHaveLength(0);
  });

  it('validation de la charge : quantité positive, coût entier, au moins une ligne', async () => {
    const locationId = await newStore();
    const product = await insertProduct(admin);
    const invalid = async (lines: unknown) =>
      pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.opening.post',
          aggregate_type: 'INVENTORY_COUNT',
          aggregate_id: freshUuid(),
          payload: { locationId, lines },
        }),
        adminCtx(),
      );
    expect((await invalid([])).status).toBe('REJECTED');
    expect((await invalid([{ productId: product, quantityBase: 0, unitCostXaf: 1 }])).status).toBe(
      'REJECTED',
    );
    expect(
      (await invalid([{ productId: product, quantityBase: 1, unitCostXaf: 1.5 }])).status,
    ).toBe('REJECTED');
    expect((await invalid([{ productId: product, quantityBase: 1, unitCostXaf: -1 }])).status).toBe(
      'REJECTED',
    );
  });

  it('rejeu du même identifiant : appliqué sans second document', async () => {
    const locationId = await newStore();
    const product = await insertProduct(admin);
    const countId = freshUuid();
    const lines = [{ productId: product, quantityBase: 3, unitCostXaf: 7 }];
    expect((await post(locationId, lines, countId)).status).toBe('APPLIED');
    expect((await post(locationId, lines, countId)).status).toBe('APPLIED');
    const rows = await db
      .selectFrom('inventory_inventory_counts')
      .select('id')
      .where('location_id', '=', toBin(locationId))
      .execute();
    expect(rows).toHaveLength(1);
  });
});
