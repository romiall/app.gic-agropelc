/**
 * Destinataires d'une notification directe (P9-11 (3/3) ; AV-389, AV-430 ; ADR-062 §2). Le plan du domaine
 * dit **qui** (les titulaires d'une permission sur un périmètre, ou des utilisateurs désignés) ; ici
 * seulement l'orchestration des lectures du port, jugées à l'instant `at` du traitement (RC-01, BR-NOT-001).
 *
 * - `USERS` : parmi les désignés, les utilisateurs actifs ayant une affectation active.
 * - `PERMISSION_HOLDERS` : les titulaires de la permission sur le périmètre ; s'il n'y en a aucun (ou si la
 *   politique ne désigne aucune permission) et que le plan le prévoit, les titulaires du rôle de repli
 *   (la Direction), comme pour une alerte sans destinataire.
 * - Les utilisateurs exclus (l'auteur du fait) ne sont jamais prévenus : le port les écarte des titulaires de
 *   la permission, le repli les écarte lui-même.
 */
import { FALLBACK_RECIPIENT_ROLE, type DirectAudience } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import type { AlertRecipientResolver } from './recipient-resolver.js';

export async function resolveDirectRecipients(
  uow: UnitOfWork,
  resolver: AlertRecipientResolver,
  audience: DirectAudience,
  at: Date,
): Promise<readonly string[]> {
  if (audience.kind === 'USERS') {
    return unique(await resolver.activeUsersAmong(uow, audience.userIds, at));
  }

  // Le port n'écarte que les titulaires de la permission ; le repli par rôle, lui, doit écarter l'auteur.
  let recipients: string[] =
    audience.permission === null
      ? []
      : unique(
          await resolver.usersHoldingPermissionAt(uow, {
            permission: audience.permission,
            perimeter: audience.perimeter,
            at,
            excludeUserIds: audience.excludeUserIds,
          }),
        );
  if (recipients.length === 0 && audience.fallbackToDirection) {
    const excluded = new Set(audience.excludeUserIds);
    const holders = await resolver.usersHoldingRolesAt(uow, {
      roles: [FALLBACK_RECIPIENT_ROLE],
      perimeter: audience.perimeter,
      at,
    });
    recipients = unique(holders.map((holder) => holder.userId)).filter(
      (userId) => !excluded.has(userId),
    );
  }
  return recipients;
}

function unique(userIds: readonly string[]): string[] {
  return [...new Set(userIds)].sort();
}
