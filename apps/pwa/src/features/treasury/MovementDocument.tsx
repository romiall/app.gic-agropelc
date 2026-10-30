/**
 * Pièce d'origine d'un mouvement de trésorerie (ECR-FIN-05, P8E-04, AV-300) : une dépense ou un paiement
 * fournisseur, lu sur demande (`GET /expenses/{id}`, `GET /supplier-payments/{id}`) ; numéro, statut,
 * objet de la dépense, ou fournisseur et référence du paiement (nom lu sur `GET /suppliers`, à défaut
 * l'identifiant court). Les autres mouvements n'ont pas de lien. Le détail ouvert reçoit le focus, à la
 * place du bouton qui l'ouvre (revue de P8E-04).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button } from '../../components/ui/index.js';
import type { ExpenseItem } from '../finance/expense-follow.js';
import type { SupplierView } from '../procurement/suppliers.js';
import { readPath, useOnlineRead, type ReadResult } from '../sales/online-read.js';
import {
  movementDocumentPath,
  type CashMovementItem,
  type SupplierPaymentItem,
} from './treasury.js';

type DocumentRead =
  | { readonly kind: 'EXPENSE'; readonly expense: ExpenseItem }
  | {
      readonly kind: 'SUPPLIER_PAYMENT';
      readonly payment: SupplierPaymentItem;
      readonly supplierName: string | null;
    };

async function readDocument(path: string): Promise<ReadResult<DocumentRead>> {
  const read = await readPath<{
    readonly expense?: ExpenseItem;
    readonly supplier_payment?: SupplierPaymentItem;
  }>(path);
  if (!read.ok) return read;
  if (read.data.expense) return { ok: true, data: { kind: 'EXPENSE', expense: read.data.expense } };
  const payment = read.data.supplier_payment!;
  // Nom du fournisseur : facultatif, l'identifiant court le remplace si la liste est illisible.
  const suppliers = await readPath<{ readonly suppliers: readonly SupplierView[] }>(
    '/api/v1/suppliers',
  );
  const supplierName = suppliers.ok
    ? (suppliers.data.suppliers.find((supplier) => supplier.id === payment.supplierId)?.name ??
      null)
    : null;
  return { ok: true, data: { kind: 'SUPPLIER_PAYMENT', payment, supplierName } };
}

export function MovementDocument({
  movement,
  label,
  online,
}: {
  readonly movement: CashMovementItem;
  /** Désignation du mouvement (date et montant) : nomme le bouton de chaque ligne. */
  readonly label: string;
  readonly online: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const path = movementDocumentPath(movement);
  const read = useOnlineRead<DocumentRead>(
    shown && path ? path : null,
    (key) => readDocument(key),
    online,
    '',
  );
  useEffect(() => {
    if (shown) container.current?.focus();
  }, [shown]);
  if (!path) return null;
  const kind = movement.sourceDocType === 'EXPENSE' ? 'EXPENSE' : 'SUPPLIER_PAYMENT';
  if (!shown) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setShown(true)}>
        {t(`treasury.movement_document_open.${kind}`, { label })}
      </Button>
    );
  }
  const data = read.data;
  let content;
  if (read.failed) {
    content = (
      <Banner
        tone="warn"
        role="alert"
        action={
          read.denied ? undefined : (
            <Button variant="outline" size="sm" onClick={read.retry}>
              {t('distribution.retry')}
            </Button>
          )
        }
      >
        {read.denied
          ? t('treasury.movement_document_denied')
          : t('treasury.movement_document_failed')}
      </Banner>
    );
  } else if (!data) {
    content = <p className="home-muted">{t('sales.loading')}</p>;
  } else if (data.kind === 'EXPENSE') {
    content = (
      <p className="home-muted">
        {t('treasury.movement_document_expense', {
          doc: data.expense.docNumber,
          category: data.expense.categoryLabel,
          description: data.expense.description,
          status: t(`expense.status.${data.expense.status}`, {
            defaultValue: data.expense.status,
          }),
        })}
      </p>
    );
  } else {
    content = (
      <p className="home-muted">
        {t('treasury.movement_document_payment', {
          doc: data.payment.docNumber,
          supplier: data.supplierName ?? `…${data.payment.supplierId.slice(-4)}`,
          status: t(`treasury.supplier_payment_status.${data.payment.status}`, {
            defaultValue: data.payment.status,
          }),
        })}
        {data.payment.externalReference
          ? ` · ${t('treasury.supplier_payment_reference', {
              reference: data.payment.externalReference,
            })}`
          : ''}
      </p>
    );
  }
  return (
    <div ref={container} role="status" tabIndex={-1} aria-label={label}>
      {content}
    </div>
  );
}
