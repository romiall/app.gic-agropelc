/**
 * P9-11 (3/3) : les producteurs des notifications directes (AV-439, AV-480) et la chaîne entière, à travers
 * les vraies fonctions et commandes des modules propriétaires, la vraie base et le vrai résolveur de
 * destinataires : `ApprovalRequested` (`requestApproval`), `ApprovalGranted` et `ApprovalRejected` (décision),
 * `StockTransferRequested` et `StockTransferDispatched` (commandes de transfert). Chaque événement est lu dans
 * `platform_domain_events`, puis traité par le consommateur `communication.direct` dans une transaction
 * annulée. La base est partagée : on ne juge que ses propres utilisateurs (d'autres titulaires de la même
 * permission peuvent exister).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { IdentityRecipientResolver } from '../src/communication-api/identity-recipient-resolver.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { createDirectNotificationHandler } from '../src/modules/communication/application/events/direct-notifications-consumer.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { requestApproval } from '../src/modules/approvals/application/public/request-approval.js';
import { deterministicEventId } from '../src/platform/events/deterministic-event-id.js';
import { toDomainEvent, type DomainEvent } from '../src/platform/events/domain-event.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { rolledBack } from './communication-test-kit.js';
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
import {
  at,
  createTransferWorld,
  dispatch,
  linesOf,
  newPair,
  newProduct,
  send,
  stock,
  type TransferWorld,
} from './transfer-world.js';

afterAll(closeTestDb);

const NOW = new Date('2026-11-02T10:00:00.000Z');
const APPROVE_PERMISSION = 'inventory.loss.approve';
const resolver = new IdentityRecipientResolver();

async function eventsOf(
  aggregateId: string,
  eventType?: string,
): Promise<readonly DomainEvent<Record<string, unknown>>[]> {
  const rows = await db
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('aggregate_id', '=', toBin(aggregateId))
    .$if(eventType !== undefined, (qb) => qb.where('event_type', '=', eventType!))
    .orderBy('seq', 'asc')
    .execute();
  return rows
    .filter((row) =>
      [
        'ApprovalRequested',
        'ApprovalGranted',
        'ApprovalRejected',
        'StockTransferRequested',
        'StockTransferDispatched',
      ].includes(row.event_type),
    )
    .map((row) => toDomainEvent<Record<string, unknown>>(row));
}

/** Les destinataires que le consommateur désignerait pour cet événement (transaction annulée). */
async function recipientsOfEvent(event: DomainEvent): Promise<readonly string[]> {
  const handle = createDirectNotificationHandler({
    idGenerator: new Uuidv7Generator(new FixedClock(NOW)),
    clock: new FixedClock(NOW),
    resolver,
  });
  return rolledBack(async (uow: UnitOfWork) => {
    await handle(uow, event);
    const rows = await uow
      .selectFrom('communication_notifications')
      .select('user_id')
      .where('source_event_id', '=', toBin(event.eventId))
      .execute();
    return rows.map((row) => fromBin(row.user_id));
  });
}

describe('P9-11 (3/3) : demandes de validation', () => {
  const clock = new FixedClock(NOW);
  const idGenerator = new Uuidv7Generator(clock);
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let requester: string;
  let requesterDevice: string;
  let approver: string;
  let approverDevice: string;
  let otherSiteApprover: string;
  let siteId: string;
  let policyId: string;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, new ApprovalDecisionHandlerRegistry());
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
    otherSiteApprover = await db.transaction().execute((trx) => insertTestUser(trx));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const otherSiteId = await insertTestSite(trx, admin, await insertTestZone(trx, admin));

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin, {
        maxScope: 'ALL',
      });
      await assignTestRole(trx, admin, adminRole, admin);

      const requesterRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, requesterRole, 'approvals.request.read', admin, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, requester, requesterRole, admin);

      const approverRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
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
      await assignTestRole(trx, otherSiteApprover, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: otherSiteId,
      });
    });

    policyId = freshUuid();
    const policy = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_type: 'approvals.policy.set',
        command_version: 1,
        author_user_id: admin,
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        base_version: null,
        depends_on: [],
        occurred_at: NOW.toISOString(),
        client_created_at: NOW.toISOString(),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          code: `P911_DIRECT_${policyId.slice(-8)}`,
          operationType: 'LOSS_DECLARATION',
          requiresApproval: true,
          approverPermission: APPROVE_PERMISSION,
          approverScope: 'SITE',
        },
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(policy.status).toBe('APPLIED');
  });

  async function createRequest(): Promise<string> {
    const requestId = freshUuid();
    await db.transaction().execute((trx) =>
      requestApproval(trx, {
        requestId,
        operationType: 'LOSS_DECLARATION',
        subjectType: 'STOCK_LOSS',
        subjectId: freshUuid(),
        subjectSummary: 'Perte valorisée 540 000 XAF',
        amountXaf: 540_000,
        siteId,
        requestedBy: requester,
        requestedAt: NOW,
        policyId,
        policyVersion: 1,
      }),
    );
    return requestId;
  }

  let deviceSeq = 100;
  const decide = (
    requestId: string,
    kind: 'approve' | 'reject',
    payload: Record<string, unknown> = {},
  ) =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: deviceSeq++,
        command_type: `approvals.request.${kind}`,
        command_version: 1,
        author_user_id: approver,
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        base_version: null,
        depends_on: [],
        occurred_at: NOW.toISOString(),
        client_created_at: NOW.toISOString(),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId, ...payload },
      },
      {
        authenticatedUserId: approver,
        authenticatedDeviceId: approverDevice,
        transport: 'ONLINE_API',
      },
    );

  it('la demande publie ApprovalRequested, une seule fois, et prévient les approbateurs de son site', async () => {
    const requestId = await createRequest();
    const events = await eventsOf(requestId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      eventType: 'ApprovalRequested',
      producerModule: 'approvals',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: requestId,
      eventId: deterministicEventId('ApprovalRequested', requestId),
      occurredAt: NOW,
    });
    expect(event!.payload).toMatchObject({
      approval_id: requestId,
      operation_type: 'LOSS_DECLARATION',
      subject_type: 'STOCK_LOSS',
      amount_xaf: 540_000,
      site_id: siteId,
      zone_id: null,
      requester_user_id: requester,
      approver_permission: APPROVE_PERMISSION,
      requested_at: NOW.toISOString(),
    });
    // Le résumé de la demande (qui peut porter une valeur au coût) ne sort jamais dans l'événement.
    expect(JSON.stringify(event!.payload)).not.toContain('Perte valorisée');

    const recipients = await recipientsOfEvent(event!);
    expect(recipients).toContain(approver);
    expect(recipients).not.toContain(otherSiteApprover);
    expect(recipients).not.toContain(requester);
  });

  it('une demande annulée avec sa transaction ne publie rien', async () => {
    const requestId = freshUuid();
    await expect(
      db.transaction().execute(async (trx) => {
        await requestApproval(trx, {
          requestId,
          operationType: 'LOSS_DECLARATION',
          subjectType: 'STOCK_LOSS',
          subjectId: freshUuid(),
          subjectSummary: 'Perte annulée',
          siteId,
          requestedBy: requester,
          requestedAt: NOW,
          policyId,
          policyVersion: 1,
        });
        throw new Error('échec simulé de l’opération propriétaire');
      }),
    ).rejects.toThrow('échec simulé');
    expect(await eventsOf(requestId)).toEqual([]);
  });

  it('l’approbation publie ApprovalGranted, une seule fois, et prévient le demandeur', async () => {
    const requestId = await createRequest();
    const done = await decide(requestId, 'approve', { decisionOption: 'PERTE_CONFIRMEE' });
    expect(done.status).toBe('APPLIED');

    const granted = await eventsOf(requestId, 'ApprovalGranted');
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      producerModule: 'approvals',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: requestId,
      eventId: deterministicEventId('ApprovalGranted', requestId),
      occurredAt: NOW,
    });
    expect(granted[0]!.payload).toMatchObject({
      approval_id: requestId,
      operation_type: 'LOSS_DECLARATION',
      site_id: siteId,
      requester_user_id: requester,
      decision: 'APPROVED',
      decision_option: 'PERTE_CONFIRMEE',
      decided_by: approver,
      comment: null,
    });
    expect(JSON.stringify(granted[0]!.payload)).not.toContain('Perte valorisée');
    expect(await recipientsOfEvent(granted[0]!)).toEqual([requester]);

    // Une seconde décision est refusée : pas d'autre événement, la première n'est pas défaite.
    const again = await decide(requestId, 'reject', { comment: 'Trop tard' });
    expect(again.status).toBe('REJECTED');
    expect(await eventsOf(requestId, 'ApprovalGranted')).toHaveLength(1);
    expect(await eventsOf(requestId, 'ApprovalRejected')).toEqual([]);
  });

  it('le refus publie ApprovalRejected avec son motif, que le demandeur reçoit', async () => {
    const requestId = await createRequest();
    const done = await decide(requestId, 'reject', { comment: '  Perte non justifiée ' });
    expect(done.status).toBe('APPLIED');

    const rejected = await eventsOf(requestId, 'ApprovalRejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({
      decision: 'REJECTED',
      decided_by: approver,
      requester_user_id: requester,
      comment: 'Perte non justifiée',
    });
    expect(await eventsOf(requestId, 'ApprovalGranted')).toEqual([]);
    expect(await recipientsOfEvent(rejected[0]!)).toEqual([requester]);

    const stored = await rolledBack(async (uow) => {
      await createDirectNotificationHandler({
        idGenerator: new Uuidv7Generator(new FixedClock(NOW)),
        clock: new FixedClock(NOW),
        resolver,
      })(uow, rejected[0]!);
      return uow
        .selectFrom('communication_notifications')
        .select(['title', 'body'])
        .where('user_id', '=', toBin(requester))
        .where('source_event_id', '=', toBin(rejected[0]!.eventId))
        .executeTakeFirstOrThrow();
    });
    expect(stored).toEqual({
      title: 'Validation refusée',
      body: 'Votre demande (Perte) a été refusée. Motif : Perte non justifiée',
    });
  });

  it('le retrait de la demande ne prévient personne', async () => {
    const requestId = await createRequest();
    const withdrawn = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: deviceSeq++,
        command_type: 'approvals.request.withdraw',
        command_version: 1,
        author_user_id: requester,
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        base_version: null,
        depends_on: [],
        occurred_at: NOW.toISOString(),
        client_created_at: NOW.toISOString(),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId },
      },
      {
        authenticatedUserId: requester,
        authenticatedDeviceId: requesterDevice,
        transport: 'ONLINE_API',
      },
    );
    expect(withdrawn.status).toBe('APPLIED');
    const row = await db
      .selectFrom('approvals_approval_requests')
      .select('status')
      .where('id', '=', toBin(requestId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('CANCELLED');
    expect(await eventsOf(requestId, 'ApprovalGranted')).toEqual([]);
    expect(await eventsOf(requestId, 'ApprovalRejected')).toEqual([]);
  });
});

describe('P9-11 (3/3) : transferts', () => {
  let world: TransferWorld;

  beforeAll(async () => {
    world = await createTransferWorld();
  });

  const transferCommand = (
    actor: TransferWorld['keeper'],
    type: string,
    transferId: string,
    payload: unknown,
  ) => send(world, actor, type, transferId, payload, { occurredAt: at('09:00') });

  it('la demande publie StockTransferRequested et prévient les expéditeurs du site source', async () => {
    const pair = await newPair(world);
    const product = await newProduct(world);
    await stock(world, product, pair.store, 100);

    const transferId = freshUuid();
    const result = await transferCommand(world.seller, 'inventory.transfer.request', transferId, {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId: product, unitCode: 'TETE', quantityBase: 40 }],
    });
    expect(result.status).toBe('APPLIED');

    const events = await eventsOf(transferId);
    expect(events).toHaveLength(1);
    const [event] = events;
    const header = await db
      .selectFrom('inventory_stock_transfers')
      .select('doc_number')
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      eventType: 'StockTransferRequested',
      producerModule: 'inventory',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: transferId,
      eventId: deterministicEventId('StockTransferRequested', transferId),
    });
    expect(event!.payload).toMatchObject({
      transfer_id: transferId,
      doc_number: header.doc_number,
      from_location_id: pair.store,
      to_location_id: pair.pos,
      from_site_id: world.storeSite,
      to_site_id: world.pdvSite,
      line_count: 1,
      requested_by: world.seller.userId,
    });
    expect(event!.commandId).not.toBeNull();

    const recipients = await recipientsOfEvent(event!);
    expect(recipients).toContain(world.keeper.userId);
    expect(recipients).not.toContain(world.seller.userId);
    expect(recipients).not.toContain(world.approver.userId);
  });

  it('l’expédition d’une demande publie StockTransferDispatched et prévient les réceptionnaires du site destinataire', async () => {
    const pair = await newPair(world);
    const product = await newProduct(world);
    await stock(world, product, pair.store, 100);
    const transferId = freshUuid();
    await transferCommand(world.seller, 'inventory.transfer.request', transferId, {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId: product, unitCode: 'TETE', quantityBase: 40 }],
    });
    const [line] = await linesOf(transferId);

    const result = await transferCommand(world.keeper, 'inventory.transfer.dispatch', transferId, {
      transferId,
      lines: [
        {
          transferLineId: fromBin(line!.id),
          productId: product,
          unitCode: 'TETE',
          quantityBase: 40,
        },
      ],
    });
    expect(result.status).toBe('APPLIED');

    const dispatched = await eventsOf(transferId, 'StockTransferDispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      producerModule: 'inventory',
      eventId: deterministicEventId('StockTransferDispatched', transferId),
    });
    expect(dispatched[0]!.payload).toMatchObject({
      transfer_id: transferId,
      from_location_id: pair.store,
      to_location_id: pair.pos,
      from_site_id: world.storeSite,
      to_site_id: world.pdvSite,
      line_count: 1,
      dispatched_by: world.keeper.userId,
    });
    // La demande reste publiée à côté : deux faits, deux événements.
    expect(await eventsOf(transferId, 'StockTransferRequested')).toHaveLength(1);

    const recipients = await recipientsOfEvent(dispatched[0]!);
    expect(recipients).toContain(world.seller.userId);
    expect(recipients).not.toContain(world.keeper.userId);
  });

  it('une expédition directe publie StockTransferDispatched ; refusée, elle ne publie rien', async () => {
    const pair = await newPair(world);
    const product = await newProduct(world);
    await stock(world, product, pair.store, 10);

    const direct = await dispatch(world, pair, product, 4);
    expect(direct.result.status).toBe('APPLIED');
    const events = await eventsOf(direct.transferId);
    expect(events.map((event) => event.eventType)).toEqual(['StockTransferDispatched']);
    expect(events[0]!.payload).toMatchObject({ dispatched_by: world.keeper.userId, line_count: 1 });

    // Plus que le stock : la commande est refusée en ligne, sa transaction annulée, aucun événement.
    const refused = await dispatch(world, pair, product, 500);
    expect(refused.result.status).not.toBe('APPLIED');
    expect(await eventsOf(refused.transferId)).toEqual([]);
  });

  it('une commande rejouée à l’identique ne publie pas deux fois', async () => {
    const pair = await newPair(world);
    const product = await newProduct(world);
    await stock(world, product, pair.store, 10);
    const transferId = freshUuid();
    const commandId = freshUuid();
    const options = { occurredAt: at('09:00'), commandId, deviceSeq: 987_654 };
    const payload = {
      fromLocationId: pair.store,
      toLocationId: pair.pos,
      lines: [{ productId: product, unitCode: 'TETE', quantityBase: 3 }],
    };
    const first = await send(
      world,
      world.keeper,
      'inventory.transfer.dispatch',
      transferId,
      payload,
      options,
    );
    const second = await send(
      world,
      world.keeper,
      'inventory.transfer.dispatch',
      transferId,
      payload,
      options,
    );
    expect(first.status).toBe('APPLIED');
    expect(second.status).toBe('APPLIED');
    expect(await eventsOf(transferId, 'StockTransferDispatched')).toHaveLength(1);
  });
});
