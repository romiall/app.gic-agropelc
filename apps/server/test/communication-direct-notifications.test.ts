/**
 * P9-11 (3/3) : consommateur `communication.direct` (AV-439, AV-480, AV-481 ; ADR-072 §4). Le résolveur est un
 * double contrôlé qui enregistre ses appels (la résolution par permission et périmètre est testée avec
 * l'adaptateur réel dans `communication-recipients.test.ts` et de bout en bout dans
 * `communication-direct-events.test.ts`) ; les utilisateurs et les notifications sont réels. Chaque test
 * s'exécute dans une transaction annulée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DirectNotificationPayloadError, FixedClock, Uuidv7Generator } from '@gic/domain';
import type { DomainEvent } from '../src/platform/events/domain-event.js';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import {
  DIRECT_CONSUMER_NAME,
  DIRECT_DISABLED_TYPES_KEY,
  createDirectNotificationHandler,
  registerDirectNotificationsConsumer,
} from '../src/modules/communication/application/events/direct-notifications-consumer.js';
import type {
  AlertRecipientResolver,
  RecipientPerimeter,
  RoleHolder,
} from '../src/modules/communication/application/recipients/recipient-resolver.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { tx } from './cash-transfer-fixtures.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, freshUuid, insertTestUser } from './helpers.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(new FixedClock(NOW));

/** Résolveur contrôlé : titulaires de la permission et de la Direction fixés par le test, appels consignés. */
class StubResolver implements AlertRecipientResolver {
  readonly holderCalls: {
    permission: string;
    excludeUserIds: readonly string[];
    perimeter: RecipientPerimeter;
    at: Date;
  }[] = [];
  readonly roleCalls: { roles: string[]; perimeter: RecipientPerimeter; at: Date }[] = [];
  readonly activeCalls: { userIds: readonly string[]; at: Date }[] = [];
  inactive = new Set<string>();

  constructor(
    public holders: readonly string[] = [],
    public direction: readonly string[] = [],
  ) {}

  async usersHoldingRolesAt(
    _uow: UnitOfWork,
    input: {
      readonly roles: readonly string[];
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
    },
  ): Promise<readonly RoleHolder[]> {
    this.roleCalls.push({ roles: [...input.roles], perimeter: input.perimeter, at: input.at });
    return input.roles.includes('DIRECTION')
      ? this.direction.map((userId) => ({ userId, roleCode: 'DIRECTION' }))
      : [];
  }

  async usersHoldingPermissionAt(
    _uow: UnitOfWork,
    input: {
      readonly permission: string;
      readonly excludeUserIds: readonly string[];
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
    },
  ): Promise<readonly string[]> {
    this.holderCalls.push({
      permission: input.permission,
      excludeUserIds: input.excludeUserIds,
      perimeter: input.perimeter,
      at: input.at,
    });
    // Contrat du port : les utilisateurs exclus ne sont jamais renvoyés.
    return this.holders.filter((id) => !input.excludeUserIds.includes(id));
  }

  async activeUsersAmong(
    _uow: UnitOfWork,
    userIds: readonly string[],
    at: Date,
  ): Promise<readonly string[]> {
    this.activeCalls.push({ userIds, at });
    return userIds.filter((id) => !this.inactive.has(id));
  }

  async teamManagersOf(): Promise<readonly string[]> {
    return [];
  }
}

let seq = 9_600_000_000;
function eventOf(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  eventId = freshUuid(),
): DomainEvent {
  seq += 1;
  return {
    seq,
    eventId,
    eventType,
    eventVersion: 1,
    producerModule: 'test',
    aggregateType: 'TEST',
    aggregateId,
    occurredAt: new Date('2026-11-02T09:00:00.000Z'),
    recordedAt: new Date('2026-11-02T09:00:00.000Z'),
    payload,
    commandId: null,
    correlationId: null,
    causationId: null,
  };
}

const notificationsOf = (uow: UnitOfWork, userId: string) =>
  uow
    .selectFrom('communication_notifications')
    .selectAll()
    .where('user_id', '=', toBin(userId))
    .orderBy('created_at', 'asc')
    .execute();

const newUser = () => tx((trx) => insertTestUser(trx));
const handle = (resolver: AlertRecipientResolver) =>
  createDirectNotificationHandler({ idGenerator, clock, resolver });

describe('P9-11 (3/3) : consommateur des notifications directes', () => {
  let requester: string;
  let approverA: string;
  let approverB: string;
  let direction: string;
  let bystander: string;

  beforeAll(async () => {
    requester = await newUser();
    approverA = await newUser();
    approverB = await newUser();
    direction = await newUser();
    bystander = await newUser();
  });

  afterAll(closeTestDb);

  const requested = (extra: Record<string, unknown> = {}, siteId = freshUuid()) => {
    const approvalId = freshUuid();
    return eventOf('ApprovalRequested', approvalId, {
      approval_id: approvalId,
      operation_type: 'LOSS_DECLARATION',
      requester_user_id: requester,
      approver_permission: 'inventory.loss.approve',
      site_id: siteId,
      zone_id: null,
      ...extra,
    });
  };
  const decided = (type: 'ApprovalGranted' | 'ApprovalRejected', extra = {}) => {
    const approvalId = freshUuid();
    return eventOf(type, approvalId, {
      approval_id: approvalId,
      operation_type: 'PURCHASE_REQUEST',
      requester_user_id: requester,
      decided_by: approverA,
      ...extra,
    });
  };

  describe('demande de validation', () => {
    it('prévient les approbateurs de la politique, sur le périmètre de la demande, le demandeur exclu', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA, approverB, requester]);
        const site = freshUuid();
        const zone = freshUuid();
        const event = requested({ site_id: site, zone_id: zone });
        expect(await handle(resolver)(uow, event)).toBe(2);

        expect(resolver.holderCalls).toEqual([
          {
            permission: 'inventory.loss.approve',
            excludeUserIds: [requester],
            perimeter: { siteId: site, zoneId: zone, ownerUserIds: [requester] },
            at: NOW,
          },
        ]);
        for (const user of [approverA, approverB]) {
          const rows = await notificationsOf(uow, user);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            channel: 'IN_APP',
            kind: 'DIRECT',
            title: 'Validation à donner',
            body: 'Perte : une demande attend votre décision.',
            link: null,
            alert_id: null,
            alert_type: null,
            note_id: null,
            source_type: 'APPROVAL_REQUEST',
            created_at: NOW,
            delivered_at: NOW,
            read_at: null,
          });
          expect(fromBin(rows[0]!.source_id!)).toBe(event.aggregateId);
          expect(fromBin(rows[0]!.source_event_id!)).toBe(event.eventId);
        }
        expect(await notificationsOf(uow, requester)).toEqual([]);
        expect(await notificationsOf(uow, bystander)).toEqual([]);
        // Des approbateurs existent : la Direction n'est pas consultée.
        expect(resolver.roleCalls).toEqual([]);
      }));

    it('sans approbateur sur le périmètre, la Direction reçoit à leur place (jamais le demandeur)', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([], [requester, direction]);
        const site = freshUuid();
        const event = requested({ site_id: site });
        expect(await handle(resolver)(uow, event)).toBe(1);

        expect(resolver.holderCalls).toHaveLength(1);
        expect(resolver.roleCalls).toEqual([
          {
            roles: ['DIRECTION'],
            perimeter: { siteId: site, zoneId: null, ownerUserIds: [requester] },
            at: NOW,
          },
        ]);
        expect(await notificationsOf(uow, direction)).toHaveLength(1);
        expect(await notificationsOf(uow, requester)).toEqual([]);
      }));

    it('une politique sans permission d’approbation va directement à la Direction', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA], [direction]);
        for (const permission of [null, undefined]) {
          const event = requested({ approver_permission: permission });
          expect(await handle(resolver)(uow, event)).toBe(1);
        }
        expect(resolver.holderCalls).toEqual([]);
        expect(resolver.roleCalls).toHaveLength(2);
        expect(await notificationsOf(uow, approverA)).toEqual([]);
        expect(await notificationsOf(uow, direction)).toHaveLength(2);
      }));

    it('ni approbateur ni Direction : aucune notification, aucune erreur', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([], []);
        expect(await handle(resolver)(uow, requested())).toBe(0);
        expect(resolver.roleCalls).toHaveLength(1);
      }));
  });

  describe('décision', () => {
    it('accordée : le demandeur seul, sans consulter les titulaires de permission', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverB], [direction]);
        const event = decided('ApprovalGranted');
        expect(await handle(resolver)(uow, event)).toBe(1);

        expect(resolver.activeCalls).toEqual([{ userIds: [requester], at: NOW }]);
        expect(resolver.holderCalls).toEqual([]);
        expect(resolver.roleCalls).toEqual([]);
        const rows = await notificationsOf(uow, requester);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: 'DIRECT',
          title: 'Validation accordée',
          body: 'Votre demande (Demande d’achat) a été approuvée.',
          source_type: 'APPROVAL_REQUEST',
        });
        expect(fromBin(rows[0]!.source_id!)).toBe(event.aggregateId);
        expect(await notificationsOf(uow, approverA)).toEqual([]);
      }));

    it('refusée : avec le motif de l’approbateur', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver();
        await handle(resolver)(uow, decided('ApprovalRejected', { comment: 'Budget épuisé' }));
        const rows = await notificationsOf(uow, requester);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: 'Validation refusée',
          body: 'Votre demande (Demande d’achat) a été refusée. Motif : Budget épuisé',
        });
      }));

    it('un demandeur désactivé n’est pas prévenu', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver();
        resolver.inactive.add(requester);
        expect(await handle(resolver)(uow, decided('ApprovalGranted'))).toBe(0);
        expect(await notificationsOf(uow, requester)).toEqual([]);
      }));

    it('le demandeur qui a décidé lui-même (Direction) n’est pas prévenu de son propre acte', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver();
        expect(
          await handle(resolver)(uow, decided('ApprovalGranted', { decided_by: requester })),
        ).toBe(0);
        expect(await notificationsOf(uow, requester)).toEqual([]);
      }));
  });

  describe('transferts', () => {
    const transfer = (
      type: 'StockTransferRequested' | 'StockTransferDispatched',
      extra: Record<string, unknown> = {},
    ) => {
      const transferId = freshUuid();
      return eventOf(type, transferId, {
        transfer_id: transferId,
        doc_number: 'TRF-FRM-2026-000012',
        from_site_id: freshUuid(),
        to_site_id: freshUuid(),
        requested_by: requester,
        dispatched_by: requester,
        ...extra,
      });
    };

    it('demandé : les expéditeurs du site source, le demandeur exclu', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA, requester]);
        const source = freshUuid();
        const event = transfer('StockTransferRequested', { from_site_id: source });
        expect(await handle(resolver)(uow, event)).toBe(1);

        expect(resolver.holderCalls).toEqual([
          {
            permission: 'inventory.transfer.dispatch',
            excludeUserIds: [requester],
            perimeter: { siteId: source, zoneId: null, ownerUserIds: [] },
            at: NOW,
          },
        ]);
        const rows = await notificationsOf(uow, approverA);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: 'DIRECT',
          title: 'Transfert à expédier',
          body: 'Le transfert TRF-FRM-2026-000012 est demandé : à préparer et à expédier.',
          source_type: 'STOCK_TRANSFER',
        });
        expect(fromBin(rows[0]!.source_id!)).toBe(event.aggregateId);
        expect(await notificationsOf(uow, requester)).toEqual([]);
      }));

    it('expédié : les réceptionnaires du site destinataire, l’expéditeur exclu', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverB, requester]);
        const target = freshUuid();
        const event = transfer('StockTransferDispatched', { to_site_id: target });
        expect(await handle(resolver)(uow, event)).toBe(1);

        expect(resolver.holderCalls).toEqual([
          {
            permission: 'inventory.transfer.receive',
            excludeUserIds: [requester],
            perimeter: { siteId: target, zoneId: null, ownerUserIds: [] },
            at: NOW,
          },
        ]);
        const rows = await notificationsOf(uow, approverB);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: 'Transfert en route',
          body: 'Le transfert TRF-FRM-2026-000012 est expédié vers votre site.',
          source_type: 'STOCK_TRANSFER',
        });
      }));

    it('personne ne détient la permission : aucune notification, et la Direction n’est pas dérangée', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([], [direction]);
        expect(await handle(resolver)(uow, transfer('StockTransferDispatched'))).toBe(0);
        expect(resolver.roleCalls).toEqual([]);
        expect(await notificationsOf(uow, direction)).toEqual([]);
      }));
  });

  describe('rejeu, désactivation et charges fautives', () => {
    it('un événement rejoué ne double rien ; un autre événement du même objet notifie à nouveau', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA]);
        const first = requested();
        expect(await handle(resolver)(uow, first)).toBe(1);
        expect(await handle(resolver)(uow, first)).toBe(0);
        expect(await notificationsOf(uow, approverA)).toHaveLength(1);

        const other = eventOf(first.eventType, first.aggregateId, first.payload as never);
        expect(await handle(resolver)(uow, other)).toBe(1);
        expect(await notificationsOf(uow, approverA)).toHaveLength(2);
      }));

    it('un type désactivé par le réglage n’est pas notifié, les autres le restent', () =>
      rolledBack(async (uow) => {
        const root = await newUser();
        await uow
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key: DIRECT_DISABLED_TYPES_KEY,
            value: jsonValue(['ApprovalGranted']),
            scope_type: 'GLOBAL',
            scope_id: null,
            valid_from: NOW,
            is_client_visible: 0,
            reason: 'Réglage de test P9-11',
            created_by: toBin(root),
          })
          .execute();
        const resolver = new StubResolver([approverA]);
        expect(await handle(resolver)(uow, decided('ApprovalGranted'))).toBe(0);
        expect(resolver.activeCalls).toEqual([]);
        expect(await handle(resolver)(uow, decided('ApprovalRejected'))).toBe(1);
        expect(await handle(resolver)(uow, requested())).toBe(1);
        expect(await notificationsOf(uow, requester)).toHaveLength(1);
      }));

    it('un autre type d’événement est ignoré sans toucher au résolveur', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA], [direction]);
        expect(await handle(resolver)(uow, eventOf('AlertRaised', freshUuid(), {}))).toBe(0);
        expect(await handle(resolver)(uow, eventOf('InternalNotePublished', freshUuid(), {}))).toBe(
          0,
        );
        expect(resolver.holderCalls).toEqual([]);
        expect(resolver.roleCalls).toEqual([]);
        expect(resolver.activeCalls).toEqual([]);
      }));

    it('une charge qui ne tient pas son contrat lève : l’échec sera consigné, jamais tu', () =>
      rolledBack(async (uow) => {
        const resolver = new StubResolver([approverA], [direction]);
        const broken = eventOf('ApprovalGranted', freshUuid(), { operation_type: 'EXPENSE' });
        await expect(handle(resolver)(uow, broken)).rejects.toThrow(DirectNotificationPayloadError);
        expect(resolver.activeCalls).toEqual([]);
      }));
  });

  describe('enregistrement', () => {
    it('le consommateur s’enregistre sous son nom, une seule fois, et écrit les notifications', () =>
      rolledBack(async (uow) => {
        const registry = new EventConsumerRegistry();
        const resolver = new StubResolver([approverA]);
        registerDirectNotificationsConsumer(registry, { idGenerator, clock, resolver });
        expect(DIRECT_CONSUMER_NAME).toBe('communication.direct');
        expect(registry.names()).toEqual(['communication.direct']);
        expect(() =>
          registerDirectNotificationsConsumer(registry, { idGenerator, clock, resolver }),
        ).toThrow('déjà enregistré');

        const handler = registry.resolve(DIRECT_CONSUMER_NAME)!;
        await handler(uow, requested());
        expect(await notificationsOf(uow, approverA)).toHaveLength(1);
      }));
  });
});
