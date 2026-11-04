/**
 * Commandes refusées sur l'appareil (ADR-052, AV-507) : une commande dont l'enveloppe est invalide est refusée avant
 * l'envoi et n'atteint jamais le serveur ; son `device_seq` manque donc dans la suite reçue. L'appareil déclare ces
 * numéros (`skipped_device_seqs`) ; le serveur les garde en plages fusionnées (`declared_skips`) et le détecteur
 * `sync.devices.seq_gap_check` ne les prend pas pour des commandes perdues. Un vrai trou, lui, est signalé comme
 * avant. Le trajet est celui d'un appareil réel : file, envoi par lots, vrai service de synchronisation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { runDeviceSeqGapCheck } from '../src/sync/jobs/device-seq-gap-alert-job.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { OfflineDevice, type CommandSpec } from './device-harness.js';
import { SETTING_PERMISSION } from './sync-harness.js';
import { rolledBack } from './communication-test-kit.js';
import { eventsOf } from './sync-alert-test-kit.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  recentBusinessDay,
} from './helpers.js';

const DAY = recentBusinessDay(3);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const HOUR = 3_600_000;

describe('commandes refusées sur l’appareil : déclarées, jamais prises pour perdues (ADR-052, AV-507)', () => {
  const clock: Clock = new FixedClock(new Date(at('13:00')));
  const idGenerator = new Uuidv7Generator(clock);
  let services: { push: SyncPushService; pull: SyncPullService };
  let author: string;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerSettingCommands(registry);
    services = {
      push: new SyncPushService(
        new CommandPipelineService(db, registry, clock, idGenerator),
        db,
        clock,
      ),
      pull: new SyncPullService(db),
    };
    await db.transaction().execute(async (trx) => {
      author = await insertTestUser(trx);
      const role = await insertTestRole(trx, author);
      await grantTestPermission(trx, role, SETTING_PERMISSION, author);
      await assignTestRole(trx, author, role, author);
    });
  });

  afterAll(closeTestDb);

  async function newDevice(): Promise<OfflineDevice> {
    const deviceId = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, author, { status: 'ACTIVE' }));
    return new OfflineDevice(services, deviceId, clock);
  }

  const setting = (label: string, minute: number): CommandSpec => ({
    type: 'organization.setting.set',
    aggregateType: 'SETTING',
    occurredAt: at(`09:${String(minute).padStart(2, '0')}`),
    payload: {
      key: `av507.${label}.${freshUuid()}`,
      value: true,
      scopeType: 'GLOBAL',
      isClientVisible: false,
    },
  });

  const declaredSkips = async (deviceId: string): Promise<unknown> =>
    (
      await db
        .selectFrom('sync_device_sync_state')
        .select('declared_skips')
        .where('device_id', '=', toBin(deviceId))
        .where('dataset', '=', '_device')
        .executeTakeFirst()
    )?.declared_skips ?? null;

  /**
   * Passe du détecteur, 30 h après les envois (au-delà du délai de 24 h), annulée ensuite. La date de réception
   * d'une commande est celle de la base (`received_at`, défaut `CURRENT_TIMESTAMP`), pas l'horloge fixe du pipeline :
   * l'âge d'un trou se compte donc depuis l'heure réelle.
   */
  const gapEvents = (deviceId: string) =>
    rolledBack(async (uow) => {
      const later = new FixedClock(new Date(Date.now() + 30 * HOUR));
      await runDeviceSeqGapCheck(
        uow,
        { clock: later, idGenerator: new Uuidv7Generator(later) },
        { scheduledFor: later.now().toISOString() },
      );
      return eventsOf(uow, 'DeviceSequenceGapDetected', deviceId);
    });

  it('le serveur garde les numéros déclarés en plages fusionnées ; redéclarer ne change rien', async () => {
    const device = await newDevice();
    device.enqueue(author, setting('a', 1)); // 1
    const skippedFirst = device.refuseLocally(); // 2
    const skippedSecond = device.refuseLocally(); // 3
    device.enqueue(author, setting('b', 2)); // 4
    expect([skippedFirst, skippedSecond]).toEqual([2, 3]);

    // La réponse du premier envoi est perdue : l'appareil redéclare les mêmes numéros au renvoi.
    device.loseNextResponses(1);
    await expect(device.sync(author)).rejects.toThrow();
    expect(await declaredSkips(device.deviceId)).toEqual([[2, 3]]);
    await device.syncUntilSettled(author);
    expect(await declaredSkips(device.deviceId)).toEqual([[2, 3]]);

    // Plus tard : un autre refus, non contigu, puis un contigu qui fusionne.
    device.refuseLocally(); // 5
    device.enqueue(author, setting('c', 3)); // 6
    await device.syncUntilSettled(author);
    expect(await declaredSkips(device.deviceId)).toEqual([
      [2, 3],
      [5, 5],
    ]);
    device.refuseLocally(); // 7
    device.refuseLocally(); // 8
    device.enqueue(author, setting('d', 4)); // 9
    await device.syncUntilSettled(author);
    expect(await declaredSkips(device.deviceId)).toEqual([
      [2, 3],
      [5, 5],
      [7, 8],
    ]);
  });

  it('un trou fait de numéros refusés chez l’appareil ne lève pas d’alerte ; un vrai trou, si', async () => {
    const declared = await newDevice();
    declared.enqueue(author, setting('e', 5)); // 1
    declared.refuseLocally(); // 2 : refusée chez l'appareil, déclarée
    declared.enqueue(author, setting('f', 6)); // 3
    await declared.syncUntilSettled(author);

    const lost = await newDevice();
    lost.enqueue(author, setting('g', 7)); // 1
    lost.nextSeq(); // 2 : consommé, ni envoyé ni déclaré : une commande perdue
    lost.enqueue(author, setting('h', 8)); // 3
    await lost.syncUntilSettled(author);

    expect(await gapEvents(declared.deviceId)).toEqual([]);
    const [event] = await gapEvents(lost.deviceId);
    expect(event!.payload).toMatchObject({ missing_from: 2, missing_to: 2, missing_count: 1 });
  });

  it('une déclaration partielle réduit le trou : seul ce qui n’est pas déclaré reste signalé', async () => {
    const device = await newDevice();
    device.enqueue(author, setting('i', 9)); // 1
    device.refuseLocally(); // 2 : déclarée
    device.nextSeq(); // 3 : perdue
    device.enqueue(author, setting('j', 10)); // 4
    await device.syncUntilSettled(author);
    const [event] = await gapEvents(device.deviceId);
    expect(event!.payload).toMatchObject({ missing_from: 3, missing_to: 3, missing_count: 1 });
  });
});
