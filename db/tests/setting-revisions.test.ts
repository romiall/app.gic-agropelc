// Révisions datées des paramètres système (BR-ADM-015 ; AV-115, AV-154) : appliquées une seule fois,
// jamais par-dessus une valeur posée ensuite par un administrateur (MP-11, revue adverse : chemin non
// testé). Clés de test propres à chaque exécution, dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type mysql from 'mysql2/promise';
import { applySettingRevisions } from '../seeds/setting-revisions.js';
import type { SystemSettingRevision } from '../seeds/system-settings.js';
import { newUuidv7Bytes } from '../seeds/uuidv7.js';
import { withRollback } from './helpers.js';

async function systemUserId(conn: mysql.Connection): Promise<Buffer> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT id FROM identity_users WHERE is_system = TRUE LIMIT 1',
  );
  return rows[0]!.id as Buffer;
}

async function insertVersion(
  conn: mysql.Connection,
  createdBy: Buffer,
  key: string,
  value: unknown,
  validFrom: string,
  reason: string,
): Promise<void> {
  await conn.query(
    `INSERT INTO organization_system_settings (id, \`key\`, value, scope_type, valid_from, created_by, reason)
     VALUES (?, ?, CAST(? AS JSON), 'GLOBAL', ?, ?, ?)`,
    [newUuidv7Bytes(), key, JSON.stringify(value), validFrom, createdBy, reason],
  );
}

async function versions(
  conn: mysql.Connection,
  key: string,
): Promise<{ value: unknown; reason: string }[]> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT value, reason FROM organization_system_settings WHERE `key` = ? AND scope_type = 'GLOBAL' ORDER BY valid_from",
    [key],
  );
  return rows.map((row) => ({ value: row.value as unknown, reason: row.reason as string }));
}

describe('applySettingRevisions (BR-ADM-015)', () => {
  it('valeur ancienne : une version datée marquée, une seule fois ; une valeur d’administrateur posée ensuite reste', async () => {
    await withRollback(async (conn) => {
      const createdBy = await systemUserId(conn);
      const key = `test.revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await insertVersion(conn, createdBy, key, 1, '2020-01-01 00:00:00', 'Seed P0-05 (test)');
      const revision: SystemSettingRevision = {
        revision: 'TEST (14/10/2026)',
        key,
        value: 0,
        isClientVisible: false,
      };

      expect(await applySettingRevisions(conn, createdBy, [revision])).toBe(1);
      expect(await versions(conn, key)).toEqual([
        { value: 1, reason: 'Seed P0-05 (test)' },
        { value: 0, reason: 'Révision TEST (14/10/2026)' },
      ]);
      // Rejeu : rien de plus.
      expect(await applySettingRevisions(conn, createdBy, [revision])).toBe(0);

      // Un administrateur repose 2 après la révision : un nouveau seed ne l'écrase pas.
      await insertVersion(conn, createdBy, key, 2, '2999-01-01 00:00:00', 'Choix de l’Admin');
      expect(await applySettingRevisions(conn, createdBy, [revision])).toBe(0);
      expect((await versions(conn, key)).at(-1)).toEqual({ value: 2, reason: 'Choix de l’Admin' });
    });
  });

  it('valeur déjà juste, ou de type texte : aucune version ajoutée', async () => {
    await withRollback(async (conn) => {
      const createdBy = await systemUserId(conn);
      const key = `test.revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await insertVersion(conn, createdBy, key, ['A', 'B'], '2020-01-01 00:00:00', 'Seed');
      expect(
        await applySettingRevisions(conn, createdBy, [
          { revision: 'TEST', key, value: ['A', 'B'], isClientVisible: false },
        ]),
      ).toBe(0);

      const textKey = `${key}_texte`;
      await insertVersion(conn, createdBy, textKey, 'OUVERT', '2020-01-01 00:00:00', 'Seed');
      expect(
        await applySettingRevisions(conn, createdBy, [
          { revision: 'TEST', key: textKey, value: 'OUVERT', isClientVisible: false },
        ]),
      ).toBe(0);
      expect(
        await applySettingRevisions(conn, createdBy, [
          { revision: 'TEST', key: textKey, value: 'FERME', isClientVisible: false },
        ]),
      ).toBe(1);
      expect((await versions(conn, textKey)).at(-1)).toEqual({
        value: 'FERME',
        reason: 'Révision TEST',
      });
    });
  });

  it('clé absente : la révision crée sa première version', async () => {
    await withRollback(async (conn) => {
      const createdBy = await systemUserId(conn);
      const key = `test.revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      expect(
        await applySettingRevisions(conn, createdBy, [
          { revision: 'TEST', key, value: 5, isClientVisible: false },
        ]),
      ).toBe(1);
      expect(await versions(conn, key)).toEqual([{ value: 5, reason: 'Révision TEST' }]);
    });
  });
});
