/**
 * P5-17 — lectures HTTP de P5 et traitement des conflits, de bout en bout : NestJS + Fastify,
 * `app.inject()`, données écrites par les vraies commandes (registre complet de l'application), rôles
 * réels du seed.
 *
 * Démontre : `GET /sites`, `/locations`, `/points-of-sale` (`org.structure.read`, portée du site) ;
 * `GET /cash-sessions(/{id})` et `/cash-transfers(/{id})` (`finance.cash.read`, portée du compte ; fiche
 * de session avec ajustement de réévaluation et flux de la fenêtre ; fiche de remise avec mouvements ;
 * filtres combinés, périodes, dates inexistantes) ; `GET /allocations(/{id})` (`inventory.stock.read`
 * ancré sur l'emplacement, restes actifs, « mes quotas » et fiche du détenteur, filtres, registre) ;
 * `GET /sync/conflicts(/{id})` (`sync.conflict.resolve` ; rôle propriétaire et portée de son affectation,
 * AV-191 ; Direction et Admin ; magasinier d'un autre site) ; `sync.conflict.resolve` / `.dismiss`
 * (AV-190 : clôture administrative, quarantaine jamais rejouée, références de `COMPENSATE`, clôture
 * propre à une décision, anomalie de stock persistante, auto-clôture d'un signal refusée (AV-192), en
 * ligne seulement, déjà clos, événement et relecture) ; refus 401, 403, 404 audités. Chaque assertion
 * porte sur les identifiants du fichier (base partagée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock, IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import { recordConflict } from '../src/platform/sync/conflicts.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';
import {
  codeOf,
  fund,
  newAccount,
  newActor,
  roleIdOf,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-08';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
let deviceSeq = 0;

describe('P5-17 : lectures HTTP de P5 et file des conflits', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  const tokens = new Map<string, string>();
  let root: string;
  let admin: Actor;
  let fin: Actor;
  let venA: Actor;
  let venB: Actor;
  let magA: Actor;
  let magB: Actor;
  /** Resp. achats (portée ALL) et magasinier du site B : deux rôles cumulés. */
  let multi: Actor;
  let siteA: string;
  let siteB: string;
  let counterA: string;
  let counterB: string;
  let posA: string;
  let posB: string;
  let central: string;
  let productId: string;
  let sessionA: string;
  let sessionB: string;
  let transferA: string;
  let transferB: string;
  let transferLate: string;
  let transferFlow: string;
  let transferNegative: string;
  let transferFinance: string;
  let allocationId: string;
  let releasedId: string;
  let cashNegativeConflict: string;
  let financeSelfConflict: string;
  let reevaluatedConflict: string;
  let quarantineConflict: string;

  const get = (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get(actor.userId)!}` },
    });

  /** Commande par le pipeline de l'application (registre complet), en ligne ou hors ligne. */
  const send = (
    actor: Actor,
    command: {
      readonly type: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly occurredAt: string;
      readonly payload: unknown;
      readonly offline?: boolean;
      readonly baseVersion?: number;
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
        base_version: command.baseVersion ?? null,
        depends_on: [],
        occurred_at: command.occurredAt,
        client_created_at: command.occurredAt,
        captured_offline: command.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload: command.payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: command.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  const ok = async (...args: Parameters<typeof send>) => {
    const result = await send(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };
  const sendTransfer = (
    actor: Actor,
    id: string,
    hhmm: string,
    payload: { fromAccountId: string; toAccountId: string; amountXaf: number },
    offline = false,
  ) =>
    ok(actor, {
      type: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at(hhmm),
      payload,
      offline,
    });
  const receiveTransfer = (
    actor: Actor,
    id: string,
    hhmm: string,
    amount: number,
    offline = false,
  ) =>
    ok(actor, {
      type: 'finance.cash_transfer.receive',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at(hhmm),
      payload: { receivedXaf: amount },
      offline,
    });
  const ids = (items: readonly { readonly id: string }[]) => items.map((item) => item.id);
  const deniedAudit = (actor: Actor, entityId: string) =>
    db
      .selectFrom('audit_audit_log')
      .select(['action', 'result', 'error_code'])
      .where('actor_user_id', '=', toBin(actor.userId))
      .where('entity_id', '=', toBin(entityId))
      .where('action', '=', 'access.denied')
      .execute();
  const conflictIdOf = async (entityId: string, conflictType: string, transferId?: string) =>
    fromBin(
      (
        await db
          .selectFrom('sync_sync_conflicts')
          .select('id')
          .where('entity_id', '=', toBin(entityId))
          .where('conflict_type', '=', conflictType)
          .$if(transferId !== undefined, (qb) =>
            qb.where((eb) =>
              eb(
                eb.fn('JSON_UNQUOTE', [eb.fn('JSON_EXTRACT', ['details', eb.val('$.transferId')])]),
                '=',
                transferId!,
              ),
            ),
          )
          .executeTakeFirstOrThrow()
      ).id,
    );
  const conflictRow = (id: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['status', 'resolution', 'resolution_refs', 'resolved_by', 'resolution_comment'])
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    root = await tx((trx) => insertTestUser(trx));
    await tx(async (trx) => {
      const zoneId = await insertTestZone(trx, root);
      siteA = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      siteB = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      counterA = await insertTestLocation(trx, root, siteA, { locationType: 'POS' });
      counterB = await insertTestLocation(trx, root, siteB, { locationType: 'POS' });
      productId = await insertTestProduct(trx, root);
    });
    admin = await newActor('ADMIN', root);
    fin = await newActor('FINANCE', root);
    venA = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    venB = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteB });
    magA = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteA });
    magB = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteB });
    multi = await newActor('RESP_ACHATS', root);
    const storekeeperRole = await roleIdOf('MAGASINIER');
    await tx((trx) =>
      assignTestRole(trx, multi.userId, storekeeperRole, root, {
        scopeType: 'SITE',
        scopeSiteId: siteB,
      }),
    );
    for (const actor of [admin, fin, venA, venB, magA, magB, multi]) {
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
    posA = await newAccount({ type: 'CAISSE_PDV', responsible: venA.userId, siteId: siteA });
    posB = await newAccount({ type: 'CAISSE_PDV', responsible: venB.userId, siteId: siteB });
    central = await newAccount({ type: 'CAISSE_CENTRALE', responsible: fin.userId });
    await fund(idGenerator, central, 100_000, at('06:00'), root);
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await tx((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: 50,
          fromLocationId: fromBin(opening.id),
          toLocationId: counterA,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 300,
          occurredAt: new Date(at('05:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: root,
          allowNegative: false,
        },
      ),
    );

    // Points de vente (mode partagé), par la vraie commande d'administration.
    for (const [siteId, salesLocationId] of [
      [siteA, counterA],
      [siteB, counterB],
    ] as const) {
      await ok(admin, {
        type: 'organization.pos.configure',
        aggregateType: 'SITE',
        aggregateId: siteId,
        occurredAt: at('05:30'),
        payload: { salesLocationId, custodyMode: 'SHARED' },
      });
    }
    // Remises du matin : fonds de 20 000 reçu au PDV A ; 10 000 vers B, en transit ; 5 000 vers A,
    // reçus hors ligne plus tard ; 3 000 vers B, reçus dans la session de B.
    transferA = freshUuid();
    transferB = freshUuid();
    transferLate = freshUuid();
    transferFlow = freshUuid();
    await sendTransfer(fin, transferA, '06:30', {
      fromAccountId: central,
      toAccountId: posA,
      amountXaf: 20_000,
    });
    await sendTransfer(fin, transferB, '06:40', {
      fromAccountId: central,
      toAccountId: posB,
      amountXaf: 10_000,
    });
    await sendTransfer(fin, transferFlow, '06:45', {
      fromAccountId: central,
      toAccountId: posB,
      amountXaf: 3_000,
    });
    await sendTransfer(fin, transferLate, '06:50', {
      fromAccountId: central,
      toAccountId: posA,
      amountXaf: 5_000,
    });
    await receiveTransfer(venA, transferA, '07:00', 20_000);
    // Sessions : A ouverte puis close sans écart (validée d'office) ; B ouverte, la remise de 3 000 y entre.
    sessionA = freshUuid();
    await ok(venA, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionA,
      occurredAt: at('08:00'),
      payload: { cashAccountId: posA, countedXaf: 20_000 },
    });
    await ok(venA, {
      type: 'finance.cash_session.close',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionA,
      occurredAt: at('18:00'),
      payload: { countedXaf: 20_000 },
    });
    sessionB = freshUuid();
    await ok(venB, {
      type: 'finance.cash_session.open',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionB,
      occurredAt: at('08:00'),
      payload: { cashAccountId: posB, countedXaf: 0 },
    });
    await receiveTransfer(venB, transferFlow, '10:00', 3_000);
    // Réception hors ligne de 12:00, synchronisée après la clôture de A : réévaluation (P5-13).
    await receiveTransfer(venA, transferLate, '12:00', 5_000, true);
    reevaluatedConflict = await conflictIdOf(sessionA, 'CASH_SESSION_REEVALUATED');
    // Quotas : 5 au vendeur A ; 2 au vendeur B (d'un autre site), révoqué ensuite.
    allocationId = freshUuid();
    releasedId = freshUuid();
    for (const [id, holder, quantityBase, hhmm] of [
      [allocationId, venA, 5, '09:00'],
      [releasedId, venB, 2, '09:05'],
    ] as const) {
      await ok(magA, {
        type: 'inventory.allocation.grant',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: id,
        occurredAt: at(hhmm),
        payload: {
          holderUserId: holder.userId,
          holderDeviceId: holder.deviceId,
          locationId: counterA,
          productId,
          quantityBase,
        },
      });
    }
    // Le quota du vendeur B (hors de son site) est révoqué par le magasinier A : il n'est plus actif.
    await ok(magA, {
      type: 'inventory.allocation.revoke',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: releasedId,
      occurredAt: at('09:10'),
      payload: { reason: 'Quota d’essai retiré.' },
    });
    // Conflits de la Finance : remises envoyées hors ligne qui rendent une caisse négative — celle du
    // PDV A (par le vendeur A) et la caisse centrale (par la Finance elle-même).
    transferNegative = freshUuid();
    await sendTransfer(
      venA,
      transferNegative,
      '19:00',
      { fromAccountId: posA, toAccountId: central, amountXaf: 50_000 },
      true,
    );
    cashNegativeConflict = await conflictIdOf(posA, 'CASH_NEGATIVE', transferNegative);
    transferFinance = freshUuid();
    await sendTransfer(
      fin,
      transferFinance,
      '20:00',
      { fromAccountId: central, toAccountId: posB, amountXaf: 100_000 },
      true,
    );
    financeSelfConflict = await conflictIdOf(central, 'CASH_NEGATIVE', transferFinance);
    // Quarantaine du magasinier : augmentation du quota sur une version périmée.
    const stale = await send(magA, {
      type: 'inventory.allocation.increase',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: allocationId,
      occurredAt: at('09:30'),
      payload: { quantityBase: 1 },
      baseVersion: 99,
    });
    expect(stale.status, JSON.stringify(stale)).toBe('CONFLICT');
    quarantineConflict = await conflictIdOf(allocationId, 'VERSION_CONFLICT');
    // Une vingtaine de commandes de préparation : délai relevé pour un poste chargé.
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('sans jeton : 401 sur chaque lecture de P5', async () => {
    for (const url of [
      '/api/v1/sites',
      `/api/v1/locations?site_id=${siteA}`,
      '/api/v1/points-of-sale',
      '/api/v1/cash-sessions',
      `/api/v1/cash-sessions/${sessionA}`,
      '/api/v1/cash-transfers',
      `/api/v1/cash-transfers/${transferA}`,
      '/api/v1/allocations',
      `/api/v1/allocations/${allocationId}`,
      '/api/v1/sync/conflicts',
      `/api/v1/sync/conflicts/${cashNegativeConflict}`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('structure : sites et PDV filtrés par la portée du site ; emplacements d’un site, hors portée ⇒ 404 audité', async () => {
    const vendorSites = ids((await get(venA, '/api/v1/sites')).json().sites);
    expect(vendorSites).toContain(siteA);
    expect(vendorSites).not.toContain(siteB);
    const financeSites = ids(
      (await get(fin, '/api/v1/sites?site_type=POINT_DE_VENTE')).json().sites,
    );
    expect(financeSites).toEqual(expect.arrayContaining([siteA, siteB]));

    const locations = await get(venA, `/api/v1/locations?site_id=${siteA}`);
    expect(locations.statusCode, locations.body).toBe(200);
    expect(ids(locations.json().locations)).toContain(counterA);
    expect(locations.json().locations.find((l: { id: string }) => l.id === counterA)).toMatchObject(
      {
        locationType: 'POS',
        custodyMode: 'SHARED',
      },
    );
    const outOfScope = await get(venA, `/api/v1/locations?site_id=${siteB}`);
    expect(outOfScope.statusCode).toBe(404);
    expect(await deniedAudit(venA, siteB)).toEqual([
      expect.objectContaining({ result: 'DENIED', error_code: 'NOT_FOUND' }),
    ]);
    expect((await get(venA, '/api/v1/locations')).statusCode).toBe(400);

    const vendorPoints = (await get(venA, '/api/v1/points-of-sale')).json().points_of_sale;
    expect(vendorPoints.map((p: { siteId: string }) => p.siteId)).toContain(siteA);
    expect(vendorPoints.map((p: { siteId: string }) => p.siteId)).not.toContain(siteB);
    const pointsB = (await get(fin, `/api/v1/points-of-sale?site_id=${siteB}`)).json()
      .points_of_sale;
    expect(pointsB).toEqual([
      expect.objectContaining({
        siteId: siteB,
        salesLocationId: counterB,
        custodyMode: 'SHARED',
        cashAccountId: posB,
        openCashSessionId: sessionB,
      }),
    ]);
    const pointA = vendorPoints.find((p: { siteId: string }) => p.siteId === siteA);
    expect(pointA).toMatchObject({ cashAccountId: posA, openCashSessionId: null });
  });

  it('sessions de caisse : portée du compte, filtres combinés, fiche avec ajustement et flux ; 403, 404 audités, dates inexistantes', async () => {
    const vendor = await get(venA, `/api/v1/cash-sessions?site_id=${siteA}`);
    expect(vendor.statusCode, vendor.body).toBe(200);
    expect(ids(vendor.json().cash_sessions)).toEqual([sessionA]);
    expect(ids((await get(venA, '/api/v1/cash-sessions')).json().cash_sessions)).not.toContain(
      sessionB,
    );
    const open = await get(fin, `/api/v1/cash-sessions?site_id=${siteB}&status=OPEN`);
    expect(ids(open.json().cash_sessions)).toEqual([sessionB]);
    const byAccount = `/api/v1/cash-sessions?cash_account_id=${posA}&from=${DAY}&to=${DAY}`;
    expect(ids((await get(fin, byAccount)).json().cash_sessions)).toEqual([sessionA]);
    // Filtres combinés : la caisse de A sous le site B ne rend rien ; sous le site A, sa session.
    expect(
      (await get(fin, `/api/v1/cash-sessions?cash_account_id=${posA}&site_id=${siteB}`)).json()
        .cash_sessions,
    ).toEqual([]);
    expect(
      ids(
        (await get(fin, `/api/v1/cash-sessions?cash_account_id=${posA}&site_id=${siteA}`)).json()
          .cash_sessions,
      ),
    ).toEqual([sessionA]);
    expect((await get(fin, `/api/v1/cash-sessions?from=${DAY}&to=2026-10-01`)).statusCode).toBe(
      400,
    );
    expect((await get(fin, '/api/v1/cash-sessions?from=2026-02-30')).statusCode).toBe(400);

    // Session A : validée d'office à la clôture, puis réévaluée par la réception tardive de 5 000.
    const detail = await get(venA, `/api/v1/cash-sessions/${sessionA}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().cash_session).toMatchObject({
      id: sessionA,
      cashAccountId: posA,
      status: 'VALIDATED',
      autoValidated: true,
      openingCountedXaf: 20_000,
      closingCountedXaf: 20_000,
      varianceXaf: 0,
      businessDate: DAY,
    });
    expect(detail.json().adjustments).toEqual([
      expect.objectContaining({
        cause: 'LATE_OPERATION',
        deltaXaf: -5_000,
        varianceBeforeXaf: 0,
        varianceAfterXaf: -5_000,
        treatment: 'OWN_APPROVAL',
        status: 'PENDING',
      }),
    ]);
    expect(detail.json().flows).toMatchObject({
      sellers: [],
      unattributedReceivedXaf: 0,
      otherMovements: [
        { movementType: 'TRANSFER_IN', direction: 'IN', amountXaf: 5_000, count: 1 },
      ],
      netFlowsXaf: 5_000,
      expectedNowXaf: 25_000,
    });
    // Session B ouverte : la remise reçue à 10:00 est dans ses flux, l'attendu courant la compte.
    expect((await get(fin, `/api/v1/cash-sessions/${sessionB}`)).json().flows).toMatchObject({
      otherMovements: [
        { movementType: 'TRANSFER_IN', direction: 'IN', amountXaf: 3_000, count: 1 },
      ],
      netFlowsXaf: 3_000,
      expectedNowXaf: 3_000,
    });

    expect((await get(venA, `/api/v1/cash-sessions/${sessionB}`)).statusCode).toBe(404);
    expect(await deniedAudit(venA, sessionB)).toHaveLength(1);
    expect((await get(venA, `/api/v1/cash-sessions/${freshUuid()}`)).statusCode).toBe(404);
    const forbidden = await get(magA, '/api/v1/cash-sessions');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');
  });

  it('remises de fonds : visibles par l’un des deux comptes, fiche avec mouvements, statut, période, pagination', async () => {
    const vendor = ids((await get(venA, '/api/v1/cash-transfers')).json().cash_transfers);
    expect(vendor).toEqual(expect.arrayContaining([transferA, transferLate, transferNegative]));
    expect(vendor).not.toContain(transferB);
    const toB = ids(
      (await get(fin, `/api/v1/cash-transfers?account_id=${posB}&status=SENT`)).json()
        .cash_transfers,
    );
    expect(toB).toEqual(expect.arrayContaining([transferB, transferFinance]));
    expect(toB).not.toContain(transferFlow);
    expect(
      ids(
        (await get(fin, `/api/v1/cash-transfers?account_id=${posA}&status=RECEIVED`)).json()
          .cash_transfers,
      ).sort(),
    ).toEqual([transferA, transferLate].sort());

    const sameDay = ids(
      (await get(fin, `/api/v1/cash-transfers?account_id=${central}&from=${DAY}&to=${DAY}`)).json()
        .cash_transfers,
    );
    expect(sameDay).toEqual(
      expect.arrayContaining([transferA, transferB, transferNegative, transferFinance]),
    );
    expect(
      (await get(fin, `/api/v1/cash-transfers?account_id=${central}&from=2026-10-09`)).json()
        .cash_transfers,
    ).toEqual([]);
    expect(
      (await get(fin, `/api/v1/cash-transfers?account_id=${central}&to=2026-10-07`)).json()
        .cash_transfers,
    ).toEqual([]);

    const detail = await get(venA, `/api/v1/cash-transfers/${transferA}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().cash_transfer).toMatchObject({
      id: transferA,
      status: 'RECEIVED',
      amountSentXaf: 20_000,
      amountReceivedXaf: 20_000,
    });
    expect(
      detail
        .json()
        .movements.map(
          (m: { movementType: string; cashAccountId: string }) =>
            `${m.movementType}:${m.cashAccountId}`,
        ),
    ).toEqual([`TRANSFER_OUT:${central}`, `TRANSFER_IN:${posA}`]);
    expect((await get(venB, `/api/v1/cash-transfers/${transferA}`)).statusCode).toBe(404);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (
        await get(
          fin,
          `/api/v1/cash-transfers?account_id=${central}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        )
      ).json();
      expect(page.cash_transfers.length).toBeLessThanOrEqual(2);
      seen.push(...ids(page.cash_transfers));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      expect.arrayContaining([
        transferA,
        transferB,
        transferFlow,
        transferLate,
        transferNegative,
        transferFinance,
      ]),
    );
    expect([...seen].sort().reverse()).toEqual(seen);
    expect((await get(fin, '/api/v1/cash-transfers?cursor=abc')).statusCode).toBe(400);
  });

  it('quotas : par emplacement avec les restes actifs, filtres, « mes quotas », fiche du détenteur et registre ; hors portée ⇒ 404', async () => {
    const byLocation = await get(magA, `/api/v1/allocations?location_id=${counterA}`);
    expect(byLocation.statusCode, byLocation.body).toBe(200);
    expect(ids(byLocation.json().allocations)).toEqual(
      expect.arrayContaining([allocationId, releasedId]),
    );
    // Le quota révoqué n'entre pas dans la part promise du stock.
    expect(byLocation.json().active_totals).toEqual([
      { productId, activeCount: 1, quantityRemaining: 5 },
    ]);
    expect(
      ids(
        (await get(magA, `/api/v1/allocations?location_id=${counterA}&status=REVOKED`)).json()
          .allocations,
      ),
    ).toEqual([releasedId]);
    expect(
      ids(
        (await get(magA, `/api/v1/allocations?location_id=${counterA}&status=ACTIVE`)).json()
          .allocations,
      ),
    ).toEqual([allocationId]);
    expect(
      (
        await get(magA, `/api/v1/allocations?location_id=${counterA}&product_id=${freshUuid()}`)
      ).json().allocations,
    ).toEqual([]);
    expect(
      (await get(magA, `/api/v1/allocations?location_id=${counterA}&status=FOO`)).statusCode,
    ).toBe(400);
    expect((await get(magA, `/api/v1/allocations?location_id=${freshUuid()}`)).statusCode).toBe(
      404,
    );
    // « Mes quotas » : ceux du détenteur seulement — le magasinier n'en détient aucun.
    expect((await get(magA, '/api/v1/allocations')).json()).toMatchObject({
      location_id: null,
      allocations: [],
    });
    const mine = await get(venA, '/api/v1/allocations');
    expect(ids(mine.json().allocations)).toEqual([allocationId]);
    expect(mine.json().allocations[0]).toMatchObject({
      holderUserId: venA.userId,
      quantityGranted: 5,
      quantityRemaining: 5,
      status: 'ACTIVE',
      version: 1,
    });
    // Le vendeur B détient un quota sur le comptoir A (hors de son site) : il le voit, pas l'emplacement.
    expect(ids((await get(venB, '/api/v1/allocations')).json().allocations)).toEqual([releasedId]);
    expect((await get(venB, `/api/v1/allocations/${releasedId}`)).statusCode).toBe(200);
    expect((await get(venB, `/api/v1/allocations?location_id=${counterA}`)).statusCode).toBe(404);
    expect((await get(venB, `/api/v1/allocations/${allocationId}`)).statusCode).toBe(404);
    expect(await deniedAudit(venB, allocationId)).toHaveLength(1);
    expect((await get(magB, `/api/v1/allocations/${releasedId}`)).statusCode).toBe(404);

    const detail = await get(venA, `/api/v1/allocations/${allocationId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().entries).toEqual([
      expect.objectContaining({ entryType: 'GRANT', quantity: 5 }),
    ]);
    const released = (await get(magA, `/api/v1/allocations/${releasedId}`)).json();
    expect(released.allocation).toMatchObject({ status: 'REVOKED', quantityRemaining: 0 });
    expect(released.entries.map((e: { entryType: string }) => e.entryType)).toEqual([
      'GRANT',
      'REVOKE',
    ]);
  });

  it('file des conflits : rôle propriétaire et portée de son affectation (AV-191), Direction et Admin ; droit absent ⇒ 403', async () => {
    expect(
      ids((await get(fin, `/api/v1/sync/conflicts?entity_id=${posA}`)).json().conflicts),
    ).toEqual([cashNegativeConflict]);
    expect(
      (await get(fin, `/api/v1/sync/conflicts?entity_id=${allocationId}`)).json().conflicts,
    ).toEqual([]);
    // Conflit sans site (caisse centrale) : visible en portée ALL, absent sous un filtre de site.
    expect(
      ids((await get(fin, `/api/v1/sync/conflicts?entity_id=${central}`)).json().conflicts),
    ).toEqual([financeSelfConflict]);
    expect(
      (await get(fin, `/api/v1/sync/conflicts?entity_id=${central}&site_id=${siteA}`)).json()
        .conflicts,
    ).toEqual([]);
    const storeQueue = await get(magA, `/api/v1/sync/conflicts?entity_id=${allocationId}`);
    expect(storeQueue.statusCode, storeQueue.body).toBe(200);
    expect(storeQueue.json().conflicts).toEqual([
      expect.objectContaining({
        id: quarantineConflict,
        conflictType: 'VERSION_CONFLICT',
        ownerRole: 'MAGASINIER',
        applied: false,
        status: 'OPEN',
        siteId: siteA,
        authorUserId: magA.userId,
      }),
    ]);
    expect((await get(magA, `/api/v1/sync/conflicts?entity_id=${posA}`)).json().conflicts).toEqual(
      [],
    );
    expect((await get(magA, `/api/v1/sync/conflicts/${cashNegativeConflict}`)).statusCode).toBe(
      404,
    );
    // Magasinier d'un autre site : ni dans la liste, ni en fiche (404 audité).
    expect(
      (await get(magB, `/api/v1/sync/conflicts?entity_id=${allocationId}`)).json().conflicts,
    ).toEqual([]);
    expect((await get(magB, `/api/v1/sync/conflicts?site_id=${siteA}`)).json().conflicts).toEqual(
      [],
    );
    expect((await get(magB, `/api/v1/sync/conflicts/${quarantineConflict}`)).statusCode).toBe(404);
    expect(await deniedAudit(magB, quarantineConflict)).toEqual([
      expect.objectContaining({ result: 'DENIED', error_code: 'NOT_FOUND' }),
    ]);
    // Rôles cumulés : la portée ALL du Resp. achats n'étend pas son rôle de magasinier (site B) au site A.
    expect(
      (await get(multi, `/api/v1/sync/conflicts?entity_id=${allocationId}`)).json().conflicts,
    ).toEqual([]);
    expect((await get(multi, `/api/v1/sync/conflicts/${quarantineConflict}`)).statusCode).toBe(404);
    // Admin : tous les conflits, de tous les rôles.
    expect(
      ids((await get(admin, `/api/v1/sync/conflicts?entity_id=${allocationId}`)).json().conflicts),
    ).toEqual([quarantineConflict]);
    expect(
      ids((await get(admin, `/api/v1/sync/conflicts?entity_id=${posA}`)).json().conflicts),
    ).toEqual([cashNegativeConflict]);
    const detail = await get(fin, `/api/v1/sync/conflicts/${cashNegativeConflict}`);
    expect(detail.json().conflict).toMatchObject({
      conflictType: 'CASH_NEGATIVE',
      ownerRole: 'FINANCE',
      applied: true,
      authorUserId: venA.userId,
      details: expect.objectContaining({ transferId: transferNegative, amountXaf: 50_000 }),
    });
    expect((await get(venA, '/api/v1/sync/conflicts')).statusCode).toBe(403);
  });

  it('sync.conflict.resolve / .dismiss : clôture administrative (AV-190), gardes, auto-clôture (AV-192), anomalie persistante, événement et relecture', async () => {
    const resolve = (actor: Actor, id: string, payload: unknown, offline = false) =>
      send(actor, {
        type: 'sync.conflict.resolve',
        aggregateType: 'SYNC_CONFLICT',
        aggregateId: id,
        occurredAt: at('21:00'),
        payload,
        offline,
      });
    const dismiss = (actor: Actor, id: string, payload: unknown) =>
      send(actor, {
        type: 'sync.conflict.dismiss',
        aggregateType: 'SYNC_CONFLICT',
        aggregateId: id,
        occurredAt: at('21:00'),
        payload,
      });

    // Quarantaine (commande du magasinier A, rien d'appliqué) : ni écartée, ni rejouée ; le magasinier
    // de B n'y a pas accès ; COMPENSATE exige des références, dédoublonnées.
    expect(codeOf(await dismiss(magA, quarantineConflict, { comment: 'x' }))).toBe(
      'CONFLICT_NOT_INFORMATIVE',
    );
    expect(
      codeOf(
        await resolve(magA, quarantineConflict, { resolution: 'ACCEPT_CLIENT', comment: 'x' }),
      ),
    ).toBe('CONFLICT_REPLAY_NOT_SUPPORTED');
    expect(
      codeOf(await resolve(magA, quarantineConflict, { resolution: 'MERGE', comment: 'x' })),
    ).toBe('CONFLICT_REPLAY_NOT_SUPPORTED');
    expect(codeOf(await resolve(magA, quarantineConflict, { resolution: 'KEEP_SERVER' }))).toMatch(
      /^VALIDATION_ERROR/,
    );
    expect(
      codeOf(await resolve(magB, quarantineConflict, { resolution: 'KEEP_SERVER', comment: 'x' })),
    ).toBe('FORBIDDEN_SCOPE');
    expect((await conflictRow(quarantineConflict)).status).toBe('OPEN');
    expect(
      codeOf(await resolve(magA, quarantineConflict, { resolution: 'COMPENSATE', comment: 'x' })),
    ).toBe('CONFLICT_REFS_REQUIRED');
    expect(
      codeOf(
        await resolve(magA, quarantineConflict, {
          resolution: 'COMPENSATE',
          comment: 'x',
          refs: ['abc'],
        }),
      ),
    ).toMatch(/^VALIDATION_ERROR/);
    const kept = await resolve(magA, quarantineConflict, {
      resolution: 'COMPENSATE',
      comment: 'Augmentation saisie deux fois : le quota a été ajusté par le quota suivant.',
      refs: [releasedId, releasedId],
    });
    expect(kept.status, JSON.stringify(kept)).toBe('APPLIED');
    const row = await conflictRow(quarantineConflict);
    expect(row).toMatchObject({ status: 'RESOLVED', resolution: 'COMPENSATE' });
    expect(row.resolution_refs).toEqual([releasedId]);
    expect(fromBin(row.resolved_by!)).toBe(magA.userId);
    const [event] = await db
      .selectFrom('platform_domain_events')
      .select(['event_type', 'producer_module', 'payload'])
      .where('aggregate_id', '=', toBin(quarantineConflict))
      .where('event_type', '=', 'SyncConflictResolved')
      .execute();
    // Événement métier propre, en plus de l'événement générique de la commande publié par le pipeline.
    expect(event).toMatchObject({ producer_module: 'sync' });
    expect(event!.payload).toMatchObject({
      conflict_id: quarantineConflict,
      status: 'RESOLVED',
      resolution: 'COMPENSATE',
      refs: [releasedId],
      applied: false,
      site_id: siteA,
      entity_id: allocationId,
    });
    expect(
      codeOf(await resolve(magA, quarantineConflict, { resolution: 'KEEP_SERVER', comment: 'y' })),
    ).toBe('CONFLICT_ALREADY_CLOSED');
    expect(
      (await get(magA, `/api/v1/sync/conflicts?entity_id=${allocationId}`)).json().conflicts,
    ).toEqual([]);
    const reread = (await get(magA, `/api/v1/sync/conflicts/${quarantineConflict}`)).json()
      .conflict;
    expect(reread).toMatchObject({
      status: 'RESOLVED',
      resolution: 'COMPENSATE',
      resolvedBy: magA.userId,
      resolvedAt: at('21:00'),
      resolutionRefs: [releasedId],
    });

    // Conflit de la Finance sur la caisse A : hors du rôle du magasinier ; en ligne seulement ;
    // un conflit appliqué accepte ACCEPT_CLIENT (le fait du client est gardé tel quel).
    expect(codeOf(await dismiss(magA, cashNegativeConflict, { comment: 'x' }))).toBe(
      'FORBIDDEN_SCOPE',
    );
    expect(codeOf(await dismiss(venA, cashNegativeConflict, { comment: 'x' }))).toBe('FORBIDDEN');
    expect(
      codeOf(
        await resolve(fin, cashNegativeConflict, { resolution: 'KEEP_SERVER', comment: 'x' }, true),
      ),
    ).toBe('ONLINE_REQUIRED');
    expect(
      codeOf(await resolve(fin, freshUuid(), { resolution: 'KEEP_SERVER', comment: 'x' })),
    ).toBe('NOT_FOUND');
    const accepted = await resolve(fin, cashNegativeConflict, {
      resolution: 'ACCEPT_CLIENT',
      comment: 'Recette remise par le vendeur, régularisée par la remise du lendemain.',
    });
    expect(accepted.status, JSON.stringify(accepted)).toBe('APPLIED');
    expect(await conflictRow(cashNegativeConflict)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'ACCEPT_CLIENT',
    });

    // AV-192 : la Finance n'écarte pas le signal de sa propre remise ; l'Admin le peut.
    expect(codeOf(await dismiss(fin, financeSelfConflict, { comment: 'x' }))).toBe(
      'CONFLICT_SELF_RESOLUTION_FORBIDDEN',
    );
    const adminDismiss = await dismiss(admin, financeSelfConflict, {
      comment: 'Remise de la Finance contrôlée.',
    });
    expect(adminDismiss.status, JSON.stringify(adminDismiss)).toBe('APPLIED');
    expect(await conflictRow(financeSelfConflict)).toMatchObject({
      status: 'DISMISSED',
      resolution: null,
    });
    const dismissedEvent = await db
      .selectFrom('platform_domain_events')
      .select('payload')
      .where('aggregate_id', '=', toBin(financeSelfConflict))
      .where('event_type', '=', 'SyncConflictResolved')
      .executeTakeFirstOrThrow();
    expect(dismissedEvent.payload).toMatchObject({ status: 'DISMISSED', resolution: null });

    // Réévaluation de la session A (signal de la Finance) : écartée par la Finance, relue par HTTP.
    expect(
      (await dismiss(fin, reevaluatedConflict, { comment: 'Ajustement validé à part.' })).status,
    ).toBe('APPLIED');
    expect(
      (await get(fin, `/api/v1/sync/conflicts/${reevaluatedConflict}`)).json().conflict,
    ).toMatchObject({
      status: 'DISMISSED',
      resolution: null,
      resolvedBy: fin.userId,
      resolutionComment: 'Ajustement validé à part.',
    });

    // Clôture propre à une décision : jamais par la file.
    const managedId = freshUuid();
    await tx((trx) =>
      recordConflict(trx, {
        id: managedId,
        commandId: null,
        conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
        entityType: 'CUSTOMER_PAYMENT',
        entityId: freshUuid(),
        siteId: siteA,
        ownerRole: 'FINANCE',
        applied: false,
        details: { methodCode: 'MOBILE_MONEY_ORANGE' },
      }),
    );
    expect(codeOf(await resolve(fin, managedId, { resolution: 'KEEP_SERVER', comment: 'x' }))).toBe(
      'CONFLICT_MANAGED_ELSEWHERE',
    );
    expect((await conflictRow(managedId)).status).toBe('OPEN');

    // Anomalie de stock persistante : une perte sur le stock commun du comptoir A le fait passer sous
    // le quota actif (5) ; la clôture attend la régularisation (révocation du quota).
    const loss = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_LOSS')
      .executeTakeFirstOrThrow();
    await tx((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: 46,
          fromLocationId: counterA,
          toLocationId: fromBin(loss.id),
          moveType: 'LOSS',
          occurredAt: new Date(at('20:30')),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: root,
          allowNegative: false,
        },
      ),
    );
    const overcommitted = await conflictIdOf(counterA, 'ALLOCATION_OVERCOMMITTED');
    expect(
      ids((await get(magA, `/api/v1/sync/conflicts?entity_id=${counterA}`)).json().conflicts),
    ).toContain(overcommitted);
    expect(
      codeOf(await resolve(magA, overcommitted, { resolution: 'KEEP_SERVER', comment: 'x' })),
    ).toBe('CONFLICT_CONDITION_PERSISTS');
    expect(codeOf(await dismiss(magA, overcommitted, { comment: 'x' }))).toBe(
      'CONFLICT_CONDITION_PERSISTS',
    );
    await ok(magA, {
      type: 'inventory.allocation.revoke',
      aggregateType: 'STOCK_ALLOCATION',
      aggregateId: allocationId,
      occurredAt: at('20:45'),
      payload: { reason: 'Stock perdu : quota retiré.' },
    });
    const closed = await resolve(magA, overcommitted, {
      resolution: 'COMPENSATE',
      comment: 'Quota révoqué après la perte.',
      refs: [allocationId],
    });
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
  });
});
