/**
 * `POST /api/v1/sync/push`, `GET /api/v1/sync/pull` (06-offline-sync/02-synchronisation.md
 * §3, §5 ; P0-12).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@gic/contracts';
import { pullRequestSchema, pushRequestSchema } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../platform/clock.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { CommandRegistryDelegated, SelfScoped } from '../platform/http/authorization.decorators.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncPullService } from './sync-pull.service.js';

@Controller('api/v1/sync')
export class SyncController {
  constructor(
    @Inject(SyncPushService) private readonly pushService: SyncPushService,
    @Inject(SyncPullService) private readonly pullService: SyncPullService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('push')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @CommandRegistryDelegated()
  async push(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<PushResponse> {
    const parsed = pushRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    const auth = request.auth!;
    if (parsed.data.device_id !== auth.device_id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        "L'appareil déclaré ne correspond pas à la session authentifiée.",
      );
    }
    const req: PushRequest = parsed.data;
    return this.pushService.push(req, {
      authenticatedUserId: auth.sub,
      authenticatedDeviceId: auth.device_id,
      correlationId: request.correlationId,
    });
  }

  @Get('pull')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async pull(
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<PullResponse> {
    const parsed = pullRequestSchema.safeParse(coerceQuery(rawQuery));
    if (!parsed.success) {
      throw validationError(parsed.error.issues);
    }
    const auth = request.auth!;
    const req: PullRequest = parsed.data;
    return this.pullService.pull(req, {
      authenticatedUserId: auth.sub,
      authenticatedDeviceId: auth.device_id,
      now: this.clock.now(),
    });
  }
}

function validationError(issues: readonly { message: string }[]): ApiError {
  return new ApiError(
    400,
    'VALIDATION_ERROR',
    `Corps de requête invalide : ${issues.map((i) => i.message).join(' ; ')}`,
  );
}

/** Query string HTTP : tout est texte ; `pullRequestSchema` attend `cursor`/`limit` numériques. */
function coerceQuery(rawQuery: unknown): unknown {
  if (typeof rawQuery !== 'object' || rawQuery === null) return rawQuery;
  const query = rawQuery as Record<string, unknown>;
  return {
    ...query,
    ...(typeof query.cursor === 'string' ? { cursor: Number(query.cursor) } : {}),
    ...(typeof query.limit === 'string' ? { limit: Number(query.limit) } : {}),
  };
}
