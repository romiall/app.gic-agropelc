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
import type { Clock } from '@gic/domain';
import { ApiError } from '../platform/http/api-error.exception.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { hasPermissionAt } from '../modules/identity/application/public/index.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SETTINGS_READ_PERMISSION)
  async history(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ history: readonly SettingVersion[] }> {
    const auth = request.auth!;
    const parsed = settingsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }

    const allowed = await hasPermissionAt(
      this.db,
      toBin(auth.sub),
      SETTINGS_READ_PERMISSION,
      this.clock.now(),
    );
    if (!allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter les paramètres.');
    }

    const history = await listSettingHistory(this.db, {
      key: parsed.data.key,
      ...(parsed.data.scope_type !== undefined ? { scopeType: parsed.data.scope_type } : {}),
      ...(parsed.data.scope_id !== undefined ? { scopeId: parsed.data.scope_id } : {}),
    });
    return { history };
  }
}
