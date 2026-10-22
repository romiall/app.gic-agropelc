/**
 * Paiements fournisseurs en attente de la Direction (ECR-FIN-05, P8E-04, AV-300) : au-delà du seuil,
 * rien n'est décaissé avant la décision (ADR-043) ; lecture seule, la décision se prend dans la file
 * des validations (`?types=SUPPLIER_PAYMENT`), lien réservé à la Direction. Lecture propre
 * (`GET /supplier-payments?status=PENDING_APPROVAL`), relue avec la trésorerie (`reloadKey`) ; noms
 * des fournisseurs lus sur `GET /suppliers` (à défaut, l'identifiant court).
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import type { SupplierView } from '../procurement/suppliers.js';
import { formatMoney } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type Pages,
  type ReadResult,
} from '../sales/online-read.js';
import type { PaymentMethodData, UserData } from '../sales/types.js';
import type { SupplierPaymentItem } from './treasury.js';

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

interface PendingRead {
  readonly payments: Pages<SupplierPaymentItem>;
  /** Noms des fournisseurs ; vide si leur lecture est refusée ou en échec. */
  readonly suppliers: ReadonlyMap<string, string>;
  /** Panne de la lecture des fournisseurs (distincte d'un refus) : annoncée avec « Réessayer ». */
  readonly suppliersFailed: boolean;
}

async function readPending(): Promise<ReadResult<PendingRead>> {
  const payments = await readPages<SupplierPaymentItem>(
    [`/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=${PAGE_LIMIT}`],
    'supplier_payments',
    MAX_PAGES,
  );
  if (!payments.ok) return payments;
  const suppliers = await readPath<{ readonly suppliers: readonly SupplierView[] }>(
    '/api/v1/suppliers',
  );
  return {
    ok: true,
    data: {
      payments: payments.data,
      suppliers: new Map(
        suppliers.ok
          ? suppliers.data.suppliers.map((supplier) => [supplier.id, supplier.name])
          : [],
      ),
      suppliersFailed: !suppliers.ok && !suppliers.denied,
    },
  };
}

export function PendingSupplierPayments({
  userId,
  online,
  reloadKey,
  accountNames,
  paymentMethods,
  users,
}: {
  readonly userId: string;
  readonly online: boolean;
  readonly reloadKey: string;
  readonly accountNames: ReadonlyMap<string, string>;
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'label'>[];
  readonly users: readonly Pick<UserData, 'id' | 'full_name'>[];
}) {
  const { t } = useTranslation();
  const navigation = useRememberedNavigation(userId);
  // Lien proposé une fois les rôles mémorisés lus (sans quoi il paraîtrait un instant à la Finance).
  const mayDecide =
    navigation !== undefined &&
    holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.supplierPaymentApprove);
  const read = useOnlineRead<PendingRead>(
    online ? 'supplier-payments:pending' : null,
    () => readPending(),
    online,
    reloadKey,
  );
  // Une décision de la Direction, prise ailleurs, change cette liste (revue de P8E-10).
  useRefreshOnVisible(read.retry);
  const short = (id: string) => `…${id.slice(-4)}`;
  const nameOf = (id: string) =>
    id === userId
      ? t('treasury.you')
      : (users.find((user) => user.id === id)?.full_name ?? short(id));
  const methodOf = (code: string) =>
    paymentMethods.find((method) => method.code === code)?.label ?? code;

  const data = read.data;
  const failure = read.failed ? (
    <div className="alert alert-error" role="alert">
      <p>
        {read.denied
          ? t('treasury.supplier_payments_denied')
          : t(
              data
                ? 'treasury.supplier_payments_failed_stale'
                : 'treasury.supplier_payments_failed',
            )}
      </p>
      {read.denied ? null : (
        <button type="button" className="secondary" onClick={read.retry}>
          {t('distribution.retry')}
        </button>
      )}
    </div>
  ) : null;

  return (
    <section className="sale-block" aria-labelledby="treasury-supplier-payments-title">
      <h2 id="treasury-supplier-payments-title">{t('treasury.supplier_payments_title')}</h2>
      <p className="home-muted">{t('treasury.supplier_payments_note')}</p>
      {failure}
      {!data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : data.payments.items.length === 0 ? (
        <p className="home-muted">{t('treasury.supplier_payments_empty')}</p>
      ) : (
        <>
          {data.suppliersFailed ? (
            <p className="text-warn" role="status">
              {t('treasury.suppliers_failed')}{' '}
              <button type="button" className="secondary" onClick={read.retry}>
                {t('distribution.retry')}
              </button>
            </p>
          ) : null}
          {data.payments.more ? (
            <p className="text-warn" role="status">
              {t('treasury.partial', { count: data.payments.items.length })}
            </p>
          ) : null}
          <ul className="line-list">
            {data.payments.items.map((payment) => (
              <li key={payment.id} className="line-card" aria-label={payment.docNumber}>
                <p>
                  <strong>{payment.docNumber}</strong> · {formatMoney(payment.amountXaf)}
                </p>
                <p>{data.suppliers.get(payment.supplierId) ?? short(payment.supplierId)}</p>
                <p className="home-muted">
                  {t('treasury.supplier_payment_meta', {
                    method: methodOf(payment.paymentMethodCode),
                    account:
                      accountNames.get(payment.fromAccountId) ?? short(payment.fromAccountId),
                    date: formatDateTime(payment.occurredAt),
                    author: nameOf(payment.createdBy),
                  })}
                  {payment.externalReference
                    ? ` · ${t('treasury.supplier_payment_reference', {
                        reference: payment.externalReference,
                      })}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
          {mayDecide ? (
            <Link
              to={`${ROUTES.approvals}?types=SUPPLIER_PAYMENT`}
              className="action action-compact"
            >
              <span className="action-label">{t('treasury.supplier_payments_decide')}</span>
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}
