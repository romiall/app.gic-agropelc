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
import {
  FinanceRecurringJobs,
  FINANCE_RECURRING_JOBS,
} from '../src/modules/finance/application/jobs/finance-recurring-jobs.js';
import {
  SalesRecurringJobs,
  SALES_RECURRING_JOBS,
} from '../src/modules/sales/application/jobs/sales-recurring-jobs.js';
import {
  ProductionRecurringJobs,
  PRODUCTION_RECURRING_JOBS,
} from '../src/modules/production/application/jobs/production-recurring-jobs.js';
import {
  ProcurementRecurringJobs,
  PROCUREMENT_RECURRING_JOBS,
} from '../src/modules/procurement/application/jobs/procurement-recurring-jobs.js';
import {
  ApprovalsRecurringJobs,
  APPROVALS_RECURRING_JOBS,
} from '../src/modules/approvals/application/jobs/approvals-recurring-jobs.js';
import { AUDIT_RECURRING_JOBS, AuditRecurringJobs } from '../src/audit/audit-recurring-jobs.js';
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

  it('récurrence quotidienne à l’heure de Douala (02:00 = 01:00 UTC) : à l’inscription elle attend son premier créneau local, puis part une fois par jour', async () => {
    const clock = new FixedClock(T0);
    const type = testType('daily');
    const scheduler = schedulerFor(
      [{ jobType: type, schedule: { kind: 'DAILY', localTime: '02:00' } }],
      clock,
    );
    // 11:17 à Douala : une tâche « à 02:00 » ne part pas au milieu de la journée parce qu'elle vient
    // d'être inscrite (contrairement à un intervalle, qui part au premier tour).
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect(await jobsOf(type)).toHaveLength(0);
    const row = await scheduleRow(type);
    expect(row).toMatchObject({
      schedule_kind: 'DAILY',
      interval_seconds: null,
      local_time: '02:00',
      last_job_id: null,
    });
    expect(row!.next_run_at.toISOString()).toBe('2026-10-10T01:00:00.000Z');

    clock.setTo(new Date('2026-10-10T01:00:30.000Z'));
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toHaveLength(1);
    expect(await scheduler.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect((await scheduleRow(type))!.next_run_at.toISOString()).toBe('2026-10-11T01:00:00.000Z');
  });

  it('créneau quotidien manqué par un arrêt du worker : une seule occurrence de rattrapage au redémarrage', async () => {
    const clock = new FixedClock(T0);
    const type = testType('daily-missed');
    const jobs = [
      { jobType: type, schedule: { kind: 'DAILY', localTime: '02:00' } } as const,
    ] as const;
    await schedulerFor(jobs, clock).enqueueDue({ jobTypes: [type] });
    // Le worker redémarre à 14:30 à Douala, après le créneau de 02:00 manqué : il part une fois.
    clock.setTo(new Date('2026-10-10T13:30:00.000Z'));
    const restarted = schedulerFor(jobs, clock);
    expect(await restarted.enqueueDue({ jobTypes: [type] })).toHaveLength(1);
    expect(await restarted.enqueueDue({ jobTypes: [type] })).toEqual([]);
    expect((await scheduleRow(type))!.next_run_at.toISOString()).toBe('2026-10-11T01:00:00.000Z');
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

  it('récurrences de finance inscrites : ouverture prolongée et remises non reçues chaque heure, réconciliation de trésorerie quotidienne à Douala', () => {
    const finance = new RecurringJobRegistry();
    new FinanceRecurringJobs(finance).onModuleInit();
    expect(finance.list()).toEqual(FINANCE_RECURRING_JOBS);
    expect(finance.get('finance.cash_sessions.open_long_check')?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
    expect(finance.get('finance.cash_transfers.unreceived_check')?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
    expect(finance.get('finance.cash.reconcile_daily')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '02:30',
    });
    // P9-07 : encaisse élevée (horaire : une remise ferme l'alerte dans l'heure) et justificatif de
    // dépense manquant (quotidien à 06:15, heure de Douala).
    expect(finance.get('finance.cash_holdings.high_check')?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
    expect(finance.get('finance.expenses.attachment_missing_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '06:15',
    });
    // P9-07 : récurrences de `sales` (créances 07:00, ventes non livrées 07:30, commerciaux inactifs 08:00).
    const sales = new RecurringJobRegistry();
    new SalesRecurringJobs(sales).onModuleInit();
    expect(sales.list()).toEqual(SALES_RECURRING_JOBS);
    expect(sales.get('sales.receivables.overdue_daily')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '07:00',
    });
    expect(sales.get('sales.orders.undelivered_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '07:30',
    });
    expect(sales.get('sales.commercial.inactivity_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '08:00',
    });
    // P9-09 : récurrences de `production` (coût standard manquant 07:45, saisie du jour manquante 10:00).
    const production = new RecurringJobRegistry();
    new ProductionRecurringJobs(production).onModuleInit();
    expect(production.list()).toEqual(PRODUCTION_RECURRING_JOBS);
    expect(production.get('production.products.standard_cost_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '07:45',
    });
    expect(production.get('production.lots.daily_entry_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '10:00',
    });
    // P9-09 : récurrences de `procurement` (photo de réception 06:15, réception incomplète 07:15) et
    // d'`approvals` (validations en attente, toutes les heures).
    const procurement = new RecurringJobRegistry();
    new ProcurementRecurringJobs(procurement).onModuleInit();
    expect(procurement.list()).toEqual(PROCUREMENT_RECURRING_JOBS);
    expect(procurement.get('procurement.receipts.attachment_missing_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '06:15',
    });
    expect(procurement.get('procurement.orders.receipt_incomplete_check')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '07:15',
    });
    const approvals = new RecurringJobRegistry();
    new ApprovalsRecurringJobs(approvals).onModuleInit();
    expect(approvals.list()).toEqual(APPROVALS_RECURRING_JOBS);
    expect(approvals.get('approvals.requests.pending_long_check')?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 3600,
    });
    // P9-10 : vérification quotidienne de la chaîne d'audit, à 03:00 (AV-470).
    const audit = new RecurringJobRegistry();
    new AuditRecurringJobs(audit).onModuleInit();
    expect(audit.list()).toEqual(AUDIT_RECURRING_JOBS);
    expect(audit.get('audit.chain.verify_daily')?.schedule).toEqual({
      kind: 'DAILY',
      localTime: '03:00',
    });
    // Un même processus inscrit les modules sans collision de type de tâche.
    const both = new RecurringJobRegistry();
    new InventoryRecurringJobs(both).onModuleInit();
    new FinanceRecurringJobs(both).onModuleInit();
    new SalesRecurringJobs(both).onModuleInit();
    new ProductionRecurringJobs(both).onModuleInit();
    new ProcurementRecurringJobs(both).onModuleInit();
    new ApprovalsRecurringJobs(both).onModuleInit();
    new AuditRecurringJobs(both).onModuleInit();
    expect(both.list()).toHaveLength(
      INVENTORY_RECURRING_JOBS.length +
        FINANCE_RECURRING_JOBS.length +
        SALES_RECURRING_JOBS.length +
        PRODUCTION_RECURRING_JOBS.length +
        PROCUREMENT_RECURRING_JOBS.length +
        APPROVALS_RECURRING_JOBS.length +
        AUDIT_RECURRING_JOBS.length,
    );
  });
});
