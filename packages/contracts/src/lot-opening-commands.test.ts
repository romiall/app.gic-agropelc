import { describe, expect, it } from 'vitest';
import {
  LOT_OPENING_AGGREGATE_TYPE,
  LOT_OPENING_POST_COMMAND,
  lotOpeningPostPayloadSchema,
} from './lot-opening-commands.js';
import { commandTypeSchema } from './command-envelope.js';

const UUID = '01900000-0000-7000-8000-000000000001';

const valid = {
  lotType: 'POULET_CHAIR',
  productId: UUID,
  mainLocationId: UUID,
  placedOn: '2026-10-05',
  quantity: 4800,
  valueXaf: 5_760_000,
};

describe('production.lot_opening.post : charge utile (ADR-069)', () => {
  it('le type de commande suit <module>.<agrégat>.<verbe> et nomme son agrégat', () => {
    expect(commandTypeSchema.safeParse(LOT_OPENING_POST_COMMAND).success).toBe(true);
    expect(LOT_OPENING_AGGREGATE_TYPE).toBe('PRODUCTION_LOT_OPENING');
  });

  it('accepte une reprise minimale et une reprise complète', () => {
    expect(lotOpeningPostPayloadSchema.safeParse(valid).success).toBe(true);
    const full = {
      ...valid,
      supplierId: UUID,
      strain: ' Cobb 500 ',
      avgWeightG: 1250.5,
      notes: 'Bande de la ferme',
    };
    const parsed = lotOpeningPostPayloadSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    // Les textes sont rognés.
    expect(parsed.success && parsed.data.strain).toBe('Cobb 500');
  });

  it('refuse un champ inconnu (aucune faute de frappe silencieuse)', () => {
    expect(lotOpeningPostPayloadSchema.safeParse({ ...valid, quantite: 3 }).success).toBe(false);
  });

  it('borne l’effectif, la valeur, le type et la date', () => {
    const refused = (overrides: Record<string, unknown>) =>
      lotOpeningPostPayloadSchema.safeParse({ ...valid, ...overrides }).success;
    expect(refused({ quantity: 0 })).toBe(false);
    expect(refused({ quantity: 1.5 })).toBe(false);
    expect(refused({ quantity: 1_000_001 })).toBe(false);
    expect(refused({ valueXaf: -1 })).toBe(false);
    expect(refused({ valueXaf: 1.5 })).toBe(false);
    expect(refused({ valueXaf: 0 })).toBe(true);
    expect(refused({ lotType: 'LAPINS' })).toBe(false);
    expect(refused({ placedOn: '05/10/2026' })).toBe(false);
    expect(refused({ productId: 'pas-un-uuid' })).toBe(false);
    expect(refused({ avgWeightG: 0 })).toBe(false);
    expect(refused({ strain: '' })).toBe(false);
  });
});
