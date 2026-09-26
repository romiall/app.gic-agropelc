/**
 * Lignes de flux de changements émises par `crm` (P3-07 ; 01-architecture-offline.md §3.1) :
 * - jeu `customers` : comptes du portefeuille (`USER` : titulaire), de l'équipe du titulaire
 *   (`TEAM`, pour le responsable) et du PDV de rattachement (`SITE`) ; à la réaffectation,
 *   `SCOPE_EXIT` vers l'ancien titulaire et les équipes qu'il quitte (§5.3) ;
 * - jeu `crm_activity` : visites et interactions (`USER` : auteur et titulaire du compte ; `TEAM` :
 *   équipes de l'auteur), objectifs (`USER`, `TEAM` ou `SITE` de la cible).
 * Les types d'entité sont les clés de `sync/entity-projections.ts`, qui ne servent une ligne que
 * si l'entité appartient encore à ce périmètre (jamais le repli générique `GLOBAL` du pipeline).
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { listTeamsOfUserAt } from '../../organization/application/public/index.js';

export const CUSTOMERS_DATASET = 'customers';
export const CRM_ACTIVITY_DATASET = 'crm_activity';

type Uow = Transaction<DB>;

async function userAudience(
  uow: Uow,
  dataset: string,
  entityType: string,
  entityId: string,
  userIds: readonly string[],
  at: Date,
): Promise<ChangeFeedEntry[]> {
  const entries: ChangeFeedEntry[] = [];
  const teams = new Set<string>();
  for (const userId of new Set(userIds)) {
    entries.push({ dataset, entityType, entityId, scopeType: 'USER', scopeId: userId });
    for (const team of await listTeamsOfUserAt(uow, userId, at)) teams.add(team);
  }
  for (const team of teams) {
    entries.push({ dataset, entityType, entityId, scopeType: 'TEAM', scopeId: team });
  }
  return entries;
}

/**
 * Compte créé ou modifié : son audience courante (titulaire, équipes du titulaire, site de
 * rattachement). `previousOwnerId` (réaffectation) : `SCOPE_EXIT` vers l'ancien titulaire et les
 * équipes que le compte quitte.
 */
export async function emitCustomerChange(
  uow: Uow,
  customerId: string,
  at: Date,
  options: { readonly previousOwnerId?: string | null } = {},
): Promise<void> {
  const row = await uow
    .selectFrom('crm_customers')
    .select(['owner_user_id', 'home_site_id', 'version'])
    .where('id', '=', toBin(customerId))
    .executeTakeFirst();
  if (!row) return;
  const owner = fromBinOrNull(row.owner_user_id);
  const upserts = await userAudience(
    uow,
    CUSTOMERS_DATASET,
    'CUSTOMER',
    customerId,
    owner !== null ? [owner] : [],
    at,
  );
  const homeSite = fromBinOrNull(row.home_site_id);
  if (homeSite !== null) {
    upserts.push({
      dataset: CUSTOMERS_DATASET,
      entityType: 'CUSTOMER',
      entityId: customerId,
      scopeType: 'SITE',
      scopeId: homeSite,
    });
  }
  const exits: ChangeFeedEntry[] = [];
  const previous = options.previousOwnerId ?? null;
  if (previous !== null && previous !== owner) {
    const kept = new Set(upserts.map((entry) => `${entry.scopeType}:${entry.scopeId}`));
    for (const entry of await userAudience(
      uow,
      CUSTOMERS_DATASET,
      'CUSTOMER',
      customerId,
      [previous],
      at,
    )) {
      if (!kept.has(`${entry.scopeType}:${entry.scopeId}`)) {
        exits.push({ ...entry, changeType: 'SCOPE_EXIT' });
      }
    }
  }
  await recordChanges(
    uow,
    [...exits, ...upserts].map((entry) => ({ ...entry, rowVersion: row.version })),
  );
}

/** Visite ou interaction : son auteur, ses équipes, et le titulaire courant du compte (s'il
 * diffère : ancien titulaire hors ligne, D02 §12 — « notification au nouveau titulaire »). */
export async function emitActivityChange(
  uow: Uow,
  entity: 'VISIT' | 'INTERACTION',
  activityId: string,
  at: Date,
): Promise<void> {
  const row =
    entity === 'VISIT'
      ? await uow
          .selectFrom('crm_visits as a')
          .innerJoin('crm_customers as c', 'c.id', 'a.customer_id')
          .select([
            'a.user_id as user_id',
            'c.owner_user_id as owner_user_id',
            'a.version as version',
          ])
          .where('a.id', '=', toBin(activityId))
          .executeTakeFirst()
      : await uow
          .selectFrom('crm_interactions as a')
          .innerJoin('crm_customers as c', 'c.id', 'a.customer_id')
          .select([
            'a.user_id as user_id',
            'c.owner_user_id as owner_user_id',
            'a.version as version',
          ])
          .where('a.id', '=', toBin(activityId))
          .executeTakeFirst();
  if (!row) return;
  const users = [fromBin(row.user_id)];
  const owner = fromBinOrNull(row.owner_user_id);
  if (owner !== null) users.push(owner);
  const entries = await userAudience(uow, CRM_ACTIVITY_DATASET, entity, activityId, users, at);
  await recordChanges(
    uow,
    entries.map((entry) => ({ ...entry, rowVersion: row.version })),
  );
}

/** Objectif : sa cible (commercial, équipe ou site). */
export async function emitTargetChange(uow: Uow, targetId: string): Promise<void> {
  const row = await uow
    .selectFrom('crm_sales_targets')
    .select(['target_type', 'user_id', 'team_id', 'site_id', 'version'])
    .where('id', '=', toBin(targetId))
    .executeTakeFirst();
  if (!row) return;
  const scope =
    row.target_type === 'USER' && row.user_id
      ? { scopeType: 'USER' as const, scopeId: fromBin(row.user_id) }
      : row.target_type === 'TEAM' && row.team_id
        ? { scopeType: 'TEAM' as const, scopeId: fromBin(row.team_id) }
        : row.site_id
          ? { scopeType: 'SITE' as const, scopeId: fromBin(row.site_id) }
          : undefined;
  if (!scope) return;
  await recordChanges(uow, [
    {
      dataset: CRM_ACTIVITY_DATASET,
      entityType: 'SALES_TARGET',
      entityId: targetId,
      ...scope,
      rowVersion: row.version,
    },
  ]);
}
