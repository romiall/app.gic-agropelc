/**
 * Vidage de l'outbox vers `POST /api/v1/sync/push` (06-offline-sync/02-synchronisation.md
 * §3). Un seul lot par appel (≤ 50 commandes, `pushRequestSchema`) ; l'appelant (`engine.ts`)
 * boucle tant qu'il reste des commandes en attente.
 */
import type { PushRequest, PushResponse, RawCommandEnvelope } from '@gic/contracts';
import { deviceStateAfterResult } from '@gic/contracts';
import type { Clock, IdGenerator } from '@gic/domain';
import type { GicDatabase, OutboxCommand } from '../storage/db.js';
import { pendingOutbox } from './outbox.js';
import { authorizedRequest } from './api-client.js';

export type PushCycleResult =
  | { readonly outcome: 'NOTHING_TO_PUSH' }
  | { readonly outcome: 'PUSHED'; readonly count: number }
  | { readonly outcome: 'OFFLINE' }
  | { readonly outcome: 'SESSION_INVALID' };

function toEnvelope(command: OutboxCommand): RawCommandEnvelope {
  return {
    command_id: command.command_id,
    device_seq: command.device_seq,
    command_type: command.command_type,
    command_version: command.command_version,
    author_user_id: command.author_user_id,
    aggregate_type: command.aggregate_type,
    aggregate_id: command.aggregate_id,
    base_version: command.base_version,
    depends_on: [...command.depends_on],
    occurred_at: command.occurred_at,
    client_created_at: command.client_created_at,
    captured_offline: command.captured_offline,
    backdated_reason: command.backdated_reason,
    attachment_ids: [...command.attachment_ids],
    payload: command.payload,
  };
}

export async function runPushCycle(
  db: GicDatabase,
  deps: { readonly clock: Clock; readonly idGenerator: IdGenerator; readonly deviceId: string },
): Promise<PushCycleResult> {
  const batch = await pendingOutbox(db);
  if (batch.length === 0) return { outcome: 'NOTHING_TO_PUSH' };

  await db.outbox
    .where('command_id')
    .anyOf(batch.map((c) => c.command_id))
    .modify({ status: 'SYNCING' });

  const request: PushRequest = {
    device_id: deps.deviceId,
    batch_id: deps.idGenerator.newId(),
    device_sent_at: deps.clock.now().toISOString(),
    commands: batch.map(toEnvelope),
  };

  const result = await authorizedRequest<PushResponse>(db, '/api/v1/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!result.ok) {
    // Pas de résultat serveur : les commandes redeviennent PENDING_SYNC (repartent au
    // prochain cycle) plutôt que SYNCING indéfiniment — reprise après coupure (§8).
    await db.outbox
      .where('command_id')
      .anyOf(batch.map((c) => c.command_id))
      .modify((c) => {
        c.status = 'PENDING_SYNC';
        c.attempts += 1;
      });
    // Seul un jeton de rafraîchissement invalide (session révoquée) force la déconnexion
    // locale : une erreur HTTP du contrôleur (ex. 400 sur une enveloppe malformée, un bug
    // côté appareil) n'est pas une preuve que la session est invalide — elle est simplement
    // reportée comme `OFFLINE` (nouvel essai au prochain cycle, sans effet destructeur).
    return result.reason === 'SESSION_INVALID'
      ? { outcome: 'SESSION_INVALID' }
      : { outcome: 'OFFLINE' };
  }

  await db.syncMeta.update('device', { clock_skew_ms: result.data.clock_skew_ms });

  for (const commandResult of result.data.results) {
    const nextStatus = deviceStateAfterResult(commandResult.status);
    await db.outbox.update(commandResult.command_id, {
      status: nextStatus,
      server_refs: commandResult.server_refs ?? null,
      last_error: commandResult.error ?? null,
    });
  }

  return { outcome: 'PUSHED', count: result.data.results.length };
}
