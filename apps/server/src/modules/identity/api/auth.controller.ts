/**
 * `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password` (P0-09 ;
 * 07-security-rbac/02-securite.md §2, §3). Adaptateur HTTP du module `identity` (gabarit
 * `api/`, comme `auth.guard.ts`) : authentifie et gère la session — RC-01/RC-02 restent au
 * pipeline de commande (`commands/`), pas ici (« un jeton valide authentifie un auteur, il
 * n'autorise aucune action par lui-même »).
 */
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../platform/id-generator.provider.js';
import { DATABASE, type Database } from '../../../platform/kysely/database.provider.js';
import { ApiError } from '../../../platform/http/api-error.exception.js';
import { toBin, fromBin } from '../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../platform/kysely/bool-column.js';
import { recordAudit } from '../../../audit/record-audit.js';
import { JWT_KEYS } from '../jwt-keys.provider.js';
import {
  signAccessToken,
  ACCESS_TOKEN_TTL_MS,
  type JwtKeyPair,
} from '../application/public/jwt.js';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard.js';
import { Public, SelfScoped } from '../../../platform/http/authorization.decorators.js';
import { hashPassword, verifyPassword } from '../application/auth/password.js';
import {
  checkLoginLock,
  recordLoginFailure,
  resetLoginAttempts,
} from '../application/auth/login-lockout.js';
import { findOrEnrollDevice } from '../application/auth/device-enrollment.js';
import { createSession, rotateSession, revokeSessionById } from '../application/auth/session.js';

const loginSchema = z.object({
  phone: z.string().min(1).max(20),
  password: z.string().min(1),
  device_id: z.string().uuid(),
  device_label: z.string().max(200).optional(),
  platform: z.string().max(100).optional(),
  app_version: z.string().max(20).optional(),
});

const refreshSchema = z.object({ refresh_token: z.string().min(1) });

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

function validationError(issues: readonly { message: string }[]): ApiError {
  return new ApiError(
    400,
    'VALIDATION_ERROR',
    `Corps de requête invalide : ${issues.map((i) => i.message).join(' ; ')}`,
  );
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JWT_KEYS) private readonly jwtKeys: JwtKeyPair,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  async login(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const parsed = loginSchema.safeParse(rawBody);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const {
      phone,
      password,
      device_id: deviceId,
      device_label: deviceLabel,
      platform,
      app_version: appVersion,
    } = parsed.data;
    const now = this.clock.now();
    const ip = request.ip;

    const [identifierLock, ipLock] = await Promise.all([
      checkLoginLock(this.db, 'IDENTIFIER', phone, now),
      checkLoginLock(this.db, 'IP', ip, now),
    ]);
    if (identifierLock.blocked || ipLock.blocked) {
      throw new ApiError(429, 'LOGIN_LOCKED', 'Trop de tentatives : réessayez plus tard.');
    }

    const user = await this.db
      .selectFrom('identity_users')
      .select(['id', 'password_hash', 'status', 'must_change_password'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    const fail = async (actorUserId: string | null): Promise<never> => {
      await this.db.transaction().execute(async (trx) => {
        await recordLoginFailure(trx, 'IDENTIFIER', phone, now);
        await recordLoginFailure(trx, 'IP', ip, now);
        if (actorUserId) {
          // `audit_audit_log.actor_user_id` est NOT NULL (FK identity_users) : un
          // identifiant inconnu n'a pas d'acteur réel à référencer, seul le verrouillage
          // ci-dessus s'applique dans ce cas (pas d'entrée d'audit).
          await recordAudit(
            trx,
            { idGenerator: this.idGenerator, clock: this.clock },
            {
              occurredAt: now,
              actorUserId,
              actorRoles: [],
              action: 'auth.login.failed',
              entityType: 'USER',
              entityId: actorUserId,
              ip,
              result: 'FAILED',
            },
          );
        }
      });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Identifiants invalides.');
    };

    if (!user) return fail(null);
    const passwordOk = await verifyPassword(user.password_hash, password);
    if (!passwordOk) return fail(fromBin(user.id));
    if (user.status !== 'ACTIVE') return fail(fromBin(user.id));

    const userId = fromBin(user.id);
    const deviceResult = await this.db.transaction().execute((trx) =>
      findOrEnrollDevice(trx, {
        deviceId,
        enrolledByUserId: userId,
        now,
        ...(deviceLabel !== undefined ? { label: deviceLabel } : {}),
        ...(platform !== undefined ? { platform } : {}),
        ...(appVersion !== undefined ? { appVersion } : {}),
      }),
    );
    if (!deviceResult.ok) return fail(userId);

    const { sessionId, refreshToken } = await this.db.transaction().execute(async (trx) => {
      const issued = await createSession(trx, this.idGenerator, { userId, deviceId, now, ip });
      await resetLoginAttempts(trx, 'IDENTIFIER', phone);
      await resetLoginAttempts(trx, 'IP', ip);
      await trx
        .updateTable('identity_users')
        .set({ last_login_at: now })
        .where('id', '=', user.id)
        .execute();
      await recordAudit(
        trx,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: userId,
          actorRoles: [],
          deviceId,
          action: 'auth.login.succeeded',
          entityType: 'USER',
          entityId: userId,
          ip,
          result: 'SUCCESS',
        },
      );
      return issued;
    });

    const accessToken = await signAccessToken(
      this.jwtKeys.privateKey,
      { sub: userId, device_id: deviceId, session_id: sessionId },
      now,
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      must_change_password: Boolean(user.must_change_password),
      device_status: deviceResult.status,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  async refresh(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const parsed = refreshSchema.safeParse(rawBody);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const now = this.clock.now();
    const ip = request.ip;

    const outcome = await this.db
      .transaction()
      .execute((trx) => rotateSession(trx, this.idGenerator, parsed.data.refresh_token, now, ip));

    if (!outcome.ok) {
      if (outcome.reason === 'TOKEN_REUSE') {
        // La famille est déjà révoquée par rotateSession ; seule la trace d'audit reste à
        // écrire ici (§11 « rafraîchissement anormal »), dans sa propre transaction — la
        // détection elle-même n'a pas besoin d'attendre cette écriture.
        await this.db.transaction().execute((trx) =>
          recordAudit(
            trx,
            { idGenerator: this.idGenerator, clock: this.clock },
            {
              occurredAt: now,
              actorUserId: outcome.userId,
              actorRoles: [],
              deviceId: outcome.deviceId,
              action: 'auth.token.reuse_detected',
              entityType: 'USER',
              entityId: outcome.userId,
              ip,
              result: 'FAILED',
              errorCode: 'TOKEN_REUSE',
            },
          ),
        );
        throw new ApiError(
          401,
          'TOKEN_REUSE',
          'Jeton de rafraîchissement déjà utilisé : session révoquée.',
        );
      }
      throw new ApiError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Jeton de rafraîchissement invalide ou expiré.',
      );
    }

    const accessToken = await signAccessToken(
      this.jwtKeys.privateKey,
      { sub: outcome.userId, device_id: outcome.deviceId, session_id: outcome.sessionId },
      now,
    );
    return {
      access_token: accessToken,
      refresh_token: outcome.refreshToken,
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async logout(@Req() request: AuthenticatedRequest) {
    const auth = request.auth!;
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await revokeSessionById(trx, auth.session_id, 'LOGOUT', now);
      await recordAudit(
        trx,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: auth.sub,
          actorRoles: [],
          deviceId: auth.device_id,
          action: 'auth.session.revoked',
          entityType: 'SESSION',
          entityId: auth.session_id,
          reason: 'LOGOUT',
          result: 'SUCCESS',
        },
      );
    });
    return { status: 'ok' };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async changePassword(@Body() rawBody: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = changePasswordSchema.safeParse(rawBody);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const auth = request.auth!;
    const now = this.clock.now();

    const user = await this.db
      .selectFrom('identity_users')
      .select(['id', 'password_hash'])
      .where('id', '=', toBin(auth.sub))
      .executeTakeFirstOrThrow();
    const currentOk = await verifyPassword(user.password_hash, parsed.data.current_password);
    if (!currentOk) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
    }

    const newHash = await hashPassword(parsed.data.new_password);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity_users')
        .set({ password_hash: newHash, must_change_password: toDbBool(false) })
        .where('id', '=', user.id)
        .execute();
      await recordAudit(
        trx,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: auth.sub,
          actorRoles: [],
          deviceId: auth.device_id,
          action: 'identity.user.change_password',
          entityType: 'USER',
          entityId: auth.sub,
          result: 'SUCCESS',
        },
      );
    });
    return { status: 'ok' };
  }
}
