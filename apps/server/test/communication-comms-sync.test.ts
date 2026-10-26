/**
 * P9-12 : jeu hors ligne `comms` (ADR-070 §6, ADR-073 §4 ; AV-483 à AV-486 ; AT-048 hors ligne) — alertes de la
 * boîte, notifications non lues, notes avec l'état de lecture de l'utilisateur — par le **vrai** pull
 * (`SyncPullService`), les vraies commandes (accusé, lecture, publication, archivage), le vrai consommateur
 * d'alertes et la base partagée. Chaque test crée ses utilisateurs, sites, alertes et notes ; le curseur de
 * départ est celui du début du fichier, les lignes lues sont filtrées par leurs identifiants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerAlertCommands } from '../src/modules/communication/application/commands/alert-commands.js';
import { registerNoteCommands } from '../src/modules/communication/application/commands/note-commands.js';
import { registerNotificationCommands } from '../src/modules/communication/application/commands/notification-commands.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { markEscalated } from '../src/modules/communication/application/alerts/alert-store.js';
import {
  addRecipients,
  createAlertNotifier,
} from '../src/modules/communication/application/notifications/alert-notifier.js';
import { insertNotification } from '../src/modules/communication/application/notifications/notification-store.js';
import { DisabledWebPushSender } from '../src/modules/communication/application/notifications/web-push.js';
import type {
  AlertRecipientResolver,
  RoleHolder,
} from '../src/modules/communication/application/recipients/recipient-resolver.js';
import { IdentityNoteAudienceResolver } from '../src/communication-api/identity-note-audience-resolver.js';
import type { DomainEvent } from '../src/platform/events/domain-event.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { committed } from './communication-test-kit.js';
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

const NOW_MS = Date.now();
const clock = new FixedClock(new Date(NOW_MS));
const idGenerator = new Uuidv7Generator(clock);
const minutes = (count: number): Date => new Date(NOW_MS + count * 60_000);
/**
 * Dates de détection futures et propres à l'exécution (comme `communication-read.e2e`) : les alertes critiques
 * que ce fichier valide dans la base partagée ne deviennent jamais « échues » pour l'escalade, qui affamerait
 * les tests d'escalade de P9-05 (ils parcourent les candidats par identifiant croissant).
 */
const detectedAt = (count: number): Date => new Date(NOW_MS + 400 * 86_400_000 + count * 60_000);

interface Actor {
  readonly id: string;
  readonly deviceId: string;
}

/** Résolveur contrôlé : les destinataires sont ceux que le test fixe, quel que soit le rôle demandé. */
class FixedResolver implements AlertRecipientResolver {
  users: readonly string[] = [];
  async usersHoldingRolesAt(
    _uow: unknown,
    input: { readonly roles: readonly string[] },
  ): Promise<readonly RoleHolder[]> {
    return this.users.map((userId) => ({ userId, roleCode: input.roles[0] ?? 'DIRECTION' }));
  }
  async usersHoldingPermissionAt(): Promise<readonly string[]> {
    return [];
  }
  async activeUsersAmong(): Promise<readonly string[]> {
    return [];
  }
  async teamManagersOf(): Promise<readonly string[]> {
    return [];
  }
}

let eventSeq = 9_800_000_000;
function eventOf(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  occurredAt = detectedAt(0),
): DomainEvent {
  eventSeq += 1;
  return {
    seq: eventSeq,
    eventId: freshUuid(),
    eventType,
    eventVersion: 1,
    producerModule: 'test',
    aggregateType: 'TEST',
    aggregateId,
    occurredAt,
    recordedAt: occurredAt,
    payload,
    commandId: null,
    correlationId: null,
    causationId: null,
  };
}

let deviceSeq = 40_000;

describe('jeu hors ligne comms (P9-12)', () => {
  const resolver = new FixedResolver();
  const pullService = new SyncPullService(db, { settleSeconds: 0 });
  let pipeline: CommandPipelineService;
  let cursor0: number;

  let siteA: string;
  let siteB: string;
  let director: Actor; // publie les notes
  let staffA: Actor; // site A, lecture et prise en compte des alertes
  let staffB: Actor; // site B
  let valuer: Actor; // site A, avec la valeur au coût
  let outsider: Actor; // aucune affectation
  let reader: Actor; // lit ses notifications (comm.alert.read), sans affectation de site

  async function newActor(trx: Parameters<typeof insertTestDevice>[0]): Promise<Actor> {
    const id = await insertTestUser(trx);
    return { id, deviceId: await insertTestDevice(trx, id, { status: 'ACTIVE' }) };
  }

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerAlertCommands(registry, idGenerator);
    registerNotificationCommands(registry, idGenerator);
    registerNoteCommands(registry, {
      idGenerator,
      clock,
      audience: new IdentityNoteAudienceResolver(),
    });
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    const cursor = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(cursor?.seq ?? 0);

    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      const zone = await insertTestZone(trx, admin);
      siteA = await insertTestSite(trx, admin, zone);
      siteB = await insertTestSite(trx, admin, zone);

      const directorRole = await insertTestRole(trx, admin);
      for (const code of ['comm.note.publish', 'comm.note.read', 'comm.alert.read']) {
        await grantTestPermission(trx, directorRole, code, admin);
      }
      director = await newActor(trx);
      await assignTestRole(trx, director.id, directorRole, admin);

      const staffRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      for (const code of ['comm.note.read', 'comm.alert.read', 'comm.alert.manage']) {
        await grantTestPermission(trx, staffRole, code, admin);
      }
      staffA = await newActor(trx);
      await assignTestRole(trx, staffA.id, staffRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      staffB = await newActor(trx);
      await assignTestRole(trx, staffB.id, staffRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteB,
      });

      const valuerRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      for (const code of ['comm.note.read', 'comm.alert.read', 'inventory.valuation.read']) {
        await grantTestPermission(trx, valuerRole, code, admin);
      }
      valuer = await newActor(trx);
      await assignTestRole(trx, valuer.id, valuerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      outsider = await newActor(trx);

      const readerRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, readerRole, 'comm.alert.read', admin);
      reader = await newActor(trx);
      await assignTestRole(trx, reader.id, readerRole, admin);
    });
  });

  afterAll(closeTestDb);

  // ---- Aides ------------------------------------------------------------------------------------------------

  const raise = (event: DomainEvent) =>
    committed((uow) =>
      handleAlertEvent(uow, event, {
        idGenerator,
        afterRaise: createAlertNotifier({
          idGenerator,
          clock,
          resolver,
          push: new DisabledWebPushSender(),
        }),
      }),
    );

  const alertIdOf = async (dedupKey: string): Promise<string> => {
    const row = await db
      .selectFrom('communication_alerts')
      .select('id')
      .where('dedup_key', '=', dedupKey)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  };

  /** Tout ce que le jeu `comms` apporte à l'utilisateur depuis le début du fichier. */
  async function pull(actor: Actor): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset: 'comms', cursor: cursor0, limit: 500 },
      { authenticatedUserId: actor.id, authenticatedDeviceId: actor.deviceId, now: new Date() },
    );
    return response.changes;
  }
  /** La dernière ligne de l'élément (le pull ne sert que la dernière par page). */
  const last = (changes: readonly Change[], type: string, id: string): Change | undefined =>
    changes.filter((change) => change.entity_type === type && change.entity_id === id).at(-1);
  const feedRows = async (type: string, id: string, userId: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['change_type', 'scope_type'])
      .where('dataset', '=', 'comms')
      .where('entity_type', '=', type)
      .where('entity_id', '=', toBin(id))
      .where('scope_id', '=', toBin(userId))
      .orderBy('seq')
      .execute();

  async function command(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    options: { readonly at?: Date; readonly offline?: boolean } = {},
  ) {
    const at = options.at ?? minutes(0);
    clock.setTo(at);
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.id,
        base_version: null,
        depends_on: [],
        occurred_at: at.toISOString(),
        client_created_at: at.toISOString(),
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.id,
        authenticatedDeviceId: actor.deviceId,
        transport: 'SYNC_PUSH',
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    clock.setTo(new Date(NOW_MS));
    return result;
  }

  const sessionOpenLong = (session: string, hours: number) =>
    eventOf('CashSessionOpenLongDetected', session, {
      session_id: session,
      opened_by: freshUuid(),
      site_id: siteA,
      hours_open: hours,
    });

  // ---- Alertes ------------------------------------------------------------------------------------------------

  describe('alertes de la boîte', () => {
    it('chaque destinataire reçoit l’alerte ouverte avec son état ; un autre utilisateur ne reçoit rien', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id, staffB.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);

      for (const actor of [staffA, staffB]) {
        const change = last(await pull(actor), 'ALERT', alertId);
        expect(change, actor.id).toMatchObject({
          change_type: 'UPSERT',
          scope_type: 'USER',
          scope_id: actor.id,
          dataset: 'comms',
        });
        expect(change!.data).toMatchObject({
          id: alertId,
          alert_type: 'CASH_SESSION_OPEN_LONG',
          nature: 'STATE',
          status: 'OPEN',
          site_id: siteA,
          occurrences: 1,
        });
        expect(change!.data).toHaveProperty('title');
        expect(change!.data).toHaveProperty('message');
      }
      expect(last(await pull(outsider), 'ALERT', alertId)).toBeUndefined();
      expect(last(await pull(valuer), 'ALERT', alertId)).toBeUndefined();
    });

    it('une occurrence qui ne change rien ne republie rien ; un message ou une gravité qui change, si', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      expect(await feedRows('ALERT', alertId, staffA.id)).toHaveLength(1);

      await raise(sessionOpenLong(session, 30));
      expect(await feedRows('ALERT', alertId, staffA.id)).toHaveLength(1);

      await raise(sessionOpenLong(session, 36));
      expect(await feedRows('ALERT', alertId, staffA.id)).toHaveLength(2);
      const change = last(await pull(staffA), 'ALERT', alertId);
      expect(change!.data).toMatchObject({ occurrences: 3 });
      expect(String(change!.data!['message'])).toContain('36');

      // Gravité relevée : la boîte est republiée.
      const variance = freshUuid();
      await raise(
        eventOf('CashVarianceDetected', variance, {
          session_id: variance,
          variance_xaf: -15_000,
          severity: 'WARNING',
          site_id: siteA,
        }),
      );
      const varianceId = await alertIdOf(`CASH_VARIANCE:${variance}`);
      expect(await feedRows('ALERT', varianceId, staffA.id)).toHaveLength(1);
      await raise(
        eventOf('CashVarianceDetected', variance, {
          session_id: variance,
          variance_xaf: -15_000,
          severity: 'CRITICAL',
          site_id: siteA,
        }),
      );
      expect(await feedRows('ALERT', varianceId, staffA.id)).toHaveLength(2);
      expect(last(await pull(staffA), 'ALERT', varianceId)!.data).toMatchObject({
        severity: 'CRITICAL',
      });
    });

    it('la prise en compte par commande republie l’état à tous les destinataires', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id, staffB.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      for (const actor of [staffA, staffB]) {
        expect(await feedRows('ALERT', alertId, actor.id)).toHaveLength(1);
      }
      await command(staffA, 'communication.alert.acknowledge', 'ALERT', alertId, {
        comment: 'Je m’en occupe',
      });
      for (const actor of [staffA, staffB]) {
        // Une ligne de plus pour chaque destinataire : le pull ne montre que l'état courant.
        expect(await feedRows('ALERT', alertId, actor.id)).toHaveLength(2);
        const change = last(await pull(actor), 'ALERT', alertId);
        expect(change).toMatchObject({ change_type: 'UPSERT' });
        expect(change!.data).toMatchObject({
          status: 'ACKNOWLEDGED',
          acknowledged_by: staffA.id,
        });
      }
    });

    it('une alerte close sort de la boîte de chacun : par la condition disparue, par l’écart décidé', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id, staffB.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      await raise(eventOf('CashSessionClosed', session, { session_id: session }, detectedAt(5)));
      for (const actor of [staffA, staffB]) {
        const change = last(await pull(actor), 'ALERT', alertId);
        expect(change).toMatchObject({ change_type: 'SCOPE_EXIT', scope_type: 'USER' });
        expect(change!.data).toBeUndefined();
      }

      const location = freshUuid();
      await raise(
        eventOf('HighLossDetected', location, {
          location_id: location,
          business_day: '2026-12-31',
          loss_quantity: 8,
          loss_value_xaf: 120_000,
          site_id: siteA,
        }),
      );
      const lossId = await alertIdOf(`HIGH_LOSS:LOSS_DAY:${location}:2026-12-31`);
      expect(last(await pull(staffA), 'ALERT', lossId)).toMatchObject({ change_type: 'UPSERT' });
      await command(staffA, 'communication.alert.dismiss', 'ALERT', lossId, {
        reason: 'Pertes déjà expliquées',
      });
      for (const actor of [staffA, staffB]) {
        expect(last(await pull(actor), 'ALERT', lossId)).toMatchObject({
          change_type: 'SCOPE_EXIT',
        });
      }
    });

    it('l’escalade republie l’alerte à ses destinataires avec la date d’escalade', async () => {
      const variance = freshUuid();
      resolver.users = [staffA.id, staffB.id];
      await raise(
        eventOf('CashVarianceDetected', variance, {
          session_id: variance,
          variance_xaf: -15_000,
          severity: 'CRITICAL',
          site_id: siteA,
        }),
      );
      const alertId = await alertIdOf(`CASH_VARIANCE:${variance}`);
      expect(last(await pull(staffA), 'ALERT', alertId)!.data).toMatchObject({
        escalated_at: null,
      });
      const escalated = await committed((uow) =>
        markEscalated(
          uow,
          { idGenerator },
          {
            id: alertId,
            alertType: 'CASH_VARIANCE',
            status: 'OPEN',
            severity: 'CRITICAL',
            criticalSince: minutes(0),
            escalatedAt: null,
            siteId: siteA,
            zoneId: null,
            ownerUserId: null,
            payload: {},
          },
          minutes(2),
          1,
        ),
      );
      expect(escalated).not.toBeNull();
      for (const actor of [staffA, staffB]) {
        expect(await feedRows('ALERT', alertId, actor.id)).toHaveLength(2);
        expect(last(await pull(actor), 'ALERT', alertId)!.data).toMatchObject({
          escalated_at: minutes(2),
        });
      }
    });

    it('un destinataire ajouté après coup reçoit l’alerte, sans doubler les autres', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      expect(last(await pull(staffB), 'ALERT', alertId)).toBeUndefined();
      await committed((uow) =>
        addRecipients(
          uow,
          alertId,
          [{ userId: staffB.id, origin: 'ESCALATION', roleCode: 'DIRECTION' }],
          minutes(10),
        ),
      );
      expect(last(await pull(staffB), 'ALERT', alertId)).toMatchObject({ change_type: 'UPSERT' });
      expect(await feedRows('ALERT', alertId, staffA.id)).toHaveLength(1);
    });

    it('la valeur au coût n’est dans le message que pour qui détient inventory.valuation.read (RC-05)', async () => {
      const location = freshUuid();
      resolver.users = [staffA.id, valuer.id];
      await raise(
        eventOf('HighLossDetected', location, {
          location_id: location,
          business_day: '2026-12-31',
          loss_quantity: 8,
          loss_value_xaf: 120_000,
          site_id: siteA,
        }),
      );
      const alertId = await alertIdOf(`HIGH_LOSS:LOSS_DAY:${location}:2026-12-31`);
      const masked = last(await pull(staffA), 'ALERT', alertId)!.data!;
      const full = last(await pull(valuer), 'ALERT', alertId)!.data!;
      expect(String(masked['message'])).not.toMatch(/120\s?000/);
      expect(String(full['message'])).toMatch(/120\s?000/);
      // La charge utile servie ne porte jamais la valeur, ni pour l'un ni pour l'autre.
      expect(masked['payload']).not.toHaveProperty('loss_value_xaf');
      expect(full['payload']).not.toHaveProperty('loss_value_xaf');

      // Une notification d'alerte au texte figé à la création (valeur au coût comprise) est rendue au droit
      // courant du destinataire, pas servie telle quelle.
      const stale = async (userId: string): Promise<string> => {
        const sourceEventId = freshUuid();
        await committed((uow) =>
          insertNotification(uow, idGenerator, {
            userId,
            channel: 'IN_APP',
            kind: 'ALERT',
            alertId,
            alertType: 'HIGH_LOSS',
            sourceType: 'ALERT',
            sourceId: alertId,
            sourceEventId,
            title: 'Perte anormale',
            body: 'Valeur perdue : 999 XAF',
            link: null,
            createdAt: minutes(-1),
            deliveredAt: minutes(-1),
          }),
        );
        const row = await db
          .selectFrom('communication_notifications')
          .select('id')
          .where('source_event_id', '=', toBin(sourceEventId))
          .executeTakeFirstOrThrow();
        return fromBin(row.id);
      };
      const staleOfStaff = await stale(staffA.id);
      const staleOfValuer = await stale(valuer.id);
      const maskedBody = String(
        last(await pull(staffA), 'NOTIFICATION', staleOfStaff)!.data!['body'],
      );
      expect(maskedBody).not.toMatch(/XAF/);
      expect(maskedBody).not.toContain('Valeur');
      expect(
        String(last(await pull(valuer), 'NOTIFICATION', staleOfValuer)!.data!['body']),
      ).toMatch(/Valeur perdue : 120\s000 XAF/);
    });
  });

  // ---- Notifications ------------------------------------------------------------------------------------------

  describe('notifications non lues', () => {
    it('chaque notification IN_APP rejoint son destinataire ; la lecture la retire', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id, staffB.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      const notifications = await db
        .selectFrom('communication_notifications')
        .select(['id', 'user_id'])
        .where('alert_id', '=', toBin(alertId))
        .execute();
      const ofStaffA = notifications.find((row) => fromBin(row.user_id) === staffA.id)!;
      const ofStaffB = notifications.find((row) => fromBin(row.user_id) === staffB.id)!;
      const idA = fromBin(ofStaffA.id);

      const change = last(await pull(staffA), 'NOTIFICATION', idA);
      expect(change).toMatchObject({ change_type: 'UPSERT', scope_type: 'USER' });
      expect(change!.data).toMatchObject({
        id: idA,
        kind: 'ALERT',
        alert_id: alertId,
        source_type: 'ALERT',
      });
      // Jamais celle d'un autre : la ligne de B n'est pas dans le jeu de A.
      expect(last(await pull(staffA), 'NOTIFICATION', fromBin(ofStaffB.id))).toBeUndefined();

      await command(staffA, 'communication.notification.read', 'NOTIFICATION', idA, {
        notificationIds: [idA],
      });
      expect(last(await pull(staffA), 'NOTIFICATION', idA)).toMatchObject({
        change_type: 'SCOPE_EXIT',
      });
      // Celle de B reste non lue : la lecture de A n'y touche pas.
      expect(last(await pull(staffB), 'NOTIFICATION', fromBin(ofStaffB.id))).toMatchObject({
        change_type: 'UPSERT',
      });
    });

    it('« tout marquer lu » retire toutes les non lues ; une notification WEB_PUSH n’est jamais dans le jeu', async () => {
      const created = minutes(-5);
      const ids = {
        one: freshUuid(),
        two: freshUuid(),
      };
      await committed(async (uow) => {
        for (const [index, key] of [ids.one, ids.two].entries()) {
          await insertNotification(uow, idGenerator, {
            userId: reader.id,
            channel: 'IN_APP',
            kind: 'DIRECT',
            sourceType: 'APPROVAL_REQUEST',
            sourceId: key,
            sourceEventId: key,
            title: `Direct ${index}`,
            body: 'Corps',
            link: null,
            createdAt: created,
            deliveredAt: created,
          });
        }
        await insertNotification(uow, idGenerator, {
          userId: reader.id,
          channel: 'WEB_PUSH',
          kind: 'DIRECT',
          sourceType: 'APPROVAL_REQUEST',
          sourceId: ids.one,
          sourceEventId: ids.one,
          title: 'Push',
          body: 'Corps',
          link: null,
          createdAt: created,
        });
      });
      const rows = await db
        .selectFrom('communication_notifications')
        .select(['id', 'channel'])
        .where('user_id', '=', toBin(reader.id))
        .where('source_id', 'in', [toBin(ids.one), toBin(ids.two)])
        .execute();
      const inApp = rows.filter((row) => row.channel === 'IN_APP').map((row) => fromBin(row.id));
      const push = rows.filter((row) => row.channel === 'WEB_PUSH').map((row) => fromBin(row.id));
      expect(inApp).toHaveLength(2);
      expect(push).toHaveLength(1);

      let changes = await pull(reader);
      for (const id of inApp) {
        expect(last(changes, 'NOTIFICATION', id)).toMatchObject({ change_type: 'UPSERT' });
      }
      expect(last(changes, 'NOTIFICATION', push[0]!)).toBeUndefined();
      expect(await feedRows('NOTIFICATION', push[0]!, reader.id)).toEqual([]);

      await command(reader, 'communication.notification.read', 'NOTIFICATION', freshUuid(), {
        all: true,
      });
      changes = await pull(reader);
      for (const id of inApp) {
        expect(last(changes, 'NOTIFICATION', id)).toMatchObject({ change_type: 'SCOPE_EXIT' });
      }
    });
  });

  // ---- Lignes de flux émises à tort -------------------------------------------------------------------------

  describe('lignes émises à tort', () => {
    const forge = (entityType: string, entityId: string, userId: string) =>
      db
        .insertInto('sync_change_feed')
        .values({
          dataset: 'comms',
          entity_type: entityType,
          entity_id: toBin(entityId),
          change_type: 'UPSERT',
          scope_type: 'USER',
          scope_id: toBin(userId),
          row_version: 1,
        })
        .execute();

    it('une alerte n’est servie qu’à ses destinataires : la supervision par la portée reste en ligne', async () => {
      const session = freshUuid();
      resolver.users = [staffA.id];
      await raise(sessionOpenLong(session, 30));
      const alertId = await alertIdOf(`CASH_SESSION_OPEN_LONG:${session}`);
      // La Direction lit toute alerte en ligne (supervision) mais n'est pas destinataire : une ligne émise
      // à tort pour elle ne sert rien.
      await forge('ALERT', alertId, director.id);
      expect(last(await pull(director), 'ALERT', alertId)).toBeUndefined();
      expect(last(await pull(staffA), 'ALERT', alertId)).toMatchObject({ change_type: 'UPSERT' });
    });

    it('une notification lue, d’un autre utilisateur ou d’un autre canal n’est jamais servie', async () => {
      const created = minutes(-5);
      const key = freshUuid();
      const pushKey = freshUuid();
      await committed(async (uow) => {
        await insertNotification(uow, idGenerator, {
          userId: staffB.id,
          channel: 'IN_APP',
          kind: 'DIRECT',
          sourceType: 'APPROVAL_REQUEST',
          sourceId: key,
          sourceEventId: key,
          title: 'À lire',
          body: 'Corps',
          link: null,
          createdAt: created,
          deliveredAt: created,
        });
        await insertNotification(uow, idGenerator, {
          userId: staffB.id,
          channel: 'WEB_PUSH',
          kind: 'DIRECT',
          sourceType: 'APPROVAL_REQUEST',
          sourceId: pushKey,
          sourceEventId: pushKey,
          title: 'Push',
          body: 'Corps',
          link: null,
          createdAt: created,
        });
      });
      const rows = await db
        .selectFrom('communication_notifications')
        .select(['id', 'channel'])
        .where('user_id', '=', toBin(staffB.id))
        .where('source_id', 'in', [toBin(key), toBin(pushKey)])
        .execute();
      const inApp = fromBin(rows.find((row) => row.channel === 'IN_APP')!.id);
      const push = fromBin(rows.find((row) => row.channel === 'WEB_PUSH')!.id);

      // Celle d'un autre utilisateur : une ligne émise pour staffA ne sert pas la notification de staffB.
      await forge('NOTIFICATION', inApp, staffA.id);
      expect(last(await pull(staffA), 'NOTIFICATION', inApp)).toBeUndefined();
      // Le canal d'envoi n'est pas une notification de l'appareil.
      await forge('NOTIFICATION', push, staffB.id);
      expect(last(await pull(staffB), 'NOTIFICATION', push)).toBeUndefined();
      // Lue, elle sort ; une ligne émise ensuite ne la rend pas.
      await command(staffB, 'communication.notification.read', 'NOTIFICATION', inApp, {
        notificationIds: [inApp],
      });
      await forge('NOTIFICATION', inApp, staffB.id);
      expect(last(await pull(staffB), 'NOTIFICATION', inApp)).toBeUndefined();
      // Lire l'envoi push ne produit aucune sortie : il n'a jamais été dans le jeu.
      await command(staffB, 'communication.notification.read', 'NOTIFICATION', push, {
        notificationIds: [push],
      });
      expect(
        (await feedRows('NOTIFICATION', push, staffB.id)).map((row) => row.change_type),
      ).toEqual(['UPSERT']);
    });

    it('une note retirée n’est plus servie, même par une ligne émise ensuite', async () => {
      const noteId = freshUuid();
      await command(director, 'communication.note.publish', 'INTERNAL_NOTE', noteId, {
        title: 'Éphémère',
        body: 'Corps',
        category: 'INFORMATION',
        requiresAck: false,
        audience: [{ type: 'SITE', ref: siteA }],
      });
      expect(last(await pull(staffA), 'NOTE', noteId)).toMatchObject({ change_type: 'UPSERT' });
      await command(director, 'communication.note.archive', 'INTERNAL_NOTE', noteId, {
        reason: 'Retirée',
      });
      await forge('NOTE', noteId, staffA.id);
      expect(last(await pull(staffA), 'NOTE', noteId)).toBeUndefined();
    });
  });

  // ---- Notes (AT-048) -----------------------------------------------------------------------------------------

  describe('notes de direction', () => {
    const noteBody = (title: string, site: string, extra: Record<string, unknown> = {}) => ({
      title,
      body: `Corps de ${title}`,
      category: 'INSTRUCTION',
      requiresAck: true,
      audience: [{ type: 'SITE', ref: site }],
      ...extra,
    });
    const publish = async (title: string, site: string, extra: Record<string, unknown> = {}) => {
      const noteId = freshUuid();
      await command(
        director,
        'communication.note.publish',
        'INTERNAL_NOTE',
        noteId,
        noteBody(title, site, extra),
      );
      return noteId;
    };

    it('AT-048 : publiée au site, lue et accusée hors ligne, puis retirée — le jeu suit chaque étape', async () => {
      const noteId = await publish('Nouveau prix du plateau', siteA);

      // Publication : chaque utilisateur touché reçoit la note (à accuser) et sa notification ; l'auteur et
      // les autres sites, rien.
      const notificationOf = async (userId: string) => {
        const row = await db
          .selectFrom('communication_notifications')
          .select('id')
          .where('note_id', '=', toBin(noteId))
          .where('user_id', '=', toBin(userId))
          .executeTakeFirst();
        return row === undefined ? undefined : fromBin(row.id);
      };
      const received = await pull(staffA);
      const note = last(received, 'NOTE', noteId);
      expect(note).toMatchObject({
        change_type: 'UPSERT',
        scope_type: 'USER',
        scope_id: staffA.id,
      });
      expect(note!.data).toMatchObject({
        id: noteId,
        title: 'Nouveau prix du plateau',
        category: 'INSTRUCTION',
        requires_ack: true,
        author_user_id: director.id,
        read_at: null,
        acknowledged_at: null,
      });
      // L'audience n'est pas jointe : l'appareil n'a pas à la connaître.
      expect(note!.data).not.toHaveProperty('audience');
      const notificationId = (await notificationOf(staffA.id))!;
      expect(last(received, 'NOTIFICATION', notificationId)!.data).toMatchObject({
        kind: 'NOTE',
        note_id: noteId,
        source_type: 'NOTE',
      });
      for (const stranger of [staffB, director, outsider]) {
        const changes = await pull(stranger);
        expect(last(changes, 'NOTE', noteId), stranger.id).toBeUndefined();
      }

      // Lecture puis accusé hors ligne, plus tard : la note revient avec l'état enregistré, la notification
      // sort des non lues.
      await command(
        staffA,
        'communication.note.acknowledge',
        'INTERNAL_NOTE',
        noteId,
        { kind: 'READ' },
        { at: minutes(3), offline: true },
      );
      let changes = await pull(staffA);
      expect(last(changes, 'NOTE', noteId)!.data).toMatchObject({
        read_at: minutes(3),
        acknowledged_at: null,
      });
      expect(last(changes, 'NOTIFICATION', notificationId)).toMatchObject({
        change_type: 'SCOPE_EXIT',
      });
      await command(
        staffA,
        'communication.note.acknowledge',
        'INTERNAL_NOTE',
        noteId,
        { kind: 'ACKNOWLEDGE' },
        { at: minutes(4), offline: true },
      );
      changes = await pull(staffA);
      expect(last(changes, 'NOTE', noteId)!.data).toMatchObject({
        read_at: minutes(3),
        acknowledged_at: minutes(4),
      });
      // L'accusé d'un utilisateur ne change rien pour les autres destinataires : celui du même site reçoit la
      // note sans état de lecture.
      expect(last(await pull(valuer), 'NOTE', noteId)!.data).toMatchObject({
        read_at: null,
        acknowledged_at: null,
      });
      const other = await db
        .selectFrom('communication_note_acknowledgements')
        .select('user_id')
        .where('note_id', '=', toBin(noteId))
        .execute();
      expect(other.map((row) => fromBin(row.user_id))).toEqual([staffA.id]);

      // Retrait : la note sort de l'appareil de ceux qui la détiennent.
      await command(director, 'communication.note.archive', 'INTERNAL_NOTE', noteId, {
        reason: 'Prix corrigé',
      });
      expect(last(await pull(staffA), 'NOTE', noteId)).toMatchObject({
        change_type: 'SCOPE_EXIT',
      });
      expect(last(await pull(valuer), 'NOTE', noteId)).toMatchObject({
        change_type: 'SCOPE_EXIT',
      });
    });

    it('un utilisateur affecté après la publication reçoit la note quand il la lit, et son retrait', async () => {
      const noteId = await publish('Consigne de zone', siteB);
      const late = await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        const actor = await newActor(trx);
        const readerRole = await insertTestRole(trx, admin);
        await grantTestPermission(trx, readerRole, 'comm.note.read', admin);
        await assignTestRole(trx, actor.id, readerRole, admin);
        const siteRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
        await assignTestRole(trx, actor.id, siteRole, admin, {
          scopeType: 'SITE',
          scopeSiteId: siteB,
          validFrom: minutes(1),
        });
        return actor;
      });
      // Jamais reçue par la publication (limite assumée, ADR-073 §4) ; reçue dès qu'il la lit.
      expect(last(await pull(late), 'NOTE', noteId)).toBeUndefined();
      await command(
        late,
        'communication.note.acknowledge',
        'INTERNAL_NOTE',
        noteId,
        { kind: 'READ' },
        { at: minutes(2) },
      );
      expect(last(await pull(late), 'NOTE', noteId)!.data).toMatchObject({
        id: noteId,
        read_at: minutes(2),
      });
      await command(director, 'communication.note.archive', 'INTERNAL_NOTE', noteId, {
        reason: 'Obsolète',
      });
      expect(last(await pull(late), 'NOTE', noteId)).toMatchObject({ change_type: 'SCOPE_EXIT' });
      expect(last(await pull(staffB), 'NOTE', noteId)).toMatchObject({ change_type: 'SCOPE_EXIT' });
    });

    it('une note expirée n’est pas servie ; une ligne émise à tort ne sert ni la note, ni un autre utilisateur', async () => {
      // Note publiée puis expirée (écrite directement : la commande refuse une expiration passée).
      const expired = freshUuid();
      const published = minutes(-120);
      await db
        .insertInto('communication_internal_notes')
        .values({
          id: toBin(expired),
          title: 'Expirée',
          body: 'Ancienne consigne.',
          category: 'INFORMATION',
          status: 'DRAFT',
          created_by: toBin(director.id),
        })
        .execute();
      await db
        .updateTable('communication_internal_notes')
        .set({
          status: 'PUBLISHED',
          published_at: published,
          expires_at: new Date(published.getTime() + 60 * 60_000),
        })
        .where('id', '=', toBin(expired))
        .execute();
      await db
        .insertInto('communication_notifications')
        .values({
          id: toBin(freshUuid()),
          user_id: toBin(staffA.id),
          channel: 'IN_APP',
          kind: 'NOTE',
          note_id: toBin(expired),
          source_type: 'NOTE',
          source_id: toBin(expired),
          title: 'Expirée',
          body: 'Note de la Direction',
        })
        .execute();
      await db
        .insertInto('sync_change_feed')
        .values({
          dataset: 'comms',
          entity_type: 'NOTE',
          entity_id: toBin(expired),
          change_type: 'UPSERT',
          scope_type: 'USER',
          scope_id: toBin(staffA.id),
          row_version: 1,
        })
        .execute();
      expect(last(await pull(staffA), 'NOTE', expired)).toBeUndefined();

      // Une note vivante dont la ligne est émise pour un utilisateur qu'elle n'a jamais touché : rien.
      const live = await publish('Vivante', siteA);
      await db
        .insertInto('sync_change_feed')
        .values([
          {
            dataset: 'comms',
            entity_type: 'NOTE',
            entity_id: toBin(live),
            change_type: 'UPSERT',
            scope_type: 'USER',
            scope_id: toBin(outsider.id),
            row_version: 1,
          },
          {
            dataset: 'comms',
            entity_type: 'NOTE',
            entity_id: toBin(live),
            change_type: 'UPSERT',
            scope_type: 'GLOBAL',
            scope_id: null,
            row_version: 1,
          },
        ])
        .execute();
      expect(last(await pull(outsider), 'NOTE', live)).toBeUndefined();
      expect(last(await pull(staffB), 'NOTE', live)).toBeUndefined();
      // Le destinataire légitime la reçoit toujours.
      expect(last(await pull(staffA), 'NOTE', live)).toMatchObject({ change_type: 'UPSERT' });
    });
  });
});
