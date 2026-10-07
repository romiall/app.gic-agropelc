/**
 * Clé de synchronisation d'un référentiel dont la clé primaire est un code (ADR-031) :
 * `sync_change_feed.entity_id` ne porte qu'un UUID. L'identifiant est un UUID version 5
 * (RFC 9562, SHA-1) du nom `<TYPE>:<code>` dans l'espace de noms fixé par l'ADR : stable,
 * reproductible par toute écriture du flux (gestionnaire de commande ou seed) sans colonne
 * supplémentaire. `platform` ne connaît aucun module : le type d'entité est fourni par l'appelant.
 */
import { createHash } from 'node:crypto';

/** Espace de noms des clés de synchronisation (ADR-031) ; ne jamais le changer. */
export const SYNC_CODE_NAMESPACE = '6f1d3c2a-8b4e-5d7f-9a10-2c3e4f5a6b7c';

export function codeEntityId(entityType: string, code: string): string {
  const namespace = Buffer.from(SYNC_CODE_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(namespace)
    .update(`${entityType}:${code}`, 'utf8')
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 9562
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
