import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type GicDatabase } from './db.js';
import {
  hasLocalSession,
  MAX_PIN_ATTEMPTS,
  setupPin,
  unlockWithPin,
  wipeDownloadedData,
  wipeLocalSession,
} from './session.js';

describe('storage/session (PIN local, BR-ADM-024)', () => {
  let db: GicDatabase;

  beforeEach(() => {
    db = createTestDb(`test-session-${Math.random()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('setupPin puis unlockWithPin avec le bon PIN restitue le jeton de rafraîchissement', async () => {
    await setupPin(db, {
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-abc',
      pin: '123456',
    });
    expect(await hasLocalSession(db)).toBe(true);

    const result = await unlockWithPin(db, '123456');
    expect(result).toMatchObject({
      ok: true,
      refreshToken: 'refresh-abc',
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
    });
  });

  it('sans session locale (jamais connecté sur cet appareil) : NO_SESSION', async () => {
    const result = await unlockWithPin(db, '123456');
    expect(result).toEqual({ ok: false, reason: 'NO_SESSION' });
  });

  it('mauvais PIN : INVALID_PIN avec le nombre de tentatives restantes, session intacte', async () => {
    await setupPin(db, {
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-abc',
      pin: '123456',
    });

    const result = await unlockWithPin(db, '000000');
    expect(result).toEqual({
      ok: false,
      reason: 'INVALID_PIN',
      attemptsLeft: MAX_PIN_ATTEMPTS - 1,
    });
    expect(await hasLocalSession(db)).toBe(true);
  });

  it(`BR-ADM-024 : ${MAX_PIN_ATTEMPTS} échecs consécutifs effacent les jetons locaux (WIPED)`, async () => {
    await setupPin(db, {
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-abc',
      pin: '123456',
    });

    let last;
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      last = await unlockWithPin(db, '000000');
    }
    expect(last).toEqual({ ok: false, reason: 'WIPED' });
    expect(await hasLocalSession(db)).toBe(false);

    // Reconnexion en ligne obligatoire : plus aucune session à déverrouiller.
    expect(await unlockWithPin(db, '123456')).toEqual({ ok: false, reason: 'NO_SESSION' });
  });

  it('un déverrouillage réussi réinitialise le compteur d’échecs', async () => {
    await setupPin(db, {
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-abc',
      pin: '123456',
    });
    await unlockWithPin(db, '000000'); // 1 échec
    await unlockWithPin(db, '123456'); // succès : remise à zéro

    const lock = await db.pinLocks.get('user-1');
    expect(lock?.failed_attempts).toBe(0);
  });

  it('wipeLocalSession efface session et verrou PIN sans toucher l’outbox', async () => {
    await setupPin(db, {
      userId: 'user-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-abc',
      pin: '123456',
    });
    await db.outbox.put({
      command_id: 'cmd-1',
      device_seq: 1,
      command_type: 'test.demo.record',
      command_version: 1,
      author_user_id: 'user-1',
      aggregate_type: 'TEST',
      aggregate_id: 'agg-1',
      base_version: null,
      depends_on: [],
      occurred_at: new Date().toISOString(),
      client_created_at: new Date().toISOString(),
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'PENDING_SYNC',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });

    await wipeLocalSession(db);
    expect(await hasLocalSession(db)).toBe(false);
    expect(await db.outbox.count()).toBe(1);
  });

  it('AV-213 (c) : wipeDownloadedData efface projections, curseurs et parcours mémorisé, garde la file, les pièces et l’identité de l’appareil', async () => {
    await db.syncMeta.put({
      key: 'device',
      device_id: 'appareil-1',
      clock_skew_ms: null,
      last_sync_at: '2026-11-05T08:00:00.000Z',
      data_user_id: 'user-1',
    });
    await db.projections.put({
      key: 'customers:CUSTOMER:c1',
      dataset: 'customers',
      entity_type: 'CUSTOMER',
      entity_id: 'c1',
      scope_type: 'USER',
      scope_id: 'user-1',
      row_version: 1,
      seq: 1,
      data: { id: 'c1' },
    });
    await db.syncCursors.put({ dataset: 'customers', cursor: 12 });
    await db.outbox.put({
      command_id: 'cmd-9',
      device_seq: 9,
      command_type: 'test.demo.record',
      command_version: 1,
      author_user_id: 'user-1',
      aggregate_type: 'DEMO',
      aggregate_id: 'agg-1',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-11-05T08:00:00.000Z',
      client_created_at: '2026-11-05T08:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'PENDING_SYNC',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });

    await wipeDownloadedData(db);
    expect(await db.projections.count()).toBe(0);
    expect(await db.syncCursors.count()).toBe(0);
    // La file d'envoi reste, comme l'identité de l'appareil ; son propriétaire de données et son dernier contact repartent de zéro.
    expect(await db.outbox.count()).toBe(1);
    expect(await db.syncMeta.get('device')).toMatchObject({
      device_id: 'appareil-1',
      data_user_id: null,
      // Marqué « effacé » : un tirage en vol qui écrirait après coup ne sera pas hérité par l'utilisateur suivant.
      data_wiped: true,
      last_sync_at: null,
    });
    // Sans appareil connu (jamais synchronisé), l'effacement ne lève pas.
    await db.syncMeta.clear();
    await expect(wipeDownloadedData(db)).resolves.toBeUndefined();
  });

  it('rejette un PIN de format invalide dès l’établissement', async () => {
    await expect(
      setupPin(db, {
        userId: 'user-1',
        deviceStatus: 'ACTIVE',
        refreshToken: 'refresh-abc',
        pin: '12',
      }),
    ).rejects.toThrow();
  });
});
