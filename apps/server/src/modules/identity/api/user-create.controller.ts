/**
 * Création d'un compte par l'administrateur (MP-13 ; ECR-ADM-04 ; AV-325 ; UC-ADM-01 ; ADR-045).
 *
 * `POST /users` : route **en ligne, hors du journal des commandes**, comme la réinitialisation du mot de
 * passe (AV-252) — le mot de passe provisoire saisi par l'Admin ne passe jamais par
 * `sync.command_inbox`, un événement, l'audit ou la base locale de l'appareil, et n'est jamais renvoyé.
 * La commande `identity.user.create` reste disponible pour les scripts et l'import (AV-072) ; elle
 * garde son mot de passe masqué (ADR-045) mais le conserve dans la file d'envoi de l'appareil qui
 * l'émet, ce que l'écran évite.
 *
 * - Droit : `identity.user.manage` (l'Admin seul, portée `ALL`) ; avec une affectation initiale,
 *   `identity.role_assignment.manage` aussi. Sans eux, 403 audité. Appareil `ACTIVE` exigé (RC-02), comme
 *   les autres écritures hors du pipeline des commandes.
 * - Téléphone E.164 (BR-ADM-001) ; unique parmi les comptes non désactivés (`PHONE_ALREADY_USED`, 409).
 * - Mot de passe : règles partagées (`newPasswordProblem`, AV-280), `PASSWORD_INVALID` (400).
 * - Effets, dans une transaction : compte `ACTIVE` avec `must_change_password` (la PWA impose le
 *   changement à la première connexion, AV-251) ; affectation initiale facultative (mêmes contrôles que
 *   `identity.role_assignment.grant` : rôle actif, type de périmètre permis, site existant) ; audit
 *   `identity.user.create` sans mot de passe ni téléphone. Une affectation refusée annule le compte.
 */
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
import { RequiresPermission } from '../../../platform/http/authorization.decorators.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../platform/kysely/bool-column.js';
import { recordAudit } from '../../../audit/record-audit.js';
import { recordDenied } from '../../../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard.js';
import { PASSWORD_PROBLEM_MESSAGES } from './auth.controller.js';
import { hashPassword } from '../application/auth/password.js';
import { hasPermissionAt } from '../application/public/rights-check.js';
import { checkDeviceActive } from '../application/public/device-check.js';
import { insertRoleAssignment } from '../application/role-assignment-writer.js';

const USER_MANAGE = 'identity.user.manage';
const ROLE_ASSIGNMENT_MANAGE = 'identity.role_assignment.manage';

const roleSchema = z
  .object({
    role_id: z.string().uuid(),
    scope_type: z.enum(['GLOBAL', 'SITE', 'ZONE', 'TEAM']),
    scope_site_id: z.string().uuid().optional(),
    scope_zone_id: z.string().uuid().optional(),
    scope_team_id: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    const target = {
      SITE: data.scope_site_id,
      ZONE: data.scope_zone_id,
      TEAM: data.scope_team_id,
    } as const;
    const provided = Object.values(target).filter((value) => value !== undefined).length;
    const expected = data.scope_type === 'GLOBAL' ? undefined : target[data.scope_type];
    const coherent =
      data.scope_type === 'GLOBAL' ? provided === 0 : expected !== undefined && provided === 1;
    if (!coherent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Périmètre incohérent avec le type choisi.',
      });
    }
  });

const createSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  // BR-ADM-001 : E.164 (voir aussi ck_identity_users_phone).
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  email: z.string().trim().email().max(200).optional(),
  // Longueur jugée par `newPasswordProblem` (message propre, code `PASSWORD_INVALID`).
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
  role: roleSchema.optional(),
});

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

const REFUSAL_STATUS = { NOT_FOUND: 404, ROLE_INACTIVE: 400, SCOPE_TYPE_NOT_ALLOWED: 400 } as const;

@Controller('api/v1')
export class UserCreateController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Post('users')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @RequiresPermission(USER_MANAGE)
  async create(@Body() rawBody: unknown, @Req() request: AuthenticatedRequest) {
    // Message sans valeur saisie : jamais d'écho du mot de passe.
    const body = createSchema.safeParse(rawBody);
    if (!body.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Compte invalide : nom, téléphone au format +237… et mot de passe provisoire attendus.',
      );
    }
    const auth = request.auth!;
    const now = this.clock.now();
    const deps = { idGenerator: this.idGenerator, clock: this.clock };
    const denied = async (errorCode: string) =>
      recordDenied(this.db, deps, {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'identity.user.create',
        entityType: 'USER',
        entityId: null,
        errorCode,
        correlationId: request.correlationId,
      });

    const allowed =
      (await hasPermissionAt(this.db, toBin(auth.sub), USER_MANAGE, now)) &&
      (body.data.role === undefined ||
        (await hasPermissionAt(this.db, toBin(auth.sub), ROLE_ASSIGNMENT_MANAGE, now)));
    if (!allowed) {
      await denied('FORBIDDEN');
      throw new ApiError(403, 'FORBIDDEN', 'Création de compte réservée à l’administrateur.');
    }
    const device = await checkDeviceActive(this.db, toBin(auth.device_id), now);
    if (!device.ok) {
      await denied(device.reason);
      throw new ApiError(
        403,
        device.reason,
        'Création impossible depuis cet appareil : il doit être approuvé et en service.',
      );
    }
    const problem = newPasswordProblem({ password: body.data.password });
    if (problem) {
      throw new ApiError(400, 'PASSWORD_INVALID', PASSWORD_PROBLEM_MESSAGES[problem]!, { problem });
    }
    const phoneTaken = await this.db
      .selectFrom('identity_users')
      .select('id')
      .where('phone', '=', body.data.phone)
      .where('status', '!=', 'DEACTIVATED')
      .executeTakeFirst();
    if (phoneTaken) {
      throw new ApiError(
        409,
        'PHONE_ALREADY_USED',
        'Ce numéro est déjà utilisé par un compte actif.',
      );
    }

    const userId = this.idGenerator.newId();
    const assignmentId = this.idGenerator.newId();
    const passwordHash = await hashPassword(body.data.password);
    const role = body.data.role;
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('identity_users')
          .values({
            id: toBin(userId),
            full_name: body.data.full_name,
            phone: body.data.phone,
            email: body.data.email ?? null,
            password_hash: passwordHash,
            must_change_password: toDbBool(true),
            status: 'ACTIVE',
            created_by: toBin(auth.sub),
          })
          .execute();
        if (role !== undefined) {
          const refusal = await insertRoleAssignment(trx, {
            assignmentId,
            userId,
            roleId: role.role_id,
            scopeType: role.scope_type,
            scopeSiteId: role.scope_site_id,
            scopeZoneId: role.scope_zone_id,
            scopeTeamId: role.scope_team_id,
            validFrom: now,
            createdBy: auth.sub,
          });
          // Lever ici annule la transaction : un compte sans l'affectation demandée n'est pas créé.
          if (refusal)
            throw new ApiError(REFUSAL_STATUS[refusal.code], refusal.code, refusal.message);
        }
        await recordAudit(trx, deps, {
          occurredAt: now,
          actorUserId: auth.sub,
          actorRoles: [],
          deviceId: auth.device_id,
          action: 'identity.user.create',
          entityType: 'USER',
          entityId: userId,
          // Jamais le mot de passe ni le téléphone : seulement ce que le compte devient.
          after: {
            status: 'ACTIVE',
            must_change_password: true,
            ...(role !== undefined ? { role_assignment_id: assignmentId } : {}),
          },
          result: 'SUCCESS',
          correlationId: request.correlationId,
        });
      });
    } catch (error) {
      // Course sur le numéro entre le contrôle et l'insertion (index `uq_identity_users_active_phone`).
      if (isDuplicateEntry(error)) {
        throw new ApiError(
          409,
          'PHONE_ALREADY_USED',
          'Ce numéro est déjà utilisé par un compte actif.',
        );
      }
      throw error;
    }
    return {
      id: userId,
      full_name: body.data.full_name,
      status: 'ACTIVE',
      must_change_password: true,
      ...(role !== undefined ? { role_assignment_id: assignmentId } : {}),
    };
  }
}
