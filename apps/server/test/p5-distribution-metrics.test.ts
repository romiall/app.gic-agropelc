/**
 * P5-19 — métriques de distribution, de bout en bout : registre complet de l'application, rôles réels
 * du seed, opérations écrites par les vraies commandes (transferts, réception sans document, retour à
 * la source, écart de transfert approuvé, quota, ventes, annulation, commande livrée en partie, session
 * de caisse, encaissement, remise de fonds) ; seules les pertes et les écarts d'inventaire sont écrits
 * par `recordStockMove` (documents fictifs).
 *
 * Démontre : flux d'un PDV par produit et période (`locationFlows`) et identité de rapprochement du
 * domaine (`distributionResidual` = 0, AV-199) ; envoyé par destination net des retours à la source,
 * chacun à sa date ; vendu de `sales` = vendu net d'`inventory` ; à livrer = solde `V_TO_DELIVER` ;
 * encaissé ventilé = total de l'accueil (BR-ANA-009) ; position des quotas et `GET /stock` net des
 * quotas (BR-STK-011) ; sessions de caisse du jour et remises en attente ; fraîcheur des appareils
 * (dernier pull enregistré, appareils d'un site, retard) ; pertes récentes de l'accueil sans double
 * compte d'une perte confirmée. Chaque assertion porte sur les identifiants du fichier (base partagée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  businessDayOf,
  distributionResidual,
  FixedClock,
  resolveAnalyticsPeriod,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { deviceFreshness, devicesOfSites } from '../src/sync/device-freshness.js';
import { syncBacklog } from '../src/sync/sync-backlog.js';
import { openConflictSummary, recordConflict } from '../src/platform/sync/conflicts.js';
import {
  allocationPositions,
  distributionFlowsOf,
  distributionKpisOf,
  listStockBalances,
  locationFlows,
  recentLosses,
  recordStockMove,
  sentByDestination,
} from '../src/modules/inventory/application/public/index.js';
import {
  cashedByGroup,
  cashedSummary,
  salesActivityByDay,
  soldByLocation,
  sumSalesActivity,
  toDeliverByLocation,
} from '../src/modules/sales/application/public/index.js';
import { buildHome } from '../src/home-api/home-service.js';
import { listSnapshotsOf } from '../src/modules/analytics/application/public/index.js';
import { refreshSnapshotsOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import {
  cashSessionThresholdsAt,
  cashSessionsOverview,
  pendingCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestTeam,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  withoutActivePolicies,
  freshPhone,
  signTestAccessToken,
} from './helpers.js';
import { fund, newActor, roleIdOf, tx, type Actor } from './cash-transfer-fixtures.js';
import {
  distributionDashboardResponseSchema,
  homeResponseSchema,
  type HomeResponse,
} from '@gic/contracts';
import { OfflineDevice } from './device-harness.js';

const D0 = '2026-09-14';
const D1 = '2026-09-15';
const D2 = '2026-09-16';
const D3 = '2026-09-17';
const D4 = '2026-09-18';
const D5 = '2026-09-19';
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
const PRICE = 1000;
let deviceSeq = 0;

describe('P5-19 : métriques de distribution', { timeout: 240_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let root: string;
  let admin: Actor;
  let dir: Actor;
  let fin: Actor;
  let magS: Actor;
  let magP: Actor;
  let venP: Actor;
  let comS: Actor;
  let siteS: string;
  let siteP: string;
  let store: string;
  let counter: string;
  let back: string;
  let back2: string;
  let back3: string;
  let productId: string;
  let ruleId: string;
  let custV: string;
  let custC: string;
  let posAcc: string;
  let central: string;
  let staleDevice: string;
  let policyId: string;
  let venToken: string;
  let magPDevice: OfflineDevice;

  const send = (
    actor: Actor,
    command: {
      readonly type: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly occurredAt: string;
      readonly payload: unknown;
    },
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: command.type,
        aggregate_type: command.aggregateType,
        aggregate_id: command.aggregateId,
        author_user_id: actor.userId,
        base_version: null,
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
  const ok = async (...args: Parameters<typeof send>) => {
    const result = await send(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };
  const line = (quantity: number) => ({
    productId,
    quantity,
    unitCode: 'PIECE',
    quantityBase: quantity,
    listUnitPriceXaf: PRICE,
    priceRuleId: ruleId,
    unitPriceXaf: PRICE,
  });
  const dispatch = async (id: string, quantityBase: number, occurredAt: string) =>
    ok(magS, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: id,
      occurredAt,
      payload: {
        fromLocationId: store,
        toLocationId: counter,
        lines: [{ productId, unitCode: 'PIECE', quantityBase }],
      },
    });
  const receive = async (transferId: string, receivedQtyBase: number, occurredAt: string) => {
    const [transferLine] = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(transferId))
      .execute();
    return ok(magP, {
      type: 'inventory.transfer.receive',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: transferId,
      occurredAt,
      payload: {
        transferId,
        lines: [{ transferLineId: fromBin(transferLine!.id), receivedQtyBase }],
      },
    });
  };
  const move = (
    moveType: string,
    from: string,
    to: string,
    quantityBase: number,
    occurredAt: string,
    sourceDocType: string,
    sourceDocId: string = freshUuid(),
  ) =>
    tx((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase,
          fromLocationId: from,
          toLocationId: to,
          moveType: moveType as never,
          occurredAt: new Date(occurredAt),
          sourceDocType: sourceDocType as never,
          sourceDocId,
          // Entrées valorisées (ouverture, gain d'inventaire) : coût déclaré de 500.
          ...(moveType === 'OPENING_BALANCE' || moveType === 'INVENTORY_GAIN'
            ? { declaredUnitCostXaf: 500 }
            : {}),
          createdBy: root,
          allowNegative: false,
        },
      ),
    );
  const virtual = async (type: string) =>
    fromBin(
      (
        await db
          .selectFrom('organization_locations')
          .select('id')
          .where('location_type', '=', type)
          .executeTakeFirstOrThrow()
      ).id,
    );
  const period = (fromDay: string, toDay: string) => ({ fromDay, toDay });
  const counterFlows = async (fromDay: string, toDay: string) => {
    const flows = await locationFlows(db, {
      locationIds: [counter],
      period: period(fromDay, toDay),
      productIds: [productId],
    });
    expect(flows).toHaveLength(1);
    return flows[0]!;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    pullService = new SyncPullService(db);

    root = await tx((trx) => insertTestUser(trx));
    let zoneId = '';
    await tx(async (trx) => {
      zoneId = await insertTestZone(trx, root);
      siteS = await insertTestSite(trx, root, zoneId, { siteType: 'MAGASIN' });
      siteP = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      store = await insertTestLocation(trx, root, siteS, { locationType: 'STORE' });
      counter = await insertTestLocation(trx, root, siteP, { locationType: 'POS' });
      back = await insertTestLocation(trx, root, siteP, { locationType: 'STORE' });
      back2 = await insertTestLocation(trx, root, siteP, { locationType: 'STORE' });
      back3 = await insertTestLocation(trx, root, siteP, { locationType: 'POS' });
      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', 'PIECE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'PIECE', name: 'Pièce', is_count: 1 })
          .execute();
      }
      for (const channel of ['POINT_DE_VENTE', 'DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
        if (
          !(await trx
            .selectFrom('catalog_sales_channels')
            .select('code')
            .where('code', '=', channel)
            .executeTakeFirst())
        ) {
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
          name: 'Divers',
          created_by: toBin(root),
        })
        .execute();
      productId = freshUuid();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `PRD-${productId.slice(-10)}`,
          name: 'Poulet de chair',
          category_id: toBin(categoryId),
          stock_family: 'MARCHANDISE',
          base_unit_code: 'PIECE',
          pricing_mode: 'PER_UNIT',
          is_sellable: 1,
          created_by: toBin(root),
        })
        .execute();
      ruleId = freshUuid();
      await trx
        .insertInto('pricing_price_rules')
        .values({
          id: toBin(ruleId),
          code: `PR-${ruleId.slice(-12)}`,
          version: 1,
          product_id: toBin(productId),
          unit_price_xaf: PRICE,
          pricing_unit_code: 'PIECE',
          status: 'ACTIVE',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          approved_by: toBin(root),
          approved_at: new Date('2026-01-01T00:00:00.000Z'),
          created_by: toBin(root),
        })
        .execute();
    });
    admin = await newActor('ADMIN', root);
    dir = await newActor('DIRECTION', root);
    fin = await newActor('FINANCE', root);
    magS = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteS });
    magP = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteP });
    venP = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteP });
    comS = await newActor('COMMERCIAL_SEDENTAIRE', root);

    // Clients à crédit : du vendeur (ventes directes) et du commercial (commande).
    await tx(async (trx) => {
      const stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(root),
        })
        .execute();
      const sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(root),
        })
        .execute();
      const customer = async (owner: Actor) => {
        const id = freshUuid();
        await trx
          .insertInto('crm_customers')
          .values({
            id: toBin(id),
            stage: 'PROSPECT',
            pipeline_step_id: toBin(stepId),
            display_name: 'Restaurant du marché',
            phone_primary: await freshPhone(),
            zone_id: toBin(zoneId),
            source_code: sourceCode,
            acquired_by_user_id: toBin(owner.userId),
            owner_user_id: toBin(owner.userId),
            acquired_at: new Date('2026-01-01T00:00:00.000Z'),
            occurred_at: new Date('2026-01-01T00:00:00.000Z'),
            credit_allowed: 1,
            credit_limit_xaf: 10_000_000,
            payment_terms_days: 30,
            created_by: toBin(root),
          })
          .execute();
        await trx
          .insertInto('crm_customer_assignments')
          .values({
            id: toBin(freshUuid()),
            customer_id: toBin(id),
            user_id: toBin(owner.userId),
            valid_from: new Date('2026-01-01T00:00:00.000Z'),
            assigned_by: toBin(root),
          })
          .execute();
        return id;
      };
      custV = await customer(venP);
      custC = await customer(comS);
    });

    // Stock d'ouverture du magasin (1 000 au coût de 500) et du magasin arrière du PDV.
    await move(
      'OPENING_BALANCE',
      await virtual('V_OPENING'),
      store,
      1000,
      at(D0, '05:00'),
      'INVENTORY_COUNT',
    );
    await move(
      'OPENING_BALANCE',
      await virtual('V_OPENING'),
      back,
      10,
      at(D0, '05:00'),
      'INVENTORY_COUNT',
    );
    // Politique d'écart de transfert du scénario (neutralisée en fin de fichier).
    policyId = freshUuid();
    await ok(admin, {
      type: 'approvals.policy.set',
      aggregateType: 'CONTROL_POLICY',
      aggregateId: policyId,
      occurredAt: at(D0, '04:00'),
      payload: {
        code: `TRF_P519_${policyId.slice(-8)}`,
        operationType: 'TRANSFER_DISCREPANCY',
        requiresApproval: true,
        approverPermission: 'inventory.transfer_discrepancy.approve',
        approverScope: 'SITE',
        validFrom: at(D0, '04:00'),
        // Le rapprochement et l'écart lisent la politique à l'heure de réception par le serveur :
        // bornée à deux heures après maintenant (neutralisée en fin de fichier).
        validTo: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      },
    });
    await ok(admin, {
      type: 'organization.pos.configure',
      aggregateType: 'SITE',
      aggregateId: siteP,
      occurredAt: at(D0, '05:30'),
      payload: { salesLocationId: counter, custodyMode: 'SHARED' },
    });
    const account = async (payload: Record<string, unknown>) => {
      const id = freshUuid();
      await ok(fin, {
        type: 'finance.cash_account.create',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: id,
        occurredAt: at(D0, '05:40'),
        payload: { code: `P519-${id.slice(-12)}`, name: 'Compte P5-19', ...payload },
      });
      return id;
    };
    posAcc = await account({
      accountType: 'CAISSE_PDV',
      siteId: siteP,
      responsibleUserId: venP.userId,
    });
    central = await account({ accountType: 'CAISSE_CENTRALE', responsibleUserId: fin.userId });
    await fund(idGenerator, posAcc, 10_000, at(D1, '05:00'), root);

    // --- Jour 1 ---------------------------------------------------------------------------------
    const t1 = freshUuid();
    const t2 = freshUuid();
    await dispatch(t1, 100, at(D1, '06:00'));
    await receive(t1, 100, at(D1, '07:00'));
    const session = freshUuid();
    await ok(venP, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at(D1, '07:30'),
      payload: { cashAccountId: posAcc, countedXaf: 10_000 },
    });
    await ok(magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '08:00'),
      payload: {
        holderUserId: venP.userId,
        holderDeviceId: venP.deviceId,
        locationId: counter,
        productId,
        quantityBase: 15,
      },
    });
    const s1 = freshUuid();
    await ok(venP, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: s1,
      occurredAt: at(D1, '09:00'),
      payload: { fromLocationId: counter, customerId: custV, lines: [line(4)] },
    });
    await ok(venP, {
      type: 'sales.sale.cancel',
      aggregateType: 'SALE_CANCELLATION',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '09:03'),
      payload: { saleId: s1, comment: 'Erreur de saisie' },
    });
    await ok(venP, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '09:30'),
      payload: { fromLocationId: counter, customerId: custV, lines: [line(6)] },
    });
    await ok(venP, {
      type: 'sales.payment.record',
      aggregateType: 'CUSTOMER_PAYMENT',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '11:00'),
      payload: {
        customerId: custV,
        amountXaf: 5_000,
        methodCode: 'ESPECES',
        cashAccountId: posAcc,
      },
    });
    const orderId = freshUuid();
    await ok(comS, {
      type: 'sales.order.place',
      aggregateType: 'SALES_ORDER',
      aggregateId: orderId,
      occurredAt: at(D1, '12:00'),
      payload: { customerId: custC, fulfilmentLocationId: counter, lines: [line(5)] },
    });
    const orderLine = await db
      .selectFrom('sales_sales_order_lines')
      .select('id')
      .where('order_id', '=', toBin(orderId))
      .executeTakeFirstOrThrow();
    await ok(comS, {
      type: 'sales.order.fulfil',
      aggregateType: 'DELIVERY_NOTE',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '13:00'),
      payload: { orderId, lines: [{ orderLineId: fromBin(orderLine.id), quantityBase: 2 }] },
    });
    await ok(venP, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: session,
      occurredAt: at(D1, '18:00'),
      payload: { countedXaf: 9_000 },
    });
    // Réception sans document hors ligne (tablette du magasinier), puis l'expédition qui la rapproche.
    magPDevice = new OfflineDevice(
      { push: app.get(SyncPushService), pull: pullService },
      magP.deviceId,
      clock,
    );
    const blind = magPDevice.enqueue(magP.userId, {
      type: 'inventory.transfer.receive',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: freshUuid(),
      occurredAt: at(D1, '20:00'),
      payload: {
        fromLocationId: store,
        toLocationId: counter,
        lines: [{ productId, unitCode: 'PIECE', receivedQtyBase: 20 }],
      },
    });
    await magPDevice.sync(magP.userId);
    expect(magPDevice.resultOf(blind.command_id)?.status).toMatch(/^APPLIED/);
    const t3 = freshUuid();
    const matched = await dispatch(t3, 20, at(D1, '19:00'));
    expect(matched).toMatchObject({ server_refs: { matchedBlindReceiptId: blind.aggregate_id } });
    // T2 part après coup (aucune expédition en transit ne devait capter la réception sans document,
    // qui se rapproche sur-le-champ d'une expédition connue de la paire, AV-177) ; renvoyée au jour 2.
    await dispatch(t2, 30, at(D1, '21:00'));

    // --- Jour 2 ---------------------------------------------------------------------------------
    await ok(magS, {
      type: 'inventory.transfer.return_to_source',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: t2,
      occurredAt: at(D2, '08:00'),
      payload: { transferId: t2, reason: 'Camion en panne' },
    });
    await ok(venP, {
      type: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: freshUuid(),
      occurredAt: at(D2, '09:00'),
      payload: { fromAccountId: posAcc, toAccountId: central, amountXaf: 1_000 },
    });
    const lossDoc = freshUuid();
    await move('LOSS', counter, await virtual('V_LOSS'), 3, at(D2, '13:00'), 'LOSS');
    await move(
      'LOSS_PENDING',
      counter,
      await virtual('V_PENDING_LOSS'),
      2,
      at(D2, '13:10'),
      'LOSS',
      lossDoc,
    );
    await move(
      'LOSS_RELEASE',
      await virtual('V_PENDING_LOSS'),
      counter,
      2,
      at(D2, '15:00'),
      'LOSS',
      lossDoc,
    );
    const countDoc = freshUuid();
    await move(
      'INVENTORY_LOSS',
      counter,
      await virtual('V_ADJUSTMENT'),
      1,
      at(D2, '16:00'),
      'INVENTORY_COUNT',
      countDoc,
    );
    await move(
      'INVENTORY_GAIN',
      await virtual('V_ADJUSTMENT'),
      counter,
      1,
      at(D2, '16:05'),
      'INVENTORY_COUNT',
      countDoc,
    );

    // --- Jour 3 : écart de transfert (9 reçus pour 10), approuvé ---------------------------------
    const t4 = freshUuid();
    await dispatch(t4, 10, at(D3, '06:00'));
    await receive(t4, 9, at(D3, '07:00'));
    const transfer = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'approval_request_id'])
      .where('id', '=', toBin(t4))
      .executeTakeFirstOrThrow();
    expect(transfer.status).toBe('DISCREPANCY_PENDING');
    const requestId = fromBin(transfer.approval_request_id!);
    await ok(dir, {
      type: 'approvals.request.approve',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: requestId,
      occurredAt: at(D3, '09:00'),
      payload: { requestId },
    });

    // Appareils du PDV : le détenteur du quota (vendeur), la tablette du magasinier rattachée au site,
    // et une tablette rattachée sans contact depuis longtemps.
    staleDevice = await tx((trx) => insertTestDevice(trx, root, { status: 'ACTIVE' }));
    for (const deviceId of [magP.deviceId, staleDevice]) {
      await db
        .updateTable('identity_devices')
        .set({
          designated_site_id: toBin(siteP),
          last_seen_at: new Date(at(D0, '00:00')),
        })
        .where('id', '=', toBin(deviceId))
        .execute();
    }
    venToken = await signTestAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: venP.userId, device_id: venP.deviceId, session_id: freshUuid() },
      clock.now(),
    );
  }, 240_000);

  afterAll(async () => {
    if (policyId !== undefined) await neutralizePolicy(policyId);
    await app.close();
    await closeTestDb();
  });

  it('flux du PDV sur la période : chaque catégorie, et l’identité de rapprochement du domaine', async () => {
    const flows = await counterFlows(D1, D3);
    expect(flows).toMatchObject({
      openingQty: 0,
      // T1 100 + réception sans document 20 + réception de T3 sous le transfert expédié 20, moins la
      // requalification de la réception sans document 20, + T4 9.
      receivedQty: 129,
      sentToQty: 130,
      soldQty: 15,
      soldToDeliverQty: 5,
      returnedQty: 4,
      soldNetQty: 11,
      lostQty: 4,
      inventoryLossQty: 1,
      lostPendingQty: 0,
      inventoryGainQty: 1,
      transferredOutQty: 0,
      otherInQty: 0,
      otherOutQty: 0,
      transitDiscrepancyQty: 1,
      transitLostQty: 1,
      closingQty: 115,
    });
    expect(distributionResidual(distributionFlowsOf(flows))).toBe(0);
    // Le solde de fin est le solde réel de l'emplacement.
    const balances = await listStockBalances(db, {
      locationId: counter,
      custodyMode: 'SHARED',
      productId,
    });
    expect(balances.reduce((sum, b) => sum + b.qtyOnHand, 0)).toBe(115);

    // Une période à la fois : chaque mouvement compte à sa date, l'identité tient sur chaque jour.
    const day1 = await counterFlows(D1, D1);
    expect(day1).toMatchObject({
      openingQty: 0,
      receivedQty: 120,
      soldNetQty: 11,
      closingQty: 109,
    });
    const day2 = await counterFlows(D2, D2);
    expect(day2).toMatchObject({
      openingQty: 109,
      receivedQty: 0,
      sentToQty: -30,
      lostQty: 4,
      lostPendingQty: 0,
      inventoryGainQty: 1,
      closingQty: 106,
    });
    for (const flow of [day1, day2, await counterFlows(D3, D3)]) {
      expect(distributionResidual(distributionFlowsOf(flow))).toBe(0);
    }
  });

  it('envoyé par destination, net des retours à la source, chacun à sa date (AV-199)', async () => {
    const all = await sentByDestination(db, {
      period: period(D1, D3),
      sourceLocationIds: [store],
      productIds: [productId],
    });
    expect(all).toEqual([
      {
        sourceLocationId: store,
        destinationLocationId: counter,
        productId,
        dispatchedQty: 160,
        returnedQty: 30,
        sentNetQty: 130,
      },
    ]);
    const [day2] = await sentByDestination(db, {
      period: period(D2, D2),
      destinationLocationIds: [counter],
    });
    expect(day2).toMatchObject({ dispatchedQty: 0, returnedQty: 30, sentNetQty: -30 });
    // Le magasin source : transféré = envoyé net ; identité vraie aussi.
    const [storeFlows] = await locationFlows(db, {
      locationIds: [store],
      period: period(D1, D3),
      productIds: [productId],
    });
    expect(storeFlows).toMatchObject({ openingQty: 1000, transferredOutQty: 130, closingQty: 870 });
    expect(distributionResidual(distributionFlowsOf(storeFlows!))).toBe(0);
    expect(await sentByDestination(db, { period: period(D1, D3) })).toEqual([]);
    expect(await sentByDestination(db, { period: period(D1, D3), sourceLocationIds: [] })).toEqual(
      [],
    );
  });

  it('vendu de sales = vendu net du registre ; à livrer = solde V_TO_DELIVER du site', async () => {
    const [sold] = await soldByLocation(db, {
      period: period(D1, D3),
      locationIds: [counter],
      productIds: [productId],
    });
    expect(sold).toMatchObject({
      siteId: siteP,
      locationId: counter,
      soldQty: 15,
      cancelledQty: 4,
      soldNetQty: 11,
      soldXaf: 15 * PRICE,
      cancelledXaf: 4 * PRICE,
      netXaf: 11 * PRICE,
    });
    expect(sold!.soldNetQty).toBe((await counterFlows(D1, D3)).soldNetQty);

    const [toDeliver] = await toDeliverByLocation(db, {
      siteIds: [siteP],
      productIds: [productId],
    });
    expect(toDeliver).toMatchObject({ locationId: counter, toDeliverQty: 3, openSales: 1 });
    const toDeliverLocation = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('site_id', '=', toBin(siteP))
      .where('location_type', '=', 'V_TO_DELIVER')
      .executeTakeFirstOrThrow();
    const [virtualBalance] = await listStockBalances(db, {
      locationId: fromBin(toDeliverLocation.id),
      custodyMode: null,
      productId,
    });
    expect(virtualBalance!.qtyOnHand).toBe(3);
    expect(await soldByLocation(db, { period: period(D1, D3) })).toEqual([]);
    expect(await toDeliverByLocation(db, { siteIds: [] })).toEqual([]);
  });

  it('encaissé ventilé par site, moyen et receveur : sa somme égale le total de l’accueil (BR-ANA-009)', async () => {
    const scope = { siteIds: [siteP] };
    const groups = await cashedByGroup(db, scope, period(D1, D3));
    expect(groups).toEqual([
      {
        siteId: siteP,
        paymentMethodCode: 'ESPECES',
        receivedByUserId: venP.userId,
        paymentsCount: 1,
        amountXaf: 5_000,
      },
    ]);
    const total = await cashedSummary(db, scope, period(D1, D3));
    expect(total).toEqual({ paymentsCount: 1, amountXaf: 5_000 });
    expect(await cashedByGroup(db, { siteIds: [] }, period(D1, D3))).toEqual([]);
  });

  it('position des quotas et GET /stock net des quotas (BR-STK-011)', async () => {
    const [position] = await allocationPositions(db, {
      locationIds: [counter],
      now: new Date(),
      productIds: [productId],
      holder: { userId: venP.userId, deviceId: venP.deviceId },
    });
    // Quota de 15 : 4 vendus puis rendus par l'annulation, 6 vendus : reste 9.
    expect(position).toMatchObject({
      custodyMode: 'SHARED',
      onHandQty: 115,
      allocatedQty: 9,
      activeAllocations: 1,
      unallocatedQty: 106,
      overcommitted: false,
      holderRemainingQty: 9,
      availableToHolderQty: 115,
    });
    const [other] = await allocationPositions(db, {
      locationIds: [counter],
      now: new Date(),
      productIds: [productId],
      holder: { userId: magP.userId, deviceId: magP.deviceId },
    });
    expect(other).toMatchObject({ holderRemainingQty: 0, availableToHolderQty: 106 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stock?location_id=${counter}&product_id=${productId}`,
      headers: { authorization: `Bearer ${venToken}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      balances: { qtyAvailable: number }[];
      allocations: Record<string, unknown>[];
    };
    // Le disponible des lignes reste sans consommateur désigné (qty_allocated à zéro, ADR-033 §3).
    expect(body.balances.reduce((sum, b) => sum + b.qtyAvailable, 0)).toBe(115);
    expect(body.allocations).toEqual([
      {
        productId,
        qtyOnHand: 115,
        qtyReserved: 0,
        allocatedRemaining: 9,
        activeAllocations: 1,
        expiredAllocations: 1,
        revocationPendingAllocations: 0,
        qtyUnallocated: 106,
        overcommitted: false,
        ownRemaining: 9,
        qtyAvailableToMe: 115,
      },
    ]);
  });

  it('sessions de caisse du PDV et remises en attente', async () => {
    const overview = await cashSessionsOverview(db, { accountIds: [posAcc], day: D1 });
    expect(overview.pendingValidationCount).toBe(1);
    expect(overview.pendingAdjustmentsCount).toBe(0);
    expect(overview.accounts).toHaveLength(1);
    expect(overview.accounts[0]).toMatchObject({
      cashAccountId: posAcc,
      siteId: siteP,
      openSession: null,
      sessionOfDay: {
        status: 'PENDING_VALIDATION',
        businessDate: D1,
        openedBy: venP.userId,
        openingVarianceXaf: 0,
        closingCountedXaf: 9_000,
        closingExpectedXaf: 15_000,
        varianceXaf: -6_000,
        currentVarianceXaf: -6_000,
        currentExpectedXaf: 15_000,
        forceClosed: false,
      },
    });
    expect(
      (await cashSessionsOverview(db, { accountIds: [posAcc], day: D2 })).accounts[0],
    ).toMatchObject({ openSession: null, sessionOfDay: null });

    const pending = await pendingCashTransfers(db, {
      accountIds: [posAcc],
      now: new Date(),
      unreceivedHours: 48,
    });
    expect(pending).toMatchObject({
      inTransit: { count: 1, totalXaf: 1_000, overdueCount: 1, overdueXaf: 1_000 },
      discrepancyPending: { count: 0, sentXaf: 0, receivedXaf: 0 },
      pendingCount: 1,
    });
    expect((await pendingCashTransfers(db, { accountIds: [], now: new Date() })).pendingCount).toBe(
      0,
    );
  });

  it('fraîcheur des appareils : appareils du site, dernier pull et dernier envoi, retard (BR-ANA-005)', async () => {
    const bySite = await devicesOfSites(db, [siteP]);
    expect([...(bySite.get(siteP) ?? [])].sort()).toEqual(
      [venP.deviceId, magP.deviceId, staleDevice].sort(),
    );
    // Le vendeur tire le flux sans rien envoyer : son dernier pull suffit à le dire à jour.
    const now = new Date();
    await pullService.pull(
      { dataset: 'cash', cursor: 0, limit: 1 },
      { authenticatedUserId: venP.userId, authenticatedDeviceId: venP.deviceId, now },
    );
    const report = await deviceFreshness(db, {
      deviceIds: bySite.get(siteP)!,
      now: new Date(),
      warningHours: 2,
    });
    expect(report.warningHours).toBe(2);
    const byId = new Map(report.devices.map((device) => [device.deviceId, device]));
    expect(byId.get(venP.deviceId)).toMatchObject({ stale: false, lastPushAt: null });
    expect(byId.get(venP.deviceId)!.lastPullAt!.getTime()).toBe(now.getTime());
    expect(byId.get(venP.deviceId)!.authors).toEqual([
      expect.objectContaining({ userId: venP.userId, pendingReported: null }),
    ]);
    // La tablette du magasinier a poussé sa réception (rien en attente après le lot).
    expect(byId.get(magP.deviceId)).toMatchObject({
      stale: false,
      designatedSiteId: siteP,
      pendingReported: 0,
    });
    expect(byId.get(magP.deviceId)!.authors).toEqual([
      expect.objectContaining({ userId: magP.userId, pendingReported: 0 }),
    ]);
    expect(byId.get(staleDevice)).toMatchObject({
      stale: true,
      lastPushAt: null,
      lastPullAt: null,
    });
    expect(report.staleCount).toBe(1);
    expect((await deviceFreshness(db, { deviceIds: [], now })).devices).toEqual([]);
  });

  it('pertes validées : la confirmation passe au perdu ; pertes récentes sans double compte ni libération d’une perte hors fenêtre', async () => {
    const lossPolicy = freshUuid();
    const declare = async (lossId: string, quantity: number, occurredAt: string) =>
      ok(venP, {
        type: 'inventory.loss.declare',
        aggregateType: 'STOCK_LOSS',
        aggregateId: lossId,
        occurredAt,
        payload: {
          locationId: back,
          productId,
          quantityBase: quantity,
          unitCode: 'PIECE',
          quantity,
          category: 'CASSE',
          comment: 'Casse en manutention.',
        },
      });
    const withdraw = (lossId: string) =>
      ok(venP, {
        type: 'inventory.loss.withdraw',
        aggregateType: 'STOCK_LOSS',
        aggregateId: lossId,
        occurredAt: new Date().toISOString(),
        payload: { lossId },
      });
    const requestOf = async (lossId: string) =>
      fromBin(
        (
          await db
            .selectFrom('inventory_loss_declarations')
            .select('approval_request_id')
            .where('id', '=', toBin(lossId))
            .executeTakeFirstOrThrow()
        ).approval_request_id!,
      );
    await withoutActivePolicies('LOSS_DECLARATION', new Date(), async () => {
      // Politique de validation des pertes propre au test (neutralisée à la fin).
      await ok(admin, {
        type: 'approvals.policy.set',
        aggregateType: 'CONTROL_POLICY',
        aggregateId: lossPolicy,
        occurredAt: at(D0, '04:00'),
        payload: {
          code: `LOSS_P519_${lossPolicy.slice(-8)}`,
          operationType: 'LOSS_DECLARATION',
          requiresApproval: true,
          approverPermission: 'inventory.loss.approve',
          approverScope: 'SITE',
          validFrom: at(D0, '04:00'),
          validTo: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        },
      });
      try {
        // Perte du passé (hors fenêtre), retirée maintenant : sa libération ne se retranche pas.
        const old = freshUuid();
        await declare(old, 1, at(D0, '06:00'));
        const since = new Date(Date.now() - 1_000);
        const before = await recentLosses(db, ALL_SCOPE, since);
        const approved = freshUuid();
        await declare(approved, 2, new Date().toISOString());
        const approvedRequest = await requestOf(approved);
        await ok(dir, {
          type: 'approvals.request.approve',
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: approvedRequest,
          occurredAt: new Date().toISOString(),
          payload: { requestId: approvedRequest },
        });
        const withdrawn = freshUuid();
        await declare(withdrawn, 1, new Date().toISOString());
        await withdraw(withdrawn);
        await withdraw(old);
        // Au coût de 500 : 2 approuvées + 1 retirée − 1 rendue = 2 unités, comptées une seule fois ; la
        // libération de la perte du passé n'est pas retranchée (sinon 1).
        const after = await recentLosses(db, ALL_SCOPE, since);
        expect(after.valueXaf - before.valueXaf).toBe(1_000);
        expect(await recentLosses(db, { siteIds: [siteP] }, since)).toEqual({
          animalHeads: 0,
          valueXaf: 1_000,
        });
        // Flux du jour : la confirmation fait passer 2 au perdu ; les pertes en attente du jour,
        // libérations comprises (celle de la perte du passé aussi), valent 2 + 1 − 1 − 1 − 2 = −1.
        const today = businessDayOf(new Date());
        const [flows] = await locationFlows(db, {
          locationIds: [back],
          period: period(today, today),
          productIds: [productId],
        });
        expect(flows).toMatchObject({
          openingQty: 9,
          lostQty: 2,
          lossConfirmedQty: 2,
          lostPendingQty: -1,
          closingQty: 8,
        });
        expect(distributionResidual(distributionFlowsOf(flows!))).toBe(0);
      } finally {
        await neutralizePolicy(lossPolicy);
      }
    });
  });

  it('cas limites : écart de transfert rejeté, bornes de jour métier, annulation le lendemain, déplacement interne, quotas dépassés', async () => {
    // Écart rejeté (5 expédiés, 4 reçus, 1 retrouvé) : la marchandise rendue est reçue.
    const t5 = freshUuid();
    await ok(magS, {
      type: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: t5,
      occurredAt: at(D4, '06:00'),
      payload: {
        fromLocationId: store,
        toLocationId: back2,
        lines: [{ productId, unitCode: 'PIECE', quantityBase: 5 }],
      },
    });
    const [t5Line] = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(t5))
      .execute();
    await ok(magP, {
      type: 'inventory.transfer.receive',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: t5,
      occurredAt: at(D4, '07:00'),
      payload: {
        transferId: t5,
        lines: [{ transferLineId: fromBin(t5Line!.id), receivedQtyBase: 4 }],
      },
    });
    const t5Row = await db
      .selectFrom('inventory_stock_transfers')
      .select('approval_request_id')
      .where('id', '=', toBin(t5))
      .executeTakeFirstOrThrow();
    const t5Request = fromBin(t5Row.approval_request_id!);
    await ok(dir, {
      type: 'approvals.request.reject',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: t5Request,
      occurredAt: at(D4, '08:00'),
      payload: { requestId: t5Request, comment: 'Marchandise retrouvée dans le camion.' },
    });
    // Déplacement interne à 23:00 UTC (minuit à Douala) : il tombe le lendemain.
    await move('INTERNAL_MOVE', back2, back3, 3, at(D4, '23:00'), 'TRANSFER');
    const flowsOf = async (location: string, day: string) => {
      const [flow] = await locationFlows(db, {
        locationIds: [location],
        period: period(day, day),
        productIds: [productId],
      });
      expect(distributionResidual(distributionFlowsOf(flow!))).toBe(0);
      return flow!;
    };
    expect(await flowsOf(back2, D4)).toMatchObject({
      receivedQty: 5,
      transitDiscrepancyQty: 1,
      transitLostQty: 0,
      transitReleasedQty: 1,
      otherOutQty: 0,
      closingQty: 5,
    });
    expect(await flowsOf(back2, D5)).toMatchObject({
      openingQty: 5,
      otherOutQty: 3,
      closingQty: 2,
    });

    // Vente à 23:58 à Douala, annulée à 00:01 le lendemain : vendu net négatif le lendemain, identique
    // dans sales et dans le registre.
    await move(
      'OPENING_BALANCE',
      await virtual('V_OPENING'),
      back3,
      5,
      at(D4, '05:00'),
      'INVENTORY_COUNT',
    );
    const late = freshUuid();
    await ok(venP, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: late,
      occurredAt: at(D4, '22:58'),
      payload: { fromLocationId: back3, customerId: custV, lines: [line(2)] },
    });
    await ok(venP, {
      type: 'sales.sale.cancel',
      aggregateType: 'SALE_CANCELLATION',
      aggregateId: freshUuid(),
      occurredAt: at(D4, '23:01'),
      payload: { saleId: late, comment: 'Erreur de produit' },
    });
    const day4 = await flowsOf(back3, D4);
    const day5 = await flowsOf(back3, D5);
    expect(day4).toMatchObject({ otherInQty: 5, soldQty: 2, soldNetQty: 2, closingQty: 3 });
    expect(day5).toMatchObject({ otherInQty: 3, returnedQty: 2, soldNetQty: -2, closingQty: 8 });
    for (const [day, flow] of [
      [D4, day4],
      [D5, day5],
    ] as const) {
      const [sold] = await soldByLocation(db, {
        period: period(day, day),
        locationIds: [back3],
        productIds: [productId],
      });
      expect(sold!.soldNetQty).toBe(flow.soldNetQty);
    }

    // Quotas dépassés : 8 alloués, puis une perte de 3 laisse 5 au solde.
    await ok(magP, {
      type: 'inventory.allocation.grant',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: freshUuid(),
      occurredAt: new Date().toISOString(),
      payload: {
        holderUserId: venP.userId,
        holderDeviceId: venP.deviceId,
        locationId: back3,
        productId,
        quantityBase: 8,
      },
    });
    await move('LOSS', back3, await virtual('V_LOSS'), 3, new Date().toISOString(), 'LOSS');
    const [position] = await allocationPositions(db, {
      locationIds: [back3],
      now: new Date(),
      productIds: [productId],
    });
    expect(position).toMatchObject({
      onHandQty: 5,
      allocatedQty: 8,
      unallocatedQty: 0,
      overcommitted: true,
      holderRemainingQty: 0,
      availableToHolderQty: -3,
    });
  });

  it('accueil et tableau, une seule définition : vendu net et encaissé par jour, annulation à sa date (AV-200, AV-209, ADR-041)', async () => {
    // Encaissement mobile money du jour 4, annulé le jour 5 sur décision de la Finance : il compte le
    // jour 4 et se retranche le jour 5, jamais rétroactivement.
    const momo = freshUuid();
    await ok(fin, {
      type: 'finance.cash_account.create',
      aggregateType: 'CASH_ACCOUNT',
      aggregateId: momo,
      occurredAt: at(D0, '05:40'),
      payload: {
        code: `P523-${momo.slice(-12)}`,
        name: 'Mobile money P5-23',
        accountType: 'MOBILE_MONEY',
        responsibleUserId: fin.userId,
      },
    });
    const payment = freshUuid();
    await ok(venP, {
      type: 'sales.payment.record',
      aggregateType: 'CUSTOMER_PAYMENT',
      aggregateId: payment,
      occurredAt: at(D4, '15:00'),
      payload: {
        customerId: custV,
        amountXaf: 3_000,
        methodCode: 'MOBILE_MONEY_ORANGE',
        cashAccountId: momo,
        reference: `OM ${payment.slice(-8)}`,
        siteId: siteP,
      },
    });
    await ok(venP, {
      type: 'sales.payment.request_cancellation',
      aggregateType: 'CUSTOMER_PAYMENT',
      aggregateId: payment,
      occurredAt: at(D4, '16:00'),
      payload: { comment: 'Saisi par erreur' },
    });
    const { cancel_approval_request_id: request } = await db
      .selectFrom('sales_customer_payments')
      .select('cancel_approval_request_id')
      .where('id', '=', toBin(payment))
      .executeTakeFirstOrThrow();
    const requestId = fromBin(request!);
    await ok(fin, {
      type: 'approvals.request.approve',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: requestId,
      occurredAt: at(D5, '08:00'),
      payload: { requestId },
    });

    const dirToken = await signTestAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: dir.userId, device_id: dir.deviceId, session_id: freshUuid() },
      clock.now(),
    );
    const scope = { siteIds: [siteP] };
    const activity = await salesActivityByDay(db, scope, period(D1, D5));
    // Site du PDV : D1 vend 15 et annule 4 ; la vente tardive de D4 (2) est annulée à 00:01 à Douala,
    // donc le jour 5 ; l'encaissement de D1 (5 000), celui de D4 (3 000) annulé le jour 5.
    const expected = [
      [D1, 11 * PRICE, 5_000],
      [D2, 0, 0],
      [D3, 0, 0],
      [D4, 2 * PRICE, 3_000],
      [D5, -2 * PRICE, -3_000],
    ] as const;
    for (const [day, netXaf, cashedXaf] of expected) {
      // Vendu : la somme par emplacement du site (fonction du tableau) = le jour de l'accueil.
      const sold = await soldByLocation(db, { period: period(day, day), siteIds: [siteP] });
      expect(
        sold.reduce((sum, row) => sum + row.netXaf, 0),
        day,
      ).toBe(netXaf);
      expect(sumSalesActivity(activity, day, day).netXaf, day).toBe(netXaf);
      expect((await cashedSummary(db, scope, period(day, day))).amountXaf, day).toBe(cashedXaf);

      // Accueil du vendeur du PDV ce jour-là (périmètre : son site).
      const home = await buildHome({
        executor: db,
        userId: venP.userId,
        clock: new FixedClock(new Date(`${day}T12:00:00.000Z`)),
      });
      const kpis = home.sections.find((section) => section.role === 'VENDEUR_PDV')!.kpis;
      const kpi = (code: string) => kpis.find((entry) => entry.code === code);
      expect(kpi('KPI-COM-08')?.value, day).toBe(netXaf);
      expect(kpi('KPI-FIN-01')?.value, day).toBe(cashedXaf);

      // Tableau du même jour : vendu de l'emplacement de vente, encaissé du site (tous moyens).
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/dashboards/distribution?from=${day}&to=${day}&site_id=${siteP}`,
        headers: { authorization: `Bearer ${dirToken}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      const [pos] = distributionDashboardResponseSchema.parse(response.json()).pointsOfSale;
      const [counterSold] = await soldByLocation(db, {
        period: period(day, day),
        locationIds: [counter],
      });
      expect(pos!.sales.netXaf, day).toBe(counterSold?.netXaf ?? 0);
      expect(pos!.cashed.amountXaf, day).toBe(cashedXaf);
    }

    // Le jour 1, tout est vendu à l'emplacement de vente : accueil et tableau identiques ; panier moyen
    // sur les deux ventes non annulées.
    const day1 = await buildHome({
      executor: db,
      userId: venP.userId,
      clock: new FixedClock(new Date(`${D1}T12:00:00.000Z`)),
    });
    const day1Kpis = day1.sections.find((section) => section.role === 'VENDEUR_PDV')!.kpis;
    expect(day1Kpis.find((entry) => entry.code === 'KPI-COM-08')).toMatchObject({
      value: 11 * PRICE,
      detail: '2 ventes',
      tone: 'good',
    });
    expect(day1Kpis.find((entry) => entry.code === 'KPI-COM-10')?.value).toBe(5_500);

    // Le jour 5 : chiffre et encaissé négatifs, signalés ; pas de panier moyen ; la semaine (lundi D0
    // au samedi D5) et la courbe portent chaque jour à sa date.
    const day5 = await buildHome({
      executor: db,
      userId: venP.userId,
      clock: new FixedClock(new Date(`${D5}T12:00:00.000Z`)),
    });
    const day5Kpis = day5.sections.find((section) => section.role === 'VENDEUR_PDV')!.kpis;
    const turnover = day5Kpis.find((entry) => entry.code === 'KPI-COM-08')!;
    expect(turnover).toMatchObject({ value: -2 * PRICE, detail: '0 vente', tone: 'warn' });
    expect(turnover.series?.map((point) => point.value)).toEqual([
      0,
      0,
      11 * PRICE,
      0,
      0,
      2 * PRICE,
      -2 * PRICE,
    ]);
    expect(day5Kpis.find((entry) => entry.code === 'KPI-COM-08-S')?.value).toBe(11 * PRICE);
    expect(day5Kpis.find((entry) => entry.code === 'KPI-COM-10')).toBeUndefined();
    expect(day5Kpis.find((entry) => entry.code === 'KPI-FIN-01')).toMatchObject({
      value: -3_000,
      tone: 'warn',
    });
  });

  describe('AT-042 : GET /api/v1/analytics/dashboards/distribution', () => {
    const tokenOf = (actor: Actor) =>
      signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
    const dashboard = async (actor: Actor, query: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/dashboards/distribution?${query}`,
        headers: { authorization: `Bearer ${await tokenOf(actor)}` },
      });
      return response;
    };
    const okDashboard = async (actor: Actor, query: string) => {
      const response = await dashboard(actor, query);
      expect(response.statusCode, response.body).toBe(200);
      return distributionDashboardResponseSchema.parse(response.json());
    };

    beforeAll(async () => {
      // Session ouverte aujourd'hui à la caisse du PDV : détail de caisse visible ou masqué.
      await ok(venP, {
        type: 'finance.cash_session.open',
        aggregateType: 'CASH_SESSION',
        aggregateId: freshUuid(),
        occurredAt: new Date().toISOString(),
        payload: { cashAccountId: posAcc, countedXaf: 8_000 },
      });
    });

    it('envoyé, reçu, vendu, perdu, restant, encaissé du PDV : les mêmes valeurs que les fonctions des modules (BR-ANA-009)', async () => {
      const body = await okDashboard(dir, `from=${D1}&to=${D3}&site_id=${siteP}`);
      expect(body.period).toEqual({ code: 'CUSTOM', fromDay: D1, toDay: D3 });
      expect(body.scope).toEqual({ allSites: false, pointsOfSaleCount: 1 });
      const [pos] = body.pointsOfSale;
      expect(pos).toMatchObject({ siteId: siteP, salesLocationId: counter, custodyMode: 'SHARED' });
      const row = pos!.products.find((line) => line.productId === productId)!;
      const [flow] = await locationFlows(db, {
        locationIds: [counter],
        period: period(D1, D3),
        productIds: [productId],
      });
      const kpis = distributionKpisOf(flow!);
      expect(row).toMatchObject({
        stocked: true,
        sentQty: 130,
        receivedQty: 129,
        soldNetQty: 11,
        soldNetXaf: 11 * PRICE,
        lostQty: 5,
        lostPendingQty: 0,
        transitPendingQty: 0,
        openingQty: 0,
        remainingQty: 115,
        toDeliverQty: 3,
        allocatedQty: 9,
        unallocatedQty: 106,
        overcommitted: false,
        replenish: null,
        remainingValueXaf: kpis.remainingValueXaf,
        lostValueXaf: kpis.lostValueXaf,
        reconciliation: { residualQty: 0, reconciled: true, salesMatchLedger: true },
      });
      expect(row.lostQty).toBe(kpis.lostQty);
      expect(row.sentQty).toBe(kpis.sentQty);
      expect(pos!.sales).toEqual({
        soldXaf: 15 * PRICE,
        cancelledXaf: 4 * PRICE,
        netXaf: 11 * PRICE,
      });
      expect(pos!.cashed).toMatchObject({
        amountXaf: 5_000,
        paymentsCount: 1,
        byMethod: [{ paymentMethodCode: 'ESPECES', amountXaf: 5_000, paymentsCount: 1 }],
      });
      expect(pos!.cashed.amountXaf).toBe(
        (await cashedSummary(db, { siteIds: [siteP] }, period(D1, D3))).amountXaf,
      );
      expect(pos!.cash).toMatchObject({
        accountsCount: 1,
        pendingValidationCount: 1,
        transfers: { inTransitCount: 1, inTransitXaf: 1_000, overdueCount: 1, discrepancyCount: 0 },
      });
      expect(pos!.cash.openSession).toMatchObject({ status: 'OPEN', severity: expect.any(String) });
      expect(pos!.devices).toMatchObject({ count: 3, staleCount: 1 });
      expect(pos!.reconciled).toBe(true);
      expect(body.freshness).toMatchObject({ devicesCount: 3, staleDevices: 1 });
      expect(body.totals).toMatchObject({
        soldNetXaf: 11 * PRICE,
        cashedXaf: 5_000,
        paymentsCount: 1,
      });
      // Jour par jour : l'identité tient chaque jour ; le retour à la source compte à sa date.
      for (const [day, sent] of [
        [D1, 150],
        [D2, -30],
        [D3, 10],
      ] as const) {
        const daily = await okDashboard(dir, `from=${day}&to=${day}&site_id=${siteP}`);
        const line = daily.pointsOfSale[0]!.products.find((p) => p.productId === productId)!;
        expect(line.sentQty, day).toBe(sent);
        expect(line.reconciliation?.reconciled, day).toBe(true);
      }
    });

    it('AT-054 : l’instantané distribution du vendeur égale les totaux du tableau de distribution (TB-4, AV-467)', async () => {
      // Jour de calcul dans la période des fixtures (septembre 2026) : les ventes et encaissements ne sont pas nuls.
      const snapshotAt = new Date('2026-09-17T12:00:00.000Z');
      await db.transaction().execute((trx) => refreshSnapshotsOf(trx, venP.userId, snapshotAt));
      const rows = (await listSnapshotsOf(db, venP.userId)).filter(
        (snapshot) => snapshot.scopeKey === 'distribution',
      );
      expect(rows.map((snapshot) => snapshot.periodKey).sort()).toEqual(['MONTH', 'TODAY', 'WEEK']);
      const month = rows.find((snapshot) => snapshot.periodKey === 'MONTH')!;
      const indicators = month.kpis as { code: string; value: number | null }[];
      // Les quatre indicateurs d'origine plus KPI-OPS-02 (AV-480) ; le vendeur n'a pas `sync.conflict.resolve` : pas
      // de compteur de conflits.
      expect(indicators.map((kpi) => kpi.code).sort()).toEqual(
        ['KPI-DIS-03', 'KPI-DIS-05', 'KPI-DIS-06', 'KPI-FIN-CS-PENDING', 'KPI-OPS-02'].sort(),
      );
      const valueOf = (code: string) => indicators.find((kpi) => kpi.code === code)?.value;
      const window = resolveAnalyticsPeriod({ code: 'MONTH', today: businessDayOf(snapshotAt) });
      const live = await okDashboard(venP, `from=${window.fromDay}&to=${window.toDay}`);
      expect(valueOf('KPI-DIS-03')).toBe(live.totals.soldNetXaf);
      expect(valueOf('KPI-DIS-06')).toBe(live.totals.cashedXaf);
      expect(valueOf('KPI-FIN-CS-PENDING')).toBe(live.totals.cashSessionsToValidate);
      // Le vendeur n'a pas `inventory.valuation.read` : la valeur du restant est masquée des deux côtés.
      expect(live.totals.remainingValueXaf).toBeNull();
      expect(valueOf('KPI-DIS-05')).toBeNull();
      // KPI-OPS-02 : les opérations en attente des appareils des points de vente du vendeur (AV-479).
      const posDevices = [...(await devicesOfSites(db, [siteP])).values()].flat();
      const backlog = await syncBacklog(db, {
        devices: { deviceIds: [...new Set(posDevices)] },
        conflicts: false,
      });
      expect(valueOf('KPI-OPS-02')).toBe(backlog.pendingOperations);
    });

    it('masque par droit : valeurs, détail de caisse, receveurs, auteurs (AV-205, AV-206)', async () => {
      const query = `from=${D1}&to=${D3}&site_id=${siteP}`;
      const view = async (actor: Actor) => {
        const pos = (await okDashboard(actor, query)).pointsOfSale[0]!;
        const row = pos.products.find((line) => line.productId === productId)!;
        return {
          value: row.remainingValueXaf !== null,
          cashDetail: pos.cash.openSession?.detail !== null,
          receivers: pos.cashed.byReceiver !== null,
          authors: pos.devices.items.every((device) => device.authors !== null),
        };
      };
      expect(await view(dir)).toEqual({
        value: true,
        cashDetail: true,
        receivers: true,
        authors: true,
      });
      expect(await view(fin)).toEqual({
        value: true,
        cashDetail: true,
        receivers: true,
        authors: false,
      });
      expect(await view(venP)).toEqual({
        value: false,
        cashDetail: true,
        receivers: true,
        authors: false,
      });
      expect(await view(magP)).toEqual({
        value: false,
        cashDetail: false,
        receivers: false,
        authors: true,
      });
      const masked = await okDashboard(magP, query);
      expect(masked.totals.remainingValueXaf).toBeNull();
      expect(masked.totals.lostValueXaf).toBeNull();
    });

    it('refus et périmètre : 403 sans le droit, 404 hors portée, vide sans PDV', async () => {
      for (const actor of [admin, comS]) {
        expect((await dashboard(actor, `site_id=${siteP}`)).statusCode).toBe(403);
      }
      expect((await dashboard(magS, `site_id=${siteP}`)).statusCode).toBe(404);
      const denied = await db
        .selectFrom('audit_audit_log')
        .select('error_code')
        .where('actor_user_id', '=', toBin(magS.userId))
        .where('action', '=', 'access.denied')
        .execute();
      expect(denied.map((row) => row.error_code)).toContain('NOT_FOUND');
      const empty = await okDashboard(magS, `from=${D1}&to=${D3}`);
      expect(empty.pointsOfSale).toEqual([]);
      expect(empty.totals).toMatchObject({
        soldNetXaf: 0,
        cashedXaf: 0,
        cashSessionsToValidate: 0,
      });
      expect(empty.freshness.devicesCount).toBe(0);
    });

    it('paramètres : période nommée, dates exclusives et appariées, bornes, dates inexistantes', async () => {
      const today = businessDayOf(new Date());
      const week = await okDashboard(dir, `period=WEEK&site_id=${siteP}`);
      expect(week.period.code).toBe('WEEK');
      expect(week.period.fromDay <= today && today <= week.period.toDay).toBe(true);
      expect(new Date(`${week.period.fromDay}T12:00:00Z`).getUTCDay()).toBe(1);
      expect((await okDashboard(dir, `site_id=${siteP}`)).period).toEqual({
        code: 'TODAY',
        fromDay: today,
        toDay: today,
      });
      for (const query of [
        `period=TODAY&from=${D1}&to=${D1}`,
        `from=${D1}`,
        `from=${D3}&to=${D1}`,
        'from=2025-01-01&to=2026-12-31',
        'from=2026-02-30&to=2026-03-01',
        'period=QUARTER',
      ]) {
        expect((await dashboard(dir, `${query}&site_id=${siteP}`)).statusCode, query).toBe(400);
      }
    });

    it('portée d’une zone : un responsable commercial voit les PDV de sa zone et de ses sous-zones (AV-204)', async () => {
      // Zone Z et sous-zone Z1 : PDV A dans Z, B dans Z1 ; PDV C ailleurs.
      const sites = await tx(async (trx) => {
        const zone = await insertTestZone(trx, root);
        const sub = await insertTestZone(trx, root, { parentId: zone });
        const elsewhere = await insertTestZone(trx, root);
        const a = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
        const b = await insertTestSite(trx, root, sub, { siteType: 'POINT_DE_VENTE' });
        const c = await insertTestSite(trx, root, elsewhere, { siteType: 'POINT_DE_VENTE' });
        const locations = [];
        for (const site of [a, b, c]) {
          locations.push(await insertTestLocation(trx, root, site, { locationType: 'POS' }));
        }
        return { zone, a, b, c, locations };
      });
      for (const [index, site] of [sites.a, sites.b, sites.c].entries()) {
        await ok(admin, {
          type: 'organization.pos.configure',
          aggregateType: 'SITE',
          aggregateId: site,
          occurredAt: new Date().toISOString(),
          payload: { salesLocationId: sites.locations[index], custodyMode: 'SHARED' },
        });
      }
      const manager = await newActor('RESP_COMMERCIAL', root, {
        scopeType: 'ZONE',
        scopeZoneId: sites.zone,
      });
      const teamManager = await tx(async (trx) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        const team = await insertTestTeam(trx, userId, root);
        await assignTestRole(trx, userId, await roleIdOf('RESP_COMMERCIAL'), root, {
          scopeType: 'TEAM',
          scopeTeamId: team,
        });
        return { userId, deviceId };
      });
      const seller = await newActor('VENDEUR_PDV', root, {
        scopeType: 'SITE',
        scopeSiteId: sites.a,
      });
      const ours = new Set([sites.a, sites.b, sites.c]);
      const seen = async (actor: Actor) =>
        (await okDashboard(actor, '')).pointsOfSale
          .map((pos) => pos.siteId)
          .filter((id) => ours.has(id))
          .sort();
      expect(await seen(manager)).toEqual([sites.a, sites.b].sort());
      expect(await seen(seller)).toEqual([sites.a]);
      expect(await seen(dir)).toEqual([sites.a, sites.b, sites.c].sort());
      // Affectation d'équipe : un PDV n'a pas de titulaire, la portée TEAM n'en atteint aucun.
      expect((await okDashboard(teamManager, '')).pointsOfSale).toEqual([]);
      expect((await dashboard(manager, `site_id=${sites.c}`)).statusCode).toBe(404);
    });
  });

  describe('accueil Finance et Magasinier (P5-20, AV-208)', () => {
    const home = async (actor: Actor): Promise<HomeResponse> => {
      const token = await signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/home',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return homeResponseSchema.parse(response.json());
    };
    const kpisOf = (body: HomeResponse, role: string) =>
      body.sections.find((section) => section.role === role)!.kpis;
    const kpiOf = (body: HomeResponse, role: string, code: string) =>
      kpisOf(body, role).find((kpi) => kpi.code === code);
    const signalOf = (body: HomeResponse, code: string) =>
      body.signals.find((signal) => signal.code === code);
    const DISTRIBUTION_KPIS = ['KPI-DIS-07', 'KPI-DIS-QUOTAS', 'KPI-OPS-01'];

    it('magasinier du PDV : réapprovisionnement, quotas à régulariser, appareils et anomalies de son seul site', async () => {
      // Seuil franchi sur l'emplacement de vente ; quota d'un second vendeur, échu depuis D3.
      await ok(magP, {
        type: 'inventory.threshold.set',
        aggregateType: 'STOCK_THRESHOLD',
        aggregateId: freshUuid(),
        occurredAt: new Date().toISOString(),
        payload: { locationId: counter, productId, minQtyBase: 1_000, targetQtyBase: 3_000 },
      });
      const seller = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteP });
      const expiring = freshUuid();
      await ok(magP, {
        type: 'inventory.allocation.grant',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: expiring,
        occurredAt: at(D3, '10:00'),
        payload: {
          holderUserId: seller.userId,
          holderDeviceId: seller.deviceId,
          locationId: counter,
          productId,
          quantityBase: 1,
          validUntil: at(D3, '11:00'),
        },
      });
      // Échu **et** en révocation (effet du consommateur de révocation sur un appareil bloqué) : un
      // seul quota à régulariser, jamais deux.
      await db
        .updateTable('inventory_stock_allocations')
        .set({ revocation_pending: 1 })
        .where('id', '=', toBin(expiring))
        .execute();
      // Anomalie ouverte d'un autre site : hors de la vue du magasinier du PDV.
      await tx((trx) =>
        recordConflict(trx, {
          id: freshUuid(),
          commandId: null,
          conflictType: 'TRANSFER_UNMATCHED',
          entityType: 'STOCK_TRANSFER',
          entityId: freshUuid(),
          siteId: siteS,
          ownerRole: 'MAGASINIER',
          applied: true,
          details: {},
        }),
      );

      const body = await home(magP);
      const now = new Date();
      expect(kpisOf(body, 'MAGASINIER').filter((kpi) => kpi.code.startsWith('KPI-FIN'))).toEqual(
        [],
      );
      expect(kpiOf(body, 'MAGASINIER', 'KPI-DIS-07')).toMatchObject({
        value: 1,
        unit: 'COUNT',
        detail: 'sur 1 seuil suivi des PDV',
        tone: 'warn',
      });
      // Mêmes fonctions que le tableau (BR-ANA-009) ; l'union ne compte le quota qu'une fois.
      const positions = await allocationPositions(db, { locationIds: [counter], now });
      const sum = (pick: (position: (typeof positions)[number]) => number) =>
        positions.reduce((total, position) => total + pick(position), 0);
      const toSettle = sum((position) => position.toSettleAllocations);
      expect(toSettle).toBeGreaterThanOrEqual(1);
      expect(
        sum((position) => position.expiredAllocations + position.revocationPendingAllocations),
      ).toBe(toSettle + 1);
      expect(kpiOf(body, 'MAGASINIER', 'KPI-DIS-QUOTAS')?.value).toBe(toSettle);
      const bySite = await devicesOfSites(db, [siteP]);
      const report = await deviceFreshness(db, {
        deviceIds: [...new Set([...bySite.values()].flat())],
        now,
      });
      expect(report.staleCount).toBeGreaterThanOrEqual(1);
      expect(kpiOf(body, 'MAGASINIER', 'KPI-OPS-01')?.value).toBe(report.staleCount);
      expect(signalOf(body, 'DEVICES_STALE')).toMatchObject({
        severity: 'WARNING',
        count: report.staleCount,
      });
      // Anomalies : celles du site du PDV seulement.
      const mine = await openConflictSummary(db, { ownerRoles: ['MAGASINIER'], siteIds: [siteP] });
      const all = await openConflictSummary(db, { ownerRoles: ['MAGASINIER'] });
      expect(all.total).toBeGreaterThan(mine.total);
      expect(signalOf(body, 'SYNC_CONFLICTS')?.count ?? 0).toBe(mine.total);

      // Magasinier d'un site sans PDV : aucun bloc de distribution ; l'anomalie de son site.
      const store = await home(magS);
      const storeCodes = kpisOf(store, 'MAGASINIER').map((kpi) => kpi.code);
      for (const code of DISTRIBUTION_KPIS) expect(storeCodes).not.toContain(code);
      expect(signalOf(store, 'SYNC_CONFLICTS')?.count).toBeGreaterThanOrEqual(1);
    });

    it('Finance : sessions à valider, écart critique du jour, remise non reçue, appareils (base partagée : minorants)', async () => {
      // Seuil de session ouverte mal saisi sur le site du PDV (0) : le défaut reprend, rien n'échoue.
      await ok(admin, {
        type: 'organization.setting.set',
        aggregateType: 'SETTING',
        aggregateId: freshUuid(),
        occurredAt: new Date().toISOString(),
        payload: {
          key: 'finance.cash_session_force_close_hours',
          value: 0,
          scopeType: 'SITE',
          scopeId: siteP,
          reason: 'Saisie absurde (test P5-20)',
        },
      });
      expect(
        (await cashSessionThresholdsAt(db, { siteIds: [siteP], at: new Date() })).get(siteP),
      ).toMatchObject({ forceCloseHours: 24 });
      await home(fin);
      const token = await signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: dir.userId, device_id: dir.deviceId, session_id: freshUuid() },
        clock.now(),
      );
      const board = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/dashboards/distribution?site_id=${siteP}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(board.statusCode, board.body).toBe(200);
      expect(
        distributionDashboardResponseSchema.parse(board.json()).pointsOfSale[0]!.cash.openSession,
      ).toMatchObject({ status: 'OPEN', openLong: false });

      // La session ouverte aujourd'hui est close avec un excédent bien au-delà du seuil critique.
      const open = await db
        .selectFrom('finance_cash_sessions')
        .select('id')
        .where('cash_account_id', '=', toBin(posAcc))
        .where('status', '=', 'OPEN')
        .executeTakeFirstOrThrow();
      await ok(venP, {
        type: 'finance.cash_session.close',
        aggregateType: 'CASH_SESSION',
        aggregateId: fromBin(open.id),
        occurredAt: new Date().toISOString(),
        payload: { countedXaf: 108_000 },
      });
      const [account] = (
        await cashSessionsOverview(db, { accountIds: [posAcc], day: businessDayOf(new Date()) })
      ).accounts;
      expect(account!.sessionsOfDay.map((session) => session.id)).toContain(fromBin(open.id));
      const body = await home(fin);
      const pending = kpiOf(body, 'FINANCE', 'KPI-FIN-CS-PENDING');
      // Session du jour 1 et session du jour, toutes deux à valider.
      expect(pending?.value).toBeGreaterThanOrEqual(2);
      expect(pending?.tone).toBe('warn');
      const variance = kpiOf(body, 'FINANCE', 'KPI-FIN-CS-VAR');
      expect(variance?.value).toBeGreaterThanOrEqual(1);
      expect(variance?.detail).toMatch(/^manquant .+ · excédent .+$/);
      expect(signalOf(body, 'CASH_VARIANCE')).toMatchObject({ severity: 'CRITICAL' });
      expect(signalOf(body, 'CASH_VARIANCE')?.count).toBeGreaterThanOrEqual(1);
      // La remise du jour 2, jamais reçue.
      expect(kpiOf(body, 'FINANCE', 'KPI-FIN-TRANSFERS')?.value).toBeGreaterThanOrEqual(1);
      expect(signalOf(body, 'CASH_TRANSFER_NOT_RECEIVED')?.count).toBeGreaterThanOrEqual(1);
      expect(kpiOf(body, 'FINANCE', 'KPI-OPS-01')?.unit).toBe('COUNT');
      // Pas de signal « sessions à valider » en doublon des validations (AV-208).
      expect(body.signals.map((signal) => signal.code)).not.toContain('CASH_SESSIONS_PENDING');
    });
  });
});
