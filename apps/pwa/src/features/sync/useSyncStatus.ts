/**
 * Lecture réactive de l'état de synchronisation depuis Dexie (`liveQuery`, 05-stack.md §2.2 :
 * « tous les écrans utilisables hors ligne lisent la base locale, jamais le réseau »).
 * Partagé par `SyncBadge` (UX-04) et `SyncScreen` (ECR-SYN-01).
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { computeBadgeState, type BadgeState } from '../../sync/badge-state.js';
import { clock } from '../../platform/composition.js';

export interface SyncStatus {
  readonly badge: BadgeState;
  readonly pending: readonly OutboxCommand[];
  readonly attention: readonly OutboxCommand[];
  readonly lastSyncAt: string | null;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const setTrue = () => setOnline(true);
    const setFalse = () => setOnline(false);
    window.addEventListener('online', setTrue);
    window.addEventListener('offline', setFalse);
    return () => {
      window.removeEventListener('online', setTrue);
      window.removeEventListener('offline', setFalse);
    };
  }, []);
  return online;
}

export function useSyncStatus(): SyncStatus | undefined {
  const online = useOnlineStatus();
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
      attention: allOutbox.filter((c) => c.status === 'CONFLICT' || c.status === 'REJECTED'),
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
