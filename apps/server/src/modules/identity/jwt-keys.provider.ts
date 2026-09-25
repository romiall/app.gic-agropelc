/**
 * Composition racine de la paire de clés JWT (ES256, 07-security-rbac/02-securite.md §3).
 * Émission réelle des jetons : P0-09 (`/auth/login`). En attendant, ce fournisseur permet
 * aux tests (et à un futur `/auth/login`) de signer avec la même clé que celle que
 * `AuthGuard` utilise pour vérifier — un seul point de vérité par processus.
 *
 * `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` absentes : toléré **hors production seulement**
 * (`env.ts` lève déjà une erreur au démarrage si `NODE_ENV=production` sans ces variables) —
 * une paire éphémère est générée en mémoire, jamais journalisée, jamais persistée : les
 * jetons signés ne survivent pas à un redémarrage du processus (acceptable en dev/test à un
 * seul processus ; jamais un secret figé dans le dépôt, 05-architecture/01-architecture-
 * logicielle.md §7 « Configuration »).
 */
import type { Provider } from '@nestjs/common';
import {
  generateEphemeralKeyPair,
  loadKeyPairFromPem,
  type JwtKeyPair,
} from './application/public/jwt.js';
import type { Env } from '../../platform/env.js';
import { ENV } from '../../platform/env.provider.js';

export const JWT_KEYS = Symbol('JWT_KEYS');

export const jwtKeysProvider: Provider = {
  provide: JWT_KEYS,
  useFactory: async (env: Env): Promise<JwtKeyPair> => {
    if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
      return loadKeyPairFromPem(env.JWT_PRIVATE_KEY, env.JWT_PUBLIC_KEY);
    }
    console.warn(
      'JWT_PRIVATE_KEY/JWT_PUBLIC_KEY non définies : paire ES256 éphémère générée en mémoire ' +
        `(NODE_ENV=${env.NODE_ENV}). Les jetons émis ne survivront pas à un redémarrage.`,
    );
    return generateEphemeralKeyPair();
  },
  inject: [ENV],
};
