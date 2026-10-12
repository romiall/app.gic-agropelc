import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import {
  countAttention,
  countPending,
  enqueueCommand,
  pendingAfterBatch,
  pendingOutbox,
} from './outbox.js';

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

  it('pendingAfterBatch : ce qui reste après le lot, par auteur, zéro compris (tablette partagée)', async () => {
    const enqueueFor = (author: string) =>
      enqueueCommand(
        db,
        { clock, idGenerator },
        {
          authorUserId: author,
          commandType: 'test.a',
          commandVersion: 1,
          aggregateType: 'TEST',
          payload: {},
          capturedOffline: true,
        },
      );
    const a1 = await enqueueFor('user-a');
    const a2 = await enqueueFor('user-a');
    await enqueueFor('user-b');
    const synced = await enqueueFor('user-c');
    await db.outbox.update(synced.command_id, { status: 'SYNCED' });

    // Lot d'A (deux commandes) : il ne lui reste rien, B en a une ; C n'a rien d'en attente.
    expect(await pendingAfterBatch(db, [a1, a2])).toEqual({ 'user-a': 0, 'user-b': 1 });
    // Lot d'une seule commande d'A : il lui en reste une.
    expect(await pendingAfterBatch(db, [a1])).toEqual({ 'user-a': 1, 'user-b': 1 });
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

  it('pendingOutbox : ordre strict, dépendantes comprises ; arrêt avant une dépendance qui ne part pas (ADR-052)', async () => {
    const enqueue = (dependsOn: readonly string[], authorUserId = 'user-1') =>
      enqueueCommand(
        db,
        { clock, idGenerator },
        {
          authorUserId,
          commandType: 'sales.sale.record',
          commandVersion: 1,
          aggregateType: 'SALE',
          dependsOn,
          payload: {},
          capturedOffline: true,
        },
      );
    const creation = await enqueue([]);
    const sale = await enqueue([creation.command_id]);
    const unknownDependency = await enqueue(['01900000-0000-7000-8000-0000000000aa']);
    const ids = async (skip?: ReadonlySet<string>) =>
      (await pendingOutbox(db, 50, 'user-1', skip)).map((c) => c.command_id);

    // La vente part dans le même lot, après sa création : le serveur les traite dans l'ordre et fait
    // attendre la vente si la création n'est pas encore réglée (S-17 levé, AV-210).
    expect(await ids()).toEqual([
      creation.command_id,
      sale.command_id,
      unknownDependency.command_id,
    ]);
    // Création écartée de ce cycle (bloquée, déjà renvoyée) : la vente qui en dépend ne part pas
    // seule, ni rien après elle (l'ordre est gardé).
    expect(await ids(new Set([creation.command_id]))).toEqual([]);
    // Création appliquée : la vente part.
    await db.outbox.update(creation.command_id, { status: 'SYNCED' });
    expect(await ids()).toEqual([sale.command_id, unknownDependency.command_id]);
    // Création refusée : la vente part aussi, le serveur la refusera (DEPENDENCY_REJECTED).
    await db.outbox.update(creation.command_id, { status: 'REJECTED' });
    expect(await ids()).toContain(sale.command_id);

    // Dépendance à une commande d'un autre utilisateur de la tablette, encore en file : elle ne part
    // qu'à sa reconnexion ; le lot s'arrête avant la dépendante.
    await db.outbox.clear();
    const other = await enqueue([], 'user-2');
    const first = await enqueue([]);
    const dependent = await enqueue([other.command_id]);
    await enqueue([]);
    expect(await ids()).toEqual([first.command_id]);
    expect(dependent.depends_on).toEqual([other.command_id]);
  });
});
