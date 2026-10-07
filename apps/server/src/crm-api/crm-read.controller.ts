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
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
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
  periodProductQuantity,
  periodRevenue,
  summarizeReceivables,
} from '../modules/sales/application/public/index.js';
import {
  CRM_LIST_DEFAULT_LIMIT,
  CRM_LIST_MAX_LIMIT,
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
  type TargetSummary,
} from '../modules/crm/application/public/index.js';

const CUSTOMER_READ = 'crm.customer.read';
const CUSTOMER_CREATE = 'crm.customer.create';
const VISIT_READ = 'crm.visit.read';
const TARGET_READ = 'crm.target.read';

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

/** Métriques d'objectif d'effort (P3) ; `CA` et `QTE_PRODUIT` viennent des ventes (P4-09). */
const REALIZED_METRICS = {
  VISITES: 'visits',
  PROSPECTS_CREES: 'prospectsCreated',
  NOUVEAUX_CLIENTS: 'newCustomers',
} as const;

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
    let userId = this.userOf(request, query.user_id);
    if (
      !all &&
      userId === undefined &&
      query.team_id === undefined &&
      query.site_id === undefined
    ) {
      userId = request.auth!.sub;
    }
    const targets = await listTargets(this.db, {
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
    const period = {
      fromUtc: businessDayStartUtc(query.from),
      toUtc: businessDayEndUtc(query.to),
      commercialUserId: userId,
    };
    // Ventes attribuées au commercial (BR-VEN-020), nettes des annulations de la période (BR-FIN-042).
    const revenue = targets.some((t) => t.metric === 'CA')
      ? (await periodRevenue(this.db, period)).netRevenueXaf
      : null;
    const realizedOf = async (t: (typeof targets)[number]): Promise<number | null> => {
      if (t.metric === 'CA') return revenue;
      if (t.metric === 'QTE_PRODUIT' && t.productId !== null) {
        return periodProductQuantity(this.db, { ...period, productId: t.productId });
      }
      const key = REALIZED_METRICS[t.metric as keyof typeof REALIZED_METRICS];
      return key !== undefined ? effort[key] : null;
    };
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
}
