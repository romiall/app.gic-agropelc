/**
 * Vidage de l'outbox vers `POST /api/v1/sync/push` (06-offline-sync/02-synchronisation.md
 * §3). Un seul lot par appel (≤ 50 commandes, `pushRequestSchema`) ; l'appelant (`engine.ts`)
 * boucle tant qu'il reste des commandes en attente.
 */
import type { PushRequest, PushResponse, RawCommandEnvelope } from '@gic/contracts';
import { deviceStateAfterResult, syncResultStatusSchema } from '@gic/contracts';
import type { Clock, IdGenerator } from '@gic/domain';
import type { GicDatabase, OutboxCommand } from '../storage/db.js';
import { pendingAfterBatch, pendingOutbox } from './outbox.js';
import { authorizedRequest } from './api-client.js';

export type PushCycleResult =
  | { readonly outcome: 'NOTHING_TO_PUSH' }
  /**
   * `count` : résultats reçus ; `settled` : commandes qui ont reçu une réponse définitive (appliquée,
   * en conflit ou refusée). Aucune (`RETRY_LATER` partout) : inutile de renvoyer aussitôt.
   */
  | { readonly outcome: 'PUSHED'; readonly count: number; readonly settled: number }
  | { readonly outcome: 'OFFLINE' }
  /** Le serveur a répondu par une erreur HTTP : joignable, nouvel essai au prochain cycle. */
  | { readonly outcome: 'SERVER_ERROR' }
  | { readonly outcome: 'SESSION_INVALID' };

/** Délai d'envoi d'un lot (jusqu'à 50 commandes, chacune dans sa transaction côté serveur). */
const PUSH_TIMEOUT_MS = 60_000;

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
  deps: {
    readonly clock: Clock;
    readonly idGenerator: IdGenerator;
    readonly deviceId: string;
    /**
     * Utilisateur de la session : seules ses commandes partent. Le serveur refuse définitivement
     * une commande dont l'auteur n'est pas l'utilisateur authentifié (`FORBIDDEN`) ; celles d'un
     * autre utilisateur de l'appareil attendent sa reconnexion.
     */
    readonly userId?: string;
  },
): Promise<PushCycleResult> {
  const batch = await pendingOutbox(db, 50, deps.userId);
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
    pending_by_author: await pendingAfterBatch(db, batch),
  };

  const result = await authorizedRequest<PushResponse>(db, '/api/v1/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    timeoutMs: PUSH_TIMEOUT_MS,
  });

  if (!result.ok) {
    // Pas de résultat serveur : les commandes redeviennent PENDING_SYNC (repartent au
    // prochain cycle) plutôt que SYNCING indéfiniment — reprise après coupure (§8). L'enveloppe
    // n'est jamais modifiée : le lot a pu atteindre le serveur avant la coupure, et son empreinte
    // (`payload_hash`, toute l'enveloppe) doit rester identique au renvoi, sans quoi le serveur
    // refuserait la commande déjà appliquée (`COMMAND_ID_REUSED`, ADR-051 §2).
    await db.outbox
      .where('command_id')
      .anyOf(batch.map((c) => c.command_id))
      .modify((c) => {
        c.status = 'PENDING_SYNC';
        c.attempts += 1;
      });
    // Seul un jeton de rafraîchissement invalide (session révoquée) force la déconnexion
    // locale. Une erreur HTTP du contrôleur (ex. 400 sur une enveloppe malformée) prouve que le
    // serveur est joignable : `SERVER_ERROR`, nouvel essai au prochain cycle, sans effet destructeur.
    if (result.reason === 'SESSION_INVALID') return { outcome: 'SESSION_INVALID' };
    return result.reason === 'HTTP_ERROR' ? { outcome: 'SERVER_ERROR' } : { outcome: 'OFFLINE' };
  }

  await db.syncMeta.update('device', { clock_skew_ms: result.data.clock_skew_ms });

  const syncedAt = deps.clock.now().toISOString();
  const answered = new Set<string>();
  let settled = 0;
  for (const commandResult of result.data.results) {
    answered.add(commandResult.command_id);
    const known = syncResultStatusSchema.safeParse(commandResult.status);
    if (!known.success) {
      // Statut hors du protocole (ex. `RECEIVED` après un `RETRY_LATER`, S-18) : jamais écrit sur
      // l'appareil ; la commande repart au prochain cycle, motif précédent conservé.
      await db.outbox
        .where('command_id')
        .equals(commandResult.command_id)
        .modify((c) => {
          c.status = 'PENDING_SYNC';
          c.attempts += 1;
          c.busy_retries = 0;
        });
      continue;
    }
    const nextStatus = deviceStateAfterResult(known.data);
    const accepted = nextStatus === 'SYNCED' || nextStatus === 'SYNCED_WITH_WARNING';
    if (nextStatus === 'PENDING_SYNC') {
      await db.outbox
        .where('command_id')
        .equals(commandResult.command_id)
        .modify((c) => {
          c.status = 'PENDING_SYNC';
          c.attempts += 1;
          c.last_error = commandResult.error ?? c.last_error;
          // Renvois consécutifs pour erreur du serveur (exception en base, S-29 à S-31, S-37) ;
          // une attente de dépendance remet le compteur à zéro.
          c.busy_retries =
            commandResult.error?.code === 'SERVER_BUSY' ? (c.busy_retries ?? 0) + 1 : 0;
        });
      continue;
    }
    settled += 1;
    await db.outbox.update(commandResult.command_id, {
      status: nextStatus,
      busy_retries: 0,
      server_refs: commandResult.server_refs ?? null,
      last_error: commandResult.error ?? null,
      ...(accepted ? { synced_at: syncedAt } : {}),
      ...(commandResult.warnings && commandResult.warnings.length > 0
        ? { warnings: [...commandResult.warnings] }
        : {}),
    });
  }
  // Commande du lot sans résultat : elle ne reste pas « en cours d'envoi » indéfiniment.
  const unanswered = batch.filter((command) => !answered.has(command.command_id));
  if (unanswered.length > 0) {
    await db.outbox
      .where('command_id')
      .anyOf(unanswered.map((command) => command.command_id))
      .modify((c) => {
        c.status = 'PENDING_SYNC';
        c.attempts += 1;
      });
  }

  return { outcome: 'PUSHED', count: result.data.results.length, settled };
}
