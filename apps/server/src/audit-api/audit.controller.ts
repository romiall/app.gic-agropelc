/**
 * `GET /api/v1/audit` (REQ-065, REQ-209 ; 07-security-rbac/03-audit.md §6 : permission
 * `audit.log.read`, consultation elle-même auditée — BR-AUD-009). Couche transport (comme
 * `commands/`, 03-graphe-dependances.md note 1 « api --> identity ») : seul point du serveur
 * où `audit` (N1) et `identity` (N3) se rencontrent, par composition ici, jamais par une
 * dépendance d'`audit` vers `identity` (qui romprait le graphe — `audit` reste, comme
 * `platform`, disponible à tout module sans jamais dépendre d'aucun).
 *
 * Portée du droit : seule l'existence de l'octroi est vérifiée ici (RC-01 minimal, comme le
 * pipeline de commande P0-06) — l'intersection avec la portée du rôle (ex. Finance limitée
 * aux entités financières, §6) est l'évaluation complète des portées que P0-10 construit ;
 * signature stable, P0-10 enrichit l'implémentation, pas ses appelants.
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { ApiError } from '../platform/http/api-error.exception.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import { recordAudit } from '../audit/record-audit.js';
import { recordDenied } from '../audit/record-denied.js';
import {
  listAuditLog,
  AUDIT_LOG_MAX_LIMIT,
  type AuditLogEntry,
  type AuditLogFilter,
} from '../audit/audit-log-query.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { hasPermissionAt } from '../modules/identity/application/public/index.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';

const AUDIT_LOG_READ_PERMISSION = 'audit.log.read';

const auditLogQuerySchema = z.object({
  entity_type: z.string().min(1).max(40).optional(),
  entity_id: z.string().uuid().optional(),
  actor_user_id: z.string().uuid().optional(),
  action: z.string().min(1).max(80).optional(),
  before_seq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(AUDIT_LOG_MAX_LIMIT).optional(),
});

@Controller('api/v1/audit')
export class AuditController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Get()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(AUDIT_LOG_READ_PERMISSION)
  async list(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ entries: readonly AuditLogEntry[] }> {
    const auth = request.auth!;
    const now = this.clock.now();
    const parsed = auditLogQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }
    // `exactOptionalPropertyTypes` : une clé absente doit être omise, pas mise à `undefined`.
    const filter: AuditLogFilter = {
      ...(parsed.data.entity_type !== undefined ? { entityType: parsed.data.entity_type } : {}),
      ...(parsed.data.entity_id !== undefined ? { entityId: parsed.data.entity_id } : {}),
      ...(parsed.data.actor_user_id !== undefined
        ? { actorUserId: parsed.data.actor_user_id }
        : {}),
      ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      ...(parsed.data.before_seq !== undefined ? { beforeSeq: parsed.data.before_seq } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    };

    const allowed = await hasPermissionAt(this.db, toBin(auth.sub), AUDIT_LOG_READ_PERMISSION, now);
    if (!allowed) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: auth.sub,
          actorRoles: [],
          deviceId: auth.device_id,
          action: 'access.denied',
          entityType: 'AUDIT_LOG',
          reason: `Permission manquante : ${AUDIT_LOG_READ_PERMISSION}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter le journal d’audit.');
    }

    const entries = await listAuditLog(this.db, filter);

    // BR-AUD-009 : toute consultation du journal est elle-même auditée.
    await this.db.transaction().execute((trx) =>
      recordAudit(
        trx,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: auth.sub,
          actorRoles: [],
          deviceId: auth.device_id,
          action: 'audit.log.read',
          entityType: 'AUDIT_LOG',
          after: filter,
          result: 'SUCCESS',
        },
      ),
    );

    return { entries };
  }
}
