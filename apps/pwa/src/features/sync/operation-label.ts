/**
 * Libellé français d'un type d'opération (MP-09 : « procurement.receipt.record » devient « Réception
 * d'achat ») ; un type inconnu de cette version reste affiché tel quel.
 */
import type { TFunction } from 'i18next';

export function operationLabel(t: TFunction, commandType: string): string {
  return t(`sync.operation.${commandType.replace(/\./g, '_')}`, { defaultValue: commandType });
}
