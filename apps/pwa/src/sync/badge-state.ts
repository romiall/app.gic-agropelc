/**
 * Pastille de synchronisation (UX-04) : « vert = synchronisé, orange = n opérations en
 * attente, rouge = erreur ou conflit, gris = hors ligne depuis X h ». Fonction pure (facile à
 * tester) — `SyncBadge.tsx` ne fait que la brancher sur `liveQuery`.
 */
export type BadgeColor = 'green' | 'orange' | 'red' | 'grey';

export interface BadgeInput {
  readonly online: boolean;
  readonly pendingCount: number;
  readonly attentionCount: number; // CONFLICT + REJECTED
  readonly lastSyncAt: string | null;
  readonly now: Date;
}

export interface BadgeState {
  readonly color: BadgeColor;
  readonly labelKey: string;
  readonly labelParams?: Record<string, number>;
}

export function computeBadgeState(input: BadgeInput): BadgeState {
  if (input.attentionCount > 0) {
    return {
      color: 'red',
      labelKey: 'sync.badge.attention',
      labelParams: { count: input.attentionCount },
    };
  }
  if (!input.online) {
    const hours = input.lastSyncAt
      ? Math.max(
          0,
          Math.floor((input.now.getTime() - new Date(input.lastSyncAt).getTime()) / 3_600_000),
        )
      : null;
    return hours === null
      ? { color: 'grey', labelKey: 'sync.badge.offline_unknown' }
      : { color: 'grey', labelKey: 'sync.badge.offline_since', labelParams: { hours } };
  }
  if (input.pendingCount > 0) {
    return {
      color: 'orange',
      labelKey: 'sync.badge.pending',
      labelParams: { count: input.pendingCount },
    };
  }
  return { color: 'green', labelKey: 'sync.badge.synced' };
}
