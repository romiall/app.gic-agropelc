/**
 * `GET /api/v1/home` — accueil par rôle de l'utilisateur authentifié (ECR-ADM-03, UX-01 ; ADR-030).
 * Route à portée propre (`@SelfScoped`) : elle ne lit que ce que les rôles de l'appelant, à
 * l'instant présent, lui donnent ; aucun identifiant fourni par le client n'élargit la lecture. La
 * réponse est calculée à chaque appel (BR-ANA-001) et porte l'instant de calcul (fraîcheur,
 * BR-ANA-005).
 */
import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { homeResponseSchema, type HomeResponse } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../platform/clock.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { SelfScoped } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { buildHome } from './home-service.js';

@Controller('api/v1/home')
@UseGuards(AuthGuard)
export class HomeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @SelfScoped()
  async home(@Req() request: AuthenticatedRequest): Promise<HomeResponse> {
    const home = await buildHome({
      executor: this.db,
      userId: request.auth!.sub,
      clock: this.clock,
    });
    // Contrat partagé avec la PWA : une réponse qui s'en écarte est une erreur du serveur.
    return homeResponseSchema.parse(home);
  }
}
