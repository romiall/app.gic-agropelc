/**
 * UUIDv7 (RFC 9562) : clé primaire de toute table métier (ADR-002).
 *
 * Générés par l'appareil pour les entités créées hors ligne, par le serveur sinon
 * (03-data/01-identifiants-et-conventions.md §1.3). Les 48 premiers bits portent
 * l'horodatage de création en millisecondes depuis l'epoch Unix, ce qui donne un tri
 * temporel naturel (localité d'index B-tree) sans exposer d'information au-delà de cet
 * horodatage approximatif. L'horodatage embarqué n'est **jamais** utilisé comme heure
 * métier : c'est `occurred_at` qui fait foi (ADR-016).
 *
 * Implémentation « méthode aléatoire » de la RFC (rand_a et rand_b tirés au hasard) :
 * conforme, plus simple qu'un compteur monotone intra-milliseconde, suffisante au
 * volume d'écriture d'un appareil ou d'un serveur unique (H-06).
 */

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toHex(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Construit un UUIDv7 à partir d'un horodatage et d'une source d'aléa injectés.
 * Fonction pure : c'est elle qui est couverte par les tests de propriété.
 */
export function buildUuidv7(timestampMs: number, randomBytes: Uint8Array): string {
  if (randomBytes.length !== 10) {
    throw new Error('buildUuidv7 attend exactement 10 octets aléatoires (rand_a + rand_b).');
  }
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
    throw new Error('buildUuidv7 : horodatage hors plage (48 bits non signés).');
  }

  const bytes = new Uint8Array(16);

  // Octets 0-5 : unix_ts_ms sur 48 bits, poids fort en tête.
  bytes[0] = (timestampMs / 2 ** 40) & 0xff;
  bytes[1] = (timestampMs / 2 ** 32) & 0xff;
  bytes[2] = (timestampMs / 2 ** 24) & 0xff;
  bytes[3] = (timestampMs / 2 ** 16) & 0xff;
  bytes[4] = (timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;

  // Octet 6 : version (0111) sur le nibble haut, 4 bits de rand_a sur le nibble bas.
  bytes[6] = 0x70 | (randomBytes[0]! & 0x0f);
  // Octet 7 : 8 bits restants de rand_a.
  bytes[7] = randomBytes[1]!;
  // Octet 8 : variante (10) sur les 2 bits hauts, 6 bits de rand_b.
  bytes[8] = 0x80 | (randomBytes[2]! & 0x3f);
  // Octets 9-15 : 56 bits restants de rand_b.
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = randomBytes[3 + i]!;
  }

  return (
    toHex(bytes, 0, 4) +
    '-' +
    toHex(bytes, 4, 6) +
    '-' +
    toHex(bytes, 6, 8) +
    '-' +
    toHex(bytes, 8, 10) +
    '-' +
    toHex(bytes, 10, 16)
  );
}

/** Vérifie le format d'un UUIDv7 (version 7, variante RFC 4122). */
export function isUuidv7(value: string): boolean {
  return UUIDV7_RE.test(value);
}

/**
 * Horodatage embarqué dans un UUIDv7, ou `null` si `value` n'en est pas un.
 * Ne fait jamais foi comme heure métier (ADR-016) : usage limité au diagnostic et à la
 * détection d'identifiants forgés (03-data/01-identifiants-et-conventions.md §1.3).
 */
export function extractUuidv7Timestamp(value: string): Date | null {
  if (!isUuidv7(value)) return null;
  const hex = value.replace(/-/g, '').slice(0, 12);
  const ms = Number.parseInt(hex, 16);
  return new Date(ms);
}

export interface ClientProvidedIdCheck {
  readonly ok: boolean;
  readonly reason?: 'INVALID_FORMAT' | 'TIMESTAMP_TOO_FAR_IN_FUTURE';
}

/**
 * Contrôle serveur d'un identifiant fourni par l'appareil (03-data/01-identifiants-et-
 * conventions.md §1.3, point 2) : format UUIDv7, horodatage embarqué pas plus de 24 h
 * dans le futur par rapport à l'heure de réception. Ne vérifie pas l'absence de
 * collision (clé primaire) : responsabilité de la couche d'accès aux données.
 */
export function checkClientProvidedUuidv7(id: string, receivedAt: Date): ClientProvidedIdCheck {
  if (!isUuidv7(id)) {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }
  const embedded = extractUuidv7Timestamp(id)!;
  const maxFuture = receivedAt.getTime() + 24 * 60 * 60 * 1000;
  if (embedded.getTime() > maxFuture) {
    return { ok: false, reason: 'TIMESTAMP_TOO_FAR_IN_FUTURE' };
  }
  return { ok: true };
}
