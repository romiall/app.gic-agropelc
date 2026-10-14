/**
 * Lectures de la communication (P9-06 ; D13 §4 UC-NOT-03 ; ADR-072 §3 ; AT-046 en partie) :
 * `GET /api/v1/alerts`, `/alerts/summary`, `/alerts/{id}`, `/notifications` et `/alert-rules`.
 *
 * - **Droit** : `comm.alert.read` (tous les rôles) ; `comm.alert_rule.manage` pour les règles (RC-01).
 *   Refus : 403 audité.
 * - **Étendue** : la boîte du lecteur plus sa supervision par la portée, jugée exactement ligne à ligne
 *   (`alertPage`) ; une alerte inconnue ou hors des deux est un 404 opaque audité (RC-07, RC-09).
 * - Réponses conformes à `@gic/contracts` (`alertListResponseSchema`…), partagées avec la PWA.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPES,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import type {
  AlertListResponse,
  AlertRuleListResponse,
  AlertSummary,
  NotificationListResponse,
} from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  ALERT_READ_PERMISSION,
  alertDetail,
  alertPage,
  alertSummary,
  decodeAlertCursor,
  decodeNotificationCursor,
  listAlertRuleItems,
  notificationPage,
  type AlertFilter,
  type AlertReadItem,
} from '../modules/communication/application/public/index.js';
import { idParamSchema, parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const RULE_PERMISSION = 'comm.alert_rule.manage';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Liste séparée par des virgules, restreinte à une liste blanche (sans doublon) ; 400 sinon. */
function listOf<T extends string>(
  raw: string | undefined,
  allowed: readonly [T, ...T[]],
): T[] | undefined {
  if (raw === undefined) return undefined;
  const values = [...new Set(raw.split(',').map((item) => item.trim()))];
  return parseOrThrow(z.array(z.enum(allowed)).min(1), values);
}

const alertsQuerySchema = z.object({
  status: z.string().trim().min(1).max(500).optional(),
  severity: z.string().trim().min(1).max(500).optional(),
  type: z.string().trim().min(1).max(1000).optional(),
  site_id: uuidParam.optional(),
  box: z.enum(['true', 'false']).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

const notificationsQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  channel: z.enum(['IN_APP', 'WEB_PUSH']).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function presentAlert(item: AlertReadItem): AlertListResponse['items'][number] {
  return {
    id: item.id,
    alertType: item.alertType,
    nature: item.nature,
    severity: item.severity,
    status: item.status,
    title: item.title,
    message: item.message,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    siteId: item.siteId,
    zoneId: item.zoneId,
    ownerUserId: item.ownerUserId,
    actionScreen: item.actionScreen,
    occurrences: item.occurrences,
    firstDetectedAt: item.firstDetectedAt.toISOString(),
    lastDetectedAt: item.lastDetectedAt.toISOString(),
    criticalSince: iso(item.criticalSince),
    escalatedAt: iso(item.escalatedAt),
    acknowledgedAt: iso(item.acknowledgedAt),
    acknowledgedBy: item.acknowledgedBy,
    resolvedAt: iso(item.resolvedAt),
    resolvedBy: item.resolvedBy,
    resolutionComment: item.resolutionComment,
    visibility: [...item.visibility],
    payload: item.payload,
  };
}

@Controller('api/v1')
export class CommunicationReadController {
  private readonly alertAccess: ReadAccess;
  private readonly ruleAccess: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.alertAccess = new ReadAccess(db, { clock, idGenerator }, ALERT_READ_PERMISSION);
    this.ruleAccess = new ReadAccess(db, { clock, idGenerator }, RULE_PERMISSION);
  }

  @Get('alerts')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ALERT_READ_PERMISSION)
  async alerts(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<AlertListResponse> {
    const query = parseOrThrow(alertsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.alertAccess.requirePermission(request, now, { type: 'ALERT' });
    const after = query.cursor === undefined ? undefined : decodeAlertCursor(query.cursor);
    if (query.cursor !== undefined && after === null) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
    }
    const statuses = listOf(query.status, ALERT_STATUSES);
    const severities = listOf(query.severity, ALERT_SEVERITIES);
    const alertTypes = listOf(query.type, ALERT_TYPES);
    const filter: AlertFilter = {
      ...(statuses !== undefined ? { statuses } : {}),
      ...(severities !== undefined ? { severities } : {}),
      ...(alertTypes !== undefined ? { alertTypes } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.box === 'true' ? { boxOnly: true } : {}),
    };
    const page = await alertPage(this.db, {
      userId: request.auth!.sub,
      at: now,
      filter,
      ...(after !== undefined && after !== null ? { after } : {}),
      limit: query.limit ?? DEFAULT_LIMIT,
    });
    return { items: page.items.map(presentAlert), nextCursor: page.nextCursor };
  }

  @Get('alerts/summary')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ALERT_READ_PERMISSION)
  async summary(@Req() request: AuthenticatedRequest): Promise<AlertSummary> {
    const now = this.clock.now();
    await this.alertAccess.requirePermission(request, now, { type: 'ALERT' });
    const summary = await alertSummary(this.db, { userId: request.auth!.sub, at: now });
    return { ...summary, computedAt: now.toISOString() };
  }

  @Get('alerts/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ALERT_READ_PERMISSION)
  async alert(
    @Param() rawParams: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<AlertListResponse['items'][number]> {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    await this.alertAccess.requirePermission(request, now, { type: 'ALERT', id });
    const item = await alertDetail(this.db, { userId: request.auth!.sub, at: now, id });
    if (item === null)
      return this.alertAccess.deny(request, now, { type: 'ALERT', id }, 'OUT_OF_SCOPE');
    return presentAlert(item);
  }

  @Get('notifications')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ALERT_READ_PERMISSION)
  async notifications(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<NotificationListResponse> {
    const query = parseOrThrow(notificationsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.alertAccess.requirePermission(request, now, { type: 'NOTIFICATION' });
    const after = query.cursor === undefined ? undefined : decodeNotificationCursor(query.cursor);
    if (query.cursor !== undefined && after === null) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
    }
    const page = await notificationPage(this.db, {
      userId: request.auth!.sub,
      at: now,
      ...(query.unread === 'true' ? { unreadOnly: true } : {}),
      ...(query.channel !== undefined ? { channel: query.channel } : {}),
      ...(after !== undefined && after !== null ? { after } : {}),
      limit: query.limit ?? DEFAULT_LIMIT,
    });
    return {
      items: page.items.map((item) => ({
        id: item.id,
        channel: item.channel,
        title: item.title,
        body: item.body,
        link: item.link,
        alertId: item.alertId,
        noteId: item.noteId,
        createdAt: item.createdAt.toISOString(),
        deliveredAt: iso(item.deliveredAt),
        readAt: iso(item.readAt),
      })),
      unreadCount: page.unreadCount,
      nextCursor: page.nextCursor,
    };
  }

  @Get('alert-rules')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(RULE_PERMISSION)
  async rules(@Req() request: AuthenticatedRequest): Promise<AlertRuleListResponse> {
    const now = this.clock.now();
    await this.ruleAccess.requirePermission(request, now, { type: 'ALERT_RULE' });
    const items = await listAlertRuleItems(this.db);
    return {
      items: items.map((item) => ({
        alertType: item.alertType,
        nature: item.nature,
        enabled: item.enabled,
        severity: item.severity,
        severitiesAdmitted: [...item.severitiesAdmitted],
        recipientRoles: [...item.recipientRoles],
        resolutionMode: item.resolutionMode,
        resolutionModesAdmitted: [...item.resolutionModesAdmitted],
        escalationHours: item.escalationHours,
        escalationApplicable: item.escalationApplicable,
        escalationRoles: [...item.escalationRoles],
        sourceAvailable: item.sourceAvailable,
        version: item.version,
        updatedAt: item.updatedAt.toISOString(),
        updatedBy: item.updatedBy,
      })),
    };
  }
}
