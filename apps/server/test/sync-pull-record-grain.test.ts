/**
 * MP-12 (AV-319) — le dernier pull d'un appareil n'est pas réécrit à chaque tirage. Un appareil tire une
 * trentaine de jeux toutes les 30 s et chaque tirage réécrivait deux lignes de `sync_device_sync_state`
 * (appareil et auteur) : des milliers d'écritures durables par heure pour un seuil de retard de deux
 * heures (vérification contradictoire du 22/10/2026, constat C20). `last_pull_at` n'avance plus que
 * d'un pas (`sync.pull_record_grain_seconds`, 60 s) ; il ne recule jamais. Chaque test crée son appareil :
 * aucun ne dépend de l'état laissé par un autre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  PULL_RECORD_GRAIN_DEFAULT_SECONDS,
  PULL_RECORD_GRAIN_KEY,
  SyncPullService,
} from '../src/sync/sync-pull.service.js';
import { authorDataset, DEVICE_DATASET } from '../src/sync/sync-push.service.js';
import type { DB } from '../src/platform/kysely/database.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestUser,
  withTestUow,
} from './helpers.js';

describe('MP-12 — enregistrement du dernier pull par pas (AV-319)', () => {
  let userId: string;
  const t0 = new Date('2026-10-22T08:00:00.000Z');
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  beforeAll(async () => {
    userId = await db.transaction().execute((trx) => insertTestUser(trx));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const newDevice = () =>
    db.transaction().execute((trx) => insertTestDevice(trx, userId, { status: 'ACTIVE' }));

  const pullAt = (service: SyncPullService, deviceId: string, now: Date) =>
    service.pull(
      { dataset: 'cash', cursor: 0, limit: 1 },
      { authenticatedUserId: userId, authenticatedDeviceId: deviceId, now },
    );

  /** Dernier pull des deux lignes enregistrées (appareil, auteur), en millisecondes. */
  async function recorded(
    executor: Kysely<DB>,
    deviceId: string,
  ): Promise<{ device: number | null; author: number | null }> {
    const rows = await executor
      .selectFrom('sync_device_sync_state')
      .select(['dataset', 'last_pull_at'])
      .where('device_id', '=', toBin(deviceId))
      .execute();
    const of = (dataset: string) => {
      const value = rows.find((row) => row.dataset === dataset)?.last_pull_at ?? null;
      return value === null ? null : new Date(value).getTime();
    };
    return { device: of(DEVICE_DATASET), author: of(authorDataset(userId)) };
  }

  const both = (date: Date) => ({ device: date.getTime(), author: date.getTime() });

  it('premier tirage : les lignes de l’appareil et de l’auteur reçoivent l’heure du tirage', async () => {
    const deviceId = await newDevice();
    const service = new SyncPullService(db, { recordGrainSeconds: 60, settleSeconds: 0 });
    await pullAt(service, deviceId, at(0));
    expect(await recorded(db, deviceId)).toEqual(both(at(0)));
  });

  it('tirages rapprochés (moins d’un pas) : rien n’est réécrit ; au-delà du pas, l’heure avance', async () => {
    const deviceId = await newDevice();
    const service = new SyncPullService(db, { recordGrainSeconds: 60, settleSeconds: 0 });
    await pullAt(service, deviceId, at(0));
    await pullAt(service, deviceId, at(10));
    await pullAt(service, deviceId, at(59));
    expect(await recorded(db, deviceId)).toEqual(both(at(0)));

    await pullAt(service, deviceId, at(61));
    expect(await recorded(db, deviceId)).toEqual(both(at(61)));
  });

  it('à la limite exacte du pas : pas de réécriture ; une milliseconde de plus, oui', async () => {
    const deviceId = await newDevice();
    const service = new SyncPullService(db, { recordGrainSeconds: 60, settleSeconds: 0 });
    await pullAt(service, deviceId, at(0));
    await pullAt(service, deviceId, at(60));
    expect(await recorded(db, deviceId)).toEqual(both(at(0)));

    await pullAt(service, deviceId, new Date(at(60).getTime() + 1));
    expect(await recorded(db, deviceId)).toEqual(both(new Date(at(60).getTime() + 1)));
  });

  it('un tirage daté avant l’heure enregistrée ne la fait jamais reculer', async () => {
    const deviceId = await newDevice();
    const service = new SyncPullService(db, { recordGrainSeconds: 0, settleSeconds: 0 });
    await pullAt(service, deviceId, at(100));
    await pullAt(service, deviceId, at(30));
    expect(await recorded(db, deviceId)).toEqual(both(at(100)));
  });

  it('pas à 0 : chaque tirage plus récent écrit', async () => {
    const deviceId = await newDevice();
    const service = new SyncPullService(db, { recordGrainSeconds: 0, settleSeconds: 0 });
    await pullAt(service, deviceId, at(62));
    expect((await recorded(db, deviceId)).device).toBe(at(62).getTime());
    await pullAt(service, deviceId, at(63));
    expect(await recorded(db, deviceId)).toEqual(both(at(63)));
  });

  it('appareil qui a déjà poussé sans jamais tirer (dernier pull vide) : le premier tirage est écrit', async () => {
    const pushedDevice = await newDevice();
    await db
      .insertInto('sync_device_sync_state')
      .values({ device_id: toBin(pushedDevice), dataset: DEVICE_DATASET, last_push_at: at(0) })
      .execute();
    const service = new SyncPullService(db, { recordGrainSeconds: 60, settleSeconds: 0 });
    await pullAt(service, pushedDevice, at(5));
    const row = await db
      .selectFrom('sync_device_sync_state')
      .select(['last_pull_at', 'last_push_at'])
      .where('device_id', '=', toBin(pushedDevice))
      .where('dataset', '=', DEVICE_DATASET)
      .executeTakeFirstOrThrow();
    expect(new Date(row.last_pull_at!).getTime()).toBe(at(5).getTime());
    // L'envoi enregistré n'est pas touché (BR-DIS-014).
    expect(new Date(row.last_push_at!).getTime()).toBe(at(0).getTime());
  });

  it('sans option ni version du paramètre : le pas est celui de la valeur par défaut', async () => {
    expect(PULL_RECORD_GRAIN_DEFAULT_SECONDS).toBe(60);
    // La clé du service est celle du seed (`system-settings.ts`, `seed.test.ts`).
    expect(PULL_RECORD_GRAIN_KEY).toBe('sync.pull_record_grain_seconds');
    await withTestUow(async (uow) => {
      const deviceId = await insertTestDevice(uow, userId, { status: 'ACTIVE' });
      // Une version éventuelle du paramètre, déjà en base, serait plus récente que ces dates de 2026.
      const service = new SyncPullService(uow, { settleSeconds: 0 });
      await pullAt(service, deviceId, at(0));
      await pullAt(service, deviceId, at(37));
      expect((await recorded(uow, deviceId)).device).toBe(at(0).getTime());
    });
  });

  it('lit le paramètre en base ; une valeur négative ou non numérique retombe sur 60 s', async () => {
    await withTestUow(async (uow) => {
      const deviceId = await insertTestDevice(uow, userId, { status: 'ACTIVE' });
      const setVersion = (value: unknown, validFrom: Date) =>
        uow
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key: PULL_RECORD_GRAIN_KEY,
            value: JSON.stringify(value),
            scope_type: 'GLOBAL',
            scope_id: null,
            valid_from: validFrom,
            is_client_visible: 0,
            created_by: toBin(userId),
            reason: 'Test MP-12',
          })
          .execute();
      const service = new SyncPullService(uow, { settleSeconds: 0 });

      // 5 s : un tirage 4 s après le dernier n'écrit pas, 6 s après, si.
      await setVersion(5, at(-1));
      await pullAt(service, deviceId, at(0));
      await pullAt(service, deviceId, at(4));
      expect((await recorded(uow, deviceId)).device).toBe(at(0).getTime());
      await pullAt(service, deviceId, at(6));
      expect((await recorded(uow, deviceId)).device).toBe(at(6).getTime());

      // Valeur négative : le pas retombe sur 60 s.
      await setVersion(-1, at(1000));
      await pullAt(service, deviceId, at(1000));
      await pullAt(service, deviceId, at(1030));
      expect((await recorded(uow, deviceId)).device).toBe(at(1000).getTime());
      await pullAt(service, deviceId, at(1061));
      expect((await recorded(uow, deviceId)).device).toBe(at(1061).getTime());

      // Valeur non numérique : idem.
      await setVersion('abc', at(2000));
      await pullAt(service, deviceId, at(2000));
      await pullAt(service, deviceId, at(2030));
      expect((await recorded(uow, deviceId)).device).toBe(at(2000).getTime());
    });
  });
});
