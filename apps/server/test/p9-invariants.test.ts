/**
 * P9-23 : invariants de la communication et de l'analyse balayés sur **toute la base** (même modèle que P5-22 et
 * P8-12) — INV-NOT-01 à 03 (alertes et notes), INV-ANA-01 à 03 (exports audités, vues par défaut, instantanés
 * personnels) —, puis l'ordre de verrouillage de la vue par défaut d'un rôle, rejoué en concurrence. Lecture seule pour
 * le balayage ; la base est partagée et persistante : chaque requête vaut à tout moment de la suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DASHBOARD_CODES } from '@gic/contracts';
import { ANALYTICS_CATALOG_VERSION } from '@gic/domain';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  AnalyticsCommandHarness,
  actorWith,
  salesDefinition,
  type CommandActor,
} from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

afterAll(closeTestDb);

/** Références fautives d'une requête qui sélectionne `ref` (au plus 20). */
async function offenders(query: ReturnType<typeof sql<{ ref: string }>>): Promise<string[]> {
  const { rows } = await query.execute(db);
  return rows.map((row) => row.ref);
}

const triggersOf = async (table: string): Promise<string[]> =>
  (
    await sql<{ name: string }>`
      SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ${table}`.execute(db)
  ).rows.map((row) => row.name);

describe('P9-23 : invariants des alertes et des notes (INV-NOT)', () => {
  it('INV-NOT-01 : au plus une alerte ouverte par type et objet', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT open_dedup_key AS ref FROM communication_alerts
         WHERE open_dedup_key IS NOT NULL GROUP BY open_dedup_key HAVING COUNT(*) > 1 LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-NOT-02 et 03 : les déclencheurs d’immuabilité des alertes et des notes existent', async () => {
    expect(await triggersOf('communication_alerts')).toEqual(
      expect.arrayContaining(['trg_communication_alerts_update_guard', 'trg_communication_alerts_purge_guard']),
    );
    expect(await triggersOf('communication_internal_notes')).toEqual(
      expect.arrayContaining([
        'trg_communication_internal_notes_update_guard',
        'trg_communication_internal_notes_no_delete',
      ]),
    );
    expect(await triggersOf('communication_note_audiences')).toEqual(
      expect.arrayContaining([
        'trg_communication_note_audiences_insert_guard',
        'trg_communication_note_audiences_update_guard',
        'trg_communication_note_audiences_delete_guard',
      ]),
    );
  });

  it('INV-NOT-02 : une alerte résolue ou écartée refuse toute modification ; une note publiée aussi', async () => {
    const resolved = await db
      .selectFrom('communication_alerts')
      .select('id')
      .where('status', 'in', ['RESOLVED', 'DISMISSED'])
      .limit(1)
      .executeTakeFirst();
    if (resolved !== undefined) {
      await expect(
        db
          .updateTable('communication_alerts')
          .set({ occurrences: sql`occurrences + 1` })
          .where('id', '=', resolved.id)
          .execute(),
      ).rejects.toThrow();
    }
    const published = await db
      .selectFrom('communication_internal_notes')
      .select('id')
      .where('status', '=', 'PUBLISHED')
      .limit(1)
      .executeTakeFirst();
    if (published !== undefined) {
      await expect(
        db
          .updateTable('communication_internal_notes')
          .set({ title: 'Titre modifié après publication' })
          .where('id', '=', published.id)
          .execute(),
      ).rejects.toThrow();
    }
  });
});

describe('P9-23 : invariants de l’analyse (INV-ANA)', () => {
  it('INV-ANA-01 : chaque export a sa ligne d’audit de demande, et chaque export terminé sa ligne de fin', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(e.id) AS ref FROM analytics_export_jobs e
         WHERE NOT EXISTS (SELECT 1 FROM audit_audit_log a
                            WHERE a.entity_id = e.id AND a.action = 'analytics.export.request')
         LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(e.id) AS ref FROM analytics_export_jobs e
         WHERE e.status IN ('DONE', 'FAILED', 'EXPIRED')
           AND NOT EXISTS (SELECT 1 FROM audit_audit_log a
                            WHERE a.entity_id = e.id
                              AND a.action IN ('analytics.export.completed', 'analytics.export.abandoned'))
         LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-ANA-01 : un export réussi a son fichier et son nombre de lignes, un échec son code ; aucune suppression, aucune modification après la fin', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(id) AS ref FROM analytics_export_jobs
         WHERE (status = 'DONE' AND (storage_key IS NULL OR row_count IS NULL))
            OR (status = 'FAILED' AND error_code IS NULL)
            OR (status IN ('QUEUED', 'RUNNING') <=> (finished_at IS NOT NULL))
         LIMIT 20`),
    ).toEqual([]);
    expect(await triggersOf('analytics_export_jobs')).toEqual(
      expect.arrayContaining(['trg_analytics_export_jobs_update_guard', 'trg_analytics_export_jobs_no_delete']),
    );
    const finished = await db
      .selectFrom('analytics_export_jobs')
      .select('id')
      .where('status', 'in', ['FAILED', 'EXPIRED'])
      .limit(1)
      .executeTakeFirst();
    if (finished !== undefined) {
      await expect(
        db
          .updateTable('analytics_export_jobs')
          .set({ error_code: 'MODIFIE' })
          .where('id', '=', finished.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        db.deleteFrom('analytics_export_jobs').where('id', '=', finished.id).execute(),
      ).rejects.toThrow();
    }
  });

  it('INV-ANA-02 : la vue par défaut d’un rôle est partagée avec ce rôle', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(id) AS ref FROM analytics_saved_views
         WHERE is_default_for_role IS NOT NULL
           AND NOT JSON_CONTAINS(shared_with_roles, JSON_QUOTE(is_default_for_role))
         LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-ANA-03 : tout instantané porte un tableau du catalogue, une période connue et un contenu objet ; un seul par (utilisateur, tableau, période)', async () => {
    const codes = DASHBOARD_CODES.map((code) => `'${code}'`).join(', ');
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT CONCAT(BIN_TO_UUID(user_id), ':', scope_key, ':', period_key) AS ref
          FROM analytics_kpi_snapshots
         WHERE scope_key NOT IN (${sql.raw(codes)})
            OR period_key NOT IN ('TODAY', 'WEEK', 'MONTH')
            OR JSON_TYPE(payload) <> 'OBJECT'
         LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT CONCAT(BIN_TO_UUID(user_id), ':', scope_key, ':', period_key) AS ref
          FROM analytics_kpi_snapshots GROUP BY user_id, scope_key, period_key HAVING COUNT(*) > 1 LIMIT 20`),
    ).toEqual([]);
  });
});

describe('P9-23 : ordre de verrouillage de la vue par défaut d’un rôle, en concurrence', () => {
  const harness = new AnalyticsCommandHarness();
  let ownerA: CommandActor & { roleCode: string };
  let ownerB: CommandActor & { roleCode: string };
  let shared: string;

  beforeAll(async () => {
    const admin = await db.transaction().execute((trx) => insertTestUser(trx));
    const permissions = ['analytics.explore', 'analytics.view.share', 'sales.sale.read'];
    ownerA = await actorWith(admin, permissions);
    ownerB = await actorWith(admin, permissions);
    shared = ownerA.roleCode;
  });

  it('deux propriétaires posent en même temps la vue par défaut du même rôle : les deux commandes sont appliquées, une seule vue reste par défaut', async () => {
    const viewA = freshUuid();
    const viewB = freshUuid();
    for (const [owner, viewId] of [
      [ownerA, viewA],
      [ownerB, viewB],
    ] as const) {
      const saved = await harness.run(owner, 'analytics.view.save', 'SAVED_VIEW', viewId, {
        name: `Concurrence ${viewId.slice(-10)}`,
        definition: salesDefinition(),
        catalogVersion: ANALYTICS_CATALOG_VERSION,
      });
      expect(saved.status).toBe('APPLIED');
      await harness.run(owner, 'analytics.view.share', 'SAVED_VIEW', viewId, { roles: [shared] });
    }
    const results = await Promise.all([
      harness.run(ownerA, 'analytics.view.set_default', 'SAVED_VIEW', viewA, { roleCode: shared }),
      harness.run(ownerB, 'analytics.view.set_default', 'SAVED_VIEW', viewB, { roleCode: shared }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['APPLIED', 'APPLIED']);
    const holders = await db
      .selectFrom('analytics_saved_views')
      .select('id')
      .where('is_default_for_role', '=', shared)
      .execute();
    expect(holders).toHaveLength(1);
    expect([toBin(viewA), toBin(viewB)].some((id) => id.equals(holders[0]!.id))).toBe(true);
  });
});
