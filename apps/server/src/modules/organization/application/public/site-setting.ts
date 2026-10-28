/**
 * Lecture d'un réglage « du site, à défaut global » (règle 8 : aucun seuil codé en dur). Fonction
 * commune des alertes de stock, de ventes et de production (P9-25, AL-1) : `organization.setting.set`
 * ne contrôle pas la valeur écrite (`z.unknown()`), donc une valeur de site inexploitable (chaîne,
 * `null`, zéro ou négatif selon le réglage) ne doit pas masquer un global valide (même règle que la
 * mortalité, AV-411).
 *
 * Sémantique : `currentSettingValue` ne rend que la dernière version du SITE. Si elle est
 * inexploitable, le repli est le GLOBAL, jamais une version antérieure valide du même site. Le GLOBAL
 * n'est pas validé ici : il est rendu tel quel et l'`…OrDefault` du domaine reste le dernier filet.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { currentSettingValue } from './setting-query.js';

export async function siteThenGlobalSetting(
  executor: Kysely<DB> | Transaction<DB>,
  key: string,
  siteId: string | null,
  at: Date,
  isValid: (value: unknown) => boolean,
): Promise<unknown> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(executor, {
      key,
      scopeType: 'SITE',
      scopeId: siteId,
      at,
    });
    if (bySite !== undefined && isValid(bySite)) return bySite;
  }
  return currentSettingValue(executor, { key, scopeType: 'GLOBAL', scopeId: null, at });
}
