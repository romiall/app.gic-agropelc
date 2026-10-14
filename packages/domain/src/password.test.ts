import { describe, expect, it } from 'vitest';
import {
  LOGIN_PASSWORD_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  newPasswordProblem,
} from './password.js';

describe('password (MP-08, AV-008, AV-280)', () => {
  it('longueur de 8 à 128 caractères, comptés en caractères et non en octets', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(LOGIN_PASSWORD_MAX_LENGTH).toBeGreaterThan(PASSWORD_MAX_LENGTH);
    expect(newPasswordProblem({ password: '1234567' })).toBe('TOO_SHORT');
    expect(newPasswordProblem({ password: '12345678' })).toBeNull();
    expect(newPasswordProblem({ password: 'é'.repeat(8) })).toBeNull();
    expect(newPasswordProblem({ password: 'x'.repeat(128) })).toBeNull();
    expect(newPasswordProblem({ password: 'x'.repeat(129) })).toBe('TOO_LONG');
  });

  it('identique au mot de passe remplacé : refusé ; confirmation différente : refusée', () => {
    expect(newPasswordProblem({ password: 'provisoire1', current: 'provisoire1' })).toBe(
      'UNCHANGED',
    );
    expect(newPasswordProblem({ password: 'nouveau-123', current: 'provisoire1' })).toBeNull();
    expect(newPasswordProblem({ password: 'nouveau-123', confirmation: 'nouveau-124' })).toBe(
      'MISMATCH',
    );
    expect(
      newPasswordProblem({
        password: 'nouveau-123',
        current: 'provisoire1',
        confirmation: 'nouveau-123',
      }),
    ).toBeNull();
    // La longueur passe avant la comparaison : un mot de passe trop court reste « trop court ».
    expect(newPasswordProblem({ password: 'abc', current: 'abc' })).toBe('TOO_SHORT');
  });
});
