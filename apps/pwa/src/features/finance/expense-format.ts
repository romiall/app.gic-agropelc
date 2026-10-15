/**
 * Libellés d'une dépense communs à la saisie et au suivi (ECR-FIN-02) : imputation, motifs de revue,
 * nom d'un utilisateur ou d'un compte connus de l'appareil.
 */
import type { TFunction } from 'i18next';
import type { IncubationBatchData, ProductionLotData, UserData } from '../sales/types.js';

/** Identifiant inconnu de l'appareil : ses quatre derniers caractères. */
export const shortId = (id: string): string => `…${id.slice(-4)}`;

/** Imputation d'une dépense (ADR-042 §8) : site, frais généraux d'une espèce, lot, ou aucune. */
export function imputationLabel(
  t: TFunction,
  input: {
    readonly type: string | null;
    readonly id: string | null;
    readonly speciesGroup: string | null;
  },
  lots: readonly Pick<ProductionLotData, 'id' | 'lot_code'>[],
  batches: readonly Pick<IncubationBatchData, 'id' | 'batch_code'>[],
): string {
  switch (input.type) {
    case null:
      return t('expense.imputation.NONE');
    case 'SITE':
      return input.speciesGroup
        ? t(`expense.imputation.OVERHEAD_${input.speciesGroup}`)
        : t('expense.imputation.SITE');
    case 'PRODUCTION_LOT':
      return t('expense.imputation.PRODUCTION_LOT', {
        code: lots.find((lot) => lot.id === input.id)?.lot_code ?? shortId(input.id ?? ''),
      });
    case 'INCUBATION_BATCH':
      return t('expense.imputation.INCUBATION_BATCH', {
        code: batches.find((batch) => batch.id === input.id)?.batch_code ?? shortId(input.id ?? ''),
      });
    default:
      return input.type;
  }
}

/**
 * Motifs de revue d'une dépense (ADR-042 §6), en clair et séparés par des virgules ; `values` :
 * valeurs des libellés (plafond du PDV).
 */
export function reviewReasonsText(
  t: TFunction,
  reasons: readonly string[],
  values: Readonly<Record<string, string>> = {},
): string {
  return reasons
    .map((reason) => t(`expense.review.${reason}`, { ...values, defaultValue: reason }))
    .join(', ');
}

/** Nom d'un utilisateur connu de l'appareil (jeu `user`), « vous » pour soi. */
export function userName(
  t: TFunction,
  users: readonly Pick<UserData, 'id' | 'full_name'>[],
  id: string,
  userId: string,
): string {
  if (id === userId) return t('expense.you');
  return users.find((user) => user.id === id)?.full_name ?? shortId(id);
}
