/**
 * Jeux `presence` et `weekly_reports` de `/sync/pull` (AV-514 (4), AV-532) : l'historique se relit sans réseau.
 * - `presence` : une feuille de présence du personnel est une ligne `SITE` ; elle ne va qu'aux appareils dont l'utilisateur
 *   lit la présence **sur ce site** (`fieldwork.presence.read`, `sync/device-scope.ts`) — ni l'autre ferme, ni le
 *   magasinier du même site ; son annulation réémet la ligne (version suivante, statut `CANCELLED`) ;
 * - `weekly_reports` : un bilan hebdomadaire est une ligne `USER` : son auteur le reçoit, jamais un autre commercial ; une
 *   correction réémet la ligne à la version suivante.
 * Données écrites par le vrai pipeline, téléchargement par le vrai `SyncPullService`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerPresenceCommands } from '../src/modules/fieldwork/application/commands/presence-commands.js';
import { registerWeeklyReportCommands } from '../src/modules/crm/application/commands/weekly-report-commands.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
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
const NOW = new Date(`${DAY}T12:00:00.000Z`);
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('jeux presence et weekly_reports de /sync/pull (AV-514 (4))', () => {
  let clock: FixedClock;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let siteA: string;
  let siteB: string;
  let managerA: Actor;
  let managerB: Actor;
  let storekeeperA: Actor;
  let writer1: Actor;
  let writer2: Actor;
  let reviewer: Actor;

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
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
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function pull(actor: Actor, dataset: string): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 2000 },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        now: clock.now(),
      },
    );
    return response.changes;
  }

  /** Dernier état reçu pour une entité (l'appareil applique les changements dans l'ordre). */
  const latest = (changes: readonly Change[], entityType: string, entityId: string) =>
    changes.filter((c) => c.entity_type === entityType && c.entity_id === entityId).at(-1);

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    const idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerPresenceCommands(registry, idGenerator);
    registerWeeklyReportCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);

    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      siteB = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const actor = async (): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        return { userId, deviceId: await insertTestDevice(trx, userId, { status: 'ACTIVE' }) };
      };
      // Responsable de ferme : enregistre et lit la présence sur son site.
      const farmRole = await insertTestRole(trx, adminId, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, farmRole, 'fieldwork.presence.record', adminId, {
        maxScope: 'SITE',
      });
      await grantTestPermission(trx, farmRole, 'fieldwork.presence.read', adminId, {
        maxScope: 'SITE',
      });
      // Magasinier : sur le même site, sans droit de présence.
      const storeRole = await insertTestRole(trx, adminId, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, storeRole, 'inventory.stock.read', adminId, {
        maxScope: 'SITE',
      });
      managerA = await actor();
      managerB = await actor();
      storekeeperA = await actor();
      await assignTestRole(trx, managerA.userId, farmRole, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      await assignTestRole(trx, managerB.userId, farmRole, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteB,
      });
      await assignTestRole(trx, storekeeperA.userId, storeRole, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteA,
      });
      // Deux commerciaux rédacteurs de bilan.
      const writerRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, writerRole, 'crm.weekly_report.submit', adminId);
      writer1 = await actor();
      writer2 = await actor();
      await assignTestRole(trx, writer1.userId, writerRole, adminId);
      await assignTestRole(trx, writer2.userId, writerRole, adminId);
      // Un responsable qui marque les bilans « vus » (portée globale).
      const reviewerRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, reviewerRole, 'crm.weekly_report.review', adminId, {
        maxScope: 'ALL',
      });
      reviewer = await actor();
      await assignTestRole(trx, reviewer.userId, reviewerRole, adminId);
    });
    const maxSeq = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(maxSeq?.seq ?? 0);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('presence : la feuille va aux appareils qui lisent la présence de son site, et son annulation est réémise', async () => {
    const sheetId = freshUuid();
    await run(
      managerA,
      'fieldwork.presence.record',
      'PRESENCE_SHEET',
      sheetId,
      `${DAY}T10:00:00.000Z`,
      {
        siteId: siteA,
        weekStart: WEEK,
        paperRef: '000042',
        responsibleName: 'Joseph Ngo Bayiha',
        lines: [
          {
            personName: 'Paul Essomba',
            personRole: 'Ouvrier',
            days: [
              { date: '2026-09-14', arrival: '07:00', departure: '16:00' },
              { date: '2026-09-15', absenceCode: 'M' },
            ],
          },
        ],
      },
    );
    const received = await pull(managerA, 'presence');
    const sheet = latest(received, 'PRESENCE_SHEET', sheetId);
    expect(sheet?.change_type).toBe('UPSERT');
    expect(sheet?.scope_type).toBe('SITE');
    expect(sheet?.scope_id).toBe(siteA);
    expect(sheet?.data).toMatchObject({
      id: sheetId,
      siteId: siteA,
      weekStart: WEEK,
      paperRef: '000042',
      status: 'RECORDED',
      lines: [
        {
          lineNo: 1,
          personName: 'Paul Essomba',
          personRole: 'Ouvrier',
          days: [
            { date: '2026-09-14', arrival: '07:00', departure: '16:00', absenceCode: null },
            { date: '2026-09-15', arrival: null, departure: null, absenceCode: 'M' },
          ],
        },
      ],
    });
    // Ni l'autre ferme, ni le magasinier du même site (sans droit de présence).
    expect(latest(await pull(managerB, 'presence'), 'PRESENCE_SHEET', sheetId)).toBeUndefined();
    expect(latest(await pull(storekeeperA, 'presence'), 'PRESENCE_SHEET', sheetId)).toBeUndefined();

    await run(
      managerA,
      'fieldwork.presence.cancel',
      'PRESENCE_SHEET',
      sheetId,
      `${DAY}T11:00:00.000Z`,
      { comment: 'Feuille reportée deux fois' },
    );
    const afterCancel = latest(await pull(managerA, 'presence'), 'PRESENCE_SHEET', sheetId);
    expect(afterCancel?.data).toMatchObject({
      status: 'CANCELLED',
      cancelComment: 'Feuille reportée deux fois',
    });
    expect(afterCancel!.row_version).toBeGreaterThan(sheet!.row_version);
  });

  it('weekly_reports : le bilan va à son auteur seulement, et une correction est réémise à la version suivante', async () => {
    const reportId = freshUuid();
    const otherId = freshUuid();
    await run(
      writer1,
      'crm.weekly_report.submit',
      'WEEKLY_REPORT',
      reportId,
      `${DAY}T10:00:00.000Z`,
      {
        weekStart: WEEK,
        successes: 'Trois nouveaux clients',
      },
    );
    await run(
      writer2,
      'crm.weekly_report.submit',
      'WEEKLY_REPORT',
      otherId,
      `${DAY}T10:30:00.000Z`,
      {
        weekStart: WEEK,
        difficulties: 'Route coupée',
      },
    );
    const mine = await pull(writer1, 'weekly_reports');
    const first = latest(mine, 'WEEKLY_REPORT', reportId);
    expect(first?.scope_type).toBe('USER');
    expect(first?.data).toMatchObject({
      id: reportId,
      userId: writer1.userId,
      weekStart: WEEK,
      successes: 'Trois nouveaux clients',
      status: 'SUBMITTED',
    });
    // Le bilan d'un autre commercial n'est jamais servi.
    expect(latest(mine, 'WEEKLY_REPORT', otherId)).toBeUndefined();
    expect(
      latest(await pull(writer2, 'weekly_reports'), 'WEEKLY_REPORT', reportId),
    ).toBeUndefined();

    // Correction (texte plus récent) : réémise à la version suivante.
    await run(
      writer1,
      'crm.weekly_report.submit',
      'WEEKLY_REPORT',
      reportId,
      `${DAY}T11:00:00.000Z`,
      {
        weekStart: WEEK,
        successes: 'Quatre nouveaux clients',
      },
    );
    const corrected = latest(await pull(writer1, 'weekly_reports'), 'WEEKLY_REPORT', reportId);
    expect(corrected?.data).toMatchObject({ successes: 'Quatre nouveaux clients' });
    expect(corrected!.row_version).toBeGreaterThan(first!.row_version);
  });

  it('weekly_reports : le « vu » du responsable réémet la ligne de l’auteur (statut, commentaire, version suivante)', async () => {
    const reportId = freshUuid();
    await run(
      writer1,
      'crm.weekly_report.submit',
      'WEEKLY_REPORT',
      reportId,
      `${DAY}T11:10:00.000Z`,
      // Une autre semaine que les essais précédents : un seul bilan par commercial et par semaine.
      { weekStart: '2026-09-07', successes: 'Cinq nouveaux clients' },
    );
    const before = latest(await pull(writer1, 'weekly_reports'), 'WEEKLY_REPORT', reportId)!;
    expect(before.data).toMatchObject({ status: 'SUBMITTED', managerComment: null });

    await run(
      reviewer,
      'crm.weekly_report.review',
      'WEEKLY_REPORT',
      reportId,
      `${DAY}T11:40:00.000Z`,
      { comment: 'Bien, à suivre' },
    );
    const after = latest(await pull(writer1, 'weekly_reports'), 'WEEKLY_REPORT', reportId)!;
    expect(after.data).toMatchObject({ status: 'REVIEWED', managerComment: 'Bien, à suivre' });
    expect(after.row_version).toBeGreaterThan(before.row_version);
    // La ligne reste celle de l'auteur : le responsable ne reçoit pas le bilan par ce jeu (il le lit en ligne).
    expect(
      latest(await pull(reviewer, 'weekly_reports'), 'WEEKLY_REPORT', reportId),
    ).toBeUndefined();
  });
});
