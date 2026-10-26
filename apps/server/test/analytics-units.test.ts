/**
 * P9-15 à P9-22 — petites règles pures et partition des tâches du worker : ratio et nombre lus en base, indicateurs
 * d'un instantané sans lien d'exploration, document source d'une ligne, voie longue du worker (la voie courte exclut les
 * tâches longues, la voie longue les réclame seules).
 */
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import type { DatasetDefinition } from '@gic/domain';
import { datasetOf } from '@gic/domain';
import { sourceOf } from '../src/analytics-api/analytics-explorer.controller.js';
import { snapshotKpisOf } from '../src/analytics-api/jobs/kpi-snapshots-refresh-job.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { LONG_RUNNING_JOB_TYPES } from '../src/platform/jobs/job-lanes.js';
import { JobRunner } from '../src/platform/jobs/job-runner.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import { num, ratio } from '../src/platform/indicator-window.js';
import { db, freshUuid } from './helpers.js';

describe('ratio et nombre lus en base (P9-15)', () => {
  it('ratio : 4 décimales, demi supérieur ; null quand le dénominateur n’est pas positif', () => {
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(2, 3)).toBe(0.6667);
    expect(ratio(5, 5)).toBe(1);
    expect(ratio(0, 4)).toBe(0);
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(3, -2)).toBeNull();
    expect(ratio(3, Number.NaN)).toBeNull();
  });

  it('nombre : décimal en chaîne, entier, vide, texte illisible', () => {
    expect(num('12.50')).toBe(12.5);
    expect(num(7)).toBe(7);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('abc')).toBe(0);
  });
});

describe('instantané : indicateurs sans lien d’exploration (P9-18)', () => {
  it('retire explore, garde le reste dans l’ordre des blocs', () => {
    const kpis = snapshotKpisOf([
      {
        kpis: [
          {
            code: 'KPI-COM-07',
            label: 'Ventes',
            unit: 'count',
            value: 3,
            previousValue: 2,
            variationPct: 50,
            explore: {
              definition: {
                dataset: 'f_sales_line',
                dimensions: [],
                measures: ['sales_count'],
                filters: [],
                sort: [],
              },
            },
            alertType: null,
          },
        ],
      },
      {
        kpis: [
          { code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value: null, explore: null },
        ],
      },
    ]);
    expect(kpis).toEqual([
      {
        code: 'KPI-COM-07',
        label: 'Ventes',
        unit: 'count',
        value: 3,
        previousValue: 2,
        variationPct: 50,
        alertType: null,
      },
      { code: 'KPI-STK-01', label: 'Stock', unit: 'quantity', value: null },
    ]);
    expect(snapshotKpisOf([])).toEqual([]);
  });
});

describe('document source d’une ligne (P9-21)', () => {
  const sales = datasetOf('f_sales_line') as DatasetDefinition;
  const stock = datasetOf('f_stock_balance') as DatasetDefinition;
  const SALE = '0191a3f0-0000-7000-8000-0000000000aa';

  it('l’identifiant du document et sa route, quand la ligne regroupe par le document', () => {
    expect(sourceOf(sales, { sale_id: SALE, revenue: 1000 })).toEqual({
      type: 'SALE',
      id: SALE,
      route: `/api/v1/sales/${SALE}`,
    });
    expect(sourceOf(datasetOf('f_stock_moves') as DatasetDefinition, { move_id: SALE })).toEqual({
      type: 'STOCK_MOVE',
      id: SALE,
      route: '/api/v1/stock-moves',
    });
  });

  it('null pour une ligne agrégée, une valeur absente ou un jeu sans document', () => {
    expect(sourceOf(sales, { revenue: 1000 })).toBeNull();
    expect(sourceOf(sales, { sale_id: null, revenue: 1000 })).toBeNull();
    expect(sourceOf(sales, { sale_id: '', revenue: 1000 })).toBeNull();
    expect(sourceOf(sales, { sale_id: 12, revenue: 1000 })).toBeNull();
    expect(sourceOf(stock, { quantity: 1 })).toBeNull();
  });
});

describe('voie longue du worker (P9-22 ; ADR-078 §3)', () => {
  const NOW = new Date('2026-09-24T12:00:00.000Z');

  it('les tâches longues sont l’export et les instantanés', () => {
    expect([...LONG_RUNNING_JOB_TYPES].sort()).toEqual([
      'analytics.export.run',
      'analytics.kpi_snapshots.refresh',
    ]);
  });

  it('la voie courte n’en réclame aucune, la voie longue les réclame seules', async () => {
    const clock = new FixedClock(NOW);
    const jobs = new JobsService(clock, new Uuidv7Generator(clock));
    const short = `p9.test.short.${freshUuid().slice(-12)}`;
    const long = LONG_RUNNING_JOB_TYPES[0]!;
    const registry = new JobHandlerRegistry();
    const seen: string[] = [];
    registry.register(short, async () => {
      seen.push('courte');
    });
    registry.register(long, async () => {
      seen.push('longue');
    });
    const runner = new JobRunner(db, registry, clock);
    // Les types sont restreints aux deux de l'essai : aucune autre tâche de la base partagée n'est réclamée.
    const mine = { jobTypes: [short, long] };
    const shortId = await db
      .transaction()
      .execute((trx) => jobs.enqueue(trx, { jobType: short, payload: {} }));
    const longId = await db
      .transaction()
      .execute((trx) => jobs.enqueue(trx, { jobType: long, payload: {} }));

    const first = await runner.claimAndProcessOne({
      ...mine,
      excludeJobTypes: LONG_RUNNING_JOB_TYPES,
    });
    expect(first).toEqual({ claimed: true, jobId: shortId, result: 'DONE' });
    expect(
      await runner.claimAndProcessOne({ ...mine, excludeJobTypes: LONG_RUNNING_JOB_TYPES }),
    ).toEqual({ claimed: false });
    expect(seen).toEqual(['courte']);

    const second = await runner.claimAndProcessOne({ jobTypes: LONG_RUNNING_JOB_TYPES });
    expect(second).toEqual({ claimed: true, jobId: longId, result: 'DONE' });
    expect(seen).toEqual(['courte', 'longue']);
  });
});
