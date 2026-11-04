/**
 * Identifiants stables d'un chargement de données (RP-2, PP-C ; AV-508) : un UUIDv7 dérivé de la nature et de la clé
 * de la ligne (code du produit, téléphone du client, numéro de la pièce…). Charger deux fois le même fichier donne
 * les mêmes `aggregate_id` : le serveur reconnaît la création déjà faite (idempotence par agrégat) et ne crée aucun
 * doublon, même si la première file a été vidée ou le fichier rechargé après une coupure.
 *
 * Forme d'UUIDv7 (ADR-002) : 48 bits de temps fixe, version 7, variante RFC 4122, le reste tiré d'un SHA-256.
 * L'instant est une constante : il ne dit rien de la date du chargement.
 */

/** Instant fixe des identifiants de chargement (1er novembre 2026, début des reprises de données). */
export const IMPORT_ID_EPOCH_MS = Date.parse('2026-11-01T00:00:00.000Z');

/** Espace de noms : deux chargements de nature différente ne produisent jamais le même identifiant. */
const NAMESPACE = 'gic-agropelc|chargement';

const hex = (byte: number): string => byte.toString(16).padStart(2, '0');

/** UUIDv7 stable pour `(kind, key)`. La clé est comparée telle quelle : l'appelant la normalise. */
export async function importEntityId(kind: string, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${NAMESPACE}|${kind}|${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const bytes = new Uint8Array(16);
  // 48 bits de temps, en gros-boutiste.
  let time = IMPORT_ID_EPOCH_MS;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | (digest[0]! & 0x0f);
  bytes[7] = digest[1]!;
  bytes[8] = 0x80 | (digest[2]! & 0x3f);
  for (let index = 9; index < 16; index += 1) bytes[index] = digest[index - 6]!;
  const text = Array.from(bytes, hex).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
