/**
 * Équipes et appartenances (organization.teams/team_memberships, BR-ADM-014 ;
 * docs/03-data/dictionnaire/02-organization.md). « Un utilisateur appartient à au plus une
 * équipe à une date donnée » : le non-chevauchement documenté porte sur l'utilisateur, pas
 * sur la paire (équipe, utilisateur) — `assign_member` ferme donc toute appartenance active
 * de l'utilisateur avant d'en ouvrir une nouvelle, dans la même transaction (le déclencheur
 * `BEFORE INSERT/UPDATE` de la table revérifie l'absence de chevauchement, filet de
 * sécurité contre une concurrence non vue par cette lecture-ci).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { emitTeamMembershipChange } from '../sync-changes.js';

const createPayloadSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  managerUserId: z.string().uuid(),
});

const assignMemberPayloadSchema = z.object({
  userId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const removeMemberPayloadSchema = z.object({
  userId: z.string().uuid(),
});

/** Fermeture d'une équipe (AV-515) : motif facultatif, gardé au journal d'audit. */
const closePayloadSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type AssignMemberPayload = z.infer<typeof assignMemberPayloadSchema>;
type RemoveMemberPayload = z.infer<typeof removeMemberPayloadSchema>;
type ClosePayload = z.infer<typeof closePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const teamId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('organization_teams')
    .select('id')
    .where('id', '=', teamId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { code, name, managerUserId } = envelope.payload;
  const manager = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('id', '=', toBin(managerUserId))
    .executeTakeFirst();
  if (!manager) return notFound('Responsable introuvable (managerUserId).');

  await uow
    .insertInto('organization_teams')
    .values({
      id: teamId,
      code,
      name,
      manager_user_id: toBin(managerUserId),
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

/** `aggregate_id` est l'identifiant (frais, choisi par l'appelant) de la **nouvelle** ligne
 * `team_memberships` créée par cette affectation — comme `identity.role_assignment.grant`,
 * pas l'utilisateur déplacé (qui peut être réaffecté plusieurs fois, chaque fois avec un
 * `aggregate_id` différent). */
const assignMember: CommandHandler<AssignMemberPayload> = async (uow, envelope) => {
  const already = await uow
    .selectFrom('organization_team_memberships')
    .select('id')
    .where('id', '=', toBin(envelope.aggregate_id))
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent (même aggregate_id)

  const { userId, teamId } = envelope.payload;
  const occurredAt = new Date(envelope.occurred_at);

  const team = await uow
    .selectFrom('organization_teams')
    .select(['id', 'is_active'])
    .where('id', '=', toBin(teamId))
    .executeTakeFirst();
  if (!team) return notFound('Équipe introuvable.');
  if (!team.is_active) {
    return {
      status: 'REJECTED',
      errorCode: 'TEAM_CLOSED',
      messageFr: 'Cette équipe est fermée : choisissez une autre équipe.',
    };
  }

  const current = await uow
    .selectFrom('organization_team_memberships')
    .select(['id', 'team_id'])
    .where('user_id', '=', toBin(userId))
    .where('valid_from', '<=', occurredAt)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', occurredAt)]))
    .executeTakeFirst();

  if (current && current.team_id.equals(toBin(teamId))) {
    return { status: 'APPLIED' }; // déjà dans cette équipe (rejeu ou déplacement redondant)
  }
  if (current) {
    await uow
      .updateTable('organization_team_memberships')
      .set({
        valid_to: occurredAt,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', current.id)
      .execute();
    await emitTeamMembershipChange(uow, fromBin(current.id));
  }

  await uow
    .insertInto('organization_team_memberships')
    .values({
      id: toBin(envelope.aggregate_id),
      team_id: toBin(teamId),
      user_id: toBin(userId),
      valid_from: occurredAt,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  await emitTeamMembershipChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

const removeMember: CommandHandler<RemoveMemberPayload> = async (uow, envelope) => {
  const { userId } = envelope.payload;
  const occurredAt = new Date(envelope.occurred_at);

  const current = await uow
    .selectFrom('organization_team_memberships')
    .select('id')
    .where('user_id', '=', toBin(userId))
    .where('valid_from', '<=', occurredAt)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', occurredAt)]))
    .executeTakeFirst();
  if (!current) return { status: 'APPLIED' }; // déjà sans équipe active (rejeu)

  await uow
    .updateTable('organization_team_memberships')
    .set({
      valid_to: occurredAt,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', current.id)
    .execute();
  await emitTeamMembershipChange(uow, fromBin(current.id));
  return { status: 'APPLIED' };
};

/**
 * Ferme une équipe (AV-515) : elle devient inactive (`is_active`, jamais supprimée : règle 4) et ses
 * appartenances encore ouvertes se closent à `occurred_at`, chacune publiée aux appareils. Elle ne reçoit plus
 * de membre (`TEAM_CLOSED`). Les affectations de rôle de périmètre `TEAM` sur cette équipe restent lisibles
 * (elles ne couvrent plus personne) ; l'Admin les retire depuis l'écran des comptes. Rejeu : sans effet.
 */
const close: CommandHandler<ClosePayload> = async (uow, envelope) => {
  const teamId = toBin(envelope.aggregate_id);
  const team = await uow
    .selectFrom('organization_teams')
    .select(['id', 'is_active'])
    .where('id', '=', teamId)
    .forUpdate()
    .executeTakeFirst();
  if (!team) return notFound('Équipe introuvable.');
  if (!team.is_active) return { status: 'APPLIED' };

  const occurredAt = new Date(envelope.occurred_at);
  const open = await uow
    .selectFrom('organization_team_memberships')
    .select('id')
    .where('team_id', '=', teamId)
    .where('valid_from', '<', occurredAt)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', occurredAt)]))
    .orderBy('id')
    .execute();
  for (const membership of open) {
    await uow
      .updateTable('organization_team_memberships')
      .set({
        valid_to: occurredAt,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', membership.id)
      .execute();
    await emitTeamMembershipChange(uow, fromBin(membership.id));
  }
  await uow
    .updateTable('organization_teams')
    .set({
      is_active: toDbBool(false),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', teamId)
    .execute();
  const reason = envelope.payload.reason;
  return {
    status: 'APPLIED',
    audit: {
      before: { isActive: true },
      after: {
        isActive: false,
        closedMemberships: open.length,
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      },
    },
  };
};

export function registerTeamCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.team.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: create,
  });
  registry.register({
    commandType: 'organization.team.assign_member',
    version: 1,
    payloadSchema: assignMemberPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: assignMember,
  });
  registry.register({
    commandType: 'organization.team.remove_member',
    version: 1,
    payloadSchema: removeMemberPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: removeMember,
  });
  registry.register({
    commandType: 'organization.team.close',
    version: 1,
    payloadSchema: closePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: close,
  });
}
