/**
 * Droits du demandeur **au téléchargement** d'un export (P9-25, EX-3 ; AV-460 ; ADR-067 §6) : le fichier a été calculé
 * avec les droits d'alors, il se télécharge pendant 24 h. Si le demandeur a perdu depuis un droit de lecture du jeu ou
 * le droit de valorisation (`inventory.valuation.read`) quand l'export porte une mesure au coût, le téléchargement est
 * refusé : sinon le fichier serait une voie latérale vers des valeurs que l'écran ne lui montre plus. Le droit
 * `analytics.export` est revérifié à chaque appel par le contrôleur ; ici, ce que la définition conservée exige en plus.
 *
 * Ne juge ni le catalogue ni les limites (un export déjà produit n'est pas rejoué) : une définition qui ne se relit
 * plus est traitée comme portant une mesure protégée, par prudence.
 */
import type { Kysely, Transaction } from 'kysely';
import { explorationDefinitionSchema } from '@gic/contracts';
import { businessDayOf, datasetOf, validateExploration } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../../identity/application/public/index.js';
import { explorationDefinitionFrom } from '../query/exploration-definition.js';
import { VALUATION_PERMISSION } from '../query/validate-for-user.js';
import type { StoredExport } from './export-store.js';

/** La première permission qui manque au demandeur pour télécharger cet export ; `null` si rien ne manque. */
export async function missingDownloadPermission(
  executor: Kysely<DB> | Transaction<DB>,
  input: { readonly job: StoredExport; readonly at: Date },
): Promise<string | null> {
  const userBin = toBin(input.job.requestedBy);
  for (const permission of datasetOf(input.job.dataset)?.permissions ?? []) {
    if (!(await hasPermissionAt(executor, userBin, permission, input.at))) return permission;
  }
  if (
    exportUsesProtectedMeasure(input.job, input.at) &&
    !(await hasPermissionAt(executor, userBin, VALUATION_PERMISSION, input.at))
  ) {
    return VALUATION_PERMISSION;
  }
  return null;
}

/** La définition conservée porte-t-elle une mesure au coût ? Oui aussi quand elle ne se relit plus. */
function exportUsesProtectedMeasure(job: StoredExport, at: Date): boolean {
  const parsed = explorationDefinitionSchema.safeParse(job.definition);
  if (!parsed.success) return true;
  const validation = validateExploration(explorationDefinitionFrom(parsed.data), {
    today: businessDayOf(at),
    canReadValuation: true,
    maxDetailDays: Number.MAX_SAFE_INTEGER,
    maxRows: Number.MAX_SAFE_INTEGER,
  });
  if (!validation.ok) return true;
  return validation.plan.measures.some((measure) => measure.protected === true);
}
