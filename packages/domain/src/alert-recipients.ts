/**
 * Destinataires d'une alerte (P9 ; BR-NOT-001, BR-NOT-008 ; D13 §7.1, §14 ; ADR-072 §1, §7, §9 ; AV-413,
 * AV-417, AV-443) : origines, rôles effectifs d'une levée, fusion sans doublon et repli sur la Direction.
 *
 * Fonctions pures : l'accès aux affectations, aux équipes et aux permissions est celui du serveur (port
 * `AlertRecipientResolver`) ; ici seulement les règles qui décident de qui est retenu.
 */

/** Origines d'un destinataire, par ordre de priorité décroissante (le premier ajout l'emporte). */
export const RECIPIENT_ORIGINS = [
  'RULE',
  'OWNER',
  'TEAM_MANAGER',
  'APPROVER',
  'ESCALATION',
  'FALLBACK',
] as const;
export type RecipientOrigin = (typeof RECIPIENT_ORIGINS)[number];

/** Rôle de repli quand aucun destinataire n'est trouvé (D13 §14). */
export const FALLBACK_RECIPIENT_ROLE = 'DIRECTION';

export interface RecipientCandidate {
  readonly userId: string;
  readonly origin: RecipientOrigin;
  /** Rôle par lequel le destinataire est retenu ; `null` pour le propriétaire, le responsable, l'approbateur. */
  readonly roleCode: string | null;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
};

/**
 * Rôles destinataires effectifs d'une levée (AV-443). Un déclencheur peut avoir ses propres rôles
 * (`DUPLICATE_SUSPECTED` : la Finance pour un paiement, le responsable commercial pour un client) ; tant
 * que la règle du type n'a pas été modifiée par un administrateur, ils s'appliquent. Une règle modifiée
 * vaut pour tout le type : le réglage de l'administrateur n'est jamais contourné par un déclencheur.
 */
export function effectiveRecipientRoles(input: {
  readonly ruleRoles: readonly string[];
  readonly catalogRoles: readonly string[];
  readonly triggerRoles: readonly string[];
}): readonly string[] {
  return sameSet(input.ruleRoles, input.catalogRoles) ? input.triggerRoles : input.ruleRoles;
}

/** Fusion sans doublon : un utilisateur n'a qu'une ligne, la première origine l'emporte, l'ordre est stable. */
export function mergeRecipients(
  candidates: readonly RecipientCandidate[],
): readonly RecipientCandidate[] {
  const seen = new Set<string>();
  const merged: RecipientCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.userId)) continue;
    seen.add(candidate.userId);
    merged.push(candidate);
  }
  return merged;
}

export interface RecipientPlan {
  readonly recipients: readonly RecipientCandidate[];
  /** Aucun destinataire par la règle, le propriétaire, le responsable ou les approbateurs. */
  readonly fallbackUsed: boolean;
}

/**
 * Destinataires d'une levée : ceux de la règle, du propriétaire, du responsable et des approbateurs,
 * dans cet ordre ; à défaut de tout destinataire, les titulaires du rôle de repli (D13 §14).
 */
export function planRecipients(input: {
  readonly primary: readonly RecipientCandidate[];
  readonly fallback: readonly RecipientCandidate[];
}): RecipientPlan {
  const primary = mergeRecipients(input.primary);
  if (primary.length > 0) return { recipients: primary, fallbackUsed: false };
  return {
    recipients: mergeRecipients(
      input.fallback.map((candidate) => ({ ...candidate, origin: 'FALLBACK' as const })),
    ),
    fallbackUsed: true,
  };
}

/**
 * Destinataires à ajouter à une alerte ouverte à une occurrence suivante : ceux que le calcul retient et
 * que l'alerte n'a pas encore. Un destinataire n'est jamais retiré (ADR-072 §9).
 */
export function recipientsToAdd(
  planned: readonly RecipientCandidate[],
  existingUserIds: ReadonlySet<string>,
): readonly RecipientCandidate[] {
  return planned.filter((candidate) => !existingUserIds.has(candidate.userId));
}
