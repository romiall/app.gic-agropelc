/**
 * Identifiant d'événement déterministe (UUID v5, RFC 4122 §4.3) pour les événements qu'un module publie
 * depuis une fonction qui ne reçoit pas de générateur d'identifiants (`requestApproval`,
 * `decideApprovalRequest`) : le type et l'objet suffisent à le recalculer, et l'unicité de `event_id`
 * interdit de publier deux fois le même fait. À réserver aux faits qui n'arrivent qu'une fois par objet
 * (une demande de validation, sa décision, la demande d'un transfert, son expédition).
 */
import { createHash } from 'node:crypto';

/** Espace de noms des identifiants d'événements de GIC AGROPELC (valeur fixe, jamais changée). */
export const EVENT_ID_NAMESPACE = '3b9f0c1e-7a52-4d86-9e14-5c2a8d6f1b07';

function bytesOf(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** UUID v5 : SHA-1 de l'espace de noms puis du nom, version et variante posées. */
export function uuidV5(namespace: string, name: string): string {
  const digest = createHash('sha1').update(bytesOf(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Identifiant de l'événement `eventType` de l'objet `aggregateId`. */
export function deterministicEventId(eventType: string, aggregateId: string): string {
  return uuidV5(EVENT_ID_NAMESPACE, `${eventType}:${aggregateId}`);
}
