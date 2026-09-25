import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  commandTypeSchema,
  commandEnvelopeBaseSchema,
  commandEnvelopeSchema,
} from './command-envelope.js';
import { fixtureRawCommandEnvelope, fixtureUuid } from './test-helpers.js';

describe('commandTypeSchema', () => {
  it.each(['sales.sale.record', 'inventory.stock_count.close', 'identity.user.deactivate'])(
    'accepte %s (<module>.<agrégat>.<verbe>)',
    (value) => {
      expect(commandTypeSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    '',
    'sales.sale',
    'sales.sale.record.extra',
    'Sales.sale.record',
    'sales.Sale.record',
    'sales.sale.Record',
    '1sales.sale.record',
    'sales..record',
  ])('rejette %s', (value) => {
    expect(commandTypeSchema.safeParse(value).success).toBe(false);
  });
});

describe('commandEnvelopeBaseSchema', () => {
  it('accepte une enveloppe minimale valide et applique les valeurs par défaut', () => {
    const result = commandEnvelopeBaseSchema.safeParse(fixtureRawCommandEnvelope());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.depends_on).toEqual([]);
      expect(result.data.attachment_ids).toEqual([]);
      expect(result.data.backdated_reason).toBeNull();
    }
  });

  it('accepte une enveloppe complète (tous les champs optionnels renseignés)', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({
        base_version: 3,
        depends_on: [fixtureUuid(), fixtureUuid()],
        backdated_reason: 'Saisie de rattrapage après coupure réseau.',
        attachment_ids: [fixtureUuid()],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejette un command_id qui n'est pas un UUIDv7", () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ command_id: 'a1b2c3d4-e5f6-4789-8abc-1234567890ab' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejette un command_type au mauvais format', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ command_type: 'invalide' }),
    );
    expect(result.success).toBe(false);
  });

  it.each([0, -1])('rejette device_seq = %s (doit être strictement positif)', (device_seq) => {
    const result = commandEnvelopeBaseSchema.safeParse(fixtureRawCommandEnvelope({ device_seq }));
    expect(result.success).toBe(false);
  });

  it.each([0, -1])(
    'rejette command_version = %s (doit être strictement positif)',
    (command_version) => {
      const result = commandEnvelopeBaseSchema.safeParse(
        fixtureRawCommandEnvelope({ command_version }),
      );
      expect(result.success).toBe(false);
    },
  );

  it('accepte base_version = null (fait accompli)', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ base_version: null }),
    );
    expect(result.success).toBe(true);
  });

  it('accepte base_version = 0 (intention sur un agrégat à sa version initiale)', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ base_version: 0 }),
    );
    expect(result.success).toBe(true);
  });

  it('rejette base_version négatif', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ base_version: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it('accepte un lot de 50 depends_on (borne haute)', () => {
    const depends_on = Array.from({ length: 50 }, () => fixtureUuid());
    const result = commandEnvelopeBaseSchema.safeParse(fixtureRawCommandEnvelope({ depends_on }));
    expect(result.success).toBe(true);
  });

  it('rejette 51 depends_on (au-delà de la borne)', () => {
    const depends_on = Array.from({ length: 51 }, () => fixtureUuid());
    const result = commandEnvelopeBaseSchema.safeParse(fixtureRawCommandEnvelope({ depends_on }));
    expect(result.success).toBe(false);
  });

  it('accepte 20 attachment_ids (borne haute)', () => {
    const attachment_ids = Array.from({ length: 20 }, () => fixtureUuid());
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ attachment_ids }),
    );
    expect(result.success).toBe(true);
  });

  it('rejette 21 attachment_ids (au-delà de la borne)', () => {
    const attachment_ids = Array.from({ length: 21 }, () => fixtureUuid());
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ attachment_ids }),
    );
    expect(result.success).toBe(false);
  });

  it.each(['occurred_at', 'client_created_at'])(
    'rejette %s sans fuseau (ni Z, ni décalage)',
    (field) => {
      const result = commandEnvelopeBaseSchema.safeParse(
        fixtureRawCommandEnvelope({ [field]: '2026-09-24T10:00:00' }),
      );
      expect(result.success).toBe(false);
    },
  );

  it('accepte un décalage horaire explicite pour occurred_at', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ occurred_at: '2026-09-24T11:00:00+01:00' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejette captured_offline manquant', () => {
    const envelope = fixtureRawCommandEnvelope();
    delete envelope.captured_offline;
    const result = commandEnvelopeBaseSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('rejette backdated_reason vide (doit être null ou non vide)', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ backdated_reason: '' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejette aggregate_type vide', () => {
    const result = commandEnvelopeBaseSchema.safeParse(
      fixtureRawCommandEnvelope({ aggregate_type: '' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('commandEnvelopeSchema', () => {
  const payloadSchema = z.object({ quantity: z.number().positive() });
  const schema = commandEnvelopeSchema(payloadSchema);

  it('valide le payload selon le schéma fourni', () => {
    const result = schema.safeParse(fixtureRawCommandEnvelope({ payload: { quantity: 3 } }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({ quantity: 3 });
    }
  });

  it('rejette un payload qui ne respecte pas le schéma fourni', () => {
    const result = schema.safeParse(fixtureRawCommandEnvelope({ payload: { quantity: -1 } }));
    expect(result.success).toBe(false);
  });

  it('rejette une enveloppe sans payload', () => {
    const envelope = fixtureRawCommandEnvelope();
    delete envelope.payload;
    const result = schema.safeParse(envelope);
    expect(result.success).toBe(false);
  });
});
