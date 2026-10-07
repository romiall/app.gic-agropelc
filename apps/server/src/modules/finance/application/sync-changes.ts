/**
 * Lignes de flux de changements émises par `finance` (P4-11 ; 01-architecture-offline.md §3.1) :
 * jeu `cash` — comptes de trésorerie de l'utilisateur ou du PDV, avec leur solde. Audience : le
 * détenteur d'une caisse personnelle, à défaut le responsable du compte (`USER`), et le site du
 * compte (`SITE`, caisse de PDV) — la même ressource que les lectures HTTP (`cashAccountResourceOf`).
 * Émis à chaque mouvement (le solde change) et à chaque création, modification ou désactivation ;
 * un compte désactivé sort du jeu (`SCOPE_EXIT`), comme l'ancien responsable d'un compte réattribué.
 * Le type d'entité est une clé de `sync/entity-projections.ts`.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';

export const CASH_DATASET = 'cash';

export async function emitCashAccountChange(
  uow: Transaction<DB>,
  cashAccountId: string,
  options: { readonly previousOwnerId?: string } = {},
): Promise<void> {
  const row = await uow
    .selectFrom('finance_cash_accounts')
    .select(['holder_user_id', 'responsible_user_id', 'site_id', 'status', 'version'])
    .where('id', '=', toBin(cashAccountId))
    .executeTakeFirst();
  if (!row) return;
  const owner = fromBinOrNull(row.holder_user_id) ?? fromBin(row.responsible_user_id);
  const site = fromBinOrNull(row.site_id);
  const changeType = row.status === 'ACTIVE' ? 'UPSERT' : 'SCOPE_EXIT';
  const base = { dataset: CASH_DATASET, entityType: 'CASH_ACCOUNT', entityId: cashAccountId };
  const entries: ChangeFeedEntry[] = [
    { ...base, scopeType: 'USER', scopeId: owner, changeType, rowVersion: row.version },
  ];
  if (site !== null) {
    entries.push({
      ...base,
      scopeType: 'SITE',
      scopeId: site,
      changeType,
      rowVersion: row.version,
    });
  }
  const previous = options.previousOwnerId;
  if (previous !== undefined && previous !== owner) {
    entries.push({
      ...base,
      scopeType: 'USER',
      scopeId: previous,
      changeType: 'SCOPE_EXIT',
      rowVersion: row.version,
    });
  }
  await recordChanges(uow, entries);
}
