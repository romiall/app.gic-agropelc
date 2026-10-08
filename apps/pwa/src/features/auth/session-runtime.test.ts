import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GicDatabase } from '../../storage/db.js';
import {
  clearSessionRuntime,
  ensureAccessToken,
  getSessionRuntime,
  setSessionRuntime,
  type SessionRuntime,
} from './session-runtime.js';

const update = vi.fn(async () => 1);
const db = { session: { update } } as unknown as GicDatabase;

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function expiredSession(): Promise<SessionRuntime> {
  return {
    userId: 'u',
    deviceId: 'd',
    deviceStatus: 'ACTIVE',
    refreshToken: 'refresh-1',
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
    pinKey: await aesKey(),
  };
}

function refreshResponse(suffix: string): Response {
  return new Response(
    JSON.stringify({
      access_token: `access-${suffix}`,
      refresh_token: `refresh-${suffix}`,
      expires_in: 900,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(async () => {
  update.mockClear();
  setSessionRuntime(await expiredSession());
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionRuntime();
});

describe('ensureAccessToken', () => {
  it('jeton encore valide : aucun appel réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = getSessionRuntime()!;
    session.accessToken = 'access-0';
    session.accessTokenExpiresAt = Date.now() + 5 * 60_000;
    expect(await ensureAccessToken(db)).toEqual({ ok: true, accessToken: 'access-0' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appels simultanés : un seul renouvellement, tous reçoivent le même jeton', async () => {
    // Le serveur fait tourner le jeton de rafraîchissement et refuse sa réutilisation : un
    // second appel parallèle avec `refresh-1` serait refusé et viderait la session.
    const fetchMock = vi.fn(async () => refreshResponse('2'));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([
      ensureAccessToken(db),
      ensureAccessToken(db),
      ensureAccessToken(db),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { ok: true, accessToken: 'access-2' },
      { ok: true, accessToken: 'access-2' },
      { ok: true, accessToken: 'access-2' },
    ]);
    // Le nouveau jeton de rafraîchissement est gardé en mémoire et rechiffré une seule fois.
    expect(getSessionRuntime()!.refreshToken).toBe('refresh-2');
    expect(update).toHaveBeenCalledTimes(1);

    // Le jeton d'accès est désormais valide : plus aucun appel.
    expect(await ensureAccessToken(db)).toEqual({ ok: true, accessToken: 'access-2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refus du serveur : tous les appelants simultanés reçoivent SESSION_INVALID, la session est vidée', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([ensureAccessToken(db), ensureAccessToken(db)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { ok: false, reason: 'SESSION_INVALID' },
      { ok: false, reason: 'SESSION_INVALID' },
    ]);
    expect(getSessionRuntime()).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('hors ligne : OFFLINE pour tous, la session est conservée et le prochain appel réessaie', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(refreshResponse('3'));
    vi.stubGlobal('fetch', fetchMock);

    const offline = await Promise.all([ensureAccessToken(db), ensureAccessToken(db)]);
    expect(offline).toEqual([
      { ok: false, reason: 'OFFLINE' },
      { ok: false, reason: 'OFFLINE' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSessionRuntime()?.refreshToken).toBe('refresh-1');

    // Le renouvellement raté n'est pas resté « en vol » : le suivant repart.
    expect(await ensureAccessToken(db)).toEqual({ ok: true, accessToken: 'access-3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sans session : SESSION_INVALID sans appel réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    clearSessionRuntime();
    expect(await ensureAccessToken(db)).toEqual({ ok: false, reason: 'SESSION_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
