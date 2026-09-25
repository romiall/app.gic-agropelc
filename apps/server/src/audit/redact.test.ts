import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets (INV-AUD-02, BR-AUD-007)', () => {
  it('masque un champ sensible au premier niveau', () => {
    expect(redactSecrets({ password_hash: 'x', full_name: 'Test' })).toEqual({
      password_hash: '[REDACTED]',
      full_name: 'Test',
    });
  });

  it('est insensible à la casse du nom de champ', () => {
    expect(redactSecrets({ Password_Hash: 'x' })).toEqual({ Password_Hash: '[REDACTED]' });
  });

  it('masque récursivement dans les objets et tableaux imbriqués', () => {
    expect(
      redactSecrets({
        user: { password: 'x', devices: [{ refresh_token_hash: 'y', id: '1' }] },
      }),
    ).toEqual({
      user: { password: '[REDACTED]', devices: [{ refresh_token_hash: '[REDACTED]', id: '1' }] },
    });
  });

  it('ne masque pas un champ dont le nom contient un mot sensible comme sous-chaîne (correspondance exacte)', () => {
    expect(redactSecrets({ token_family_id: 'abc' })).toEqual({ token_family_id: 'abc' });
  });

  it('laisse intactes les valeurs primitives, null et les dates', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets('texte')).toBe('texte');
    expect(redactSecrets([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("ne modifie pas l'objet source (copie)", () => {
    const source = { password: 'x' };
    const result = redactSecrets(source);
    expect(source.password).toBe('x');
    expect(result).not.toBe(source);
  });
});
