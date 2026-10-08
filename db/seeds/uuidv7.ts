/**
 * Identifiants des lignes créées par les scripts d'amorçage (`run.ts`, `create-local-admin.ts`).
 *
 * Toute clé primaire est un UUIDv7 (ADR-002 ; RFC 9562) : le serveur le **vérifie** dans les jetons
 * d'accès (`verifyAccessToken` : `sub`, `device_id`, `session_id`) et refuse tout autre format
 * (`MALFORMED_CLAIMS`). Un compte administrateur local créé avec 16 octets tirés au hasard ne
 * pouvait donc jamais appeler l'API. Ce paquet n'importe pas `@gic/domain` (migrations et seeds
 * restent autonomes) : même algorithme que `packages/domain/src/uuid.ts` (méthode aléatoire :
 * 48 bits d'horodatage en millisecondes, puis aléa, version 7, variante RFC 4122).
 */
import { randomBytes } from 'node:crypto';

/** 16 octets d'un UUIDv7, prêts pour une colonne `BINARY(16)`. */
export function newUuidv7Bytes(timestampMs: number = Date.now()): Buffer {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
    throw new Error('newUuidv7Bytes : horodatage hors plage (48 bits non signés).');
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestampMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

/** Forme texte canonique (8-4-4-4-12) de 16 octets. */
export function uuidText(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
