/**
 * P9-05 : destinataires et notifications d'une alerte (ADR-072 §1, §4, §6, §7 ; BR-NOT-001, 004, 005,
 * 008 ; AV-413, AV-416, AV-417, AV-440). Le résolveur est un double contrôlé (la résolution par rôle et
 * périmètre est testée avec l'adaptateur réel dans `communication-recipients.test.ts`) ; les utilisateurs,
 * les abonnements et les alertes sont réels. Chaque test s'exécute dans une transaction annulée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { DomainEvent } from '../src/platform/events/domain-event.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { escalateDueAlerts } from '../src/modules/communication/application/alerts/alert-escalation.js';
import {
  lockAlert,
  lockAlertForEscalation,
  markAcknowledged,
  markEscalated,
} from '../src/modules/communication/application/alerts/alert-store.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import {
  createAlertNotifier,
  type AlertNotifierDeps,
} from '../src/modules/communication/application/notifications/alert-notifier.js';
import {
  insertNotification,
  insertNotifications,
} from '../src/modules/communication/application/notifications/notification-store.js';
import { dispatchPendingPushes } from '../src/modules/communication/application/notifications/push-dispatch.js';
import type {
  PushMessage,
  PushSendResult,
  PushTarget,
  WebPushSender,
} from '../src/modules/communication/application/notifications/web-push.js';
import type {
  AlertRecipientResolver,
  RecipientPerimeter,
  RoleHolder,
} from '../src/modules/communication/application/recipients/recipient-resolver.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { newActor, tx } from './cash-transfer-fixtures.js';
import { rolledBack, rolledBackWithSequences } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(new FixedClock(NOW));
/** Très ancien : ces alertes passent avant toute autre dans le lot d'escalade de la base partagée. */
const LONG_AGO = '2026-10-01T00:00:00.000Z';

/** Résolveur contrôlé : titulaires par rôle, responsables et approbateurs fixés par le test. */
class StubResolver implements AlertRecipientResolver {
  readonly roleCalls: string[][] = [];
  readonly approverCalls: {
    permission: string;
    excludeUserIds: readonly string[];
    perimeter: RecipientPerimeter;
    at: Date;
  }[] = [];
  readonly perimeters: { perimeter: RecipientPerimeter; at: Date }[] = [];
  inactive = new Set<string>();
  /** Un site pour lequel le résolveur lève : simule une panne sur une alerte précise. */
  poisonSite: string | null = null;

  constructor(
    public byRole: Record<string, readonly string[]> = {},
    public managers: readonly string[] = [],
    public approvers: readonly string[] = [],
  ) {}

  async usersHoldingRolesAt(
    _uow: UnitOfWork,
    input: {
      readonly roles: readonly string[];
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
    },
  ): Promise<readonly RoleHolder[]> {
    this.roleCalls.push([...input.roles]);
    this.perimeters.push({ perimeter: input.perimeter, at: input.at });
    if (this.poisonSite !== null && input.perimeter.siteId === this.poisonSite) {
      throw new Error('résolveur en panne');
    }
    return input.roles.flatMap((roleCode) =>
      (this.byRole[roleCode] ?? []).map((userId) => ({ userId, roleCode })),
    );
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
    this.approverCalls.push({
      permission: input.permission,
      excludeUserIds: input.excludeUserIds,
      perimeter: input.perimeter,
      at: input.at,
    });
    return this.approvers.filter((id) => !input.excludeUserIds.includes(id));
  }

  async activeUsersAmong(_uow: UnitOfWork, userIds: readonly string[]): Promise<readonly string[]> {
    return userIds.filter((id) => !this.inactive.has(id));
  }

  async teamManagersOf(): Promise<readonly string[]> {
    return this.managers;
  }
}

class FakeSender implements WebPushSender {
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  constructor(
    public enabled = true,
    public outcomes: Record<string, PushSendResult> = {},
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
    this.sent.push({ target, message });
    return this.outcomes[target.endpoint] ?? { status: 'SENT' };
  }
}

let seq = 9_500_000_000;
function eventOf(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  occurredAt = '2026-11-02T09:00:00.000Z',
): DomainEvent {
  seq += 1;
  return {
    seq,
    eventId: freshUuid(),
    eventType,
    eventVersion: 1,
    producerModule: 'test',
    aggregateType: 'TEST',
    aggregateId,
    occurredAt: new Date(occurredAt),
    recordedAt: new Date(occurredAt),
    payload,
    commandId: null,
    correlationId: null,
    causationId: null,
  };
}

const cashVariance = (
  session: string,
  severity: 'WARNING' | 'CRITICAL',
  occurredAt?: string,
  extra: Record<string, unknown> = {},
) =>
  eventOf(
    'CashVarianceDetected',
    session,
    { session_id: session, variance_xaf: -15_000, severity, site_id: freshUuid(), ...extra },
    occurredAt,
  );

function wire(resolver: AlertRecipientResolver, sender: WebPushSender = new FakeSender()) {
  const deps: AlertNotifierDeps = { idGenerator, clock, resolver, push: sender };
  return {
    deps,
    options: { idGenerator, afterRaise: createAlertNotifier(deps) },
  };
}

const recipientsOf = (uow: UnitOfWork, alertId: string) =>
  uow
    .selectFrom('communication_alert_recipients')
    .select(['user_id', 'origin', 'role_code'])
    .where('alert_id', '=', toBin(alertId))
    .execute();

const notificationsOf = (uow: UnitOfWork, userId: string, alertId?: string) =>
  uow
    .selectFrom('communication_notifications')
    .selectAll()
    .where('user_id', '=', toBin(userId))
    .$if(alertId !== undefined, (qb) => qb.where('alert_id', '=', toBin(alertId!)))
    .orderBy('created_at', 'asc')
    .execute();

async function alertIdOf(uow: UnitOfWork, dedupKey: string): Promise<string> {
  const row = await uow
    .selectFrom('communication_alerts')
    .select('id')
    .where('dedup_key', '=', dedupKey)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

async function subscribe(
  userId: string,
  endpoint = `https://push.test/${freshUuid()}`,
  deviceStatus: 'ACTIVE' | 'BLOCKED' | 'LOST' | 'RETIRED' = 'ACTIVE',
) {
  await tx(async (trx) => {
    const deviceId = await insertTestDevice(trx, userId, { status: deviceStatus });
    await trx
      .insertInto('communication_push_subscriptions')
      .values({
        id: toBin(freshUuid()),
        user_id: toBin(userId),
        device_id: toBin(deviceId),
        endpoint,
        p256dh: 'p256dh-test',
        auth: 'auth-test',
      })
      .execute();
  });
  return endpoint;
}

const newUser = () => tx((trx) => insertTestUser(trx));

afterAll(closeTestDb);

describe('P9-05 : destinataires et notifications d’une alerte', () => {
  let root: string;

  beforeAll(async () => {
    root = await newUser();
  });

  it('un test annulé ne laisse aucun trou dans la séquence des événements (consommateurs des autres tests)', async () => {
    const finance = await newUser();
    const { seqs } = await rolledBackWithSequences(async (uow) => {
      await handleAlertEvent(
        uow,
        cashVariance(freshUuid(), 'CRITICAL'),
        wire(new StubResolver({ FINANCE: [finance] })).options,
      );
    });
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    const rows = await db
      .selectFrom('platform_domain_events')
      .select(['seq', 'event_type'])
      .where('seq', 'in', [...seqs])
      .execute();
    expect(rows).toHaveLength(seqs.length);
    expect(rows.every((row) => row.event_type === 'test.tombstone')).toBe(true);
  });

  it('création : destinataires par règle, propriétaire et responsable, une ligne par utilisateur', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const owner = await newUser();
      const manager = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance, owner] }, [manager]);
      const { options } = wire(resolver);
      const account = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('CashHoldingHighDetected', account, {
          account_id: account,
          holder_user_id: owner,
          holder_label: 'Caisse de test',
          balance_xaf: 900_000,
          days_without_transfer: 9,
          site_id: freshUuid(),
        }),
        options,
      );
      const alertId = await alertIdOf(uow, `CASH_HOLDING_HIGH:${account}`);
      const recipients = await recipientsOf(uow, alertId);
      const byUser = new Map(recipients.map((row) => [fromBin(row.user_id), row.origin]));
      // `owner` est aussi titulaire du rôle de la règle : la première origine l'emporte, une seule ligne.
      expect(byUser.get(finance)).toBe('RULE');
      expect(byUser.get(owner)).toBe('RULE');
      expect(byUser.get(manager)).toBe('TEAM_MANAGER');
      expect(recipients).toHaveLength(3);
      // WARNING : une notification in-app par destinataire, aucun push.
      for (const userId of [finance, owner, manager]) {
        const rows = await notificationsOf(uow, userId, alertId);
        expect(rows.map((row) => row.channel)).toEqual(['IN_APP']);
        expect(rows[0]).toMatchObject({
          kind: 'ALERT',
          alert_type: 'CASH_HOLDING_HIGH',
          title: 'Encaisse élevée ou sans remise',
          source_type: 'ALERT',
        });
        expect(rows[0]!.delivered_at).not.toBeNull();
        expect(rows[0]!.read_at).toBeNull();
      }
    }));

  it('à défaut de tout destinataire, la Direction reçoit (repli D13 §14)', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      const resolver = new StubResolver({ DIRECTION: [direction] });
      const { options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      expect(await recipientsOf(uow, alertId)).toEqual([
        expect.objectContaining({ origin: 'FALLBACK', role_code: 'DIRECTION' }),
      ]);
      expect((await notificationsOf(uow, direction, alertId)).map((n) => n.channel)).toEqual([
        'IN_APP',
      ]);
      // Les rôles de la règle ont été demandés d'abord, puis le repli.
      expect(resolver.roleCalls).toEqual([['FINANCE'], ['DIRECTION']]);
    }));

  it('INFO : destinataires inscrits, aucune notification (centre d’alertes seulement)', () =>
    rolledBack(async (uow) => {
      const lead = await newUser();
      const resolver = new StubResolver({ RESP_COMMERCIAL: [lead] });
      const { options } = wire(resolver);
      const sale = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('PriceMismatchDetected', sale, { sale_id: sale, site_id: freshUuid() }),
        options,
      );
      const alertId = await alertIdOf(uow, `PRICE_MISMATCH:${sale}`);
      expect(await recipientsOf(uow, alertId)).toHaveLength(1);
      expect(await notificationsOf(uow, lead)).toEqual([]);
    }));

  it('occurrence ordinaire : seuls les destinataires nouvellement ajoutés sont notifiés', () =>
    rolledBack(async (uow) => {
      const first = await newUser();
      const second = await newUser();
      const resolver = new StubResolver({ FINANCE: [first] });
      const { options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      resolver.byRole = { FINANCE: [first, second] };
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      expect(await notificationsOf(uow, first, alertId)).toHaveLength(1);
      expect(await notificationsOf(uow, second, alertId)).toHaveLength(1);
      expect(await recipientsOf(uow, alertId)).toHaveLength(2);
      // Jamais retiré : un utilisateur qui n'est plus calculé reste destinataire.
      resolver.byRole = { FINANCE: [second] };
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      expect(await recipientsOf(uow, alertId)).toHaveLength(2);
      expect(await notificationsOf(uow, first, alertId)).toHaveLength(1);
    }));

  it('relèvement en CRITICAL : tous les destinataires sont notifiés à nouveau, push immédiat', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      await subscribe(finance);
      const resolver = new StubResolver({ FINANCE: [finance] });
      const { options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL'), options);
      // Une troisième occurrence ordinaire ne renotifie rien.
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL'), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      const rows = await notificationsOf(uow, finance, alertId);
      expect(rows.map((row) => row.channel).sort()).toEqual(['IN_APP', 'IN_APP', 'WEB_PUSH']);
      expect(rows.filter((row) => row.channel === 'WEB_PUSH')[0]!.delivered_at).toBeNull();
    }));

  it('sans abonnement valide ou sans canal Web Push : la notification reste in-app', () =>
    rolledBack(async (uow) => {
      const subscribed = await newUser();
      const bare = await newUser();
      const offline = await newUser();
      await subscribe(subscribed);
      await subscribe(offline);
      const resolver = new StubResolver({ FINANCE: [subscribed, bare] });
      const session = freshUuid();
      await handleAlertEvent(
        uow,
        cashVariance(session, 'CRITICAL'),
        wire(resolver, new FakeSender(true)).options,
      );
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      expect((await notificationsOf(uow, bare, alertId)).map((n) => n.channel)).toEqual(['IN_APP']);
      expect(
        (await notificationsOf(uow, subscribed, alertId)).map((n) => n.channel).sort(),
      ).toEqual(['IN_APP', 'WEB_PUSH']);

      // Canal désactivé (aucune clé ni bibliothèque : AV-415) : même abonné, in-app seulement. Un autre
      // abonné (hors du créneau de regroupement de `subscribed`) le montre sans ambiguïté.
      const session2 = freshUuid();
      await handleAlertEvent(
        uow,
        cashVariance(session2, 'CRITICAL'),
        wire(new StubResolver({ FINANCE: [offline] }), new FakeSender(false)).options,
      );
      const alert2 = await alertIdOf(uow, `CASH_VARIANCE:${session2}`);
      expect((await notificationsOf(uow, offline, alert2)).map((n) => n.channel)).toEqual([
        'IN_APP',
      ]);
    }));

  it('regroupement : un push par utilisateur et par type par créneau, le suivant compte les tues', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      await subscribe(finance);
      const resolver = new StubResolver({ FINANCE: [finance] });
      const { options } = wire(resolver);
      const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
      const sessions = [freshUuid(), freshUuid(), freshUuid()];

      clock.setTo(NOW);
      await handleAlertEvent(uow, cashVariance(sessions[0]!, 'CRITICAL'), options);
      clock.setTo(at(5));
      await handleAlertEvent(uow, cashVariance(sessions[1]!, 'CRITICAL'), options);
      // Un autre type n'est pas regroupé avec celui-ci.
      const loss = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('HighLossDetected', loss, {
          location_id: loss,
          business_day: '2026-11-02',
          loss_value_xaf: 80_000,
          site_id: freshUuid(),
        }),
        wire(new StubResolver({ RESP_FERME: [finance] })).options,
      );
      clock.setTo(at(20));
      await handleAlertEvent(uow, cashVariance(sessions[2]!, 'CRITICAL'), options);
      clock.setTo(NOW);

      const all = await notificationsOf(uow, finance);
      const variance = all.filter((row) => row.alert_type === 'CASH_VARIANCE');
      expect(variance.filter((row) => row.channel === 'IN_APP')).toHaveLength(3);
      const pushes = variance.filter((row) => row.channel === 'WEB_PUSH');
      // Premier push à t0 ; celui de t+5 est tu ; celui de t+20 ouvre le créneau suivant.
      expect(pushes).toHaveLength(2);
      expect(pushes[0]!.body).not.toContain('autre');
      expect(pushes[1]!.body).toContain('(+1 autre alerte de ce type)');
      // Le type HIGH_LOSS a son propre créneau : son push part.
      expect(
        all.filter((row) => row.alert_type === 'HIGH_LOSS' && row.channel === 'WEB_PUSH'),
      ).toHaveLength(1);
    }));

  it('valeur au coût : rendue au titulaire de la valorisation, jamais au magasinier ni dans l’alerte', async () => {
    const zone = await tx((trx) => insertTestZone(trx, root));
    const site = await tx((trx) => insertTestSite(trx, root, zone));
    const valuer = await newActor('DIRECTION', root, { scopeType: 'GLOBAL' });
    const keeper = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: site });
    await rolledBack(async (uow) => {
      const resolver = new StubResolver({
        MAGASINIER: [keeper.userId],
        DIRECTION: [valuer.userId],
      });
      const { options } = wire(resolver);
      const location = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('HighLossDetected', location, {
          location_id: location,
          business_day: '2026-11-02',
          loss_quantity: 12,
          loss_value_xaf: 120_000,
          site_id: site,
        }),
        options,
      );
      const alertId = await alertIdOf(uow, `HIGH_LOSS:LOSS_DAY:${location}:2026-11-02`);
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['message', 'payload'])
        .where('id', '=', toBin(alertId))
        .executeTakeFirstOrThrow();
      expect(alert.message).not.toMatch(/120\s?000/);
      const seen = await notificationsOf(uow, valuer.userId, alertId);
      expect(seen[0]!.body).toMatch(/Valeur perdue : 120\s000 XAF/);
      const masked = await notificationsOf(uow, keeper.userId, alertId);
      expect(masked[0]!.body).not.toMatch(/120\s?000/);
      expect(masked[0]!.body).not.toContain('Valeur');
    });
  });

  it('approbateurs : la permission de la politique est résolue, le demandeur exclu', () =>
    rolledBack(async (uow) => {
      const approver = await newUser();
      const requester = await newUser();
      const resolver = new StubResolver({}, [], [approver, requester]);
      const { options } = wire(resolver);
      const request = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('ApprovalPendingLong', request, {
          request_id: request,
          operation_label: 'Dépense',
          hours_pending: 30,
          approver_permission: 'finance.expense.approve',
          requester_user_id: requester,
          site_id: freshUuid(),
        }),
        options,
      );
      const alertId = await alertIdOf(uow, `APPROVAL_PENDING_LONG:${request}`);
      const recipients = await recipientsOf(uow, alertId);
      expect(recipients).toEqual([expect.objectContaining({ origin: 'APPROVER' })]);
      expect(fromBin(recipients[0]!.user_id)).toBe(approver);
      expect(resolver.approverCalls).toHaveLength(1);
      expect(resolver.approverCalls[0]).toMatchObject({
        permission: 'finance.expense.approve',
        excludeUserIds: [requester],
      });
      // Le demandeur est le propriétaire de la ressource jugée (portées OWN et TEAM), sans être notifié.
      expect(resolver.approverCalls[0]!.perimeter.ownerUserIds).toEqual([requester]);
      expect((await recipientsOf(uow, alertId)).map((r) => fromBin(r.user_id))).not.toContain(
        requester,
      );
    }));
});

describe('P9-05 : escalade des alertes critiques', () => {
  const raiseCritical = async (
    uow: UnitOfWork,
    resolver: StubResolver,
    occurredAt: string,
    sender: WebPushSender = new FakeSender(),
  ) => {
    const { deps, options } = wire(resolver, sender);
    const session = freshUuid();
    await handleAlertEvent(uow, cashVariance(session, 'CRITICAL', occurredAt), options);
    return { deps, session, alertId: await alertIdOf(uow, `CASH_VARIANCE:${session}`) };
  };

  it('une fois, depuis critical_since : niveau supérieur, notification d’escalade, événement', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance], DIRECTION: [direction] });
      clock.setTo(NOW);
      const { deps, alertId } = await raiseCritical(uow, resolver, LONG_AGO);

      const first = await escalateDueAlerts(uow, deps);
      expect(first.escalated).toBeGreaterThanOrEqual(1);
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['escalated_at', 'status'])
        .where('id', '=', toBin(alertId))
        .executeTakeFirstOrThrow();
      expect(alert.escalated_at?.toISOString()).toBe(NOW.toISOString());
      expect(alert.status).toBe('OPEN');

      const recipients = await recipientsOf(uow, alertId);
      expect(recipients.find((r) => fromBin(r.user_id) === direction)?.origin).toBe('ESCALATION');
      const directionRows = await notificationsOf(uow, direction, alertId);
      expect(directionRows.every((row) => row.title.startsWith('Escalade : '))).toBe(true);
      expect(directionRows[0]!.source_type).toBe('ALERT_ESCALATION');
      // Le niveau d'origine reste destinataire sans nouvelle notification d'escalade.
      expect(
        (await notificationsOf(uow, finance, alertId)).every(
          (row) => !row.title.startsWith('Escalade'),
        ),
      ).toBe(true);

      const events = await uow
        .selectFrom('platform_domain_events')
        .select('event_type')
        .where('aggregate_id', '=', toBin(alertId))
        .where('event_type', '=', 'AlertEscalated')
        .execute();
      expect(events).toHaveLength(1);

      // Jamais deux fois.
      const before = (await notificationsOf(uow, direction, alertId)).length;
      await escalateDueAlerts(uow, deps);
      expect((await notificationsOf(uow, direction, alertId)).length).toBe(before);
      expect(
        await uow
          .selectFrom('platform_domain_events')
          .select('event_type')
          .where('aggregate_id', '=', toBin(alertId))
          .where('event_type', '=', 'AlertEscalated')
          .execute(),
      ).toHaveLength(1);
    }));

  it('pas avant l’échéance ; mesurée depuis le relèvement, pas depuis la première détection', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance], DIRECTION: [direction] });
      const { deps, options } = wire(resolver);
      const session = freshUuid();
      clock.setTo(NOW);
      // Levée WARNING il y a des semaines, relevée en CRITICAL il y a une heure.
      await handleAlertEvent(uow, cashVariance(session, 'WARNING', LONG_AGO), options);
      await handleAlertEvent(
        uow,
        cashVariance(session, 'CRITICAL', '2026-11-02T09:00:00.000Z'),
        options,
      );
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      const escalatedAt = async () =>
        (
          await uow
            .selectFrom('communication_alerts')
            .select('escalated_at')
            .where('id', '=', toBin(alertId))
            .executeTakeFirstOrThrow()
        ).escalated_at;

      await escalateDueAlerts(uow, deps);
      expect(await escalatedAt()).toBeNull(); // 1 h après le relèvement : pas encore 4 h

      clock.setTo(new Date('2026-11-02T13:00:00.000Z')); // 4 h exactement
      await escalateDueAlerts(uow, deps);
      expect((await escalatedAt())?.toISOString()).toBe('2026-11-02T13:00:00.000Z');
      clock.setTo(NOW);
    }));

  it('une prise en compte avant l’échéance arrête l’escalade ; une alerte sans niveau supérieur reste sans effet', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance], DIRECTION: [direction] });
      clock.setTo(NOW);
      const { deps, alertId } = await raiseCritical(uow, resolver, LONG_AGO);
      const alert = await lockAlert(uow, alertId);
      await markAcknowledged(uow, deps, alert!, {
        userId: finance,
        at: new Date('2026-11-02T09:30:00.000Z'),
        commandId: freshUuid(),
      });
      await escalateDueAlerts(uow, deps);
      const row = await uow
        .selectFrom('communication_alerts')
        .select(['escalated_at', 'status'])
        .where('id', '=', toBin(alertId))
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ escalated_at: null, status: 'ACKNOWLEDGED' });
      expect(await notificationsOf(uow, direction, alertId)).toEqual([]);
    }));

  it('règle sans délai d’escalade ou désactivée : aucune escalade', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance], DIRECTION: [await newUser()] });
      clock.setTo(NOW);
      const { deps, alertId } = await raiseCritical(uow, resolver, LONG_AGO);
      await uow
        .updateTable('communication_alert_rules')
        .set({ escalation_hours: null })
        .where('alert_type', '=', 'CASH_VARIANCE')
        .execute();
      await escalateDueAlerts(uow, deps);
      const escalated = async () =>
        (
          await uow
            .selectFrom('communication_alerts')
            .select('escalated_at')
            .where('id', '=', toBin(alertId))
            .executeTakeFirstOrThrow()
        ).escalated_at;
      expect(await escalated()).toBeNull();

      await uow
        .updateTable('communication_alert_rules')
        .set({ escalation_hours: 4, enabled: 0 })
        .where('alert_type', '=', 'CASH_VARIANCE')
        .execute();
      await escalateDueAlerts(uow, deps);
      expect(await escalated()).toBeNull();
    }));

  it('le push d’une escalade n’est jamais regroupé', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      await subscribe(direction);
      const resolver = new StubResolver({ FINANCE: [direction], DIRECTION: [direction] });
      clock.setTo(NOW);
      // Premier push d'alerte (créneau ouvert), puis l'escalade du même type, dans le créneau.
      const { deps, alertId } = await raiseCritical(uow, resolver, LONG_AGO);
      await escalateDueAlerts(uow, deps);
      const rows = await notificationsOf(uow, direction, alertId);
      const pushes = rows.filter((row) => row.channel === 'WEB_PUSH');
      expect(pushes.map((row) => row.source_type).sort()).toEqual(['ALERT', 'ALERT_ESCALATION']);
    }));
});

describe('P9-05 : envoi des push après validation', () => {
  async function pendingPush(uow: UnitOfWork, resolver: StubResolver, sessionOccurredAt?: string) {
    const { deps, options } = wire(resolver);
    const session = freshUuid();
    clock.setTo(NOW);
    await handleAlertEvent(uow, cashVariance(session, 'CRITICAL', sessionOccurredAt), options);
    return { deps, alertId: await alertIdOf(uow, `CASH_VARIANCE:${session}`) };
  }

  const pushRow = (uow: UnitOfWork, alertId: string) =>
    uow
      .selectFrom('communication_notifications')
      .select(['id', 'delivered_at'])
      .where('alert_id', '=', toBin(alertId))
      .where('channel', '=', 'WEB_PUSH')
      .executeTakeFirstOrThrow();

  it('envoie, marque livré ; un abonnement disparu (410) est révoqué', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      const good = await subscribe(user);
      const gone = await subscribe(user);
      const { alertId } = await pendingPush(uow, new StubResolver({ FINANCE: [user] }));
      const sender = new FakeSender(true, { [gone]: { status: 'GONE' } });
      const result = await dispatchPendingPushes(uow, { clock, sender });
      expect(result.delivered).toBeGreaterThanOrEqual(1);
      expect(sender.sent.map((s) => s.target.endpoint)).toEqual(
        expect.arrayContaining([good, gone]),
      );
      expect((await pushRow(uow, alertId)).delivered_at?.toISOString()).toBe(NOW.toISOString());
      const subs = await uow
        .selectFrom('communication_push_subscriptions')
        .select(['endpoint', 'revoked_at'])
        .where('user_id', '=', toBin(user))
        .execute();
      expect(subs.find((s) => s.endpoint === gone)?.revoked_at).not.toBeNull();
      expect(subs.find((s) => s.endpoint === good)?.revoked_at).toBeNull();
      // Le message porte le titre, le corps et l'alerte.
      const message = sender.sent.find((s) => s.target.endpoint === good)!.message;
      expect(message).toMatchObject({ alertId, alertType: 'CASH_VARIANCE' });
      expect(message.title).toBe('Écart de caisse');
    }));

  it('en panne : la ligne reste en attente et est reprise au passage suivant', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      const endpoint = await subscribe(user);
      const { alertId } = await pendingPush(uow, new StubResolver({ FINANCE: [user] }));
      const failing = new FakeSender(true, {
        [endpoint]: { status: 'FAILED', reason: 'HTTP_503' },
      });
      await dispatchPendingPushes(uow, { clock, sender: failing });
      expect((await pushRow(uow, alertId)).delivered_at).toBeNull();
      const recovered = new FakeSender(true);
      await dispatchPendingPushes(uow, { clock, sender: recovered });
      expect((await pushRow(uow, alertId)).delivered_at).not.toBeNull();
      // Une ligne livrée n'est plus reprise.
      const again = new FakeSender(true);
      await dispatchPendingPushes(uow, { clock, sender: again });
      expect(again.sent.filter((s) => s.message.alertId === alertId)).toEqual([]);
    }));

  it('une alerte déjà résolue n’est plus poussée ; le canal désactivé n’envoie rien', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      await subscribe(user);
      const { alertId } = await pendingPush(uow, new StubResolver({ FINANCE: [user] }));
      const disabled = new FakeSender(false);
      expect(await dispatchPendingPushes(uow, { clock, sender: disabled })).toEqual({
        examined: 0,
        delivered: 0,
        revoked: 0,
      });
      expect(disabled.sent).toEqual([]);

      await uow
        .updateTable('communication_alerts')
        .set({ status: 'RESOLVED', resolved_at: NOW, resolution_kind: 'CONDITION_CLEARED' })
        .where('id', '=', toBin(alertId))
        .execute();
      const sender = new FakeSender(true);
      await dispatchPendingPushes(uow, { clock, sender });
      expect(sender.sent.filter((s) => s.message.alertId === alertId)).toEqual([]);
      expect((await pushRow(uow, alertId)).delivered_at).toBeNull();
    }));

  it('au-delà de la fenêtre de reprise, une ligne en attente est abandonnée', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      await subscribe(user);
      const { alertId } = await pendingPush(uow, new StubResolver({ FINANCE: [user] }));
      const later = new FixedClock(new Date(NOW.getTime() + 61 * 60_000));
      const sender = new FakeSender(true);
      await dispatchPendingPushes(uow, { clock: later, sender });
      expect(sender.sent.filter((s) => s.message.alertId === alertId)).toEqual([]);
    }));
});

describe('P9-05 : durcissement après la revue adverse', () => {
  const highLoss = (location: string, siteId: string, occurredAt: string) =>
    eventOf(
      'HighLossDetected',
      location,
      {
        location_id: location,
        business_day: '2026-11-02',
        loss_value_xaf: 80_000,
        site_id: siteId,
      },
      occurredAt,
    );
  const lossKey = (location: string) => `HIGH_LOSS:LOSS_DAY:${location}:2026-11-02`;
  const escalatedAtOf = async (uow: UnitOfWork, alertId: string) =>
    (
      await uow
        .selectFrom('communication_alerts')
        .select('escalated_at')
        .where('id', '=', toBin(alertId))
        .executeTakeFirstOrThrow()
    ).escalated_at;
  const escalatedEvents = (uow: UnitOfWork, alertId: string) =>
    uow
      .selectFrom('platform_domain_events')
      .select(['event_id', 'payload'])
      .where('aggregate_id', '=', toBin(alertId))
      .where('event_type', '=', 'AlertEscalated')
      .execute();
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  it('le périmètre et l’instant de traitement sont transmis au résolveur', () =>
    rolledBack(async (uow) => {
      const owner = await newUser();
      const site = freshUuid();
      const resolver = new StubResolver({ FINANCE: [await newUser()] });
      const { options } = wire(resolver);
      clock.setTo(NOW);
      const account = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf(
          'CashHoldingHighDetected',
          account,
          {
            account_id: account,
            holder_user_id: owner,
            holder_label: 'Caisse',
            balance_xaf: 500_000,
            days_without_transfer: 8,
            site_id: site,
          },
          '2026-10-30T08:00:00.000Z',
        ),
        options,
      );
      expect(resolver.perimeters[0]).toEqual({
        perimeter: { siteId: site, zoneId: null, ownerUserIds: [owner] },
        at: NOW,
      });
    }));

  it('propriétaire notifié par son origine ; le responsable n’est calculé que si le type le prévoit', () =>
    rolledBack(async (uow) => {
      const owner = await newUser();
      const manager = await newUser();
      const lead = await newUser();
      // OVERDUE_RECEIVABLE : pas de responsable d'équipe (teamManager = faux) ; le propriétaire est
      // le titulaire de la vente.
      const resolver = new StubResolver({ RESP_COMMERCIAL: [lead] }, [manager]);
      const { options } = wire(resolver);
      const sale = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('ReceivableOverdue', sale, {
          sale_id: sale,
          doc_number: 'VTE-2026-000888',
          commercial_user_id: owner,
          site_id: freshUuid(),
          days_overdue: 5,
          balance_due_xaf: 10_000,
        }),
        options,
      );
      const alertId = await alertIdOf(uow, `OVERDUE_RECEIVABLE:${sale}`);
      const byUser = new Map(
        (await recipientsOf(uow, alertId)).map((row) => [fromBin(row.user_id), row.origin]),
      );
      expect(byUser.get(owner)).toBe('OWNER');
      expect(byUser.get(lead)).toBe('RULE');
      expect(byUser.has(manager)).toBe(false);
    }));

  it('rôles propres à un déclencheur ; une règle modifiée par l’administrateur vaut pour tout le type', () =>
    rolledBack(async (uow) => {
      const holder = await newUser();
      const byTrigger = async (eventType: string) => {
        const resolver = new StubResolver({
          FINANCE: [holder],
          RESP_COMMERCIAL: [holder],
          RESP_ACHATS: [holder],
          DIRECTION: [holder],
        });
        const { options } = wire(resolver);
        const subject = freshUuid();
        await handleAlertEvent(
          uow,
          eventOf(eventType, subject, { kind: 'DOUBLON', reference: 'REF-1' }),
          options,
        );
        return resolver.roleCalls[0];
      };
      expect(await byTrigger('PaymentFlaggedDuplicate')).toEqual(['FINANCE']);
      expect(await byTrigger('CustomerDuplicateSuspected')).toEqual(['RESP_COMMERCIAL']);
      expect(await byTrigger('GoodsReceiptQuarantined')).toEqual(['RESP_ACHATS']);

      await uow
        .updateTable('communication_alert_rules')
        .set({ recipient_roles: JSON.stringify(['FINANCE', 'DIRECTION']) })
        .where('alert_type', '=', 'DUPLICATE_SUSPECTED')
        .execute();
      expect(await byTrigger('CustomerDuplicateSuspected')).toEqual(['FINANCE', 'DIRECTION']);
    }));

  it('WARNING : aucun push, même pour un abonné ; abonnement révoqué ou appareil hors service : pas de cible', async () => {
    // Toutes les données sont validées avant la première lecture de la transaction du test : la lecture
    // répétable ne verrait pas, sinon, les abonnements créés ensuite (le test serait vide).
    const warned = await newUser();
    await subscribe(warned);
    const blocked = await newUser();
    await subscribe(blocked, undefined, 'BLOCKED');
    const lost = await newUser();
    await subscribe(lost, undefined, 'LOST');
    const revoked = await newUser();
    const revokedEndpoint = await subscribe(revoked);
    await tx((trx) =>
      trx
        .updateTable('communication_push_subscriptions')
        .set({ revoked_at: NOW })
        .where('endpoint', '=', revokedEndpoint)
        .execute(),
    );
    const suspended = await tx((trx) =>
      insertTestUser(trx, {
        status: 'SUSPENDED',
        statusChangedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    await subscribe(suspended);
    const healthy = await newUser();
    await subscribe(healthy);

    await rolledBack(async (uow) => {
      clock.setTo(NOW);
      const session = freshUuid();
      await handleAlertEvent(
        uow,
        cashVariance(session, 'WARNING'),
        wire(new StubResolver({ FINANCE: [warned] })).options,
      );
      const warnAlert = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      expect((await notificationsOf(uow, warned, warnAlert)).map((n) => n.channel)).toEqual([
        'IN_APP',
      ]);

      const critical = freshUuid();
      const targets = [blocked, lost, revoked, suspended, healthy];
      await handleAlertEvent(
        uow,
        cashVariance(critical, 'CRITICAL'),
        wire(new StubResolver({ FINANCE: targets })).options,
      );
      const criticalAlert = await alertIdOf(uow, `CASH_VARIANCE:${critical}`);
      for (const userId of [blocked, lost, revoked, suspended]) {
        expect((await notificationsOf(uow, userId, criticalAlert)).map((n) => n.channel)).toEqual([
          'IN_APP',
        ]);
      }
      // Témoin : un abonné actif, lui, reçoit le push (le test n'est pas vide).
      expect(
        (await notificationsOf(uow, healthy, criticalAlert)).map((n) => n.channel).sort(),
      ).toEqual(['IN_APP', 'WEB_PUSH']);
    });
  });

  it('relèvement : un destinataire devenu inactif n’est plus notifié, sa ligne reste', () =>
    rolledBack(async (uow) => {
      const stays = await newUser();
      const leaves = await newUser();
      const resolver = new StubResolver({ FINANCE: [stays, leaves] });
      const { options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'WARNING'), options);
      resolver.inactive.add(leaves);
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL'), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      expect(await notificationsOf(uow, stays, alertId)).toHaveLength(2);
      expect(await notificationsOf(uow, leaves, alertId)).toHaveLength(1);
      expect(await recipientsOf(uow, alertId)).toHaveLength(2);
    }));

  it('regroupement : par utilisateur, critiques seulement, une fois par alerte', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const other = await newUser();
      await subscribe(finance);
      await subscribe(other);
      const resolver = new StubResolver({ FINANCE: [finance] });
      const { options } = wire(resolver);
      const raise = async (
        severity: 'WARNING' | 'CRITICAL',
        minutes: number,
        session = freshUuid(),
      ) => {
        clock.setTo(at(minutes));
        await handleAlertEvent(
          uow,
          cashVariance(session, severity, at(minutes).toISOString()),
          options,
        );
        return session;
      };
      const pushRows = async (userId: string) =>
        (await notificationsOf(uow, userId)).filter(
          (row) => row.channel === 'WEB_PUSH' && row.alert_type === 'CASH_VARIANCE',
        );

      await raise('CRITICAL', 0);
      const upgraded = await raise('WARNING', 1);
      await raise('CRITICAL', 2, upgraded); // relevée : deux lignes in-app, push tu (créneau ouvert)
      await raise('WARNING', 3); // jamais éligible au push : ne compte pas
      // Un autre utilisateur n'est pas dans le créneau de `finance`.
      resolver.byRole = { FINANCE: [other] };
      await raise('CRITICAL', 4);
      expect(await pushRows(other)).toHaveLength(1);
      resolver.byRole = { FINANCE: [finance] };
      await raise('CRITICAL', 20);

      const pushes = await pushRows(finance);
      expect(pushes).toHaveLength(2);
      // Seule l'alerte relevée a été tue : une alerte, comptée une fois.
      expect(pushes[1]!.body).toContain('(+1 autre alerte de ce type)');
      clock.setTo(NOW);
    }));

  it('un push jamais envoyé d’une alerte close n’ouvre pas le créneau ; l’escalade non plus', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      await subscribe(finance);
      const resolver = new StubResolver({ FINANCE: [finance] });
      const { options } = wire(resolver);
      const pushRows = async (userId: string) =>
        (await notificationsOf(uow, userId)).filter(
          (row) => row.channel === 'WEB_PUSH' && row.alert_type === 'CASH_VARIANCE',
        );

      // A : push en attente, puis alerte résolue avant l'envoi ; B, cinq minutes plus tard, part.
      clock.setTo(NOW);
      const a = freshUuid();
      await handleAlertEvent(uow, cashVariance(a, 'CRITICAL'), options);
      await uow
        .updateTable('communication_alerts')
        .set({ status: 'RESOLVED', resolved_at: NOW, resolution_kind: 'CONDITION_CLEARED' })
        .where('id', '=', toBin(await alertIdOf(uow, `CASH_VARIANCE:${a}`)))
        .execute();
      clock.setTo(at(5));
      await handleAlertEvent(uow, cashVariance(freshUuid(), 'CRITICAL'), options);
      expect(await pushRows(finance)).toHaveLength(2);
      clock.setTo(NOW);
    }));

  it('l’escalade n’ouvre pas de créneau d’alerte', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      const lateJoiner = await newUser();
      const resolver = new StubResolver({ FINANCE: [lateJoiner], DIRECTION: [direction] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      await subscribe(direction);
      // L'alerte est levée et escaladée pour la direction (push d'escalade) ; une alerte suivante, dont
      // la direction est destinataire, part immédiatement : l'escalade n'a pas ouvert son créneau.
      const first = freshUuid();
      await handleAlertEvent(uow, cashVariance(first, 'CRITICAL', LONG_AGO), options);
      await escalateDueAlerts(uow, deps);
      const escalationPushes = (await notificationsOf(uow, direction)).filter(
        (row) => row.channel === 'WEB_PUSH' && row.source_type === 'ALERT_ESCALATION',
      );
      expect(escalationPushes.length).toBeGreaterThanOrEqual(1);

      resolver.byRole = { FINANCE: [direction], DIRECTION: [direction] };
      clock.setTo(at(1));
      const second = freshUuid();
      await handleAlertEvent(uow, cashVariance(second, 'CRITICAL'), options);
      const secondId = await alertIdOf(uow, `CASH_VARIANCE:${second}`);
      const pushes = (await notificationsOf(uow, direction, secondId)).filter(
        (row) => row.channel === 'WEB_PUSH',
      );
      expect(pushes).toHaveLength(1);
      clock.setTo(NOW);
    }));

  it('escalade : les rôles de la règle décident du niveau supérieur', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      const supervisor = await newUser();
      const resolver = new StubResolver({
        FINANCE: [finance],
        DIRECTION: [direction],
        RESP_PRODUCTION: [supervisor],
      });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL', LONG_AGO), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      await uow
        .updateTable('communication_alert_rules')
        .set({ escalation_roles: JSON.stringify(['RESP_PRODUCTION']) })
        .where('alert_type', '=', 'CASH_VARIANCE')
        .execute();
      await escalateDueAlerts(uow, deps);
      const recipients = new Map(
        (await recipientsOf(uow, alertId)).map((row) => [fromBin(row.user_id), row.origin]),
      );
      expect(recipients.get(supervisor)).toBe('ESCALATION');
      expect(recipients.has(direction)).toBe(false);
      const events = await escalatedEvents(uow, alertId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ escalation_recipients: 1 });
    }));

  it('escalade sans titulaire du niveau supérieur : rien n’est consommé, reprise quand il y en a un', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL', LONG_AGO), options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);

      const empty = await escalateDueAlerts(uow, deps);
      expect(empty.withoutAudience).toBeGreaterThanOrEqual(1);
      expect(await escalatedAtOf(uow, alertId)).toBeNull();
      expect(await escalatedEvents(uow, alertId)).toEqual([]);

      const direction = await newUser();
      resolver.byRole = { FINANCE: [finance], DIRECTION: [direction] };
      await escalateDueAlerts(uow, deps);
      expect((await escalatedAtOf(uow, alertId))?.toISOString()).toBe(NOW.toISOString());
      expect(await escalatedEvents(uow, alertId)).toHaveLength(1);
      expect((await notificationsOf(uow, direction, alertId)).length).toBeGreaterThanOrEqual(1);
    }));

  it('une panne sur une alerte n’empêche pas l’escalade des autres et n’en consomme pas l’escalade', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      const resolver = new StubResolver({ RESP_FERME: [direction], DIRECTION: [direction] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const healthySite = freshUuid();
      const brokenSite = freshUuid();
      const healthy = freshUuid();
      const broken = freshUuid();
      await handleAlertEvent(uow, highLoss(healthy, healthySite, LONG_AGO), options);
      await handleAlertEvent(uow, highLoss(broken, brokenSite, LONG_AGO), options);
      resolver.poisonSite = brokenSite;
      const result = await escalateDueAlerts(uow, deps);
      expect(result.escalated).toBeGreaterThanOrEqual(1);
      const healthyId = await alertIdOf(uow, lossKey(healthy));
      const brokenId = await alertIdOf(uow, lossKey(broken));
      expect(await escalatedAtOf(uow, healthyId)).not.toBeNull();
      expect(await escalatedAtOf(uow, brokenId)).toBeNull();
      expect(await escalatedEvents(uow, brokenId)).toEqual([]);

      // Le résolveur rétabli : l'alerte en panne est reprise.
      resolver.poisonSite = null;
      await escalateDueAlerts(uow, deps);
      expect(await escalatedAtOf(uow, brokenId)).not.toBeNull();
    }));

  it('une erreur après la pose de l’escalade l’annule : l’alerte reste à escalader', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      const resolver = new StubResolver({ RESP_FERME: [direction] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const location = freshUuid();
      await handleAlertEvent(uow, highLoss(location, freshUuid(), LONG_AGO), options);
      const alertId = await alertIdOf(uow, lossKey(location));
      // Le titulaire du niveau supérieur renvoyé n'est pas un identifiant valide : l'inscription du
      // destinataire échoue **après** la pose de `escalated_at` et de l'événement ; tout doit être annulé.
      resolver.byRole = { RESP_FERME: [direction], DIRECTION: ['pas-un-uuid'] };
      await escalateDueAlerts(uow, deps);
      expect(await escalatedAtOf(uow, alertId)).toBeNull();
      expect(await escalatedEvents(uow, alertId)).toEqual([]);

      resolver.byRole = { RESP_FERME: [direction], DIRECTION: [direction] };
      await escalateDueAlerts(uow, deps);
      expect(await escalatedAtOf(uow, alertId)).not.toBeNull();
    }));

  it('la pose de l’escalade est conditionnelle : une seule fois, jamais sur une alerte prise en compte', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const resolver = new StubResolver({ FINANCE: [finance] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const raise = async () => {
        const session = freshUuid();
        await handleAlertEvent(uow, cashVariance(session, 'CRITICAL', LONG_AGO), options);
        return alertIdOf(uow, `CASH_VARIANCE:${session}`);
      };
      const open = await raise();
      const row = await lockAlertForEscalation(uow, open);
      expect(await markEscalated(uow, deps, row!, NOW, 1)).not.toBeNull();
      expect(await markEscalated(uow, deps, row!, NOW, 1)).toBeNull();

      const acknowledged = await raise();
      const locked = await lockAlert(uow, acknowledged);
      await markAcknowledged(uow, deps, locked!, {
        userId: finance,
        at: new Date('2026-11-02T09:30:00.000Z'),
        commandId: freshUuid(),
      });
      const stale = await lockAlertForEscalation(uow, acknowledged);
      // `stale` est relu après la prise en compte : l'UPDATE conditionnel est le dernier garde-fou.
      expect(await markEscalated(uow, deps, { ...stale!, status: 'OPEN' }, NOW, 1)).toBeNull();
      expect(await escalatedAtOf(uow, acknowledged)).toBeNull();
    }));

  it('les alertes dont la règle n’escalade pas n’affament pas les autres (candidats filtrés par règle)', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      const resolver = new StubResolver({
        FINANCE: [finance],
        RESP_FERME: [direction],
        DIRECTION: [direction],
      });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      for (let i = 0; i < 3; i += 1) {
        await handleAlertEvent(uow, cashVariance(freshUuid(), 'CRITICAL', LONG_AGO), options);
      }
      await uow
        .updateTable('communication_alert_rules')
        .set({ escalation_hours: null })
        .where('alert_type', '=', 'CASH_VARIANCE')
        .execute();
      const location = freshUuid();
      await handleAlertEvent(uow, highLoss(location, freshUuid(), LONG_AGO), options);
      const result = await escalateDueAlerts(uow, deps, { batchSize: 1 });
      expect(await escalatedAtOf(uow, await alertIdOf(uow, lossKey(location)))).not.toBeNull();
      expect(result.escalated).toBeGreaterThanOrEqual(1);
    }));

  it('des alertes échues sans destinataire de niveau supérieur n’affament pas les autres (reprise par curseur)', () =>
    rolledBack(async (uow) => {
      const finance = await newUser();
      const direction = await newUser();
      // CASH_VARIANCE n'a pas de titulaire de son niveau supérieur (DIRECTION) ; HIGH_LOSS en a un.
      const resolver = new StubResolver({ FINANCE: [finance], RESP_FERME: [direction] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      for (let i = 0; i < 3; i += 1) {
        await handleAlertEvent(uow, cashVariance(freshUuid(), 'CRITICAL', LONG_AGO), options);
      }
      resolver.byRole = {
        FINANCE: [finance],
        RESP_FERME: [direction],
        RESP_PRODUCTION: [direction],
      };
      await uow
        .updateTable('communication_alert_rules')
        .set({ escalation_roles: JSON.stringify(['RESP_PRODUCTION']) })
        .where('alert_type', '=', 'HIGH_LOSS')
        .execute();
      const location = freshUuid();
      await handleAlertEvent(uow, highLoss(location, freshUuid(), LONG_AGO), options);
      // Les trois alertes de caisse échues restent sans audience (aucun titulaire de DIRECTION).
      const result = await escalateDueAlerts(uow, deps, { batchSize: 1 });
      expect(result.withoutAudience).toBeGreaterThanOrEqual(3);
      expect(await escalatedAtOf(uow, await alertIdOf(uow, lossKey(location)))).not.toBeNull();
    }));

  it('toutes les alertes échues sont escaladées, lot après lot', () =>
    rolledBack(async (uow) => {
      const direction = await newUser();
      const resolver = new StubResolver({ RESP_FERME: [direction], DIRECTION: [direction] });
      clock.setTo(NOW);
      const { deps, options } = wire(resolver);
      const locations = [freshUuid(), freshUuid(), freshUuid()];
      for (const location of locations) {
        await handleAlertEvent(uow, highLoss(location, freshUuid(), LONG_AGO), options);
      }
      await escalateDueAlerts(uow, deps, { batchSize: 1 });
      for (const location of locations) {
        expect(await escalatedAtOf(uow, await alertIdOf(uow, lossKey(location)))).not.toBeNull();
      }
    }));

  it('push : dans la fenêtre de reprise il part, avec le titre et le corps de la notification', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      const endpoint = await subscribe(user);
      const resolver = new StubResolver({ FINANCE: [user] });
      clock.setTo(NOW);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL'), wire(resolver).options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      const sender = new FakeSender(true);
      await dispatchPendingPushes(uow, {
        clock: new FixedClock(new Date(NOW.getTime() + 59 * 60_000)),
        sender,
      });
      const sent = sender.sent.filter((s) => s.message.alertId === alertId);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.target.endpoint).toBe(endpoint);
      const row = (await notificationsOf(uow, user, alertId)).find(
        (n) => n.channel === 'WEB_PUSH',
      )!;
      expect(sent[0]!.message).toMatchObject({
        title: row.title,
        body: row.body,
        tag: 'alert:CASH_VARIANCE',
      });
    }));

  it('push : un appareil devenu hors service entre la création et l’envoi ne reçoit rien', () =>
    rolledBack(async (uow) => {
      const user = await newUser();
      const endpoint = await subscribe(user);
      const resolver = new StubResolver({ FINANCE: [user] });
      clock.setTo(NOW);
      const session = freshUuid();
      await handleAlertEvent(uow, cashVariance(session, 'CRITICAL'), wire(resolver).options);
      const alertId = await alertIdOf(uow, `CASH_VARIANCE:${session}`);
      const subscription = await uow
        .selectFrom('communication_push_subscriptions')
        .select('device_id')
        .where('endpoint', '=', endpoint)
        .executeTakeFirstOrThrow();
      await uow
        .updateTable('identity_devices')
        .set({ status: 'LOST', status_changed_at: NOW })
        .where('id', '=', subscription.device_id)
        .execute();
      const sender = new FakeSender(true);
      await dispatchPendingPushes(uow, { clock, sender });
      expect(sender.sent.filter((s) => s.message.alertId === alertId)).toEqual([]);
    }));
});

describe('P9-11 : insertion groupée des notifications', () => {
  const rowFor = (userId: string, sourceEventId: string) => ({
    userId,
    channel: 'IN_APP' as const,
    kind: 'DIRECT' as const,
    sourceType: 'APPROVAL_REQUEST',
    sourceId: freshUuid(),
    sourceEventId,
    title: 'Titre',
    body: 'Corps',
    link: null,
    createdAt: NOW,
    deliveredAt: NOW,
  });

  it('par lots : aucune ligne perdue ni doublée, quel que soit le découpage ; un rejeu n’écrit rien', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => newUser()));
    for (const chunkSize of [1, 2, 3, 5, 8, undefined]) {
      await rolledBack(async (uow) => {
        const eventId = freshUuid();
        const rows = users.map((userId) => rowFor(userId, eventId));
        const options = chunkSize === undefined ? {} : { chunkSize };
        expect(await insertNotifications(uow, idGenerator, rows, options), `lot ${chunkSize}`).toBe(
          5,
        );
        for (const userId of users) {
          expect(await notificationsOf(uow, userId), `lot ${chunkSize}`).toHaveLength(1);
        }
        // Même événement, mêmes destinataires : rien de plus.
        expect(await insertNotifications(uow, idGenerator, rows, options)).toBe(0);
        // Un destinataire de plus : seule sa ligne est écrite.
        const extra = await newUser();
        expect(
          await insertNotifications(uow, idGenerator, [...rows, rowFor(extra, eventId)], options),
        ).toBe(1);
        // Jeu hors ligne `comms` : une ligne de flux par notification écrite, aucune pour une ligne ignorée.
        for (const userId of [...users, extra]) {
          const feed = await uow
            .selectFrom('sync_change_feed')
            .select('entity_id')
            .where('dataset', '=', 'comms')
            .where('entity_type', '=', 'NOTIFICATION')
            .where('scope_id', '=', toBin(userId))
            .execute();
          expect(feed, `lot ${chunkSize}`).toHaveLength(1);
          const own = await notificationsOf(uow, userId);
          expect(feed[0]!.entity_id.equals(own[0]!.id), `lot ${chunkSize}`).toBe(true);
        }
      });
    }
  });

  it('une ligne ignorée (rejeu) ne publie aucune ligne de flux ; seul le canal IN_APP est publié', () =>
    rolledBack(async (uow) => {
      const [user, other] = await Promise.all([newUser(), newUser()]);
      const eventId = freshUuid();
      const feedOf = (userId: string) =>
        uow
          .selectFrom('sync_change_feed')
          .select('entity_id')
          .where('dataset', '=', 'comms')
          .where('entity_type', '=', 'NOTIFICATION')
          .where('scope_id', '=', toBin(userId))
          .execute();
      // Une notification, puis le même événement rejoué : une seule ligne de flux.
      expect(await insertNotification(uow, idGenerator, rowFor(user, eventId))).toBe(true);
      expect(await insertNotification(uow, idGenerator, rowFor(user, eventId))).toBe(false);
      expect(await feedOf(user)).toHaveLength(1);
      // L'envoi push n'est jamais dans le jeu de l'appareil, seul ou dans un lot.
      expect(
        await insertNotification(uow, idGenerator, {
          ...rowFor(user, freshUuid()),
          channel: 'WEB_PUSH',
        }),
      ).toBe(true);
      expect(await feedOf(user)).toHaveLength(1);
      const mixed = freshUuid();
      expect(
        await insertNotifications(uow, idGenerator, [
          rowFor(other, mixed),
          { ...rowFor(other, mixed), channel: 'WEB_PUSH' },
        ]),
      ).toBe(2);
      expect(await feedOf(other)).toHaveLength(1);
    }));

  it('une liste vide n’écrit rien', () =>
    rolledBack(async (uow) => {
      expect(await insertNotifications(uow, idGenerator, [])).toBe(0);
    }));
});
