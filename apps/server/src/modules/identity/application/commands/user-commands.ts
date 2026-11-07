/**
 * Commandes du cycle de vie d'un utilisateur (SM-USER, 04-workflows/machines-a-etats/
 * 06-transverses.md ; BR-ADM-001, BR-ADM-002).
 *
 * Une transition absente de la table SM-USER est interdite (`INVALID_TRANSITION`), sauf déjà
 * dans l'état cible (rejeu sans effet, BR-SYN-007). `status_changed_at` = `occurred_at`, borné à l'heure de réception
 * de la commande par le serveur (`effectiveAt`) : exactement ce que compare `identity/application/public/user-check.ts`
 * pour BR-ADM-002 (commandes hors ligne antérieures à la désactivation acceptées, postérieures en quarantaine).
 *
 * AV-229 : `reactivate` (depuis `SUSPENDED` ou `DEACTIVATED`) et `deactivate` (depuis `SUSPENDED`) réécrivent
 * `status_changed_at` ; la période hors service qu'elles ferment est consignée d'abord (`identity_user_status_periods`,
 * ajout seul), pour que le contrôle d'utilisateur du pipeline mette encore en quarantaine un fait daté pendant cette
 * période. Chaque transition lit le compte `FOR UPDATE` (ADR-038 : deux transitions simultanées se suivent).
 */
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DB } from '../../../../platform/kysely/database.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { hasOtherActiveAdmin } from './admin-guard.js';
import { revokeUserSessions } from './revoke-sessions.js';
import { closeUserOutOfServicePeriod, isUserOutOfServiceStatus } from './user-status-periods.js';
import { hashPassword } from '../auth/password.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@gic/domain';

const emptyPayloadSchema = z.object({});
const reasonRequiredSchema = z.object({ reason: z.string().min(1).max(500) });
// BR-ADM-001 : E.164 (voir aussi ck_identity_users_phone).
const phoneSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Numéro attendu au format E.164.');
const createPayloadSchema = z.object({
  fullName: z.string().min(1).max(200),
  phone: phoneSchema,
  // MP-08 (AV-280) : règles partagées ; masqué dans la charge conservée (ADR-045).
  initialPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  email: z.string().email().optional(),
});
/**
 * Modification des informations d'un compte (AV-515) : nom, numéro, adresse e-mail. Un champ absent reste
 * inchangé ; `email: null` retire l'adresse. Le mot de passe et l'état du compte ont leurs propres commandes.
 */
const updatePayloadSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone: phoneSchema.optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
  })
  .refine(
    (payload) =>
      payload.fullName !== undefined || payload.phone !== undefined || payload.email !== undefined,
    { message: 'Aucune information à modifier.' },
  );

type EmptyPayload = z.infer<typeof emptyPayloadSchema>;
type ReasonRequiredPayload = z.infer<typeof reasonRequiredSchema>;
type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

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

function emailAlreadyUsed(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'EMAIL_ALREADY_USED',
    messageFr: 'Cette adresse e-mail est déjà utilisée par un compte actif.',
  };
}

/**
 * Un autre compte non désactivé porte cette adresse (la connexion par e-mail serait ambiguë). `exceptUserId` : le
 * compte lui-même (modification, réactivation) ; absent à la création. La création (commande et `POST /users`), la
 * modification et la réactivation d'un compte désactivé le contrôlent toutes (revue adverse du 05/11/2026) ; aucun
 * index unique n'existe sur l'adresse (limite consignée dans AV-515 : deux demandes simultanées vers la même adresse).
 */
export async function emailTakenByOther(
  executor: Pick<Kysely<DB>, 'selectFrom'>,
  email: string,
  exceptUserId?: Buffer,
): Promise<boolean> {
  const other = await executor
    .selectFrom('identity_users')
    .select('id')
    .where(sql<boolean>`LOWER(email) = ${email.toLowerCase()}`)
    .where('status', '!=', 'DEACTIVATED')
    .$if(exceptUserId !== undefined, (qb) => qb.where('id', '!=', exceptUserId!))
    .executeTakeFirst();
  return other !== undefined;
}

/** Numéro et adresse ne s'écrivent jamais en clair au journal d'audit : on y garde de quoi les reconnaître. */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 4)}${'•'.repeat(Math.max(phone.length - 7, 0))}${phone.slice(-3)}`;
}

function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  return at <= 0 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function lastAdmin(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'LAST_ADMIN',
    messageFr: 'Impossible : aucun autre ADMIN actif ne resterait (INV-ADM-01).',
  };
}

/**
 * Date d'effet d'un changement d'état de compte : celle du fait, jamais postérieure à la réception de la commande par le
 * serveur. Une horloge d'administration en avance décalerait sinon la période hors service (la réactivation la prolongerait
 * de l'avance, et les faits réels de l'utilisateur dans cet intervalle seraient mis en quarantaine à tort, AV-229).
 */
async function effectiveAt(
  uow: UnitOfWork,
  envelope: { readonly occurred_at: string; readonly command_id: string },
): Promise<Date> {
  const occurredAt = new Date(envelope.occurred_at);
  const { receivedAt } = await loadCommandOrigin(uow, envelope.command_id);
  return occurredAt.getTime() <= receivedAt.getTime() ? occurredAt : receivedAt;
}

const suspend: CommandHandler<ReasonRequiredPayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const user = await uow
    .selectFrom('identity_users')
    .select('status')
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!user) return notFound();
  if (user.status === 'SUSPENDED') return { status: 'APPLIED' };
  if (user.status !== 'ACTIVE') return invalidTransition(user.status);
  if (isOwnAccount(envelope)) return ownAccount();

  const occurredAt = await effectiveAt(uow, envelope);
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
    .select(['status', 'phone', 'email', 'status_changed_at', 'status_reason'])
    .where('id', '=', userId)
    .forUpdate()
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
  // Même chose pour l'adresse e-mail : un compte désactivé la libère, et la connexion par e-mail deviendrait ambiguë
  // si deux comptes actifs la portaient.
  if (
    user.status === 'DEACTIVATED' &&
    user.email !== null &&
    (await emailTakenByOther(uow, user.email, userId))
  ) {
    return emailAlreadyUsed();
  }

  const occurredAt = await effectiveAt(uow, envelope);
  // AV-229 : la période hors service que la réactivation ferme, avant de réécrire la ligne vivante.
  if (isUserOutOfServiceStatus(user.status)) {
    await closeUserOutOfServicePeriod(uow, {
      commandId: envelope.command_id,
      userId: envelope.aggregate_id,
      status: user.status,
      validFrom: user.status_changed_at,
      closedAt: occurredAt,
      reason: user.status_reason,
      closedBy: envelope.author_user_id,
    });
  }
  await uow
    .updateTable('identity_users')
    .set({
      status: 'ACTIVE',
      status_changed_at: occurredAt,
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
    .select(['status', 'status_changed_at', 'status_reason'])
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!user) return notFound();
  if (user.status === 'DEACTIVATED') return { status: 'APPLIED' };
  if (user.status !== 'ACTIVE' && user.status !== 'SUSPENDED')
    return invalidTransition(user.status);
  if (isOwnAccount(envelope)) return ownAccount();

  const occurredAt = await effectiveAt(uow, envelope);
  if (!(await hasOtherActiveAdmin(uow, envelope.aggregate_id, occurredAt))) return lastAdmin();

  // AV-229 : la suspension que la désactivation ferme (les faits datés entre les deux restent en quarantaine).
  if (user.status === 'SUSPENDED') {
    await closeUserOutOfServicePeriod(uow, {
      commandId: envelope.command_id,
      userId: envelope.aggregate_id,
      status: 'SUSPENDED',
      validFrom: user.status_changed_at,
      closedAt: occurredAt,
      reason: user.status_reason,
      closedBy: envelope.author_user_id,
    });
  }
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
  if (
    envelope.payload.email !== undefined &&
    (await emailTakenByOther(uow, envelope.payload.email))
  ) {
    return emailAlreadyUsed();
  }

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

/**
 * Modifie le nom, le numéro ou l'adresse e-mail d'un compte (AV-515). Jamais le compte système ni un compte
 * désactivé (il se réactive d'abord, ce qui revérifie son numéro). Les sessions restent valides : elles
 * tiennent au compte, pas à son identifiant de connexion. Rejouée avec les mêmes valeurs : sans effet.
 */
const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const userId = toBin(envelope.aggregate_id);
  const user = await uow
    .selectFrom('identity_users')
    .select(['status', 'full_name', 'phone', 'email', 'is_system'])
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!user) return notFound();
  if (Number(user.is_system) === 1) {
    return {
      status: 'REJECTED',
      errorCode: 'SYSTEM_ACCOUNT',
      messageFr: 'Le compte système ne se modifie pas.',
    };
  }
  if (user.status === 'DEACTIVATED') {
    return {
      status: 'REJECTED',
      errorCode: 'INVALID_TRANSITION',
      messageFr: 'Un compte désactivé ne se modifie pas : réactivez-le d’abord.',
    };
  }

  const { fullName, phone, email } = envelope.payload;
  const next = {
    full_name: fullName ?? user.full_name,
    phone: phone ?? user.phone,
    email: email === undefined ? user.email : email,
  };
  const nameChanged = next.full_name !== user.full_name;
  const phoneChanged = next.phone !== user.phone;
  const emailChanged = next.email !== user.email;
  // Rien ne change : l'audit reste vide, sans quoi le pipeline y copierait la charge de la commande (numéro compris).
  if (!nameChanged && !phoneChanged && !emailChanged) {
    return { status: 'APPLIED', audit: { before: {}, after: {} } };
  }
  if (phoneChanged && (await phoneTakenByOther(uow, next.phone, userId))) return phoneAlreadyUsed();
  if (emailChanged && next.email !== null && (await emailTakenByOther(uow, next.email, userId))) {
    return emailAlreadyUsed();
  }

  await uow
    .updateTable('identity_users')
    .set({
      full_name: next.full_name,
      phone: next.phone,
      email: next.email,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', userId)
    .execute();
  return {
    status: 'APPLIED',
    audit: {
      before: {
        ...(nameChanged ? { fullName: user.full_name } : {}),
        ...(phoneChanged ? { phone: maskPhone(user.phone) } : {}),
        ...(emailChanged ? { email: maskEmail(user.email) } : {}),
      },
      after: {
        ...(nameChanged ? { fullName: next.full_name } : {}),
        ...(phoneChanged ? { phone: maskPhone(next.phone) } : {}),
        ...(emailChanged ? { email: maskEmail(next.email) } : {}),
      },
    },
  };
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
    commandType: 'identity.user.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'identity.user.manage',
    handler: update,
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
