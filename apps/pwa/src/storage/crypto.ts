/**
 * Clé dérivée du PIN (07-security-rbac/02-securite.md §3 : PIN local, 6 chiffres, PBKDF2-
 * SHA256 ≥ 310 000 itérations, sel aléatoire) et chiffrement des magasins sensibles locaux
 * (AES-GCM). Web Crypto (`crypto.subtle`) : disponible nativement, aucune dépendance (K1).
 * Le PIN lui-même n'est jamais stocké ni transmis — seule la clé qui en dérive existe, en
 * mémoire, le temps de la session déverrouillée.
 */

export const PBKDF2_ITERATIONS = 310_000;
const PIN_RE = /^\d{6}$/;

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64(bytes);
}

/** Clé AES-GCM dérivée du PIN et d'un sel par utilisateur+appareil (jamais persistée). */
export async function deriveKey(
  pin: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface Encrypted {
  readonly ciphertext: string;
  readonly iv: string;
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<Encrypted> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  const buffer = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: toBase64(new Uint8Array(buffer)), iv: toBase64(iv) };
}

export async function decryptText(key: CryptoKey, encrypted: Encrypted): Promise<string> {
  const buffer = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(encrypted.iv) },
    key,
    fromBase64(encrypted.ciphertext),
  );
  return new TextDecoder().decode(buffer);
}
