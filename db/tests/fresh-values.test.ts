// Valeurs uniques des tests de base (helpers.ts) : un téléphone ou un code court déjà pris dans la
// transaction du test, ou déjà délivré par le processus, n'est jamais rendu.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import {
  drawPhone,
  drawShortCode,
  freshPhone,
  freshShortCode,
  randomId,
  withRollback,
} from './helpers.js';

/** Insère `insert(valeur tirée)` jusqu'à réussite (une valeur tirée brute peut déjà être prise). */
async function insertDrawn(draw: () => string, insert: (value: string) => Promise<unknown>) {
  for (;;) {
    const value = draw();
    try {
      await insert(value);
      return value;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
    }
  }
}

async function insertUser(conn: PoolConnection, phone: string): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [id, phone, id],
  );
  return id;
}

describe('valeurs uniques de test', () => {
  it('freshPhone saute un numéro porté par un utilisateur et ne rend jamais deux fois le même', async () => {
    await withRollback(async (conn) => {
      const taken = await insertDrawn(drawPhone, (phone) => insertUser(conn, phone));
      const queue = [taken];
      const phone = await freshPhone(conn, () => queue.shift() ?? drawPhone());
      expect(queue).toEqual([]);
      expect(phone).not.toBe(taken);
      expect(phone).toMatch(/^\+2376\d{8}$/);
      await expect(freshPhone(conn, () => phone)).rejects.toThrow(/Aucune valeur de test libre/);
    });
  });

  it('freshShortCode saute un code court déjà attribué', async () => {
    await withRollback(async (conn) => {
      const admin = await insertUser(conn, await freshPhone(conn));
      const taken = await insertDrawn(drawShortCode, (code) =>
        conn.query(
          `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, ?, ?, ?)`,
          [randomId(), code, admin, admin],
        ),
      );
      const queue = [taken];
      const code = await freshShortCode(conn, () => queue.shift() ?? drawShortCode());
      expect(queue).toEqual([]);
      expect(code).not.toBe(taken);
      expect(code).toMatch(/^[A-Z0-9]{4}$/);
    });
  });
});
