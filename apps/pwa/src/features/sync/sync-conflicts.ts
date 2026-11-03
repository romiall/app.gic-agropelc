/**
 * Règles pures de l'écran ECR-SYN-03 « Résolution des conflits » (RP-3 ; UC-SYN-07 ; SM-CONFLICT ; BR-SYN-017 ; AV-190).
 * Lecture de `GET /sync/conflicts`, règles de clôture (`sync.conflict.resolve` et `sync.conflict.dismiss`)
 * et validation des motifs et références de régularisation.
 */

export const CONFLICT_STATUS_FILTERS = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type ConflictStatusFilter = (typeof CONFLICT_STATUS_FILTERS)[number];

export const CONFLICT_RESOLUTIONS = [
  'KEEP_SERVER',
  'ACCEPT_CLIENT',
  'MERGE',
  'COMPENSATE',
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export type ConflictActionMode = 'RESOLVE' | 'DISMISS';

export const COMMENT_MAX = 1000;

/** Conflits gérés par une décision métier dédiée (`PAYMENT_REFERENCE_DUPLICATE` → file de validation). */
const MANAGED_ELSEWHERE = new Set(['PAYMENT_REFERENCE_DUPLICATE']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConflictView {
  readonly id: string;
  readonly conflictType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly siteId: string | null;
  readonly ownerRole: string;
  readonly applied: boolean;
  readonly details: unknown;
  readonly status: ConflictStatusFilter;
  readonly resolution: ConflictResolution | null;
  readonly resolutionRefs: readonly string[];
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionComment: string | null;
  readonly createdAt: string;
  readonly commandId: string | null;
  readonly authorUserId: string | null;
  readonly deviceId: string | null;
}

export function conflictsPath(status: ConflictStatusFilter): string {
  return `/api/v1/sync/conflicts?status=${encodeURIComponent(status)}&limit=200`;
}

export function isManagedElsewhere(conflict: ConflictView): boolean {
  return MANAGED_ELSEWHERE.has(conflict.conflictType);
}

/** AV-192 : un conflit sur un fait appliqué n'est jamais clos par l'auteur de ce fait. */
export function isSelfAppliedConflict(conflict: ConflictView, userId: string): boolean {
  return conflict.applied && conflict.authorUserId === userId;
}

export function allowedResolutions(conflict: ConflictView): readonly ConflictResolution[] {
  return conflict.applied ? CONFLICT_RESOLUTIONS : ['KEEP_SERVER', 'COMPENSATE'];
}

export function canResolveConflict(conflict: ConflictView, userId: string): boolean {
  return (
    conflict.status === 'OPEN' &&
    !isManagedElsewhere(conflict) &&
    !isSelfAppliedConflict(conflict, userId)
  );
}

export function canDismissConflict(conflict: ConflictView, userId: string): boolean {
  return canResolveConflict(conflict, userId) && conflict.applied;
}

export function parseResolutionRefs(raw: string): {
  readonly refs: readonly string[];
  readonly valid: boolean;
} {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const valid = unique.length <= 20 && unique.every((part) => UUID_REGEX.test(part));
  return { refs: unique, valid };
}

export type ConflictDecisionProblem = 'COMMENT_REQUIRED' | 'REFS_REQUIRED' | 'REFS_INVALID';

export function decisionProblem(input: {
  readonly mode: ConflictActionMode;
  readonly resolution: ConflictResolution;
  readonly comment: string;
  readonly refsText: string;
}): ConflictDecisionProblem | null {
  const trimmedComment = input.comment.trim();
  if (!trimmedComment || trimmedComment.length > COMMENT_MAX) {
    return 'COMMENT_REQUIRED';
  }
  if (input.mode === 'RESOLVE') {
    const parsed = parseResolutionRefs(input.refsText);
    if (!parsed.valid) return 'REFS_INVALID';
    if (input.resolution === 'COMPENSATE' && parsed.refs.length === 0) {
      return 'REFS_REQUIRED';
    }
  }
  return null;
}

export function conflictCommandOf(input: {
  readonly mode: ConflictActionMode;
  readonly resolution: ConflictResolution;
  readonly comment: string;
  readonly refsText: string;
}): {
  readonly commandType: 'sync.conflict.resolve' | 'sync.conflict.dismiss';
  readonly payload: Record<string, unknown>;
} {
  const comment = input.comment.trim();
  if (input.mode === 'DISMISS') {
    return {
      commandType: 'sync.conflict.dismiss',
      payload: { comment },
    };
  }
  const { refs } = parseResolutionRefs(input.refsText);
  return {
    commandType: 'sync.conflict.resolve',
    payload: {
      resolution: input.resolution,
      comment,
      ...(refs.length > 0 ? { refs } : {}),
    },
  };
}
