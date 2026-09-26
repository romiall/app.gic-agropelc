/**
 * Écriture du flux de changements par un module métier (06-offline-sync/02-synchronisation.md
 * §5.1 : « chaque écriture serveur ajoute des lignes à `sync.change_feed` (dans la même
 * transaction) — une ligne par **périmètre destinataire** concerné »). API interne de
 * `sync-core` (comme `recordAudit` pour `audit`) : un module n'écrit jamais la table
 * directement, il décrit l'entité changée et son périmètre, ce fichier ne connaît aucun
 * module (règle `no-sync-core-business-logic`).
 *
 * Complète, sans le remplacer, le repli générique du pipeline (`command-pipeline.service.ts`,
 * une ligne `GLOBAL` par agrégat de commande) : un module dont les données ont un périmètre
 * réel (stock d'un emplacement, P2-06) l'émet ici, et sa projection de synchronisation
 * (`sync/entity-projections.ts`) ignore les lignes qui ne portent pas ce périmètre. Nécessaire
 * aussi hors d'une commande propre au module : un solde modifié par une décision
 * d'approbation (`approvals.request.approve`, gestionnaire de décision d'`inventory`) doit
 * atteindre le jeu `stock` sans que la commande `approvals` le sache.
 */
import type { UnitOfWork } from '../unit-of-work.js';
import { toBin, toBinOrNull } from '../kysely/uuid-columns.js';

export type ChangeScopeType = 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM' | 'USER' | 'DEVICE' | 'LOCATION';

export interface ChangeFeedEntry {
  /** Jeu de données téléchargé par l'appareil (01-architecture-offline.md §3.1). */
  readonly dataset: string;
  /** Clé de `sync/entity-projections.ts`. */
  readonly entityType: string;
  readonly entityId: string;
  readonly scopeType: ChangeScopeType;
  /** Nul seulement pour `GLOBAL`. */
  readonly scopeId: string | null;
  readonly changeType?: 'UPSERT' | 'DELETE' | 'SCOPE_EXIT';
  readonly rowVersion?: number;
}

export async function recordChanges(
  uow: UnitOfWork,
  entries: readonly ChangeFeedEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await uow
    .insertInto('sync_change_feed')
    .values(
      entries.map((entry) => ({
        dataset: entry.dataset,
        entity_type: entry.entityType,
        entity_id: toBin(entry.entityId),
        change_type: entry.changeType ?? 'UPSERT',
        scope_type: entry.scopeType,
        scope_id: toBinOrNull(entry.scopeId),
        row_version: entry.rowVersion ?? 1,
      })),
    )
    .execute();
}
