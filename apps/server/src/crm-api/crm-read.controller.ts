/**
 * Lectures HTTP du CRM (P3-06 ; 08-api-events/01-architecture-api.md §4.4) : `GET /customers`,
 * `/customers/duplicate-check`, `/customers/{id}`, `/visits`, `/interactions`, `/targets`,
 * `/performance/commercial`. Composition transport hors du module (même précédent
 * qu'`inventory-api/`).
 *
 * Portée (01-architecture-api.md §2 : « toute requête est restreinte à la portée de
 * l'utilisateur ») : chaque élément renvoyé est évalué par `evaluateAccess` (RC-04) sur sa
 * ressource — compte : titulaire, site de rattachement, zone ; visite ou interaction : auteur et
 * zone du compte ; objectif : sa cible. Une liste sans ancrage (`owner`, `site_id`, `zone_id`,
 * `user_id`…) porte, sauf portée `ALL`, sur l'utilisateur, les membres des équipes qu'il dirige
 * et, pour les comptes, ses sites d'affectation (DÉDUIT : « mon portefeuille », celui de mon
 * équipe, les clients de mon PDV — D02 §12). Élément hors portée ⇒ absent de la liste, ou 404
 * pour une fiche ; droit absent ⇒ 403 ; les deux refus d'une fiche sont audités (BR-AUD-004).
 *
 * Droits (01-rbac.md §5) : comptes `crm.customer.read` ; contrôle de doublon
 * `crm.customer.create` (réponse masquée hors périmètre, AV-014, RC-07) ; visites et interactions
 * `crm.visit.read` (DÉDUIT : aucune permission de lecture propre aux interactions, activité du
 * même portefeuille) ; objectifs et effort commercial `crm.target.read`. Ses propres objectifs et
 * son propre effort se lisent avec la seule permission (DÉDUIT : l'utilisateur est la ressource).
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  DomainError,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  isMondayBusinessDay,
  normalizePhone,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { recordDenied } from '../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  activeSiteAssignmentsAt,
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { businessDateParam } from '../read-api/read-access.js';
import {
  currentSettingValue,
  listManagedTeamMembersAt,
} from '../modules/organization/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  SALES_LIST_MAX_LIMIT,
  listOrders,
  listReceivables,
  listSales,
  summarizeReceivables,
  targetRealized,
} from '../modules/sales/application/public/index.js';
import { weeklyFigures } from './weekly-report-figures.js';
import {
  CRM_LIST_DEFAULT_LIMIT,
  CRM_LIST_MAX_LIMIT,
  WEEKLY_REPORT_LIST_MAX_LIMIT,
  absorbedCustomerIds,
  commercialEffort,
  customerResourceOf,
  findCustomerByPhone,
  getCustomer,
  listCustomerAssignments,
  listCustomerStageHistory,
  listCustomers,
  listInteractions,
  listTargets,
  listVisits,
  listWeeklyReports,
  type TargetSummary,
} from '../modules/crm/application/public/index.js';

const CUSTOMER_READ = 'crm.customer.read';
const CUSTOMER_CREATE = 'crm.customer.create';
const VISIT_READ = 'crm.visit.read';
const TARGET_READ = 'crm.target.read';
const WEEKLY_REPORT_READ = 'crm.weekly_report.read';
const VALUATION_READ = 'inventory.valuation.read';

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const limit = z.coerce.number().int().positive().max(CRM_LIST_MAX_LIMIT).optional();
const userRef = z.union([z.literal('me'), uuid]);

const customersQuerySchema = z.object({
  owner: userRef.optional(),
  site_id: uuid.optional(),
  zone_id: uuid.optional(),
  stage: z.enum(['PROSPECT', 'CUSTOMER', 'LOST', 'MERGED']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: uuid.optional(),
  limit,
});
const duplicateQuerySchema = z.object({ phone: z.string().trim().min(1).max(30) });
const activityQuerySchema = z.object({
  user_id: userRef.optional(),
  customer_id: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  cursor: uuid.optional(),
  limit,
});
const targetsQuerySchema = z.object({
  user_id: userRef.optional(),
  team_id: uuid.optional(),
  site_id: uuid.optional(),
  active_on: businessDate.optional(),
});
const performanceQuerySchema = z.object({
  user_id: userRef.optional(),
  from: businessDate,
  to: businessDate,
});
const weeklyReportsQuerySchema = z.object({
  user_id: userRef.optional(),
  week_start: businessDateParam.optional(),
  from_week: businessDateParam.optional(),
  to_week: businessDateParam.optional(),
  limit: z.coerce.number().int().positive().max(WEEKLY_REPORT_LIST_MAX_LIMIT).optional(),
});
const weeklyFiguresQuerySchema = z.object({
  user_id: userRef.optional(),
  week_start: businessDateParam,
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

const NOT_FOUND_MESSAGE = 'Ressource introuvable.';

@Controller('api/v1')
export class CrmReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id?: string },
    permissionCode: string,
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
            ? `Permission manquante : ${permissionCode}.`
            : `Hors portée : ${permissionCode}.`,
        errorCode: reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND',
      },
    );
    if (reason === 'NO_PERMISSION') {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  }

  private async requirePermission(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id?: string },
    permissionCode: string,
  ): Promise<void> {
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), permissionCode, now))) {
      await this.deny(request, now, entity, permissionCode, 'NO_PERMISSION');
    }
  }

  private async allowed(
    request: AuthenticatedRequest,
    now: Date,
    permissionCode: string,
    resource: ResourceLocator,
  ): Promise<boolean> {
    const access = await evaluateAccess(this.db, {
      userId: request.auth!.sub,
      permissionCode,
      occurredAt: now,
      resource,
    });
    return access.allowed;
  }

  /** Portée `ALL` : seule une portée sans restriction admet une ressource vide. */
  private hasAllScope(request: AuthenticatedRequest, now: Date, permissionCode: string) {
    return this.allowed(request, now, permissionCode, {});
  }

  private userOf(request: AuthenticatedRequest, ref: string | undefined): string | undefined {
    return ref === 'me' ? request.auth!.sub : ref;
  }

  /** Utilisateurs par défaut d'une liste sans ancrage : soi et les membres des équipes dirigées. */
  private async defaultUsers(request: AuthenticatedRequest, now: Date): Promise<string[]> {
    const me = request.auth!.sub;
    return [...new Set([me, ...(await listManagedTeamMembersAt(this.db, me, now))])];
  }

  private async filterAllowed<T>(
    request: AuthenticatedRequest,
    now: Date,
    permissionCode: string,
    items: readonly T[],
    resourceOf: (item: T) => ResourceLocator,
  ): Promise<T[]> {
    const kept: T[] = [];
    for (const item of items) {
      if (await this.allowed(request, now, permissionCode, resourceOf(item))) kept.push(item);
    }
    return kept;
  }

  @Get('customers')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CUSTOMER_READ)
  async customers(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(customersQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'CUSTOMER' }, CUSTOMER_READ);
    const all = await this.hasAllScope(request, now, CUSTOMER_READ);
    const owner = this.userOf(request, query.owner);
    const anchored =
      owner !== undefined || query.site_id !== undefined || query.zone_id !== undefined;
    const anyOf =
      !all && !anchored
        ? {
            ownerUserIds: await this.defaultUsers(request, now),
            siteIds: [...(await activeSiteAssignmentsAt(this.db, request.auth!.sub, now))],
          }
        : undefined;
    const page = await listCustomers(this.db, {
      ...(anyOf !== undefined ? { anyOf } : {}),
      ...(owner !== undefined ? { ownerUserId: owner } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.zone_id !== undefined ? { zoneId: query.zone_id } : {}),
      ...(query.stage !== undefined ? { stage: query.stage } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? CRM_LIST_DEFAULT_LIMIT,
    });
    const customers = all
      ? [...page.items]
      : await this.filterAllowed(request, now, CUSTOMER_READ, page.items, customerResourceOf);
    return { customers, next_cursor: page.nextCursor };
  }

  /** BR-CRM-006, AV-014 : existence d'un compte pour ce téléphone, masquée hors périmètre. */
  @Get('customers/duplicate-check')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CUSTOMER_CREATE)
  async duplicateCheck(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(duplicateQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'CUSTOMER' }, CUSTOMER_CREATE);
    const countryCode = await currentSettingValue(this.db, {
      key: 'crm.phone_default_country_code',
      scopeType: 'GLOBAL',
      scopeId: null,
      at: now,
    });
    let phone: string;
    try {
      phone = normalizePhone(query.phone, countryCode === undefined ? '237' : String(countryCode));
    } catch (error) {
      if (error instanceof DomainError) throw new ApiError(400, error.code, error.message);
      throw error;
    }
    const existing = await findCustomerByPhone(this.db, phone);
    if (!existing) return { phone, exists: false };
    if (await this.allowed(request, now, CUSTOMER_READ, customerResourceOf(existing))) {
      return {
        phone,
        exists: true,
        in_scope: true,
        customer: {
          id: existing.id,
          display_name: existing.displayName,
          stage: existing.stage,
          owner_user_id: existing.ownerUserId,
        },
      };
    }
    return {
      phone,
      exists: true,
      in_scope: false,
      message: 'Compte existant, suivi par un autre commercial.',
    };
  }

  @Get('customers/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CUSTOMER_READ)
  async customer(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'CUSTOMER', id }, CUSTOMER_READ);
    const customer = await getCustomer(this.db, id);
    if (!customer) throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    if (!(await this.allowed(request, now, CUSTOMER_READ, customerResourceOf(customer)))) {
      return this.deny(request, now, { type: 'CUSTOMER', id }, CUSTOMER_READ, 'OUT_OF_SCOPE');
    }
    // Lectures agrégées par la chaîne de fusion (BR-CRM-007) ; activité selon crm.visit.read.
    const absorbed = await absorbedCustomerIds(this.db, id);
    const customerIds = [id, ...absorbed];
    const activityScope = (userId: string): ResourceLocator => ({
      ownerUserId: userId,
      zoneId: customer.zoneId,
    });
    const visits = await listVisits(this.db, { customerIds, limit: 20 });
    const interactions = await listInteractions(this.db, { customerIds, limit: 20 });
    return {
      customer,
      absorbed_customer_ids: absorbed,
      assignments: await listCustomerAssignments(this.db, id),
      stage_history: await listCustomerStageHistory(this.db, id),
      recent_visits: await this.filterAllowed(request, now, VISIT_READ, visits.items, (v) =>
        activityScope(v.userId),
      ),
      recent_interactions: await this.filterAllowed(
        request,
        now,
        VISIT_READ,
        interactions.items,
        (i) => activityScope(i.userId),
      ),
      sales: await this.customerSales(request, now, customerResourceOf(customer), customerIds),
    };
  }

  /**
   * P4-10 : volet ventes de la fiche client (D02 « fiche client » ; BR-CRM-007 : comptes absorbés
   * compris). Encours et créances par ancienneté : fait du compte, évalué sur la portée du client
   * (`sales.receivable.read`). Dernières commandes et ventes (`sales.order.read`,
   * `sales.sale.read`) : chaque document sur sa propre portée (RC-04), comme les listes de
   * `sales-api/`. `null` : droit absent sur ce client.
   */
  private async customerSales(
    request: AuthenticatedRequest,
    now: Date,
    resource: ResourceLocator,
    customerIds: readonly string[],
  ) {
    const RECENT = 10;
    const today = businessDayOf(now);
    const visible = async <T extends { readonly resource: ResourceLocator }>(
      permission: string,
      items: readonly T[],
    ): Promise<T[]> => {
      const kept: T[] = [];
      for (const item of items) {
        if (kept.length === RECENT) break;
        if (await this.allowed(request, now, permission, item.resource)) kept.push(item);
      }
      return kept;
    };
    const newestFirst = <T extends { readonly occurredAt: string }>(items: readonly T[]) =>
      [...items].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    const holds = async (permission: string) =>
      hasPermissionAt(this.db, toBin(request.auth!.sub), permission, now);

    const receivables = (await this.allowed(request, now, 'sales.receivable.read', resource))
      ? summarizeReceivables(await listReceivables(this.db, { today, customerIds }))
      : null;
    const recentOrders = (await holds('sales.order.read'))
      ? (
          await visible(
            'sales.order.read',
            newestFirst(
              (
                await Promise.all(
                  customerIds.map((customerId) =>
                    listOrders(this.db, { customerId, limit: SALES_LIST_MAX_LIMIT }),
                  ),
                )
              ).flatMap((page) => page.items),
            ),
          )
        ).slice(0, RECENT)
      : null;
    const recentSales = (await holds('sales.sale.read'))
      ? (
          await visible(
            'sales.sale.read',
            newestFirst(
              (
                await Promise.all(
                  customerIds.map((customerId) =>
                    listSales(this.db, { customerId, limit: SALES_LIST_MAX_LIMIT }),
                  ),
                )
              ).flatMap((page) => page.items),
            ),
          )
        ).slice(0, RECENT)
      : null;
    return {
      outstandingXaf: receivables?.totalXaf ?? null,
      receivables,
      recent_orders: recentOrders,
      recent_sales: recentSales,
    };
  }

  private async activityFilter(
    request: AuthenticatedRequest,
    now: Date,
    query: z.infer<typeof activityQuerySchema>,
  ) {
    await this.requirePermission(request, now, { type: 'VISIT' }, VISIT_READ);
    const all = await this.hasAllScope(request, now, VISIT_READ);
    const userId = this.userOf(request, query.user_id);
    const userIds =
      !all && userId === undefined && query.customer_id === undefined
        ? await this.defaultUsers(request, now)
        : undefined;
    const customerIds =
      query.customer_id !== undefined
        ? [query.customer_id, ...(await absorbedCustomerIds(this.db, query.customer_id))]
        : undefined;
    return {
      all,
      filter: {
        ...(userId !== undefined ? { userId } : {}),
        ...(userIds !== undefined ? { userIds } : {}),
        ...(customerIds !== undefined ? { customerIds } : {}),
        ...(query.from !== undefined ? { fromUtc: businessDayStartUtc(query.from) } : {}),
        ...(query.to !== undefined ? { toUtc: businessDayEndUtc(query.to) } : {}),
        ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
        limit: query.limit ?? CRM_LIST_DEFAULT_LIMIT,
      },
    };
  }

  @Get('visits')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(VISIT_READ)
  async visits(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(activityQuerySchema, rawQuery);
    const now = this.clock.now();
    const { all, filter } = await this.activityFilter(request, now, query);
    const page = await listVisits(this.db, filter);
    const visits = all
      ? [...page.items]
      : await this.filterAllowed(request, now, VISIT_READ, page.items, (v) => ({
          ownerUserId: v.userId,
          zoneId: v.customerZoneId,
        }));
    return { visits, next_cursor: page.nextCursor };
  }

  @Get('interactions')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(VISIT_READ)
  async interactions(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(activityQuerySchema, rawQuery);
    const now = this.clock.now();
    const { all, filter } = await this.activityFilter(request, now, query);
    const page = await listInteractions(this.db, filter);
    const interactions = all
      ? [...page.items]
      : await this.filterAllowed(request, now, VISIT_READ, page.items, (i) => ({
          ownerUserId: i.userId,
          zoneId: i.customerZoneId,
        }));
    return { interactions, next_cursor: page.nextCursor };
  }

  /** Objectif lisible : le sien, celui d'une équipe dirigée, ou dans la portée de la cible. */
  private async targetReadable(
    request: AuthenticatedRequest,
    now: Date,
    target: TargetSummary,
  ): Promise<boolean> {
    const me = request.auth!.sub;
    if (target.userId === me || target.teamManagerUserId === me) return true;
    const resource: ResourceLocator =
      target.userId !== null
        ? { ownerUserId: target.userId }
        : target.siteId !== null
          ? { siteId: target.siteId }
          : {};
    return this.allowed(request, now, TARGET_READ, resource);
  }

  @Get('targets')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(TARGET_READ)
  async targets(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(targetsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'SALES_TARGET' }, TARGET_READ);
    const all = await this.hasAllScope(request, now, TARGET_READ);
    const userId = this.userOf(request, query.user_id);
    const unanchored =
      !all && userId === undefined && query.team_id === undefined && query.site_id === undefined;
    // S-39 (AV-522) : sans ancrage, comme `/visits` et `/customers`, la liste porte les objectifs de soi, des membres
    // des équipes dirigées et de ces équipes (auparavant les seuls objectifs propres).
    const targets = unanchored
      ? [
          ...(await listTargets(this.db, {
            userIds: await this.defaultUsers(request, now),
            targetType: 'USER',
            ...(query.active_on !== undefined ? { activeOn: query.active_on } : {}),
          })),
          ...(
            await listTargets(this.db, {
              targetType: 'TEAM',
              ...(query.active_on !== undefined ? { activeOn: query.active_on } : {}),
            })
          ).filter((target) => target.teamManagerUserId === request.auth!.sub),
        ]
      : await listTargets(this.db, {
          ...(userId !== undefined ? { userId } : {}),
          ...(query.team_id !== undefined ? { teamId: query.team_id } : {}),
          ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
          ...(query.active_on !== undefined ? { activeOn: query.active_on } : {}),
        });
    const readable: TargetSummary[] = [];
    for (const target of targets) {
      if (all || (await this.targetReadable(request, now, target))) readable.push(target);
    }
    return { targets: readable };
  }

  /**
   * Effort commercial sur une période de jours métier (ECR-CRM-05, version simple ; AT-015) et
   * objectifs de l'utilisateur couvrant la période, avec leur réalisé quand il est calculable.
   */
  @Get('performance/commercial')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(TARGET_READ)
  async performance(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(performanceQuerySchema, rawQuery);
    if (query.to < query.from) throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
    const now = this.clock.now();
    const userId = this.userOf(request, query.user_id) ?? request.auth!.sub;
    await this.requirePermission(request, now, { type: 'USER', id: userId }, TARGET_READ);
    if (
      userId !== request.auth!.sub &&
      !(await this.allowed(request, now, TARGET_READ, { ownerUserId: userId }))
    ) {
      return this.deny(request, now, { type: 'USER', id: userId }, TARGET_READ, 'OUT_OF_SCOPE');
    }
    const effort = await commercialEffort(this.db, {
      userId,
      fromUtc: businessDayStartUtc(query.from),
      toUtc: businessDayEndUtc(query.to),
    });
    const targets = (await listTargets(this.db, { userId })).filter(
      (t) => t.periodStart <= query.to && t.periodEnd >= query.from,
    );
    // P9-27 : le réalisé d'un objectif est défini une seule fois (`sales.targetRealized`, ADR-065 §2) ; ici, sur la
    // fenêtre demandée. CA : ventes attribuées au commercial (BR-VEN-020), nettes des annulations (BR-FIN-042).
    const fromUtc = businessDayStartUtc(query.from);
    const toUtc = businessDayEndUtc(query.to);
    const realizedOf = (t: (typeof targets)[number]): Promise<number | null> =>
      targetRealized(this.db, {
        userId,
        metric: t.metric,
        productId: t.productId,
        fromUtc,
        toUtc,
      });
    return {
      user_id: userId,
      from: query.from,
      to: query.to,
      effort,
      targets: await Promise.all(
        targets.map(async (t) => ({ ...t, realized: await realizedOf(t) })),
      ),
    };
  }

  /**
   * Bilans hebdomadaires des commerciaux (fiche BH ; PP-E, REQ-307, AV-314) : `GET /weekly-reports`. Le sien se lit
   * avec la seule permission ; ceux d'une équipe dirigée ou de tous, selon la portée de `crm.weekly_report.read`
   * (élément par élément, RC-04). Sans ancrage et hors portée `ALL` : soi et les membres des équipes dirigées.
   */
  @Get('weekly-reports')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(WEEKLY_REPORT_READ)
  async weeklyReports(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(weeklyReportsQuerySchema, rawQuery);
    const now = this.clock.now();
    const me = request.auth!.sub;
    await this.requirePermission(request, now, { type: 'WEEKLY_REPORT' }, WEEKLY_REPORT_READ);
    const all = await this.hasAllScope(request, now, WEEKLY_REPORT_READ);
    const anchored = this.userOf(request, query.user_id);
    // Sans ancrage et hors portée `ALL` : les titulaires que les octrois admettent (soi, les équipes dirigées, l'équipe
    // d'une affectation `TEAM`), pas seulement les équipes dirigées.
    const confinement = all ? null : await listConfinementAt(this.db, me, WEEKLY_REPORT_READ, now);
    const userIds =
      anchored !== undefined
        ? [anchored]
        : confinement === null
          ? undefined
          : [...confinement.ownerUserIds];
    const reports = await listWeeklyReports(this.db, {
      ...(userIds !== undefined ? { userIds } : {}),
      ...(query.week_start !== undefined ? { weekStart: query.week_start } : {}),
      ...(query.from_week !== undefined ? { fromWeek: query.from_week } : {}),
      ...(query.to_week !== undefined ? { toWeek: query.to_week } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    // Son propre bilan se lit avec la seule permission : l'auteur en est le titulaire par construction, et un commercial
    // terrain (affectation de zone) ne tomberait jamais dans la portée `OWN` d'une ressource sans zone ni site.
    const readable: (typeof reports)[number][] = [];
    for (const report of reports) {
      if (
        all ||
        report.userId === me ||
        (await this.allowed(request, now, WEEKLY_REPORT_READ, { ownerUserId: report.userId }))
      ) {
        readable.push(report);
      }
    }
    return { reports: readable };
  }

  /**
   * Chiffres de la semaine d'un commercial (visites, prospects, clients, CA, encaissé, pertes), **calculés** et jamais
   * saisis : `GET /weekly-reports/figures?week_start=`. Mêmes règles de portée que le bilan ; la valeur des pertes est
   * au coût, donc `null` sans `inventory.valuation.read` (RC-05).
   */
  @Get('weekly-reports/figures')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(WEEKLY_REPORT_READ)
  async weeklyReportFigures(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(weeklyFiguresQuerySchema, rawQuery);
    if (!isMondayBusinessDay(query.week_start)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'La semaine commence un lundi.');
    }
    const now = this.clock.now();
    const me = request.auth!.sub;
    const userId = this.userOf(request, query.user_id) ?? me;
    await this.requirePermission(request, now, { type: 'USER', id: userId }, WEEKLY_REPORT_READ);
    if (
      userId !== me &&
      !(await this.allowed(request, now, WEEKLY_REPORT_READ, { ownerUserId: userId }))
    ) {
      return this.deny(
        request,
        now,
        { type: 'USER', id: userId },
        WEEKLY_REPORT_READ,
        'OUT_OF_SCOPE',
      );
    }
    const includeCosts = await hasPermissionAt(this.db, toBin(me), VALUATION_READ, now);
    return {
      user_id: userId,
      week_start: query.week_start,
      figures: await weeklyFigures(this.db, { userId, weekStart: query.week_start, includeCosts }),
    };
  }
}
