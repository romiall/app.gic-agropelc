/**
 * Jeton de rafraîchissement opaque (07-security-rbac/02-securite.md §3 : « opaque (256 bits
 * aléatoires), stocké haché (SHA-256) »). Encodage base64url pour le transport (pas de `+`/
 * `/` à échapper en JSON/URL) ; seul le SHA-256 hexadécimal est stocké (`identity_auth_
 * sessions.refresh_token_hash`), jamais la valeur en clair.
 */
import { randomBytes, createHash } from 'node:crypto';

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
