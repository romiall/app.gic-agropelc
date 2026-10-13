/**
 * Historique de la garde d'un emplacement (P5-23, AV-195 (2), ADR-040 ; BR-STK-016, ADR-033 §2). La ligne
 * `organization_locations` porte la garde courante ; chaque période (mode, appareil désigné) est consignée
 * dans `organization_location_custody_periods`, pour qu'un fait hors ligne se juge sur la garde en vigueur à
 * son `occurred_at` (`custodyAt`). Seuls `organization.location.create` (période initiale) et
 * `organization.pos.configure` changent la garde d'un emplacement.
 *
 * Une période ne naît que si le couple (mode, appareil) change : rejouer une configuration est sans effet.
 * Début d'une nouvelle période : `occurred_at` de la commande, jamais avant le début de la période qu'elle
 * ferme (une période vide reste admise : deux configurations de même date). Un emplacement sans période
 * (inséré avant l'historique, ou directement par un test) se voit d'abord attribuer la période de son état
 * avant le changement, depuis sa création.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBinOrNull, toBin, toBinOrNull } from '../../../platform/kysely/uuid-columns.js';

export interface CustodyState {
  readonly custodyMode: string;
  readonly designatedDeviceId: string | null;
}

export async function recordCustodyPeriod(
  uow: UnitOfWork,
  input: {
    readonly locationId: string;
    /** Garde avant le changement, et date de création de l'emplacement (début d'une période matérialisée). */
    readonly previous: CustodyState & { readonly since: Date };
    readonly next: CustodyState;
    readonly at: Date;
    readonly commandId: string;
    readonly createdBy: string;
    readonly newId: () => string;
  },
): Promise<void> {
  const open = await uow
    .selectFrom('organization_location_custody_periods')
    .select(['id', 'custody_mode', 'designated_device_id', 'valid_from'])
    .where('location_id', '=', toBin(input.locationId))
    .where('valid_to', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  const current: CustodyState & { readonly from: Date } = open
    ? {
        custodyMode: open.custody_mode,
        designatedDeviceId: fromBinOrNull(open.designated_device_id),
        from: open.valid_from,
      }
    : {
        ...input.previous,
        // Jamais après la date de la commande (emplacement créé après la date métier de la commande :
        // horloge, données de test) : la période matérialisée ne commence pas après celle qui la suit.
        from: new Date(Math.min(input.previous.since.getTime(), input.at.getTime())),
      };
  if (
    current.custodyMode === input.next.custodyMode &&
    current.designatedDeviceId === input.next.designatedDeviceId
  ) {
    if (!open) await insertPeriod(uow, input, current, current.from);
    return;
  }
  const start = new Date(Math.max(input.at.getTime(), current.from.getTime()));
  if (open) {
    await uow
      .updateTable('organization_location_custody_periods')
      .set({ valid_to: start })
      .where('id', '=', open.id)
      .execute();
  } else if (start.getTime() > current.from.getTime()) {
    // Période de l'état d'avant, matérialisée seulement si elle a une durée.
    await insertPeriod(uow, input, current, current.from, start);
  }
  await insertPeriod(uow, input, input.next, start);
}

async function insertPeriod(
  uow: UnitOfWork,
  input: {
    readonly locationId: string;
    readonly commandId: string;
    readonly createdBy: string;
    readonly newId: () => string;
  },
  state: CustodyState,
  from: Date,
  to: Date | null = null,
): Promise<void> {
  await uow
    .insertInto('organization_location_custody_periods')
    .values({
      id: toBin(input.newId()),
      location_id: toBin(input.locationId),
      custody_mode: state.custodyMode,
      designated_device_id: toBinOrNull(state.designatedDeviceId),
      valid_from: from,
      valid_to: to,
      command_id: toBin(input.commandId),
      created_by: toBin(input.createdBy),
    })
    .execute();
}
