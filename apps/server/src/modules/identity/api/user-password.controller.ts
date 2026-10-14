/**
 * Réinitialisation du mot de passe d'un utilisateur par l'administrateur (MP-08 ; AV-252, AV-281 ;
 * ADR-045 ; 02-securite.md §2 « par l'Admin uniquement ; audit »).
 *
 * `POST /users/{id}/reset-password` : route **en ligne, hors du journal des commandes** (AV-252) — le
 * mot de passe saisi par l'Admin ne passe jamais par `sync.command_inbox`, un événement ou l'audit, et
 * n'est jamais renvoyé. Écrit par le module propriétaire des tables (`identity`).
 *
 * - Droit : `identity.user.manage` (l'Admin seul, portée `ALL`) ; sans lui, 403 audité.
 * - Appareil `ACTIVE` exigé (MP-11, revue adverse : RC-02, une écriture hors du pipeline des
 *   commandes garde la règle) ; un appareil en attente d'approbation reçoit 403 `DEVICE_PENDING`
 *   audité. La session, le compte de l'Admin et l'appareil hors service sont refusés en amont par la
 *   garde d'authentification (AV-282).
 * - Cible : un compte réel (l'utilisateur système n'existe pas pour cette route : 404) ; pas son propre
 *   compte (`RESET_OWN_PASSWORD` : le changement de mot de passe s'en charge) ; pas un compte désactivé
 *   (`USER_DEACTIVATED`) ; un compte suspendu est accepté (AV-281).
 * - Règles du nouveau mot de passe partagées (`newPasswordProblem`, AV-280) : `PASSWORD_INVALID`.
 * - Effets, dans une transaction : nouveau hachage, `must_change_password` posé (l'écran de la PWA
 *   impose le changement à la prochaine connexion, AV-251), toutes les sessions de l'utilisateur
 *   révoquées (motif `ADMIN`), verrouillage de son identifiant levé, audit
 *   `identity.user.reset_password` sans aucun mot de passe.
 * - Les jetons d'accès de l'utilisateur sont refusés dès sa requête suivante (AV-282 : la garde
 *   d'authentification constate la révocation de la session).
 */
import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
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
import { resetLoginAttempts } from '../application/auth/login-lockout.js';
import { revokeUserSessions } from '../application/commands/revoke-sessions.js';
import { hasPermissionAt } from '../application/public/rights-check.js';
import { checkDeviceActive } from '../application/public/device-check.js';

const USER_MANAGE = 'identity.user.manage';

const paramsSchema = z.object({ id: z.string().uuid() });
const resetPasswordSchema = z.object({
  // Longueur jugée par `newPasswordProblem` (message propre, code `PASSWORD_INVALID`).
  new_password: z.string().min(1).max(LOGIN_PASSWORD_MAX_LENGTH),
});

@Controller('api/v1')
export class UserPasswordController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Post('users/:id/reset-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(USER_MANAGE)
  async resetPassword(
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const params = paramsSchema.safeParse(rawParams);
    if (!params.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Identifiant d’utilisateur invalide.');
    }
    // Message sans valeur saisie : jamais d'écho du mot de passe.
    const body = resetPasswordSchema.safeParse(rawBody);
    if (!body.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Nouveau mot de passe attendu (`new_password`).');
    }
    const auth = request.auth!;
    const now = this.clock.now();
    const targetId = params.data.id;
    const deps = { idGenerator: this.idGenerator, clock: this.clock };

    if (!(await hasPermissionAt(this.db, toBin(auth.sub), USER_MANAGE, now))) {
      await recordDenied(this.db, deps, {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'identity.user.reset_password',
        entityType: 'USER',
        entityId: targetId,
        errorCode: 'FORBIDDEN',
        correlationId: request.correlationId,
      });
      throw new ApiError(403, 'FORBIDDEN', 'Réinitialisation réservée à l’administrateur.');
    }
    const device = await checkDeviceActive(this.db, toBin(auth.device_id), now);
    if (!device.ok) {
      await recordDenied(this.db, deps, {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'identity.user.reset_password',
        entityType: 'USER',
        entityId: targetId,
        errorCode: device.reason,
        correlationId: request.correlationId,
      });
      throw new ApiError(
        403,
        device.reason,
        'Réinitialisation impossible depuis cet appareil : il doit être approuvé et en service.',
      );
    }

    const target = await this.db
      .selectFrom('identity_users')
      .select(['id', 'status', 'phone', 'is_system'])
      .where('id', '=', toBin(targetId))
      .executeTakeFirst();
    if (!target || target.is_system) {
      throw new ApiError(404, 'NOT_FOUND', 'Utilisateur introuvable.');
    }
    if (targetId === auth.sub) {
      throw new ApiError(
        409,
        'RESET_OWN_PASSWORD',
        'Votre propre mot de passe se change par « Changer mon mot de passe », avec l’actuel.',
      );
    }
    if (target.status === 'DEACTIVATED') {
      throw new ApiError(
        409,
        'USER_DEACTIVATED',
        'Compte désactivé : réactivez-le avant de réinitialiser son mot de passe.',
      );
    }
    const problem = newPasswordProblem({ password: body.data.new_password });
    if (problem) {
      throw new ApiError(400, 'PASSWORD_INVALID', PASSWORD_PROBLEM_MESSAGES[problem]!, { problem });
    }

    const newHash = await hashPassword(body.data.new_password);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity_users')
        .set({
          password_hash: newHash,
          must_change_password: toDbBool(true),
          updated_by: toBin(auth.sub),
          version: sql`version + 1`,
        })
        .where('id', '=', target.id)
        .execute();
      await revokeUserSessions(trx, targetId, 'ADMIN', now);
      await resetLoginAttempts(trx, 'IDENTIFIER', target.phone);
      await recordAudit(trx, deps, {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'identity.user.reset_password',
        entityType: 'USER',
        entityId: targetId,
        // Jamais le mot de passe : seulement ses effets.
        after: { must_change_password: true, sessions_revoked: true },
        result: 'SUCCESS',
        correlationId: request.correlationId,
      });
    });
    return { status: 'ok' };
  }
}
