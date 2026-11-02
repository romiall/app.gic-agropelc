/**
 * `GET /api/v1/organization/settings` (BR-ADM-015 : « historique des paramètres lisible »,
 * critère de sortie P0-11). Couche transport (comme `audit-api/`, 03-graphe-dependances.md
 * note 1 « api --> identity ») : `organization` (N2) ne peut pas dépendre d'`identity` (N3)
 * — c'est l'inverse qui est autorisé (`identity --> organization`) — donc ce contrôleur vit
 * hors des deux modules, qui ne se rencontrent qu'ici, par composition.
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import type { Clock, IdGenerator } from '@gic/domain';
import { ApiError } from '../platform/http/api-error.exception.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { userFullNames } from '../modules/identity/application/public/index.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { ReadAccess } from '../read-api/read-access.js';
import {
  listCurrentSettings,
  listSettingHistory,
  type SettingVersion,
} from '../modules/organization/application/public/index.js';

const SETTINGS_READ_PERMISSION = 'org.settings.manage';

const settingsQuerySchema = z.object({
  key: z.string().min(1).max(100),
  scope_type: z.enum(['GLOBAL', 'SITE', 'ZONE', 'ROLE']).optional(),
  scope_id: z.string().uuid().optional(),
});

@Controller('api/v1/organization/settings')
export class SettingsController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, SETTINGS_READ_PERMISSION);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SETTINGS_READ_PERMISSION)
  async history(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ history: readonly (SettingVersion & { createdByName: string | null })[] }> {
    const parsed = settingsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }

    // Refus audité (`access.denied`, BR-AUD-004).
    await this.access.requirePermission(request, this.clock.now(), { type: 'SETTING' });

    const history = await listSettingHistory(this.db, {
      key: parsed.data.key,
      ...(parsed.data.scope_type !== undefined ? { scopeType: parsed.data.scope_type } : {}),
      ...(parsed.data.scope_id !== undefined ? { scopeId: parsed.data.scope_id } : {}),
    });
    return { history: await this.withAuthorNames(history) };
  }

  /**
   * Version en vigueur de chaque paramètre et de chaque portée (RP-1, ECR-ADM-07), avec l'auteur de la
   * révision : de quoi lister l'écran sans une lecture par clé. Même droit que l'historique.
   */
  @Get('current')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SETTINGS_READ_PERMISSION)
  async current(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ settings: readonly (SettingVersion & { createdByName: string | null })[] }> {
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'SETTING' });
    return { settings: await this.withAuthorNames(await listCurrentSettings(this.db, now)) };
  }

  private async withAuthorNames(versions: readonly SettingVersion[]) {
    const names = await userFullNames(
      this.db,
      versions.map((version) => version.createdBy),
    );
    return versions.map((version) => ({
      ...version,
      createdByName: names.get(version.createdBy) ?? null,
    }));
  }
}
