/**
 * Téléphones des fixtures (helpers.ts) : un numéro déjà pris en base ou déjà délivré par le processus
 * n'est jamais rendu, et `insertTestUser` réessaie quand un fichier parallèle valide le même numéro
 * entre son contrôle et son insertion (collision réelle de `uq_identity_users_active_phone` observée
 * dans la suite).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '@gic/domain';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  drawLocalPhone,
  freshLocalPhone,
  freshPhone,
  freshUuid,
  insertTestUser,
  isDuplicateKey,
  withTestUow,
} from './helpers.js';

afterAll(closeTestDb);

/** Utilisateur au numéro tiré sans `freshPhone` : inconnu du registre du processus. */
async function insertUnregisteredUser(trx: UnitOfWork): Promise<string> {
  for (;;) {
    const id = freshUuid();
    const local = drawLocalPhone();
    try {
      await trx
        .insertInto('identity_users')
        .values({
          id: toBin(id),
          full_name: 'Test',
          phone: `+237${local}`,
          password_hash: 'x',
          status: 'ACTIVE',
          created_by: toBin(id),
        })
        .execute();
      return local;
    } catch (error) {
      if (!isDuplicateKey(error, 'uq_identity_users_active_phone')) throw error;
    }
  }
}

/** Rend d'abord `first`, puis des tirages ordinaires. */
const drawsFrom = (first: readonly string[]) => {
  const queue = [...first];
  return { draw: () => queue.shift() ?? drawLocalPhone(), left: () => queue.length };
};

describe('téléphones de test', () => {
  it('forme nationale saisie sur le terrain et forme E.164 des colonnes', async () => {
    const local = await freshLocalPhone();
    expect(local).toMatch(/^6\d{8}$/);
    expect(normalizePhone(local, '237')).toBe(`+237${local}`);
    expect(await freshPhone()).toMatch(/^\+2376\d{8}$/);
  });

  it('saute un numéro pris en base, puis ne rend jamais deux fois le même', async () => {
    await withTestUow(async (trx) => {
      const taken = await insertUnregisteredUser(trx);
      const draws = drawsFrom([taken]);
      const local = await freshLocalPhone({ executor: trx, draw: draws.draw });
      expect(draws.left()).toBe(0);
      expect(local).not.toBe(taken);
      await expect(freshLocalPhone({ draw: () => local })).rejects.toThrow(
        /Aucun numéro de test libre/,
      );
    });
  });

  it('insertTestUser réessaie sur un numéro validé ailleurs après son contrôle', async () => {
    await withTestUow(async (trx) => {
      // Première lecture : la photo de la transaction (REPEATABLE READ) précède la validation.
      await trx.selectFrom('identity_users').select('id').limit(1).execute();
      const raced = await db.transaction().execute((other) => insertUnregisteredUser(other));
      const invisible = await trx
        .selectFrom('identity_users')
        .select('id')
        .where('active_phone', '=', `+237${raced}`)
        .executeTakeFirst();
      expect(invisible).toBeUndefined();
      const draws = drawsFrom([raced]);
      const userId = await insertTestUser(trx, { drawPhone: draws.draw });
      expect(draws.left()).toBe(0);
      const { phone } = await trx
        .selectFrom('identity_users')
        .select('phone')
        .where('id', '=', toBin(userId))
        .executeTakeFirstOrThrow();
      expect(phone).not.toBe(`+237${raced}`);
      expect(phone).toMatch(/^\+2376\d{8}$/);
    });
  });
});
