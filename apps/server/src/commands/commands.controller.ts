/**
 * `POST /api/v1/commands` (08-api-events/01-architecture-api.md §1, §4.1 : « une commande,
 * même enveloppe [que /sync/push] » — même gestionnaire, même idempotence, même audit).
 * Chemin d'écriture du back-office en ligne ; `/sync/push` (lot, ordre par `device_seq`)
 * est P0-12, mais réutilisera le même {@link CommandPipelineService}.
 */
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { CommandResult } from '@gic/contracts';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { CommandRegistryDelegated } from '../platform/http/authorization.decorators.js';
import { CommandPipelineService } from './command-pipeline.service.js';

@Controller('api/v1/commands')
export class CommandsController {
  // @Inject(CommandPipelineService) explicite, pas seulement le type du paramètre : esbuild
  // (tsx en développement, vitest en test — voir apps/server/package.json) n'implémente pas
  // `emitDecoratorMetadata`, dont dépend la résolution DI de NestJS par type inféré. Sans
  // décorateur explicite, l'injection échoue silencieusement (`this.pipeline` vaut
  // `undefined` à l'exécution, aucune erreur au démarrage) — seul `tsc` (utilisé par
  // `pnpm run typecheck`/`build`, jamais pour exécuter) émet cette métadonnée. Règle pour
  // tout le paquet : toujours un jeton `@Inject()` explicite, y compris classe → classe.
  constructor(@Inject(CommandPipelineService) private readonly pipeline: CommandPipelineService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @CommandRegistryDelegated()
  async submit(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<CommandResult> {
    // `auth` posé par AuthGuard.canActivate, toujours défini ici (garde exécutée avant le
    // gestionnaire de route) — non-null assertion sûre, pas de contrôle métier supplémentaire.
    const auth = request.auth!;
    return this.pipeline.handle(body, {
      authenticatedUserId: auth.sub,
      authenticatedDeviceId: auth.device_id,
      transport: 'ONLINE_API',
      correlationId: request.correlationId,
    });
  }
}
