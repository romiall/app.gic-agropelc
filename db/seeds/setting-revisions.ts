/**
 * Révisions datées des paramètres système (BR-ADM-015 : une nouvelle version, jamais une réécriture).
 * Chaque révision du seed (`SYSTEM_SETTING_REVISIONS`, ex. AV-115, AV-154) s'applique **une fois** par
 * base : une ligne GLOBAL dont le motif est `Révision <révision>` la marque. Elle ne s'applique pas si
 * la valeur en vigueur est déjà la bonne, ni une seconde fois : une valeur posée ensuite par un
 * administrateur n'est jamais écrasée.
 *
 * Module séparé de `run.ts` (MP-11, revue adverse : le chemin n'était pas testé) pour être exercé par
 * `db/tests/setting-revisions.test.ts`.
 */
import type mysql from 'mysql2/promise';
import type { SystemSettingRevision } from './system-settings.js';
import { newUuidv7Bytes as newId } from './uuidv7.js';

/** Applique les révisions absentes ; rend le nombre de révisions écrites. */
export async function applySettingRevisions(
  conn: mysql.Connection,
  systemUserId: Buffer,
  revisions: readonly SystemSettingRevision[],
): Promise<number> {
  let revised = 0;
  for (const revision of revisions) {
    const reason = `Révision ${revision.revision}`;
    const [applied] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT id FROM organization_system_settings WHERE `key` = ? AND scope_type = 'GLOBAL' AND scope_id IS NULL AND reason = ?",
      [revision.key, reason],
    );
    if (applied.length > 0) continue;
    // Comparaison JSON faite par MySQL : juste pour tout type de valeur (une chaîne JSON relue puis
    // passée à `JSON.parse` cassait, revue de MP-11).
    const [current] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT value = CAST(? AS JSON) AS same FROM organization_system_settings WHERE `key` = ? AND scope_type = 'GLOBAL' AND scope_id IS NULL ORDER BY valid_from DESC LIMIT 1",
      [JSON.stringify(revision.value), revision.key],
    );
    if (Number(current[0]?.same) === 1) continue;
    await conn.query(
      `INSERT INTO organization_system_settings (id, \`key\`, value, scope_type, valid_from, is_client_visible, created_by, reason)
       VALUES (?, ?, CAST(? AS JSON), 'GLOBAL', UTC_TIMESTAMP(6), ?, ?, ?)`,
      [
        newId(),
        revision.key,
        JSON.stringify(revision.value),
        revision.isClientVisible,
        systemUserId,
        reason,
      ],
    );
    revised++;
  }
  return revised;
}
