/**
 * Enveloppe d'une commande telle qu'elle part vers `POST /api/v1/sync/push`, et sa vérification locale
 * (06-offline-sync/02-synchronisation.md §3.1).
 *
 * Le serveur valide le lot **entier** avec `pushRequestSchema` : une seule enveloppe invalide (un identifiant
 * qui n'est pas un UUIDv7, un motif vide…) fait refuser les 50 commandes du lot par un HTTP 400, à chaque
 * cycle, indéfiniment — la file de l'appareil reste alors bloquée et les approbations, ventes et saisies qui
 * la suivent ne partent jamais (constaté en ligne le 04/11/2026 : douze appareils de test enrôlés avec des
 * identifiants UUIDv4 ; toute décision de l'Admin sur l'un d'eux bloquait toutes les suivantes).
 *
 * `checkEnvelope` applique ici le **même schéma** que le serveur (`@gic/contracts`) : une commande qu'il
 * refuse ici l'aurait été là-bas, et le moteur la désigne au lieu de laisser le lot échouer.
 */
import { describeIssuesFr, rawCommandEnvelopeSchema } from '@gic/contracts';
import type { RawCommandEnvelope } from '@gic/contracts';
import type { OutboxCommand } from '../storage/db.js';

/** Enveloppe de transport d'une commande de l'outbox (champs locaux — statut, tentatives… — exclus). */
export function toEnvelope(command: OutboxCommand): RawCommandEnvelope {
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

export type EnvelopeCheck =
  { readonly ok: true } | { readonly ok: false; readonly message_fr: string };

/**
 * Début du motif d'une commande refusée sur l'appareil avant l'envoi. Sert aussi à reconnaître, parmi les commandes
 * `REJECTED`, celles qui n'ont jamais atteint le serveur (refus local) : leur numéro est déclaré au serveur
 * (`skipped_device_seqs`, ADR-052, AV-507), y compris pour celles refusées par une version antérieure de l'application.
 */
export const LOCAL_REFUSAL_PREFIX = "Commande non envoyable, refusée sur l'appareil";

/** La commande passerait-elle la validation du serveur ? Sinon, pourquoi (en français, sans le contenu). */
export function checkEnvelope(command: OutboxCommand): EnvelopeCheck {
  const parsed = rawCommandEnvelopeSchema.safeParse(toEnvelope(command));
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    message_fr: `${LOCAL_REFUSAL_PREFIX} : ${describeIssuesFr(parsed.error.issues)}`,
  };
}
