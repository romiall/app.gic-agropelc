/**
 * Présence du personnel (PP-E ; AV-314, AV-514 (7), AV-532) : une personne dont la ligne ne désigne aucun compte est
 * rattachée au compte **actif** de même nom complet, s'il est **unique**. Un nom que portent deux comptes, un compte
 * suspendu et une ligne qui dit « aucun compte » (`userId: null`) ne désignent personne ; un compte nommé par la charge
 * est gardé tel quel. Le rejeu de la même feuille (sans compte désigné) reste reconnu, il n'est pas refusé comme « autre
 * feuille » parce que le serveur y a rattaché un compte.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerPresenceCommands } from '../src/modules/fieldwork/application/commands/presence-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

describe('AV-514 (7) : rattachement d’une personne de la feuille à son compte', () => {
  let pipeline: CommandPipelineService;
  let manager: { readonly userId: string; readonly deviceId: string };
  let siteId: string;
  const tag = freshUuid().slice(-6).toUpperCase();
  const name = (first: string, last: string) => `${first} ${last} ${tag}`;
  const accounts: Record<string, string> = {};

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function record(sheetId: string, payload: unknown): Promise<Result> {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'fieldwork.presence.record',
        aggregate_type: 'PRESENCE_SHEET',
        aggregate_id: sheetId,
        author_user_id: manager.userId,
        base_version: null,
        depends_on: [],
        occurred_at: `${DAY}T10:00:00.000Z`,
        client_created_at: `${DAY}T10:00:00.000Z`,
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
      await grantTestPermission(trx, role, 'fieldwork.presence.record', adminId);
      await assignTestRole(trx, managerId, role, adminId, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      const named = async (key: string, fullName: string, status?: 'SUSPENDED') => {
        const id = await insertTestUser(
          trx,
          status ? { status, statusChangedAt: new Date(NOW) } : {},
        );
        await trx
          .updateTable('identity_users')
          .set({ full_name: fullName })
          .where('id', '=', toBin(id))
          .execute();
        accounts[key] = id;
      };
      await named('rose', name('Rose', 'Atangana'));
      // Compte au nom accentué : la fiche papier peut l'écrire sans accents.
      await named('elise', name('Élise', 'Ngô'));
      // Deux homonymes : aucun n'est désigné.
      await named('paul1', name('Paul', 'Mbarga'));
      await named('paul2', name('Paul', 'Mbarga'));
      // Compte suspendu : ne se rattache pas.
      await named('alice', name('Alice', 'Nkoa'), 'SUSPENDED');
      await named('marie', name('Marie', 'Eyenga'));
      await named('jean', name('Jean', 'Fouda'));
      await named('other', name('Autre', 'Compte'));
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const day = { date: '2026-09-14', arrival: '07:00', departure: '16:00' };
  const payload = (lines: readonly Record<string, unknown>[]) => ({
    siteId,
    weekStart: WEEK,
    paperRef: `PT-${tag}`,
    responsibleName: 'Joseph Ngo Bayiha',
    lines: lines.map((line) => ({ days: [day], ...line })),
  });

  it('nom exact et unique d’un compte actif : rattaché ; homonymes, compte suspendu, « aucun compte » : non ; compte nommé : gardé', async () => {
    const sheetId = freshUuid();
    const lines = [
      // La casse et les accents ne comptent pas (`personNameKey`).
      { personName: name('ROSE', 'atangana') },
      { personName: name('elise', 'ngo') },
      { personName: name('Paul', 'Mbarga') },
      { personName: name('Alice', 'Nkoa') },
      { personName: name('Marie', 'Eyenga'), userId: null },
      { personName: name('Jean', 'Fouda'), userId: accounts['other']! },
      { personName: `Inconnu ${tag}` },
    ];
    const result = await record(sheetId, payload(lines));
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const rows = await db
      .selectFrom('fieldwork_staff_presence')
      .select(['line_no', 'user_id'])
      .where('sheet_id', '=', toBin(sheetId))
      .orderBy('line_no')
      .execute();
    expect(rows.map((row) => (row.user_id ? fromBin(row.user_id) : null))).toEqual([
      accounts['rose']!,
      accounts['elise']!,
      null,
      null,
      null,
      accounts['other']!,
      null,
    ]);

    // Le rejeu de la même feuille (sans compte désigné) est reconnu : aucune ligne de plus, pas de « autre feuille ».
    const replay = await record(sheetId, payload(lines));
    expect(code(replay), JSON.stringify(replay)).toBe('APPLIED');
    const count = await db
      .selectFrom('fieldwork_staff_presence')
      .select('id')
      .where('sheet_id', '=', toBin(sheetId))
      .execute();
    expect(count).toHaveLength(lines.length);

    // Un autre contenu sous le même identifiant reste refusé.
    const other = await record(
      sheetId,
      payload([{ personName: name('ROSE', 'atangana') }, ...lines.slice(2)]),
    );
    expect(code(other)).toBe('PRESENCE_ID_TAKEN');
  });
});
