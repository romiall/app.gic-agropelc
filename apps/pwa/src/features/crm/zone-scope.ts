/**
 * Zones du périmètre de l'utilisateur (S-19, AV-520) : logique pure, côté appareil.
 *
 * L'appareil reçoit toutes les zones (le moteur de prix a besoin de l'arbre entier pour la spécificité d'une
 * règle) et les affectations de rôle de l'utilisateur (jeu `role_assignment`). Pour ne proposer à un commercial de
 * terrain que les zones où il agit, on déduit son périmètre de ses affectations en vigueur — comme
 * `expenseSites` (AV-301) pour les sites :
 *
 * - une affectation `ZONE` ouvre cette zone et toutes ses sous-zones ;
 * - une affectation `GLOBAL` ou `TEAM` (les zones d'une équipe ne sont pas connues de l'appareil), ou aucune
 *   affectation de zone (rôles de site seulement, ou affectations pas encore reçues) : aucun filtrage, toutes les
 *   zones restent proposées.
 *
 * Le serveur reste juge (`ZONE_NOT_ALLOWED`, `FORBIDDEN_SCOPE`) : ce filtre évite seulement de proposer des choix
 * qu'il refusera.
 */
import type { RoleAssignmentData, ZoneData } from '../sales/types.js';

const inForce = (
  assignment: Pick<RoleAssignmentData, 'valid_from' | 'valid_to' | 'revoked_at'>,
  now: Date,
): boolean =>
  assignment.revoked_at === null &&
  new Date(assignment.valid_from) <= now &&
  (assignment.valid_to === null || new Date(assignment.valid_to) > now);

/** La zone `zoneId` est-elle `ancestorId` ou l'une de ses sous-zones ? (garde contre un cycle) */
function withinZone(
  zoneId: string,
  ancestorId: string,
  zones: ReadonlyMap<string, Pick<ZoneData, 'parent_id'>>,
): boolean {
  let current: string | null | undefined = zoneId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = zones.get(current)?.parent_id;
  }
  return false;
}

/**
 * Identifiants des zones du périmètre de l'utilisateur, ou `null` quand aucun filtrage ne s'applique (voir plus
 * haut). Un ensemble vide est possible : toutes ses affectations de zone pointent des zones inconnues de l'appareil.
 */
export function allowedZoneIds(input: {
  readonly assignments: readonly RoleAssignmentData[];
  readonly userId: string;
  readonly zones: ReadonlyMap<string, Pick<ZoneData, 'parent_id'>>;
  readonly now: Date;
}): ReadonlySet<string> | null {
  const mine = input.assignments.filter(
    (assignment) => assignment.user_id === input.userId && inForce(assignment, input.now),
  );
  if (
    mine.some(
      (assignment) => assignment.scope_type === 'GLOBAL' || assignment.scope_type === 'TEAM',
    )
  ) {
    return null;
  }
  const roots = mine
    .filter((assignment) => assignment.scope_type === 'ZONE' && assignment.scope_zone_id !== null)
    .map((assignment) => assignment.scope_zone_id as string);
  if (roots.length === 0) return null;
  const allowed = new Set<string>();
  for (const zoneId of input.zones.keys()) {
    if (roots.some((root) => withinZone(zoneId, root, input.zones))) allowed.add(zoneId);
  }
  return allowed;
}
