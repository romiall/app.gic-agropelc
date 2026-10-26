/**
 * P9-22 — mesures de charge de l'analyse (ADR-078 §5 ; NFR-12, NFR-13, NFR-15) sur une base jetable chargée par
 * `pnpm --filter @gic/db load:p9`. Lancées à la demande (`pnpm --filter @gic/server test:perf`), hors de la suite par
 * défaut. Chaque mesure est répétée ; le p95 est comparé au seuil de l'ADR :
 *
 * - tour de contrôle (`GET /analytics/dashboards/direction`) : p95 ≤ 3 s sur 366 jours **et** sur 7 jours ;
 * - explorateur (`POST /analytics/query`, ventes à 90 jours) : p95 ≤ 5 s ;
 * - export de 100 000 lignes : moins de 2 minutes (calcul et écriture du fichier).
 *
 * Les durées mesurées sont écrites dans la sortie ; le rapport de clôture dit ce qui a été mesuré et ce qui ne l'a pas
 * été (le facteur 10 de H-06 reste la porte d'avant production, NFR-33).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ANALYTICS_CATALOG_VERSION, type Clock } from '@gic/domain';
import { AppModule } from '../../src/app.module.js';
import { CLOCK } from '../../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../../src/platform/http/register-correlation-id.js';
import { CHUNK_STORAGE } from '../../src/platform/storage/chunk-storage.provider.js';
import type { ChunkStorage } from '../../src/platform/storage/chunk-storage.js';
import { JWT_KEYS } from '../../src/modules/identity/jwt-keys.provider.js';
import { insertExport } from '../../src/modules/analytics/application/exports/export-store.js';
import { runExport } from '../../src/modules/analytics/application/exports/run-export.js';
import { newActor, tx, type Actor } from '../cash-transfer-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser, signTestAccessToken } from '../helpers.js';

const RUNS = 10;
const DASHBOARD_P95_MS = 3_000;
const EXPLORER_P95_MS = 5_000;
const EXPORT_MAX_MS = 120_000;

const p95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number;
};

describe('P9-22 : charge de l’analyse', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let direction: Actor;
  let token: string;

  const timed = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> => {
    const start = process.hrtime.bigint();
    const result = await run();
    return { ms: Number((process.hrtime.bigint() - start) / 1_000_000n), result };
  };
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    const root = await tx((trx) => insertTestUser(trx));
    direction = await newActor('DIRECTION', root);
    token = await signTestAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: direction.userId, device_id: direction.deviceId, session_id: freshUuid() },
      clock.now(),
    );
    const { rows } = await sql<{
      n: string;
    }>`SELECT COUNT(*) AS n FROM sales_sales WHERE doc_number LIKE 'LOAD-%'`.execute(db);
    expect(
      Number(rows[0]?.n ?? 0),
      'le jeu de charge est chargé (pnpm --filter @gic/db load:p9)',
    ).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it.each([
    ['7 jours', 'period=WEEK'],
    [
      '366 jours',
      `from=${new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
    ],
  ])('tour de contrôle sur %s : p95 ≤ 3 s', async (label, period) => {
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const { ms, result } = await timed(() =>
        get(`/api/v1/analytics/dashboards/direction?${period}`),
      );
      expect(result.statusCode, result.body).toBe(200);
      samples.push(ms);
    }
    process.stdout.write(`tour de contrôle ${label} : p95 ${p95(samples)} ms (${samples.join(', ')})
`);
    expect(p95(samples)).toBeLessThanOrEqual(DASHBOARD_P95_MS);
  });

  it('explorateur, ventes à 90 jours : p95 ≤ 5 s', async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const { ms, result } = await timed(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/analytics/query',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          payload: JSON.stringify({
            definition: {
              dataset: 'f_sales_line',
              period: { code: 'CUSTOM', fromDay: from, toDay: to },
              dimensions: ['business_day', 'product_id'],
              measures: ['revenue', 'quantity'],
            },
          }),
        }),
      );
      expect(result.statusCode, result.body).toBe(200);
      samples.push(ms);
    }
    process.stdout.write(`explorateur 90 jours : p95 ${p95(samples)} ms (${samples.join(', ')})
`);
    expect(p95(samples)).toBeLessThanOrEqual(EXPLORER_P95_MS);
  });

  it('export de 100 000 lignes en moins de 2 minutes', async () => {
    const exportId = freshUuid();
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const definition = {
      dataset: 'f_sales_line',
      period: { code: 'CUSTOM', fromDay: from, toDay: to },
      dimensions: ['sale_id', 'business_day', 'product_id'],
      measures: ['revenue', 'quantity'],
      filters: [],
      sort: [],
      limit: 100_000,
    };
    await db.transaction().execute((trx) =>
      insertExport(trx, {
        id: exportId,
        requestedBy: direction.userId,
        dataset: 'f_sales_line',
        definition,
        format: 'CSV',
        catalogVersion: ANALYTICS_CATALOG_VERSION,
        commandId: freshUuid(),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    const storage = app.get<ChunkStorage>(CHUNK_STORAGE);
    const { ms, result } = await timed(() =>
      db
        .transaction()
        .execute((trx) =>
          runExport(trx, { clock, idGenerator: app.get(ID_GENERATOR), storage }, exportId),
        ),
    );
    process.stdout.write(`export de 100 000 lignes : ${ms} ms (${JSON.stringify(result)})
`);
    expect(result).toEqual({ status: 'DONE', rowCount: 100_000 });
    expect(ms).toBeLessThan(EXPORT_MAX_MS);
  });
});
