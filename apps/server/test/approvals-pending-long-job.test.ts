/**
 * P9-09 : `approvals.requests.pending_long_check` (D13 §7.1 `APPROVAL_PENDING_LONG`, SM-APPROVAL « délai
 * de 24 h dépassé », AV-408, AV-466) — passe horaire à identité : un événement par demande en attente
 * depuis au moins 24 h (réception par le serveur), `escalated_at` posé une fois, marqueur en dernier ; une
 * demande verrouillée par une décision en cours est sautée. Les demandes sont insérées directement (la
 * date de réception est maîtrisée), horloge dans le passé lointain, transactions annulées.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as {
    currentSettingValue: (...args: unknown[]) => Promise<unknown>;
  };
  return { ...actual, currentSettingValue: vi.fn(actual.currentSettingValue) };
});

import { APPROVAL_OPERATION_LABELS, FixedClock, Uuidv7Generator } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  APPROVAL_PENDING_LONG_JOB_TYPE,
  ApprovalPendingLongJob,
} from '../src/modules/approvals/application/jobs/approval-pending-long-job.js';
import {
  APPROVALS_RECURRING_JOBS,
  ApprovalsRecurringJobs,
} from '../src/modules/approvals/application/jobs/approvals-recurring-jobs.js';
import { OPERATION_TYPES } from '../src/modules/approvals/application/commands/operation-types.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const NOW = new Date('2019-03-12T09:00:00.000Z');
const SLOT = NOW.toISOString();
const HOUR_MS = 3_600_000;
const clock = new FixedClock(NOW);
const idGenerator = new Uuidv7Generator(clock);
const passId = (slot: string) => `APPROVAL_PENDING_LONG:${slot}`;

const settingsOverride = new Map<string, unknown>();
beforeEach(() => {
  settingsOverride.clear();
  vi.mocked(currentSettingValue).mockImplementation(async (_executor, input) => {
    const key = (input as { key: string }).key;
    return settingsOverride.has(key) ? settingsOverride.get(key) : undefined;
  });
});

function runner() {
  const registry = new JobHandlerRegistry();
  new ApprovalPendingLongJob(clock, idGenerator, registry).onModuleInit();
  return registry.resolve(APPROVAL_PENDING_LONG_JOB_TYPE)!;
}

interface RequestOptions {
  readonly hoursAgo: number;
  readonly status?: string;
  readonly operationType?: string;
  readonly policy?: boolean;
  readonly escalatedAt?: Date | null;
  readonly siteId?: string | null;
  /** Date du fait (appareil) : distincte de la réception par le serveur. */
  readonly requestedHoursAgo?: number;
}

async function world(executor: UnitOfWork | typeof db) {
  const admin = await insertTestUser(executor as UnitOfWork);
  const zone = await insertTestZone(executor as UnitOfWork, admin);
  const site = await insertTestSite(executor as UnitOfWork, admin, zone);
  const requester = await insertTestUser(executor as UnitOfWork);
  const policyId = freshUuid();
  await executor
    .insertInto('approvals_control_policies')
    .values({
      id: toBin(policyId),
      code: `T9-${policyId.slice(-12)}`,
      operation_type: 'EXPENSE',
      status: 'RETIRED',
      valid_from: new Date('2019-01-01T00:00:00.000Z'),
      valid_to: new Date('2019-01-01T00:00:00.000Z'),
      requires_approval: 1,
      approver_permission: 'finance.expense.approve',
      approver_scope: 'SITE',
      created_by: toBin(admin),
    })
    .execute();

  async function request(options: RequestOptions): Promise<string> {
    const id = freshUuid();
    const createdAt = new Date(NOW.getTime() - options.hoursAgo * HOUR_MS);
    const requestedAt = new Date(
      NOW.getTime() - (options.requestedHoursAgo ?? options.hoursAgo) * HOUR_MS,
    );
    const status = options.status ?? 'PENDING';
    await executor
      .insertInto('approvals_approval_requests')
      .values({
        id: toBin(id),
        operation_type: options.operationType ?? 'EXPENSE',
        subject_type: 'EXPENSE',
        subject_id: toBin(freshUuid()),
        subject_summary: 'Achat de médicaments : 450 000 XAF',
        amount_xaf: 450_000,
        site_id:
          options.siteId === undefined
            ? toBin(site)
            : options.siteId === null
              ? null
              : toBin(options.siteId),
        requested_by: toBin(requester),
        requested_at: requestedAt,
        created_at: createdAt,
        created_by: toBin(requester),
        status,
        ...(options.policy === false ? {} : { policy_id: toBin(policyId), policy_version: 1 }),
        ...(options.escalatedAt !== undefined ? { escalated_at: options.escalatedAt } : {}),
        ...(status === 'APPROVED' || status === 'REJECTED'
          ? { decided_by: toBin(admin), decided_at: NOW }
          : {}),
      })
      .execute();
    return id;
  }
  return { admin, site, requester, policyId, request };
}

async function eventsOf(
  uow: UnitOfWork,
  eventType: string,
  keep: (payload: Record<string, unknown>) => boolean,
) {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', eventType)
    .orderBy('seq', 'desc')
    .limit(3000)
    .execute();
  return rows
    .map((row) => toDomainEvent(row))
    .filter((event) => keep(event.payload as Record<string, unknown>))
    .reverse();
}

const escalatedAt = (uow: UnitOfWork, id: string) =>
  uow
    .selectFrom('approvals_approval_requests')
    .select('escalated_at')
    .where('id', '=', toBin(id))
    .executeTakeFirstOrThrow()
    .then((row) => row.escalated_at);

describe('approvals.requests.pending_long_check (P9-09, AV-408, AV-466)', () => {
  it('inscrite à l’ordonnanceur, toutes les heures', () => {
    const registry = new RecurringJobRegistry();
    new ApprovalsRecurringJobs(registry).onModuleInit();
    expect(registry.list()).toEqual(APPROVALS_RECURRING_JOBS);
    expect(registry.get(APPROVAL_PENDING_LONG_JOB_TYPE)?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
  });

  it('chaque type d’opération du catalogue a un libellé français', () => {
    for (const type of OPERATION_TYPES) {
      expect(APPROVAL_OPERATION_LABELS[type], type).toBeTypeOf('string');
    }
    expect(Object.keys(APPROVAL_OPERATION_LABELS).sort()).toEqual([...OPERATION_TYPES].sort());
  });

  it('demandes en attente depuis au moins 24 h : un événement par demande, borne comprise ; marqueur en dernier', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const old = await w.request({ hoursAgo: 25 });
      const exactly = await w.request({ hoursAgo: 24 });
      const recent = await w.request({ hoursAgo: 23 });
      const decided = await w.request({ hoursAgo: 40, status: 'APPROVED' });
      const cancelled = await w.request({ hoursAgo: 40, status: 'CANCELLED' });
      const noPolicy = await w.request({ hoursAgo: 30, policy: false, siteId: null });
      // Saisie hors ligne : le fait date de trois jours, la réception par le serveur d'une heure.
      const offline = await w.request({ hoursAgo: 1, requestedHoursAgo: 72 });
      await runner()(uow, { scheduledFor: SLOT });

      const all = [old, exactly, recent, decided, cancelled, noPolicy, offline];
      const events = await eventsOf(uow, 'ApprovalPendingLong', (p) =>
        all.includes(String(p['request_id'])),
      );
      expect(events.map((event) => event.aggregateId).sort()).toEqual(
        [old, exactly, noPolicy].sort(),
      );
      const event = events.find((e) => e.aggregateId === old)!;
      expect(event.producerModule).toBe('approvals');
      expect(event.aggregateType).toBe('APPROVAL_REQUEST');
      expect(event.payload).toEqual({
        request_id: old,
        operation_type: 'EXPENSE',
        operation_label: 'Dépense',
        hours_pending: 25,
        threshold_hours: 24,
        approver_permission: 'finance.expense.approve',
        approver_scope: 'SITE',
        requester_user_id: w.requester,
        subject_type: 'EXPENSE',
        subject_id: (event.payload as { subject_id: string }).subject_id,
        requested_at: new Date(NOW.getTime() - 25 * HOUR_MS).toISOString(),
        escalated: false,
        business_day: '2019-03-12',
        site_id: w.site,
        pass_id: passId(SLOT),
      });
      // Jamais le résumé ni le montant (valeurs au coût possibles, RC-05).
      expect(Object.keys(event.payload as object)).not.toContain('subject_summary');
      expect(Object.keys(event.payload as object)).not.toContain('amount_xaf');
      expect(Object.values(event.payload as object)).not.toContain(450_000);
      expect(JSON.stringify(event.payload)).not.toContain('médicaments');
      // Sans politique : aucun approbateur désigné, seule la règle de la Direction s'applique.
      const orphan = events.find((e) => e.aggregateId === noPolicy)!;
      expect(orphan.payload).toMatchObject({ approver_permission: null, approver_scope: null });
      expect(Object.keys(orphan.payload as object)).not.toContain('site_id');

      const markers = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === passId(SLOT),
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'APPROVAL_PENDING_LONG',
        business_day: '2019-03-12',
      });
      expect(markers[0]!.seq).toBeGreaterThan(Math.max(...events.map((e) => e.seq)));

      // `escalated_at` : posé une fois au premier constat, pour les seules demandes en retard.
      for (const id of [old, exactly, noPolicy]) {
        expect((await escalatedAt(uow, id))?.toISOString()).toBe(NOW.toISOString());
      }
      for (const id of [recent, decided, cancelled, offline]) {
        expect(await escalatedAt(uow, id)).toBeNull();
      }
    }));

  it('l’attente se compte depuis la réception par le serveur, non depuis la date du fait', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const offline = await w.request({ hoursAgo: 30, requestedHoursAgo: 72 });
      await runner()(uow, { scheduledFor: SLOT });
      const [event] = await eventsOf(
        uow,
        'ApprovalPendingLong',
        (p) => p['request_id'] === offline,
      );
      expect(event!.payload).toMatchObject({
        hours_pending: 30,
        requested_at: new Date(NOW.getTime() - 72 * HOUR_MS).toISOString(),
      });
    }));

  it('une demande déjà escaladée est republiée sans réécrire escalated_at ; le rejeu du créneau ne republie pas', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const first = new Date('2019-03-11T20:00:00.000Z');
      const old = await w.request({ hoursAgo: 30, escalatedAt: first });
      await runner()(uow, { scheduledFor: SLOT });
      const [event] = await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === old);
      expect(event!.payload).toMatchObject({ escalated: true, hours_pending: 30 });
      expect((await escalatedAt(uow, old))?.toISOString()).toBe(first.toISOString());

      await runner()(uow, { scheduledFor: SLOT });
      expect(
        await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === old),
      ).toHaveLength(1);
      await runner()(uow, { scheduledFor: '2019-03-12T10:00:00.000Z' });
      expect(
        await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === old),
      ).toHaveLength(2);
    }));

  it('le délai est un paramètre (6 h ; valeur invalide : 24 h)', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const eightHours = await w.request({ hoursAgo: 8 });
      await runner()(uow, { scheduledFor: SLOT });
      expect(
        await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === eightHours),
      ).toEqual([]);

      settingsOverride.set('approvals.pending_long_hours', 6);
      await runner()(uow, { scheduledFor: '2019-03-12T09:10:00.000Z' });
      const [event] = await eventsOf(
        uow,
        'ApprovalPendingLong',
        (p) => p['request_id'] === eightHours,
      );
      expect(event!.payload).toMatchObject({ threshold_hours: 6, hours_pending: 8 });

      settingsOverride.set('approvals.pending_long_hours', -2);
      await runner()(uow, { scheduledFor: '2019-03-12T09:20:00.000Z' });
      expect(
        await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === eightHours),
      ).toHaveLength(1);
    }));

  it('bout en bout : alerte levée aux approbateurs, fermée par le marqueur quand la demande est décidée', () =>
    rolledBack(async (uow) => {
      const w = await world(uow);
      const pending = await w.request({ hoursAgo: 26 });
      await runner()(uow, { scheduledFor: SLOT });
      const [event] = await eventsOf(
        uow,
        'ApprovalPendingLong',
        (p) => p['request_id'] === pending,
      );
      await handleAlertEvent(uow, event!, { idGenerator });
      const alert = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['status', 'severity', 'title', 'message', 'site_id'])
          .where('dedup_key', '=', `APPROVAL_PENDING_LONG:${pending}`)
          .executeTakeFirstOrThrow();
      const raised = await alert();
      expect(raised).toMatchObject({
        status: 'OPEN',
        severity: 'WARNING',
        title: 'Validation en attente depuis trop longtemps',
      });
      expect(raised.message).toContain('Dépense');
      expect(raised.message).toContain('26 h');
      expect(fromBin(raised.site_id as Buffer)).toBe(w.site);

      // La demande est décidée (par une façade d'un module propriétaire : aucun événement ne la désigne).
      await uow
        .updateTable('approvals_approval_requests')
        .set({ status: 'APPROVED', decided_by: toBin(w.admin), decided_at: NOW })
        .where('id', '=', toBin(pending))
        .execute();
      const next = '2019-03-12T10:00:00.000Z';
      await runner()(uow, { scheduledFor: next });
      const [marker] = await eventsOf(
        uow,
        'AlertDetectionPassCompleted',
        (payload) => payload['pass_id'] === passId(next),
      );
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alert()).status).toBe('RESOLVED');
    }));

  it('une demande verrouillée par une décision en cours est sautée, puis signalée à la passe suivante', async () => {
    // Demande validée (visible d'une autre connexion) ; annulée en fin de test pour ne rien laisser en attente.
    const w = await world(db);
    const id = await w.request({ hoursAgo: 30, policy: false });
    try {
      let skipped = -1;
      let markers = -1;
      await db.transaction().execute(async (lockTx) => {
        await lockTx
          .selectFrom('approvals_approval_requests')
          .select('id')
          .where('id', '=', toBin(id))
          .forUpdate()
          .execute();
        await rolledBack(async (uow) => {
          await runner()(uow, { scheduledFor: SLOT });
          skipped = (await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === id))
            .length;
          // Une passe partielle ne résout rien : aucun marqueur n'est publié tant qu'une demande est sautée.
          markers = (
            await eventsOf(
              uow,
              'AlertDetectionPassCompleted',
              (payload) => payload['pass_id'] === passId(SLOT),
            )
          ).length;
        });
      });
      expect(skipped).toBe(0);
      expect(markers).toBe(0);
      expect(
        await db
          .selectFrom('approvals_approval_requests')
          .select('escalated_at')
          .where('id', '=', toBin(id))
          .executeTakeFirstOrThrow()
          .then((row) => row.escalated_at),
      ).toBeNull();

      await rolledBack(async (uow) => {
        await runner()(uow, { scheduledFor: '2019-03-12T09:30:00.000Z' });
        expect(
          await eventsOf(uow, 'ApprovalPendingLong', (p) => p['request_id'] === id),
        ).toHaveLength(1);
        // Libre du verrou : la passe est complète, son marqueur est publié.
        expect(
          await eventsOf(
            uow,
            'AlertDetectionPassCompleted',
            (payload) => payload['pass_id'] === passId('2019-03-12T09:30:00.000Z'),
          ),
        ).toHaveLength(1);
      });
    } finally {
      await db
        .updateTable('approvals_approval_requests')
        .set({ status: 'CANCELLED' })
        .where('id', '=', toBin(id))
        .execute();
    }
  });
});
