/**
 * `approvals.policy.set`, `.request.approve/.reject/.withdraw`, `requestApproval` (API
 * interne, ADR-018 ; SM-APPROVAL). Niveau service, base MySQL réelle — comme
 * `organization-commands.test.ts`.
 *
 * Permissions utilisées : codes réels du catalogue (P0-05 ; `attachments.attachment.manage`
 * ajouté par P0-13, AV-093) — jamais `test.*`, puisque `CommandHandlerRegistry` les porte en
 * dur (`policy-commands.ts`, `request-commands.ts`, `attachment-commands.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { registerAttachmentCommands } from '../src/modules/attachments/application/commands/attachment-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import type { ApprovalDecisionContext } from '../src/modules/approvals/application/decision-handler-registry.js';
import { requestApproval } from '../src/modules/approvals/application/public/request-approval.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-09-25T09:00:00.000Z';
const APPROVE_PERMISSION = 'inventory.loss.approve'; // permission réelle (catalogue P0-05)

function buildCommand(overrides: {
  readonly commandId: string;
  readonly commandType: string;
  readonly authorUserId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}): Record<string, unknown> {
  return {
    command_id: overrides.commandId,
    device_seq: 1,
    command_type: overrides.commandType,
    command_version: 1,
    author_user_id: overrides.authorUserId,
    aggregate_type: overrides.aggregateType,
    aggregate_id: overrides.aggregateId,
    base_version: null,
    depends_on: [],
    occurred_at: OCCURRED_AT,
    client_created_at: OCCURRED_AT,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: overrides.payload,
  };
}

describe('approvals (P0-13)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let decisionRegistry: ApprovalDecisionHandlerRegistry;
  let admin: string;
  let adminDevice: string;
  let requester: string;
  let requesterDevice: string;
  let approver: string;
  let approverDevice: string;
  let outsider: string;
  let outsiderDevice: string;
  let siteId: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    decisionRegistry = new ApprovalDecisionHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    registerAttachmentCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    requester = await db.transaction().execute((trx) => insertTestUser(trx));
    requesterDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, requester, { status: 'ACTIVE' }));
    approver = await db.transaction().execute((trx) => insertTestUser(trx));
    approverDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, approver, { status: 'ACTIVE' }));
    outsider = await db.transaction().execute((trx) => insertTestUser(trx));
    outsiderDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, outsider, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin, {
        maxScope: 'ALL',
      });
      await assignTestRole(trx, admin, adminRole, admin);

      // requester : peut voir la file (gate générique RC-01) et joindre des pièces.
      const requesterRole = await insertTestRole(trx, requester);
      await grantTestPermission(trx, requesterRole, 'approvals.request.read', admin, {
        maxScope: 'OWN',
      });
      await grantTestPermission(trx, requesterRole, 'attachments.attachment.manage', admin, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, requester, requesterRole, admin);

      // approver : détient inventory.loss.approve à la portée SITE, affecté sur `siteId`.
      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await grantTestPermission(trx, approverRole, APPROVE_PERMISSION, admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });

      // outsider : voit la file (gate RC-01) mais ne détient jamais APPROVE_PERMISSION.
      const outsiderRole = await insertTestRole(trx, outsider);
      await grantTestPermission(trx, outsiderRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await assignTestRole(trx, outsider, outsiderRole, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function setPolicy(code: string): Promise<string> {
    const policyId = freshUuid();
    const result = await pipeline.handle(
      buildCommand({
        commandId: freshUuid(),
        commandType: 'approvals.policy.set',
        authorUserId: admin,
        aggregateType: 'CONTROL_POLICY',
        aggregateId: policyId,
        payload: {
          code,
          operationType: 'LOSS_DECLARATION',
          requiresApproval: true,
          approverPermission: APPROVE_PERMISSION,
          approverScope: 'SITE',
        },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');
    return policyId;
  }

  it('approvals.policy.set : versionnement — un second set retire la version active précédente', async () => {
    const code = `TEST_POLICY_${freshUuid().slice(-8)}`;
    const v1 = await setPolicy(code);
    const v2Id = freshUuid();
    const v2Result = await pipeline.handle(
      buildCommand({
        commandId: freshUuid(),
        commandType: 'approvals.policy.set',
        authorUserId: admin,
        aggregateType: 'CONTROL_POLICY',
        aggregateId: v2Id,
        payload: {
          code,
          operationType: 'LOSS_DECLARATION',
          requiresApproval: true,
          approverPermission: APPROVE_PERMISSION,
        },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(v2Result.status).toBe('APPLIED');

    const rows = await db
      .selectFrom('approvals_control_policies')
      .select(['id', 'version', 'status'])
      .where('code', '=', code)
      .orderBy('version', 'asc')
      .execute();
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]!.status).toBe('RETIRED');
    expect(rows[1]!.status).toBe('ACTIVE');
    expect(rows[0]!.id.toString('hex')).toBe(toBin(v1).toString('hex'));
  });

  it('requiresApproval sans approverPermission → REJECTED VALIDATION_ERROR (CK, dictionnaire)', async () => {
    const result = await pipeline.handle(
      buildCommand({
        commandId: freshUuid(),
        commandType: 'approvals.policy.set',
        authorUserId: admin,
        aggregateType: 'CONTROL_POLICY',
        aggregateId: freshUuid(),
        payload: {
          code: `TEST_POLICY_${freshUuid().slice(-8)}`,
          operationType: 'LOSS_DECLARATION',
          requiresApproval: true,
        },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toMatch(/^VALIDATION_ERROR/);
  });

  describe('cycle de vie de la demande (SM-APPROVAL)', () => {
    async function createPendingRequest(
      policyId: string,
      requiredAttachmentIds: readonly string[] = [],
      subjectId: string = freshUuid(),
    ): Promise<string> {
      const requestId = freshUuid();
      await db.transaction().execute((trx) =>
        requestApproval(trx, {
          requestId,
          operationType: 'LOSS_DECLARATION',
          subjectType: 'STOCK_LOSS',
          subjectId,
          subjectSummary: 'Perte de test',
          siteId,
          requestedBy: requester,
          requestedAt: new Date(OCCURRED_AT),
          policyId,
          policyVersion: 1,
          requiredAttachmentIds,
        }),
      );
      return requestId;
    }

    it('approve : gestionnaire de décision du module propriétaire exécuté dans la transaction de la décision (ADR-018)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const requestId = await createPendingRequest(policyId);

      const seen: ApprovalDecisionContext[] = [];
      decisionRegistry.register('LOSS_DECLARATION', async (uow, ctx) => {
        seen.push(ctx);
        await uow
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key: `test.approval_decision.${ctx.requestId}`,
            value: JSON.stringify(ctx.decision),
            scope_type: 'GLOBAL',
            created_by: toBin(ctx.decidedBy),
          })
          .execute();
      });

      const result = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId, decisionOption: 'PERTE_CONFIRMEE' },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(result.status).toBe('APPLIED');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ requestId, decision: 'APPROVED', decidedBy: approver });

      const row = await db
        .selectFrom('approvals_approval_requests')
        .selectAll()
        .where('id', '=', toBin(requestId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('APPROVED');
      expect(row.decided_by?.toString('hex')).toBe(toBin(approver).toString('hex'));
      expect(row.decision_option).toBe('PERTE_CONFIRMEE');
      expect(row.self_approved).toBe(0);

      const marker = await db
        .selectFrom('organization_system_settings')
        .select('id')
        .where('key', '=', `test.approval_decision.${requestId}`)
        .execute();
      expect(marker).toHaveLength(1);
    });

    it('approve : gestionnaire de décision en échec → toute la décision annulée (même transaction, pas d’effet partiel)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const requestId = await createPendingRequest(policyId);

      // Registre de décision dédié (ApprovalDecisionHandlerRegistry refuse un second
      // enregistrement pour la même clé LOSS_DECLARATION, déjà prise par le test précédent) :
      // isole ce pipeline des gestionnaires posés ailleurs dans ce fichier.
      const failingRegistry = new ApprovalDecisionHandlerRegistry();
      failingRegistry.register('LOSS_DECLARATION', async () => {
        throw new Error('échec simulé du gestionnaire propriétaire');
      });
      const failingCommandRegistry = new CommandHandlerRegistry();
      registerRequestCommands(failingCommandRegistry, failingRegistry);
      const failingPipeline = new CommandPipelineService(
        db,
        failingCommandRegistry,
        clock,
        idGenerator,
      );

      await expect(
        failingPipeline.handle(
          buildCommand({
            commandId: freshUuid(),
            commandType: 'approvals.request.approve',
            authorUserId: approver,
            aggregateType: 'APPROVAL_REQUEST',
            aggregateId: requestId,
            payload: { requestId },
          }),
          {
            authenticatedUserId: approver,
            authenticatedDeviceId: approverDevice,
            transport: 'ONLINE_API',
          },
        ),
      ).resolves.toMatchObject({ status: 'RETRY_LATER' });

      const row = await db
        .selectFrom('approvals_approval_requests')
        .select('status')
        .where('id', '=', toBin(requestId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PENDING'); // rollback complet : aucune décision enregistrée
    });

    it('approve : hors du périmètre de affectation (site différent) → REJECTED APPROVER_NOT_ALLOWED (BR-ADM-018)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const otherZone = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      const otherSite = await db
        .transaction()
        .execute((trx) => insertTestSite(trx, admin, otherZone));
      const requestId = freshUuid();
      await db.transaction().execute((trx) =>
        requestApproval(trx, {
          requestId,
          operationType: 'LOSS_DECLARATION',
          subjectType: 'TEST_LOSS',
          subjectId: freshUuid(),
          subjectSummary: 'Perte hors périmètre',
          siteId: otherSite,
          requestedBy: requester,
          requestedAt: new Date(OCCURRED_AT),
          policyId,
          policyVersion: 1,
        }),
      );

      const result = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver, // affecté sur `siteId`, pas `otherSite`
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(result.status).toBe('REJECTED');
      expect(result.status === 'REJECTED' && result.error.code).toBe('APPROVER_NOT_ALLOWED');
    });

    it('MP-11 (AV-295) : rôle d’approbateur échu avant la réception → APPROVER_NOT_ALLOWED, même à une date déclarée antérieure', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const former = await db.transaction().execute((trx) => insertTestUser(trx));
      const formerDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, former, { status: 'ACTIVE' }));
      await db.transaction().execute(async (trx) => {
        const role = await insertTestRole(trx, former, { allowedScopeTypes: ['SITE'] });
        await grantTestPermission(trx, role, 'approvals.request.read', admin, { maxScope: 'ALL' });
        await grantTestPermission(trx, role, APPROVE_PERMISSION, admin, { maxScope: 'SITE' });
        // Valable à la date déclarée de la décision (09:00), échu depuis 10:00 le même jour.
        await assignTestRole(trx, former, role, admin, {
          scopeType: 'SITE',
          scopeSiteId: siteId,
          validFrom: new Date('2026-09-01T00:00:00.000Z'),
          validTo: new Date('2026-09-25T10:00:00.000Z'),
        });
      });
      const requestId = freshUuid();
      await db.transaction().execute((trx) =>
        requestApproval(trx, {
          requestId,
          operationType: 'LOSS_DECLARATION',
          subjectType: 'TEST_LOSS',
          subjectId: freshUuid(),
          subjectSummary: 'Perte décidée après la fin du rôle',
          siteId,
          requestedBy: requester,
          requestedAt: new Date(OCCURRED_AT),
          policyId,
          policyVersion: 1,
        }),
      );
      const result = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: former,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: former,
          authenticatedDeviceId: formerDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(result.status).toBe('REJECTED');
      expect(result.status === 'REJECTED' && result.error.code).toBe('APPROVER_NOT_ALLOWED');
      const row = await db
        .selectFrom('approvals_approval_requests')
        .select('status')
        .where('id', '=', toBin(requestId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PENDING');
    });

    it('approve : demandeur == approbateur → SELF_APPROVAL_FORBIDDEN, même avec le marqueur, sauf la Direction (BR-ADM-017, INV-ADM-02)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const selfRequest = async (requestedBy: string) => {
        const requestId = freshUuid();
        await db.transaction().execute((trx) =>
          requestApproval(trx, {
            requestId,
            operationType: 'LOSS_DECLARATION',
            subjectType: 'TEST_LOSS',
            subjectId: freshUuid(),
            subjectSummary: 'Auto-demande',
            siteId,
            requestedBy, // le demandeur EST l'approbateur potentiel
            requestedAt: new Date(OCCURRED_AT),
            policyId,
            policyVersion: 1,
          }),
        );
        return requestId;
      };
      const approve = (author: string, device: string, requestId: string, selfApproved?: true) =>
        pipeline.handle(
          buildCommand({
            commandId: freshUuid(),
            commandType: 'approvals.request.approve',
            authorUserId: author,
            aggregateType: 'APPROVAL_REQUEST',
            aggregateId: requestId,
            payload: selfApproved ? { requestId, selfApproved } : { requestId },
          }),
          { authenticatedUserId: author, authenticatedDeviceId: device, transport: 'ONLINE_API' },
        );
      const codeOf = (result: Awaited<ReturnType<typeof approve>>) =>
        result.status === 'REJECTED' ? result.error.code : result.status;

      // Approbateur hors Direction : sa propre demande, refusée avec ou sans le marqueur (avant MP-07,
      // le marqueur suffisait).
      const ownRequest = await selfRequest(approver);
      expect(codeOf(await approve(approver, approverDevice, ownRequest))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );
      expect(codeOf(await approve(approver, approverDevice, ownRequest, true))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );

      // Direction (rôle réel du seed) qui détient aussi l'approbation : marqueur exigé, puis permis.
      const director = await db.transaction().execute((trx) => insertTestUser(trx));
      const directorDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, director, { status: 'ACTIVE' }));
      const directionRole = await db
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', 'DIRECTION')
        .executeTakeFirstOrThrow();
      await db
        .transaction()
        .execute((trx) =>
          assignTestRole(trx, director, fromBin(directionRole.id), admin, { scopeType: 'GLOBAL' }),
        );
      const directorRequest = await selfRequest(director);
      expect(codeOf(await approve(director, directorDevice, directorRequest))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );
      expect(codeOf(await approve(director, directorDevice, directorRequest, true))).toBe(
        'APPLIED',
      );
      const row = await db
        .selectFrom('approvals_approval_requests')
        .select('self_approved')
        .where('id', '=', toBin(directorRequest))
        .executeTakeFirstOrThrow();
      expect(row.self_approved).toBe(1);

      // MP-11 (AV-295) : Direction jusqu'à 10:00 seulement (droit d'approuver gardé par un autre rôle) ;
      // sa décision datée de 09:00, reçue ensuite, ne vaut plus auto-validation.
      const former = await db.transaction().execute((trx) => insertTestUser(trx));
      const formerDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, former, { status: 'ACTIVE' }));
      await db.transaction().execute(async (trx) => {
        const role = await insertTestRole(trx, former, { allowedScopeTypes: ['SITE'] });
        await grantTestPermission(trx, role, 'approvals.request.read', admin, { maxScope: 'ALL' });
        await grantTestPermission(trx, role, APPROVE_PERMISSION, admin, { maxScope: 'SITE' });
        await assignTestRole(trx, former, role, admin, { scopeType: 'SITE', scopeSiteId: siteId });
        await assignTestRole(trx, former, fromBin(directionRole.id), admin, {
          scopeType: 'GLOBAL',
          validFrom: new Date('2026-09-01T00:00:00.000Z'),
          validTo: new Date('2026-09-25T10:00:00.000Z'),
        });
      });
      const formerRequest = await selfRequest(former);
      expect(codeOf(await approve(former, formerDevice, formerRequest, true))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );
    });

    it('approve : pièce jointe requise non AVAILABLE → REJECTED ATTACHMENT_MISSING (BR-ADM-020)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const attachmentId = freshUuid();
      await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'attachments.attachment.register',
          authorUserId: requester,
          aggregateType: 'ATTACHMENT',
          aggregateId: attachmentId,
          payload: {
            ownerType: 'STOCK_LOSS',
            ownerId: freshUuid(),
            kind: 'PHOTO',
            mimeType: 'image/jpeg',
            sizeBytes: 100,
            sha256: 'b'.repeat(64),
            capturedAt: OCCURRED_AT,
          },
        }),
        {
          authenticatedUserId: requester,
          authenticatedDeviceId: requesterDevice,
          transport: 'ONLINE_API',
        },
      );

      const requestId = await createPendingRequest(policyId, [attachmentId]);
      const blocked = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(blocked.status).toBe('REJECTED');
      expect(blocked.status === 'REJECTED' && blocked.error.code).toBe('ATTACHMENT_MISSING');

      // La pièce devient AVAILABLE (hors flux d'upload HTTP, écriture directe pour ce test) :
      // la même demande peut alors être approuvée.
      await db
        .updateTable('attachments_attachments')
        .set({ upload_status: 'AVAILABLE' })
        .where('id', '=', toBin(attachmentId))
        .execute();
      const unblocked = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(unblocked.status).toBe('APPLIED');
    });

    it('revue de MP-10 (AV-290) : pièce exigée refusée ou jamais enregistrée — remplacée par une nouvelle pièce du même document', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const lossId = freshUuid();
      const insertPiece = async (
        id: string,
        kind: string,
        status: string,
        owner = lossId,
        author = requester,
      ) =>
        db
          .insertInto('attachments_attachments')
          .values({
            id: toBin(id),
            owner_type: 'STOCK_LOSS',
            owner_id: toBin(owner),
            kind,
            mime_type: 'image/jpeg',
            size_bytes: 100,
            uploaded_bytes: 100,
            sha256: 'c'.repeat(64),
            storage_key: `test/${id}`,
            upload_status: status,
            captured_at: new Date(OCCURRED_AT),
            occurred_at: new Date(OCCURRED_AT),
            created_by: toBin(author),
          })
          .execute();
      const approve = async (requestId: string) => {
        const result = await pipeline.handle(
          buildCommand({
            commandId: freshUuid(),
            commandType: 'approvals.request.approve',
            authorUserId: approver,
            aggregateType: 'APPROVAL_REQUEST',
            aggregateId: requestId,
            payload: { requestId },
          }),
          {
            authenticatedUserId: approver,
            authenticatedDeviceId: approverDevice,
            transport: 'ONLINE_API',
          },
        );
        return result.status === 'REJECTED' ? result.error.code : result.status;
      };

      // Pièce exigée en quarantaine : une autre nature, ou une pièce d'un autre document, ne suffit pas.
      const quarantined = freshUuid();
      await insertPiece(quarantined, 'PHOTO', 'QUARANTINED');
      const requestId = await createPendingRequest(policyId, [quarantined], lossId);
      await insertPiece(freshUuid(), 'OTHER', 'AVAILABLE');
      await insertPiece(freshUuid(), 'PHOTO', 'AVAILABLE', freshUuid());
      // Revue de P8E-05 : la photo d'un autre utilisateur, même reçue, ne remplace pas celle de l'auteur.
      await insertPiece(freshUuid(), 'PHOTO', 'AVAILABLE', lossId, approver);
      expect(await approve(requestId)).toBe('ATTACHMENT_MISSING');
      // Nouvelle photo reçue du même document : elle remplace la pièce exigée.
      await insertPiece(freshUuid(), 'PHOTO', 'AVAILABLE');
      expect(await approve(requestId)).toBe('APPLIED');

      // Pièce exigée jamais enregistrée : toute pièce reçue du document la remplace.
      const otherLoss = freshUuid();
      const unknown = await createPendingRequest(policyId, [freshUuid()], otherLoss);
      expect(await approve(unknown)).toBe('ATTACHMENT_MISSING');
      await insertPiece(freshUuid(), 'OTHER', 'AVAILABLE', otherLoss, approver);
      expect(await approve(unknown)).toBe('ATTACHMENT_MISSING');
      await insertPiece(freshUuid(), 'OTHER', 'AVAILABLE', otherLoss);
      expect(await approve(unknown)).toBe('APPLIED');
    });

    it('reject : commentaire obligatoire (VALIDATION_ERROR si absent), puis rejet effectif avec motif', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const requestId = await createPendingRequest(policyId);

      const missingComment = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.reject',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(missingComment.status).toBe('REJECTED');
      expect(missingComment.status === 'REJECTED' && missingComment.error.code).toMatch(
        /^VALIDATION_ERROR/,
      );

      const rejected = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.reject',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: {
            requestId,
            comment: 'Perte non justifiée',
            decisionOption: 'PERTE_NON_JUSTIFIEE',
          },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(rejected.status).toBe('APPLIED');
      const row = await db
        .selectFrom('approvals_approval_requests')
        .select(['status', 'decision_comment'])
        .where('id', '=', toBin(requestId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('REJECTED');
      expect(row.decision_comment).toBe('Perte non justifiée');
    });

    it('withdraw : seul le demandeur peut retirer sa demande PENDING', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const requestId = await createPendingRequest(policyId);

      const forbidden = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.withdraw',
          authorUserId: outsider,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: outsider,
          authenticatedDeviceId: outsiderDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(forbidden.status).toBe('REJECTED');
      expect(forbidden.status === 'REJECTED' && forbidden.error.code).toBe('FORBIDDEN');

      const withdrawn = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.withdraw',
          authorUserId: requester,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: requester,
          authenticatedDeviceId: requesterDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(withdrawn.status).toBe('APPLIED');
      const row = await db
        .selectFrom('approvals_approval_requests')
        .select(['status', 'decided_by', 'decided_at'])
        .where('id', '=', toBin(requestId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('CANCELLED');
      expect(row.decided_by).toBeNull(); // ck_approvals_approval_requests_decision
      expect(row.decided_at).toBeNull();
    });

    it('approve sur une demande déjà décidée → REJECTED APPROVAL_NOT_PENDING (immuabilité post-décision)', async () => {
      const policyId = await setPolicy(`TEST_POLICY_${freshUuid().slice(-8)}`);
      const requestId = await createPendingRequest(policyId);
      await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );

      const second = await pipeline.handle(
        buildCommand({
          commandId: freshUuid(),
          commandType: 'approvals.request.approve',
          authorUserId: approver,
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          payload: { requestId },
        }),
        {
          authenticatedUserId: approver,
          authenticatedDeviceId: approverDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(second.status).toBe('REJECTED');
      expect(second.status === 'REJECTED' && second.error.code).toBe('APPROVAL_NOT_PENDING');
    });
  });
});
