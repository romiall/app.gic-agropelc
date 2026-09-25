/**
 * `SyncPushService`/`SyncPullService` (P0-12 ; 06-offline-sync/02-synchronisation.md §3, §5,
 * §9) — au niveau service (comme `pipeline.integration.test.ts`), plus un aller-retour HTTP
 * unique pour prouver le câblage du contrôleur (`sync-http.e2e.test.ts`).
 *
 * Démontre les critères de sortie de la phase :
 * - AT-002 (lot renvoyé après perte de la réponse → un seul effet) : voir « rejeu ».
 * - AT-036 (horloge suspecte) : voir « écart d'horloge ».
 * - AT-050 (compatibilité N-1) : voir « versions N-1 ».
 * - NFR-19 (harnais, 100 coupures sans duplication) : voir « harnais ».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestPermission,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const DEMO_TYPE = 'test.sync_demo.record';
const DEMO_PERMISSION = 'test.sync_demo.record';
const OCCURRED_AT = '2026-09-24T09:00:00.000Z';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registry.register<{ note: string }>({
    commandType: DEMO_TYPE,
    version: 1,
    payloadSchema: z.object({ note: z.string().min(1).max(200) }),
    permissionCode: DEMO_PERMISSION,
    handler: async (uow, envelope) => {
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: `test.sync_demo.${envelope.command_id}`,
          value: JSON.stringify(envelope.payload.note),
          scope_type: 'GLOBAL',
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
      return { status: 'APPLIED' as const };
    },
  });
  // Version 2 du même command_type : démontre AT-050 (compatibilité N-1, un appareil non
  // mis à jour continue d'envoyer des commandes v1, un appareil à jour peut envoyer v2 —
  // les deux restent acceptées simultanément).
  registry.register<{ note: string; extra?: string }>({
    commandType: DEMO_TYPE,
    version: 2,
    payloadSchema: z.object({ note: z.string().min(1).max(200), extra: z.string().optional() }),
    permissionCode: DEMO_PERMISSION,
    handler: async (uow, envelope) => {
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: `test.sync_demo.${envelope.command_id}`,
          value: JSON.stringify({
            note: envelope.payload.note,
            extra: envelope.payload.extra ?? null,
          }),
          scope_type: 'GLOBAL',
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
      return { status: 'APPLIED' as const };
    },
  });
  return registry;
}

function buildRawCommand(overrides: {
  readonly command_id: string;
  readonly device_seq: number;
  readonly author_user_id: string;
  readonly occurred_at?: string;
  readonly command_version?: number;
  readonly payload: unknown;
}): Record<string, unknown> {
  return {
    command_id: overrides.command_id,
    device_seq: overrides.device_seq,
    command_type: DEMO_TYPE,
    command_version: overrides.command_version ?? 1,
    author_user_id: overrides.author_user_id,
    aggregate_type: 'TEST_SETTING',
    aggregate_id: freshUuid(),
    base_version: null,
    depends_on: [],
    occurred_at: overrides.occurred_at ?? OCCURRED_AT,
    client_created_at: overrides.occurred_at ?? OCCURRED_AT,
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: overrides.payload,
  };
}

async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(enrolledBy: string): Promise<string> {
  return db.transaction().execute((trx) => insertTestDevice(trx, enrolledBy, { status: 'ACTIVE' }));
}

describe('SyncPushService / SyncPullService (P0-12)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pushService: SyncPushService;
  let pullService: SyncPullService;
  let author: string;
  let device: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-24T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);
    pushService = new SyncPushService(pipeline, db, clock);
    pullService = new SyncPullService(db);

    author = await createRealUser();
    device = await createRealDevice(author);

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, DEMO_PERMISSION);
      const role = await insertTestRole(trx, author);
      await grantTestPermission(trx, role, DEMO_PERMISSION, author);
      await assignTestRole(trx, author, role, author);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('lot ordonné : plusieurs commandes, results[] dans l’ordre de device_seq malgré un envoi désordonné', async () => {
    const c1 = freshUuid();
    const c2 = freshUuid();
    const response = await pushService.push(
      {
        device_id: device,
        batch_id: freshUuid(),
        device_sent_at: OCCURRED_AT,
        // Envoyées dans le désordre : le service doit les traiter par device_seq croissant.
        commands: [
          buildRawCommand({
            command_id: c2,
            device_seq: 2,
            author_user_id: author,
            payload: { note: 'deux' },
          }),
          buildRawCommand({
            command_id: c1,
            device_seq: 1,
            author_user_id: author,
            payload: { note: 'un' },
          }),
        ],
      },
      { authenticatedUserId: author, authenticatedDeviceId: device },
    );
    expect(response.results.map((r) => r.command_id)).toEqual([c1, c2]);
    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(typeof response.clock_skew_ms).toBe('number');
  });

  it('AT-002 : lot renvoyé après perte de la réponse → un seul effet, résultats identiques', async () => {
    const commandId = freshUuid();
    const request = {
      device_id: device,
      batch_id: freshUuid(),
      device_sent_at: OCCURRED_AT,
      commands: [
        buildRawCommand({
          command_id: commandId,
          device_seq: 100,
          author_user_id: author,
          payload: { note: 'sans perte' },
        }),
      ],
    };
    const first = await pushService.push(request, {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
    });
    // « Réponse perdue » : l'appareil, sans accusé de réception, renvoie EXACTEMENT le même lot.
    const second = await pushService.push(request, {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
    });
    expect(second.results).toEqual(first.results);

    const rows = await db
      .selectFrom('organization_system_settings')
      .select('id')
      .where('key', '=', `test.sync_demo.${commandId}`)
      .execute();
    expect(rows).toHaveLength(1); // un seul effet malgré les deux envois
  });

  it('AT-036 : écart d’horloge > 5 min → CLOCK_SUSPECT sur chaque résultat, occurred_at non corrigé', async () => {
    const commandId = freshUuid();
    const deviceSentAt = '2026-09-24T15:30:00.000Z'; // 2h30 après l'horloge fixe du serveur (13:00)
    const response = await pushService.push(
      {
        device_id: device,
        batch_id: freshUuid(),
        device_sent_at: deviceSentAt,
        commands: [
          buildRawCommand({
            command_id: commandId,
            device_seq: 200,
            author_user_id: author,
            payload: { note: 'horloge' },
          }),
        ],
      },
      { authenticatedUserId: author, authenticatedDeviceId: device },
    );
    expect(Math.abs(response.clock_skew_ms)).toBeGreaterThan(5 * 60 * 1000);
    expect(response.results[0]!.warnings).toContain('CLOCK_SUSPECT');

    // occurred_at (2026-09-24T09:00, dans buildRawCommand) n'est jamais corrigé (ADR-016) :
    // l'entrée d'audit — pas l'inbox — le porte tel quel. Vérifié via sync_command_inbox.
    const row = await db
      .selectFrom('sync_command_inbox')
      .select(['occurred_at', 'clock_skew_ms'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(row.occurred_at.toISOString()).toBe(OCCURRED_AT);
    expect(row.clock_skew_ms).not.toBeNull();
  });

  it('AT-050 : versions N-1 — v1 et v2 du même command_type restent acceptées', async () => {
    const v1CommandId = freshUuid();
    const v2CommandId = freshUuid();
    const response = await pushService.push(
      {
        device_id: device,
        batch_id: freshUuid(),
        device_sent_at: OCCURRED_AT,
        commands: [
          buildRawCommand({
            command_id: v1CommandId,
            device_seq: 300,
            author_user_id: author,
            command_version: 1,
            payload: { note: 'ancienne version' },
          }),
          buildRawCommand({
            command_id: v2CommandId,
            device_seq: 301,
            author_user_id: author,
            command_version: 2,
            payload: { note: 'nouvelle version', extra: 'champ ajouté' },
          }),
        ],
      },
      { authenticatedUserId: author, authenticatedDeviceId: device },
    );
    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);
  });

  describe('pull', () => {
    it('filtre par périmètre : GLOBAL toujours visible, SITE seulement pour un appareil dont l’utilisateur y est affecté', async () => {
      const outsider = await createRealUser();
      const outsiderDevice = await createRealDevice(outsider);
      const insider = await createRealUser();
      const insiderDevice = await createRealDevice(insider);

      const siteId = freshUuid();

      // Zone + site réels (nécessaires pour la FK de la ligne change_feed synthétique et de
      // l'affectation de rôle) : construits comme les autres fixtures « réelles » de cette
      // suite (durables, hors transaction annulée).
      const zoneId = await db.transaction().execute(async (trx) => {
        const id = freshUuid();
        await trx
          .insertInto('organization_zones')
          .values({
            id: toBin(id),
            level: 'SECTEUR',
            code: `Z-${id.slice(-8)}`,
            name: 'Zone test pull',
            depth: 1,
            created_by: toBin(insider),
          })
          .execute();
        return id;
      });
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('organization_sites')
          .values({
            id: toBin(siteId),
            code: siteId.slice(-8).toUpperCase(),
            name: 'Site test pull',
            site_type: 'MAGASIN',
            zone_id: toBin(zoneId),
            created_by: toBin(insider),
          })
          .execute();

        const role = await insertTestRole(trx, insider, { allowedScopeTypes: ['SITE'] });
        await assignTestRole(trx, insider, role, insider, {
          scopeType: 'SITE',
          scopeSiteId: siteId,
        });

        // Lignes change_feed synthétiques (aucun gestionnaire réel n'écrit encore de portée
        // non-GLOBAL) : une GLOBAL, une SITE ciblant `siteId`.
        await trx
          .insertInto('sync_change_feed')
          .values({
            dataset: 'test_pull',
            entity_type: 'ZONE',
            entity_id: toBin(zoneId),
            change_type: 'UPSERT',
            scope_type: 'GLOBAL',
            scope_id: null,
            row_version: 1,
          })
          .execute();
        await trx
          .insertInto('sync_change_feed')
          .values({
            dataset: 'test_pull',
            entity_type: 'SITE',
            entity_id: toBin(siteId),
            change_type: 'UPSERT',
            scope_type: 'SITE',
            scope_id: toBin(siteId),
            row_version: 1,
          })
          .execute();
      });

      const insiderResult = await pullService.pull(
        { dataset: 'test_pull', cursor: 0, limit: 500 },
        {
          authenticatedUserId: insider,
          authenticatedDeviceId: insiderDevice,
          now: new Date('2026-09-24T13:00:00.000Z'),
        },
      );
      const outsiderResult = await pullService.pull(
        { dataset: 'test_pull', cursor: 0, limit: 500 },
        {
          authenticatedUserId: outsider,
          authenticatedDeviceId: outsiderDevice,
          now: new Date('2026-09-24T13:00:00.000Z'),
        },
      );

      const insiderEntityIds = insiderResult.changes.map((c) => c.entity_id);
      const outsiderEntityIds = outsiderResult.changes.map((c) => c.entity_id);
      expect(insiderEntityIds).toContain(zoneId); // GLOBAL : visible par tous
      expect(insiderEntityIds).toContain(siteId); // SITE : visible, insider y est affecté
      expect(outsiderEntityIds).toContain(zoneId); // GLOBAL : visible par tous
      expect(outsiderEntityIds).not.toContain(siteId); // SITE : absent, outsider n'y est pas affecté

      const siteChange = insiderResult.changes.find((c) => c.entity_id === siteId);
      expect(siteChange?.data).toMatchObject({ id: siteId, site_type: 'MAGASIN' });
    });

    it('pagination : limit et next_cursor/has_more, curseur strictement croissant', async () => {
      // `dataset` est VARCHAR(40) : un suffixe court (pas l'UUID complet) suffit à
      // distinguer ce jeu de données des autres tests de cette suite.
      const datasetName = `test_pagination_${freshUuid().slice(-8)}`;
      await db.transaction().execute(async (trx) => {
        for (let i = 0; i < 5; i++) {
          await trx
            .insertInto('sync_change_feed')
            .values({
              dataset: datasetName,
              entity_type: 'ZONE',
              entity_id: toBin(freshUuid()),
              change_type: 'DELETE', // aucune projection requise, teste seulement la pagination
              scope_type: 'GLOBAL',
              scope_id: null,
              row_version: 1,
            })
            .execute();
        }
      });

      const page1 = await pullService.pull(
        { dataset: datasetName, cursor: 0, limit: 2 },
        { authenticatedUserId: author, authenticatedDeviceId: device, now: new Date() },
      );
      expect(page1.changes).toHaveLength(2);
      expect(page1.has_more).toBe(true);

      const page2 = await pullService.pull(
        { dataset: datasetName, cursor: page1.next_cursor, limit: 2 },
        { authenticatedUserId: author, authenticatedDeviceId: device, now: new Date() },
      );
      expect(page2.changes).toHaveLength(2);
      expect(page2.next_cursor).toBeGreaterThan(page1.next_cursor);

      const page3 = await pullService.pull(
        { dataset: datasetName, cursor: page2.next_cursor, limit: 2 },
        { authenticatedUserId: author, authenticatedDeviceId: device, now: new Date() },
      );
      expect(page3.changes).toHaveLength(1);
      expect(page3.has_more).toBe(false);
    });
  });

  describe('harnais NFR-19', () => {
    it('100 coupures simulées (réponse perdue, renvoi du même lot) : aucune duplication', async () => {
      const commandId = freshUuid();
      const request = {
        device_id: device,
        batch_id: freshUuid(),
        device_sent_at: OCCURRED_AT,
        commands: [
          buildRawCommand({
            command_id: commandId,
            device_seq: 900,
            author_user_id: author,
            payload: { note: 'harnais 100 coupures' },
          }),
        ],
      };

      let lastResponse;
      for (let cut = 0; cut < 100; cut++) {
        // Chaque itération simule : la commande est appliquée côté serveur, mais la
        // connexion est coupée avant que l'appareil ne reçoive la réponse — il renvoie donc
        // le lot identique au tour suivant, exactement comme un vrai appareil hors ligne le
        // ferait (§4, reprise et attente progressive).
        lastResponse = await pushService.push(request, {
          authenticatedUserId: author,
          authenticatedDeviceId: device,
        });
      }
      expect(lastResponse!.results[0]!.status).toBe('APPLIED');

      const rows = await db
        .selectFrom('organization_system_settings')
        .select('id')
        .where('key', '=', `test.sync_demo.${commandId}`)
        .execute();
      expect(rows).toHaveLength(1);

      const inboxRow = await db
        .selectFrom('sync_command_inbox')
        .select('attempts')
        .where('command_id', '=', toBin(commandId))
        .executeTakeFirstOrThrow();
      // `attempts` (dictionnaire : « tentatives d'application serveur ») reste à sa valeur
      // d'application unique : les 99 rejeux suivants sont des lectures du résultat déjà
      // enregistré (étape 1 du pipeline), jamais une nouvelle tentative d'application.
      expect(inboxRow.attempts).toBe(1);
    });
  });
});
