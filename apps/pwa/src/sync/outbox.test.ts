import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { countAttention, countPending, enqueueCommand, pendingOutbox } from './outbox.js';

describe('sync/outbox (06-offline-sync/01-architecture-offline.md §5)', () => {
  let db: GicDatabase;
  const clock = new FixedClock(new Date('2026-09-25T09:00:00.000Z'));
  const idGenerator = new Uuidv7Generator(clock);

  beforeEach(() => {
    db = createTestDb(`test-outbox-${Math.random()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('device_seq croît strictement à chaque commande (FIFO par appareil)', async () => {
    const first = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'organization.setting.set',
        commandVersion: 1,
        aggregateType: 'SETTING',
        payload: {},
        capturedOffline: true,
      },
    );
    const second = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'organization.setting.set',
        commandVersion: 1,
        aggregateType: 'SETTING',
        payload: {},
        capturedOffline: true,
      },
    );
    expect(second.device_seq).toBe(first.device_seq + 1);
    expect(first.status).toBe('LOCAL_ONLY');
  });

  it('une commande sans aggregateId en génère un nouveau (création)', async () => {
    const command = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'organization.setting.set',
        commandVersion: 1,
        aggregateType: 'SETTING',
        payload: {},
        capturedOffline: false,
      },
    );
    expect(command.aggregate_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pendingOutbox renvoie LOCAL_ONLY et PENDING_SYNC dans l’ordre de device_seq, jamais SYNCED', async () => {
    const a = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'test.a',
        commandVersion: 1,
        aggregateType: 'TEST',
        payload: {},
        capturedOffline: true,
      },
    );
    const b = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'test.b',
        commandVersion: 1,
        aggregateType: 'TEST',
        payload: {},
        capturedOffline: true,
      },
    );
    await db.outbox.update(a.command_id, { status: 'SYNCED' });

    const pending = await pendingOutbox(db);
    expect(pending.map((c) => c.command_id)).toEqual([b.command_id]);
  });

  it('countPending inclut SYNCING, countAttention inclut CONFLICT et REJECTED', async () => {
    const a = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'test.a',
        commandVersion: 1,
        aggregateType: 'TEST',
        payload: {},
        capturedOffline: true,
      },
    );
    const b = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'test.b',
        commandVersion: 1,
        aggregateType: 'TEST',
        payload: {},
        capturedOffline: true,
      },
    );
    await db.outbox.update(a.command_id, { status: 'SYNCING' });
    await db.outbox.update(b.command_id, { status: 'REJECTED' });

    expect(await countPending(db)).toBe(1);
    expect(await countAttention(db)).toBe(1);
  });
});
