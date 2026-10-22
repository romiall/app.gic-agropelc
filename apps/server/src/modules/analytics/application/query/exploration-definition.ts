/**
 * Définition d'exploration du contrat (`explorationDefinitionSchema`, P9-02) vers celle du domaine
 * (`ExplorationDefinition`, P9-12) : sans propriété vide (`exactOptionalPropertyTypes`). Partagée par l'explorateur,
 * les vues sauvegardées et les exports (P9-14, P9-19, P9-20).
 */
import type { z } from 'zod';
import type { ExplorationDefinition } from '@gic/domain';
import type { explorationDefinitionSchema } from '@gic/contracts';

export function explorationDefinitionFrom(
  input: z.input<typeof explorationDefinitionSchema>,
): ExplorationDefinition {
  return {
    dataset: input.dataset,
    ...(input.period !== undefined
      ? {
          period: {
            code: input.period.code,
            ...(input.period.fromDay !== undefined ? { fromDay: input.period.fromDay } : {}),
            ...(input.period.toDay !== undefined ? { toDay: input.period.toDay } : {}),
          },
        }
      : {}),
    dimensions: input.dimensions ?? [],
    measures: input.measures,
    filters: input.filters ?? [],
    sort: input.sort ?? [],
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}
