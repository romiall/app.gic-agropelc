/**
 * Lecture réactive de l'état de synchronisation depuis Dexie (`liveQuery`, 05-stack.md §2.2 :
 * « tous les écrans utilisables hors ligne lisent la base locale, jamais le réseau »).
 * Partagé par `SyncBadge` (UX-04) et `SyncScreen` (ECR-SYN-01).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useOnline } from '../../platform/useOnline.js';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { computeBadgeState, type BadgeState } from '../../sync/badge-state.js';
import { needsAttention } from '../../sync/outbox.js';
import { clock } from '../../platform/composition.js';

export interface SyncStatus {
  readonly badge: BadgeState;
  readonly pending: readonly OutboxCommand[];
  readonly attention: readonly OutboxCommand[];
  readonly lastSyncAt: string | null;
}

export function useSyncStatus(): SyncStatus | undefined {
  // Joignabilité réelle du serveur (ADR-037), pas seulement l'interface réseau.
  const online = useOnline();
  const snapshot = useLiveQuery(async () => {
    const db = getDb();
    const [allOutbox, meta] = await Promise.all([
      db.outbox.orderBy('device_seq').toArray(),
      db.syncMeta.get('device'),
    ]);
    return {
      pending: allOutbox.filter(
        (c) => c.status === 'LOCAL_ONLY' || c.status === 'PENDING_SYNC' || c.status === 'SYNCING',
      ),
      // Une opération classée par l'utilisateur ne compte plus (MP-09, AV-283).
      attention: allOutbox.filter(needsAttention),
      lastSyncAt: meta?.last_sync_at ?? null,
    };
  }, []);

  if (!snapshot) return undefined;
  const badge = computeBadgeState({
    online,
    pendingCount: snapshot.pending.length,
    attentionCount: snapshot.attention.length,
    lastSyncAt: snapshot.lastSyncAt,
    now: clock.now(),
  });
  return {
    badge,
    pending: snapshot.pending,
    attention: snapshot.attention,
    lastSyncAt: snapshot.lastSyncAt,
  };
}
