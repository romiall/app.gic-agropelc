/**
 * Lectures HTTP du catalogue (phase P1 : `/products`, `/units`, `/reason-codes`). Composition
 * transport hors du module (comme `organization-api/`, `audit-api/`) : `AuthGuard` est
 * transport interne d'`identity` (`api/`), jamais son API publique
 * (`application/public/`) — un module ne peut importer que celle-ci
 * (.dependency-cruiser.cjs, `module-public-api-only-*`), même quand le graphe des
 * dépendances métier l'autorise par ailleurs (`catalog -> identity`).
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
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
  findProduct,
  listProducts,
  listStandardCosts,
  listUnits,
  listReasonCodes,
  type ProductSummary,
  type StandardCostVersion,
  type UnitSummary,
  type ReasonCodeSummary,
} from '../modules/catalog/application/public/index.js';

const READ_PERMISSION = 'catalog.product.read';
/** Les coûts sont réservés à la valorisation (RC-05) : ni la liste des produits ni les appareils ne les servent. */
const COST_PERMISSION = 'inventory.valuation.read';

const productIdSchema = z.string().uuid();

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

  /**
   * Historique du coût standard d'un produit (AV-516) : versions datées, la plus récente en tête. Droit de
   * valorisation (`inventory.valuation.read`) : un coût ne se lit pas avec le seul droit de lire le catalogue.
   */
  @Get('products/:id/standard-costs')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(COST_PERMISSION)
  async standardCosts(
    @Param('id') rawId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ product_id: string; costs: readonly StandardCostVersion[] }> {
    const auth = request.auth!;
    const allowed = await hasPermissionAt(
      this.db,
      toBin(auth.sub),
      COST_PERMISSION,
      this.clock.now(),
    );
    if (!allowed) {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter les coûts.');
    }
    const id = productIdSchema.safeParse(rawId);
    if (!id.success)
      throw new ApiError(400, 'VALIDATION_ERROR', 'Identifiant de produit invalide.');
    if (!(await findProduct(this.db, id.data))) {
      throw new ApiError(404, 'NOT_FOUND', 'Produit introuvable.');
    }
    return { product_id: id.data, costs: await listStandardCosts(this.db, id.data) };
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
