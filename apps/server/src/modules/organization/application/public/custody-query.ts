/**
 * Garde d'un emplacement à un instant (P5-23, AV-195 (2), ADR-040) : la période de
 * `organization_location_custody_periods` qui couvre `at` (`valid_from ≤ at < valid_to`), à défaut la plus
 * ancienne quand `at` la précède ; `undefined` si l'emplacement n'a aucune période (l'appelant retient alors
 * la garde courante). Lecture simple, sans verrou : une configuration validée à l'instant même peut ne pas
 * être vue, ce qui ne change qu'un signal informatif, jamais un rejet.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface CustodyAt {
  readonly custodyMode: string;
  readonly designatedDeviceId: string | null;
  /** Début de la période retenue. */
  readonly periodFrom: Date;
}

export async function custodyAt(
  executor: Kysely<DB> | Transaction<DB>,
  locationId: string,
  at: Date,
): Promise<CustodyAt | undefined> {
  const covering = await executor
    .selectFrom('organization_location_custody_periods')
    .select(['custody_mode', 'designated_device_id', 'valid_from'])
    .where('location_id', '=', toBin(locationId))
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  const row =
    covering ??
    (await executor
      .selectFrom('organization_location_custody_periods')
      .select(['custody_mode', 'designated_device_id', 'valid_from'])
      .where('location_id', '=', toBin(locationId))
      // Une période vide (deux changements de même date) n'a jamais été en vigueur.
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', eb.ref('valid_from'))]))
      .orderBy('valid_from', 'asc')
      .limit(1)
      .executeTakeFirst());
  if (!row) return undefined;
  return {
    custodyMode: row.custody_mode,
    designatedDeviceId: fromBinOrNull(row.designated_device_id),
    periodFrom: row.valid_from,
  };
}
