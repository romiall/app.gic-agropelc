/**
 * Vue d'ensemble financière d'une période (P8-11 ; ADR-044 §4 ; AT-040 « combien réellement
 * encaissé ? » ; D11 KPI-FIN-01 à 06) : `GET /api/v1/finance/overview?from=&to=`. Composition de
 * transport à partir des lectures publiques existantes, sans nouvelle définition :
 * - CA net, coût des ventes et marge brute (`periodRevenue`, BR-FIN-042, 043) ;
 * - encaissé de la période (`cashedSummary`, KPI-FIN-01, ADR-041), distinct du CA ;
 * - créances au jour de la lecture, avec leurs tranches d'ancienneté (`receivablesSummary`,
 *   `summarizeReceivables`, KPI-FIN-02, 03) — le solde dû est un solde courant, il ne se reconstitue
 *   pas à la fin d'une période passée ;
 * - dépenses de la période par catégorie (`expensesSummary`, KPI-FIN-04) ;
 * - dettes et avances fournisseurs (`supplierPayables`, KPI-FIN-05) ;
 * - soldes de trésorerie par type de compte (KPI-FIN-06).
 *
 * Droit de la route : `finance.payable.read` (Direction, Resp. achats, Finance ; portée `ALL`,
 * AV-278). Chaque bloc n'est rendu qu'avec le droit qui gouverne déjà sa lecture (revue de P8-14 : la
 * matrice réserve CA, encaissé, créances et trésorerie à la Direction et à la Finance) — sinon `null` :
 * CA, encaissé, créances, trésorerie : `analytics.dashboard.finance` ; dépenses :
 * `finance.expense.read` en portée `ALL` ; coût des ventes et marge : `inventory.valuation.read`
 * (RC-05).
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
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { ALL_SCOPE } from '../platform/read-scope.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  ReadAccess,
  assertPeriod,
  businessDateParam,
  parseOrThrow,
} from '../read-api/read-access.js';
import {
  expensesSummary,
  listCashAccounts,
  supplierPayables,
} from '../modules/finance/application/public/index.js';
import {
  cashedSummary,
  listReceivables,
  periodRevenue,
  receivablesSummary,
  summarizeReceivables,
} from '../modules/sales/application/public/index.js';

const PAYABLE_READ = 'finance.payable.read';
const DASHBOARD_FINANCE = 'analytics.dashboard.finance';
const EXPENSE_READ = 'finance.expense.read';
const VALUATION_READ = 'inventory.valuation.read';
const querySchema = z.object({ from: businessDateParam, to: businessDateParam });

@Controller('api/v1')
export class FinanceOverviewReadController {
  private readonly payableRead: ReadAccess;
  private readonly dashboard: ReadAccess;
  private readonly expenseRead: ReadAccess;
  private readonly valuation: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    const deps = { clock, idGenerator };
    this.payableRead = new ReadAccess(db, deps, PAYABLE_READ);
    this.dashboard = new ReadAccess(db, deps, DASHBOARD_FINANCE);
    this.expenseRead = new ReadAccess(db, deps, EXPENSE_READ);
    this.valuation = new ReadAccess(db, deps, VALUATION_READ);
  }

  @Get('finance/overview')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async overview(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const { from, to } = parseOrThrow(querySchema, rawQuery);
    assertPeriod(from, to);
    const now = this.clock.now();
    const entity = { type: 'FINANCE_OVERVIEW' };
    await this.payableRead.requirePermission(request, now, entity);
    if (!(await this.payableRead.allowsAll(request, now))) {
      await this.payableRead.deny(request, now, entity, 'NO_PERMISSION');
    }
    const finance = await this.dashboard.allowsAll(request, now);
    const expensesVisible = await this.expenseRead.allowsAll(request, now);
    const valued = await this.valuation.allowsAll(request, now);
    const period = { fromUtc: businessDayStartUtc(from), toUtc: businessDayEndUtc(to) };
    const today = businessDayOf(now);
    const suppliers = await supplierPayables(this.db, { today });
    return {
      from,
      to,
      as_of: today,
      revenue: finance ? await this.revenue(period, valued) : null,
      collected: finance ? await this.collected(from, to) : null,
      receivables: finance ? await this.receivables(today) : null,
      expenses: expensesVisible ? await expensesSummary(this.db, period) : null,
      payables: {
        balanceXaf: suppliers.reduce((sum, supplier) => sum + supplier.balanceXaf, 0),
        overdueXaf: suppliers.reduce((sum, supplier) => sum + supplier.overdueXaf, 0),
        advanceXaf: suppliers.reduce((sum, supplier) => sum + supplier.advanceXaf, 0),
        netXaf: suppliers.reduce((sum, supplier) => sum + supplier.netXaf, 0),
      },
      cash: finance ? await this.cash() : null,
    };
  }

  private async revenue(period: { fromUtc: Date; toUtc: Date }, valued: boolean) {
    const revenue = await periodRevenue(this.db, period);
    return {
      grossRevenueXaf: revenue.grossRevenueXaf,
      cancelledXaf: revenue.cancelledXaf,
      netRevenueXaf: revenue.netRevenueXaf,
      costOfSalesXaf: valued ? revenue.costOfSalesXaf : null,
      grossMarginXaf: valued ? revenue.grossMarginXaf : null,
      saleCount: revenue.saleCount,
    };
  }

  private async collected(from: string, to: string) {
    const collected = await cashedSummary(this.db, ALL_SCOPE, { fromDay: from, toDay: to });
    return { amountXaf: collected.amountXaf, paymentsCount: collected.paymentsCount };
  }

  private async receivables(today: string) {
    const summary = await receivablesSummary(this.db, ALL_SCOPE, today);
    const aging = summarizeReceivables(await listReceivables(this.db, { today }));
    return { ...summary, buckets: aging.buckets };
  }

  private async cash() {
    const byType = new Map<string, number>();
    for (const account of await listCashAccounts(this.db, { status: 'ACTIVE' })) {
      byType.set(account.accountType, (byType.get(account.accountType) ?? 0) + account.balanceXaf);
    }
    return {
      totalXaf: [...byType.values()].reduce((sum, value) => sum + value, 0),
      byAccountType: Object.fromEntries([...byType].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}
