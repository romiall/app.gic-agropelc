/**
 * Billet de téléchargement d'un volume (AV-539, ADR-070 §6). Un lien ne porte pas l'en-tête `Authorization` : le
 * navigateur télécharge un fichier de plusieurs centaines de Mo par un lien, pas par une lecture en mémoire. L'application
 * demande donc, authentifiée, un **billet** court qui désigne un volume, un utilisateur, son appareil et sa session.
 *
 * Signé ES256 par la clé des jetons d'accès, mais d'une **autre nature** : `typ: attachment-archive-download`, sans
 * `sub`, `device_id` ni `session_id`. `verifyAccessToken` le refuse (revendications incomplètes) et
 * {@link verifyArchiveTicket} refuse un jeton d'accès (pas de `typ`). Valable 10 minutes ; le serveur revérifie à chaque
 * appel la session, le compte, l'appareil et le droit.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';

const ALG = 'ES256';
const TYP = 'attachment-archive-download';
export const ARCHIVE_TICKET_TTL_MS = 10 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArchiveTicketClaims {
  readonly volumeId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}

export async function signArchiveTicket(
  privateKey: CryptoKey,
  claims: ArchiveTicketClaims,
  now: Date,
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + ARCHIVE_TICKET_TTL_MS);
  const token = await new SignJWT({
    typ: TYP,
    vol: claims.volumeId,
    uid: claims.userId,
    did: claims.deviceId,
    sid: claims.sessionId,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(privateKey);
  return { token, expiresAt };
}

export type VerifyArchiveTicketResult =
  | { readonly ok: true; readonly claims: ArchiveTicketClaims }
  | { readonly ok: false; readonly reason: 'EXPIRED' | 'INVALID' };

export async function verifyArchiveTicket(
  publicKey: CryptoKey,
  token: string,
  now: Date,
): Promise<VerifyArchiveTicketResult> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, { algorithms: [ALG], currentDate: now }));
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.name === 'JWTExpired' ? 'EXPIRED' : 'INVALID',
    };
  }
  const { typ, vol, uid, did, sid } = payload as Record<string, unknown>;
  if (
    typ !== TYP ||
    typeof vol !== 'string' ||
    typeof uid !== 'string' ||
    typeof did !== 'string' ||
    typeof sid !== 'string' ||
    ![vol, uid, did, sid].every((value) => UUID.test(value)) ||
    'sub' in payload
  ) {
    return { ok: false, reason: 'INVALID' };
  }
  return { ok: true, claims: { volumeId: vol, userId: uid, deviceId: did, sessionId: sid } };
}
