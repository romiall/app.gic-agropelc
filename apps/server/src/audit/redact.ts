/**
 * Masquage des champs secrets (INV-AUD-02, BR-AUD-007 « aucune donnée secrète n'est
 * journalisée : mots de passe, PIN, jetons, clés ») : appliqué à `before`/`after` par
 * `record-audit.ts` avant hachage et stockage — un appelant de `audit.record` ne peut donc
 * pas laisser fuiter un secret par inadvertance en passant un instantané de ligne complet
 * (ex. `identity_users.password_hash`).
 *
 * Liste fermée de noms de champs (INV-AUD-02 : « CODE, liste de champs masqués ») plutôt
 * qu'un motif générique : correspondance exacte (insensible à la casse) pour ne pas masquer
 * un champ non sensible qui contiendrait accidentellement un mot de la liste comme
 * sous-chaîne (ex. `token_family_id` n'est pas un secret). À étendre, dans son propre commit,
 * quand un futur module introduit une nouvelle colonne sensible.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'pin',
  'pin_hash',
  'pin_code',
  'token',
  'access_token',
  'refresh_token',
  'refresh_token_hash',
  'reset_token',
  'secret',
  'client_secret',
  'api_key',
  'private_key',
  'jwt_private_key',
  'otp',
  'mfa_code',
  'totp_secret',
  'authorization',
]);

const REDACTED_MARKER = '[REDACTED]';

/** Recopie `value` en remplaçant par `[REDACTED]` toute valeur dont la clé est sensible. */
export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_FIELD_NAMES.has(key.toLowerCase())
        ? REDACTED_MARKER
        : redact(entryValue);
    }
    return result;
  }
  return value;
}
