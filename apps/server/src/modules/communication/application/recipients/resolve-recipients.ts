/**
 * Calcul des destinataires d'une alerte (P9-05 ; ADR-072 §1, §7 ; BR-NOT-001 ; D13 §7.1, §14).
 *
 * Origines, par priorité : `RULE` (titulaires des rôles de la règle dont l'affectation couvre l'objet),
 * `OWNER` (propriétaire désigné par l'événement), `TEAM_MANAGER` (responsable de l'équipe du
 * propriétaire), `APPROVER` (titulaires de la permission d'approbation, demandeur exclu), puis
 * `FALLBACK` (Direction) à défaut de tout destinataire. Les fusions et le repli sont les fonctions pures
 * du domaine ; ici seulement l'orchestration des lectures du port.
 */
import {
  FALLBACK_RECIPIENT_ROLE,
  alertDefinitionOf,
  effectiveRecipientRoles,
  mergeRecipients,
  planRecipients,
  type AlertRaiseAction,
  type RecipientCandidate,
  type RecipientPlan,
} from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import type { AlertRule } from '../alerts/alert-store.js';
import type { AlertRecipientResolver, RecipientPerimeter } from './recipient-resolver.js';

const stringField = (payload: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

export function perimeterOf(action: {
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserIds: readonly string[];
}): RecipientPerimeter {
  return { siteId: action.siteId, zoneId: action.zoneId, ownerUserIds: action.ownerUserIds };
}

/** Destinataires d'une levée d'alerte (à la création, ou à une occurrence suivante pour compléter). */
export async function resolveAlertRecipients(
  uow: UnitOfWork,
  resolver: AlertRecipientResolver,
  input: { readonly action: AlertRaiseAction; readonly rule: AlertRule; readonly at: Date },
): Promise<RecipientPlan> {
  const { action, rule, at } = input;
  const perimeter = perimeterOf(action);
  const roles = effectiveRecipientRoles({
    ruleRoles: rule.recipientRoles,
    catalogRoles: alertDefinitionOf(action.alertType).recipientRoles,
    triggerRoles: action.recipientRoles,
  });

  const primary: RecipientCandidate[] = [];
  if (roles.length > 0) {
    for (const holder of await resolver.usersHoldingRolesAt(uow, { roles, perimeter, at })) {
      primary.push({ userId: holder.userId, origin: 'RULE', roleCode: holder.roleCode });
    }
  }
  if (action.ownerUserIds.length > 0) {
    for (const userId of await resolver.activeUsersAmong(uow, action.ownerUserIds, at)) {
      primary.push({ userId, origin: 'OWNER', roleCode: null });
    }
    if (action.teamManager) {
      for (const userId of await resolver.teamManagersOf(uow, action.ownerUserIds, at)) {
        primary.push({ userId, origin: 'TEAM_MANAGER', roleCode: null });
      }
    }
  }
  if (action.approvers) {
    // Convention de la charge utile d'une demande en attente : la permission d'approbation de la politique
    // et le demandeur (qui ne s'approuve pas lui-même).
    const permission = stringField(action.payload, 'approver_permission');
    const requester = stringField(action.payload, 'requester_user_id');
    if (permission !== null) {
      // Le moteur de droits juge l'approbation sur la ressource de la demande : son demandeur en est le
      // propriétaire (portées `OWN` et `TEAM`) sans devenir destinataire pour autant (origine `OWNER`).
      const approvers = await resolver.usersHoldingPermissionAt(uow, {
        permission,
        perimeter: requester === null ? perimeter : { ...perimeter, ownerUserIds: [requester] },
        at,
        excludeUserIds: requester === null ? [] : [requester],
      });
      for (const userId of approvers) primary.push({ userId, origin: 'APPROVER', roleCode: null });
    }
  }

  if (mergeRecipients(primary).length > 0) {
    return planRecipients({ primary, fallback: [] });
  }
  const fallback = await resolver.usersHoldingRolesAt(uow, {
    roles: [FALLBACK_RECIPIENT_ROLE],
    perimeter,
    at,
  });
  return planRecipients({
    primary: [],
    fallback: fallback.map((holder) => ({
      userId: holder.userId,
      origin: 'FALLBACK' as const,
      roleCode: holder.roleCode,
    })),
  });
}

/** Destinataires de niveau supérieur d'une escalade : titulaires des rôles d'escalade de la règle. */
export async function resolveEscalationRecipients(
  uow: UnitOfWork,
  resolver: AlertRecipientResolver,
  input: {
    readonly rule: AlertRule;
    readonly perimeter: RecipientPerimeter;
    readonly at: Date;
  },
): Promise<readonly RecipientCandidate[]> {
  const roles =
    input.rule.escalationRoles.length > 0 ? input.rule.escalationRoles : [FALLBACK_RECIPIENT_ROLE];
  const holders = await resolver.usersHoldingRolesAt(uow, {
    roles,
    perimeter: input.perimeter,
    at: input.at,
  });
  return mergeRecipients(
    holders.map((holder) => ({
      userId: holder.userId,
      origin: 'ESCALATION' as const,
      roleCode: holder.roleCode,
    })),
  );
}
