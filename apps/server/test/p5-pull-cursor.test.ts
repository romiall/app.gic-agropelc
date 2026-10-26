/**
 * P5-23 — curseur du pull et position des consommateurs d'événements (AV-198) : deux transactions écrivent
 * dans le flux et se valident dans l'ordre inverse de leurs numéros. Le numéro est attribué à l'insertion :
 * tant que la première est ouverte, sa ligne est invisible et la seconde, de numéro supérieur, est lue.
 * Un curseur posé sur le dernier numéro lu sauterait la première pour toujours ; il est désormais retenu
 * avant le trou récent (`settledSequenceBound`), et la ligne est servie au pull suivant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { EventConsumerRunner } from '../src/platform/events/event-consumer-runner.js';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import type { DB } from '../src/platform/kysely/database.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, insertTestDevice, insertTestUser } from './helpers.js';

/** Une transaction de test ouverte jusqu'à `release()`, après avoir exécuté `write`. */
async function holdOpen(write: (trx: Transaction<DB>) => Promise<unknown>) {
  let ready!: () => void;
  let open!: () => void;
  const held = new Promise<void>((resolve) => (ready = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  const done = db.transaction().execute(async (trx) => {
    await write(trx);
    ready();
    await gate;
  });
  await Promise.race([held, done]);
  return {
    release: async () => {
      open();
      await done;
    },
  };
}

const lastSeq = async (table: 'sync_change_feed' | 'platform_domain_events') =>
  Number(
    (
      await db
        .selectFrom(table)
        .select(sql<string>`COALESCE(MAX(seq), 0)`.as('seq'))
        .executeTakeFirstOrThrow()
    ).seq,
  );

describe('P5-23 — numérotation validée dans le désordre (AV-198)', () => {
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    userId = await db.transaction().execute((trx) => insertTestUser(trx));
    deviceId = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, userId, { status: 'ACTIVE' }));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const feedRow = (dataset: string, entityId: string) => ({
    dataset,
    entity_type: 'TEST_ENTITY',
    entity_id: toBin(entityId),
    change_type: 'DELETE',
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
  });

  it('pull : le curseur reste avant la ligne d’une transaction encore ouverte, servie au pull suivant ; sans retenue, elle serait perdue', async () => {
    const dataset = `p523_${freshUuid().slice(-8)}`;
    const first = freshUuid();
    const second = freshUuid();
    const start = await lastSeq('sync_change_feed');
    const ctx = { authenticatedUserId: userId, authenticatedDeviceId: deviceId, now: new Date() };
    const pull = new SyncPullService(db);
    const unsettled = new SyncPullService(db, { settleSeconds: 0 });

    // La première écriture prend son numéro, puis sa transaction reste ouverte.
    const holder = await holdOpen((trx) =>
      trx.insertInto('sync_change_feed').values(feedRow(dataset, first)).execute(),
    );
    await db.insertInto('sync_change_feed').values(feedRow(dataset, second)).execute();

    const during = await pull.pull({ dataset, cursor: start, limit: 100 }, ctx);
    expect(during.changes.map((change) => change.entity_id)).toEqual([second]);
    expect(during.next_cursor).toBe(start);
    expect(during.has_more).toBe(false);
    // L'ancien comportement : le curseur passe la ligne invisible.
    const skipped = await unsettled.pull({ dataset, cursor: start, limit: 100 }, ctx);
    expect(skipped.next_cursor).toBeGreaterThan(start + 1);

    await holder.release();
    const after = await pull.pull({ dataset, cursor: during.next_cursor, limit: 100 }, ctx);
    expect(after.changes.map((change) => change.entity_id)).toEqual([first, second]);
    expect(after.next_cursor).toBe(skipped.next_cursor);
    const lost = await unsettled.pull({ dataset, cursor: skipped.next_cursor, limit: 100 }, ctx);
    expect(lost.changes).toEqual([]);
  });

  it('pull : un trou ancien (transaction annulée il y a plus de la fenêtre) ne retient pas le curseur', async () => {
    const dataset = `p523_${freshUuid().slice(-8)}`;
    const start = await lastSeq('sync_change_feed');
    const ctx = { authenticatedUserId: userId, authenticatedDeviceId: deviceId, now: new Date() };
    // Un numéro est consommé puis abandonné (transaction annulée) : trou définitif.
    await db
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto('sync_change_feed').values(feedRow(dataset, freshUuid())).execute();
        throw new Error('annulée');
      })
      .catch(() => undefined);
    const kept = freshUuid();
    await db.insertInto('sync_change_feed').values(feedRow(dataset, kept)).execute();
    // Récent : retenu ; avec une fenêtre nulle (trou tenu pour définitif) : avancé.
    const retained = await new SyncPullService(db).pull(
      { dataset, cursor: start, limit: 100 },
      ctx,
    );
    expect(retained.next_cursor).toBe(start);
    const settled = await new SyncPullService(db, { settleSeconds: 0 }).pull(
      { dataset, cursor: start, limit: 100 },
      ctx,
    );
    expect(settled.changes.map((change) => change.entity_id)).toEqual([kept]);
    expect(settled.next_cursor).toBeGreaterThan(start + 1);
  });

  it('consommateur d’événements : la position ne dépasse pas l’événement d’une transaction encore ouverte, traité au passage suivant', async () => {
    const seen: string[] = [];
    const registry = new EventConsumerRegistry();
    const consumer = `test.p523_${freshUuid().slice(-8)}`;
    registry.register(consumer, async (_uow, event) => {
      if (event.eventType === 'test.p523.event') seen.push(event.aggregateId);
    });
    const runner = new EventConsumerRunner(db, registry);
    // Position initiale : la tête du flux.
    await db
      .insertInto('platform_event_consumer_offsets')
      .values({ consumer_name: consumer, last_seq: await lastSeq('platform_domain_events') })
      .execute();

    const event = (aggregateId: string) => ({
      event_id: toBin(freshUuid()),
      event_type: 'test.p523.event',
      producer_module: 'test',
      aggregate_type: 'TEST',
      aggregate_id: toBin(aggregateId),
      occurred_at: new Date(),
      payload: JSON.stringify({}),
    });
    const first = freshUuid();
    const second = freshUuid();
    const holder = await holdOpen((trx) =>
      trx.insertInto('platform_domain_events').values(event(first)).execute(),
    );
    await db.insertInto('platform_domain_events').values(event(second)).execute();

    await runner.processOnce(consumer, { batchSize: 500 });
    expect(seen).toEqual([]);
    await holder.release();
    await runner.processOnce(consumer, { batchSize: 500 });
    expect(seen).toEqual([first, second]);
  });
});
