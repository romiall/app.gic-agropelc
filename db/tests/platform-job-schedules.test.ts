// Garde en base de l'ordonnanceur des tâches récurrentes (P5-16 ; migration 20261010093100 ;
// dictionnaire platform.job_schedules) : une ligne par type de tâche, deux formes de récurrence
// cohérentes (intervalle strictement positif, ou heure locale HH:MM valide). Les droits du compte
// applicatif (UPDATE de `next_run_at`) sont prouvés côté serveur (job-scheduler.test.ts), ces tests
// se connectant avec le compte des migrations.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { withRollback } from './helpers.js';

const NEXT = '2026-10-09 10:00:00.000000';

async function insertSchedule(
  conn: PoolConnection,
  jobType: string,
  kind: string,
  intervalSeconds: number | null,
  localTime: string | null,
): Promise<void> {
  await conn.query(
    `INSERT INTO platform_job_schedules (job_type, schedule_kind, interval_seconds, local_time, next_run_at)
     VALUES (?, ?, ?, ?, ?)`,
    [jobType, kind, intervalSeconds, localTime, NEXT],
  );
}

const jobType = () => `test.schedule.${Math.floor(Math.random() * 1_000_000_000)}`;

describe('platform_job_schedules (P5-16)', () => {
  it('une ligne par type de tâche (clé primaire)', async () => {
    await withRollback(async (conn) => {
      const type = jobType();
      await insertSchedule(conn, type, 'INTERVAL', 3600, null);
      await expect(insertSchedule(conn, type, 'INTERVAL', 60, null)).rejects.toThrow(
        /Duplicate entry/,
      );
    });
  });

  it('intervalle strictement positif, sans heure locale', async () => {
    await withRollback(async (conn) => {
      for (const seconds of [0, -60]) {
        await expect(insertSchedule(conn, jobType(), 'INTERVAL', seconds, null)).rejects.toThrow(
          /ck_platform_job_schedules_kind/,
        );
      }
      await expect(insertSchedule(conn, jobType(), 'INTERVAL', 3600, '02:00')).rejects.toThrow(
        /ck_platform_job_schedules_kind/,
      );
    });
  });

  it('heure locale quotidienne au format HH:MM, sans intervalle', async () => {
    await withRollback(async (conn) => {
      await insertSchedule(conn, jobType(), 'DAILY', null, '02:00');
      await insertSchedule(conn, jobType(), 'DAILY', null, '23:59');
      for (const bad of ['24:00', '7:30', '12:60', null]) {
        await expect(insertSchedule(conn, jobType(), 'DAILY', null, bad)).rejects.toThrow(
          /ck_platform_job_schedules_kind/,
        );
      }
      await expect(insertSchedule(conn, jobType(), 'DAILY', 60, '02:00')).rejects.toThrow(
        /ck_platform_job_schedules_kind/,
      );
      await expect(insertSchedule(conn, jobType(), 'WEEKLY', null, null)).rejects.toThrow(
        /ck_platform_job_schedules_kind/,
      );
    });
  });

  it('le créneau suivant s’avance par mise à jour', async () => {
    await withRollback(async (conn) => {
      const type = jobType();
      await insertSchedule(conn, type, 'INTERVAL', 3600, null);
      await conn.query(
        `UPDATE platform_job_schedules SET next_run_at = '2026-10-09 11:00:00.000000' WHERE job_type = ?`,
        [type],
      );
      const [rows] = await conn.query(
        'SELECT next_run_at FROM platform_job_schedules WHERE job_type = ?',
        [type],
      );
      expect((rows as Array<{ next_run_at: Date }>).length).toBe(1);
    });
  });
});
