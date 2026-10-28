/**
 * P9-22 — mesures de charge de l'analyse (ADR-068 §5 ; NFR-12, NFR-13, NFR-15) sur une base dédiée dont le nom se
 * termine par `_load` (db/README.md §7), chargée par `pnpm --filter @gic/db load:p9`. Lancées à la demande
 * (`pnpm --filter @gic/server test:perf`), hors de la suite par défaut. Avant toute écriture, le test refuse une
 * base non dédiée, un jeu incomplet ou inférieur au plancher (P9-25, PF-10) et imprime le volume mesuré. Les
 * fenêtres de mesure se calent sur le dernier jour du jeu, non sur la date du jour. Chaque mesure est répétée ; le
 * p95 est comparé au seuil de l'ADR :
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

/**
 * Plancher du jeu mesuré, en lignes de vente : le défaut du générateur (250 000 ventes) en produit 625 000 ;
 * `P9_PERF_MIN_LINES` l'abaisse pour un essai à blanc (le cas d'export exige au moins 100 000 lignes). Validé à la
 * collecte : une valeur non entière ne doit pas éteindre le plancher sans bruit.
 */
const MIN_LOAD_LINES = Number(process.env.P9_PERF_MIN_LINES ?? 500_000);
if (!Number.isInteger(MIN_LOAD_LINES) || MIN_LOAD_LINES < 1) {
  throw new Error('P9_PERF_MIN_LINES : entier ≥ 1 attendu.');
}

/** Décale un jour `AAAA-MM-JJ` de `days` jours (négatif : vers le passé). */
const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

const p95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number;
};

describe('P9-22 : charge de l’analyse', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let direction: Actor;
  let token: string;
  /** Dernier jour des ventes du jeu de charge : les fenêtres de mesure s'y calent. */
  let lastDay: string;

  const timed = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> => {
    const start = process.hrtime.bigint();
    const result = await run();
    return { ms: Number((process.hrtime.bigint() - start) / 1_000_000n), result };
  };
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    // Garde avant toute écriture (newActor valide un utilisateur, un appareil et une session) : base dédiée
    // (même règle que db/load/load-database-guard.ts ; garder les deux alignées) et jeu complet.
    const database =
      (await sql<{ name: string | null }>`SELECT DATABASE() AS name`.execute(db)).rows[0]?.name ??
      null;
    if (database === null || !/.+_load$/i.test(database)) {
      throw new Error(
        `Mesure de charge refusée : la base « ${database ?? '(aucune)'} » n’est pas dédiée (nom en « _load » exigé, db/README.md §7).`,
      );
    }
    const set = (
      await sql<{
        n_sales: string;
        last_number: string;
        first_day: string | null;
        last_day: string | null;
      }>`SELECT COUNT(*) AS n_sales,
                COALESCE(MAX(CAST(SUBSTRING(doc_number, 6) AS UNSIGNED)), 0) AS last_number,
                DATE_FORMAT(MIN(business_date), '%Y-%m-%d') AS first_day,
                DATE_FORMAT(MAX(business_date), '%Y-%m-%d') AS last_day
           FROM sales_sales WHERE doc_number LIKE 'LOAD-%'`.execute(db)
    ).rows[0];
    const lined = (
      await sql<{
        n_lines: string;
        n_products: string;
        n_sites: string;
      }>`SELECT COUNT(*) AS n_lines,
                COUNT(DISTINCT l.product_id) AS n_products, COUNT(DISTINCT s.site_id) AS n_sites
           FROM sales_sale_lines l JOIN sales_sales s ON s.id = l.sale_id
          WHERE s.doc_number LIKE 'LOAD-%'`.execute(db)
    ).rows[0];
    const bare = (
      await sql<{ n: string }>`SELECT COUNT(*) AS n FROM sales_sales s
          WHERE s.doc_number LIKE 'LOAD-%'
            AND NOT EXISTS (SELECT 1 FROM sales_sale_lines l WHERE l.sale_id = s.id)`.execute(db)
    ).rows[0];
    const sales = Number(set?.n_sales ?? 0);
    const lines = Number(lined?.n_lines ?? 0);
    const lastSaleDay = set?.last_day ?? null;
    // Numéros LOAD-1 à LOAD-n sans trou, chaque vente avec ses lignes, volume suffisant.
    if (
      sales === 0 ||
      sales !== Number(set?.last_number) ||
      Number(bare?.n ?? 1) !== 0 ||
      lines < MIN_LOAD_LINES ||
      lastSaleDay === null
    ) {
      throw new Error(
        `Jeu de charge inutilisable : ${sales} ventes (dernier numéro ${set?.last_number}), ${bare?.n} sans ligne, ` +
          `${lines} lignes de vente, ${MIN_LOAD_LINES} au moins exigées (pnpm --filter @gic/db load:p9, db/README.md §7).`,
      );
    }
    lastDay = lastSaleDay;
    process.stdout.write(
      `jeu de charge : ${sales} ventes, ${lines} lignes de vente, ${lined?.n_products} produits, ` +
        `${lined?.n_sites} sites, du ${set?.first_day} au ${lastSaleDay}\n`,
    );

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
  });

  afterAll(async () => {
    // La garde de beforeAll peut lever avant la création de l'application.
    await app?.close();
    await closeTestDb();
  });

  it.each([
    ['7 jours', 6],
    ['366 jours', 365],
  ])('tour de contrôle sur %s : p95 ≤ 3 s', async (label, span) => {
    // Fenêtre calée sur le dernier jour du jeu (jamais sur la date du jour : un jeu ancien vide la fenêtre).
    const period = `from=${shiftDay(lastDay, -span)}&to=${lastDay}`;
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
    const to = lastDay;
    const from = shiftDay(lastDay, -89);
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
    const to = lastDay;
    const from = shiftDay(lastDay, -365);
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
