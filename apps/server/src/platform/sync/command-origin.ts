/**
 * `[STD-ORIGIN]` d'une commande (conventions §3.3 : appareil, réception serveur, horloge
 * suspecte) : `sync_command_inbox` est déjà écrite quand le gestionnaire s'exécute
 * (command-pipeline.service.ts). Partagé par les modules dont les documents portent ce bloc
 * (inventory, fieldwork, crm…) — même lecture que le précédent `attachments/attachment-commands.ts`.
 */
import { isClockSkewSuspect } from '@gic/domain';
import type { UnitOfWork } from '../unit-of-work.js';
import { fromBin, toBin } from '../kysely/uuid-columns.js';

export interface CommandOrigin {
  readonly deviceId: string | null;
  readonly receivedAt: Date;
  readonly clockSuspect: boolean;
}

export async function loadCommandOrigin(
  uow: UnitOfWork,
  commandId: string,
): Promise<CommandOrigin> {
  const row = await uow
    .selectFrom('sync_command_inbox')
    .select(['device_id', 'received_at', 'clock_skew_ms'])
    .where('command_id', '=', toBin(commandId))
    .executeTakeFirstOrThrow();
  return {
    deviceId: row.device_id ? fromBin(row.device_id) : null,
    receivedAt: row.received_at,
    clockSuspect: isClockSkewSuspect(row.clock_skew_ms),
  };
}
