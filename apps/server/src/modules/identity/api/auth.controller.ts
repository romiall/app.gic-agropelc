/**
 * `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password` (P0-09 ;
 * 07-security-rbac/02-securite.md §2, §3). Adaptateur HTTP du module `identity` (gabarit
 * `api/`, comme `auth.guard.ts`) : authentifie et gère la session — RC-01/RC-02 restent au
 * pipeline de commande (`commands/`), pas ici (« un jeton valide authentifie un auteur, il
 * n'autorise aucune action par lui-même »).
 *
 * MP-08 (AV-251, AV-280, ADR-045) : `change-password` applique les règles partagées d'un nouveau mot de
 * passe (`newPasswordProblem` : 8 à 128 caractères, différent de l'actuel) et compte un mot de passe
 * actuel faux comme un échec de connexion de l'utilisateur (verrouillage progressif, 02-securite §2) ;
 * aucun mot de passe n'est journalisé ni audité. Le changement imposé du mot de passe provisoire reste
 * l'affaire de l'écran (AV-251) : le serveur ne refuse rien d'autre.
 */
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  LOGIN_PASSWORD_MAX_LENGTH,
  newPasswordProblem,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
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
import {
  findOrEnrollDevice,
  type DeviceLoginRefusal,
} from '../application/auth/device-enrollment.js';
import { createSession, rotateSession, revokeSessionById } from '../application/auth/session.js';

const loginSchema = z.object({
  phone: z.string().min(1).max(20),
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
  device_id: z.string().uuid(),
  device_label: z.string().max(200).optional(),
  platform: z.string().max(100).optional(),
  app_version: z.string().max(20).optional(),
});

const refreshSchema = z.object({ refresh_token: z.string().min(1) });

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
  // Longueur jugée par `newPasswordProblem` (message propre, code `PASSWORD_INVALID`).
  new_password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
});

/** Messages des défauts d'un nouveau mot de passe (MP-08, AV-280). */
export const PASSWORD_PROBLEM_MESSAGES: Readonly<Record<string, string>> = {
  TOO_SHORT: 'Mot de passe trop court : 8 caractères au moins.',
  TOO_LONG: 'Mot de passe trop long : 128 caractères au plus.',
  UNCHANGED: 'Le nouveau mot de passe doit être différent de l’actuel.',
};

function validationError(issues: readonly { message: string }[]): ApiError {
  return new ApiError(
    400,
    'VALIDATION_ERROR',
    `Corps de requête invalide : ${issues.map((i) => i.message).join(' ; ')}`,
  );
}

/** AV-253 : message rendu après un mot de passe correct, selon l'état de l'appareil. */
const DEVICE_REFUSAL_MESSAGES: Record<DeviceLoginRefusal, string> = {
  DEVICE_BLOCKED: 'Cet appareil est bloqué : contactez votre responsable.',
  DEVICE_LOST: 'Cet appareil a été déclaré perdu : contactez votre responsable.',
  DEVICE_RETIRED: 'Cet appareil est retiré du service : contactez votre responsable.',
};

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

    // `errorCode` : motif écrit dans l'audit seulement (AV-253 : un compte suspendu ou désactivé garde le
    // message générique, son motif n'est lisible qu'au journal).
    const fail = async (actorUserId: string | null, errorCode?: string): Promise<never> => {
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
              errorCode: errorCode ?? 'INVALID_CREDENTIALS',
              correlationId: request.correlationId,
            },
          );
        }
      });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Identifiants invalides.');
    };

    // Utilisateur système (`password_hash` vide) : jamais de connexion, comme un identifiant inconnu.
    if (!user || user.password_hash === '') return fail(null);
    const passwordOk = await verifyPassword(user.password_hash, password);
    if (!passwordOk) return fail(fromBin(user.id));
    if (user.status !== 'ACTIVE') return fail(fromBin(user.id), `ACCOUNT_${user.status}`);

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
    if (!deviceResult.ok) {
      // AV-253 (13/10/2026) : le mot de passe est juste, l'appareil est hors service — motif rendu
      // (403, code distinct) pour renvoyer l'utilisateur vers son responsable ; ni compteur
      // d'échecs (les identifiants sont valides) ni session.
      await this.db.transaction().execute((trx) =>
        recordAudit(
          trx,
          { idGenerator: this.idGenerator, clock: this.clock },
          {
            occurredAt: now,
            actorUserId: userId,
            actorRoles: [],
            deviceId,
            action: 'auth.login.failed',
            entityType: 'USER',
            entityId: userId,
            ip,
            result: 'DENIED',
            errorCode: deviceResult.reason,
            correlationId: request.correlationId,
          },
        ),
      );
      throw new ApiError(403, deviceResult.reason, DEVICE_REFUSAL_MESSAGES[deviceResult.reason]);
    }

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
          correlationId: request.correlationId,
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
      // MP-06 : code court, affiché par l'appareil en attente d'approbation (BR-ADM-007).
      device_short_code: deviceResult.shortCode,
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
              correlationId: request.correlationId,
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
          correlationId: request.correlationId,
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
      .select(['id', 'password_hash', 'phone'])
      .where('id', '=', toBin(auth.sub))
      .executeTakeFirst();
    if (!user || user.password_hash === '') {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
    }
    // MP-08 : le mot de passe actuel se teste comme une connexion de cet utilisateur (verrouillage
    // progressif par identifiant, 02-securite §2) : un jeton d'accès volé ne permet pas de le deviner.
    if ((await checkLoginLock(this.db, 'IDENTIFIER', user.phone, now)).blocked) {
      throw new ApiError(429, 'LOGIN_LOCKED', 'Trop de tentatives : réessayez plus tard.');
    }
    const currentOk = await verifyPassword(user.password_hash, parsed.data.current_password);
    if (!currentOk) {
      await this.db.transaction().execute(async (trx) => {
        await recordLoginFailure(trx, 'IDENTIFIER', user.phone, now);
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
            result: 'FAILED',
            errorCode: 'INVALID_CREDENTIALS',
            correlationId: request.correlationId,
          },
        );
      });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
    }
    const problem = newPasswordProblem({
      password: parsed.data.new_password,
      current: parsed.data.current_password,
    });
    if (problem) {
      throw new ApiError(400, 'PASSWORD_INVALID', PASSWORD_PROBLEM_MESSAGES[problem]!, { problem });
    }

    const newHash = await hashPassword(parsed.data.new_password);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity_users')
        .set({ password_hash: newHash, must_change_password: toDbBool(false) })
        .where('id', '=', user.id)
        .execute();
      await resetLoginAttempts(trx, 'IDENTIFIER', user.phone);
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
          correlationId: request.correlationId,
        },
      );
    });
    return { status: 'ok' };
  }
}
