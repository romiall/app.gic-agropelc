/**
 * P0-15 — Harnais de synchronisation (09-non-functional/03-plan-de-tests.md §3) : scénarios
 * de base au-delà de ce que `sync-push-pull.test.ts` couvre déjà au niveau d'un seul appareil
 * (AT-002, AT-036, AT-050, harnais NFR-19) — ici, **plusieurs appareils virtuels** et le
 * désordre **entre lots** (pas seulement entre commandes d'un même lot). Après chaque
 * scénario : égalité de l'état local de chaque appareil avec le serveur, après un pull
 * complet (§3, dernière phrase).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
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
import {
  buildHarnessServices,
  SETTING_DATASET,
  SETTING_PERMISSION,
  VirtualDevice,
  type VirtualDeviceContext,
} from './sync-harness.js';
import type { Database } from '../src/platform/kysely/database.provider.js';
import { canonicalJsonStringify } from '../src/platform/canonical-json.js';
import { sha256Hex } from '../src/platform/hash.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toDbBool } from '../src/platform/kysely/bool-column.js';

async function createVirtualDevice(
  services: ReturnType<typeof buildHarnessServices>,
  clock: Clock,
): Promise<VirtualDevice> {
  const ctx: VirtualDeviceContext = await db.transaction().execute(async (trx) => {
    const user = await insertTestUser(trx);
    const device = await insertTestDevice(trx, user, { status: 'ACTIVE' });
    await insertTestPermission(trx, SETTING_PERMISSION);
    const role = await insertTestRole(trx, user);
    await grantTestPermission(trx, role, SETTING_PERMISSION, user);
    await assignTestRole(trx, user, role, user);
    return { authenticatedUserId: user, authenticatedDeviceId: device };
  });
  return new VirtualDevice(services, ctx, clock);
}

async function readSettingValue(database: Database, key: string): Promise<unknown[]> {
  return database
    .selectFrom('organization_system_settings')
    .select('id')
    .where('key', '=', key)
    .execute();
}

describe('Harnais de synchronisation (P0-15)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let services: ReturnType<typeof buildHarnessServices>;

  beforeAll(() => {
    clock = new FixedClock(new Date('2026-09-25T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    services = buildHarnessServices(db, clock, idGenerator);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it(
    'plusieurs appareils virtuels concurrents, chacun rejouant son lot (réponse perdue) : ' +
      'aucune duplication, et égalité avec le serveur après un pull complet',
    async () => {
      const devices = await Promise.all([
        createVirtualDevice(services, clock),
        createVirtualDevice(services, clock),
        createVirtualDevice(services, clock),
      ]);
      const keys = devices.map((_, i) => `harness.concurrent.${freshUuid()}.${i}`);

      // Trois appareils en concurrence (pas un seul, comme le harnais NFR-19 existant) :
      // l'écriture simultanée de l'audit chaîné (INV-AUD-01) peut transitoirement refuser une
      // commande (RETRY_LATER, `SERVER_BUSY`) — chaque appareil relance alors le même lot,
      // exactement comme il le ferait après une coupure réseau.
      const results = await Promise.all(
        devices.map(async (deviceVm, i) => {
          const batch = [deviceVm.buildSettingCommand({ key: keys[i]!, deviceSeq: 1 })];
          return deviceVm.pushUntilSettled(batch);
        }),
      );
      for (const response of results) {
        expect(response.results[0]!.status).toBe('APPLIED');
      }

      for (const key of keys) {
        expect(await readSettingValue(db, key)).toHaveLength(1);
      }

      // Pull complet par chaque appareil : GLOBAL est visible par tous, donc chacun doit
      // retrouver les trois paramètres créés par les trois appareils, pas seulement le sien.
      const now = clock.now();
      await Promise.all(devices.map((deviceVm) => deviceVm.pullAll(SETTING_DATASET, now)));

      for (const deviceVm of devices) {
        for (const key of keys) {
          const projected = [...deviceVm.localProjection.values()].find((v) => v['key'] === key);
          expect(projected, `appareil manque ${key} après pull complet`).toBeDefined();
        }
      }
    },
  );

  it('inversion d’ordre de lots : le second lot envoyé (device_seq les plus hauts) arrive avant le premier', async () => {
    const deviceVm = await createVirtualDevice(services, clock);
    const keyA1 = `harness.reorder.${freshUuid()}`;
    const keyA2 = `harness.reorder.${freshUuid()}`;
    const keyB1 = `harness.reorder.${freshUuid()}`;
    const keyB2 = `harness.reorder.${freshUuid()}`;

    const batchA = [
      deviceVm.buildSettingCommand({ key: keyA1, deviceSeq: 1 }),
      deviceVm.buildSettingCommand({ key: keyA2, deviceSeq: 2 }),
    ];
    const batchB = [
      deviceVm.buildSettingCommand({ key: keyB1, deviceSeq: 3 }),
      deviceVm.buildSettingCommand({ key: keyB2, deviceSeq: 4 }),
    ];

    // Désordre réseau : B (device_seq 3, 4) arrive avant A (device_seq 1, 2).
    const responseB = await deviceVm.push(batchB);
    const responseA = await deviceVm.push(batchA);

    expect(responseB.results.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(responseA.results.every((r) => r.status === 'APPLIED')).toBe(true);

    for (const key of [keyA1, keyA2, keyB1, keyB2]) {
      expect(await readSettingValue(db, key)).toHaveLength(1);
    }

    await deviceVm.pullAll(SETTING_DATASET, clock.now());
    const projectedKeys = new Set([...deviceVm.localProjection.values()].map((v) => v['key']));
    for (const key of [keyA1, keyA2, keyB1, keyB2]) {
      expect(projectedKeys.has(key)).toBe(true);
    }
  });

  it('écart d’horloge simultané sur deux appareils : chacun reçoit SON écart, sans contamination croisée', async () => {
    const fast = await createVirtualDevice(services, clock); // horloge en avance de 10 min
    const slow = await createVirtualDevice(services, clock); // horloge en retard de 10 min
    const serverNow = clock.now();
    const fastSentAt = new Date(serverNow.getTime() + 10 * 60_000).toISOString();
    const slowSentAt = new Date(serverNow.getTime() - 10 * 60_000).toISOString();

    const [fastResponse, slowResponse] = await Promise.all([
      fast.push([fast.buildSettingCommand({ key: `harness.skew.${freshUuid()}` })], {
        deviceSentAt: fastSentAt,
      }),
      slow.push([slow.buildSettingCommand({ key: `harness.skew.${freshUuid()}` })], {
        deviceSentAt: slowSentAt,
      }),
    ]);

    // clock_skew_ms = server_time − device_sent_at (sync-push.service.ts) : une horloge
    // d'appareil en avance (device_sent_at > server_time) donne un écart négatif.
    expect(fastResponse.clock_skew_ms).toBeLessThan(0);
    expect(slowResponse.clock_skew_ms).toBeGreaterThan(0);
    expect(Math.abs(fastResponse.clock_skew_ms)).toBeGreaterThan(5 * 60_000);
    expect(Math.abs(slowResponse.clock_skew_ms)).toBeGreaterThan(5 * 60_000);
    expect(fastResponse.results[0]!.warnings).toContain('CLOCK_SUSPECT');
    expect(slowResponse.results[0]!.warnings).toContain('CLOCK_SUSPECT');
  });

  it('lot à résultat mixte (une commande valide, une ciblant une portée inexistante) : rejeu identique, sans double effet', async () => {
    const deviceVm = await createVirtualDevice(services, clock);
    const okKey = `harness.mixed.${freshUuid()}`;
    const missingSiteId = freshUuid(); // jamais inséré : NOT_FOUND (setting-commands.ts)

    const batch = [
      deviceVm.buildSettingCommand({ key: okKey, deviceSeq: 1 }),
      deviceVm.buildSettingCommand({
        key: `harness.mixed.${freshUuid()}`,
        deviceSeq: 2,
        scopeType: 'SITE',
        scopeId: missingSiteId,
      }),
    ];

    const first = await deviceVm.push(batch);
    expect(first.results.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(first.results[1]!.error?.code).toBe('NOT_FOUND');

    // Rejeu exact du même lot (réponse perdue) : chaque commande retrouve SON statut propre —
    // l'idempotence ne doit pas transformer un REJECTED en APPLIED, ni l'inverse.
    const second = await deviceVm.push(batch);
    expect(second.results).toEqual(first.results);
    expect(await readSettingValue(db, okKey)).toHaveLength(1);
  });

  it(
    'reprise après échec transitoire (FAILED_RETRYABLE) : le rejeu applique réellement la ' +
      'commande au lieu de renvoyer indéfiniment le même échec (régression, découverte par le ' +
      'scénario concurrent ci-dessus)',
    async () => {
      const deviceVm = await createVirtualDevice(services, clock);
      const key = `harness.retry.${freshUuid()}`;
      const envelope = deviceVm.buildSettingCommand({ key, deviceSeq: 1 });
      const payloadHash = sha256Hex(canonicalJsonStringify(envelope));

      // Simule ce que l'étape 7 du pipeline écrit après un échec transitoire réel (verrou,
      // délai) : la ligne existe, `status = FAILED_RETRYABLE`, sans résultat ni code d'erreur
      // final — exactement l'état qu'un vrai deadlock produirait avant correction du bug.
      await db
        .insertInto('sync_command_inbox')
        .values({
          command_id: toBin(envelope.command_id),
          device_id: toBin(deviceVm.ctx.authenticatedDeviceId),
          user_id: toBin(envelope.author_user_id),
          device_seq: envelope.device_seq,
          transport: 'SYNC_PUSH',
          command_type: envelope.command_type,
          command_version: envelope.command_version,
          aggregate_type: envelope.aggregate_type,
          aggregate_id: toBin(envelope.aggregate_id),
          base_version: envelope.base_version,
          depends_on: jsonValue(envelope.depends_on),
          payload: jsonValue(envelope.payload),
          payload_hash: payloadHash,
          occurred_at: new Date(envelope.occurred_at),
          client_created_at: new Date(envelope.client_created_at),
          captured_offline: toDbBool(envelope.captured_offline),
          status: 'FAILED_RETRYABLE',
          error_message: 'Erreur transitoire, à réessayer.',
          attempts: 1,
        })
        .execute();

      // Rejeu (enveloppe strictement identique, donc même payload_hash) : doit relancer le
      // pipeline, pas renvoyer `FAILED_RETRYABLE` tel quel (qui n'est même pas un statut valide
      // du protocole, `SYNC_RESULT_STATUSES`).
      const response = await deviceVm.push([envelope]);
      expect(response.results[0]!.status).toBe('APPLIED');
      expect(await readSettingValue(db, key)).toHaveLength(1);

      const inboxRow = await db
        .selectFrom('sync_command_inbox')
        .select(['status', 'attempts'])
        .where('command_id', '=', toBin(envelope.command_id))
        .executeTakeFirstOrThrow();
      expect(inboxRow.status).toBe('APPLIED');
      expect(inboxRow.attempts).toBe(2); // 1 (échec initial simulé) + 1 (cette reprise)
    },
  );
});
