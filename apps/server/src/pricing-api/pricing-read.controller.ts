/**
 * Lectures HTTP de `pricing` (phase P1 : `/price-rules`, `/campaigns`, `/prices/resolve` —
 * UC-PRX-06, simulateur). Composition transport hors du module (comme `organization-api/`) :
 * `AuthGuard` reste le transport interne d'`identity`, jamais son API publique
 * (.dependency-cruiser.cjs, `module-public-api-only-*`).
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
  listPriceRules,
  listCampaigns,
  resolvePriceForContext,
  type PriceRuleView,
  type CampaignView,
} from '../modules/pricing/application/public/index.js';

const READ_PERMISSION = 'pricing.price.read';

async function assertReadAllowed(
  db: Database,
  clock: Clock,
  request: AuthenticatedRequest,
): Promise<void> {
  const auth = request.auth!;
  const allowed = await hasPermissionAt(db, toBin(auth.sub), READ_PERMISSION, clock.now());
  if (!allowed) {
    throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour consulter la tarification.');
  }
}

const priceRulesQuerySchema = z.object({
  product_id: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED']).optional(),
});

const resolveQuerySchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  at: z.string().datetime().optional(),
  site_id: z.string().uuid().optional(),
  zone_id: z.string().uuid().optional(),
  customer_category_id: z.string().uuid().optional(),
  channel_code: z.string().min(1).max(20).optional(),
});

@Controller('api/v1')
export class PricingReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('price-rules')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async priceRules(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ price_rules: readonly PriceRuleView[] }> {
    await assertReadAllowed(this.db, this.clock, request);
    const parsed = priceRulesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Paramètres de requête invalides.');
    }
    const price_rules = await listPriceRules(this.db, {
      ...(parsed.data.product_id !== undefined ? { productId: parsed.data.product_id } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    });
    return { price_rules };
  }

  @Get('campaigns')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async campaigns(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ campaigns: readonly CampaignView[] }> {
    await assertReadAllowed(this.db, this.clock, request);
    const campaigns = await listCampaigns(this.db);
    return { campaigns };
  }

  @Get('prices/resolve')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(READ_PERMISSION)
  async resolve(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{
    found: boolean;
    rule_id?: string;
    unit_price_xaf?: number;
    specificity?: number;
  }> {
    await assertReadAllowed(this.db, this.clock, request);
    const parsed = resolveQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Paramètres de requête invalides.');
    }
    const q = parsed.data;
    const result = await resolvePriceForContext(this.db, {
      productId: q.product_id,
      at: q.at !== undefined ? new Date(q.at) : this.clock.now(),
      quantity: q.quantity,
      ...(q.site_id !== undefined ? { siteId: q.site_id } : {}),
      ...(q.zone_id !== undefined ? { zoneId: q.zone_id } : {}),
      ...(q.customer_category_id !== undefined
        ? { customerCategoryId: q.customer_category_id }
        : {}),
      ...(q.channel_code !== undefined ? { channelCode: q.channel_code } : {}),
    });
    if (!result.found) return { found: false };
    return {
      found: true,
      rule_id: result.resolution.rule.id,
      unit_price_xaf: result.resolution.unitPriceXaf,
      specificity: result.resolution.specificity,
    };
  }
}
