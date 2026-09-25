import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandRegistry } from './command-registry.js';
import { fixtureRawCommandEnvelope } from './test-helpers.js';

describe('CommandRegistry.register', () => {
  it('enregistre un type de commande valide', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number() }));
    expect(registry.has('sales.sale.record', 1)).toBe(true);
  });

  it('refuse un command_type au mauvais format', () => {
    const registry = new CommandRegistry();
    expect(() => registry.register('invalide', 1, z.object({}))).toThrow();
  });

  it('refuse un doublon (même command_type, même version)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({}));
    expect(() => registry.register('sales.sale.record', 1, z.object({}))).toThrow();
  });

  it('accepte deux versions du même command_type (compatibilité N-1, BR-SYN-016)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number() }));
    registry.register('sales.sale.record', 2, z.object({ quantity: z.number(), note: z.string() }));
    expect(registry.has('sales.sale.record', 1)).toBe(true);
    expect(registry.has('sales.sale.record', 2)).toBe(true);
  });
});

describe('CommandRegistry.has', () => {
  it('renvoie false pour un type ou une version non enregistrés', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({}));
    expect(registry.has('sales.sale.record', 2)).toBe(false);
    expect(registry.has('inventory.stock_count.close', 1)).toBe(false);
  });
});

describe('CommandRegistry.versionsOf', () => {
  it('renvoie un tableau vide pour un command_type inconnu', () => {
    const registry = new CommandRegistry();
    expect(registry.versionsOf('sales.sale.record')).toEqual([]);
  });

  it('renvoie les versions triées par ordre croissant', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 2, z.object({}));
    registry.register('sales.sale.record', 1, z.object({}));
    registry.register('sales.sale.record', 3, z.object({}));
    expect(registry.versionsOf('sales.sale.record')).toEqual([1, 2, 3]);
  });
});

describe('CommandRegistry.parse', () => {
  it('valide une enveloppe correcte et renvoie un payload typé', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number().positive() }));
    const result = registry.parse(fixtureRawCommandEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.payload).toEqual({ quantity: 3 });
      expect(result.envelope.depends_on).toEqual([]);
    }
  });

  it('rejette une enveloppe structurellement invalide (VALIDATION_ERROR)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number() }));
    const result = registry.parse(fixtureRawCommandEnvelope({ command_id: 'pas-un-uuid' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('VALIDATION_ERROR');
      expect(result.issues).toBeDefined();
    }
  });

  it('rejette un command_type jamais enregistré (UNKNOWN_COMMAND_TYPE)', () => {
    const registry = new CommandRegistry();
    const result = registry.parse(fixtureRawCommandEnvelope());
    expect(result).toEqual({ ok: false, reason: 'UNKNOWN_COMMAND_TYPE' });
  });

  it('rejette une version non enregistrée pour un command_type connu (UNSUPPORTED_VERSION)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({}));
    const result = registry.parse(fixtureRawCommandEnvelope({ command_version: 2 }));
    expect(result).toEqual({ ok: false, reason: 'UNSUPPORTED_VERSION' });
  });

  it('rejette un payload qui ne respecte pas le schéma enregistré (VALIDATION_ERROR)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number().positive() }));
    const result = registry.parse(fixtureRawCommandEnvelope({ payload: { quantity: -1 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('VALIDATION_ERROR');
    }
  });

  it('résout le schéma exact de la version reçue (coexistence N-1)', () => {
    const registry = new CommandRegistry();
    registry.register('sales.sale.record', 1, z.object({ quantity: z.number() }));
    registry.register('sales.sale.record', 2, z.object({ quantity: z.number(), note: z.string() }));

    const v1 = registry.parse(
      fixtureRawCommandEnvelope({ command_version: 1, payload: { quantity: 5 } }),
    );
    expect(v1.ok).toBe(true);
    if (v1.ok) expect(v1.envelope.payload).toEqual({ quantity: 5 });

    const v2 = registry.parse(
      fixtureRawCommandEnvelope({
        command_version: 2,
        payload: { quantity: 5, note: 'rattrapage' },
      }),
    );
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.envelope.payload).toEqual({ quantity: 5, note: 'rattrapage' });

    const v2InvalidPayload = registry.parse(
      fixtureRawCommandEnvelope({ command_version: 2, payload: { quantity: 5 } }),
    );
    expect(v2InvalidPayload.ok).toBe(false);
  });
});
