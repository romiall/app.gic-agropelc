/**
 * Clé de synchronisation d'un référentiel à clé `code` (ADR-031) : même calcul que
 * `apps/server/src/platform/sync/code-entity-id.ts` (le paquet `db` n'importe pas le serveur) —
 * UUID version 5 (RFC 9562) du nom `<TYPE>:<code>` dans l'espace de noms de l'ADR. Les deux
 * implémentations sont épinglées sur la même valeur par leurs tests.
 */
import { createHash } from 'node:crypto';

export const SYNC_CODE_NAMESPACE = '6f1d3c2a-8b4e-5d7f-9a10-2c3e4f5a6b7c';

export function codeEntityId(entityType: string, code: string): string {
  const namespace = Buffer.from(SYNC_CODE_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(namespace)
    .update(`${entityType}:${code}`, 'utf8')
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
