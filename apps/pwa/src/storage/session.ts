/**
 * Session locale : établissement du PIN, déverrouillage, échecs (BR-ADM-024 : 5 échecs →
 * effacement des jetons locaux, reconnexion en ligne obligatoire). Le jeton d'accès n'est
 * jamais persisté (courte durée de vie, régénéré au déverrouillage via `/auth/refresh`) ;
 * seul le jeton de rafraîchissement est chiffré au repos (07-security-rbac/02-securite.md
 * §4 « Stockage côté appareil »).
 */
import type { GicDatabase } from './db.js';
import {
  deriveKey,
  decryptText,
  encryptText,
  isValidPin,
  newSalt,
  PBKDF2_ITERATIONS,
} from './crypto.js';

export const MAX_PIN_ATTEMPTS = 5;

export type UnlockResult =
  | {
      readonly ok: true;
      readonly refreshToken: string;
      readonly userId: string;
      readonly deviceStatus: 'PENDING' | 'ACTIVE';
      readonly pinKey: CryptoKey;
    }
  | { readonly ok: false; readonly reason: 'INVALID_PIN'; readonly attemptsLeft: number }
  | { readonly ok: false; readonly reason: 'WIPED' }
  | { readonly ok: false; readonly reason: 'NO_SESSION' };

/** Après une connexion en ligne réussie : définit le PIN et chiffre le jeton de session. */
export async function setupPin(
  db: GicDatabase,
  input: {
    readonly userId: string;
    readonly deviceStatus: 'PENDING' | 'ACTIVE';
    readonly refreshToken: string;
    readonly pin: string;
  },
): Promise<CryptoKey> {
  if (!isValidPin(input.pin)) {
    throw new Error('PIN invalide : 6 chiffres attendus (07-security-rbac/02-securite.md §3).');
  }
  const salt = newSalt();
  const key = await deriveKey(input.pin, salt);
  const encrypted = await encryptText(key, input.refreshToken);
  await db.transaction('rw', db.session, db.pinLocks, async () => {
    await db.pinLocks.put({
      user_id: input.userId,
      salt,
      iterations: PBKDF2_ITERATIONS,
      failed_attempts: 0,
    });
    await db.session.put({
      key: 'current',
      user_id: input.userId,
      device_status: input.deviceStatus,
      encrypted_refresh_token: encrypted.ciphertext,
      iv: encrypted.iv,
    });
  });
  return key;
}

/** Déverrouillage hors ligne par PIN (ECR-ADM-02). */
export async function unlockWithPin(db: GicDatabase, pin: string): Promise<UnlockResult> {
  const session = await db.session.get('current');
  if (!session) return { ok: false, reason: 'NO_SESSION' };
  const lock = await db.pinLocks.get(session.user_id);
  if (!lock) return { ok: false, reason: 'NO_SESSION' };

  const key = await deriveKey(pin, lock.salt, lock.iterations);
  try {
    const refreshToken = await decryptText(key, {
      ciphertext: session.encrypted_refresh_token,
      iv: session.iv,
    });
    await db.pinLocks.update(session.user_id, { failed_attempts: 0 });
    return {
      ok: true,
      refreshToken,
      userId: session.user_id,
      deviceStatus: session.device_status,
      pinKey: key,
    };
  } catch {
    const failedAttempts = lock.failed_attempts + 1;
    if (failedAttempts >= MAX_PIN_ATTEMPTS) {
      await wipeLocalSession(db);
      return { ok: false, reason: 'WIPED' };
    }
    await db.pinLocks.update(session.user_id, { failed_attempts: failedAttempts });
    return { ok: false, reason: 'INVALID_PIN', attemptsLeft: MAX_PIN_ATTEMPTS - failedAttempts };
  }
}

/** BR-ADM-024 : jetons locaux effacés, l'outbox et les projections restent intactes. */
export async function wipeLocalSession(db: GicDatabase): Promise<void> {
  await db.transaction('rw', db.session, db.pinLocks, async () => {
    await db.session.clear();
    await db.pinLocks.clear();
  });
}

export async function hasLocalSession(db: GicDatabase): Promise<boolean> {
  return (await db.session.get('current')) !== undefined;
}
