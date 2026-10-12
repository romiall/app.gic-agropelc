/**
 * Lectures HTTP des sessions de caisse et des remises de fonds (P5-17 ; ADR-032 ;
 * 08-api-events/01-architecture-api.md §4.9) : `GET /cash-sessions`, `/cash-sessions/{id}`,
 * `/cash-transfers`, `/cash-transfers/{id}`. Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit (AV-189) : `finance.cash.read`, comme `GET /cash-accounts` (Direction, Finance : tout ; Vendeur :
 * son site ; commerciaux et Resp. ferme : leur caisse). Portée (RC-04) : celle du **compte** —
 * détenteur d'une caisse personnelle, à défaut responsable, et site (`cashAccountResourceOf`) :
 * - une session est visible si sa caisse de PDV l'est ; sa fiche porte ses ajustements (réévaluations,
 *   P5-13) et les flux de sa fenêtre avec les sous-totaux par vendeur (AV-155, AV-187), composés ici
 *   parce que `finance` n'importe pas `sales` (`cash-session-subtotals.ts`) ;
 * - une remise est visible si l'**un** de ses deux comptes l'est ; sa fiche porte ses mouvements.
 * Hors portée ⇒ absente d'une liste, 404 audité pour une fiche ; droit absent ⇒ 403 audité.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { businessDayEndUtc, businessDayStartUtc, type Clock, type IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_MAX_LIMIT,
  CASH_TRANSFER_STATUSES,
  cashAccountResourceOf,
  cashTransferMovements,
  findCashAccount,
  findCashSessionDetail,
  findCashTransfer,
  listCashAccounts,
  listCashSessionAdjustments,
  listCashSessions,
  listCashTransfers,
} from '../modules/finance/application/public/index.js';
import {
  assertPeriod,
  businessDateParam,
  idParamSchema,
  parseOrThrow,
  ReadAccess,
  uuidParam,
} from '../read-api/read-access.js';
import { cashSessionSellerSubtotals } from './cash-session-subtotals.js';

const CASH_READ = 'finance.cash.read';

const limit = z.coerce.number().int().positive().max(CASH_LIST_MAX_LIMIT).optional();
const sessionsQuerySchema = z.object({
  cash_account_id: uuidParam.optional(),
  site_id: uuidParam.optional(),
  status: z.enum(['OPEN', 'PENDING_VALIDATION', 'VALIDATED']).optional(),
  from: businessDateParam.optional(),
  to: businessDateParam.optional(),
  cursor: uuidParam.optional(),
  limit,
});
const transfersQuerySchema = z.object({
  account_id: uuidParam.optional(),
  status: z.enum(CASH_TRANSFER_STATUSES).optional(),
  from: businessDateParam.optional(),
  to: businessDateParam.optional(),
  cursor: uuidParam.optional(),
  limit,
});

@Controller('api/v1')
export class CashOperationsReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, CASH_READ);
  }

  /** Le compte existe-t-il et est-il dans la portée de l'appelant ? */
  private async accountVisible(
    request: AuthenticatedRequest,
    now: Date,
    accountId: string,
  ): Promise<boolean> {
    const account = await findCashAccount(this.db, accountId);
    return account !== null && account !== undefined
      ? this.access.allows(request, now, cashAccountResourceOf(account))
      : false;
  }

  /**
   * Comptes auxquels restreindre une liste : `undefined` ⇒ aucune restriction (portée `ALL`, sans
   * filtre demandé) ; sinon les comptes demandés et visibles.
   */
  private async accountScope(
    request: AuthenticatedRequest,
    now: Date,
    filter: {
      readonly accountId?: string;
      readonly siteId?: string;
      readonly accountType?: 'CAISSE_PDV';
    },
  ): Promise<readonly string[] | undefined> {
    const all = await this.access.allowsAll(request, now);
    if (filter.accountId !== undefined) {
      // Le compte demandé doit aussi respecter les autres filtres (site, type), puis la portée.
      const account = await findCashAccount(this.db, filter.accountId);
      if (
        !account ||
        (filter.siteId !== undefined && account.siteId !== filter.siteId) ||
        (filter.accountType !== undefined && account.accountType !== filter.accountType)
      ) {
        return [];
      }
      return all || (await this.access.allows(request, now, cashAccountResourceOf(account)))
        ? [account.id]
        : [];
    }
    if (all && filter.siteId === undefined && filter.accountType === undefined) return undefined;
    const accounts = await listCashAccounts(this.db, {
      ...(filter.siteId !== undefined ? { siteIds: [filter.siteId] } : {}),
      ...(filter.accountType !== undefined ? { accountType: filter.accountType } : {}),
    });
    const kept: string[] = [];
    for (const account of accounts) {
      if (filter.siteId !== undefined && account.siteId !== filter.siteId) continue;
      if (all || (await this.access.allows(request, now, cashAccountResourceOf(account)))) {
        kept.push(account.id);
      }
    }
    return kept;
  }

  @Get('cash-sessions')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async sessions(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(sessionsQuerySchema, rawQuery);
    assertPeriod(query.from, query.to);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'CASH_SESSION' });
    const cashAccountIds = await this.accountScope(request, now, {
      ...(query.cash_account_id !== undefined ? { accountId: query.cash_account_id } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      accountType: 'CAISSE_PDV',
    });
    const page = await listCashSessions(this.db, {
      ...(cashAccountIds !== undefined ? { cashAccountIds } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.from !== undefined ? { fromDate: query.from } : {}),
      ...(query.to !== undefined ? { toDate: query.to } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? CASH_LIST_DEFAULT_LIMIT,
    });
    return { cash_sessions: page.items, next_cursor: page.nextCursor };
  }

  @Get('cash-sessions/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async session(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'CASH_SESSION', id };
    await this.access.requirePermission(request, now, entity);
    const session = await findCashSessionDetail(this.db, id);
    if (!session || !(await this.accountVisible(request, now, session.cashAccountId))) {
      return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    const flows = await cashSessionSellerSubtotals(this.db, id);
    return {
      cash_session: session,
      adjustments: await listCashSessionAdjustments(this.db, id),
      flows:
        flows === undefined
          ? null
          : {
              window: flows.window,
              sellers: flows.sellers,
              unattributedReceivedXaf: flows.unattributedReceivedXaf,
              otherMovements: flows.otherMovements,
              netFlowsXaf: flows.netFlowsXaf,
              expectedNowXaf: flows.expectedNowXaf,
            },
    };
  }

  @Get('cash-transfers')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async transfers(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(transfersQuerySchema, rawQuery);
    assertPeriod(query.from, query.to);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'CASH_TRANSFER' });
    const accountIds = await this.accountScope(
      request,
      now,
      query.account_id !== undefined ? { accountId: query.account_id } : {},
    );
    const page = await listCashTransfers(this.db, {
      ...(accountIds !== undefined ? { accountIds } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.from !== undefined ? { fromUtc: businessDayStartUtc(query.from) } : {}),
      ...(query.to !== undefined ? { toUtc: businessDayEndUtc(query.to) } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? CASH_LIST_DEFAULT_LIMIT,
    });
    return { cash_transfers: page.items, next_cursor: page.nextCursor };
  }

  @Get('cash-transfers/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CASH_READ)
  async transfer(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'CASH_TRANSFER', id };
    await this.access.requirePermission(request, now, entity);
    const transfer = await findCashTransfer(this.db, id);
    const visible =
      transfer !== undefined &&
      ((await this.accountVisible(request, now, transfer.fromAccountId)) ||
        (await this.accountVisible(request, now, transfer.toAccountId)));
    if (!visible) return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
    return { cash_transfer: transfer, movements: await cashTransferMovements(this.db, id) };
  }
}
