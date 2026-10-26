/**
 * P9-10 (revue adverse, constat 23 ; D13 `DEVICE_SEQ_GAP`, AV-423) : les restes que l'appareil déclare à
 * l'envoi expliquent les numéros de sa suite qui manquent à la boîte des commandes — de bout en bout, par le
 * vrai service d'envoi (`SyncPushService`) et le vrai pipeline, sur une tablette partagée.
 *
 * Les tests de la passe (`sync-seq-gap-alert.test.ts`) écrivent `pending_reported` directement ; celui-ci
 * prouve que ce que le service enregistre (total de tous les auteurs, plus ce que le lot n'a pas réglé) couvre
 * les numéros manquants du scénario réel : une régression du calcul du total ferait lever une fausse alerte
 * critique (ou masquerait un trou) sans qu'aucun autre test ne casse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  gapsExplainedByPending,
  missingSequenceCount,
  type Clock,
  type SequenceGap,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { DEVICE_DATASET } from '../src/sync/sync-state-datasets.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { OfflineDevice, type CommandSpec } from './device-harness.js';
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

const DAY = '2026-10-08';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('restes déclarés par l’appareil et trous de séquence (P9-10, AV-423)', () => {
  let clock: Clock;
  let services: { push: SyncPushService; pull: SyncPullService };
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(`${DAY}T13:00:00.000Z`));
    const idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerSettingCommands(registry);
    const pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
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

  async function newTablet(): Promise<OfflineDevice> {
    const deviceId = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, userA, { status: 'ACTIVE' }));
    return new OfflineDevice(services, deviceId, clock);
  }

  const setting = (label: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
    type: 'organization.setting.set',
    aggregateType: 'SETTING',
    occurredAt: at('09:00'),
    payload: {
      key: `p910.gap.${label}.${freshUuid()}`,
      value: true,
      scopeType: 'GLOBAL',
      isClientVisible: true,
    },
    ...extra,
  });

  /** Numéros reçus par la boîte pour l'appareil, par ordre croissant. */
  async function receivedSeqs(deviceId: string): Promise<number[]> {
    const rows = await db
      .selectFrom('sync_command_inbox')
      .select('device_seq')
      .where('device_id', '=', toBin(deviceId))
      .where('device_seq', 'is not', null)
      .orderBy('device_seq')
      .execute();
    return rows.map((row) => Number(row.device_seq));
  }

  /** Plages absentes entre 1 et le plus grand numéro reçu (la suite d'un appareil démarre à 1). */
  function gapsOf(seqs: readonly number[]): SequenceGap[] {
    const gaps: SequenceGap[] = [];
    let previous = 0;
    for (const seq of seqs) {
      if (seq > previous + 1) {
        gaps.push({ from: previous + 1, to: seq - 1, openedAt: new Date(0) });
      }
      previous = seq;
    }
    return gaps;
  }

  async function pendingReported(deviceId: string): Promise<number | null> {
    const row = await db
      .selectFrom('sync_device_sync_state')
      .select('pending_reported')
      .where('device_id', '=', toBin(deviceId))
      .where('dataset', '=', DEVICE_DATASET)
      .executeTakeFirst();
    return row === undefined ? null : row.pending_reported;
  }

  it('tablette partagée : les commandes de l’autre auteur, déclarées en attente, couvrent exactement le trou', async () => {
    const tablet = await newTablet();
    tablet.enqueue(userA, setting('a1')); // 1
    tablet.enqueue(userA, setting('a2')); // 2
    tablet.enqueue(userB, setting('b1')); // 3
    tablet.enqueue(userB, setting('b2')); // 4
    tablet.enqueue(userA, setting('a3')); // 5

    // L'auteur A pousse sa part ; B n'a pas ouvert sa session : ses deux commandes restent sur la tablette.
    await tablet.sync(userA);
    expect(await receivedSeqs(tablet.deviceId)).toEqual([1, 2, 5]);
    const gaps = gapsOf(await receivedSeqs(tablet.deviceId));
    expect(missingSequenceCount(gaps)).toBe(2);
    expect(await pendingReported(tablet.deviceId)).toBe(2);
    expect(gapsExplainedByPending(gaps, await pendingReported(tablet.deviceId))).toBe(true);

    // Une commande de moins déclarée en attente et le trou ne serait plus expliqué.
    expect(gapsExplainedByPending(gaps, 1)).toBe(false);

    // B pousse sa part : le trou se comble, plus rien n'est déclaré en attente.
    await tablet.sync(userB);
    expect(await receivedSeqs(tablet.deviceId)).toEqual([1, 2, 3, 4, 5]);
    expect(gapsOf(await receivedSeqs(tablet.deviceId))).toEqual([]);
    expect(await pendingReported(tablet.deviceId)).toBe(0);
  });

  it('lot retenu (RETRY_LATER) : ce que le serveur n’a pas réglé s’ajoute aux restes des autres auteurs', async () => {
    const tablet = await newTablet();
    tablet.enqueue(userA, setting('a1')); // 1 : appliquée
    tablet.enqueue(userA, setting('a2', { dependsOn: [freshUuid()] })); // 2 : dépendance jamais reçue
    tablet.enqueue(userA, setting('a3')); // 3 : retenue derrière la précédente, ni traitée ni enregistrée
    tablet.enqueue(userB, setting('b1')); // 4

    const first = await tablet.sync(userA);
    expect(first.map((result) => result.status)).toEqual(['APPLIED', 'RETRY_LATER', 'RETRY_LATER']);
    // Le lot de A déclare B (1) et ce qu'il n'a pas réglé (2) : 3 restent à envoyer sur l'appareil.
    expect(await pendingReported(tablet.deviceId)).toBe(3);

    // B pousse la sienne : la commande 2 est dans la boîte (en attente de sa dépendance), la 3 retenue derrière
    // elle n'y est pas — le numéro 3 manque —, et A déclare toujours ses deux commandes non réglées.
    await tablet.sync(userB);
    const seqs = await receivedSeqs(tablet.deviceId);
    expect(seqs).toEqual([1, 2, 4]);
    const gaps = gapsOf(seqs);
    expect(gaps.map((gap) => [gap.from, gap.to])).toEqual([[3, 3]]);
    expect(missingSequenceCount(gaps)).toBe(1);
    expect(await pendingReported(tablet.deviceId)).toBe(2);
    expect(gapsExplainedByPending(gaps, await pendingReported(tablet.deviceId))).toBe(true);
    // Sans ces restes déclarés, le trou ne serait pas expliqué (alerte critique).
    expect(gapsExplainedByPending(gaps, 0)).toBe(false);
  });
});
