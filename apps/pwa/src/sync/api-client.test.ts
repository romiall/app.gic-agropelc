/**
 * MP-11 (AV-282, blocage immédiat) : un 401 du serveur sur un jeton encore valable localement fait
 * renouveler le jeton une fois, puis rejouer l'appel ; un refus du renouvellement vide la session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GicDatabase } from '../storage/db.js';
import {
  clearSessionRuntime,
  expireAccessToken,
  getSessionRuntime,
  setSessionRuntime,
} from '../features/auth/session-runtime.js';
import { authorizedRequest } from './api-client.js';
import { fetchAttachmentContent } from './attachment-content.js';

const update = vi.fn(async () => 1);
const db = { session: { update } } as unknown as GicDatabase;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const unauthenticated = () =>
  json(401, { error: { code: 'UNAUTHENTICATED', details: { reason: 'SESSION_REVOKED' } } });
const refreshed = (suffix: string) =>
  json(200, {
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_in: 900,
  });

/** Réponses de `fetch` par chemin, dans l'ordre ; les jetons présentés sont relevés. */
function stubFetch(routes: Record<string, (() => Response)[]>) {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = Object.keys(routes).find((candidate) => url.endsWith(candidate));
    if (!path) throw new Error(`appel inattendu : ${url}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ path, authorization: headers.authorization });
    const next = routes[path]!.shift();
    if (!next) throw new Error(`réponse manquante : ${path}`);
    return next();
  });
  vi.stubGlobal('fetch', mock);
  return seen;
}

beforeEach(async () => {
  update.mockClear();
  setSessionRuntime({
    userId: 'u',
    deviceId: 'd',
    deviceStatus: 'ACTIVE',
    refreshToken: 'refresh-0',
    accessToken: 'access-0',
    accessTokenExpiresAt: Date.now() + 10 * 60_000,
    pinKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionRuntime();
});

describe('authorizedRequest : 401 (MP-11)', () => {
  it('jeton refusé : renouvelé une fois, l’appel est rejoué avec le nouveau jeton', async () => {
    const seen = stubFetch({
      '/api/v1/home': [unauthenticated, () => json(200, { ok: 1 })],
      '/api/v1/auth/refresh': [() => refreshed('1')],
    });
    expect(await authorizedRequest(db, '/api/v1/home', { method: 'GET' })).toEqual({
      ok: true,
      data: { ok: 1 },
    });
    expect(seen).toEqual([
      { path: '/api/v1/home', authorization: 'Bearer access-0' },
      { path: '/api/v1/auth/refresh', authorization: undefined },
      { path: '/api/v1/home', authorization: 'Bearer access-1' },
    ]);
  });

  it('renouvellement refusé (session révoquée) : SESSION_INVALID, session vidée, rien de rejoué', async () => {
    const seen = stubFetch({
      '/api/v1/sync/push': [unauthenticated],
      '/api/v1/auth/refresh': [() => json(401, { error: { code: 'INVALID_REFRESH_TOKEN' } })],
    });
    expect(
      await authorizedRequest(db, '/api/v1/sync/push', { method: 'POST', body: '{}' }),
    ).toEqual({ ok: false, reason: 'SESSION_INVALID' });
    expect(getSessionRuntime()).toBeUndefined();
    expect(seen.map((call) => call.path)).toEqual(['/api/v1/sync/push', '/api/v1/auth/refresh']);
  });

  it('second 401 après un renouvellement réussi : erreur HTTP, pas de troisième essai', async () => {
    const seen = stubFetch({
      '/api/v1/home': [unauthenticated, unauthenticated],
      '/api/v1/auth/refresh': [() => refreshed('1')],
    });
    const result = await authorizedRequest(db, '/api/v1/home', { method: 'GET' });
    expect(result).toMatchObject({ ok: false, reason: 'HTTP_ERROR', status: 401 });
    expect(seen).toHaveLength(3);
  });

  it('autre refus (403) : rendu tel quel, sans renouvellement', async () => {
    const seen = stubFetch({ '/api/v1/home': [() => json(403, { error: { code: 'FORBIDDEN' } })] });
    expect(await authorizedRequest(db, '/api/v1/home', { method: 'GET' })).toMatchObject({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 403,
    });
    expect(seen).toHaveLength(1);
  });

  it('expireAccessToken : sans effet sur un jeton déjà remplacé', () => {
    const session = getSessionRuntime()!;
    const expiresAt = session.accessTokenExpiresAt;
    expireAccessToken('access-ancien');
    expect(session.accessTokenExpiresAt).toBe(expiresAt);
    expireAccessToken('access-0');
    expect(session.accessTokenExpiresAt).toBe(0);
  });
});

describe('fetchAttachmentContent : 401 (MP-11)', () => {
  it('jeton refusé : renouvelé une fois, la lecture est rejouée', async () => {
    const seen = stubFetch({
      '/api/v1/attachments/p1/content': [unauthenticated, () => new Response('octets')],
      '/api/v1/auth/refresh': [() => refreshed('1')],
    });
    const result = await fetchAttachmentContent(db, 'p1');
    expect(result.ok).toBe(true);
    expect(seen.map((call) => call.authorization)).toEqual([
      'Bearer access-0',
      undefined,
      'Bearer access-1',
    ]);
  });

  it('renouvellement refusé : SESSION_INVALID', async () => {
    stubFetch({
      '/api/v1/attachments/p1/content': [unauthenticated],
      '/api/v1/auth/refresh': [() => json(401, {})],
    });
    expect(await fetchAttachmentContent(db, 'p1')).toEqual({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('second 401 : SESSION_INVALID sans troisième essai', async () => {
    const seen = stubFetch({
      '/api/v1/attachments/p1/content': [unauthenticated, unauthenticated],
      '/api/v1/auth/refresh': [() => refreshed('1')],
    });
    expect(await fetchAttachmentContent(db, 'p1')).toEqual({
      ok: false,
      reason: 'SESSION_INVALID',
    });
    expect(seen).toHaveLength(3);
  });
});
