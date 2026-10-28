/**
 * P9-25 (PF-1 ; ADR-068 §8 ; AV-470, AV-471) : purges de la communication — notifications lues, lignes d'envoi
 * Web Push et notifications d'une alerte purgée (jamais celles d'une note encore publiée), abonnements push
 * révoqués, alertes closes sous le rôle de maintenance (plancher de 730 jours du déclencheur), tâche quotidienne
 * `communication.maintenance.purge_daily` et commande `db:purge-alerts`.
 *
 * Base partagée et persistante : l'horloge d'essai est très ancienne (`NOW` en 2001), aucune ligne réelle n'est
 * aussi vieille et les réglages semés (valables depuis 2026) ne sont pas en vigueur à cette date, donc les défauts
 * s'appliquent ; chaque essai tourne dans une transaction annulée et ne décale jamais l'horloge de la base. Les
 * assertions portent sur des identifiants (jamais un compte absolu : d'autres fichiers laissent des lignes
 * validées).
 *
 * Les alertes closes se suppriment sous une connexion qui a `DELETE` sur `communication_alerts` : `DATABASE_URL`
 * (administrateur, CI), à défaut `SERVER_DATABASE_URL` (poste local où `gic_app` a tous les droits). Jamais
 * `MAINTENANCE_DATABASE_URL` : le vrai rôle de maintenance ne peut insérer ni alertes ni utilisateurs. Une
 * connexion sans `DELETE` (erreur 1142) saute les essais concernés, visiblement ; le moindre privilège se
 * vérifie à la main (voir la clôture de P9-25).
 */
import { afterAll, afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { FixedClock } from '@gic/domain';
import {
  COMMUNICATION_PURGE_JOB_TYPE,
  CommunicationPurgeJob,
} from '../src/modules/communication/application/jobs/communication-purge-job.js';
import { CommunicationRecurringJobs } from '../src/modules/communication/application/jobs/communication-recurring-jobs.js';
import {
  countPurgeableAlerts,
  purgeClosedAlerts,
  runAlertPurgeCli,
} from '../src/modules/communication/application/maintenance/purge-alerts.js';
import {
  purgeReadNotifications,
  purgeRevokedPushSubscriptions,
  runCommunicationPurge,
} from '../src/modules/communication/application/maintenance/purge.js';
import { usersWithActiveSubscription } from '../src/modules/communication/application/notifications/notification-store.js';
import {
  noteHolderIds,
  recordNoteChanges,
} from '../src/modules/communication/application/sync-changes.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { createDatabase } from '../src/platform/kysely/database.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestUser,
  withTestUow,
} from './helpers.js';

const DAY = 86_400_000;
const NOW = new Date('2001-06-01T12:00:00.000Z');
const clock = new FixedClock(NOW);
/** Coupure des 90 jours à `NOW` : lue strictement avant = purgée, exactement à = conservée. */
const CUT = new Date('2001-03-03T12:00:00.000Z');
const ago = (days: number, extraMs = 0): Date => new Date(NOW.getTime() - days * DAY - extraMs);

// --- Connexion des essais d'alertes (aucun repli sur MAINTENANCE_DATABASE_URL, voir l'en-tête) ---
const alertUrl = process.env.DATABASE_URL || process.env.SERVER_DATABASE_URL;
if (!alertUrl) {
  throw new Error(
    'DATABASE_URL ou SERVER_DATABASE_URL requis pour les essais de purge des alertes.',
  );
}
const alertConnection = createDatabase(alertUrl);

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    alertConnection.pool.end((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

const ROLLBACK = Symbol('ROLLBACK');

/** Transaction toujours annulée sur la connexion des alertes ; privilège `DELETE` manquant : essai sauté. */
async function alertTx(ctx: TestContext, fn: (trx: UnitOfWork) => Promise<void>): Promise<void> {
  const box: { failed: boolean; error?: unknown } = { failed: false };
  try {
    await alertConnection.db.transaction().execute(async (trx) => {
      try {
        await fn(trx);
      } catch (error) {
        box.failed = true;
        box.error = error;
      }
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  if (box.failed) {
    if ((box.error as { errno?: number } | null)?.errno === 1142) {
      ctx.skip(
        'La connexion des essais n’a pas DELETE sur communication_alerts (erreur 1142) : essai sauté.',
      );
    }
    throw box.error;
  }
}

// --- Fixtures ---
async function notification(
  uow: UnitOfWork,
  userId: string,
  input: {
    readonly createdAt: Date;
    readonly readAt?: Date;
    readonly channel?: 'IN_APP' | 'WEB_PUSH';
    readonly kind?: 'ALERT' | 'NOTE' | 'DIRECT';
    readonly noteId?: string;
    readonly alertId?: string;
  },
): Promise<string> {
  const id = freshUuid();
  const kind = input.kind ?? 'DIRECT';
  await uow
    .insertInto('communication_notifications')
    .values({
      id: toBin(id),
      user_id: toBin(userId),
      channel: input.channel ?? 'IN_APP',
      kind,
      // CHECK ck_communication_notifications_alert : une notification `ALERT` porte son type d'alerte.
      alert_type: kind === 'ALERT' ? 'OVERDUE_RECEIVABLE' : null,
      alert_id: input.alertId !== undefined ? toBin(input.alertId) : null,
      note_id: input.noteId !== undefined ? toBin(input.noteId) : null,
      title: 'Essai de purge',
      body: 'Corps',
      created_at: input.createdAt,
      delivered_at: input.createdAt,
      read_at: input.readAt ?? null,
    })
    .execute();
  return id;
}

const notificationExists = async (uow: UnitOfWork, id: string): Promise<boolean> =>
  (await uow
    .selectFrom('communication_notifications')
    .select('id')
    .where('id', '=', toBin(id))
    .executeTakeFirst()) !== undefined;

async function setSetting(
  uow: UnitOfWork,
  key: string,
  value: unknown,
  validFrom: Date,
): Promise<void> {
  await uow
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: JSON.stringify(value),
      scope_type: 'GLOBAL',
      valid_from: validFrom,
      created_by: toBin(await insertTestUser(uow)),
    })
    .execute();
}

async function insertNote(uow: UnitOfWork, createdBy: string): Promise<string> {
  const id = freshUuid();
  await uow
    .insertInto('communication_internal_notes')
    .values({
      id: toBin(id),
      title: 'Note d’essai',
      body: 'Consigne.',
      category: 'INFORMATION',
      status: 'PUBLISHED',
      published_at: ago(300),
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

async function archiveNote(uow: UnitOfWork, id: string): Promise<void> {
  await uow
    .updateTable('communication_internal_notes')
    .set({ status: 'ARCHIVED', archived_at: NOW })
    .where('id', '=', toBin(id))
    .execute();
}

type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

/** Alerte insérée directement dans l'état voulu (les contraintes de cohérence de la table s'appliquent). */
async function insertAlert(
  uow: UnitOfWork,
  adminId: string,
  input: { readonly status: AlertStatus; readonly closedAt?: Date },
): Promise<string> {
  const id = freshUuid();
  const closed = input.status === 'RESOLVED' || input.status === 'DISMISSED';
  await uow
    .insertInto('communication_alert_rules')
    .values({
      alert_type: 'OVERDUE_RECEIVABLE',
      severity: 'WARNING',
      recipient_roles: jsonValue(['FINANCE']),
      resolution_mode: 'AUTO',
    })
    .ignore()
    .execute();
  await uow
    .insertInto('communication_alerts')
    .values({
      id: toBin(id),
      alert_type: 'OVERDUE_RECEIVABLE',
      nature: 'STATE',
      severity: 'WARNING',
      status: input.status,
      subject_type: 'SALE',
      subject_id: toBin(freshUuid()),
      title: 'Créance échue',
      payload: jsonValue({ doc_number: 'VTE-1' }),
      dedup_key: `purge-test:${id}`,
      first_detected_at: new Date('1999-01-01T00:00:00.000Z'),
      last_detected_at: new Date('1999-01-01T00:00:00.000Z'),
      acknowledged_at:
        input.status === 'ACKNOWLEDGED' ? new Date('1999-01-02T00:00:00.000Z') : null,
      acknowledged_by: input.status === 'ACKNOWLEDGED' ? toBin(adminId) : null,
      resolved_at: closed ? (input.closedAt ?? null) : null,
      resolution_kind:
        input.status === 'RESOLVED' ? 'PASS' : input.status === 'DISMISSED' ? 'DISMISSED' : null,
      resolved_by: input.status === 'DISMISSED' ? toBin(adminId) : null,
      resolution_comment: input.status === 'DISMISSED' ? 'Écartée (essai de purge)' : null,
    })
    .execute();
  return id;
}

const alertExists = async (uow: UnitOfWork, id: string): Promise<boolean> =>
  (await uow
    .selectFrom('communication_alerts')
    .select('id')
    .where('id', '=', toBin(id))
    .executeTakeFirst()) !== undefined;

/** Fait lever les lectures ou suppressions de ces tables (isolation d'une étape, interblocage simulé). */
function failOn(
  uow: UnitOfWork,
  methods: readonly ('selectFrom' | 'deleteFrom')[],
  tables: readonly string[],
  error: Error,
): void {
  for (const method of methods) {
    const original = (uow[method] as unknown as (table: unknown) => unknown).bind(uow);
    vi.spyOn(uow, method).mockImplementation(((table: unknown) => {
      const name = typeof table === 'string' ? table : '';
      if (tables.some((target) => name === target || name.startsWith(`${target} `))) throw error;
      return original(table);
    }) as never);
  }
}

describe('PF-1 : notifications (AV-471)', () => {
  it('lues : strictement avant la coupure, la limite exacte est conservée', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const before = await notification(uow, user, {
        createdAt: ago(200),
        readAt: new Date(CUT.getTime() - 1),
      });
      const exact = await notification(uow, user, { createdAt: ago(200), readAt: CUT });
      const after = await notification(uow, user, {
        createdAt: ago(200),
        readAt: new Date(CUT.getTime() + 1),
      });
      const unread = await notification(uow, user, {
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
      });

      const result = await purgeReadNotifications(uow, { before: CUT });
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(result.truncated).toBe(false);
      expect(await notificationExists(uow, before)).toBe(false);
      expect(await notificationExists(uow, exact)).toBe(true);
      expect(await notificationExists(uow, after)).toBe(true);
      expect(await notificationExists(uow, unread)).toBe(true); // jamais lue : hors du périmètre (AV-471)
    }));

  it('la durée est lue au réglage à la date de l’horloge ; sans réglage, 90 jours', async () => {
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      await setSetting(
        uow,
        'communication.notification_retention_days',
        30,
        new Date(NOW.getTime() - 1000),
      );
      const old = await notification(uow, user, { createdAt: ago(100), readAt: ago(30, 1) });
      const edge = await notification(uow, user, { createdAt: ago(100), readAt: ago(30) });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await notificationExists(uow, old)).toBe(false);
      expect(await notificationExists(uow, edge)).toBe(true);
    });
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const old = await notification(uow, user, { createdAt: ago(200), readAt: ago(91) });
      const recent = await notification(uow, user, { createdAt: ago(200), readAt: ago(89) });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await notificationExists(uow, old)).toBe(false);
      expect(await notificationExists(uow, recent)).toBe(true);
    });
  });

  it('la notification d’une note encore publiée est conservée ; archivée, elle part ; une ALERT orpheline part', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const noteId = await insertNote(uow, user);
      const ofNote = await notification(uow, user, {
        createdAt: ago(300),
        readAt: ago(200),
        kind: 'NOTE',
        noteId,
      });
      const orphan = await notification(uow, user, {
        createdAt: ago(300),
        readAt: ago(200),
        kind: 'ALERT',
      });

      const first = await runCommunicationPurge(uow, { clock });
      expect(first.failedSteps).toEqual([]);
      expect(await notificationExists(uow, ofNote)).toBe(true);
      expect(await notificationExists(uow, orphan)).toBe(false);

      // Défaut aggravant évité : le détenteur de la note est encore connu, donc l'archivage atteint son appareil.
      expect(await noteHolderIds(uow, noteId)).toContain(user);
      await recordNoteChanges(uow, noteId, await noteHolderIds(uow, noteId), 'SCOPE_EXIT');
      const exit = await uow
        .selectFrom('sync_change_feed')
        .select('seq')
        .where('entity_id', '=', toBin(noteId))
        .where('change_type', '=', 'SCOPE_EXIT')
        .where('scope_id', '=', toBin(user))
        .execute();
      expect(exit.length).toBeGreaterThanOrEqual(1);

      await archiveNote(uow, noteId);
      const second = await runCommunicationPurge(uow, { clock });
      expect(second.failedSteps).toEqual([]);
      expect(await notificationExists(uow, ofNote)).toBe(false);
    }));

  it('une notification d’alerte purgée est supprimée, lue ou non ; celle d’une alerte existante non lue reste', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const live = await insertAlert(uow, user, { status: 'OPEN' });
      const unreadOrphan = await notification(uow, user, { createdAt: ago(10), kind: 'ALERT' });
      const unreadLive = await notification(uow, user, {
        createdAt: ago(10),
        kind: 'ALERT',
        alertId: live,
      });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await notificationExists(uow, unreadOrphan)).toBe(false);
      expect(await notificationExists(uow, unreadLive)).toBe(true);
    }));

  it('lignes d’envoi WEB_PUSH : supprimées au-delà de la durée, lues ou non ; IN_APP jamais lue conservée', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const old = await notification(uow, user, {
        createdAt: new Date(CUT.getTime() - 1),
        channel: 'WEB_PUSH',
      });
      const edge = await notification(uow, user, { createdAt: CUT, channel: 'WEB_PUSH' });
      const inApp = await notification(uow, user, { createdAt: new Date(CUT.getTime() - DAY) });
      await purgeReadNotifications(uow, { before: CUT });
      expect(await notificationExists(uow, old)).toBe(false);
      expect(await notificationExists(uow, edge)).toBe(true);
      expect(await notificationExists(uow, inApp)).toBe(true);
    }));

  it('lots plafonnés : la reprise suit, puis rien à supprimer', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push(await notification(uow, user, { createdAt: ago(200), readAt: ago(150) }));
      }
      const capped = await purgeReadNotifications(uow, { before: CUT, batch: 2, maxBatches: 2 });
      expect(capped).toEqual({ deleted: 4, truncated: true });
      const rest = await purgeReadNotifications(uow, { before: CUT });
      expect(rest.truncated).toBe(false);
      for (const id of ids) expect(await notificationExists(uow, id)).toBe(false);
      expect((await purgeReadNotifications(uow, { before: CUT })).deleted).toBe(0);
    }));
});

describe('PF-1 : abonnements push révoqués', () => {
  it('révoqué : supprimé ; actif : conservé et toujours ciblé', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const device = await insertTestDevice(uow, user, { status: 'ACTIVE' });
      const subscription = async (revokedAt: Date | null): Promise<string> => {
        const id = freshUuid();
        await uow
          .insertInto('communication_push_subscriptions')
          .values({
            id: toBin(id),
            user_id: toBin(user),
            device_id: toBin(device),
            endpoint: `https://push.example.test/${id}`,
            p256dh: 'BPublicKeyForTests',
            auth: 'secretAuth',
            revoked_at: revokedAt,
          })
          .execute();
        return id;
      };
      const revoked = await subscription(ago(1));
      const active = await subscription(null);

      const first = await purgeRevokedPushSubscriptions(uow);
      expect(first.deleted).toBeGreaterThanOrEqual(1);
      const remaining = await uow
        .selectFrom('communication_push_subscriptions')
        .select('id')
        .where('id', 'in', [toBin(revoked), toBin(active)])
        .execute();
      expect(remaining.map((row) => row.id.toString('hex'))).toEqual([
        toBin(active).toString('hex'),
      ]);
      expect((await usersWithActiveSubscription(uow, [user])).has(user)).toBe(true);
      expect((await purgeRevokedPushSubscriptions(uow)).deleted).toBe(0);
    }));
});

describe('PF-1 : alertes closes (AV-470)', () => {
  const CLOCK_2002 = new FixedClock(new Date('2002-01-01T00:00:00.000Z'));
  /** 2002-01-01 moins 730 jours. */
  const ALERT_CUT = new Date('2000-01-02T00:00:00.000Z');

  it('closes avant la coupure : supprimées avec leurs destinataires ; les liens de notification passent à NULL', (ctx) =>
    alertTx(ctx, async (trx) => {
      const admin = await insertTestUser(trx);
      const recipient = await insertTestUser(trx);
      const justBefore = await insertAlert(trx, admin, {
        status: 'RESOLVED',
        closedAt: new Date(ALERT_CUT.getTime() - 1),
      });
      const atCut = await insertAlert(trx, admin, { status: 'RESOLVED', closedAt: ALERT_CUT });
      const justAfter = await insertAlert(trx, admin, {
        status: 'RESOLVED',
        closedAt: new Date(ALERT_CUT.getTime() + 1),
      });
      const dismissed = await insertAlert(trx, admin, {
        status: 'DISMISSED',
        closedAt: new Date(ALERT_CUT.getTime() - DAY),
      });
      const open = await insertAlert(trx, admin, { status: 'OPEN' });
      const acknowledged = await insertAlert(trx, admin, { status: 'ACKNOWLEDGED' });
      for (const alertId of [justBefore, atCut]) {
        await trx
          .insertInto('communication_alert_recipients')
          .values({ alert_id: toBin(alertId), user_id: toBin(recipient), origin: 'RULE' })
          .execute();
      }
      const ofDeleted = await notification(trx, recipient, {
        createdAt: ago(1),
        kind: 'ALERT',
        alertId: justBefore,
      });
      const ofKept = await notification(trx, recipient, {
        createdAt: ago(1),
        kind: 'ALERT',
        alertId: atCut,
      });

      const pending = await countPurgeableAlerts(trx, { clock: CLOCK_2002 });
      expect(pending).toBeGreaterThanOrEqual(2);
      const outcome = await purgeClosedAlerts(trx, { clock: CLOCK_2002 });
      expect(outcome.deleted).toBe(pending);
      expect(outcome.truncated).toBe(false);
      expect(outcome.retentionDays).toBe(730);
      expect(outcome.floorApplied).toBe(false);
      expect(outcome.before.toISOString()).toBe(ALERT_CUT.toISOString());

      expect(await alertExists(trx, justBefore)).toBe(false);
      expect(await alertExists(trx, dismissed)).toBe(false);
      for (const kept of [atCut, justAfter, open, acknowledged]) {
        expect(await alertExists(trx, kept)).toBe(true);
      }
      const recipientsOf = async (alertId: string): Promise<number> =>
        (
          await trx
            .selectFrom('communication_alert_recipients')
            .select('user_id')
            .where('alert_id', '=', toBin(alertId))
            .execute()
        ).length;
      expect(await recipientsOf(justBefore)).toBe(0);
      expect(await recipientsOf(atCut)).toBe(1);
      const linkOf = async (id: string) =>
        (
          await trx
            .selectFrom('communication_notifications')
            .select('alert_id')
            .where('id', '=', toBin(id))
            .executeTakeFirstOrThrow()
        ).alert_id;
      expect(await linkOf(ofDeleted)).toBeNull();
      expect(await linkOf(ofKept)).not.toBeNull();
      expect(await countPurgeableAlerts(trx, { clock: CLOCK_2002 })).toBe(0);
    }));

  it('plancher du réglage : 365 jours ne raccourcit rien ; 1 000 jours allonge', (ctx) =>
    alertTx(ctx, async (trx) => {
      const admin = await insertTestUser(trx);
      await setSetting(
        trx,
        'communication.alert_retention_days',
        365,
        new Date(CLOCK_2002.now().getTime() - 1000),
      );
      const sinceFourHundred = await insertAlert(trx, admin, {
        status: 'RESOLVED',
        closedAt: new Date(CLOCK_2002.now().getTime() - 400 * DAY),
      });
      const floored = await purgeClosedAlerts(trx, { clock: CLOCK_2002 });
      expect(floored.retentionDays).toBe(730);
      expect(floored.floorApplied).toBe(true);
      expect(await alertExists(trx, sinceFourHundred)).toBe(true); // aucune erreur du déclencheur

      await setSetting(
        trx,
        'communication.alert_retention_days',
        1000,
        new Date(CLOCK_2002.now().getTime() - 500),
      );
      const eight = await insertAlert(trx, admin, {
        status: 'RESOLVED',
        closedAt: new Date(CLOCK_2002.now().getTime() - 800 * DAY),
      });
      const thousandOne = await insertAlert(trx, admin, {
        status: 'RESOLVED',
        closedAt: new Date(CLOCK_2002.now().getTime() - 1001 * DAY),
      });
      const longer = await purgeClosedAlerts(trx, { clock: CLOCK_2002 });
      expect(longer.retentionDays).toBe(1000);
      expect(await alertExists(trx, eight)).toBe(true);
      expect(await alertExists(trx, thousandOne)).toBe(false);
    }));

  it('horloge applicative en avance sur celle de la base : le plancher de la base protège, sans erreur', (ctx) =>
    alertTx(ctx, async (trx) => {
      const admin = await insertTestUser(trx);
      const resolvedAt = new Date(Date.now() - 700 * DAY);
      const young = await insertAlert(trx, admin, { status: 'RESOLVED', closedAt: resolvedAt });
      const ahead = new FixedClock(new Date(Date.now() + 5 * 365 * DAY));
      const outcome = await purgeClosedAlerts(trx, { clock: ahead });
      // Sous la coupure applicative, mais en deçà du plancher de la base (730 jours) : conservée.
      expect(outcome.before.getTime()).toBeGreaterThan(resolvedAt.getTime());
      expect(await alertExists(trx, young)).toBe(true);
    }));

  it('la tâche quotidienne compte les alertes en attente sans rien supprimer', () =>
    withTestUow(async (uow) => {
      const admin = await insertTestUser(uow);
      const due = await insertAlert(uow, admin, {
        status: 'RESOLVED',
        closedAt: new Date('1999-01-01T00:00:00.000Z'),
      });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(outcome.alertsAwaitingPurge).toBeGreaterThanOrEqual(1);
      expect(await alertExists(uow, due)).toBe(true);
    }));
});

describe('PF-1 : tâche quotidienne', () => {
  it('le gestionnaire est enregistré, s’exécute sans lever, et la récurrence est quotidienne à 03:30', async () => {
    const handlers = new JobHandlerRegistry();
    new CommunicationPurgeJob(clock, handlers).onModuleInit();
    const handler = handlers.resolve(COMMUNICATION_PURGE_JOB_TYPE);
    expect(handler).toBeDefined();
    await withTestUow(async (uow) => {
      await handler!(uow, {});
    });

    const recurring = new RecurringJobRegistry();
    new CommunicationRecurringJobs(recurring).onModuleInit();
    expect(recurring.get(COMMUNICATION_PURGE_JOB_TYPE)).toEqual({
      jobType: 'communication.maintenance.purge_daily',
      schedule: { kind: 'DAILY', localTime: '03:30' },
    });
  });

  it('une étape en échec est isolée : les autres aboutissent et rien ne lève', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const eligible = await notification(uow, user, { createdAt: ago(200), readAt: ago(150) });
      failOn(uow, ['selectFrom', 'deleteFrom'], ['platform_jobs'], new Error('panne simulée'));
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual(['jobs']);
      expect(await notificationExists(uow, eligible)).toBe(false);
    }));

  it('un interblocage (1213) n’est pas isolé : il remonte pour annuler la transaction', () =>
    withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      await notification(uow, user, { createdAt: ago(200), readAt: ago(150) });
      failOn(
        uow,
        ['deleteFrom'],
        ['communication_notifications'],
        Object.assign(new Error('Deadlock found'), { errno: 1213 }),
      );
      await expect(runCommunicationPurge(uow, { clock })).rejects.toMatchObject({ errno: 1213 });
    }));
});

describe('PF-1 : commande db:purge-alerts', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    };
  };

  it('un argument inconnu : usage, code 2', async () => {
    const { err, io } = capture();
    expect(await runAlertPurgeCli(['--tout'], { MAINTENANCE_DATABASE_URL: 'mysql://x' }, io)).toBe(
      2,
    );
    expect(err.join('\n')).toContain('Usage');
  });

  it('variable absente : code 2, sans repli sur SERVER_DATABASE_URL', async () => {
    const { err, io } = capture();
    const code = await runAlertPurgeCli(
      ['--', '--dry-run'],
      { SERVER_DATABASE_URL: 'mysql://x' },
      io,
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('MAINTENANCE_DATABASE_URL');
  });

  it('--dry-run : compte sans supprimer et ferme la connexion', async () => {
    const { out, io } = capture();
    let closed = 0;
    const code = await runAlertPurgeCli(
      ['--', '--dry-run'],
      { MAINTENANCE_DATABASE_URL: 'mysql://sans-effet' },
      io,
      {
        clock: new FixedClock(new Date('2002-01-01T00:00:00.000Z')),
        open: () => ({
          db,
          close: async () => {
            closed += 1;
          },
        }),
      },
    );
    expect(code).toBe(0);
    expect(closed).toBe(1);
    expect(out.join('\n')).toContain('essai à blanc');
  });
});
