import { afterEach, describe, expect, it, vi } from 'vitest';
import { changePassword } from './change-password.js';

const input = { accessToken: 'jeton', currentPassword: 'provisoire1', newPassword: 'personnel-1' };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('changePassword (MP-08, AV-251)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 : appel authentifié par le jeton de la connexion, corps attendu par le serveur', async () => {
    const fetchMock = vi.fn(async () => reply(200, { status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await changePassword(input)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/auth\/change-password$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jeton');
    expect(JSON.parse(init.body as string)).toEqual({
      current_password: 'provisoire1',
      new_password: 'personnel-1',
    });
    // MP-11 : une demande sans réponse est abandonnée (comptée hors ligne), l'écran ne reste pas figé.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sans réponse dans le délai : OFFLINE (MP-11)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('délai dépassé', 'TimeoutError');
      }),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'OFFLINE' });
  });

  it('401 : mot de passe actuel faux, ou jeton expiré ; 429 ; 400 avec le défaut ; réseau', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(401, { error: { code: 'INVALID_CREDENTIALS' } })),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'INVALID_CURRENT' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(401, { error: { code: 'UNAUTHENTICATED' } })),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(429, { error: { code: 'LOGIN_LOCKED' } })),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'LOCKED' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(400, { error: { code: 'PASSWORD_INVALID', details: { problem: 'UNCHANGED' } } }),
      ),
    );
    expect(await changePassword(input)).toEqual({
      ok: false,
      reason: 'INVALID_NEW',
      problem: 'UNCHANGED',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(503, {})),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'OFFLINE' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('réseau');
      }),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'OFFLINE' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(500, {})),
    );
    expect(await changePassword(input)).toEqual({ ok: false, reason: 'UNKNOWN', status: 500 });
  });
});
