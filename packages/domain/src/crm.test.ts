import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { mergeFieldPatch, normalizePhone } from './crm.js';

describe('normalizePhone — BR-CRM-006', () => {
  it.each([
    ['6 99 12 34 56', '+237699123456'],
    ['699-12-34-56', '+237699123456'],
    ['237 699 12 34 56', '+237699123456'],
    ['00237699123456', '+237699123456'],
    ['+237 (6) 99.12.34.56', '+237699123456'],
    ['+33 6 12 34 56 78', '+33612345678'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw, '237')).toBe(expected);
  });

  it.each(['', 'abc', '12', '+0123456789', '6991234567890123456'])(
    '« %s » : PHONE_INVALID',
    (raw) => {
      expect(() => normalizePhone(raw, '237')).toThrow(DomainError);
    },
  );
});

describe('mergeFieldPatch — matrice des conflits (compte modifié sur deux appareils)', () => {
  const current = { display_name: 'Boutique Mama', address_text: 'Akwa', email: null };
  const fieldVersions = {
    display_name: { version: 3, occurredAt: '2026-10-01T10:00:00.000Z' },
    address_text: { version: 1, occurredAt: '2026-09-01T10:00:00.000Z' },
  };

  it('champs non modifiés côté serveur depuis la version de base : appliqués', () => {
    const { applied, collisions } = mergeFieldPatch({
      patch: { address_text: 'Bonabéri', email: 'mama@example.cm' },
      baseVersion: 2,
      clientOccurredAt: new Date('2026-10-01T09:00:00Z'),
      fieldVersions,
      currentValues: current,
    });
    expect(applied).toEqual({ address_text: 'Bonabéri', email: 'mama@example.cm' });
    expect(collisions).toEqual([]);
  });

  it('collision : la valeur la plus récente (occurred_at) l’emporte, l’autre est rapportée', () => {
    const older = mergeFieldPatch({
      patch: { display_name: 'Chez Mama' },
      baseVersion: 2,
      clientOccurredAt: new Date('2026-10-01T09:00:00Z'),
      fieldVersions,
      currentValues: current,
    });
    expect(older.applied).toEqual({});
    expect(older.collisions).toEqual([
      {
        field: 'display_name',
        clientValue: 'Chez Mama',
        serverValue: 'Boutique Mama',
        winner: 'SERVER',
      },
    ]);

    const newer = mergeFieldPatch({
      patch: { display_name: 'Chez Mama' },
      baseVersion: 2,
      clientOccurredAt: new Date('2026-10-01T11:00:00Z'),
      fieldVersions,
      currentValues: current,
    });
    expect(newer.applied).toEqual({ display_name: 'Chez Mama' });
    expect(newer.collisions[0]!.winner).toBe('CLIENT');
  });

  it('valeur composée identique des deux côtés (position) : ni appliquée ni rapportée', () => {
    const position = { lat: 4.0511, lng: 9.7679, accuracyM: 12 };
    const result = mergeFieldPatch({
      patch: { position: { ...position } },
      baseVersion: 1,
      clientOccurredAt: new Date('2026-10-01T09:00:00Z'),
      fieldVersions: { position: { version: 2, occurredAt: '2026-10-01T08:00:00.000Z' } },
      currentValues: { position },
    });
    expect(result).toEqual({ applied: {}, collisions: [] });
  });

  it('sans version de base (en ligne) : tout le patch s’applique', () => {
    expect(
      mergeFieldPatch({
        patch: { display_name: 'Chez Mama' },
        baseVersion: null,
        clientOccurredAt: new Date('2026-10-01T09:00:00Z'),
        fieldVersions,
        currentValues: current,
      }).applied,
    ).toEqual({ display_name: 'Chez Mama' });
  });
});
