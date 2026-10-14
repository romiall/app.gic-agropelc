/**
 * P9-04 (ADR-071 §12, AV-412) : un événement sauté par un consommateur après ses essais est consigné
 * dans `platform_event_consumer_failures` (ajout seul) ; `last_error` n'en garde que le dernier message,
 * réécrit par le premier événement traité ensuite — la trace ne dépend donc pas de lui.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import { EventConsumerRunner } from '../src/platform/events/event-consumer-runner.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid } from './helpers.js';

const AT = new Date('2026-11-02T10:00:00.000Z');

async function insertEvent(eventType: string): Promise<string> {
  const eventId = freshUuid();
  await db
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(eventId),
      event_type: eventType,
      producer_module: 'test',
      aggregate_type: 'TEST',
      aggregate_id: toBin(freshUuid()),
      occurred_at: AT,
      payload: jsonValue({}),
    })
    .execute();
  return eventId;
}

async function startAtHead(consumerName: string): Promise<void> {
  const row = await db
    .selectFrom('platform_domain_events')
    .select(({ fn }) => fn.max('seq').as('maxSeq'))
    .executeTakeFirst();
  await db
    .insertInto('platform_event_consumer_offsets')
    .values({ consumer_name: consumerName, last_seq: row?.maxSeq ? Number(row.maxSeq) : 0 })
    .execute();
}

const failuresOf = (consumerName: string) =>
  db
    .selectFrom('platform_event_consumer_failures')
    .selectAll()
    .where('consumer_name', '=', consumerName)
    .orderBy('event_seq')
    .execute();

describe('P9-04 : événements sautés consignés par le runner', () => {
  afterAll(closeTestDb);

  it('l’échec persistant est consigné ; le succès suivant efface last_error, pas la trace', async () => {
    const consumerName = `test.failures.${freshUuid()}`;
    const registry = new EventConsumerRegistry();
    registry.register(consumerName, async (_uow, event) => {
      if (event.eventType === 'test.event.poison')
        throw new Error('Charge utile invalide : champ manquant');
    });
    const runner = new EventConsumerRunner(db, registry);
    await startAtHead(consumerName);
    const poison = await insertEvent('test.event.poison');
    await insertEvent('test.event.fine');

    const run = await runner.processOnce(consumerName, { maxAttempts: 3, settleSeconds: 0 });
    expect(run).toMatchObject({ processed: 1, failed: 1 });

    const failures = await failuresOf(consumerName);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      consumer_name: consumerName,
      event_type: 'test.event.poison',
      error_message: 'Charge utile invalide : champ manquant',
      attempts: 3,
    });
    expect(failures[0]!.event_id.toString('hex')).toBe(poison.replace(/-/g, ''));

    // `last_error` : réécrit à `null` par le succès suivant du même lot ; la trace reste.
    const offset = await db
      .selectFrom('platform_event_consumer_offsets')
      .select('last_error')
      .where('consumer_name', '=', consumerName)
      .executeTakeFirstOrThrow();
    expect(offset.last_error).not.toBeNull(); // dans CET appel, l'erreur reste visible
    await insertEvent('test.event.fine');
    await runner.processOnce(consumerName, { settleSeconds: 0 });
    const after = await db
      .selectFrom('platform_event_consumer_offsets')
      .select('last_error')
      .where('consumer_name', '=', consumerName)
      .executeTakeFirstOrThrow();
    expect(after.last_error).toBeNull();
    expect(await failuresOf(consumerName)).toHaveLength(1);
  });

  it('un rejeu avant l’avancée de la position ne consigne pas le saut deux fois', async () => {
    const consumerName = `test.failures.${freshUuid()}`;
    const registry = new EventConsumerRegistry();
    registry.register(consumerName, async () => {
      throw new Error('toujours en échec');
    });
    const runner = new EventConsumerRunner(db, registry);
    await startAtHead(consumerName);
    const poison = await insertEvent('test.event.poison');
    await runner.processOnce(consumerName, { maxAttempts: 2, settleSeconds: 0 });
    // Position ramenée juste avant l'événement (reprise après arrêt entre la consignation et la position).
    const row = await db
      .selectFrom('platform_domain_events')
      .select('seq')
      .where('event_id', '=', toBin(poison))
      .executeTakeFirstOrThrow();
    await db
      .updateTable('platform_event_consumer_offsets')
      .set({ last_seq: Number(row.seq) - 1 })
      .where('consumer_name', '=', consumerName)
      .execute();
    await runner.processOnce(consumerName, { maxAttempts: 2, settleSeconds: 0 });
    const failures = await failuresOf(consumerName);
    expect(new Set(failures.map((f) => Number(f.event_seq))).size).toBe(failures.length);
  });
});
