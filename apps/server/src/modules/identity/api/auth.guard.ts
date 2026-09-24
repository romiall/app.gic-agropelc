/**
 * Authentification (08-api-events/01-architecture-api.md §2 : `Authorization: Bearer
 * <jeton>` ; `device_id` dans le jeton). Adaptateur HTTP du module `identity` (gabarit
 * `api/`, 01-architecture-logicielle.md §3) : ne fait que vérifier la signature/expiration
 * du jeton (application/public/jwt.ts) et attacher l'identité à la requête — RC-01 (droits)
 * et RC-02 (appareil actif) restent au pipeline de commande (`commands/`), pas ici : un
 * jeton valide authentifie un auteur, il n'autorise aucune action par lui-même (§3 « Aucun
 * droit dans le jeton »).
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../../../platform/clock.provider.js';
import { ApiError } from '../../../platform/http/api-error.exception.js';
import {
  verifyAccessToken,
  type AccessTokenClaims,
  type JwtKeyPair,
} from '../application/public/jwt.js';
import { JWT_KEYS } from '../jwt-keys.provider.js';

export interface AuthenticatedRequest extends FastifyRequest {
  auth?: AccessTokenClaims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JWT_KEYS) private readonly jwtKeys: JwtKeyPair,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'En-tête Authorization: Bearer manquant.');
    }

    const result = await verifyAccessToken(this.jwtKeys.publicKey, token, this.clock.now());
    if (!result.ok) {
      throw new ApiError(401, 'UNAUTHENTICATED', `Jeton invalide (${result.reason}).`);
    }

    request.auth = result.claims;
    return true;
  }
}
