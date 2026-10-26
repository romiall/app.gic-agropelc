/**
 * P9-20 et P9-22 — exports audités (ADR-077 §3 à §8 ; BR-ANA-008 ; AV-433, AV-434, AV-497 ; AT-046) : la commande
 * `analytics.export.request` par le vrai pipeline, la tâche de calcul `runExport` sur un stockage local temporaire
 * (CSV et XLSX relus, droit retiré entre la demande et le calcul : `FAILED` sans levée, rejeu sans fichier partiel,
 * tâche déjà terminée sans second effet), puis la purge quotidienne. Acteurs à rôle d'essai sur la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYTICS_CATALOG_VERSION } from '@gic/domain';
import { LocalFsChunkStorage } from '../src/platform/storage/local-fs-chunk-storage.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { invalidateUser } from '../src/modules/identity/application/rbac/rbac-cache.js';
import { runExport } from '../src/modules/analytics/application/exports/run-export.js';
import { exportStorageKey } from '../src/modules/analytics/application/exports/export-store.js';
import { runAnalyticsPurge } from '../src/modules/analytics/application/maintenance/purge.js';
import {
  AnalyticsCommandHarness,
  TODAY,
  actorWith,
  salesDefinition,
  type CommandActor,
} from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

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
      let outcome = await db
        .transaction()
        .execute((trx) =>
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
      outcome = await db
        .transaction()
        .execute((trx) =>
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
      await db
        .transaction()
        .execute((trx) =>
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
      await db
        .transaction()
        .execute((trx) =>
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
  });
});
