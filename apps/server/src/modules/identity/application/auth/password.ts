/**
 * Hachage de mot de passe (07-security-rbac/02-securite.md §2 : « hachage argon2id
 * (paramètres OWASP en vigueur, mémoire ≥ 19 Mo) »). `@node-rs/argon2` : binaire natif
 * préconstruit (NAPI-RS), aucune compilation locale requise (contrairement au paquet
 * `argon2` historique, qui recompile via node-gyp) — préférable ici puisque l'hébergement
 * cible (Hostinger sans VPS, ADR-024) ne garantit pas d'outillage de compilation, même si
 * aucun déploiement n'y est requis avant P4.
 */
import { hash, verify } from '@node-rs/argon2';

// `Algorithm.Argon2id` (@node-rs/argon2) est un `const enum` : inutilisable avec
// `isolatedModules` (tsx/vitest, transpilation fichier par fichier, esbuild) — valeur brute.
const ARGON2ID = 2;

const ARGON2ID_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB ≈ 19 Mo, recommandation OWASP en vigueur citée par la spec
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2ID_OPTIONS);
}

export function verifyPassword(passwordHash: string, plainPassword: string): Promise<boolean> {
  return verify(passwordHash, plainPassword);
}
