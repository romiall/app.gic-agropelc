/**
 * `production.lot_opening.post` (ADR-069, BR-PRD-016 ; AV-541 à AV-544) à travers le vrai pipeline de commande : la
 * reprise d'un lot en cours est une déclaration (effectif repris, mise en place réelle, valeur totale) toujours soumise
 * à validation ; **rien n'existe avant la décision** — l'approbation fait naître le lot actif, son lot de stock, l'entrée
 * `OPENING`, le mouvement `OPENING_BALANCE` depuis `V_OPENING` à la valeur déclarée et l'écriture de coût `ANIMAUX` ;
 * le refus n'écrit ni stock ni coût.
 *
 * Rôles réels du semis (`RESP_FERME`, `RESP_PRODUCTION`, `DIRECTION`, `ADMIN`) : l'essai vérifie aussi les octrois du droit
 * `production.lot_opening.post` et la politique `LOT_OPENING_DEFAULT` posés par `pnpm run db:seed`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, businessDayStartUtc, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerLotOpeningCommands } from '../src/modules/production/application/commands/lot-opening-commands.js';
import {
  biologicalLotRemainingCostXaf,
  costObjectBalance,
  lotHeadcount,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  withoutActivePolicies,
} from './helpers.js';

const DAY = '2026-11-09';
const NOW = `${DAY}T09:00:00.000Z`;
/** Mise en place réelle des lots repris (35 jours avant la reprise). */
const PLACED_ON = '2026-10-05';
/** Mise en place du lot de l'essai central (une date par essai : deux reprises du même lot réel seraient un doublon). */
const CORE_PLACED_ON = '2026-10-03';
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('production.lot_opening.post (ADR-069, BR-PRD-016)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let director: Actor;
  let stranger: Actor;
  let farmId: string;
  let buildingId: string;
  let secondBuildingId: string;
  let storeId: string;
  let supplierId: string;
  let broilerId: string;
  let layerId: string;
  let inactiveBroilerId: string;
  let stockOnlyProductId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  // Le code de rejet d'une charge utile invalide est `VALIDATION_ERROR:<détail>` : seul le préfixe compte ici.
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code.split(':')[0]! : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly occurredAt?: string } = {},
  ): Promise<Result> {
    const occurredAt = options.occurredAt ?? NOW;
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

  /** Charge utile minimale d'une reprise de poulets de chair ; chaque essai peut surcharger un champ. */
  const payloadOf = (overrides: Record<string, unknown> = {}) => ({
    lotType: 'POULET_CHAIR',
    productId: broilerId,
    mainLocationId: buildingId,
    placedOn: PLACED_ON,
    quantity: 4800,
    valueXaf: 5_760_000,
    ...overrides,
  });

  const post = (
    actor: Actor,
    payload: Record<string, unknown> = payloadOf(),
    openingId: string = freshUuid(),
    options: { readonly offline?: boolean } = {},
  ) =>
    run(
      actor,
      'production.lot_opening.post',
      'PRODUCTION_LOT_OPENING',
      openingId,
      payload,
      options,
    ).then((result) => ({ result, openingId }));

  const openingRow = (openingId: string) =>
    db
      .selectFrom('production_lot_openings')
      .selectAll()
      .where('id', '=', toBin(openingId))
      .executeTakeFirstOrThrow();

  const lotRow = (lotId: string) =>
    db
      .selectFrom('production_production_lots')
      .selectAll()
      .where('id', '=', toBin(lotId))
      .executeTakeFirst();

  const decide = async (approver: Actor, openingId: string, decision: 'approve' | 'reject') => {
    const requestId = fromBinOrNull((await openingRow(openingId)).approval_request_id)!;
    return run(
      approver,
      `approvals.request.${decision}`,
      'APPROVAL_REQUEST',
      requestId,
      decision === 'approve' ? { requestId } : { requestId, comment: 'Effectif non confirmé.' },
    );
  };

  const heads = async (stockLotId: string, scope: 'REARING' | 'UNSOLD' = 'UNSOLD') =>
    lotHeadcount(db, { lotId: stockLotId, scope });

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
    registerLotCommands(registry, idGenerator, sequences);
    registerLotOpeningCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      dir: await roleId('DIRECTION'),
      adm: await roleId('ADMIN'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = {
        userId: adminId,
        deviceId: await insertTestDevice(trx, adminId, { status: 'ACTIVE' }),
      };
      await assignTestRole(trx, adminId, roles.adm, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const shopId = await insertTestSite(trx, adminId, zoneId);
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      secondBuildingId = await insertTestLocation(trx, adminId, farmId, {
        locationType: 'BUILDING',
      });
      storeId = await insertTestLocation(trx, adminId, shopId, { locationType: 'STORE' });
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);
      director = await actor(roles.dir);
      const strangerId = await insertTestUser(trx);
      stranger = {
        userId: strangerId,
        deviceId: await insertTestDevice(trx, strangerId, { status: 'ACTIVE' }),
      };

      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', 'TETE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
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
      const product = async (
        name: string,
        options: { species?: string; status?: string; family?: string; lot?: string },
      ) => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: options.family ?? 'BIOLOGIQUE',
            ...(options.species !== undefined ? { species: options.species } : {}),
            base_unit_code: 'TETE',
            lot_tracking: options.lot ?? 'REQUIRED',
            ...(options.status !== undefined ? { status: options.status } : {}),
            created_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      broilerId = await product('Poulet de chair vif (reprise)', { species: 'POULET_CHAIR' });
      layerId = await product('Poule pondeuse (reprise)', { species: 'PONDEUSE' });
      inactiveBroilerId = await product('Poulet retiré du catalogue', {
        species: 'POULET_CHAIR',
        status: 'INACTIVE',
      });
      stockOnlyProductId = await product('Aliment (non animal)', {
        family: 'INTRANT',
        lot: 'NONE',
      });
      supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir de reprise',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('pose la déclaration en attente de validation : ni lot, ni stock, ni coût avant la décision', async () => {
    const { result, openingId } = await post(farmManager);
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    const pending = await openingRow(openingId);
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', lot_type: 'POULET_CHAIR' });
    expect(Number(pending.quantity_base)).toBe(4800);
    expect(Number(pending.value_xaf)).toBe(5_760_000);
    expect(pending.approval_request_id).not.toBeNull();
    // Rien n'existe avant la décision.
    expect(await lotRow(openingId)).toBeUndefined();
    const stockLots = await db
      .selectFrom('inventory_stock_lots')
      .select('id')
      .where('origin_id', '=', toBin(openingId))
      .execute();
    expect(stockLots).toHaveLength(0);
    const costs = await costObjectBalance(db, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: openingId,
    });
    expect(costs.netXaf).toBe(0);

    // RC-05 : le résumé servi au demandeur ne porte aucune valeur ; le montant reste dans `amount_xaf`.
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select([
        'subject_summary',
        'amount_xaf',
        'operation_type',
        'subject_type',
        'site_id',
        'status',
      ])
      .where('id', '=', pending.approval_request_id!)
      .executeTakeFirstOrThrow();
    expect(request.operation_type).toBe('LOT_OPENING');
    expect(request.subject_type).toBe('PRODUCTION_LOT_OPENING');
    expect(request.status).toBe('PENDING');
    expect(Number(request.amount_xaf)).toBe(5_760_000);
    expect(request.subject_summary).toBe(
      'Reprise d’un lot en cours : Poulet de chair vif (reprise), 4800 têtes mises en place le 05/10/2026',
    );
    expect(request.subject_summary).not.toContain('5760000');
    expect(fromBin(request.site_id!)).toBe(farmId);
  });

  it('l’approbation fait naître le lot actif, son stock au coût déclaré, son entrée de reprise et son coût par tête', async () => {
    const { result, openingId } = await post(
      productionManager,
      payloadOf({
        placedOn: CORE_PLACED_ON,
        supplierId,
        strain: 'Cobb 500',
        avgWeightG: 1250.5,
        notes: 'Bande de la ferme au 09/11',
      }),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    const approved = await decide(director, openingId, 'approve');
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');

    const posted = await openingRow(openingId);
    expect(posted.status).toBe('POSTED');
    expect(posted.entry_id).not.toBeNull();
    expect(posted.decided_at).not.toBeNull();
    expect(fromBinOrNull(posted.decided_by)).toBe(director.userId);

    const lot = (await lotRow(openingId))!;
    expect(lot).toMatchObject({ status: 'ACTIVE', lot_type: 'POULET_CHAIR', strain: 'Cobb 500' });
    expect(lot.lot_code).toMatch(/^LOT-/);
    expect(fromBin(lot.site_id)).toBe(farmId);
    expect(fromBin(lot.main_location_id)).toBe(buildingId);
    expect(fromBinOrNull(lot.supplier_id)).toBe(supplierId);
    // Date de mise en place réelle (âge du lot), effectif initial = effectif repris (INV-PRD-01).
    expect(lot.start_date!.toISOString().slice(0, 10)).toBe(CORE_PLACED_ON);
    expect(Number(lot.initial_quantity)).toBe(4800);
    // L'auteur de la reprise reste l'auteur du lot, pas l'approbateur.
    expect(fromBin(lot.created_by)).toBe(productionManager.userId);

    // Lot de stock de traçabilité : origine, produit, rang FIFO à la mise en place.
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .selectAll()
      .where('id', '=', lot.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot).toMatchObject({
      origin_type: 'PRODUCTION_LOT',
      status: 'OPEN',
      lot_code: lot.lot_code,
    });
    expect(fromBin(stockLot.origin_id!)).toBe(openingId);
    expect(stockLot.fifo_rank_at.getTime()).toBe(businessDayStartUtc(CORE_PLACED_ON).getTime());

    // Effectif en élevage et non vendu, calculés du registre (INV-PRD-01).
    const stockLotId = fromBin(lot.stock_lot_id);
    expect(await heads(stockLotId, 'REARING')).toBe(4800);
    expect(await heads(stockLotId, 'UNSOLD')).toBe(4800);
    const balance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand', 'value_xaf'])
      .where('location_id', '=', toBin(buildingId))
      .where('lot_key', '=', lot.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(Number(balance.qty_on_hand)).toBe(4800);
    expect(Number(balance.value_xaf)).toBe(5_760_000);

    // Un seul mouvement, `OPENING_BALANCE` depuis `V_OPENING`, à la valeur déclarée.
    const moves = await db
      .selectFrom('inventory_stock_moves as m')
      .innerJoin('organization_locations as f', 'f.id', 'm.from_location_id')
      .select([
        'm.move_type',
        'm.quantity',
        'm.unit_cost_xaf',
        'm.value_xaf',
        'm.source_doc_type',
        'f.location_type as from_type',
      ])
      .where('m.lot_id', '=', lot.stock_lot_id)
      .execute();
    expect(
      moves.map((move) => [
        move.move_type,
        move.from_type,
        move.source_doc_type,
        Number(move.quantity),
        Number(move.unit_cost_xaf),
        Number(move.value_xaf),
      ]),
    ).toEqual([['OPENING_BALANCE', 'V_OPENING', 'LOT_ENTRY', 4800, 1200, 5_760_000]]);

    // Coût ANIMAUX du lot = valeur déclarée ; coût restant et coût par tête (ADR-027).
    const entries = await db
      .selectFrom('inventory_cost_entries')
      .select(['cost_type', 'direction', 'amount_xaf', 'source_type'])
      .where('cost_object_type', '=', 'PRODUCTION_LOT')
      .where('cost_object_id', '=', toBin(openingId))
      .execute();
    expect(
      entries.map((entry) => [
        entry.cost_type,
        entry.direction,
        Number(entry.amount_xaf),
        entry.source_type,
      ]),
    ).toEqual([['ANIMAUX', 'DEBIT', 5_760_000, 'STOCK_MOVE']]);
    expect(
      await db.transaction().execute((trx) => biologicalLotRemainingCostXaf(trx, stockLotId)),
    ).toBe(5_760_000);

    // L'entrée de reprise : type et origine `OPENING`, sans source ; INV-PRD-01 : Σ entrées = effectif initial.
    const entryRows = await db
      .selectFrom('production_lot_entries')
      .selectAll()
      .where('production_lot_id', '=', lot.id)
      .execute();
    expect(entryRows).toHaveLength(1);
    expect(entryRows[0]).toMatchObject({
      entry_type: 'OPENING',
      source_kind: 'OPENING',
      status: 'RECORDED',
    });
    expect(Number(entryRows[0]!.quantity_base)).toBe(4800);
    expect(Number(entryRows[0]!.unit_cost_xaf)).toBe(1200);
    expect(Number(entryRows[0]!.value_xaf)).toBe(5_760_000);
    expect(Number(entryRows[0]!.avg_weight_g)).toBe(1250.5);
    expect(fromBinOrNull(entryRows[0]!.source_location_id)).toBeNull();
    expect(fromBin(entryRows[0]!.id)).toBe(fromBin(posted.entry_id!));
  });

  it('le lot repris est un lot ordinaire : mis en vente, il garde son effectif et son coût', async () => {
    const { openingId } = await post(farmManager, payloadOf({ placedOn: '2026-10-06' }));
    expect((await decide(director, openingId, 'approve')).status).toBe('APPLIED');

    const selling = await run(
      productionManager,
      'production.lot.set_status',
      'PRODUCTION_LOT',
      openingId,
      {
        status: 'SELLING',
      },
    );
    expect(selling.status, JSON.stringify(selling)).toBe('APPLIED');
    const lot = (await lotRow(openingId))!;
    expect(lot.status).toBe('SELLING');
    expect(await heads(fromBin(lot.stock_lot_id), 'REARING')).toBe(4800);
  });

  it('un refus ne crée ni lot, ni stock, ni coût ; la même déclaration rejouée n’est pas « faite »', async () => {
    const { openingId } = await post(farmManager, payloadOf({ placedOn: '2026-10-07' }));
    const refused = await decide(director, openingId, 'reject');
    expect(refused.status, JSON.stringify(refused)).toBe('APPLIED');

    const declaration = await openingRow(openingId);
    expect(declaration.status).toBe('REJECTED');
    expect(declaration.entry_id).toBeNull();
    expect(await lotRow(openingId)).toBeUndefined();
    expect(
      (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: openingId }))
        .netXaf,
    ).toBe(0);
    const stockLots = await db
      .selectFrom('inventory_stock_lots')
      .select('id')
      .where('origin_id', '=', toBin(openingId))
      .execute();
    expect(stockLots).toHaveLength(0);

    // Même identifiant après le refus : refusé (une nouvelle tentative prend un autre identifiant).
    const replay = await post(farmManager, payloadOf({ placedOn: '2026-10-07' }), openingId);
    expect(code(replay.result)).toBe('LOT_OPENING_ID_TAKEN');
    // Une nouvelle tentative corrigée, sous un autre identifiant, est acceptée : le refus libère le lot réel.
    const retry = await post(farmManager, payloadOf({ placedOn: '2026-10-07', quantity: 4700 }));
    expect(retry.result.status, JSON.stringify(retry.result)).toBe('APPLIED');
  });

  it('rejouer une déclaration en attente ne fait rien de plus (une seule demande, une seule déclaration)', async () => {
    const { openingId } = await post(farmManager, payloadOf({ placedOn: '2026-10-08' }));
    const again = await post(farmManager, payloadOf({ placedOn: '2026-10-08' }), openingId);
    expect(again.result.status, JSON.stringify(again.result)).toBe('APPLIED');
    const requests = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(openingId))
      .execute();
    expect(requests).toHaveLength(1);
    // Après la comptabilisation, le rejeu reste un succès sans effet : un seul lot, un seul mouvement.
    expect((await decide(director, openingId, 'approve')).status).toBe('APPLIED');
    expect(
      (await post(farmManager, payloadOf({ placedOn: '2026-10-08' }), openingId)).result.status,
    ).toBe('APPLIED');
    const lot = (await lotRow(openingId))!;
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select('id')
      .where('lot_id', '=', lot.stock_lot_id)
      .execute();
    expect(moves).toHaveLength(1);
  });

  it('refuse une déclaration invalide : effectif, valeur, date, espèce, emplacement, produit, fournisseur', async () => {
    const refused = async (overrides: Record<string, unknown>) =>
      code((await post(farmManager, payloadOf(overrides))).result);

    expect(await refused({ quantity: 0 })).toBe('VALIDATION_ERROR');
    expect(await refused({ quantity: 12.5 })).toBe('VALIDATION_ERROR');
    expect(await refused({ quantity: 1_000_001 })).toBe('VALIDATION_ERROR');
    expect(await refused({ valueXaf: -1 })).toBe('VALIDATION_ERROR');
    expect(await refused({ placedOn: '05/10/2026' })).toBe('VALIDATION_ERROR');
    expect(await refused({ unknownField: 1 })).toBe('VALIDATION_ERROR');
    // Au-delà de 10 000 000 F par tête : faute de frappe.
    expect(await refused({ quantity: 10, valueXaf: 100_000_001 })).toBe(
      'LOT_OPENING_VALUE_TOO_HIGH',
    );
    expect(await refused({ placedOn: '2026-11-10' })).toBe('LOT_OPENING_DATE_FUTURE');
    expect(await refused({ placedOn: '2022-01-01' })).toBe('LOT_OPENING_DATE_TOO_OLD');
    expect(await refused({ placedOn: '2026-02-30' })).toBe('LOT_OPENING_DATE_INVALID');
    // Poule pondeuse dans un lot de poulets de chair ; produit retiré ; produit qui n'est pas un animal.
    expect(await refused({ productId: layerId })).toBe('PRODUCT_INVALID');
    expect(await refused({ productId: inactiveBroilerId })).toBe('PRODUCT_INVALID');
    expect(await refused({ productId: stockOnlyProductId })).toBe('PRODUCT_INVALID');
    expect(await refused({ productId: freshUuid() })).toBe('PRODUCT_INVALID');
    // Emplacement hors ferme, inconnu.
    expect(await refused({ mainLocationId: storeId })).toBe('LOCATION_INVALID');
    expect(await refused({ mainLocationId: freshUuid() })).toBe('LOCATION_INVALID');
    expect(await refused({ supplierId: freshUuid() })).toBe('REFERENCE_INVALID');
  });

  it('refuse le doublon d’un même lot réel : autre reprise en attente ou comptabilisée, lot existant', async () => {
    const first = await post(
      farmManager,
      payloadOf({ mainLocationId: secondBuildingId, placedOn: '2026-10-10' }),
    );
    expect(first.result.status).toBe('APPLIED');
    const sameDay = payloadOf({
      mainLocationId: secondBuildingId,
      placedOn: '2026-10-10',
      quantity: 4000,
    });
    // En attente.
    expect(code((await post(farmManager, sameDay)).result)).toBe('LOT_OPENING_DUPLICATE');
    // Comptabilisée.
    expect((await decide(director, first.openingId, 'approve')).status).toBe('APPLIED');
    expect(code((await post(farmManager, sameDay)).result)).toBe('LOT_OPENING_DUPLICATE');
    // Un autre jour, ou un autre emplacement : deux lots différents.
    expect(
      (
        await post(
          farmManager,
          payloadOf({ mainLocationId: secondBuildingId, placedOn: '2026-10-11' }),
        )
      ).result.status,
    ).toBe('APPLIED');
    expect(
      (await post(farmManager, payloadOf({ mainLocationId: buildingId, placedOn: '2026-10-10' })))
        .result.status,
    ).toBe('APPLIED');

    // Un lot ordinaire déjà saisi (écran de mise en place) du même produit, emplacement et jour de démarrage.
    const manualLotId = freshUuid();
    const created = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      manualLotId,
      {
        lotType: 'POULET_CHAIR',
        productId: broilerId,
        mainLocationId: secondBuildingId,
      },
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    await db
      .updateTable('production_production_lots')
      .set({ status: 'ACTIVE', start_date: new Date('2026-10-12T00:00:00.000Z') })
      .where('id', '=', toBin(manualLotId))
      .execute();
    expect(
      code(
        (
          await post(
            farmManager,
            payloadOf({ mainLocationId: secondBuildingId, placedOn: '2026-10-12' }),
          )
        ).result,
      ),
    ).toBe('LOT_OPENING_DUPLICATE');
  });

  it('respecte la portée : un responsable d’une autre ferme et un compte sans droit sont refusés', async () => {
    expect(code((await post(otherFarmManager)).result)).toBe('FORBIDDEN_SCOPE');
    expect(code((await post(stranger)).result)).toBe('FORBIDDEN');
    // L'Administrateur charge pour la ferme (droit global) ; le magasinier n'a pas ce droit.
    expect((await post(admin, payloadOf({ placedOn: '2026-10-13' }))).result.status).toBe(
      'APPLIED',
    );
  });

  it('l’auteur d’une reprise ne la valide pas lui-même et la reprise en attente ne se retire pas', async () => {
    const { openingId } = await post(farmManager, payloadOf({ placedOn: '2026-10-14' }));
    const selfApproved = await decide(farmManager, openingId, 'approve');
    expect(code(selfApproved)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await openingRow(openingId)).status).toBe('PENDING_APPROVAL');

    const requestId = fromBinOrNull((await openingRow(openingId)).approval_request_id)!;
    const withdrawn = await run(
      farmManager,
      'approvals.request.withdraw',
      'APPROVAL_REQUEST',
      requestId,
      { requestId },
    );
    expect(code(withdrawn)).toBe('LOT_OPENING_NOT_WITHDRAWABLE');
    expect((await openingRow(openingId)).status).toBe('PENDING_APPROVAL');
  });

  it('une reprise comptabilisée ne s’annule pas : l’effectif se corrige par un inventaire', async () => {
    const { openingId } = await post(farmManager, payloadOf({ placedOn: '2026-10-15' }));
    expect((await decide(director, openingId, 'approve')).status).toBe('APPLIED');
    const entryId = fromBin((await openingRow(openingId)).entry_id!);
    const cancelled = await run(
      productionManager,
      'production.lot.cancel_entry',
      'LOT_ENTRY',
      entryId,
      {
        comment: 'Erreur de saisie',
      },
    );
    expect(code(cancelled)).toBe('LOT_ENTRY_INVALID');
    expect((await lotRow(openingId))!.status).toBe('ACTIVE');
  });

  it('l’approbation est refusée si l’emplacement n’est plus une ferme active ; la demande reste à décider', async () => {
    const location = await db
      .transaction()
      .execute((trx) =>
        insertTestLocation(trx, admin.userId, farmId, { locationType: 'BUILDING' }),
      );
    const { openingId } = await post(
      farmManager,
      payloadOf({ mainLocationId: location, placedOn: '2026-10-16' }),
    );
    await db
      .updateTable('organization_locations')
      .set({ status: 'INACTIVE' })
      .where('id', '=', toBin(location))
      .execute();
    const approved = await decide(director, openingId, 'approve');
    expect(code(approved)).toBe('LOCATION_INVALID');
    expect((await openingRow(openingId)).status).toBe('PENDING_APPROVAL');
    expect(await lotRow(openingId)).toBeUndefined();
    // La Direction peut toujours refuser.
    expect((await decide(director, openingId, 'reject')).status).toBe('APPLIED');
    expect((await openingRow(openingId)).status).toBe('REJECTED');
  });

  it('sans politique LOT_OPENING la commande est refusée ; hors ligne, la politique est jugée à la réception', async () => {
    await withoutActivePolicies('LOT_OPENING', new Date('2026-11-08T00:00:00.000Z'), async () => {
      expect(code((await post(farmManager, payloadOf({ placedOn: '2026-10-17' }))).result)).toBe(
        'CONTROL_POLICY_MISSING',
      );
    });
    const offline = await post(farmManager, payloadOf({ placedOn: '2026-10-18' }), freshUuid(), {
      offline: true,
    });
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED');
    const declaration = await openingRow(offline.openingId);
    expect(Number(declaration.captured_offline)).toBe(1);
    expect((await decide(director, offline.openingId, 'approve')).status).toBe('APPLIED');
    expect((await lotRow(offline.openingId))!.status).toBe('ACTIVE');
  });
});
