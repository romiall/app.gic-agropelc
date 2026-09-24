import { beforeAll, describe, expect, it } from 'vitest';
import type { JwtKeyPair } from './jwt.js';
import {
  ACCESS_TOKEN_TTL_MS,
  exportKeyPairToPem,
  generateEphemeralKeyPair,
  loadKeyPairFromPem,
  signAccessToken,
  verifyAccessToken,
} from './jwt.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const CLAIMS = {
  sub: '0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11',
  device_id: '0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a12',
  session_id: '0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a13',
};

describe('jwt (07-security-rbac/02-securite.md §3)', () => {
  let keys: JwtKeyPair;

  beforeAll(async () => {
    keys = await generateEphemeralKeyPair();
  });

  it('signe puis vérifie un jeton valide (aller-retour des revendications)', async () => {
    const token = await signAccessToken(keys.privateKey, CLAIMS, NOW);
    const result = await verifyAccessToken(keys.publicKey, token, NOW);
    expect(result).toEqual({ ok: true, claims: CLAIMS });
  });

  it('rejette un jeton expiré (> 15 min, EXPIRED)', async () => {
    const token = await signAccessToken(keys.privateKey, CLAIMS, NOW);
    const later = new Date(NOW.getTime() + ACCESS_TOKEN_TTL_MS + 1000);
    const result = await verifyAccessToken(keys.publicKey, token, later);
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('accepte un jeton encore valide juste avant expiration', async () => {
    const token = await signAccessToken(keys.privateKey, CLAIMS, NOW);
    const justBefore = new Date(NOW.getTime() + ACCESS_TOKEN_TTL_MS - 1000);
    const result = await verifyAccessToken(keys.publicKey, token, justBefore);
    expect(result.ok).toBe(true);
  });

  it('rejette un jeton signé par une autre paire de clés (INVALID_SIGNATURE)', async () => {
    const token = await signAccessToken(keys.privateKey, CLAIMS, NOW);
    const otherKeys = await generateEphemeralKeyPair();
    const result = await verifyAccessToken(otherKeys.publicKey, token, NOW);
    expect(result).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('rejette un jeton dont les revendications ne sont pas des UUIDv7 (MALFORMED_CLAIMS)', async () => {
    const token = await signAccessToken(keys.privateKey, { ...CLAIMS, sub: 'pas-un-uuid' }, NOW);
    const result = await verifyAccessToken(keys.publicKey, token, NOW);
    expect(result).toEqual({ ok: false, reason: 'MALFORMED_CLAIMS' });
  });

  it('ne porte aucun droit dans le jeton (§3 : contenu minimal sub/device_id/session_id)', async () => {
    const token = await signAccessToken(keys.privateKey, CLAIMS, NOW);
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['device_id', 'exp', 'iat', 'session_id', 'sub']);
  });

  it('exportKeyPairToPem/loadKeyPairFromPem : une paire rechargée depuis PEM vérifie les mêmes jetons', async () => {
    const { privatePem, publicPem } = await exportKeyPairToPem(keys);
    const reloaded = await loadKeyPairFromPem(privatePem, publicPem);
    const token = await signAccessToken(reloaded.privateKey, CLAIMS, NOW);
    const result = await verifyAccessToken(reloaded.publicKey, token, NOW);
    expect(result).toEqual({ ok: true, claims: CLAIMS });
  });
});
