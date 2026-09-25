/**
 * Démonstration du critère de sortie P0-08 (« consommateur de test exactement-une-fois par
 * clé » ; 08-api-events/02-catalogue-evenements.md §1, §3) : `EventConsumerRunner` traite un
 * lot et avance la position, et un gestionnaire dont l'effet de bord est keyé
 * `(consumer_name, event_id)` (contrainte unique, `platform_event_consumer_marks`) ne duplique
 * jamais son effet — même rejoué directement avec le même `event_id` — parce que la
 * contrainte l'empêche, pas parce qu'on le suppose. Un échec persistant n'arrête pas le lot :
 * la position avance quand même jusqu'au dernier événement traité, `last_error` retient le
 * dernier échec.
 */
import { describe, expect, it } from 'vitest';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
import { EventConsumerRunner } from '../src/platform/events/event-consumer-runner.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid } from './helpers.js';

const OCCURRED_AT = new Date('2026-09-24T10:00:00.000Z');

async function insertTestEvent(eventType: string, payload: unknown = {}): Promise<string> {
  const eventId = freshUuid();
  await db
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(eventId),
      event_type: eventType,
      producer_module: 'test',
      aggregate_type: 'TEST',
      aggregate_id: toBin(freshUuid()),
      occurred_at: OCCURRED_AT,
      payload: jsonValue(payload),
    })
    .execute();
  return eventId;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * `platform_domain_events` est une vraie table partagée par toute la suite (ajout seul,
 * jamais annulée — comme `audit_audit_log`), y compris d'autres fichiers de test qui y
 * écrivent pendant que celui-ci tourne (`fileParallelism`, vitest.config.ts). Un consommateur
 * neuf démarrant à `last_seq = 0` rejouerait tout l'historique déjà présent, pas seulement
 * les événements de ce test. On fixe donc la position de départ du consommateur de test au
 * `seq` maximal déjà écrit, avant d'insérer ses propres événements : il ne voit ensuite que
 * ceux-là, quel que soit ce que les autres fichiers écrivent en parallèle.
 */
async function seedOffsetAtCurrentHead(consumerName: string): Promise<void> {
  const row = await db
    .selectFrom('platform_domain_events')
    .select(({ fn }) => fn.max('seq').as('maxSeq'))
    .executeTakeFirst();
  const lastSeq = row?.maxSeq ? Number(row.maxSeq) : 0;
  await db
    .insertInto('platform_event_consumer_offsets')
    .values({ consumer_name: consumerName, last_seq: lastSeq })
    .execute();
}

describe('EventConsumerRunner.processOnce (P0-08, idempotence par clé)', () => {
  it('traitement normal : une marque par événement, position avancée', async () => {
    const consumerName = `test.consumer.${freshUuid()}`;
    const registry = new EventConsumerRegistry();
    registry.register(consumerName, async (uow, event) => {
      await uow
        .insertInto('platform_event_consumer_marks')
        .values({ consumer_name: consumerName, event_id: toBin(event.eventId) })
        .execute();
    });
    const runner = new EventConsumerRunner(db, registry);

    await seedOffsetAtCurrentHead(consumerName);
    const eventId = await insertTestEvent('test.event.recorded');
    const result = await runner.processOnce(consumerName);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const marks = await db
      .selectFrom('platform_event_consumer_marks')
      .selectAll()
      .where('consumer_name', '=', consumerName)
      .where('event_id', '=', toBin(eventId))
      .execute();
    expect(marks).toHaveLength(1);

    const offset = await db
      .selectFrom('platform_event_consumer_offsets')
      .select('last_seq')
      .where('consumer_name', '=', consumerName)
      .executeTakeFirstOrThrow();
    expect(Number(offset.last_seq)).toBeGreaterThan(0);
  });

  it('rejeu direct du même event_id : aucune duplication (contrainte unique, pas seulement supposée)', async () => {
    const consumerName = `test.consumer.${freshUuid()}`;
    const registry = new EventConsumerRegistry();
    let calls = 0;
    registry.register(consumerName, async (uow, event) => {
      calls++;
      try {
        await uow
          .insertInto('platform_event_consumer_marks')
          .values({ consumer_name: consumerName, event_id: toBin(event.eventId) })
          .execute();
      } catch (error) {
        // Déjà traité pour cette clé (rejeu) : no-op — exactement le contrat attendu d'un
        // consommateur idempotent, où la contrainte d'unicité fait le travail plutôt qu'une
        // vérification préalable (qui serait elle-même sujette à une course).
        if (!isDuplicateKeyError(error)) throw error;
      }
    });
    const runner = new EventConsumerRunner(db, registry);
    await seedOffsetAtCurrentHead(consumerName);
    const eventId = await insertTestEvent('test.event.redelivered');

    await runner.processOnce(consumerName);

    // Rejeu direct du gestionnaire avec le même événement — simule une redélivrance réelle
    // (ex. le processus meurt entre l'effet de bord et l'avancée de position, l'événement est
    // retraité au prochain passage) sans dépendre de processOnce, qui a déjà avancé la
    // position et ne re-sélectionnerait plus cet événement.
    const row = await db
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('event_id', '=', toBin(eventId))
      .executeTakeFirstOrThrow();
    const event = toDomainEvent(row);
    const handler = registry.resolve(consumerName);
    if (!handler) throw new Error('gestionnaire introuvable');
    await db.transaction().execute((trx) => handler(trx, event));

    expect(calls).toBe(2);
    const marks = await db
      .selectFrom('platform_event_consumer_marks')
      .selectAll()
      .where('consumer_name', '=', consumerName)
      .where('event_id', '=', toBin(eventId))
      .execute();
    expect(marks).toHaveLength(1); // une seule marque malgré les deux invocations
  });

  it("un échec définitif n'arrête pas les suivants du même lot (§3 « continue avec les suivants »)", async () => {
    const consumerName = `test.consumer.${freshUuid()}`;
    await seedOffsetAtCurrentHead(consumerName);
    const failingEventId = await insertTestEvent('test.event.fails');
    const okEventId = await insertTestEvent('test.event.ok_after_failure');

    const registry = new EventConsumerRegistry();
    registry.register(consumerName, async (uow, event) => {
      if (event.eventId === failingEventId) {
        throw new Error('échec simulé');
      }
      await uow
        .insertInto('platform_event_consumer_marks')
        .values({ consumer_name: consumerName, event_id: toBin(event.eventId) })
        .execute();
    });
    const runner = new EventConsumerRunner(db, registry);

    const result = await runner.processOnce(consumerName, { maxAttempts: 2 });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const marks = await db
      .selectFrom('platform_event_consumer_marks')
      .select('event_id')
      .where('consumer_name', '=', consumerName)
      .execute();
    expect(marks.map((m) => fromBin(m.event_id))).toEqual([okEventId]);

    const offset = await db
      .selectFrom('platform_event_consumer_offsets')
      .select(['last_seq', 'last_error'])
      .where('consumer_name', '=', consumerName)
      .executeTakeFirstOrThrow();
    expect(offset.last_error).toBe('échec simulé');

    const okRow = await db
      .selectFrom('platform_domain_events')
      .select('seq')
      .where('event_id', '=', toBin(okEventId))
      .executeTakeFirstOrThrow();
    // La position a dépassé l'événement en échec : elle atteint le dernier du lot, pas
    // bloquée sur le premier qui a échoué.
    expect(Number(offset.last_seq)).toBe(Number(okRow.seq));
  });
});
