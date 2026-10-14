/**
 * MP-07 — file de validation `GET /approvals/inbox` (ECR-ADM-08, UC-ADM-15) : portée du décideur
 * (BR-ADM-018, la règle de la décision), filtre par type, pagination, pièce attendue (BR-ADM-020),
 * montant au coût masqué (RC-05), auto-validation réservée à la Direction (INV-ADM-02, BR-ADM-017), et
 * fidélité du catalogue de décision partagé (`@gic/domain`) aux gestionnaires des modules.
 *
 * Base partagée : politiques de test retirées dès leur création (elles ne s'appliquent à rien d'autre),
 * demandes datées de 2019 pour passer en tête de la file (la plus ancienne d'abord), annulées à la fin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { APPROVAL_DECISION_SPECS, type Clock } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  APPROVAL_DECISION_HANDLER_REGISTRY,
  OPERATION_TYPES,
  pendingApprovalsFor,
  type ApprovalDecisionHandlerRegistry,
} from '../src/modules/approvals/application/public/index.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';

let deviceSeq = 0;

interface InboxEntry {
  readonly id: string;
  readonly operationType: string;
  readonly subjectSummary: string;
  readonly amountXaf: number | null;
  readonly amountMasked: boolean;
  readonly requestedByName: string | null;
  readonly attachmentsPending: boolean;
  readonly selfRequest: boolean;
}

describe('MP-07 : file de validation', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let root: string;
  let s1: string;
  let s2: string;
  let s3: string;
  let direction: Actor;
  let respCom: Actor;
  let respFerme: Actor;
  let finance: Actor;
  let admin: Actor;
  let magasinier: Actor;
  const requests: Record<string, string> = {};

  const tokenOf = (actor: Actor) =>
    signAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
      clock.now(),
    );
  const get = async (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await tokenOf(actor)}` },
    });
  /** Demandes du test visibles par l'acteur, dans l'ordre de la file (pages suivies au besoin). */
  const inboxOf = async (actor: Actor, query = '', limit = 200) => {
    const ours = new Set(Object.values(requests));
    const seen: InboxEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const response = await get(
        actor,
        `/api/v1/approvals/inbox?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { requests: InboxEntry[]; next_cursor: string | null };
      for (const entry of body.requests) if (ours.has(entry.id)) seen.push(entry);
      cursor = body.next_cursor;
      // Les demandes du test sont les plus anciennes : inutile de lire toute la base.
      if (cursor === null || seen.length === ours.size) break;
    }
    return seen;
  };
  const decide = (
    actor: Actor,
    commandType: 'approvals.request.approve' | 'approvals.request.reject',
    requestId: string,
    payload: Record<string, unknown>,
    capturedOffline = false,
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: new Date().toISOString(),
        client_created_at: new Date().toISOString(),
        captured_offline: capturedOffline,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId, ...payload },
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  const codeOf = (result: CommandResult) =>
    result.status === 'REJECTED' ? result.error?.code : result.status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);

    root = await tx((trx) => insertTestUser(trx));
    let zone: string;
    await tx(async (trx) => {
      zone = await insertTestZone(trx, root);
      s1 = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
      s2 = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
      // Autre zone : hors de la portée de zone du Resp. commercial (évaluation exacte, sans pré-filtre).
      s3 = await insertTestSite(trx, root, await insertTestZone(trx, root), {
        siteType: 'POINT_DE_VENTE',
      });
    });
    direction = await newActor('DIRECTION', root);
    admin = await newActor('ADMIN', root);
    finance = await newActor('FINANCE', root);
    respFerme = await newActor('RESP_FERME', root, { scopeType: 'SITE', scopeSiteId: s1 });
    magasinier = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: s1 });
    respCom = await newActor('RESP_COMMERCIAL', root, { scopeType: 'ZONE', scopeZoneId: zone! });
    const member = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zone!,
    });
    const outsider = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zone!,
    });
    const vendeur = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: s1 });
    await tx(async (trx) => {
      const team = await insertTestTeam(trx, respCom.userId, root);
      await insertTestTeamMembership(trx, team, member.userId, root);
    });

    await tx(async (trx) => {
      const policy = async (operationType: string, approverPermission: string) => {
        const id = freshUuid();
        await trx
          .insertInto('approvals_control_policies')
          .values({
            id: toBin(id),
            code: `MP07_${id.slice(-12)}`,
            version: 1,
            operation_type: operationType,
            condition: jsonValue({}),
            requires_photo: 0,
            requires_comment: 0,
            requires_approval: 1,
            approver_permission: approverPermission,
            approver_scope: 'ALL',
            valid_from: new Date('2019-01-01T00:00:00.000Z'),
            valid_to: new Date('2019-01-01T00:00:00.000Z'),
            status: 'RETIRED',
            created_by: toBin(root),
          })
          .execute();
        return id;
      };
      const priceOverride = await policy('PRICE_OVERRIDE', 'sales.price_override.approve');
      const loss = await policy('LOSS_DECLARATION', 'inventory.loss.approve');
      const cashVariance = await policy('CASH_VARIANCE', 'finance.cash_session.validate');
      let minute = 0;
      const request = async (
        key: string,
        input: {
          readonly operationType: string;
          readonly policyId: string;
          readonly requestedBy: string;
          readonly siteId?: string;
          readonly amountXaf?: number;
          readonly requiredAttachmentIds?: readonly string[];
          readonly summary?: string;
        },
      ) => {
        const id = freshUuid();
        minute += 1;
        await trx
          .insertInto('approvals_approval_requests')
          .values({
            id: toBin(id),
            operation_type: input.operationType,
            subject_type: 'TEST_SUBJECT',
            subject_id: toBin(freshUuid()),
            subject_summary: input.summary ?? `MP-07 ${key}`,
            ...(input.siteId ? { site_id: toBin(input.siteId) } : {}),
            ...(input.amountXaf !== undefined ? { amount_xaf: String(input.amountXaf) } : {}),
            ...(input.requiredAttachmentIds
              ? { required_attachment_ids: jsonValue(input.requiredAttachmentIds) }
              : {}),
            requested_by: toBin(input.requestedBy),
            requested_at: new Date(Date.UTC(2019, 0, 1, 1, minute)),
            policy_id: toBin(input.policyId),
            policy_version: 1,
            created_by: toBin(input.requestedBy),
          })
          .execute();
        requests[key] = id;
      };
      await request('teamDiscount', {
        operationType: 'PRICE_OVERRIDE',
        policyId: priceOverride,
        requestedBy: member.userId,
        siteId: s1,
        amountXaf: 4_000,
      });
      await request('otherDiscount', {
        operationType: 'PRICE_OVERRIDE',
        policyId: priceOverride,
        requestedBy: outsider.userId,
        siteId: s1,
      });
      await request('lossS1', {
        operationType: 'LOSS_DECLARATION',
        policyId: loss,
        requestedBy: vendeur.userId,
        siteId: s1,
        amountXaf: 12_000,
        requiredAttachmentIds: [freshUuid()],
      });
      await request('lossS2', {
        operationType: 'LOSS_DECLARATION',
        policyId: loss,
        requestedBy: vendeur.userId,
        siteId: s2,
        amountXaf: 9_000,
      });
      await request('lossOtherZone', {
        operationType: 'LOSS_DECLARATION',
        policyId: loss,
        requestedBy: vendeur.userId,
        siteId: s3,
        amountXaf: 7_000,
      });
      await request('cashVariance', {
        operationType: 'CASH_VARIANCE',
        policyId: cashVariance,
        requestedBy: vendeur.userId,
        siteId: s1,
        amountXaf: 5_000,
      });
      await request('directionOwn', {
        operationType: 'PRICE_OVERRIDE',
        policyId: priceOverride,
        requestedBy: direction.userId,
        siteId: s1,
      });
      await request('respComOwn', {
        operationType: 'PRICE_OVERRIDE',
        policyId: priceOverride,
        requestedBy: respCom.userId,
        siteId: s1,
      });
    });
  }, 180_000);

  afterAll(async () => {
    // Hygiène de la base partagée : aucune demande de ce test ne reste en attente.
    const ids = Object.values(requests);
    if (ids.length > 0) {
      await db
        .updateTable('approvals_approval_requests')
        .set({ status: 'CANCELLED' })
        .where(
          'id',
          'in',
          ids.map((id) => toBin(id)),
        )
        .where('status', '=', 'PENDING')
        .execute();
    }
    await app.close();
    await closeTestDb();
  });

  it('portée de chaque décideur, la plus ancienne d’abord (BR-ADM-018) ; ses propres demandes à la Direction seulement', async () => {
    const all = await inboxOf(direction);
    expect(all.map((entry) => entry.id)).toEqual([
      requests.teamDiscount,
      requests.otherDiscount,
      requests.lossS1,
      requests.lossS2,
      requests.lossOtherZone,
      requests.cashVariance,
      requests.directionOwn,
      requests.respComOwn,
    ]);
    expect(all.find((entry) => entry.id === requests.directionOwn)!.selfRequest).toBe(true);
    expect(all.find((entry) => entry.id === requests.teamDiscount)).toMatchObject({
      operationType: 'PRICE_OVERRIDE',
      amountXaf: 4_000,
      amountMasked: false,
      selfRequest: false,
      requestedByName: expect.any(String),
    });

    // Resp. commercial : remises de son équipe seulement, jamais la sienne ; pertes des sites de sa
    // zone (`inventory.loss.approve` ZONE ; celle d'une autre zone exclue par l'évaluation exacte, la
    // portée de zone n'ayant pas de pré-filtre SQL), montant au coût masqué (sans valorisation).
    const com = await inboxOf(respCom);
    expect(com.map((entry) => entry.id)).toEqual([
      requests.teamDiscount,
      requests.lossS1,
      requests.lossS2,
    ]);
    expect(com.find((entry) => entry.id === requests.lossS2)).toMatchObject({
      amountXaf: null,
      amountMasked: true,
    });
    // Resp. ferme : pertes de son site ; Finance : écart de caisse, pas de remise.
    expect((await inboxOf(respFerme)).map((entry) => entry.id)).toEqual([requests.lossS1]);
    expect((await inboxOf(finance)).map((entry) => entry.id)).toEqual([requests.cashVariance]);
    // Lecture sans droit d'approbation : rien ; l'Admin n'a pas la file (RC-03).
    expect(await inboxOf(magasinier)).toEqual([]);
    expect((await get(admin, '/api/v1/approvals/inbox')).statusCode).toBe(403);
  });

  it('filtre par type, pagination, pièce attendue (BR-ADM-020), montant au coût masqué (RC-05)', async () => {
    expect(
      (await inboxOf(direction, '&types=LOSS_DECLARATION,MORTALITY')).map((entry) => entry.id),
    ).toEqual([requests.lossS1, requests.lossS2, requests.lossOtherZone]);
    expect((await get(direction, '/api/v1/approvals/inbox?types=INCONNU')).statusCode).toBe(400);
    expect((await get(direction, '/api/v1/approvals/inbox?limit=500')).statusCode).toBe(400);

    // Une demande par page : même ordre en suivant les curseurs.
    const paged = await inboxOf(direction, '', 1);
    expect(paged.map((entry) => entry.id)).toEqual((await inboxOf(direction)).map((e) => e.id));

    const [lossForFerme] = await inboxOf(respFerme);
    expect(lossForFerme).toMatchObject({
      attachmentsPending: true,
      amountXaf: null,
      amountMasked: true,
    });
    const lossForDirection = (await inboxOf(direction)).find((e) => e.id === requests.lossS1)!;
    expect(lossForDirection).toMatchObject({ amountXaf: 12_000, amountMasked: false });
    expect(
      (await inboxOf(direction)).find((e) => e.id === requests.lossS2)!.attachmentsPending,
    ).toBe(false);

    // L'accueil partage la même lecture (montant masqué compris).
    const home = await pendingApprovalsFor(db, respFerme.userId, clock.now());
    expect(home.find((entry) => entry.id === requests.lossS1)).toMatchObject({ amountXaf: null });
    expect(home.map((entry) => entry.id)).not.toContain(requests.lossS2);
  });

  it('aucune décision hors ligne (SM-APPROVAL) : approuver ou refuser saisi hors ligne, refusé', async () => {
    for (const commandType of ['approvals.request.approve', 'approvals.request.reject'] as const) {
      expect(
        codeOf(
          await decide(
            direction,
            commandType,
            requests.otherDiscount,
            { comment: 'Hors ligne' },
            true,
          ),
        ),
      ).toBe('ONLINE_REQUIRED');
    }
    expect(
      (
        await db
          .selectFrom('approvals_approval_requests')
          .select('status')
          .where('id', '=', toBin(requests.otherDiscount))
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('PENDING');
  });

  it('auto-validation : la Direction seulement, avec le marqueur explicite (INV-ADM-02)', async () => {
    // Resp. commercial : sa propre remise est dans sa portée d'équipe (il en est titulaire) ; avec le
    // marqueur, refusée quand même (avant MP-07, elle était appliquée).
    expect(
      codeOf(
        await decide(respCom, 'approvals.request.approve', requests.respComOwn, {
          selfApproved: true,
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      (
        await db
          .selectFrom('approvals_approval_requests')
          .select('status')
          .where('id', '=', toBin(requests.respComOwn))
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('PENDING');
    expect(
      codeOf(await decide(direction, 'approvals.request.approve', requests.directionOwn, {})),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      codeOf(
        await decide(direction, 'approvals.request.approve', requests.directionOwn, {
          selfApproved: true,
        }),
      ),
    ).toBe('APPLIED');
    const row = await db
      .selectFrom('approvals_approval_requests')
      .select(['status', 'self_approved'])
      .where('id', '=', toBin(requests.directionOwn))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'APPROVED', self_approved: 1 });
    expect((await inboxOf(direction)).map((entry) => entry.id)).not.toContain(
      requests.directionOwn,
    );
    // Refus : motif obligatoire.
    expect(
      codeOf(await decide(direction, 'approvals.request.reject', requests.otherDiscount, {})),
    ).toMatch(/^VALIDATION_ERROR/);
  });

  it('catalogue de décision fidèle aux gestionnaires des modules (ADR-018)', () => {
    const registry = app.get<ApprovalDecisionHandlerRegistry>(APPROVAL_DECISION_HANDLER_REGISTRY);
    // Type sans aucun appelant de `requestApproval` à ce jour.
    const unused = new Set(['RECEIPT_VALUE']);
    for (const type of OPERATION_TYPES) {
      const spec = APPROVAL_DECISION_SPECS[type];
      if (spec?.recordOnly) expect(registry.resolve(type), type).toBeUndefined();
      if (registry.resolve(type) === undefined) {
        expect(spec?.recordOnly === true || unused.has(type), type).toBe(true);
      }
      if (spec && !spec.rejectable) expect(registry.resolve(type), type).toBeDefined();
    }
    for (const type of Object.keys(APPROVAL_DECISION_SPECS)) {
      expect(OPERATION_TYPES as readonly string[]).toContain(type);
    }
  });
});
