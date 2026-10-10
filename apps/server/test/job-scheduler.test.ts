/**
 * Ordonnanceur des tâches récurrentes (P5-16 ; platform.job_schedules ; 05-stack.md K5, ADR-011,
 * ADR-023) contre la vraie base (compte applicatif `gic_app` : création, verrou et avancement des
 * lignes prouvés ici) : créneaux alignés, au plus un dépôt par créneau même avec deux ordonnanceurs
 * concurrents (`FOR UPDATE SKIP LOCKED`), pas d'empilement tant que la précédente attend, une seule
 * occurrence après un arrêt prolongé, forme modifiée sans perdre le créneau, récurrence quotidienne à
 * l'heure de Douala, ligne d'un type non inscrit ignorée, récurrences d'`inventory` déclarées.
 *
 * Horloge figée **postérieure** à celle de job-runner.test.ts (2026-09-24 12:00 UTC), qui réclame les
 * tâches sans filtre : les tâches déposées ici ne lui sont jamais dues ; elles sont purgées en fin de
 * fichier (`platform_jobs` est PURGE_TECHNIQUE).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { JobScheduler } from '../src/platform/jobs/job-scheduler.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import {
  RecurringJobRegistry,
  type RecurringJob,
} from '../src/platform/jobs/recurring-job-registry.js';
import {
  InventoryRecurringJobs,
  INVENTORY_RECURRING_JOBS,
} from '../src/modules/inventory/application/jobs/inventory-recurring-jobs.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';

const T0 = new Date('2026-10-09T10:17:00.000Z');
const createdTypes: string[] = [];

function testType(label: string): string {
  const type = `test.recurring.${label}.${freshUuid().slice(-12)}`;
  createdTypes.push(type);
  return type;
}

function schedulerFor(jobs: readonly RecurringJob[], clock: FixedClock): JobScheduler {
  const registry = new RecurringJobRegistry();
  for (const job of jobs) registry.register(job);
  return new JobScheduler(db, clock, new JobsService(clock, new Uuidv7Generator(clock)), registry);
}

async function scheduleRow(jobType: string) {
  return db
    .selectFrom('platform_job_schedules')
    .selectAll()
    .where('job_type', '=', jobType)
    .executeTakeFirst();
}

async function jobsOf(jobType: string) {
  return db
    .selectFrom('platform_jobs')
    .select(['id', 'status', 'run_at', 'payload'])
    .where('job_type', '=', jobType)
    .execute();
}

describe('ordonnanceur des tâches récurrentes (P5-16)', () => {
  afterAll(async () => {
    if (createdTypes.length > 0) {
      await db.deleteFrom('platform_jobs').where('job_type', 'in', createdTypes).execute();
    }
    await closeTestDb();
  });

  it('première passe : ligne créée, une tâche déposée, créneau suivant aligné ; même créneau : rien de plus', async () => {
    const clock = new FixedClock(T0);
    const type = testType('hourly');
    const scheduler = schedulerFor(
      [{ jobType: type, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } }],
      clock,
    );

    const first = await scheduler.enqueueDue({ jobTypes: [type] });
    expect(first).toHaveLength(1);
    const [job] = await jobsOf(type);
    expect(job).toMatchObject({ status: 'PENDING' });
    expect((job!.payload as Record<string, unknown>)['scheduledFor']).toBe(T0.toISOString());
    const row = await scheduleRow(type);
    expect(row).toMatchObject({
      schedule_kind: 'INTERVAL',
      interval_seconds: 3600,
      local_time: null,
    });
    expect(row!.next_run_at.toISOString()).toBe('2026-10-09T11:00:00.000Z');
    expect(await scheduler.lastJobId(type)).toBe(first[0]);

    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect(await jobsOf(type)).toHaveLength(1);
  });

  it('deux ordonnanceurs concurrents sur un créneau dû : une seule tâche (SKIP LOCKED)', async () => {
    const clock = new FixedClock(T0);
    const type = testType('concurrent');
    const jobs = [{ jobType: type, schedule: { kind: 'INTERVAL', intervalSeconds: 900 } } as const];
    const a = schedulerFor(jobs, clock);
    const b = schedulerFor(jobs, clock);
    const [fromA, fromB] = await Promise.all([
      a.enqueueDue({ jobTypes: [type] }),
      b.enqueueDue({ jobTypes: [type] }),
    ]);
    expect(fromA.length + fromB.length).toBe(1);
    expect(await jobsOf(type)).toHaveLength(1);
  });

  it('tâche précédente encore en attente : aucun empilement, créneau avancé quand même ; après un arrêt prolongé, une seule occurrence', async () => {
    const clock = new FixedClock(T0);
    const type = testType('stacking');
    const scheduler = schedulerFor(
      [{ jobType: type, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } }],
      clock,
    );
    const [firstId] = await scheduler.enqueueDue({ jobTypes: [type] });

    clock.setTo(new Date('2026-10-09T11:05:00.000Z'));
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect((await scheduleRow(type))!.next_run_at.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(await jobsOf(type)).toHaveLength(1);

    // La première se termine ; le worker reste arrêté sept heures : une seule occurrence de rattrapage.
    await db
      .updateTable('platform_jobs')
      .set({ status: 'DONE' })
      .where('id', '=', toBin(firstId!))
      .execute();
    clock.setTo(new Date('2026-10-09T18:30:00.000Z'));
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toHaveLength(1);
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect((await scheduleRow(type))!.next_run_at.toISOString()).toBe('2026-10-09T19:00:00.000Z');
    expect(await jobsOf(type)).toHaveLength(2);
  });

  it('forme changée dans le code : ligne mise à jour sans réinitialiser le créneau', async () => {
    const clock = new FixedClock(T0);
    const type = testType('changed');
    await schedulerFor(
      [{ jobType: type, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } }],
      clock,
    ).enqueueDue({
      jobTypes: [type],
    });
    const before = (await scheduleRow(type))!.next_run_at.toISOString();
    await schedulerFor(
      [{ jobType: type, schedule: { kind: 'INTERVAL', intervalSeconds: 600 } }],
      clock,
    ).enqueueDue({
      jobTypes: [type],
    });
    const row = await scheduleRow(type);
    expect(row!.interval_seconds).toBe(600);
    expect(row!.next_run_at.toISOString()).toBe(before);
  });

  it('récurrence quotidienne à l’heure de Douala (02:00 = 01:00 UTC)', async () => {
    const clock = new FixedClock(T0);
    const type = testType('daily');
    const scheduler = schedulerFor(
      [{ jobType: type, schedule: { kind: 'DAILY', localTime: '02:00' } }],
      clock,
    );
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toHaveLength(1);
    const row = await scheduleRow(type);
    expect(row).toMatchObject({
      schedule_kind: 'DAILY',
      interval_seconds: null,
      local_time: '02:00',
    });
    expect(row!.next_run_at.toISOString()).toBe('2026-10-10T01:00:00.000Z');
  });

  it('ligne d’un type non inscrit dans le processus : ignorée', async () => {
    const clock = new FixedClock(T0);
    const orphan = testType('orphan');
    await db
      .insertInto('platform_job_schedules')
      .values({
        job_type: orphan,
        schedule_kind: 'INTERVAL',
        interval_seconds: 60,
        next_run_at: new Date('2026-10-01T00:00:00.000Z'),
      })
      .execute();
    const other = testType('registered');
    const scheduler = schedulerFor(
      [{ jobType: other, schedule: { kind: 'INTERVAL', intervalSeconds: 60 } }],
      clock,
    );
    await scheduler.enqueueDue();
    expect(await jobsOf(orphan)).toHaveLength(0);
    expect((await scheduleRow(orphan))!.next_run_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('registre : doublon et forme invalide refusés ; récurrences d’inventory inscrites (balayage horaire, quotidiennes à Douala)', () => {
    const registry = new RecurringJobRegistry();
    registry.register({
      jobType: 'test.recurring.once',
      schedule: { kind: 'INTERVAL', intervalSeconds: 60 },
    });
    expect(() =>
      registry.register({
        jobType: 'test.recurring.once',
        schedule: { kind: 'INTERVAL', intervalSeconds: 60 },
      }),
    ).toThrow(/déjà inscrite/);
    expect(() =>
      registry.register({
        jobType: 'test.recurring.bad',
        schedule: { kind: 'DAILY', localTime: '25:00' },
      }),
    ).toThrow(/HH:MM/);

    const inventory = new RecurringJobRegistry();
    new InventoryRecurringJobs(inventory).onModuleInit();
    expect(inventory.list()).toEqual(INVENTORY_RECURRING_JOBS);
    expect(inventory.get('inventory.transfers.unmatched_sweep')?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
    expect(inventory.get('inventory.ledger.reconcile_daily')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '02:00',
    });
  });
});
