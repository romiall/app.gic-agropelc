/**
 * Authentification (08-api-events/01-architecture-api.md §2 : `Authorization: Bearer
 * <jeton>` ; `device_id` dans le jeton). Adaptateur HTTP du module `identity` (gabarit
 * `api/`, 01-architecture-logicielle.md §3) : vérifie la signature/expiration du jeton
 * (application/public/jwt.ts) et attache l'identité à la requête — RC-01 (droits) et RC-02
 * (appareil actif pour écrire) restent au pipeline de commande (`commands/`), pas ici : un
 * jeton valide authentifie un auteur, il n'autorise aucune action par lui-même (§3 « Aucun
 * droit dans le jeton »).
 *
 * MP-11 (AV-282, décision du porteur du 14/10/2026 : blocage immédiat) : le jeton ne vaut que si
 * sa session est vivante, son utilisateur actif et son appareil en service (`session-state.ts`,
 * état mis en cache 5 s et vidé à chaque révocation) — une déconnexion, une réinitialisation,
 * une suspension ou un blocage d'appareil prend effet à la requête suivante, sans attendre
 * l'expiration du jeton (15 min).
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../../../platform/clock.provider.js';
import { DATABASE, type Database } from '../../../platform/kysely/database.provider.js';
import { ApiError } from '../../../platform/http/api-error.exception.js';
import { cachedSessionAccess, type SessionAccess } from '../application/auth/session-state.js';
import {
  verifyAccessToken,
  type AccessTokenClaims,
  type JwtKeyPair,
} from '../application/public/jwt.js';
import { JWT_KEYS } from '../jwt-keys.provider.js';

export interface AuthenticatedRequest extends FastifyRequest {
  auth?: AccessTokenClaims;
}

const ACCESS_REFUSALS: Readonly<Record<Exclude<SessionAccess, 'ACTIVE'>, string>> = {
  SESSION_REVOKED: 'Session close : reconnectez-vous.',
  USER_INACTIVE: 'Compte suspendu ou désactivé.',
  DEVICE_OUT_OF_SERVICE: 'Appareil hors service : contactez votre responsable.',
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JWT_KEYS) private readonly jwtKeys: JwtKeyPair,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'En-tête Authorization: Bearer manquant.');
    }

    const now = this.clock.now();
    const result = await verifyAccessToken(this.jwtKeys.publicKey, token, now);
    if (!result.ok) {
      throw new ApiError(401, 'UNAUTHENTICATED', `Jeton invalide (${result.reason}).`);
    }
    const access = await cachedSessionAccess(this.db, {
      sessionId: result.claims.session_id,
      userId: result.claims.sub,
      deviceId: result.claims.device_id,
      at: now,
    });
    if (access !== 'ACTIVE') {
      throw new ApiError(401, 'UNAUTHENTICATED', ACCESS_REFUSALS[access], { reason: access });
    }

    request.auth = result.claims;
    return true;
  }
}
