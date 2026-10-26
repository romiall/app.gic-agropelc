/**
 * Validation d'une définition d'exploration **pour un utilisateur** (P9-19, P9-20 ; ADR-064 §4 et §7, ADR-067 §3) :
 * le jeu est-il lisible (chacune de ses permissions de lecture), la définition est-elle valide contre le catalogue,
 * les limites et le droit de valorisation (`inventory.valuation.read`) de l'utilisateur ? Sert à la sauvegarde d'une
 * vue, à la demande d'un export et, une seconde fois, au calcul de l'export (les droits sont revérifiés à l'instant
 * du calcul). Ne juge ni l'étendue des lignes (`resolveExactScope`) ni l'exécution.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  businessDayOf,
  datasetOf,
  validateExploration,
  type ExplorationDefinition,
  type ExplorationPlan,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../../identity/application/public/index.js';
import { readExplorerLimits } from './limits.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const VALUATION_PERMISSION = 'inventory.valuation.read';

export type UserExplorationValidation =
  | { readonly ok: true; readonly plan: ExplorationPlan; readonly canReadValuation: boolean }
  | {
      readonly ok: false;
      /** `FORBIDDEN` (jeu illisible), `FORBIDDEN_MEASURE` ou un code de `validateExploration`. */
      readonly code: string;
      readonly messageFr: string;
      readonly permission?: string;
    };

export async function validateExplorationForUser(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly definition: ExplorationDefinition;
    readonly at: Date;
    /** Plafond de lignes de l'usage (l'export en admet davantage que l'écran). */
    readonly maxRows?: number;
  },
): Promise<UserExplorationValidation> {
  const userBin = toBin(input.userId);
  const target = datasetOf(input.definition.dataset);
  if (target !== undefined) {
    for (const permission of target.permissions) {
      if (!(await hasPermissionAt(executor, userBin, permission, input.at))) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          messageFr: 'Droit insuffisant pour consulter ce jeu de données.',
          permission,
        };
      }
    }
  }
  const limits = await readExplorerLimits(executor, input.at);
  const canReadValuation = await hasPermissionAt(executor, userBin, VALUATION_PERMISSION, input.at);
  const validation = validateExploration(input.definition, {
    today: businessDayOf(input.at),
    canReadValuation,
    maxDetailDays: limits.maxDetailDays,
    maxRows: input.maxRows ?? limits.maxRows,
  });
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      messageFr: validation.message,
      ...(validation.code === 'FORBIDDEN_MEASURE' ? { permission: VALUATION_PERMISSION } : {}),
    };
  }
  return { ok: true, plan: validation.plan, canReadValuation };
}
