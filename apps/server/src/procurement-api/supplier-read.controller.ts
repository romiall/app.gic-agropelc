/**
 * Lecture HTTP `GET /api/v1/suppliers` (phase P1). Composition transport hors du module
 * (comme `organization-api/`) : `AuthGuard` reste le transport interne d'`identity`, jamais
 * son API publique (.dependency-cruiser.cjs, `module-public-api-only-*`).
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
  listSuppliers,
  type SupplierSummary,
} from '../modules/procurement/application/public/index.js';

const READ_PERMISSION = 'procurement.supplier.read';

const querySchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });

@Controller('api/v1')
export class SupplierReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('suppliers')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async suppliers(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ suppliers: readonly SupplierSummary[] }> {
    const auth = request.auth!;
    const allowed = await hasPermissionAt(
      this.db,
      toBin(auth.sub),
      READ_PERMISSION,
      this.clock.now(),
    );
    if (!allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter les fournisseurs.');
    }
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Paramètres de requête invalides.');
    }
    const suppliers = await listSuppliers(
      this.db,
      parsed.data.status !== undefined ? { status: parsed.data.status } : {},
    );
    return { suppliers };
  }
}
