/**
 * Garde de désactivation d'un emplacement tenue par `finance` (P5-12 ; BR-ADM-011, INV-STK-07 ;
 * dictionnaire `organization.locations`) : l'emplacement de vente (`POS`) d'un site dont la caisse de
 * PDV a une session **ouverte** ne se désactive pas (`LOCATION_HAS_OPEN_CASH_SESSION`) ; consultée par
 * `organization.location.deactivate` et, pour chaque emplacement actif du site, par
 * `organization.site.close`. Enregistrée auprès d'`organization` au démarrage (inversion de dépendance).
 *
 * Lecture seule. Les caisses du site sont lues sans verrou (type et site d'un compte sont immuables) ;
 * les sessions en verrou partagé : une ouverture concurrente, qui tient le site en partagé puis le
 * compte et ses sessions en exclusif, est soit déjà visible, soit attend la fin de la fermeture du site
 * (aucun cycle : la garde ne verrouille jamais un compte). Limite connue : un site sans emplacement
 * `POS` actif n'appelle pas cette garde à sa fermeture (le registre est par emplacement).
 */
import type { LocationDeactivationBlock } from '../../organization/application/public/index.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export async function financeLocationDeactivationGuard(
  uow: UnitOfWork,
  locationId: string,
): Promise<LocationDeactivationBlock | null> {
  const location = await uow
    .selectFrom('organization_locations')
    .select(['site_id', 'location_type'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!location || location.location_type !== 'POS' || location.site_id === null) return null;

  const accounts = await uow
    .selectFrom('finance_cash_accounts')
    .select('id')
    .where('site_id', '=', location.site_id)
    .where('account_type', '=', 'CAISSE_PDV')
    .execute();
  if (accounts.length === 0) return null;

  const open = await uow
    .selectFrom('finance_cash_sessions')
    .select('id')
    .where(
      'open_account',
      'in',
      accounts.map((account) => account.id),
    )
    .limit(1)
    .forShare()
    .executeTakeFirst();
  if (open) {
    return {
      code: 'LOCATION_HAS_OPEN_CASH_SESSION',
      messageFr:
        'La caisse de ce point de vente a une session ouverte : la clôturer avant de désactiver l’emplacement de vente.',
    };
  }
  return null;
}
