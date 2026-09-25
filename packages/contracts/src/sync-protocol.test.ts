import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  rawCommandEnvelopeSchema,
  pushRequestSchema,
  SYNC_RESULT_STATUSES,
  syncResultStatusSchema,
  commandResultSchema,
  pushResponseSchema,
  DEVICE_SYNC_STATES,
  deviceSyncStateSchema,
  deviceStateAfterResult,
  pullRequestSchema,
  CHANGE_TYPES,
  changeTypeSchema,
  SCOPE_TYPES,
  scopeTypeSchema,
  changeSchema,
  pullResponseSchema,
} from './sync-protocol.js';
import { fixtureRawCommandEnvelope, fixtureUuid } from './test-helpers.js';

describe('rawCommandEnvelopeSchema', () => {
  it('accepte une enveloppe avec un payload arbitraire', () => {
    expect(rawCommandEnvelopeSchema.safeParse(fixtureRawCommandEnvelope()).success).toBe(true);
  });

  it('rejette une enveloppe dont les champs de transport sont invalides', () => {
    const result = rawCommandEnvelopeSchema.safeParse(
      fixtureRawCommandEnvelope({ command_id: 'pas-un-uuid' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('pushRequestSchema', () => {
  function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      device_id: fixtureUuid(),
      batch_id: fixtureUuid(),
      device_sent_at: '2026-09-24T10:00:10.000Z',
      commands: [fixtureRawCommandEnvelope()],
      ...overrides,
    };
  }

  it('accepte une requête avec un lot de 1 à 50 commandes', () => {
    expect(pushRequestSchema.safeParse(validRequest()).success).toBe(true);
    const fifty = Array.from({ length: 50 }, () => fixtureRawCommandEnvelope());
    expect(pushRequestSchema.safeParse(validRequest({ commands: fifty })).success).toBe(true);
  });

  it('rejette un lot vide', () => {
    expect(pushRequestSchema.safeParse(validRequest({ commands: [] })).success).toBe(false);
  });

  it('rejette un lot de plus de 50 commandes', () => {
    const fiftyOne = Array.from({ length: 51 }, () => fixtureRawCommandEnvelope());
    expect(pushRequestSchema.safeParse(validRequest({ commands: fiftyOne })).success).toBe(false);
  });

  it("rejette un device_id qui n'est pas un UUIDv7", () => {
    expect(pushRequestSchema.safeParse(validRequest({ device_id: 'pas-un-uuid' })).success).toBe(
      false,
    );
  });
});

describe('syncResultStatusSchema', () => {
  it.each(SYNC_RESULT_STATUSES)('accepte %s', (status) => {
    expect(syncResultStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejette un statut hors catalogue', () => {
    expect(syncResultStatusSchema.safeParse('UNKNOWN').success).toBe(false);
  });
});

describe('commandResultSchema', () => {
  it('accepte un résultat minimal (command_id + status)', () => {
    const result = commandResultSchema.safeParse({ command_id: fixtureUuid(), status: 'APPLIED' });
    expect(result.success).toBe(true);
  });

  it('accepte un résultat complet', () => {
    const result = commandResultSchema.safeParse({
      command_id: fixtureUuid(),
      status: 'APPLIED_WITH_WARNINGS',
      server_refs: { invoice_number: 'F-2026-000123' },
      warnings: ['STOCK_NEGATIVE'],
      error: { code: 'VALIDATION_ERROR:PRICE_NOT_FOUND', message_fr: 'Prix introuvable.' },
      conflict_id: fixtureUuid(),
    });
    expect(result.success).toBe(true);
  });

  it('rejette un avertissement hors catalogue', () => {
    const result = commandResultSchema.safeParse({
      command_id: fixtureUuid(),
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['NOT_A_WARNING'],
    });
    expect(result.success).toBe(false);
  });

  it('rejette un statut inconnu', () => {
    const result = commandResultSchema.safeParse({ command_id: fixtureUuid(), status: 'UNKNOWN' });
    expect(result.success).toBe(false);
  });
});

describe('pushResponseSchema', () => {
  it("accepte une réponse avec un décalage d'horloge négatif", () => {
    const result = pushResponseSchema.safeParse({
      results: [{ command_id: fixtureUuid(), status: 'APPLIED' }],
      server_time: '2026-09-24T10:00:11.000Z',
      clock_skew_ms: -250,
    });
    expect(result.success).toBe(true);
  });

  it('rejette un clock_skew_ms non entier', () => {
    const result = pushResponseSchema.safeParse({
      results: [],
      server_time: '2026-09-24T10:00:11.000Z',
      clock_skew_ms: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('deviceSyncStateSchema', () => {
  it.each(DEVICE_SYNC_STATES)('accepte %s', (state) => {
    expect(deviceSyncStateSchema.safeParse(state).success).toBe(true);
  });
});

describe('deviceStateAfterResult (BR-SYN-006)', () => {
  it.each([
    ['APPLIED', 'SYNCED'],
    ['APPLIED_WITH_WARNINGS', 'SYNCED_WITH_WARNING'],
    ['CONFLICT', 'CONFLICT'],
    ['REJECTED', 'REJECTED'],
    ['RETRY_LATER', 'PENDING_SYNC'],
  ] as const)('%s → %s', (status, expected) => {
    expect(deviceStateAfterResult(status)).toBe(expected);
  });

  it('est total sur SYNC_RESULT_STATUSES (renvoie toujours un état visible valide)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SYNC_RESULT_STATUSES), (status) => {
        const state = deviceStateAfterResult(status);
        expect((DEVICE_SYNC_STATES as readonly string[]).includes(state)).toBe(true);
      }),
    );
  });
});

describe('pullRequestSchema', () => {
  it('applique la limite par défaut (500) quand elle est omise', () => {
    const result = pullRequestSchema.safeParse({ dataset: 'catalog.products', cursor: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(500);
  });

  it("accepte une limite explicite jusqu'à 2000", () => {
    const result = pullRequestSchema.safeParse({
      dataset: 'catalog.products',
      cursor: 0,
      limit: 2000,
    });
    expect(result.success).toBe(true);
  });

  it('rejette une limite supérieure à 2000', () => {
    const result = pullRequestSchema.safeParse({
      dataset: 'catalog.products',
      cursor: 0,
      limit: 2001,
    });
    expect(result.success).toBe(false);
  });

  it('rejette une limite nulle ou négative', () => {
    expect(
      pullRequestSchema.safeParse({ dataset: 'catalog.products', cursor: 0, limit: 0 }).success,
    ).toBe(false);
  });

  it('rejette un cursor négatif', () => {
    expect(pullRequestSchema.safeParse({ dataset: 'catalog.products', cursor: -1 }).success).toBe(
      false,
    );
  });
});

describe('changeTypeSchema / scopeTypeSchema', () => {
  it.each(CHANGE_TYPES)('accepte le type de changement %s', (value) => {
    expect(changeTypeSchema.safeParse(value).success).toBe(true);
  });

  it.each(SCOPE_TYPES)('accepte le type de portée %s', (value) => {
    expect(scopeTypeSchema.safeParse(value).success).toBe(true);
  });
});

describe('changeSchema', () => {
  it('accepte un UPSERT avec data', () => {
    const result = changeSchema.safeParse({
      seq: 1,
      dataset: 'catalog.products',
      entity_type: 'product',
      entity_id: fixtureUuid(),
      change_type: 'UPSERT',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      data: { name: 'Engrais NPK 20-10-10' },
    });
    expect(result.success).toBe(true);
  });

  it('accepte un DELETE sans data', () => {
    const result = changeSchema.safeParse({
      seq: 2,
      dataset: 'catalog.products',
      entity_type: 'product',
      entity_id: fixtureUuid(),
      change_type: 'DELETE',
      scope_type: 'SITE',
      scope_id: fixtureUuid(),
      row_version: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejette un change_type hors catalogue', () => {
    const result = changeSchema.safeParse({
      seq: 1,
      dataset: 'catalog.products',
      entity_type: 'product',
      entity_id: fixtureUuid(),
      change_type: 'PATCH',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejette seq = 0 (doit être strictement positif)', () => {
    const result = changeSchema.safeParse({
      seq: 0,
      dataset: 'catalog.products',
      entity_type: 'product',
      entity_id: fixtureUuid(),
      change_type: 'UPSERT',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejette row_version négatif', () => {
    const result = changeSchema.safeParse({
      seq: 1,
      dataset: 'catalog.products',
      entity_type: 'product',
      entity_id: fixtureUuid(),
      change_type: 'UPSERT',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: -1,
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('pullResponseSchema', () => {
  it('accepte une réponse de pull valide', () => {
    const result = pullResponseSchema.safeParse({
      changes: [
        {
          seq: 1,
          dataset: 'catalog.products',
          entity_type: 'product',
          entity_id: fixtureUuid(),
          change_type: 'UPSERT',
          scope_type: 'GLOBAL',
          scope_id: null,
          row_version: 1,
          data: {},
        },
      ],
      next_cursor: 1,
      has_more: false,
    });
    expect(result.success).toBe(true);
  });
});
