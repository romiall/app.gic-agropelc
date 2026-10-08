/**
 * Garde de désactivation d'un emplacement tenue par `inventory` (INV-STK-07, BR-ADM-011) : un
 * emplacement ne se désactive pas tant qu'il porte du stock, un quota d'appareil actif ou un
 * transfert ouvert. Enregistrée auprès d'`organization` au démarrage (inversion de dépendance :
 * `organization` ignore ces données). Lecture seule : verrous partagés pour que la décision ne
 * dépende pas d'un instantané périmé (une sortie concurrente écrit sous verrou exclusif).
 */
import type { LocationDeactivationBlock } from '../../organization/application/public/index.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

/** Transfert encore en cours : marchandise demandée, en route, avec écart à trancher, ou non rapprochée. */
const OPEN_TRANSFER_STATUSES = ['REQUESTED', 'DISPATCHED', 'DISCREPANCY_PENDING', 'UNMATCHED'];

export async function inventoryLocationDeactivationGuard(
  uow: UnitOfWork,
  locationId: string,
): Promise<LocationDeactivationBlock | null> {
  const id = toBin(locationId);

  const stocked = await uow
    .selectFrom('inventory_stock_balances')
    .select('product_id')
    .where('location_id', '=', id)
    .where('qty_on_hand', '<>', '0')
    .limit(1)
    .forShare()
    .executeTakeFirst();
  if (stocked) {
    return {
      code: 'LOCATION_NOT_EMPTY',
      messageFr: 'Cet emplacement porte encore du stock : le vider avant de le désactiver.',
    };
  }

  const quota = await uow
    .selectFrom('inventory_stock_allocations')
    .select('id')
    .where('location_id', '=', id)
    .where('status', '=', 'ACTIVE')
    .limit(1)
    .forShare()
    .executeTakeFirst();
  if (quota) {
    return {
      code: 'LOCATION_HAS_ALLOCATIONS',
      messageFr: 'Cet emplacement a des allocations actives : les libérer ou les révoquer d’abord.',
    };
  }

  const transfer = await uow
    .selectFrom('inventory_stock_transfers')
    .select('id')
    .where((eb) => eb.or([eb('from_location_id', '=', id), eb('to_location_id', '=', id)]))
    .where('status', 'in', OPEN_TRANSFER_STATUSES)
    .limit(1)
    .forShare()
    .executeTakeFirst();
  if (transfer) {
    return {
      code: 'LOCATION_HAS_OPEN_TRANSFER',
      messageFr: 'Cet emplacement a un transfert ouvert : le terminer ou l’annuler d’abord.',
    };
  }
  return null;
}
