/**
 * Pseudonymisation des identifiants dans les logs (09-non-functional/02-observabilite.md
 * §2 : « user_id (pseudonymisé) », « pas de donnée personnelle... dans les logs »).
 * Empreinte courte et déterministe (même utilisateur → même pseudonyme d'un appel à
 * l'autre, pour corréler des lignes de log sans exposer l'UUID réel) — pas un chiffrement
 * réversible, un simple hachage tronqué.
 */
import { sha256Hex } from '../hash.js';

const PSEUDONYM_LENGTH = 12;

export function pseudonymizeId(value: string): string {
  return sha256Hex(value).slice(0, PSEUDONYM_LENGTH);
}
