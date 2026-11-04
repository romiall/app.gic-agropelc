/** Identifiants stables d'un chargement (RP-2, PP-C ; AV-508) : même clé, même UUIDv7 ; jamais une collision de nature. */
import { isUuidv7 } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import { authorImportId, IMPORT_ID_EPOCH_MS, importEntityId } from './ids.js';

describe('authorImportId', () => {
  it('rattache l’identifiant à celui qui charge : le même auteur retrouve le sien, un autre ne le partage pas', async () => {
    const mine = await authorImportId(
      '01900000-0000-7000-8000-0000000000aa',
      'customer',
      '+237677123456',
    );
    expect(
      await authorImportId('01900000-0000-7000-8000-0000000000aa', 'customer', '+237677123456'),
    ).toBe(mine);
    expect(
      await authorImportId('01900000-0000-7000-8000-0000000000ab', 'customer', '+237677123456'),
    ).not.toBe(mine);
    // Ni la clé seule, ni une autre nature ne retombent sur lui.
    expect(await importEntityId('customer', '+237677123456')).not.toBe(mine);
    expect(
      await authorImportId('01900000-0000-7000-8000-0000000000aa', 'supplier', '+237677123456'),
    ).not.toBe(mine);
    expect(isUuidv7(mine)).toBe(true);
  });
});

describe('importEntityId', () => {
  it('rend un UUIDv7 valide, toujours le même pour la même clé', async () => {
    const first = await importEntityId('product', 'POULET-CHAIR');
    const second = await importEntityId('product', 'POULET-CHAIR');
    expect(first).toBe(second);
    expect(isUuidv7(first)).toBe(true);
  });

  it('une autre clé ou une autre nature donne un autre identifiant', async () => {
    const base = await importEntityId('product', 'A');
    expect(await importEntityId('product', 'B')).not.toBe(base);
    expect(await importEntityId('category', 'A')).not.toBe(base);
  });

  it('les 48 premiers bits sont l’instant fixe du chargement', async () => {
    const id = await importEntityId('customer', '+237677123456');
    const timeHex = id.replace(/-/g, '').slice(0, 12);
    expect(Number.parseInt(timeHex, 16)).toBe(IMPORT_ID_EPOCH_MS);
  });

  it('pas de collision sur un grand nombre de clés', async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      ids.add(await importEntityId('customer', `client-${index}`));
    }
    expect(ids.size).toBe(2_000);
  });
});
