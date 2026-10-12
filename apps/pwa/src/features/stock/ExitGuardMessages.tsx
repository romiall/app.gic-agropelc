/**
 * Messages de la garde hors ligne d'une sortie de stock (BR-STK-013, AV-303) : refus sur l'appareil,
 * puis sorties enregistrées que le serveur signalera.
 */
import { useTranslation } from 'react-i18next';
import { formatQuantity } from '../sales/format.js';
import type { ExitGuard, ExitIssue } from '../sales/quota.js';

export function ExitGuardMessages({
  guard,
  productName,
}: {
  readonly guard: ExitGuard;
  readonly productName: (productId: string) => string;
}) {
  const { t } = useTranslation();
  const values = (issue: ExitIssue) => ({
    product: productName(issue.productId),
    available: formatQuantity(Math.max(0, issue.available)),
    requested: formatQuantity(issue.requested),
  });
  return (
    <>
      {guard.blocks.map((issue) => (
        <p key={`block-${issue.productId}-${issue.code}`} className="error-message" role="alert">
          {t(`stock.guard.${issue.code}`, values(issue))}
        </p>
      ))}
      {guard.signals.map((issue) => (
        <p key={`signal-${issue.productId}-${issue.code}`} className="text-warn" role="status">
          {t('stock.guard_signal', {
            ...values(issue),
            code: t(`sales.quota_block.${issue.code}`),
          })}
        </p>
      ))}
    </>
  );
}
