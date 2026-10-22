/**
 * P9-19 et P9-20 — lectures HTTP des vues sauvegardées et des exports (ADR-077 §2 et §6 ; BR-ANA-007, BR-ANA-008 ;
 * AV-434 ; AT-046) : NestJS + Fastify (`app.inject()`). Les vues sont listées avec leur exécutabilité, une vue
 * invisible est introuvable ; l'export n'est lu et téléchargé que par son demandeur — un administrateur qui détient
 * `audit.log.read` n'ouvre pas le fichier d'autrui —, le fichier est servi en flux, chaque téléchargement est audité,
 * un export échu est refusé (410).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { ANALYTICS_CATALOG_VERSION } from '@gic/domain';
import { exportJobSchema, savedViewSchema } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { CHUNK_STORAGE } from '../src/platform/storage/chunk-storage.provider.js';
import type { ChunkStorage } from '../src/platform/storage/chunk-storage.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { runExport } from '../src/modules/analytics/application/exports/run-export.js';
import {
  AnalyticsCommandHarness,
  TODAY,
  actorWith,
  salesDefinition,
  type CommandActor,
} from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser, signTestAccessToken } from './helpers.js';

/** Identifiant d'une colonne binaire d'audit (`entity_id`), en UUID. */
const idOf = (value: Buffer | null): string | null => (value === null ? null : fromBin(value));

describe('P9-19 et P9-20 : lectures des vues et des exports', { timeout: 120_000 }, () => {
  const harness = new AnalyticsCommandHarness();
  let app: NestFastifyApplication;
  let clock: Clock;
  let storage: ChunkStorage;
  const tokens = new Map<string, string>();
  let admin: string;
  let owner: CommandActor & { roleCode: string };
  let reader: CommandActor & { roleCode: string };
  let outsider: CommandActor & { roleCode: string };
  let auditor: CommandActor & { roleCode: string };
  let noExplore: CommandActor & { roleCode: string };

  const get = (actor: CommandActor, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens.get(actor.id)!}` } });
  const definition = (extra: Record<string, unknown> = {}) =>
    salesDefinition({
      period: { code: 'CUSTOM', fromDay: '2024-01-01', toDay: TODAY },
      dimensions: ['sale_id'],
      limit: 5,
      ...extra,
    });
  const deniedOf = (actor: CommandActor, entityType: string) =>
    db
      .selectFrom('audit_audit_log')
      .select(['entity_id', 'error_code'])
      .where('actor_user_id', '=', toBin(actor.id))
      .where('action', '=', 'access.denied')
      .where('entity_type', '=', entityType)
      .execute();

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    storage = app.get<ChunkStorage>(CHUNK_STORAGE);
    const jwtKeys = app.get(JWT_KEYS);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    owner = await actorWith(admin, ['analytics.explore', 'analytics.view.share', 'analytics.export', 'sales.sale.read']);
    reader = await actorWith(admin, ['analytics.explore', 'analytics.export', 'sales.sale.read']);
    outsider = await actorWith(admin, ['analytics.explore', 'analytics.export', 'sales.sale.read']);
    auditor = await actorWith(admin, ['audit.log.read', 'analytics.explore']);
    noExplore = await actorWith(admin, ['sales.sale.read']);
    for (const actor of [owner, reader, outsider, auditor, noExplore]) {
      tokens.set(
        actor.id,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.id, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }
  });
  afterAll(async () => {
    // Les tâches de calcul en file des exports de l'essai sont retirées (aucune tâche orpheline pour les autres essais).
    await db
      .deleteFrom('platform_jobs')
      .where('job_type', '=', 'analytics.export.run')
      .where('status', '=', 'PENDING')
      .where(
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.exportId')) IN (SELECT BIN_TO_UUID(id) FROM analytics_export_jobs WHERE requested_by IN (${sql.join([owner, reader, outsider].map((actor) => toBin(actor.id)))}))`,
      )
      .execute();
    await app.close();
    await closeTestDb();
  });

  describe('vues', () => {
    it('liste les vues visibles avec leur exécutabilité ; le tiers sans le rôle partagé ne la voit pas', async () => {
      const viewId = freshUuid();
      await harness.run(owner, 'analytics.view.save', 'SAVED_VIEW', viewId, {
        name: `Vue HTTP ${viewId.slice(-8)}`,
        definition: definition(),
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      });
      await harness.run(owner, 'analytics.view.share', 'SAVED_VIEW', viewId, { roles: [reader.roleCode] });

      const asReader = await get(reader, '/api/v1/analytics/views');
      expect(asReader.statusCode, asReader.body).toBe(200);
      const listed = (asReader.json() as { views: unknown[] }).views.map((view) => savedViewSchema.parse(view));
      expect(listed.find((view) => view.id === viewId)).toMatchObject({
        ownerUserId: owner.id,
        executability: 'OK',
        sharedWithRoles: [reader.roleCode],
      });
      const asOutsider = await get(outsider, '/api/v1/analytics/views');
      expect((asOutsider.json() as { views: { id: string }[] }).views.some((view) => view.id === viewId)).toBe(false);

      const one = await get(reader, `/api/v1/analytics/views/${viewId}`);
      expect(one.statusCode).toBe(200);
      expect(savedViewSchema.parse(one.json()).id).toBe(viewId);
    });

    it('une vue invisible ou inconnue : 404 audité ; sans le droit d’explorer : 403 audité ; sans jeton : 401', async () => {
      const viewId = freshUuid();
      await harness.run(owner, 'analytics.view.save', 'SAVED_VIEW', viewId, {
        name: `Vue privée ${viewId.slice(-8)}`,
        definition: definition(),
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      });
      const hidden = await get(outsider, `/api/v1/analytics/views/${viewId}`);
      expect(hidden.statusCode).toBe(404);
      expect((await deniedOf(outsider, 'ANALYTICS_VIEW')).some((row) => idOf(row.entity_id) === viewId)).toBe(true);
      expect((await get(outsider, `/api/v1/analytics/views/${freshUuid()}`)).statusCode).toBe(404);
      expect((await get(noExplore, '/api/v1/analytics/views')).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/v1/analytics/views' })).statusCode).toBe(401);
    });
  });

  describe('exports', () => {
    async function finishedExport(
      actor: CommandActor,
      format: 'CSV' | 'XLSX' = 'CSV',
      server: AnalyticsCommandHarness = harness,
      override: Record<string, unknown> = {},
    ): Promise<string> {
      const exportId = freshUuid();
      const result = await server.run(actor, 'analytics.export.request', 'ANALYTICS_EXPORT', exportId, {
        definition: definition(override),
        format,
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      });
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      const outcome = await db
        .transaction()
        .execute((trx) =>
          runExport(trx, { clock: server.clock, idGenerator: server.idGenerator, storage }, exportId),
        );
      expect(outcome.status).toBe('DONE');
      return exportId;
    }

    it('le demandeur liste, lit et télécharge son export (flux CSV, en-têtes, audit du téléchargement)', async () => {
      const exportId = await finishedExport(owner);
      const list = await get(owner, '/api/v1/analytics/exports');
      expect(list.statusCode, list.body).toBe(200);
      const jobs = (list.json() as { exports: unknown[] }).exports.map((job) => exportJobSchema.parse(job));
      expect(jobs.find((job) => job.id === exportId)).toMatchObject({ status: 'DONE', format: 'CSV', dataset: 'f_sales_line' });

      const one = await get(owner, `/api/v1/analytics/exports/${exportId}`);
      expect(exportJobSchema.parse(one.json())).toMatchObject({ id: exportId, status: 'DONE' });

      const file = await get(owner, `/api/v1/analytics/exports/${exportId}/download`);
      expect(file.statusCode, file.body).toBe(200);
      expect(file.headers['content-type']).toContain('text/csv');
      expect(String(file.headers['content-disposition'])).toContain('attachment; filename="export-f_sales_line-');
      expect(String(file.headers['cache-control'])).toContain('no-store');
      expect(file.body.startsWith('﻿Vente (document);')).toBe(true);
      const audit = await db
        .selectFrom('audit_audit_log')
        .select(['actor_user_id', 'result'])
        .where('entity_id', '=', toBin(exportId))
        .where('action', '=', 'analytics.export.downloaded')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.result).toBe('SUCCESS');
    });

    it('XLSX : type de contenu du classeur, archive servie', async () => {
      const exportId = await finishedExport(owner, 'XLSX');
      const file = await get(owner, `/api/v1/analytics/exports/${exportId}/download`);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(file.rawPayload.subarray(0, 2).toString('ascii')).toBe('PK');
    });

    it('aucun autre rôle ne télécharge ni ne lit : un tiers et un administrateur (audit.log.read) reçoivent 404, audité', async () => {
      const exportId = await finishedExport(owner);
      for (const actor of [outsider, reader]) {
        for (const url of [`/api/v1/analytics/exports/${exportId}`, `/api/v1/analytics/exports/${exportId}/download`]) {
          expect((await get(actor, url)).statusCode).toBe(404);
        }
      }
      // L'administrateur n'a pas `analytics.export` : refus 403 ; avec le droit d'exporter mais pas d'être le demandeur : 404.
      expect((await get(auditor, `/api/v1/analytics/exports/${exportId}/download`)).statusCode).toBe(403);
      expect((await deniedOf(outsider, 'ANALYTICS_EXPORT')).some((row) => idOf(row.entity_id) === exportId)).toBe(true);
      // Le tiers ne voit pas l'export dans sa liste.
      const list = await get(outsider, '/api/v1/analytics/exports');
      expect((list.json() as { exports: { id: string }[] }).exports.some((job) => job.id === exportId)).toBe(false);
    });

    it('un export échu (24 h) est refusé 410 et listé EXPIRED, un export en file 409', async () => {
      // Demandé et calculé avec une horloge de janvier : l'échéance est passée pour le serveur de l'essai.
      const past = new AnalyticsCommandHarness('2026-01-05T09:00:00.000Z');
      const exportId = await finishedExport(owner, 'CSV', past, {
        period: { code: 'CUSTOM', fromDay: '2025-01-01', toDay: '2025-12-31' },
      });
      const one = await get(owner, `/api/v1/analytics/exports/${exportId}`);
      expect(exportJobSchema.parse(one.json()).status).toBe('EXPIRED');
      const download = await get(owner, `/api/v1/analytics/exports/${exportId}/download`);
      expect(download.statusCode).toBe(410);
      expect((download.json() as { error: { code: string } }).error.code).toBe('EXPORT_EXPIRED');

      const queued = freshUuid();
      await harness.run(owner, 'analytics.export.request', 'ANALYTICS_EXPORT', queued, {
        definition: definition(),
        format: 'CSV',
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      });
      const notReady = await get(owner, `/api/v1/analytics/exports/${queued}/download`);
      expect(notReady.statusCode).toBe(409);
      expect((notReady.json() as { error: { code: string } }).error.code).toBe('EXPORT_NOT_READY');
    });
  });
});
