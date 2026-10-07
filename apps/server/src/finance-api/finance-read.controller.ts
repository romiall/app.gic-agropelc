/**
 * Lectures HTTP de la trésorerie (P4-10 ; 08-api-events/01-architecture-api.md §4.9) :
 * `GET /cash-accounts` (soldes), `/cash-accounts/{id}/movements`. Composition transport hors du
 * module (même précédent que `production-api/`).
 *
 * Droit (01-rbac.md §5.6) : `finance.cash.read` (Direction, Finance : tous les comptes ; Vendeur :
 * comptes de son site ; commerciaux et Resp. ferme : leur caisse). Portée (RC-04) : détenteur d'une
 * caisse personnelle, à défaut responsable du compte, et site du compte. Compte hors portée ⇒ absent
 * de la liste, ou 404 (audité) pour ses mouvements ; droit absent ⇒ 403.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { businessDayEndUtc, businessDayStartUtc, type Clock, type IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { recordDenied } from '../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { evaluateAccess, hasPermissionAt } from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  CASH_ACCOUNT_TYPES,
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_MAX_LIMIT,
  cashAccountResourceOf,
  findCashAccount,
  listCashAccounts,
  listCashMovements,
  type CashAccountSummary,
} from '../modules/finance/application/public/index.js';

const CASH_READ = 'finance.cash.read';

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const accountsQuerySchema = z.object({
  site_id: uuid.optional(),
  account_type: z.enum(CASH_ACCOUNT_TYPES).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
const movementsQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().positive().max(CASH_LIST_MAX_LIMIT).optional(),
});
const idParamSchema = z.object({ id: uuid });

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
    );
  }
  return parsed.data;
}

@Controller('api/v1')
export class FinanceReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id?: string },
    reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE',
  ): Promise<never> {
    const auth = request.auth!;
    await recordDenied(
      this.db,
      { idGenerator: this.idGenerator, clock: this.clock },
      {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'access.denied',
        entityType: entity.type,
        entityId: entity.id ?? null,
        reason:
          reason === 'NO_PERMISSION'
            ? `Permission manquante : ${CASH_READ}.`
            : `Hors portée : ${CASH_READ}.`,
        errorCode: reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND',
      },
    );
    if (reason === 'NO_PERMISSION') {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    throw new ApiError(404, 'NOT_FOUND', 'Ressource introuvable.');
  }

  private async requirePermission(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id?: string },
  ): Promise<void> {
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), CASH_READ, now))) {
      await this.deny(request, now, entity, 'NO_PERMISSION');
    }
  }

  private async visible(
    request: AuthenticatedRequest,
    now: Date,
    account: CashAccountSummary,
  ): Promise<boolean> {
    return (
      await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: CASH_READ,
        occurredAt: now,
        resource: cashAccountResourceOf(account),
      })
    ).allowed;
  }

  @Get('cash-accounts')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async accounts(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(accountsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'CASH_ACCOUNT' });
    const accounts = await listCashAccounts(this.db, {
      ...(query.site_id !== undefined ? { siteIds: [query.site_id] } : {}),
      ...(query.account_type !== undefined ? { accountType: query.account_type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    });
    const kept: CashAccountSummary[] = [];
    for (const account of accounts) {
      if (await this.visible(request, now, account)) kept.push(account);
    }
    return { cash_accounts: kept };
  }

  @Get('cash-accounts/:id/movements')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async movements(
    @Param() rawParams: unknown,
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const query = parseOrThrow(movementsQuerySchema, rawQuery);
    if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
    }
    const now = this.clock.now();
    const entity = { type: 'CASH_ACCOUNT', id };
    await this.requirePermission(request, now, entity);
    const account = await findCashAccount(this.db, id);
    if (!account || !(await this.visible(request, now, account))) {
      return this.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    const page = await listCashMovements(this.db, id, {
      ...(query.from !== undefined ? { fromUtc: businessDayStartUtc(query.from) } : {}),
      ...(query.to !== undefined ? { toUtc: businessDayEndUtc(query.to) } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? CASH_LIST_DEFAULT_LIMIT,
    });
    return { cash_account: account, movements: page.items, next_cursor: page.nextCursor };
  }
}
