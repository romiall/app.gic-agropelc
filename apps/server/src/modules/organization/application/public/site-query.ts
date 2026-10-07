/**
 * Sites d'un ensemble de zones (ADR-030 : périmètre d'un rôle affecté à une zone). Une zone couvre
 * ses sites et ceux de ses descendantes (fermeture transitive `organization_zone_ancestors`).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export async function listSiteIdsInZones(
  executor: Kysely<DB> | Transaction<DB>,
  zoneIds: readonly string[],
): Promise<readonly string[]> {
  if (zoneIds.length === 0) return [];
  const rows = await executor
    .selectFrom('organization_sites as s')
    .innerJoin('organization_zone_ancestors as a', 'a.zone_id', 's.zone_id')
    .select('s.id as id')
    .where(
      'a.ancestor_id',
      'in',
      zoneIds.map((id) => toBin(id)),
    )
    .where('s.status', '=', 'ACTIVE')
    .execute();
  return [...new Set(rows.map((row) => fromBin(row.id)))];
}
