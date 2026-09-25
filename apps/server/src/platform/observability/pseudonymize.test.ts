import { describe, expect, it } from 'vitest';
import { pseudonymizeId } from './pseudonymize.js';

describe('pseudonymizeId (09-non-functional/02-observabilite.md §2)', () => {
  it('est déterministe : le même identifiant produit toujours le même pseudonyme', () => {
    const id = '01a0d9a1-6f70-7fec-992b-ab41a187cc9e';
    expect(pseudonymizeId(id)).toBe(pseudonymizeId(id));
  });

  it('deux identifiants différents produisent des pseudonymes différents', () => {
    expect(pseudonymizeId('user-a')).not.toBe(pseudonymizeId('user-b'));
  });

  it('ne renvoie jamais l’identifiant réel en clair', () => {
    const id = '01a0d9a1-6f70-7fec-992b-ab41a187cc9e';
    expect(pseudonymizeId(id)).not.toContain(id);
  });

  it('longueur courte et stable (empreinte tronquée, pas un hachage complet)', () => {
    expect(pseudonymizeId('any-id')).toHaveLength(12);
  });
});
