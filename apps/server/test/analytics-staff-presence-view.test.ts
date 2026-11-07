/**
 * Vue d'analyse `analytics_f_staff_presence` (AV-514 (5), AV-532) : la présence du personnel relevée sur les fiches PT, une
 * ligne par personne et par jour, au site de la feuille. Jours de présence, jours d'absence (code M, C, R…) et durée
 * travaillée (jours relevés en heures, départ non antérieur à l'arrivée) ; une feuille annulée n'y figure plus. Ce jeu ne
 * recoupe pas `analytics_f_attendance` (sessions de travail du pointage numérique).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerPresenceCommands } from '../src/modules/fieldwork/application/commands/presence-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
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
} from './helpers.js';

const DAY = '2026-09-20';
const WEEK = '2026-09-14';
const NOW = `${DAY}T12:00:00.000Z`;
let deviceSeq = 0;

describe('analytics_f_staff_presence : présence du personnel des fiches PT', () => {
  let pipeline: CommandPipelineService;
  let manager: { readonly userId: string; readonly deviceId: string };
  let siteId: string;

  async function run(
    commandType: string,
    sheetId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'PRESENCE_SHEET',
        aggregate_id: sheetId,
        author_user_id: manager.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: manager.userId,
        authenticatedDeviceId: manager.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  /** Totaux de la vue pour le site de l'essai, sur la semaine. */
  async function totals() {
    const { rows } = await sql<{
      present: string | null;
      absent: string | null;
      minutes: string | null;
      lines: string;
    }>`
      SELECT SUM(present_count) AS present, SUM(absent_count) AS absent, SUM(worked_minutes) AS minutes,
             COUNT(*) AS \`lines\`
        FROM analytics_f_staff_presence
       WHERE site_id = ${toBin(siteId)} AND business_day BETWEEN ${WEEK} AND '2026-09-20'
    `.execute(db);
    const row = rows[0]!;
    return {
      present: Number(row.present ?? 0),
      absent: Number(row.absent ?? 0),
      minutes: Number(row.minutes ?? 0),
      lines: Number(row.lines),
    };
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    const idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerPresenceCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const managerId = await insertTestUser(trx);
      manager = { userId: managerId, deviceId: await insertTestDevice(trx, managerId) };
      const role = await insertTestRole(trx, adminId, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, role, 'fieldwork.presence.record', adminId, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, managerId, role, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('présence, absence et durée par personne et par jour ; la feuille annulée ne compte plus', async () => {
    expect(await totals()).toEqual({ present: 0, absent: 0, minutes: 0, lines: 0 });

    const sheetId = freshUuid();
    await run('fieldwork.presence.record', sheetId, `${DAY}T10:00:00.000Z`, {
      siteId,
      weekStart: WEEK,
      paperRef: 'PT-VIEW',
      lines: [
        {
          personName: 'Paul Essomba',
          personRole: 'Ouvrier',
          days: [
            { date: '2026-09-14', arrival: '07:00', departure: '16:00' },
            { date: '2026-09-15', absenceCode: 'M' },
          ],
        },
        {
          personName: 'Rose Atangana',
          personRole: 'Gardienne',
          days: [{ date: '2026-09-14', arrival: '18:00', departure: '23:30' }],
        },
      ],
    });
    // Trois jours de présence (9 h + 5 h 30 min = 870 min) et un jour d'absence.
    expect(await totals()).toEqual({ present: 2, absent: 1, minutes: 870, lines: 3 });

    const { rows } = await sql<{ day_status: string; role_label: string | null }>`
      SELECT day_status, role_label FROM analytics_f_staff_presence
       WHERE sheet_id = ${toBin(sheetId)} ORDER BY business_day, role_label
    `.execute(db);
    expect(rows).toEqual([
      { day_status: 'PRESENT', role_label: 'Gardienne' },
      { day_status: 'PRESENT', role_label: 'Ouvrier' },
      { day_status: 'ABSENT', role_label: 'Ouvrier' },
    ]);

    await run('fieldwork.presence.cancel', sheetId, `${DAY}T11:00:00.000Z`, {
      comment: 'Feuille reportée deux fois',
    });
    expect(await totals()).toEqual({ present: 0, absent: 0, minutes: 0, lines: 0 });
  });
});
