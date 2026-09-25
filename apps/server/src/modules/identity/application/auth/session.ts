/**
 * Émission et rotation de session (07-security-rbac/02-securite.md §3). Une session =
 * une ligne `identity_auth_sessions` ; la rotation **insère une nouvelle ligne** (même
 * `token_family_id`) et marque l'ancienne `ROTATED` plutôt que de réécrire son
 * `refresh_token_hash` en place — condition nécessaire pour détecter une réutilisation
 * (une ligne déjà révoquée retrouvée par hash = jeton déjà tourné, présenté une seconde fois).
 */
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';
import { revokeSessionFamily } from '../commands/revoke-sessions.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours glissants (§3)
const OFFLINE_GRANT_MS = 7 * 24 * 60 * 60 * 1000; // BR-ADM-023

export interface IssuedSession {
  readonly sessionId: string;
  readonly refreshToken: string;
}

export async function createSession(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly now: Date;
    readonly ip: string | null;
  },
): Promise<IssuedSession> {
  const sessionId = idGenerator.newId();
  const tokenFamilyId = idGenerator.newId();
  const refreshToken = generateRefreshToken();
  await uow
    .insertInto('identity_auth_sessions')
    .values({
      id: toBin(sessionId),
      user_id: toBin(input.userId),
      device_id: toBin(input.deviceId),
      refresh_token_hash: hashRefreshToken(refreshToken),
      token_family_id: toBin(tokenFamilyId),
      expires_at: new Date(input.now.getTime() + REFRESH_TOKEN_TTL_MS),
      offline_grant_until: new Date(input.now.getTime() + OFFLINE_GRANT_MS),
      ip_first: input.ip,
      ip_last: input.ip,
    })
    .execute();
  return { sessionId, refreshToken };
}

export type RefreshOutcome =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly userId: string;
      readonly deviceId: string;
      readonly refreshToken: string;
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'SESSION_EXPIRED' }
  | {
      readonly ok: false;
      readonly reason: 'TOKEN_REUSE';
      readonly userId: string;
      readonly deviceId: string;
    };

export async function rotateSession(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  presentedToken: string,
  now: Date,
  ip: string | null,
): Promise<RefreshOutcome> {
  const row = await uow
    .selectFrom('identity_auth_sessions')
    .select(['id', 'user_id', 'device_id', 'token_family_id', 'revoked_at', 'expires_at'])
    .where('refresh_token_hash', '=', hashRefreshToken(presentedToken))
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'NOT_FOUND' };

  if (row.revoked_at !== null) {
    await revokeSessionFamily(uow, row.token_family_id, 'TOKEN_REUSE', now);
    return {
      ok: false,
      reason: 'TOKEN_REUSE',
      userId: fromBin(row.user_id),
      deviceId: fromBin(row.device_id),
    };
  }
  if (row.expires_at <= now) {
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }

  const newSessionId = idGenerator.newId();
  const refreshToken = generateRefreshToken();
  await uow
    .updateTable('identity_auth_sessions')
    .set({ revoked_at: now, revoked_reason: 'ROTATED' })
    .where('id', '=', row.id)
    .execute();
  await uow
    .insertInto('identity_auth_sessions')
    .values({
      id: toBin(newSessionId),
      user_id: row.user_id,
      device_id: row.device_id,
      refresh_token_hash: hashRefreshToken(refreshToken),
      token_family_id: row.token_family_id,
      expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      offline_grant_until: new Date(now.getTime() + OFFLINE_GRANT_MS),
      ip_first: ip,
      ip_last: ip,
    })
    .execute();

  return {
    ok: true,
    sessionId: newSessionId,
    userId: fromBin(row.user_id),
    deviceId: fromBin(row.device_id),
    refreshToken,
  };
}

export async function revokeSessionById(
  uow: UnitOfWork,
  sessionId: string,
  reason: 'LOGOUT',
  now: Date,
): Promise<void> {
  await uow
    .updateTable('identity_auth_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('id', '=', toBin(sessionId))
    .where('revoked_at', 'is', null)
    .execute();
}
