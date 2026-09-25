/**
 * Lecture (non vérifiée) du contenu d'un jeton d'accès JWT côté appareil, pour connaître
 * `sub` (identifiant utilisateur) localement. Aucune décision d'autorisation n'en dépend :
 * le serveur revérifie la signature et les droits à chaque requête (07-security-
 * rbac/02-securite.md §3, "aucun droit dans le jeton").
 */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly device_id: string;
  readonly session_id: string;
}

export function decodeAccessTokenClaims(token: string): AccessTokenClaims {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('Jeton JWT malformé.');
  const base64 = payload
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(payload.length / 4) * 4, '=');
  const json = atob(base64);
  return JSON.parse(json) as AccessTokenClaims;
}
