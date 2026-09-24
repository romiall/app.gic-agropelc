import { describe, expect, it } from 'vitest';
import { randomId, withRollback } from './helpers.js';

describe('platform_domain_events', () => {
  it('accepte une insertion puis refuse toute modification et toute suppression (ADR-011, INV-GLO-03)', async () => {
    await withRollback(async (conn) => {
      const eventId = randomId();
      await conn.query(
        `INSERT INTO platform_domain_events
           (event_id, event_type, producer_module, aggregate_type, aggregate_id, occurred_at, payload)
         VALUES (?, 'TestEvent', 'platform', 'test', ?, NOW(6), JSON_OBJECT())`,
        [eventId, randomId()],
      );

      await expect(
        conn.query('UPDATE platform_domain_events SET event_type = ? WHERE event_id = ?', [
          'Hacked',
          eventId,
        ]),
      ).rejects.toThrow(/immuable/);

      await expect(
        conn.query('DELETE FROM platform_domain_events WHERE event_id = ?', [eventId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('platform_event_consumer_offsets / platform_document_sequences', () => {
  it('sont librement modifiables (compteurs techniques)', async () => {
    await withRollback(async (conn) => {
      await conn.query(
        "INSERT INTO platform_event_consumer_offsets (consumer_name, last_seq) VALUES ('test.consumer', 0)",
      );
      await conn.query(
        "UPDATE platform_event_consumer_offsets SET last_seq = 42 WHERE consumer_name = 'test.consumer'",
      );
      const [rows] = await conn.query(
        "SELECT last_seq FROM platform_event_consumer_offsets WHERE consumer_name = 'test.consumer'",
      );
      expect((rows as Array<{ last_seq: number }>)[0]?.last_seq).toBe(42);
    });
  });
});
