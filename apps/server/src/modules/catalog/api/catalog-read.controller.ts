/**
 * Lectures HTTP du catalogue (phase P1 : `/products`, `/units`, `/reason-codes`). `catalog`
 * peut dépendre directement d'`identity` (03-graphe-dependances.md), donc ce contrôleur vit
 * dans le module lui-même — pas de composition séparée comme `organization-api/` (qui doit
 * contourner l'interdiction inverse `organization -> identity`).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE, type Database } from '../../../platform/kysely/database.provider.js';
import { CLOCK } from '../../../platform/clock.provider.js';
import type { Clock } from '@gic/domain';
import { ApiError } from '../../../platform/http/api-error.exception.js';
import { AuthGuard, type AuthenticatedRequest } from '../../identity/api/auth.guard.js';
import { hasPermissionAt } from '../../identity/application/public/index.js';
import { RequiresPermission } from '../../../platform/http/authorization.decorators.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import {
  listProducts,
  listUnits,
  listReasonCodes,
  type ProductSummary,
  type UnitSummary,
  type ReasonCodeSummary,
} from '../application/public/index.js';

const READ_PERMISSION = 'catalog.product.read';

const productsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const reasonCodesQuerySchema = z.object({
  category: z.string().min(1).max(30).optional(),
});

async function assertReadAllowed(
  db: Database,
  clock: Clock,
  request: AuthenticatedRequest,
): Promise<void> {
  const auth = request.auth!;
  const allowed = await hasPermissionAt(db, toBin(auth.sub), READ_PERMISSION, clock.now());
  if (!allowed) {
    throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter le catalogue.');
  }
}

@Controller('api/v1')
export class CatalogReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('products')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async products(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ products: readonly ProductSummary[] }> {
    await assertReadAllowed(this.db, this.clock, request);
    const parsed = productsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Paramètres de requête invalides.');
    }
    const products = await listProducts(
      this.db,
      parsed.data.status !== undefined ? { status: parsed.data.status } : {},
    );
    return { products };
  }

  @Get('units')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async units(@Req() request: AuthenticatedRequest): Promise<{ units: readonly UnitSummary[] }> {
    await assertReadAllowed(this.db, this.clock, request);
    const units = await listUnits(this.db);
    return { units };
  }

  @Get('reason-codes')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async reasonCodes(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ reason_codes: readonly ReasonCodeSummary[] }> {
    await assertReadAllowed(this.db, this.clock, request);
    const parsed = reasonCodesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Paramètres de requête invalides.');
    }
    const reason_codes = await listReasonCodes(
      this.db,
      parsed.data.category !== undefined ? { category: parsed.data.category } : {},
    );
    return { reason_codes };
  }
}
