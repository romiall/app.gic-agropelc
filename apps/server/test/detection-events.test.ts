/**
 * P9-07 : publication des événements de détection (ADR-061 §3) — idempotence par (type, sujet, passe),
 * identité de passe, marqueur de passe complète, et bout en bout avec le consommateur d'alertes : ce que
 * la passe suivante ne revoit pas est résolu, ce qu'elle revoit reste ouvert.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import {
  PASS_COMPLETED_EVENT,
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../src/platform/events/detection-events.js';
import { toDomainEvent, type DomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { codeEntityId } from '../src/platform/sync/code-entity-id.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, freshUuid } from './helpers.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const idGenerator = new Uuidv7Generator(new FixedClock(NOW));

afterAll(closeTestDb);

const eventsOf = async (uow: UnitOfWork, eventType: string, aggregateId: string) =>
  (
    await uow
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('event_type', '=', eventType)
      .where('aggregate_id', '=', toBin(aggregateId))
      .orderBy('seq')
      .execute()
  ).map((row) => toDomainEvent(row));

const overdue = (saleId: string, passId?: string) => ({
  eventType: 'ReceivableOverdue',
  producerModule: 'sales',
  aggregateType: 'SALE',
  aggregateId: saleId,
  occurredAt: NOW,
  ...(passId === undefined ? {} : { passId }),
  payload: {
    sale_id: saleId,
    doc_number: 'VTE-2026-000321',
    commercial_user_id: freshUuid(),
    site_id: freshUuid(),
    days_overdue: 4,
    balance_due_xaf: 12_000,
    business_day: '2026-11-02',
  },
});

describe('P9-07 : événements de détection', () => {
  it('identité de passe : type et créneau, bornée à 64 caractères ; créneau de la tâche ou instant', () => {
    expect(detectionPassId('OVERDUE_RECEIVABLE', '2026-11-02T04:00:00.000Z')).toBe(
      'OVERDUE_RECEIVABLE:2026-11-02T04:00:00.000Z',
    );
    // Portée : le début (type et portée) n'est jamais tronqué, seul le créneau l'est.
    expect(detectionPassId('ATTACHMENT_MISSING', '2026-11-02T04:00:00.000Z', 'EXPENSE')).toBe(
      'ATTACHMENT_MISSING:EXPENSE:2026-11-02T04:00:00.000Z',
    );
    const long = detectionPassId('ATTACHMENT_MISSING', 'y'.repeat(80), 'EXPENSE');
    expect(long.length).toBe(64);
    expect(long.startsWith('ATTACHMENT_MISSING:EXPENSE:')).toBe(true);
    expect(passSlotOf({ scheduledFor: '2026-11-02T04:00:00.000Z' }, NOW)).toBe(
      '2026-11-02T04:00:00.000Z',
    );
    expect(passSlotOf({}, NOW)).toBe(NOW.toISOString());
    expect(passSlotOf(undefined, NOW)).toBe(NOW.toISOString());
    expect(passSlotOf({ scheduledFor: '' }, NOW)).toBe(NOW.toISOString());
  });

  it('un sujet n’est publié qu’une fois par passe ; une autre passe le publie à nouveau', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      const first = overdue(sale, 'OVERDUE_RECEIVABLE:slot-1');
      expect(await publishDetectionEvent(uow, idGenerator, first)).toBe(true);
      expect(await publishDetectionEvent(uow, idGenerator, first)).toBe(false);
      expect(
        await publishDetectionEvent(uow, idGenerator, {
          ...first,
          passId: 'OVERDUE_RECEIVABLE:slot-2',
        }),
      ).toBe(true);
      const events = await eventsOf(uow, 'ReceivableOverdue', sale);
      expect(events).toHaveLength(2);
      expect((events[0]!.payload as { pass_id: string }).pass_id).toBe('OVERDUE_RECEIVABLE:slot-1');
    }));

  it('rejeu d’une passe : reconnu avant l’insertion — aucune tentative d’INSERT, donc aucun numéro de séquence consommé', () =>
    rolledBack(async (uow) => {
      // Un `INSERT IGNORE` sur une clé en double consomme tout de même un numéro de séquence : le trou
      // retarderait les consommateurs de la fenêtre de stabilisation. Le rejeu ne doit donc rien insérer.
      const inserts = { count: 0 };
      const counted = uow.withPlugin({
        transformQuery(args) {
          const node = args.node;
          if (
            node.kind === 'InsertQueryNode' &&
            node.into?.table.identifier.name === 'platform_domain_events'
          ) {
            inserts.count += 1;
          }
          return node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const input = overdue(freshUuid(), `OVERDUE_RECEIVABLE:${freshUuid()}`);
      expect(await publishDetectionEvent(counted, idGenerator, input)).toBe(true);
      expect(inserts.count).toBe(1);
      expect(await publishDetectionEvent(counted, idGenerator, input)).toBe(false);
      expect(await publishDetectionEvent(counted, idGenerator, input)).toBe(false);
      expect(inserts.count).toBe(1);

      // Même chose pour le marqueur de fin de passe.
      const marker = {
        producerModule: 'sales',
        alertType: 'OVERDUE_RECEIVABLE' as const,
        passId: `OVERDUE_RECEIVABLE:${freshUuid()}`,
        businessDay: '2026-11-02',
        occurredAt: NOW,
      };
      expect(await publishPassCompleted(counted, marker)).toBe(true);
      expect(inserts.count).toBe(2);
      expect(await publishPassCompleted(counted, marker)).toBe(false);
      expect(inserts.count).toBe(2);
    }));

  it('marqueur à portée : la portée est reportée dans la charge utile', () =>
    rolledBack(async (uow) => {
      const input = {
        producerModule: 'finance',
        alertType: 'ATTACHMENT_MISSING' as const,
        passId: `ATTACHMENT_MISSING:EXPENSE:${freshUuid()}`,
        scope: 'EXPENSE',
        businessDay: '2026-11-02',
        occurredAt: NOW,
      };
      await publishPassCompleted(uow, input);
      const [row] = await uow
        .selectFrom('platform_domain_events')
        .select('payload')
        .where('event_type', '=', PASS_COMPLETED_EVENT)
        .orderBy('seq', 'desc')
        .limit(1)
        .execute();
      expect(row!.payload).toEqual({
        alert_type: 'ATTACHMENT_MISSING',
        pass_id: input.passId,
        scope: 'EXPENSE',
        business_day: '2026-11-02',
      });
    }));

  it('sujet composite : même identifiant que celui du consommateur ; partie manquante : erreur sans la charge utile', () =>
    rolledBack(async (uow) => {
      const account = freshUuid();
      const payload = {
        cash_account_id: account,
        business_day: '2026-11-02',
        secret: 'ne-pas-fuiter',
      };
      const subjectId = compositeSubjectId('CASH_MISMATCH', payload);
      await publishDetectionEvent(uow, idGenerator, {
        eventType: 'CashMismatchDetected',
        producerModule: 'finance',
        aggregateType: 'CASH_RECONCILIATION',
        aggregateId: subjectId,
        occurredAt: NOW,
        payload,
      });
      const [event] = await uow
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'CashMismatchDetected')
        .where('aggregate_id', '=', toBin(subjectId))
        .execute();
      await handleAlertEvent(uow, toDomainEvent(event!), { idGenerator });
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['subject_id', 'dedup_key'])
        .where('dedup_key', 'like', `CASH_MISMATCH:%${account}%`)
        .executeTakeFirstOrThrow();
      // Le sujet de l'alerte est exactement l'identifiant que l'éditeur a calculé (constante partagée).
      expect(fromBin(alert.subject_id)).toBe(subjectId);

      let message = '';
      try {
        compositeSubjectId('CASH_MISMATCH', {
          business_day: '2026-11-02',
          secret: 'ne-pas-fuiter',
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('CASH_MISMATCH');
      expect(message).not.toContain('ne-pas-fuiter');
    }));

  it('hors passe (sur fait) : chaque publication est un événement distinct, sans pass_id', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      const onFact = overdue(sale);
      expect(await publishDetectionEvent(uow, idGenerator, onFact)).toBe(true);
      expect(await publishDetectionEvent(uow, idGenerator, onFact)).toBe(true);
      const events = await eventsOf(uow, 'ReceivableOverdue', sale);
      expect(events).toHaveLength(2);
      expect(events[0]!.payload).not.toHaveProperty('pass_id');
    }));

  it('marqueur : un par (type, passe), avec le jour métier', () =>
    rolledBack(async (uow) => {
      const input = {
        producerModule: 'sales',
        alertType: 'OVERDUE_RECEIVABLE',
        passId: `OVERDUE_RECEIVABLE:${freshUuid()}`,
        businessDay: '2026-11-02',
        occurredAt: NOW,
      };
      expect(await publishPassCompleted(uow, input)).toBe(true);
      expect(await publishPassCompleted(uow, input)).toBe(false);
      const rows = await uow
        .selectFrom('platform_domain_events')
        .select(['payload', 'producer_module'])
        .where('event_type', '=', PASS_COMPLETED_EVENT)
        .where('aggregate_type', '=', 'ALERT_DETECTION_PASS')
        .orderBy('seq', 'desc')
        .limit(1)
        .execute();
      expect(rows[0]!.producer_module).toBe('sales');
      expect(rows[0]!.payload).toEqual({
        alert_type: 'OVERDUE_RECEIVABLE',
        pass_id: input.passId,
        business_day: '2026-11-02',
      });
    }));

  it('bout en bout : la passe suivante résout ce qu’elle ne revoit pas, garde ce qu’elle revoit', () =>
    rolledBack(async (uow) => {
      const stays = freshUuid();
      const goes = freshUuid();
      const consume = async (events: readonly DomainEvent[]) => {
        for (const event of events) await handleAlertEvent(uow, event, { idGenerator });
      };
      const published = async (aggregateId: string, eventType = 'ReceivableOverdue') =>
        eventsOf(uow, eventType, aggregateId);

      const passOne = `OVERDUE_RECEIVABLE:${freshUuid()}`;
      await publishDetectionEvent(uow, idGenerator, overdue(stays, passOne));
      await publishDetectionEvent(uow, idGenerator, overdue(goes, passOne));
      await publishPassCompleted(uow, {
        producerModule: 'sales',
        alertType: 'OVERDUE_RECEIVABLE',
        passId: passOne,
        businessDay: '2026-11-02',
        occurredAt: NOW,
      });
      await consume([...(await published(stays)), ...(await published(goes))]);

      const passTwo = `OVERDUE_RECEIVABLE:${freshUuid()}`;
      await publishDetectionEvent(uow, idGenerator, overdue(stays, passTwo));
      await publishPassCompleted(uow, {
        producerModule: 'sales',
        alertType: 'OVERDUE_RECEIVABLE',
        passId: passTwo,
        businessDay: '2026-11-03',
        occurredAt: new Date(NOW.getTime() + 86_400_000),
      });
      const markerEvents = await uow
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', PASS_COMPLETED_EVENT)
        // l'identifiant du marqueur dérive du couple (type, passe)
        .where(
          'event_id',
          '=',
          toBin(codeEntityId('ALERT_PASS_COMPLETED', `OVERDUE_RECEIVABLE:${passTwo}`)),
        )
        .execute();
      expect(markerEvents).toHaveLength(1);
      const secondEvents = (await published(stays)).slice(1);
      await consume([...secondEvents, toDomainEvent(markerEvents[0]!)]);

      const status = async (sale: string) =>
        await uow
          .selectFrom('communication_alerts')
          .select(['status', 'occurrences', 'last_pass_id'])
          .where('dedup_key', '=', `OVERDUE_RECEIVABLE:${sale}`)
          .executeTakeFirstOrThrow();
      expect(await status(stays)).toMatchObject({
        status: 'OPEN',
        occurrences: 2,
        last_pass_id: passTwo,
      });
      expect(await status(goes)).toMatchObject({ status: 'RESOLVED' });
    }));
});
