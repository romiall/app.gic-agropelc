/**
 * P5-07 — tablette partagée côté serveur (AV-007, BR-SYN-014) et harnais multi-appareils.
 *
 * Plusieurs utilisateurs se relaient sur une même tablette : un seul compteur `device_seq`, une seule
 * file, mais chaque auteur pousse sa part avec sa propre session. Démontre, contre les vrais services
 * de synchronisation et le vrai pipeline :
 * - `last_device_seq` est le **maximum** reçu, pas le dernier d'un lot (les lots de deux auteurs
 *   s'entrecroisent dans la suite des `device_seq`) ;
 * - INV-SYN-04 reformulé : l'ordre garanti est celui de chaque couple (appareil, auteur) ;
 * - l'appareil déclare ce qu'il lui reste à envoyer, par auteur (`pending_by_author`), et la règle
 *   BR-DIS-014 (changement d'appareil désigné d'un PDV) s'appuie dessus de bout en bout ;
 * - un auteur ne peut pas pousser la commande d'un autre (sécurité), sans gêner ses propres commandes
 *   du même lot (INV-SYN-05) ;
 * - coupure réseau, perte de réponse (rejeu sans nouvelle application) et révocation de l'appareil en
 *   cours de journée (RC-02 : avant la révocation, appliqué ; après, quarantaine).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService, authorDataset } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { registerDeviceCommands } from '../src/modules/identity/application/commands/device-commands.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { NetworkDownError, OfflineDevice, type CommandSpec } from './device-harness.js';
import { SETTING_DATASET, SETTING_PERMISSION } from './sync-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-08';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('tablette partagée et harnais multi-appareils (P5-07, AV-007, BR-SYN-014)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let userA: string;
  let userB: string;
  let admin: string;
  let adminDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(`${DAY}T13:00:00.000Z`));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerSettingCommands(registry);
    registerDeviceCommands(registry);
    registerPosCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      const adminRole = await insertTestRole(trx, admin);
      for (const code of ['org.structure.manage', 'identity.device.block']) {
        await grantTestPermission(trx, adminRole, code, admin);
      }
      await assignTestRole(trx, admin, adminRole, admin);

      const sellerRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, sellerRole, SETTING_PERMISSION, admin);
      userA = await insertTestUser(trx);
      userB = await insertTestUser(trx);
      await assignTestRole(trx, userA, sellerRole, admin);
      await assignTestRole(trx, userB, sellerRole, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** Une tablette neuve (approuvée) avec son harnais. */
  async function newTablet(): Promise<OfflineDevice> {
    const deviceId = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, userA, { status: 'ACTIVE' }));
    return new OfflineDevice(services, deviceId, clock);
  }

  const setting = (key: string, occurredAt = at('09:00')): CommandSpec => ({
    type: 'organization.setting.set',
    aggregateType: 'SETTING',
    occurredAt,
    payload: { key, value: true, scopeType: 'GLOBAL', isClientVisible: true },
  });
  const uniqueKey = (label: string) => `p507.${label}.${freshUuid()}`;

  async function settingRows(key: string) {
    return db
      .selectFrom('organization_system_settings')
      .select('id')
      .where('key', '=', key)
      .execute();
  }

  async function syncRow(deviceId: string, dataset: string) {
    return db
      .selectFrom('sync_device_sync_state')
      .select(['last_device_seq', 'pending_reported', 'last_push_at'])
      .where('device_id', '=', toBin(deviceId))
      .where('dataset', '=', dataset)
      .executeTakeFirst();
  }

  async function inboxCount(deviceId: string): Promise<number> {
    const rows = await db
      .selectFrom('sync_command_inbox')
      .select('command_id')
      .where('device_id', '=', toBin(deviceId))
      .execute();
    return rows.length;
  }

  it('deux auteurs, un compteur : last_device_seq est le maximum reçu et chaque commande est appliquée une fois', async () => {
    const tablet = await newTablet();
    const keys = Array.from({ length: 5 }, (_, i) => uniqueKey(`seq${i + 1}`));
    // Ordre de saisie sur la tablette : A, A, B, B, A — compteur commun 1..5.
    tablet.enqueue(userA, setting(keys[0]!));
    tablet.enqueue(userA, setting(keys[1]!));
    tablet.enqueue(userB, setting(keys[2]!));
    tablet.enqueue(userB, setting(keys[3]!));
    tablet.enqueue(userA, setting(keys[4]!));
    expect(tablet.pendingByAuthor()).toEqual({ [userA]: 3, [userB]: 2 });

    // B ouvre sa session en premier : ses commandes portent les seq 3 et 4.
    const fromB = await tablet.sync(userB);
    expect(fromB.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect((await syncRow(tablet.deviceId, '_device'))?.last_device_seq).toBe(4);

    // A pousse ensuite 1, 2 et 5 : le maximum est 5, jamais le dernier lot reçu.
    const fromA = await tablet.sync(userA);
    expect(fromA.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect((await syncRow(tablet.deviceId, '_device'))?.last_device_seq).toBe(5);
    expect((await syncRow(tablet.deviceId, authorDataset(userA)))?.last_device_seq).toBe(5);
    expect((await syncRow(tablet.deviceId, authorDataset(userB)))?.last_device_seq).toBe(4);

    for (const key of keys) expect(await settingRows(key)).toHaveLength(1);
    expect(await inboxCount(tablet.deviceId)).toBe(5);
  });

  it('last_device_seq ne recule jamais : un lot de seq plus bas arrivé après un lot de seq plus haut', async () => {
    const tablet = await newTablet();
    tablet.enqueue(userB, setting(uniqueKey('low'))); // seq 1
    tablet.enqueue(userA, setting(uniqueKey('high'))); // seq 2
    await tablet.sync(userA);
    expect((await syncRow(tablet.deviceId, '_device'))?.last_device_seq).toBe(2);
    await tablet.sync(userB);
    expect((await syncRow(tablet.deviceId, '_device'))?.last_device_seq).toBe(2);
    expect((await syncRow(tablet.deviceId, authorDataset(userB)))?.last_device_seq).toBe(1);
  });

  it('INV-SYN-04 reformulé : au sein d’un couple (appareil, auteur), l’ordre de device_seq prime sur l’ordre du lot', async () => {
    const tablet = await newTablet();
    const key = uniqueKey('order');
    const first = tablet.enqueue(userA, {
      ...setting(key),
      payload: { ...(setting(key).payload as object), value: 1 },
    });
    const second = tablet.enqueue(userA, {
      ...setting(key),
      payload: { ...(setting(key).payload as object), value: 2 },
    });
    // Le transport inverse le lot : le serveur impose l'ordre de device_seq.
    const response = await services.push.push(
      {
        device_id: tablet.deviceId,
        batch_id: freshUuid(),
        device_sent_at: clock.now().toISOString(),
        commands: [second, first],
      },
      { authenticatedUserId: userA, authenticatedDeviceId: tablet.deviceId },
    );
    expect(response.results.map((r) => r.command_id)).toEqual([
      first.command_id,
      second.command_id,
    ]);
    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);
  });

  describe('déclaration des opérations en attente (pending_by_author)', () => {
    it('l’appareil déclare ce qu’il lui reste, par auteur et en total ; zéro quand tout est parti', async () => {
      const tablet = await newTablet();
      for (let i = 0; i < 3; i++) tablet.enqueue(userA, setting(uniqueKey(`a${i}`)));
      for (let i = 0; i < 2; i++) tablet.enqueue(userB, setting(uniqueKey(`b${i}`)));

      // A pousse un premier lot de deux commandes : il lui en reste une, à B deux.
      await tablet.sync(userA, { batchSize: 2, maxBatches: 1 });
      expect((await syncRow(tablet.deviceId, '_device'))?.pending_reported).toBe(3);
      expect((await syncRow(tablet.deviceId, authorDataset(userA)))?.pending_reported).toBe(1);
      expect((await syncRow(tablet.deviceId, authorDataset(userB)))?.pending_reported).toBe(2);

      // B tout envoyer : il reste la commande d'A.
      await tablet.sync(userB);
      expect((await syncRow(tablet.deviceId, '_device'))?.pending_reported).toBe(1);
      expect((await syncRow(tablet.deviceId, authorDataset(userB)))?.pending_reported).toBe(0);

      await tablet.sync(userA);
      expect((await syncRow(tablet.deviceId, '_device'))?.pending_reported).toBe(0);
      expect((await syncRow(tablet.deviceId, authorDataset(userA)))?.pending_reported).toBe(0);
      expect(tablet.pending()).toBe(0);
    });

    it('un appareil qui ne déclare rien n’est pas supposé vide : total non renseigné', async () => {
      const tablet = await newTablet();
      const envelope = tablet.enqueue(userA, setting(uniqueKey('undeclared')));
      await services.push.push(
        {
          device_id: tablet.deviceId,
          batch_id: freshUuid(),
          device_sent_at: clock.now().toISOString(),
          commands: [envelope],
        },
        { authenticatedUserId: userA, authenticatedDeviceId: tablet.deviceId },
      );
      const row = await syncRow(tablet.deviceId, '_device');
      expect(row?.last_push_at).toBeInstanceOf(Date);
      expect(row?.pending_reported).toBeNull();
    });

    it('BR-DIS-014 de bout en bout : l’appareil désigné d’un PDV ne se change qu’une fois sa file vidée', async () => {
      const tablet = await newTablet();
      const replacement = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
      const { siteId, salesLocationId } = await db.transaction().execute(async (trx) => {
        const zoneId = await insertTestZone(trx, admin);
        const site = await insertTestSite(trx, admin, zoneId, { siteType: 'POINT_DE_VENTE' });
        const pos = await insertTestLocation(trx, admin, site, { locationType: 'POS' });
        return { siteId: site, salesLocationId: pos };
      });
      const configure = (designatedDeviceId: string) =>
        pipeline.handle(
          {
            command_id: freshUuid(),
            device_seq: 1,
            command_type: 'organization.pos.configure',
            command_version: 1,
            author_user_id: admin,
            aggregate_type: 'SITE',
            aggregate_id: siteId,
            base_version: null,
            depends_on: [],
            occurred_at: at('10:00'),
            client_created_at: at('10:00'),
            captured_offline: false,
            backdated_reason: null,
            attachment_ids: [],
            payload: { salesLocationId, custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId },
          },
          {
            authenticatedUserId: admin,
            authenticatedDeviceId: adminDevice,
            transport: 'ONLINE_API',
          },
        );
      expect((await configure(tablet.deviceId)).status).toBe('APPLIED');

      tablet.enqueue(userA, setting(uniqueKey('pdv1')));
      tablet.enqueue(userA, setting(uniqueKey('pdv2')));
      tablet.enqueue(userB, setting(uniqueKey('pdv3')));
      await tablet.sync(userA, { batchSize: 1, maxBatches: 1 });
      expect((await syncRow(tablet.deviceId, '_device'))?.pending_reported).toBe(2);

      const blocked = await configure(replacement);
      expect(blocked).toMatchObject({
        status: 'REJECTED',
        error: { code: 'POS_DEVICE_CHANGE_BLOCKED' },
      });

      await tablet.syncAll();
      expect((await syncRow(tablet.deviceId, '_device'))?.pending_reported).toBe(0);
      expect((await configure(replacement)).status).toBe('APPLIED');
    });
  });

  it('un auteur ne pousse pas la commande d’un autre : rejet définitif, ses propres commandes passent (INV-SYN-05)', async () => {
    const tablet = await newTablet();
    const foreign = tablet.enqueue(userA, setting(uniqueKey('foreign')));
    const own = tablet.enqueue(userB, setting(uniqueKey('own')));
    const response = await services.push.push(
      {
        device_id: tablet.deviceId,
        batch_id: freshUuid(),
        device_sent_at: clock.now().toISOString(),
        commands: [foreign, own],
      },
      { authenticatedUserId: userB, authenticatedDeviceId: tablet.deviceId },
    );
    const byId = new Map(response.results.map((r) => [r.command_id, r]));
    expect(byId.get(foreign.command_id)).toMatchObject({
      status: 'REJECTED',
      error: { code: 'FORBIDDEN' },
    });
    expect(byId.get(own.command_id)?.status).toBe('APPLIED');
  });

  describe('coupure réseau, perte de réponse, révocation', () => {
    it('hors réseau, rien ne part ; au retour, tout est appliqué dans l’ordre de la file', async () => {
      const tablet = await newTablet();
      const keys = [uniqueKey('off1'), uniqueKey('off2')];
      for (const key of keys) tablet.enqueue(userA, setting(key));

      tablet.goOffline();
      await expect(tablet.sync(userA)).rejects.toBeInstanceOf(NetworkDownError);
      expect(tablet.pending(userA)).toBe(2);
      for (const key of keys) expect(await settingRows(key)).toHaveLength(0);
      expect(await syncRow(tablet.deviceId, '_device')).toBeUndefined();

      tablet.goOnline();
      const results = await tablet.sync(userA);
      expect(results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
      for (const key of keys) expect(await settingRows(key)).toHaveLength(1);
    });

    it('réponse perdue : le serveur a traité le lot, la file est renvoyée à l’identique sans second effet', async () => {
      const tablet = await newTablet();
      const keys = [uniqueKey('lost1'), uniqueKey('lost2'), uniqueKey('lost3')];
      for (const key of keys) tablet.enqueue(userA, setting(key));

      tablet.loseNextResponses(1);
      await expect(tablet.sync(userA)).rejects.toMatchObject({ reason: 'RESPONSE_LOST' });
      // L'appareil ne sait pas : tout reste en file ; le serveur, lui, a tout appliqué.
      expect(tablet.pending(userA)).toBe(3);
      for (const key of keys) expect(await settingRows(key)).toHaveLength(1);

      const replay = await tablet.sync(userA);
      expect(replay.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
      expect(tablet.pending(userA)).toBe(0);
      for (const key of keys) expect(await settingRows(key)).toHaveLength(1);
      expect(await inboxCount(tablet.deviceId)).toBe(3);
    });

    it('révocation en cours de journée : avant, appliqué ; après, quarantaine DEVICE_REVOKED (RC-02)', async () => {
      const tablet = await newTablet();
      const before = tablet.enqueue(userA, setting(uniqueKey('before'), at('09:00')));
      const after = tablet.enqueue(userA, setting(uniqueKey('after'), at('15:00')));
      const alsoAfter = tablet.enqueue(userB, setting(uniqueKey('after-b'), at('16:00')));

      const lost = await pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: 1,
          command_type: 'identity.device.declare_lost',
          command_version: 1,
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: tablet.deviceId,
          base_version: null,
          depends_on: [],
          occurred_at: at('12:00'),
          client_created_at: at('12:00'),
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: [],
          payload: {},
        },
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(lost.status).toBe('APPLIED');

      await tablet.syncAll();
      expect(tablet.resultOf(before.command_id)?.status).toBe('APPLIED');
      for (const quarantined of [after, alsoAfter]) {
        expect(tablet.resultOf(quarantined.command_id)).toMatchObject({
          status: 'CONFLICT',
          error: { code: 'DEVICE_REVOKED' },
        });
      }
    });
  });

  it('égalité avec le serveur : après un pull complet, chaque utilisateur de la tablette retrouve les paramètres des deux', async () => {
    const tablet = await newTablet();
    const keys = [uniqueKey('pull-a'), uniqueKey('pull-b')];
    tablet.enqueue(userA, setting(keys[0]!));
    tablet.enqueue(userB, setting(keys[1]!));
    await tablet.syncAll();

    await tablet.pullAll(SETTING_DATASET, userA, clock.now());
    for (const key of keys) {
      const projected = [...tablet.localProjection.values()].find((v) => v['key'] === key);
      expect(projected, `paramètre ${key} manquant après pull complet`).toBeDefined();
    }
  });
});
