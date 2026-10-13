/**
 * Vue d'ensemble financière d'une période (P8-11 ; ADR-062 §4 ; AT-040 « combien réellement
 * encaissé ? » ; D11 KPI-FIN-01 à 06) : `GET /api/v1/finance/overview?from=&to=`. Composition de
 * transport à partir des lectures publiques existantes, sans nouvelle définition :
 * - CA net, coût des ventes et marge brute (`periodRevenue`, BR-FIN-042, 043) ;
 * - encaissé de la période (`cashedSummary`, KPI-FIN-01, ADR-041), distinct du CA ;
 * - créances au jour de la lecture (`receivablesSummary`, KPI-FIN-02, 03) ;
 * - dépenses de la période par catégorie (`expensesSummary`, KPI-FIN-04) ;
 * - dettes et avances fournisseurs (`supplierPayables`, KPI-FIN-05) ;
 * - soldes de trésorerie par type de compte (KPI-FIN-06).
 *
 * Droit `finance.payable.read` (Direction, Resp. achats, Finance ; portée `ALL`, AV-365) ; coût des ventes
 * et marge masqués sans `inventory.valuation.read` (RC-05).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { recordDenied } from '../audit/record-denied.js';
import { ALL_SCOPE } from '../platform/read-scope.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { evaluateAccess } from '../modules/identity/application/public/index.js';
import {
  expensesSummary,
  listCashAccounts,
  supplierPayables,
} from '../modules/finance/application/public/index.js';
import {
  cashedSummary,
  periodRevenue,
  receivablesSummary,
} from '../modules/sales/application/public/index.js';

const PAYABLE_READ = 'finance.payable.read';
const VALUATION_READ = 'inventory.valuation.read';
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const querySchema = z.object({ from: businessDate, to: businessDate });

@Controller('api/v1')
export class FinanceOverviewReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Get('finance/overview')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async overview(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success || parsed.data.to < parsed.data.from) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Période invalide (from et to au format AAAA-MM-JJ).',
      );
    }
    const { from, to } = parsed.data;
    const now = this.clock.now();
    const userId = request.auth!.sub;
    const access = await evaluateAccess(this.db, {
      userId,
      permissionCode: PAYABLE_READ,
      occurredAt: now,
      resource: {},
    });
    if (!access.allowed) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: userId,
          actorRoles: [],
          deviceId: request.auth!.device_id,
          action: 'access.denied',
          entityType: 'FINANCE_OVERVIEW',
          entityId: null,
          reason: `Permission manquante : ${PAYABLE_READ}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    const valued = (
      await evaluateAccess(this.db, {
        userId,
        permissionCode: VALUATION_READ,
        occurredAt: now,
        resource: {},
      })
    ).allowed;
    const period = { fromUtc: businessDayStartUtc(from), toUtc: businessDayEndUtc(to) };
    const today = businessDayOf(now);
    const revenue = await periodRevenue(this.db, period);
    const collected = await cashedSummary(this.db, ALL_SCOPE, { fromDay: from, toDay: to });
    const receivables = await receivablesSummary(this.db, ALL_SCOPE, today);
    const expenses = await expensesSummary(this.db, period);
    const suppliers = await supplierPayables(this.db, { today });
    const accounts = await listCashAccounts(this.db, { status: 'ACTIVE' });
    const cashByType = new Map<string, number>();
    for (const account of accounts) {
      cashByType.set(
        account.accountType,
        (cashByType.get(account.accountType) ?? 0) + account.balanceXaf,
      );
    }
    return {
      from,
      to,
      as_of: today,
      revenue: {
        grossRevenueXaf: revenue.grossRevenueXaf,
        cancelledXaf: revenue.cancelledXaf,
        netRevenueXaf: revenue.netRevenueXaf,
        costOfSalesXaf: valued ? revenue.costOfSalesXaf : null,
        grossMarginXaf: valued ? revenue.grossMarginXaf : null,
        saleCount: revenue.saleCount,
      },
      collected: { amountXaf: collected.amountXaf, paymentsCount: collected.paymentsCount },
      receivables,
      expenses,
      payables: {
        balanceXaf: suppliers.reduce((sum, supplier) => sum + supplier.balanceXaf, 0),
        overdueXaf: suppliers.reduce((sum, supplier) => sum + supplier.overdueXaf, 0),
        advanceXaf: suppliers.reduce((sum, supplier) => sum + supplier.advanceXaf, 0),
        netXaf: suppliers.reduce((sum, supplier) => sum + supplier.netXaf, 0),
      },
      cash: {
        totalXaf: [...cashByType.values()].reduce((sum, value) => sum + value, 0),
        byAccountType: Object.fromEntries([...cashByType].sort(([a], [b]) => a.localeCompare(b))),
      },
    };
  }
}
