/**
 * Messages de la garde hors ligne d'une sortie de stock (BR-STK-013, AV-231) : refus sur l'appareil,
 * puis sorties enregistrées que le serveur signalera. Chaque message porte un identifiant stable
 * (`guardIssueId`) que le champ de quantité concerné référence (`aria-describedby`) ; la région est
 * polie (`role="status"`) pour ne pas couper la saisie à chaque chiffre.
 */
import { useTranslation } from 'react-i18next';
import { formatQuantity } from '../sales/format.js';
import type { ExitGuard, ExitIssue } from '../sales/quota.js';
import { guardIssueId } from './exit-guard.js';

export function ExitGuardMessages({
  guard,
  idPrefix,
  productName,
  unitOf,
}: {
  readonly guard: ExitGuard;
  readonly idPrefix: string;
  readonly productName: (productId: string) => string;
  readonly unitOf: (productId: string) => string;
}) {
  const { t } = useTranslation();
  const values = (issue: ExitIssue) => ({
    product: productName(issue.productId),
    available: formatQuantity(Math.max(0, issue.available)),
    requested: formatQuantity(issue.requested),
    unit: unitOf(issue.productId),
  });
  return (
    <>
      {guard.blocks.map((issue) => (
        <p
          key={`block-${issue.productId}-${issue.code}`}
          id={guardIssueId(idPrefix, issue.productId)}
          className="error-message"
          role="status"
        >
          {t(`stock.guard.${issue.code}`, values(issue))}
        </p>
      ))}
      {guard.signals.map((issue) => (
        <p
          key={`signal-${issue.productId}-${issue.code}`}
          id={guardIssueId(idPrefix, issue.productId)}
          className="text-warn"
          role="status"
        >
          {t('stock.guard_signal', {
            ...values(issue),
            code: t(`sales.quota_block.${issue.code}`),
          })}
        </p>
      ))}
    </>
  );
}
