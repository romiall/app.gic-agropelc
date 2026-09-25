import { describe, expect, it } from 'vitest';
import {
  SYNC_PROTOCOL_ERROR_CODES,
  isSyncProtocolErrorCode,
  WARNING_CODES,
  warningCodeSchema,
  errorCodeSchema,
  apiErrorSchema,
} from './error-codes.js';

describe('isSyncProtocolErrorCode', () => {
  it.each(SYNC_PROTOCOL_ERROR_CODES)('reconnaît %s comme code du protocole', (code) => {
    expect(isSyncProtocolErrorCode(code)).toBe(true);
  });

  it.each(['INSUFFICIENT_STOCK', 'VALIDATION_ERROR:PRICE_NOT_FOUND', '', 'forbidden'])(
    'rejette %s (code métier ou chaîne hors catalogue)',
    (code) => {
      expect(isSyncProtocolErrorCode(code)).toBe(false);
    },
  );
});

describe('warningCodeSchema', () => {
  it.each(WARNING_CODES)('accepte %s', (code) => {
    expect(warningCodeSchema.safeParse(code).success).toBe(true);
  });

  it('rejette un avertissement hors catalogue', () => {
    expect(warningCodeSchema.safeParse('UNKNOWN_WARNING').success).toBe(false);
  });
});

describe('errorCodeSchema', () => {
  it.each([
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'VALIDATION_ERROR:PRICE_NOT_FOUND',
    'INSUFFICIENT_STOCK',
    'A',
    'A1',
    'A_B_C:D_E_F',
    'A'.repeat(100),
  ])('accepte %s', (code) => {
    expect(errorCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each([
    '',
    'forbidden',
    'Forbidden',
    '1FORBIDDEN',
    'FORBIDDEN:',
    'FORBIDDEN::DETAIL',
    'FORBIDDEN DETAIL',
    'FORBIDDEN-DETAIL',
    'A'.repeat(101),
  ])('rejette %s', (code) => {
    expect(errorCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('apiErrorSchema', () => {
  it('accepte une erreur minimale (code + message)', () => {
    const result = apiErrorSchema.safeParse({
      error: { code: 'FORBIDDEN', message: 'Accès refusé.' },
    });
    expect(result.success).toBe(true);
  });

  it('accepte une erreur complète (details, correlation_id)', () => {
    const result = apiErrorSchema.safeParse({
      error: {
        code: 'VALIDATION_ERROR:PRICE_NOT_FOUND',
        message: 'Prix introuvable.',
        details: { product_id: 'abc' },
        correlation_id: 'a1b2c3d4-e5f6-4789-8abc-1234567890ab',
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejette un correlation_id qui n'est pas un UUID", () => {
    const result = apiErrorSchema.safeParse({
      error: { code: 'FORBIDDEN', message: 'Accès refusé.', correlation_id: 'pas-un-uuid' },
    });
    expect(result.success).toBe(false);
  });

  it('rejette un message vide', () => {
    const result = apiErrorSchema.safeParse({ error: { code: 'FORBIDDEN', message: '' } });
    expect(result.success).toBe(false);
  });

  it('rejette un code au mauvais format', () => {
    const result = apiErrorSchema.safeParse({
      error: { code: 'forbidden', message: 'Accès refusé.' },
    });
    expect(result.success).toBe(false);
  });
});
