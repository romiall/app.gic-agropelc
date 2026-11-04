/**
 * Journal d'un refus de requête (ADR-052) : la ligne nomme la méthode et le chemin (sans paramètres), l'appareil et
 * l'utilisateur quand la requête est authentifiée, et le motif d'une requête mal formée (texte rendu à l'appelant,
 * borné, jamais la charge). Aucune base : fonction pure.
 */
import { describe, expect, it } from 'vitest';
import { refusalLogEntry } from '../src/platform/http/api-error.filter.js';

const request = (overrides: Partial<Parameters<typeof refusalLogEntry>[3]> = {}) => ({
  method: 'POST',
  url: '/api/v1/sync/push?secret=1',
  correlationId: '01900000-0000-7000-8000-000000000abc',
  auth: {
    sub: '01900000-0000-7000-8000-000000000001',
    device_id: '01900000-0000-7000-8000-0000000000d0',
  },
  ...overrides,
});

describe('journal d’un refus de requête', () => {
  it('une requête mal formée : méthode, chemin sans paramètres, appareil, utilisateur et motif', () => {
    const entry = refusalLogEntry(
      'VALIDATION_ERROR',
      400,
      'Corps de requête invalide : commands.3.aggregate_id : UUIDv7 attendu (ADR-002).',
      request(),
    );
    expect(entry.line).toBe(
      'Requête refusée : VALIDATION_ERROR (POST /api/v1/sync/push) : Corps de requête invalide : commands.3.aggregate_id : UUIDv7 attendu (ADR-002).',
    );
    expect(entry.fields).toMatchObject({
      module: 'http',
      code: 'VALIDATION_ERROR',
      correlationId: '01900000-0000-7000-8000-000000000abc',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceId: '01900000-0000-7000-8000-0000000000d0',
    });
    // Les paramètres de la requête n'atteignent jamais le journal.
    expect(entry.line).not.toContain('secret');
  });

  it('le motif est borné', () => {
    const entry = refusalLogEntry('VALIDATION_ERROR', 400, 'x'.repeat(2000), request());
    expect(entry.line.length).toBeLessThan(400);
  });

  it('un refus qui n’est pas une requête mal formée ne reporte pas de motif', () => {
    const entry = refusalLogEntry(
      'FORBIDDEN',
      403,
      'Droit manquant pour ce client précis.',
      request(),
    );
    expect(entry.line).toBe('Requête refusée : FORBIDDEN (POST /api/v1/sync/push)');
  });

  it('une requête non authentifiée (connexion) : pas d’appareil ni d’utilisateur', () => {
    const entry = refusalLogEntry(
      'VALIDATION_ERROR',
      400,
      'Corps de requête invalide : UUIDv7 attendu (ADR-002).',
      request({ url: '/api/v1/auth/login', auth: undefined }),
    );
    expect(entry.fields.userId).toBeUndefined();
    expect(entry.fields.deviceId).toBeUndefined();
    expect(entry.line).toContain('(POST /api/v1/auth/login)');
  });
});
