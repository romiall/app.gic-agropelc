/**
 * P9-20 et P9-22 — exports audités (ADR-067 §3 à §8 ; BR-ANA-008 ; AV-383, AV-384, AV-447 ; AT-046) : la commande
 * `analytics.export.request` par le vrai pipeline, la tâche de calcul `runExport` sur un stockage local temporaire
 * (CSV et XLSX relus, droit retiré entre la demande et le calcul : `FAILED` sans levée, rejeu sans fichier partiel,
 * tâche déjà terminée sans second effet), puis la purge quotidienne. Acteurs à rôle d'essai sur la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enough } from './analytics-view-seeds.js';
import { sql } from 'kysely';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYTICS_CATALOG_VERSION, businessPeriodOf } from '@gic/domain';
import { LocalFsChunkStorage } from '../src/platform/storage/local-fs-chunk-storage.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordAudit } from '../src/audit/record-audit.js';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import {
  concludeExport,
  runExport,
  runExportJob,
} from '../src/modules/analytics/application/exports/run-export.js';
import {
  exportStorageKey,
  lockExport,
  pendingExportCount,
} from '../src/modules/analytics/application/exports/export-store.js';
import { runAnalyticsPurge } from '../src/modules/analytics/application/maintenance/purge.js';
import {
  AnalyticsCommandHarness,
  TODAY,
  actorWith,
  salesDefinition,
  type CommandActor,
} from './analytics-command-fixtures.js';
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
  withTestUow,
} from './helpers.js';

const REQUEST = 'analytics.export.request';
const WINDOW_START = '2024-01-01';

describe('P9-20 : exports audités', () => {
  const harness = new AnalyticsCommandHarness();
  const directory = mkdtempSync(join(tmpdir(), 'gic-export-'));
  const storage = new LocalFsChunkStorage(directory);
  let admin: string;

  /** Exports demandés par l'essai : leurs tâches en file sont retirées à la fin (aucune tâche orpheline pour les autres essais). */
  const requested: string[] = [];
  const request = (
    actor: CommandActor,
    exportId: string,
    extra: Record<string, unknown> = {},
    options: { offline?: boolean } = {},
  ) => {
    requested.push(exportId);
    return harness.run(
      actor,
      REQUEST,
      'ANALYTICS_EXPORT',
      exportId,
      {
        definition: definition(),
        format: 'CSV',
        catalogVersion: ANALYTICS_CATALOG_VERSION,
        ...extra,
      },
      options,
    );
  };
  /** Les cinq premières ventes de la base (un document par ligne) : borné, donc indépendant du volume de la base. */
  const definition = (extra: Record<string, unknown> = {}) =>
    salesDefinition({
      period: { code: 'CUSTOM', fromDay: WINDOW_START, toDay: TODAY },
      dimensions: ['sale_id'],
      measures: ['revenue'],
      limit: 5,
      ...extra,
    });
  const run = (exportId: string) =>
    db
      .transaction()
      .execute((trx) =>
        runExport(
          trx,
          { clock: harness.clock, idGenerator: harness.idGenerator, storage },
          exportId,
        ),
      );
  const rowOf = (exportId: string) =>
    db
      .selectFrom('analytics_export_jobs')
      .selectAll()
      .where('id', '=', toBin(exportId))
      .executeTakeFirst();
  const expectedRows = async (): Promise<number> => {
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*) AS n FROM (
        SELECT sale_id FROM analytics_f_sales_line
         WHERE business_day BETWEEN ${WINDOW_START} AND ${TODAY} GROUP BY sale_id LIMIT 5) t`.execute(
      db,
    );
    return Number(rows[0]!.n);
  };
  const purge = () =>
    db.transaction().execute((trx) =>
      runAnalyticsPurge(trx, {
        clock: harness.clock,
        idGenerator: harness.idGenerator,
        storage,
      }),
    );
  /** Un réglage global valable une seconde avant l'instant du serveur, dans la transaction (annulée) de l'essai. */
  const setting = (
    trx: Parameters<Parameters<typeof withTestUow>[0]>[0],
    key: string,
    value: unknown,
  ) =>
    trx
      .insertInto('organization_system_settings')
      .values({
        id: toBin(freshUuid()),
        key,
        value: JSON.stringify(value),
        scope_type: 'GLOBAL',
        valid_from: new Date(harness.clock.now().getTime() - 1000),
        created_by: toBin(admin),
      })
      .execute();
  /** Droit d'exporter en global, lecture des ventes sur `siteCount` sites : l'étendue exacte porte autant de candidats. */
  const siteScopedActor = (siteCount: number): Promise<CommandActor> =>
    db.transaction().execute(async (trx) => {
      const id = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, id, { status: 'ACTIVE' });
      const exporter = await insertTestRole(trx, admin);
      await grantTestPermission(trx, exporter, 'analytics.export', admin);
      await assignTestRole(trx, id, exporter, admin);
      const reader = await insertTestRole(trx, admin, { allowedScopeTypes: ['GLOBAL', 'SITE'] });
      // Portée maximale SITE : avec `ALL` (défaut du helper) l'étendue serait « tout » et jamais tronquée.
      await grantTestPermission(trx, reader, 'sales.sale.read', admin, { maxScope: 'SITE' });
      const zone = await insertTestZone(trx, admin);
      for (let index = 0; index < siteCount; index += 1) {
        const site = await insertTestSite(trx, admin, zone);
        await assignTestRole(trx, id, reader, admin, { scopeType: 'SITE', scopeSiteId: site });
      }
      return { id, deviceId };
    });
  const auditOf = (exportId: string, action: string) =>
    db
      .selectFrom('audit_audit_log')
      .select(['result', 'error_code', 'after'])
      .where('entity_id', '=', toBin(exportId))
      .where('action', '=', action)
      .execute();

  beforeAll(async () => {
    admin = await db.transaction().execute((trx) => insertTestUser(trx));
  });
  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    for (const exportId of requested) {
      await db
        .deleteFrom('platform_jobs')
        .where('job_type', '=', 'analytics.export.run')
        .where('status', '=', 'PENDING')
        .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.exportId')) = ${exportId}`)
        .execute();
    }
    await closeTestDb();
  });

  describe('la demande', () => {
    it('crée la ligne QUEUED (échéance 24 h après la demande), dépose la tâche, publie l’événement et l’audit', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      const result = await request(actor, exportId);
      expect(result.status).toBe('APPLIED');
      const row = await rowOf(exportId);
      expect(row).toMatchObject({
        dataset: 'f_sales_line',
        format: 'CSV',
        status: 'QUEUED',
        catalog_version: ANALYTICS_CATALOG_VERSION,
        row_count: null,
        finished_at: null,
      });
      expect(row!.expires_at.getTime() - new Date('2026-10-22T09:00:00.000Z').getTime()).toBe(
        24 * 3_600_000,
      );
      const jobs = await db
        .selectFrom('platform_jobs')
        .select(['job_type', 'payload', 'status'])
        .where('job_type', '=', 'analytics.export.run')
        .execute();
      expect(jobs.some((job) => (job.payload as { exportId: string }).exportId === exportId)).toBe(
        true,
      );
      const events = await db
        .selectFrom('platform_domain_events')
        .select('payload')
        .where('event_type', '=', 'AnalyticsExportRequested')
        .where('aggregate_id', '=', toBin(exportId))
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        export_id: exportId,
        requested_by: actor.id,
        format: 'CSV',
      });
      const audit = await auditOf(exportId, REQUEST);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.result).toBe('SUCCESS');
      expect((audit[0]!.after as { definition: { dataset: string } }).definition.dataset).toBe(
        'f_sales_line',
      );
    });

    it('un identifiant déjà connu du même demandeur est rendu appliqué sans second effet ; celui d’un autre est introuvable', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const other = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      expect((await request(actor, exportId)).status).toBe('APPLIED');
      const { rows } = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM platform_jobs
         WHERE job_type = 'analytics.export.run' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.exportId')) = ${exportId}`.execute(
        db,
      );
      expect(Number(rows[0]!.n)).toBe(1);
      expect(await request(other, exportId)).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOT_FOUND' },
      });
    });

    it('refus : hors ligne, catalogue périmé, sans le droit d’exporter, jeu illisible, mesure au coût sans droit', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      expect(await request(actor, freshUuid(), {}, { offline: true })).toMatchObject({
        status: 'REJECTED',
        error: { code: 'ONLINE_REQUIRED' },
      });
      expect(
        await request(actor, freshUuid(), { catalogVersion: ANALYTICS_CATALOG_VERSION + 1 }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'CATALOG_OUTDATED' } });
      const noExport = await actorWith(admin, ['analytics.explore', 'sales.sale.read']);
      expect(await request(noExport, freshUuid())).toMatchObject({
        status: 'REJECTED',
        error: { code: 'FORBIDDEN' },
      });
      const blind = await actorWith(admin, ['analytics.export']);
      expect(await request(blind, freshUuid())).toMatchObject({
        status: 'REJECTED',
        error: { code: 'FORBIDDEN' },
      });
      expect(
        await request(actor, freshUuid(), { definition: definition({ measures: ['margin'] }) }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN_MEASURE' } });
      // Un export financier exige les deux droits : avec `inventory.valuation.read`, la même demande passe.
      const finance = await actorWith(admin, [
        'analytics.export',
        'sales.sale.read',
        'inventory.valuation.read',
      ]);
      expect(
        (await request(finance, freshUuid(), { definition: definition({ measures: ['margin'] }) }))
          .status,
      ).toBe('APPLIED');
    });

    it('au plus trois exports en file ou en cours par demandeur (EXPORT_BACKLOG)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      for (let index = 0; index < 3; index += 1) {
        expect((await request(actor, freshUuid())).status).toBe('APPLIED');
      }
      expect(await request(actor, freshUuid())).toMatchObject({
        status: 'REJECTED',
        error: { code: 'EXPORT_BACKLOG' },
      });
    });

    it('une période nommée est figée à la demande : plage résolue conservée, période demandée gardée dans l’audit (EX-7)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      const result = await request(actor, exportId, {
        definition: definition({ period: { code: 'MONTH' } }),
      });
      expect(result.status).toBe('APPLIED');
      const month = businessPeriodOf('MONTH', TODAY);
      expect((await rowOf(exportId))!.definition).toMatchObject({
        period: { code: 'CUSTOM', fromDay: month.fromDay, toDay: month.toDay },
      });
      const audit = await auditOf(exportId, REQUEST);
      expect(audit[0]!.after).toMatchObject({
        definition: { period: { code: 'CUSTOM', fromDay: month.fromDay, toDay: month.toDay } },
        requested_period: { code: 'MONTH' },
      });
      // Une plage personnalisée reste telle quelle, et l'audit n'invente pas de période demandée.
      const custom = freshUuid();
      await request(actor, custom);
      expect((await rowOf(custom))!.definition).toMatchObject({
        period: { code: 'CUSTOM', fromDay: WINDOW_START, toDay: TODAY },
      });
      expect((await auditOf(custom, REQUEST))[0]!.after).toMatchObject({
        requested_period: { code: 'CUSTOM', fromDay: WINDOW_START, toDay: TODAY },
      });
    });

    it('deux demandes simultanées d’un même demandeur, depuis deux appareils, au seuil du plafond : une seule passe (EX-8)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const second = await db.transaction().execute(async (trx) => ({
        id: actor.id,
        deviceId: await insertTestDevice(trx, actor.id, { status: 'ACTIVE' }),
      }));
      for (let index = 0; index < 2; index += 1) {
        expect((await request(actor, freshUuid())).status).toBe('APPLIED');
      }
      const results = await Promise.all([
        request(actor, freshUuid()),
        request(second, freshUuid()),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['APPLIED', 'REJECTED']);
      expect(results.find((result) => result.status === 'REJECTED')).toMatchObject({
        error: { code: 'EXPORT_BACKLOG' },
      });
    });
  });

  describe('le calcul', () => {
    it('CSV : fichier relu (BOM, entête, une ligne par vente), ligne DONE, audit et événement de fin', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      const outcome = await run(exportId);
      const expected = await expectedRows();
      expect(outcome).toEqual({ status: 'DONE', rowCount: expected });

      const row = await rowOf(exportId);
      expect(row).toMatchObject({
        status: 'DONE',
        row_count: expected,
        storage_key: exportStorageKey(exportId),
        error_code: null,
      });
      expect(row!.finished_at).not.toBeNull();
      const file = (await storage.readAll(exportStorageKey(exportId))).toString('utf8');
      expect(file.startsWith('﻿')).toBe(true);
      const lines = file.split('\r\n');
      expect(lines.pop()).toBe('');
      expect(lines).toHaveLength(expected + 1);
      expect(lines[0]).toBe("﻿Vente (document);Chiffre d'affaires");

      const completed = await auditOf(exportId, 'analytics.export.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]!.result).toBe('SUCCESS');
      expect(completed[0]!.after).toMatchObject({
        status: 'DONE',
        row_count: expected,
        dataset: 'f_sales_line',
      });
      const events = await db
        .selectFrom('platform_domain_events')
        .select('payload')
        .where('event_type', '=', 'AnalyticsExportCompleted')
        .where('aggregate_id', '=', toBin(exportId))
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ status: 'DONE', requested_by: actor.id });
    });

    it('XLSX : l’archive commence par « PK » et se relit comme une feuille', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId, { format: 'XLSX' });
      expect((await run(exportId)).status).toBe('DONE');
      const file = await storage.readAll(exportStorageKey(exportId));
      expect(file.subarray(0, 2).toString('ascii')).toBe('PK');
      expect(file.includes(Buffer.from('xl/worksheets/sheet1.xml', 'utf8'))).toBe(true);
    });

    it('droit retiré entre la demande et le calcul : FAILED FORBIDDEN, sans levée, sans fichier, audité', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      await db
        .updateTable('identity_user_role_assignments')
        .set({ revoked_at: new Date('2026-10-22T08:00:00.000Z') })
        .where('user_id', '=', toBin(actor.id))
        .execute();
      // Les octrois sont mis en cache par processus : une révocation écrite en base se déclare au cache.
      invalidateUser(actor.id);
      const outcome = await run(exportId);
      expect(outcome).toEqual({ status: 'FAILED', errorCode: 'FORBIDDEN' });
      const row = await rowOf(exportId);
      expect(row).toMatchObject({
        status: 'FAILED',
        error_code: 'FORBIDDEN',
        storage_key: null,
        row_count: null,
      });
      expect(await storage.uploadedBytes(exportStorageKey(exportId))).toBe(0);
      const completed = await auditOf(exportId, 'analytics.export.completed');
      expect(completed).toEqual([
        expect.objectContaining({ result: 'FAILED', error_code: 'FORBIDDEN' }),
      ]);
    });

    it('une tâche déjà terminée est ignorée (aucun second audit, aucun second événement)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      expect((await run(exportId)).status).toBe('DONE');
      expect(await run(exportId)).toEqual({ status: 'SKIPPED' });
      expect(await run(freshUuid())).toEqual({ status: 'SKIPPED' });
      expect(await auditOf(exportId, 'analytics.export.completed')).toHaveLength(1);
    });

    it('rejeu après interruption : le fichier partiel est supprimé avant la nouvelle écriture', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      const key = exportStorageKey(exportId);
      await storage.appendChunk(key, 0, Buffer.from('PARTIEL-'.repeat(100), 'utf8'));
      expect((await run(exportId)).status).toBe('DONE');
      const file = (await storage.readAll(key)).toString('utf8');
      expect(file.startsWith('﻿')).toBe(true);
      expect(file).not.toContain('PARTIEL');
    });

    it('plus de lignes que le plafond : FAILED QUERY_LIMIT_EXCEEDED, sans fichier, audité, jamais tronqué (EX-5)', async (ctx) => {
      enough(ctx, await expectedRows(), 2, 'lignes de vente dans la période');
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId, { definition: definition({ limit: undefined }) });
      await withTestUow(async (trx) => {
        await setting(trx, 'analytics.export_max_rows', 1);
        const outcome = await runExport(
          trx,
          { clock: harness.clock, idGenerator: harness.idGenerator, storage },
          exportId,
        );
        expect(outcome).toEqual({ status: 'FAILED', errorCode: 'QUERY_LIMIT_EXCEEDED' });
        expect(
          await trx
            .selectFrom('analytics_export_jobs')
            .select(['status', 'error_code', 'storage_key', 'row_count'])
            .where('id', '=', toBin(exportId))
            .executeTakeFirst(),
        ).toEqual({
          status: 'FAILED',
          error_code: 'QUERY_LIMIT_EXCEEDED',
          storage_key: null,
          row_count: null,
        });
        expect(
          await trx
            .selectFrom('audit_audit_log')
            .select(['result', 'error_code'])
            .where('entity_id', '=', toBin(exportId))
            .where('action', '=', 'analytics.export.completed')
            .execute(),
        ).toEqual([{ result: 'FAILED', error_code: 'QUERY_LIMIT_EXCEEDED' }]);
      });
      expect(await storage.uploadedBytes(exportStorageKey(exportId))).toBe(0);
    });

    it('étendue tronquée faute de place : FAILED SCOPE_TRUNCATED, sans fichier, audité, jamais un export partiel (EX-5)', async () => {
      const actor = await siteScopedActor(2);
      const exportId = freshUuid();
      expect((await request(actor, exportId)).status).toBe('APPLIED');
      await withTestUow(async (trx) => {
        await setting(trx, 'analytics.scope_max_candidates', 1);
        const outcome = await runExport(
          trx,
          { clock: harness.clock, idGenerator: harness.idGenerator, storage },
          exportId,
        );
        expect(outcome).toEqual({ status: 'FAILED', errorCode: 'SCOPE_TRUNCATED' });
        expect(
          await trx
            .selectFrom('audit_audit_log')
            .select(['result', 'error_code'])
            .where('entity_id', '=', toBin(exportId))
            .where('action', '=', 'analytics.export.completed')
            .execute(),
        ).toEqual([{ result: 'FAILED', error_code: 'SCOPE_TRUNCATED' }]);
      });
      expect(await storage.uploadedBytes(exportStorageKey(exportId))).toBe(0);
    });
  });

  describe('tâche perdue : dernier essai (PF-6, AV-469)', () => {
    const jobRun = (
      store: LocalFsChunkStorage,
      exportId: string,
      attempt?: { attempt: number; maxAttempts: number },
      logger?: { error: (message: unknown) => void },
    ) =>
      db
        .transaction()
        .execute((trx) =>
          runExportJob(
            trx,
            { clock: harness.clock, idGenerator: harness.idGenerator, storage: store },
            exportId,
            attempt,
            logger,
          ),
        );
    const completedEvents = (exportId: string) =>
      db
        .selectFrom('platform_domain_events')
        .select('payload')
        .where('event_type', '=', 'AnalyticsExportCompleted')
        .where('aggregate_id', '=', toBin(exportId))
        .execute();

    it('au dernier essai, une erreur technique ne remonte plus : FAILED EXPORT_JOB_FAILED, audité, demandeur prévenu, le compte des exports en cours retombe', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      expect(await pendingExportCount(db, actor.id)).toBe(1);
      const messages: string[] = [];
      const outcome = await jobRun(
        new FailingAppendStorage(directory),
        exportId,
        { attempt: 5, maxAttempts: 5 },
        {
          error: (message) => {
            messages.push(String(message));
          },
        },
      );
      expect(outcome).toEqual({ status: 'FAILED', errorCode: 'EXPORT_JOB_FAILED' });
      expect(await rowOf(exportId)).toMatchObject({
        status: 'FAILED',
        error_code: 'EXPORT_JOB_FAILED',
        storage_key: null,
        row_count: null,
      });
      expect(await auditOf(exportId, 'analytics.export.completed')).toEqual([
        expect.objectContaining({ result: 'FAILED', error_code: 'EXPORT_JOB_FAILED' }),
      ]);
      const events = await completedEvents(exportId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        status: 'FAILED',
        error_code: 'EXPORT_JOB_FAILED',
        requested_by: actor.id,
      });
      expect(await storage.uploadedBytes(exportStorageKey(exportId))).toBe(0);
      expect(await pendingExportCount(db, actor.id)).toBe(0);
      // Le journal dit l'export et la nature de l'erreur, jamais son message (il peut citer des valeurs).
      expect(messages.join('\n')).toContain(exportId);
      expect(messages.join('\n')).not.toContain('stockage en panne');
    });

    it('stockage en panne en écriture ET en suppression : l’export est tout de même conclu (base d’abord, fichier au mieux)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      const messages: string[] = [];
      const outcome = await jobRun(
        new BrokenStorage(directory),
        exportId,
        { attempt: 5, maxAttempts: 5 },
        {
          error: (message) => {
            messages.push(String(message));
          },
        },
      );
      expect(outcome).toEqual({ status: 'FAILED', errorCode: 'EXPORT_JOB_FAILED' });
      expect(await rowOf(exportId)).toMatchObject({
        status: 'FAILED',
        error_code: 'EXPORT_JOB_FAILED',
      });
      expect(await auditOf(exportId, 'analytics.export.completed')).toHaveLength(1);
      expect(await completedEvents(exportId)).toHaveLength(1);
      expect(await pendingExportCount(db, actor.id)).toBe(0);
      // La suppression tardive en échec est journalisée (la purge supprimera le fichier d'un export FAILED).
      expect(messages.some((message) => message.includes('non supprimé'))).toBe(true);
    });

    it('avant le dernier essai, comme sans contexte, la même erreur remonte : la ligne reste en file, rien n’est conclu', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      await expect(
        jobRun(new FailingAppendStorage(directory), exportId, { attempt: 4, maxAttempts: 5 }),
      ).rejects.toThrow('stockage en panne');
      await expect(jobRun(new FailingAppendStorage(directory), exportId)).rejects.toThrow(
        'stockage en panne',
      );
      expect((await rowOf(exportId))!.status).toBe('QUEUED');
      expect(await auditOf(exportId, 'analytics.export.completed')).toEqual([]);
      expect(await completedEvents(exportId)).toEqual([]);
      expect(await pendingExportCount(db, actor.id)).toBe(1);
    });

    it('au dernier essai, un export déjà terminé rend SKIPPED (rendu par runExport) et n’est pas modifié', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      expect((await run(exportId)).status).toBe('DONE');
      const before = await rowOf(exportId);
      expect(await jobRun(storage, exportId, { attempt: 5, maxAttempts: 5 })).toEqual({
        status: 'SKIPPED',
      });
      expect(await rowOf(exportId)).toEqual(before);
      expect(await auditOf(exportId, 'analytics.export.completed')).toHaveLength(1);
    });
  });

  describe('la purge quotidienne (P9-22)', () => {
    it('passe EXPIRED les exports échus, supprime les fichiers à 30 jours, abandonne les exports perdus', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const done = freshUuid();
      const lost = freshUuid();
      await request(actor, done);
      await run(done);
      await request(actor, lost);
      const key = exportStorageKey(done);
      expect(await storage.uploadedBytes(key)).toBeGreaterThan(0);

      // Vingt-cinq jours après la demande : échu (24 h), fichier encore présent (moins de 30 jours).
      harness.clock.setTo(new Date(Date.now() + 25 * 86_400_000));
      let outcome = await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        }),
      );
      expect(outcome.exportsExpired).toBeGreaterThanOrEqual(1);
      expect((await rowOf(done))!.status).toBe('EXPIRED');
      expect(await storage.uploadedBytes(key)).toBeGreaterThan(0);
      // L'export resté en file depuis plus d'un jour est abandonné.
      expect(outcome.exportsAbandoned).toBeGreaterThanOrEqual(1);
      expect(await rowOf(lost)).toMatchObject({ status: 'FAILED', error_code: 'EXPORT_ABANDONED' });
      expect(await auditOf(lost, 'analytics.export.abandoned')).toEqual([
        expect.objectContaining({ result: 'FAILED', error_code: 'EXPORT_ABANDONED' }),
      ]);

      // Trente-deux jours après la demande : le fichier est supprimé, la ligne reste.
      harness.clock.setTo(new Date(Date.now() + 32 * 86_400_000));
      outcome = await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        }),
      );
      expect(outcome.exportFilesDeleted).toBeGreaterThanOrEqual(1);
      expect(await storage.uploadedBytes(key)).toBe(0);
      expect((await rowOf(done))!.status).toBe('EXPIRED');
    });

    it('une donnée en deçà de la durée n’est jamais supprimée (journal des requêtes de moins de 90 jours)', async () => {
      const user = await db.transaction().execute((trx) => insertTestUser(trx));
      const logId = freshUuid();
      await db
        .insertInto('analytics_query_log')
        .values({
          id: toBin(logId),
          user_id: toBin(user),
          dataset: 'f_sales_line',
          definition: JSON.stringify({ definition: {}, catalogVersion: 1 }),
          outcome: 'OK',
        })
        .execute();
      harness.clock.setTo(new Date(Date.now() + 80 * 86_400_000));
      await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        }),
      );
      expect(
        await db
          .selectFrom('analytics_query_log')
          .select('id')
          .where('id', '=', toBin(logId))
          .executeTakeFirst(),
      ).toBeDefined();
      harness.clock.setTo(new Date(Date.now() + 100 * 86_400_000));
      await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        }),
      );
      expect(
        await db
          .selectFrom('analytics_query_log')
          .select('id')
          .where('id', '=', toBin(logId))
          .executeTakeFirst(),
      ).toBeUndefined();
    });

    it('la purge saute l’export que le calcul tient verrouillé : il se termine DONE avec son fichier (EX-1)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      const key = exportStorageKey(exportId);
      await storage.appendChunk(key, 0, Buffer.from('EN-COURS', 'utf8'));
      // Plus de 24 h après la demande : l'export est candidat à l'abandon.
      harness.clock.setTo(new Date(Date.now() + 2 * 86_400_000));
      await db.transaction().execute(async (worker) => {
        // Le worker tient sa ligne (début de runExport) ; la purge passe en même temps, dans sa propre transaction.
        const job = await lockExport(worker, exportId);
        await purge();
        // La fin passe par la conclusion réelle (ligne, audit de fin, événement) : un export DONE sans ligne d'audit
        // de fin violerait INV-ANA-01 pour tous les essais de la base partagée. L'horloge revient à l'instant réel :
        // la fin n'est pas datée du futur.
        harness.clock.setTo(new Date());
        await concludeExport(
          worker,
          { clock: harness.clock, idGenerator: harness.idGenerator, storage },
          job!,
          { status: 'DONE', rowCount: 0 },
          1,
        );
      });
      expect((await rowOf(exportId))!.status).toBe('DONE');
      expect(await storage.uploadedBytes(key)).toBeGreaterThan(0);
      expect(await auditOf(exportId, 'analytics.export.abandoned')).toEqual([]);
    });

    it('un fichier manqué pendant plus de 30 jours est repris, le compte ne compte que les fichiers supprimés, une clé inconnue n’est jamais touchée (EX-2)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const done = freshUuid();
      await request(actor, done);
      await run(done);
      const key = exportStorageKey(done);
      const stranger = exportStorageKey(freshUuid());
      await storage.appendChunk('exports/pas-un-export.txt', 0, Buffer.from('x', 'utf8'));
      await storage.appendChunk(stranger, 0, Buffer.from('x', 'utf8'));
      expect(await storage.uploadedBytes(key)).toBeGreaterThan(0);

      // Cent jours plus tard : la fenêtre glissante d'avant aurait laissé ce fichier pour toujours.
      harness.clock.setTo(new Date(Date.now() + 100 * 86_400_000));
      const first = await purge();
      expect(first.exportFilesDeleted).toBeGreaterThanOrEqual(1);
      expect(await storage.uploadedBytes(key)).toBe(0);
      expect((await rowOf(done))!.status).toBe('EXPIRED');
      expect(await storage.uploadedBytes('exports/pas-un-export.txt')).toBe(1);
      expect(await storage.uploadedBytes(stranger)).toBe(1);
      // Rien ne reste à supprimer : le second passage ne compte aucun fichier.
      expect((await purge()).exportFilesDeleted).toBe(0);
    });

    it('le fichier d’un export FAILED est supprimé sans attendre la rétention (EX-2)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const exportId = freshUuid();
      await request(actor, exportId);
      const key = exportStorageKey(exportId);
      await storage.appendChunk(key, 0, Buffer.from('RESTE', 'utf8'));
      harness.clock.setTo(new Date(Date.now() + 60_000));
      // L'échec et la purge sont joués dans une transaction annulée : un export FAILED sans ligne d'audit de fin
      // violerait INV-ANA-01 pour tous les essais de la base partagée.
      await withTestUow(async (trx) => {
        await sql`UPDATE analytics_export_jobs SET status = 'FAILED', error_code = 'TEST', finished_at = NOW(6)
                   WHERE id = ${toBin(exportId)}`.execute(trx);
        const outcome = await runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        });
        expect(outcome.exportFilesDeleted).toBeGreaterThanOrEqual(1);
      });
      expect(await storage.uploadedBytes(key)).toBe(0);
    });

    it('le seuil d’abandon est un réglage : plus ancien que 24 h, un export reste en file sous un seuil plus long (EX-6)', async () => {
      const actor = await actorWith(admin, ['analytics.export', 'sales.sale.read']);
      const queued = freshUuid();
      await request(actor, queued);
      harness.clock.setTo(new Date(Date.now() + 3 * 86_400_000));
      await withTestUow(async (trx) => {
        await setting(trx, 'analytics.export_abandon_hours', 1000);
        await runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage,
        });
        expect(
          (
            await trx
              .selectFrom('analytics_export_jobs')
              .select('status')
              .where('id', '=', toBin(queued))
              .executeTakeFirst()
          )?.status,
        ).toBe('QUEUED');
      });
      // Sans le réglage, le seuil par défaut (24 h) s'applique : le même export est abandonné.
      await purge();
      expect(await rowOf(queued)).toMatchObject({
        status: 'FAILED',
        error_code: 'EXPORT_ABANDONED',
      });
    });

    /** Une ligne de journal vieille de 400 jours (insertion explicite : le déclencheur n'interdit que l'UPDATE). */
    const insertOldLogRow = async (): Promise<string> => {
      const user = await db.transaction().execute((trx) => insertTestUser(trx));
      const logId = freshUuid();
      await db
        .insertInto('analytics_query_log')
        .values({
          id: toBin(logId),
          user_id: toBin(user),
          dataset: 'f_sales_line',
          definition: JSON.stringify({ definition: {}, catalogVersion: 1 }),
          outcome: 'OK',
          created_at: new Date(Date.now() - 400 * 86_400_000),
        })
        .execute();
      return logId;
    };
    const logRowOf = (logId: string) =>
      db
        .selectFrom('analytics_query_log')
        .select('id')
        .where('id', '=', toBin(logId))
        .executeTakeFirst();

    it('une étape en échec n’annule pas les autres : le journal est purgé malgré un stockage qui ne répond pas (PF-5)', async () => {
      const logId = await insertOldLogRow();
      // L'horloge de l'essai est ramenée à l'instant réel (les essais voisins la déplacent) : aucune date future.
      harness.clock.setTo(new Date());
      const outcome = await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage: new UnlistableStorage(directory),
        }),
      );
      // La fonction ne lève pas ; seule l'étape des fichiers (qui liste le stockage) est en échec.
      expect(outcome.failedSteps.map((failure) => failure.step)).toEqual(['fichiers']);
      expect(outcome.failedSteps[0]!.message).toBe('stockage indisponible');
      expect(outcome.queryLogDeleted).toBeGreaterThanOrEqual(1);
      // Avant le correctif, l'échec annulait aussi la suppression du journal (une seule transaction).
      expect(await logRowOf(logId)).toBeUndefined();
    });

    it('l’étape d’abandon en échec : l’export reste en file, le journal est purgé, la reprise suivante l’abandonne (PF-5)', async () => {
      const logId = await insertOldLogRow();
      // Un export en file depuis trois jours, inséré avec sa date (elle est immuable : on ne peut pas la reculer
      // ensuite) et sa ligne d'audit de demande, que INV-ANA-01 exige de tout export de la base partagée.
      const exportId = freshUuid();
      const created = new Date(Date.now() - 3 * 86_400_000);
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('analytics_export_jobs')
          .values({
            id: toBin(exportId),
            requested_by: toBin(admin),
            dataset: 'f_sales_line',
            definition: JSON.stringify({}),
            format: 'CSV',
            catalog_version: 1,
            expires_at: new Date(created.getTime() + 86_400_000),
            created_at: created,
          })
          .execute();
        await recordAudit(
          trx,
          { clock: harness.clock, idGenerator: harness.idGenerator },
          {
            occurredAt: created,
            actorUserId: admin,
            actorRoles: [],
            action: 'analytics.export.request',
            entityType: 'ANALYTICS_EXPORT',
            entityId: exportId,
            after: { dataset: 'f_sales_line', format: 'CSV' },
            result: 'SUCCESS',
          },
        );
      });
      harness.clock.setTo(new Date());

      const outcome = await db.transaction().execute((trx) =>
        runAnalyticsPurge(trx, {
          clock: harness.clock,
          idGenerator: harness.idGenerator,
          storage: new UndeletableStorage(directory),
        }),
      );
      // Un export étranger de la base partagée peut échouer de même : l'essai ne compte pas les échecs.
      expect(outcome.failedSteps.map((failure) => failure.step)).toContain('abandon');
      expect(outcome.queryLogDeleted).toBeGreaterThanOrEqual(1);
      expect(await logRowOf(logId)).toBeUndefined();
      // L'abandon de l'export est annulé avec son audit (point de sauvegarde) : rien de partiel n'est validé.
      expect((await rowOf(exportId))!.status).toBe('QUEUED');
      expect(await auditOf(exportId, 'analytics.export.abandoned')).toEqual([]);

      // Stockage rétabli : la prochaine exécution reprend l'export.
      await purge();
      expect(await rowOf(exportId)).toMatchObject({
        status: 'FAILED',
        error_code: 'EXPORT_ABANDONED',
      });
      expect(await auditOf(exportId, 'analytics.export.abandoned')).toHaveLength(1);
    });
  });
});

/** Stockage dont le listage échoue : l'étape des fichiers de la purge est en échec, les autres n'y touchent pas. */
class UnlistableStorage extends LocalFsChunkStorage {
  override listKeys(): Promise<readonly string[]> {
    return Promise.reject(new Error('stockage indisponible'));
  }
}

/** Stockage dont la suppression échoue : l'abandon d'un export (qui supprime son fichier partiel) est en échec. */
class UndeletableStorage extends LocalFsChunkStorage {
  override delete(): Promise<void> {
    return Promise.reject(new Error('suppression impossible'));
  }
}

/** Stockage dont l'écriture échoue (message technique reconnaissable : il ne doit jamais atteindre le journal). */
class FailingAppendStorage extends LocalFsChunkStorage {
  override appendChunk(): Promise<number> {
    return Promise.reject(new Error('stockage en panne : /chemin/secret'));
  }
}

/** Stockage en lecture seule ou indisponible : écriture et suppression échouent (PF-6, repli du dernier essai). */
class BrokenStorage extends LocalFsChunkStorage {
  override appendChunk(): Promise<number> {
    return Promise.reject(new Error('stockage en panne : /chemin/secret'));
  }
  override delete(): Promise<void> {
    return Promise.reject(new Error('stockage en panne : suppression impossible'));
  }
}
