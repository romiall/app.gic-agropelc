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
import { businessDayOf, distributionResidual, type Clock, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { deviceFreshness, devicesOfSites } from '../src/sync/device-freshness.js';
import {
  allocationPositions,
  distributionFlowsOf,
  listStockBalances,
  locationFlows,
  recentLosses,
  recordStockMove,
  sentByDestination,
} from '../src/modules/inventory/application/public/index.js';
import {
  cashedByGroup,
  cashedSummary,
  soldByLocation,
  toDeliverByLocation,
} from '../src/modules/sales/application/public/index.js';
import {
  cashSessionsOverview,
  pendingCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  withoutActivePolicies,
  freshPhone,
} from './helpers.js';
import { fund, newActor, tx, type Actor } from './cash-transfer-fixtures.js';
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
    venToken = await signAccessToken(
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
});
