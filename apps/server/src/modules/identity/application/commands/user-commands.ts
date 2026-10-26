/**
 * Commandes du cycle de vie d'un utilisateur (SM-USER, 04-workflows/machines-a-etats/
 * 06-transverses.md ; BR-ADM-001, BR-ADM-002).
 *
 * Une transition absente de la table SM-USER est interdite (`INVALID_TRANSITION`), sauf déjà
 * dans l'état cible (rejeu sans effet, BR-SYN-007). `status_changed_at` = `occurred_at` :
 * exactement ce que compare `identity/application/public/user-check.ts` pour BR-ADM-002
 * (commandes hors ligne antérieures à la désactivation acceptées, postérieures en quarantaine).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { hasOtherActiveAdmin } from './admin-guard.js';
import { revokeUserSessions } from './revoke-sessions.js';
import { hashPassword } from '../auth/password.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@gic/domain';

const emptyPayloadSchema = z.object({});
const reasonRequiredSchema = z.object({ reason: z.string().min(1).max(500) });
// BR-ADM-001 : E.164 (voir aussi ck_identity_users_phone).
const createPayloadSchema = z.object({
  fullName: z.string().min(1).max(200),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Numéro attendu au format E.164.'),
  // MP-08 (AV-280) : règles partagées ; masqué dans la charge conservée (ADR-045).
  initialPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  email: z.string().email().optional(),
});

type EmptyPayload = z.infer<typeof emptyPayloadSchema>;
type ReasonRequiredPayload = z.infer<typeof reasonRequiredSchema>;
type CreatePayload = z.infer<typeof createPayloadSchema>;

function invalidTransition(currentStatus: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'INVALID_TRANSITION',
    messageFr: `Transition invalide depuis l'état ${currentStatus} (SM-USER).`,
  };
}

function notFound(): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Utilisateur introuvable.' };
}

/** Suspendre ou désactiver son propre compte : jamais (AV-328 ; ce que `GET /users` affiche). */
function ownAccount(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'OWN_ACCOUNT',
    messageFr: 'Impossible sur votre propre compte : un autre administrateur doit le faire.',
  };
}

/** Identifiants comparés sans tenir compte de la casse : un UUID en majuscules désigne le même compte. */
function isOwnAccount(envelope: { aggregate_id: string; author_user_id: string }): boolean {
  return envelope.aggregate_id.toLowerCase() === envelope.author_user_id.toLowerCase();
}

function phoneAlreadyUsed(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'PHONE_ALREADY_USED',
    messageFr: 'Ce numéro est déjà utilisé par un compte actif.',
  };
}

/** Un autre compte non désactivé porte ce numéro (`uq_identity_users_active_phone`). */
async function phoneTakenByOther(uow: UnitOfWork, phone: string, userId: Buffer): Promise<boolean> {
  const other = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('phone', '=', phone)
    .where('status', '!=', 'DEACTIVATED')
    .where('id', '!=', userId)
    .executeTakeFirst();
  return other !== undefined;
}

function lastAdmin(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'LAST_ADMIN',
    messageFr: 'Impossible : aucun autre ADMIN actif ne resterait (INV-ADM-01).',
  };
}

const suspend: CommandHandler<ReasonRequiredPayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const user = await uow
    .selectFrom('identity_users')
    .select('status')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return notFound();
  if (user.status === 'SUSPENDED') return { status: 'APPLIED' };
  if (user.status !== 'ACTIVE') return invalidTransition(user.status);
  if (isOwnAccount(envelope)) return ownAccount();

  const occurredAt = new Date(envelope.occurred_at);
  if (!(await hasOtherActiveAdmin(uow, envelope.aggregate_id, occurredAt))) return lastAdmin();

  await uow
    .updateTable('identity_users')
    .set({
      status: 'SUSPENDED',
      status_changed_at: occurredAt,
      status_reason: envelope.payload.reason,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', userId)
    .execute();
  await revokeUserSessions(uow, envelope.aggregate_id, 'ADMIN', occurredAt);
  return { status: 'APPLIED' };
};

const reactivate: CommandHandler<EmptyPayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const user = await uow
    .selectFrom('identity_users')
    .select(['status', 'phone'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return notFound();
  if (user.status === 'ACTIVE') return { status: 'APPLIED' };
  if (user.status !== 'SUSPENDED' && user.status !== 'DEACTIVATED') {
    return invalidTransition(user.status);
  }
  // Un compte désactivé libère son numéro (MP-13 : un autre compte a pu le reprendre). Rejet définitif
  // plutôt que l'erreur de contrainte, que le pipeline traiterait à tort comme transitoire.
  if (user.status === 'DEACTIVATED' && (await phoneTakenByOther(uow, user.phone, userId))) {
    return phoneAlreadyUsed();
  }

  await uow
    .updateTable('identity_users')
    .set({
      status: 'ACTIVE',
      status_changed_at: new Date(envelope.occurred_at),
      status_reason: null,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', userId)
    .execute();
  return { status: 'APPLIED' };
};

const deactivate: CommandHandler<ReasonRequiredPayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const user = await uow
    .selectFrom('identity_users')
    .select('status')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return notFound();
  if (user.status === 'DEACTIVATED') return { status: 'APPLIED' };
  if (user.status !== 'ACTIVE' && user.status !== 'SUSPENDED')
    return invalidTransition(user.status);
  if (isOwnAccount(envelope)) return ownAccount();

  const occurredAt = new Date(envelope.occurred_at);
  if (!(await hasOtherActiveAdmin(uow, envelope.aggregate_id, occurredAt))) return lastAdmin();

  await uow
    .updateTable('identity_users')
    .set({
      status: 'DEACTIVATED',
      status_changed_at: occurredAt,
      status_reason: envelope.payload.reason,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', userId)
    .execute();
  await revokeUserSessions(uow, envelope.aggregate_id, 'USER_DEACTIVATED', occurredAt);
  return { status: 'APPLIED' };
};

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent (même aggregate_id)

  // uq_identity_users_active_phone n'unicise que les comptes non désactivés (colonne
  // générée `active_phone`) : même contrôle ici pour rejeter proprement plutôt que de
  // laisser remonter une erreur de contrainte (que le pipeline traiterait à tort comme
  // transitoire, étape 7 de command-pipeline.service.ts).
  const phoneTaken = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('phone', '=', envelope.payload.phone)
    .where('status', '!=', 'DEACTIVATED')
    .executeTakeFirst();
  if (phoneTaken) return phoneAlreadyUsed();

  const passwordHash = await hashPassword(envelope.payload.initialPassword);
  await uow
    .insertInto('identity_users')
    .values({
      id: userId,
      full_name: envelope.payload.fullName,
      phone: envelope.payload.phone,
      email: envelope.payload.email ?? null,
      password_hash: passwordHash,
      must_change_password: toDbBool(true),
      status: 'ACTIVE',
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

export function registerUserCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'identity.user.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'identity.user.manage',
    handler: create,
  });
  registry.register({
    commandType: 'identity.user.suspend',
    version: 1,
    payloadSchema: reasonRequiredSchema,
    permissionCode: 'identity.user.manage',
    handler: suspend,
  });
  registry.register({
    commandType: 'identity.user.reactivate',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: 'identity.user.manage',
    handler: reactivate,
  });
  registry.register({
    commandType: 'identity.user.deactivate',
    version: 1,
    payloadSchema: reasonRequiredSchema,
    permissionCode: 'identity.user.manage',
    handler: deactivate,
  });
}
