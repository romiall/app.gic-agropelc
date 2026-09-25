import { describe, expect, it } from 'vitest';
import { decryptText, deriveKey, encryptText, isValidPin, newSalt } from './crypto.js';

describe('isValidPin (07-security-rbac/02-securite.md §3 : 6 chiffres)', () => {
  it.each(['123456', '000000', '999999'])('%s est valide', (pin) => {
    expect(isValidPin(pin)).toBe(true);
  });

  it.each(['12345', '1234567', 'abcdef', '12a456', ''])('%s est invalide', (pin) => {
    expect(isValidPin(pin)).toBe(false);
  });
});

describe('deriveKey / encryptText / decryptText', () => {
  it('chiffre puis déchiffre un texte avec la clé dérivée du bon PIN', async () => {
    const salt = newSalt();
    const key = await deriveKey('123456', salt, 1_000); // itérations réduites : test rapide
    const encrypted = await encryptText(key, 'refresh-token-secret');
    const decrypted = await decryptText(key, encrypted);
    expect(decrypted).toBe('refresh-token-secret');
  });

  it('un sel différent produit une clé différente (échec du déchiffrement)', async () => {
    const key1 = await deriveKey('123456', newSalt(), 1_000);
    const key2 = await deriveKey('123456', newSalt(), 1_000);
    const encrypted = await encryptText(key1, 'secret');
    await expect(decryptText(key2, encrypted)).rejects.toThrow();
  });

  it('un mauvais PIN sur le même sel échoue à déchiffrer (jamais un texte erroné silencieux)', async () => {
    const salt = newSalt();
    const key = await deriveKey('123456', salt, 1_000);
    const wrongKey = await deriveKey('654321', salt, 1_000);
    const encrypted = await encryptText(key, 'secret');
    await expect(decryptText(wrongKey, encrypted)).rejects.toThrow();
  });

  it('deux chiffrements du même texte produisent des IV différents (pas de fuite de motif)', async () => {
    const key = await deriveKey('123456', newSalt(), 1_000);
    const a = await encryptText(key, 'secret');
    const b = await encryptText(key, 'secret');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
