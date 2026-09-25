/**
 * Identifiant d'appareil (UUIDv7, ADR-002) : généré une seule fois à l'installation, jamais
 * régénéré (06-offline-sync/01-architecture-offline.md §6 « Installation »). Stocké non
 * chiffré (`sync_state`, non sensible) : il doit rester lisible avant tout déverrouillage par
 * PIN, y compris pour un appareil jamais encore enrôlé.
 */
import type { GicDatabase } from './db.js';
import type { IdGenerator } from '@gic/domain';

export async function getOrCreateDeviceId(
  db: GicDatabase,
  idGenerator: IdGenerator,
): Promise<string> {
  const existing = await db.syncMeta.get('device');
  if (existing) return existing.device_id;

  const deviceId = idGenerator.newId();
  await db.syncMeta.put({
    key: 'device',
    device_id: deviceId,
    clock_skew_ms: null,
    last_sync_at: null,
  });
  return deviceId;
}
