/**
 * Monde de test des transferts de P5-16 (réception sans document, rapprochement, retour à la source,
 * AT-017) : utilisateurs et rôles (magasinier, vendeur de PDV, approbateur), appareils, sites
 * magasin et point de vente, politique `TRANSFER_DISCREPANCY` bornée à la journée du test (pièges de
 * la base partagée : PROMPT-DE-REPRISE.md §1), vrai pipeline de commande et vrais registres.
 * Chaque test crée sa propre paire d'emplacements et ses produits : aucun état partagé entre tests.
 */
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerAllocationCommands } from '../src/modules/inventory/application/commands/allocation-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import {
  assignTestRole,
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

export const DAY = '2026-10-09';
/** Instant du jour du test (UTC). */
export const at = (hhmm: string, day = DAY): string => `${day}T${hhmm}:00.000Z`;

export interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

export interface TransferWorld {
  readonly clock: FixedClock;
  readonly idGenerator: IdGenerator;
  readonly registry: CommandHandlerRegistry;
  readonly decisionRegistry: ApprovalDecisionHandlerRegistry;
  readonly pipeline: CommandPipelineService;
  readonly admin: Actor;
  readonly keeper: Actor;
  readonly seller: Actor;
  readonly approver: Actor;
  readonly zoneId: string;
  readonly storeSite: string;
  readonly pdvSite: string;
  readonly policyId: string;
}

let deviceSeq = 5_000;

export interface SendOptions {
  readonly occurredAt?: string;
  readonly offline?: boolean;
  readonly commandId?: string;
  /** Rejeu à l'identique : même `device_seq` (l'enveloppe entière est hachée). */
  readonly deviceSeq?: number;
  readonly aggregateType?: string;
}

/** Une commande à travers le vrai pipeline, au nom d'un acteur et de son appareil. */
export function send(
  world: TransferWorld,
  actor: Actor,
  commandType: string,
  aggregateId: string,
  payload: unknown,
  options: SendOptions = {},
) {
  const occurredAt = options.occurredAt ?? at('09:00');
  const offline = options.offline ?? false;
  return world.pipeline.handle(
    {
      command_id: options.commandId ?? freshUuid(),
      device_seq: options.deviceSeq ?? deviceSeq++,
      command_version: 1,
      command_type: commandType,
      author_user_id: actor.userId,
      aggregate_type:
        options.aggregateType ??
        (commandType.startsWith('approvals.') ? 'APPROVAL_REQUEST' : 'STOCK_TRANSFER'),
      aggregate_id: aggregateId,
      base_version: null,
      depends_on: [],
      occurred_at: occurredAt,
      client_created_at: occurredAt,
      captured_offline: offline,
      backdated_reason: null,
      attachment_ids: [],
      payload,
    },
    {
      authenticatedUserId: actor.userId,
      authenticatedDeviceId: actor.deviceId,
      transport: offline ? 'SYNC_PUSH' : 'ONLINE_API',
    },
  );
}

async function newActor(
  admin: string,
  permissions: readonly string[],
  scope?: { readonly siteId: string },
): Promise<Actor> {
  return db.transaction().execute(async (trx) => {
    const userId = await insertTestUser(trx);
    const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
    const role = await insertTestRole(trx, admin, scope ? { allowedScopeTypes: ['SITE'] } : {});
    for (const code of permissions) {
      await grantTestPermission(trx, role, code, admin, scope ? { maxScope: 'SITE' } : {});
    }
    await assignTestRole(
      trx,
      userId,
      role,
      admin,
      scope ? { scopeType: 'SITE', scopeSiteId: scope.siteId } : {},
    );
    return { userId, deviceId };
  });
}

export async function createTransferWorld(
  options: {
    readonly clockAt?: string;
    readonly policyFrom?: string;
    readonly policyTo?: string;
  } = {},
): Promise<TransferWorld> {
  const clock = new FixedClock(new Date(options.clockAt ?? at('12:00')));
  const idGenerator = new Uuidv7Generator(clock);
  const registry = new CommandHandlerRegistry();
  const decisionRegistry = new ApprovalDecisionHandlerRegistry();
  registerTransferCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
  registerAllocationCommands(registry, idGenerator);
  registerPolicyCommands(registry);
  registerRequestCommands(registry, decisionRegistry);
  const pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

  const adminId = await db.transaction().execute((trx) => insertTestUser(trx));
  const adminDevice = await db
    .transaction()
    .execute((trx) => insertTestDevice(trx, adminId, { status: 'ACTIVE' }));
  const { zoneId, storeSite, pdvSite } = await db.transaction().execute(async (trx) => {
    const zone = await insertTestZone(trx, adminId);
    return {
      zoneId: zone,
      storeSite: await insertTestSite(trx, adminId, zone, { siteType: 'MAGASIN' }),
      pdvSite: await insertTestSite(trx, adminId, zone, { siteType: 'POINT_DE_VENTE' }),
    };
  });
  await db.transaction().execute(async (trx) => {
    const role = await insertTestRole(trx, adminId);
    // Droits de l'administrateur posés avant sa première commande (les droits d'un utilisateur sont
    // mis en cache par processus) : politiques, quotas, configuration d'un PDV.
    for (const code of [
      'approvals.policy.manage',
      'inventory.allocation.manage',
      'org.structure.manage',
    ]) {
      await grantTestPermission(trx, role, code, adminId);
    }
    await assignTestRole(trx, adminId, role, adminId);
  });
  const admin = { userId: adminId, deviceId: adminDevice };
  const keeper = await newActor(adminId, [
    'inventory.transfer.request',
    'inventory.transfer.dispatch',
    'inventory.transfer.receive',
    'inventory.stock.read',
  ]);
  const seller = await newActor(
    adminId,
    ['inventory.transfer.receive', 'inventory.transfer.request', 'inventory.stock.read'],
    { siteId: pdvSite },
  );
  const approver = await newActor(adminId, ['inventory.transfer_discrepancy.approve'], {
    siteId: storeSite,
  });
  await db.transaction().execute(async (trx) => {
    const role = await insertTestRole(trx, adminId);
    await grantTestPermission(trx, role, 'approvals.request.read', adminId);
    await assignTestRole(trx, approver.userId, role, adminId);
  });

  const world: TransferWorld = {
    clock,
    idGenerator,
    registry,
    decisionRegistry,
    pipeline,
    admin,
    keeper,
    seller,
    approver,
    zoneId,
    storeSite,
    pdvSite,
    policyId: freshUuid(),
  };
  // Politique bornée à la journée du test (une politique sans fin devancerait celles des autres).
  const policy = await world.pipeline.handle(
    {
      command_id: freshUuid(),
      device_seq: deviceSeq++,
      command_version: 1,
      command_type: 'approvals.policy.set',
      author_user_id: adminId,
      aggregate_type: 'CONTROL_POLICY',
      aggregate_id: world.policyId,
      base_version: null,
      depends_on: [],
      occurred_at: at('00:00'),
      client_created_at: at('00:00'),
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: {
        code: `TRF_P516_${world.policyId.slice(-8)}`,
        operationType: 'TRANSFER_DISCREPANCY',
        requiresApproval: true,
        approverPermission: 'inventory.transfer_discrepancy.approve',
        approverScope: 'SITE',
        validFrom: options.policyFrom ?? at('00:00'),
        validTo: options.policyTo ?? at('23:00'),
      },
    },
    { authenticatedUserId: adminId, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
  );
  if (policy.status !== 'APPLIED') throw new Error(`Politique de test : ${JSON.stringify(policy)}`);
  return world;
}

export interface Pair {
  readonly store: string;
  readonly pos: string;
}

/**
 * Une paire neuve : magasin (`SHARED`) du site magasin → emplacement de vente du PDV, gardé selon
 * `custody` (défaut : `EXCLUSIVE_DEVICE`, tablette désignée = appareil du vendeur).
 */
export async function newPair(
  world: TransferWorld,
  custody: {
    readonly mode?: 'EXCLUSIVE_DEVICE' | 'EXCLUSIVE_USER' | 'SHARED';
    readonly designatedDeviceId?: string;
    readonly custodianUserId?: string;
  } = {},
): Promise<Pair> {
  return db.transaction().execute(async (trx) => {
    const store = await insertTestLocation(trx, world.admin.userId, world.storeSite, {
      locationType: 'STORE',
    });
    const mode = custody.mode ?? 'EXCLUSIVE_DEVICE';
    if (mode === 'EXCLUSIVE_USER') {
      // Stock mobile : son détenteur est obligatoire dès l'insertion (ck_organization_locations_mobile).
      const mobile = freshUuid();
      await trx
        .insertInto('organization_locations')
        .values({
          id: toBin(mobile),
          site_id: toBin(world.pdvSite),
          code: mobile.replace(/-/g, '').slice(-8).toUpperCase(),
          name: 'Stock mobile de test',
          location_type: 'MOBILE',
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: toBin(custody.custodianUserId ?? world.seller.userId),
          created_by: toBin(world.admin.userId),
        })
        .execute();
      return { store, pos: mobile };
    }
    const pos = await insertTestLocation(trx, world.admin.userId, world.pdvSite, {
      locationType: 'POS',
    });
    await trx
      .updateTable('organization_locations')
      .set({
        custody_mode: mode,
        designated_device_id:
          mode === 'EXCLUSIVE_DEVICE'
            ? toBin(custody.designatedDeviceId ?? world.seller.deviceId)
            : null,
      })
      .where('id', '=', toBin(pos))
      .execute();
    return { store, pos };
  });
}

export async function newProduct(
  world: TransferWorld,
  lotTracking: 'NONE' | 'OPTIONAL' | 'REQUIRED' = 'NONE',
): Promise<string> {
  return db
    .transaction()
    .execute((trx) => insertTestProduct(trx, world.admin.userId, { lotTracking }));
}

/** Lot de stock d'un produit (`SUPPLIER_LOT` par défaut ; `PRODUCTION_LOT` : lot biologique). */
export async function newLot(
  world: TransferWorld,
  productId: string,
  options: { readonly originType?: string; readonly rankAt?: string } = {},
): Promise<string> {
  const id = freshUuid();
  await db
    .insertInto('inventory_stock_lots')
    .values({
      id: toBin(id),
      lot_code: `P516-${id.slice(-12)}`,
      product_id: toBin(productId),
      origin_type: options.originType ?? 'SUPPLIER_LOT',
      origin_id: toBin(freshUuid()),
      fifo_rank_at: new Date(options.rankAt ?? at('01:00', '2026-10-01')),
      created_by: toBin(world.admin.userId),
    })
    .execute();
  return id;
}

async function virtualId(type: string): Promise<string> {
  const row = await db
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', type)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/** Stock d'ouverture valorisé d'un produit (et d'un lot) sur un emplacement. */
export async function stock(
  world: TransferWorld,
  productId: string,
  locationId: string,
  quantityBase: number,
  options: { readonly lotId?: string; readonly unitCostXaf?: number } = {},
): Promise<void> {
  const opening = await virtualId('V_OPENING');
  await db.transaction().execute((trx) =>
    recordStockMove(
      trx,
      { idGenerator: world.idGenerator },
      {
        productId,
        ...(options.lotId !== undefined ? { lotId: options.lotId } : {}),
        quantityBase,
        fromLocationId: opening,
        toLocationId: locationId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: options.unitCostXaf ?? 500,
        occurredAt: new Date(at('00:30', '2026-10-01')),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: world.admin.userId,
        allowNegative: false,
      },
    ),
  );
}

/** Solde (quantité, valeur) d'un produit sur un emplacement ; `lotId` : `undefined` = tous lots. */
export async function balanceOf(
  productId: string,
  locationId: string,
  lotId?: string | null,
): Promise<{ readonly qty: number; readonly valueXaf: number }> {
  let query = db
    .selectFrom('inventory_stock_balances')
    .select(['qty_on_hand', 'value_xaf', 'lot_key'])
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId));
  if (lotId !== undefined) {
    query = query.where('lot_key', '=', lotId === null ? Buffer.alloc(16) : toBin(lotId));
  }
  const rows = await query.execute();
  return {
    qty: Math.round(rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0) * 1000) / 1000,
    valueXaf: rows.reduce((sum, row) => sum + Number(row.value_xaf), 0),
  };
}

export async function transitOf(productId: string, lotId?: string | null) {
  return balanceOf(productId, await virtualId('V_TRANSIT'), lotId);
}

export async function transferOf(transferId: string) {
  return db
    .selectFrom('inventory_stock_transfers')
    .selectAll()
    .where('id', '=', toBin(transferId))
    .executeTakeFirstOrThrow();
}

export async function linesOf(transferId: string) {
  return db
    .selectFrom('inventory_stock_transfer_lines')
    .selectAll()
    .where('transfer_id', '=', toBin(transferId))
    .orderBy('id')
    .execute();
}

export async function movesOf(documentId: string, moveType?: string) {
  let query = db
    .selectFrom('inventory_stock_moves')
    .selectAll()
    .where('source_doc_type', '=', 'TRANSFER')
    .where('source_doc_id', '=', toBin(documentId));
  if (moveType !== undefined) query = query.where('move_type', '=', moveType);
  // Ordre d'écriture (l'identifiant d'une horloge de test figée n'est pas chronologique).
  return query.orderBy('recorded_at').orderBy('id').execute();
}

export async function conflictsOn(conflictType: string, entityId: string) {
  return db
    .selectFrom('sync_sync_conflicts')
    .selectAll()
    .where('conflict_type', '=', conflictType)
    .where('entity_id', '=', toBin(entityId))
    .execute();
}

/** Expédition directe d'un produit de la paire. */
export async function dispatch(
  world: TransferWorld,
  pair: Pair,
  productId: string,
  quantityBase: number,
  options: SendOptions & { readonly transferId?: string; readonly lotId?: string } = {},
) {
  const transferId = options.transferId ?? freshUuid();
  const result = await send(
    world,
    world.keeper,
    'inventory.transfer.dispatch',
    transferId,
    {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [
        {
          productId,
          unitCode: 'TETE',
          quantityBase,
          ...(options.lotId !== undefined ? { lotId: options.lotId } : {}),
        },
      ],
    },
    { occurredAt: options.occurredAt ?? at('06:00'), ...options },
  );
  return { transferId, result };
}

/** Réception sans document par la tablette du PDV (hors ligne par défaut). */
export async function blindReceive(
  world: TransferWorld,
  pair: Pair,
  lines: readonly {
    readonly productId: string;
    readonly receivedQtyBase: number;
    readonly lotId?: string;
  }[],
  options: SendOptions & { readonly actor?: Actor; readonly receiptId?: string } = {},
) {
  const receiptId = options.receiptId ?? freshUuid();
  const result = await send(
    world,
    options.actor ?? world.seller,
    'inventory.transfer.receive',
    receiptId,
    {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: lines.map((line) => ({ unitCode: 'TETE', ...line })),
    },
    { offline: true, occurredAt: options.occurredAt ?? at('08:00'), ...options },
  );
  return { receiptId, result };
}

/** Paramètre de site (jamais global : la base est partagée), daté avant l'instant de test. */
export async function setSiteSetting(
  world: TransferWorld,
  key: string,
  siteId: string,
  value: unknown,
  validFrom: string,
): Promise<void> {
  await db
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: jsonValue(value),
      scope_type: 'SITE',
      scope_id: toBin(siteId),
      valid_from: new Date(validFrom),
      is_client_visible: 0,
      created_by: toBin(world.admin.userId),
      reason: 'Test P5-16',
    })
    .execute();
}
