/**
 * Jetons d'accès (07-security-rbac/02-securite.md §3) : JWT signé ES256, durée 15 min,
 * contenu minimal `sub`/`device_id`/`session_id`. **Aucun droit dans le jeton** : les
 * droits sont relus côté serveur à chaque requête (identity/rights-check.ts).
 *
 * Émission complète (P0-09, `/auth/login`) : ce module ne fait aujourd'hui que la partie
 * commune signature/vérification, utilisée ici par les tests du pipeline pour simuler un
 * jeton déjà émis, en attendant l'émission réelle après contrôle des identifiants.
 */
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';
import type { CryptoKey } from 'jose';
import { isUuidv7 } from '@gic/domain';

const ALG = 'ES256';
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface JwtKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

export interface AccessTokenClaims {
  /** `identity_users.id` (UUID texte, §2 « Identifiants »). */
  readonly sub: string;
  readonly device_id: string;
  readonly session_id: string;
}

export async function generateEphemeralKeyPair(): Promise<JwtKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  return { privateKey, publicKey };
}

export async function loadKeyPairFromPem(
  privatePem: string,
  publicPem: string,
): Promise<JwtKeyPair> {
  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(privatePem, ALG),
    importSPKI(publicPem, ALG),
  ]);
  return { privateKey, publicKey };
}

/** Sérialisation PEM, utilisée pour journaliser où provient la paire éphémère (jamais loguée elle-même). */
export async function exportKeyPairToPem(
  keys: JwtKeyPair,
): Promise<{ privatePem: string; publicPem: string }> {
  const [privatePem, publicPem] = await Promise.all([
    exportPKCS8(keys.privateKey),
    exportSPKI(keys.publicKey),
  ]);
  return { privatePem, publicPem };
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: AccessTokenClaims,
  now: Date,
): Promise<string> {
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = Math.floor((now.getTime() + ACCESS_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(privateKey);
}

export type VerifyAccessTokenResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: 'EXPIRED' | 'INVALID_SIGNATURE' | 'MALFORMED_CLAIMS' };

export async function verifyAccessToken(
  publicKey: CryptoKey,
  token: string,
  now: Date,
): Promise<VerifyAccessTokenResult> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, { algorithms: [ALG], currentDate: now }));
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') {
      return { ok: false, reason: 'EXPIRED' };
    }
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  const { sub, device_id: deviceId, session_id: sessionId } = payload;
  if (
    typeof sub !== 'string' ||
    !isUuidv7(sub) ||
    typeof deviceId !== 'string' ||
    !isUuidv7(deviceId) ||
    typeof sessionId !== 'string' ||
    !isUuidv7(sessionId)
  ) {
    return { ok: false, reason: 'MALFORMED_CLAIMS' };
  }
  return { ok: true, claims: { sub, device_id: deviceId, session_id: sessionId } };
}
