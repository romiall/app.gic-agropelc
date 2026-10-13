/**
 * Horloge d'appareil suspecte et date future, paramétrées (P5-23 ; AV-216, AV-226, AV-227 ; BR-SYN-011,
 * INV-GLO-02, ADR-016) :
 * - le seuil du drapeau `CLOCK_SUSPECT` se lit dans `sync.clock_skew_flag_minutes`, à l'heure serveur de la
 *   réception du lot (jamais à `occurred_at`, déclaré par l'horloge en cause) ; une valeur absurde reprend
 *   5 min ; la décision est écrite dans l'inbox (`clock_suspect`) et relue par `loadCommandOrigin` ;
 * - la tolérance de date future se lit dans `sync.occurred_at_future_tolerance_minutes` ;
 * - un écart hors des bornes des colonnes `INT` est borné, sans faire échouer le lot.
 *
 * Les versions des paramètres sont datées de 2025, avant toute horloge des autres suites, et se terminent
 * par la valeur par défaut (5) : les tables de paramètres sont immuables, une version datée après le seed
 * changerait définitivement les suites à horloge réelle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CLOCK_SKEW_STORED_MAX_MS, FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { loadCommandOrigin } from '../src/platform/sync/command-origin.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { OfflineDevice } from './device-harness.js';
import { SETTING_PERMISSION } from './sync-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const FLAG_KEY = 'sync.clock_skew_flag_minutes';
const FUTURE_KEY = 'sync.occurred_at_future_tolerance_minutes';
const MINUTE = 60_000;

/** Versions GLOBAL datées de 2025 (insérées une fois : la table est immuable). */
const VERSIONS: ReadonlyArray<readonly [string, string, unknown]> = [
  [FLAG_KEY, '2025-02-01T00:00:00.000Z', 2],
  [FLAG_KEY, '2025-03-01T00:00:00.000Z', 60],
  [FLAG_KEY, '2025-04-01T00:00:00.000Z', 'abc'],
  [FLAG_KEY, '2025-04-15T00:00:00.000Z', -5],
  [FLAG_KEY, '2025-05-01T00:00:00.000Z', 5],
  [FUTURE_KEY, '2025-06-01T00:00:00.000Z', 1],
  [FUTURE_KEY, '2025-07-01T00:00:00.000Z', 30],
  [FUTURE_KEY, '2025-08-01T00:00:00.000Z', 5],
];

describe('horloge suspecte et date future paramétrées (P5-23 : AV-216, AV-226, AV-227)', () => {
  const clock = new FixedClock(new Date('2025-02-10T12:00:00.000Z'));
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let user: string;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    // Sonde : n'écrit rien de métier ; le drapeau se lit sur l'inbox et par `loadCommandOrigin`.
    registry.register({
      commandType: 'organization.probe.clock',
      version: 1,
      payloadSchema: z.object({ label: z.string() }),
      permissionCode: SETTING_PERMISSION,
      handler: async () => ({ status: 'APPLIED' }),
    });
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };
    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, SETTING_PERMISSION, admin);
      user = await insertTestUser(trx);
      await assignTestRole(trx, user, role, admin);
      for (const [key, validFrom, value] of VERSIONS) {
        const exists = await trx
          .selectFrom('organization_system_settings')
          .select('id')
          .where('key', '=', key)
          .where('scope_type', '=', 'GLOBAL')
          .where('valid_from', '=', new Date(validFrom))
          .executeTakeFirst();
        if (exists) continue;
        await trx
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: jsonValue(value),
            scope_type: 'GLOBAL',
            valid_from: new Date(validFrom),
            is_client_visible: 0,
            reason: 'Réglage de test P5-23 (AV-216, AV-226), daté de 2025',
            created_by: toBin(admin),
          })
          .execute();
      }
    });
  });

  afterAll(closeTestDb);

  const newTablet = async (offsetMs: number) => {
    const tablet = new OfflineDevice(
      services,
      await db.transaction().execute((trx) => insertTestDevice(trx, user, { status: 'ACTIVE' })),
      clock,
    );
    tablet.setClockOffset(offsetMs);
    return tablet;
  };
  /** Une commande saisie à l'heure de la tablette (ou à `occurredAt`), envoyée, et son drapeau. */
  async function pushed(offsetMs: number, occurredAt?: string) {
    const tablet = await newTablet(offsetMs);
    const envelope = tablet.enqueue(user, {
      type: 'organization.probe.clock',
      aggregateType: 'PROBE',
      occurredAt: occurredAt ?? tablet.deviceNow().toISOString(),
      payload: { label: 'p523' },
    });
    await tablet.sync(user);
    const result = tablet.resultOf(envelope.command_id);
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select(['status', 'clock_skew_ms', 'clock_suspect'])
      .where('command_id', '=', toBin(envelope.command_id))
      .executeTakeFirstOrThrow();
    const origin = await db
      .transaction()
      .execute((trx) => loadCommandOrigin(trx, envelope.command_id));
    return { result, inbox, origin, tablet };
  }
  const suspect = (warnings: readonly string[] | undefined) =>
    (warnings ?? []).includes('CLOCK_SUSPECT');

  it('seuil lu à la réception : 2 min en février (10 min d’avance → drapeau), 60 min en mars (10 min → rien, 90 min → drapeau)', async () => {
    clock.setTo(new Date('2025-02-10T12:00:00.000Z'));
    const feb = await pushed(10 * MINUTE);
    // Le drapeau s'ajoute aux avertissements sans changer le statut (le fait est appliqué, ADR-016).
    expect(feb.result?.status).toBe('APPLIED');
    expect(suspect(feb.result?.warnings)).toBe(true);
    expect(feb.inbox).toMatchObject({
      status: 'APPLIED',
      clock_skew_ms: -10 * MINUTE,
      clock_suspect: 1,
    });
    expect(feb.origin.clockSuspect).toBe(true);

    clock.setTo(new Date('2025-03-10T12:00:00.000Z'));
    const march = await pushed(10 * MINUTE);
    expect(march.result?.status).toBe('APPLIED');
    expect(suspect(march.result?.warnings)).toBe(false);
    expect(march.inbox.clock_suspect).toBe(0);
    expect(march.origin.clockSuspect).toBe(false);
    const far = await pushed(90 * MINUTE);
    expect(suspect(far.result?.warnings)).toBe(true);
    expect(far.inbox.clock_suspect).toBe(1);
  });

  it('date de référence : la réception, jamais occurred_at — un fait de février reçu en mars se juge au seuil de mars', async () => {
    clock.setTo(new Date('2025-03-10T12:00:00.000Z'));
    const late = await pushed(10 * MINUTE, '2025-02-10T12:00:00.000Z');
    expect(late.result?.status).toBe('APPLIED');
    expect(late.inbox.clock_suspect).toBe(0);
  });

  it('valeur absurde (texte, négative) : repli de 5 min — 3 min d’avance non marquées, 10 min marquées', async () => {
    for (const day of ['2025-04-05', '2025-04-20']) {
      clock.setTo(new Date(`${day}T12:00:00.000Z`));
      expect((await pushed(3 * MINUTE)).inbox.clock_suspect).toBe(0);
      expect((await pushed(10 * MINUTE)).inbox.clock_suspect).toBe(1);
    }
  });

  it('ONLINE_API (sans écart mesuré) : jamais marqué', async () => {
    clock.setTo(new Date('2025-02-10T12:00:00.000Z'));
    const device = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, user, { status: 'ACTIVE' }));
    const commandId = freshUuid();
    const result = await pipeline.handle(
      {
        command_id: commandId,
        device_seq: 1,
        command_version: 1,
        command_type: 'organization.probe.clock',
        aggregate_type: 'PROBE',
        aggregate_id: freshUuid(),
        author_user_id: user,
        base_version: null,
        depends_on: [],
        occurred_at: clock.now().toISOString(),
        client_created_at: clock.now().toISOString(),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { label: 'en ligne' },
      },
      { authenticatedUserId: user, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select(['clock_skew_ms', 'clock_suspect'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(inbox).toEqual({ clock_skew_ms: null, clock_suspect: 0 });
  });

  it('AV-227 : tablette en retard de 40 jours — écart borné à INT_MAX, lot traité, drapeau levé, état de l’appareil enregistré', async () => {
    clock.setTo(new Date('2025-05-10T12:00:00.000Z'));
    const behind = await pushed(-40 * 86_400_000);
    expect(behind.result?.status).toMatch(/^APPLIED/);
    expect(suspect(behind.result?.warnings)).toBe(true);
    expect(behind.inbox).toMatchObject({
      clock_skew_ms: CLOCK_SKEW_STORED_MAX_MS,
      clock_suspect: 1,
    });
    const state = await db
      .selectFrom('sync_device_sync_state')
      .select('last_clock_skew_ms')
      .where('device_id', '=', toBin(behind.tablet.deviceId))
      .where('dataset', '=', '_device')
      .executeTakeFirstOrThrow();
    expect(state.last_clock_skew_ms).toBe(CLOCK_SKEW_STORED_MAX_MS);
  });

  it('AV-226 : tolérance de date future paramétrée — 1 min (juin), 30 min (juillet), 5 min (août)', async () => {
    const online = async (aheadMinutes: number) => {
      const device = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, user, { status: 'ACTIVE' }));
      const occurredAt = new Date(clock.now().getTime() + aheadMinutes * MINUTE).toISOString();
      return pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: 1,
          command_version: 1,
          command_type: 'organization.probe.clock',
          aggregate_type: 'PROBE',
          aggregate_id: freshUuid(),
          author_user_id: user,
          base_version: null,
          depends_on: [],
          occurred_at: occurredAt,
          client_created_at: occurredAt,
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: [],
          payload: { label: `+${aheadMinutes}` },
        },
        { authenticatedUserId: user, authenticatedDeviceId: device, transport: 'ONLINE_API' },
      );
    };
    const codeOf = (result: Awaited<ReturnType<typeof online>>) =>
      result.status === 'REJECTED' ? result.error?.code : result.status;

    clock.setTo(new Date('2025-06-10T12:00:00.000Z'));
    expect(codeOf(await online(2))).toBe('OCCURRED_AT_FUTURE');
    clock.setTo(new Date('2025-07-10T12:00:00.000Z'));
    expect(codeOf(await online(2))).toBe('APPLIED');
    expect(codeOf(await online(29))).toBe('APPLIED');
    expect(codeOf(await online(31))).toBe('OCCURRED_AT_FUTURE');
    clock.setTo(new Date('2025-08-10T12:00:00.000Z'));
    expect(codeOf(await online(4))).toBe('APPLIED');
    expect(codeOf(await online(6))).toBe('OCCURRED_AT_FUTURE');
  });
});
