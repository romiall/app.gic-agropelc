/**
 * Lecteur de projection du jeu hors ligne `kpi` (P9-18 ; ADR-076 §6, ADR-070 §6) : l'instantané personnel
 * d'indicateurs de l'utilisateur, une ligne par `(tableau, période)`, **en portée `USER` seulement et celle de
 * l'utilisateur qui télécharge**. L'appareil affiche ses indicateurs locaux et, en regard, cet instantané daté
 * (`computed_at`, « à jour au ») ; la tour de contrôle et l'explorateur restent en ligne.
 *
 * Fichier propre à P9, inscrit dans `ENTITY_PROJECTIONS` (`entity-projections.ts`) par une seule ligne. Une
 * ligne `GLOBAL` (repli générique du pipeline) ou d'un autre utilisateur ne sert jamais rien ; un instantané
 * supprimé (droit perdu, appareil inactif) n'est plus servi et sa sortie est une ligne `DELETE` du flux.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import {
  KPI_ENTITY_TYPE,
  listSnapshotsOf,
  snapshotEntityId,
} from '../modules/analytics/application/public/index.js';

/**
 * Signature de `EntityProjectionReader` (`entity-projections.ts`), recopiée ici : ce fichier est importé par
 * `entity-projections.ts`, qui ne peut pas être importé en retour (règle `no-circular`).
 */
interface ProjectionContext {
  readonly scopeType: string;
  readonly scopeId: string | null;
}
type ProjectionReader = (
  executor: Kysely<DB> | Transaction<DB>,
  entityId: string,
  context: ProjectionContext,
) => Promise<Record<string, unknown> | undefined>;

export const KPI_PROJECTIONS: Readonly<Record<string, ProjectionReader>> = {
  [KPI_ENTITY_TYPE]: async (executor, entityId, context) => {
    if (context.scopeType !== 'USER' || context.scopeId === null) return undefined;
    const userId = context.scopeId;
    const snapshots = await listSnapshotsOf(executor, userId);
    const found = snapshots.find((snapshot) => snapshotEntityId(snapshot) === entityId);
    if (found === undefined) return undefined;
    return {
      id: entityId,
      scope_key: found.scopeKey,
      period_key: found.periodKey,
      computed_at: found.computedAt.toISOString(),
      kpis: found.kpis,
    };
  },
};
