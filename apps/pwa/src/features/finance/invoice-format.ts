/**
 * Libellés des factures fournisseurs (ECR-FIN-03, P8E-05) : écarts de rapprochement en clair
 * (`mismatch_details`, `INVOICE_MISMATCH_REASONS`), communs à l'aperçu de la saisie et aux fiches.
 */
import type { TFunction } from 'i18next';
import type { InvoiceMismatchDetail } from '@gic/domain';
import { formatMoney } from '../sales/format.js';

const AMOUNT_REASONS = new Set([
  'LINE_NOT_ON_ORDER',
  'PRICE_MISMATCH',
  'LINE_AMOUNT_MISMATCH',
  'TOTAL_MISMATCH',
]);

const formatQuantityValue = (value: number | null) =>
  value === null ? '—' : String(Math.round(value * 1000) / 1000).replace('.', ',');

/**
 * Écart en clair : ligne de la facture (rang), valeurs attendue et facturée (montants en F CFA,
 * quantités en unité de base) ; `orderLineLabel` nomme une ligne de bon de commande (produit), sinon
 * « une ligne du bon » (cumul au-delà de l'accepté, qui ne porte pas de rang).
 */
export function mismatchText(
  t: TFunction,
  detail: InvoiceMismatchDetail,
  orderLineLabel: (poLineId: string) => string | null = () => null,
): string {
  const amounts = AMOUNT_REASONS.has(detail.reason);
  const value = (input: number | null) =>
    amounts ? (input === null ? '—' : formatMoney(input)) : formatQuantityValue(input);
  const named = detail.poLineId ? orderLineLabel(detail.poLineId) : null;
  return t(`supplier_invoice.mismatch.${detail.reason}`, {
    line: detail.lineIndex === null ? '' : String(detail.lineIndex + 1),
    product: named || t('supplier_invoice.mismatch_order_line'),
    expected: value(detail.expected),
    actual: value(detail.actual),
    defaultValue: detail.reason,
  });
}
