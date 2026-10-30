/**
 * Paiements fournisseurs en attente de la Direction (ECR-FIN-05, P8E-04, AV-300) : au-delà du seuil,
 * rien n'est décaissé avant la décision (ADR-043) ; lecture seule, la décision se prend dans la file
 * des validations (`?types=SUPPLIER_PAYMENT`), lien réservé à la Direction. Lecture propre
 * (`GET /supplier-payments?status=PENDING_APPROVAL`), relue avec la trésorerie (`reloadKey`) ; noms
 * des fournisseurs lus sur `GET /suppliers` (à défaut, l'identifiant court).
 */
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import {
  Banner,
  Button,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  LinkButton,
  Section,
  SkeletonRows,
} from '../../components/ui/index.js';
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
    <Banner
      tone="bad"
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
        ? t('treasury.supplier_payments_denied')
        : t(data ? 'treasury.supplier_payments_failed_stale' : 'treasury.supplier_payments_failed')}
    </Banner>
  ) : null;

  return (
    <Section title={t('treasury.supplier_payments_title')}>
      <p className="home-muted">{t('treasury.supplier_payments_note')}</p>
      {failure}
      {!data ? (
        read.failed ? null : (
          <SkeletonRows rows={2} />
        )
      ) : data.payments.items.length === 0 ? (
        <EmptyState icon="check-circle" title={t('treasury.supplier_payments_empty')} />
      ) : (
        <>
          {data.suppliersFailed ? (
            <Banner
              tone="warn"
              role="status"
              action={
                <Button variant="outline" size="sm" onClick={read.retry}>
                  {t('distribution.retry')}
                </Button>
              }
            >
              {t('treasury.suppliers_failed')}
            </Banner>
          ) : null}
          {data.payments.more ? (
            <p className="text-warn" role="status">
              {t('treasury.partial', { count: data.payments.items.length })}
            </p>
          ) : null}
          <DataList
            template="minmax(0, 2fr) minmax(8rem, 1fr) minmax(0, 3fr)"
            columns={[
              { label: t('treasury.col_payment') },
              { label: t('treasury.col_amount'), numeric: true },
              { label: t('treasury.col_detail') },
            ]}
          >
            {data.payments.items.map((payment) => (
              <DataRow key={payment.id} aria-label={payment.docNumber}>
                <DataCell primary>
                  <strong>{payment.docNumber}</strong>
                  <small className="fin-group-meta">
                    {data.suppliers.get(payment.supplierId) ?? short(payment.supplierId)}
                  </small>
                </DataCell>
                <DataCell label={t('treasury.col_amount')} numeric>
                  {formatMoney(payment.amountXaf)}
                </DataCell>
                <DataCell>
                  <span className="fin-meta">
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
                  </span>
                </DataCell>
              </DataRow>
            ))}
          </DataList>
          {mayDecide ? (
            <div className="chip-row">
              <LinkButton
                to={`${ROUTES.approvals}?types=SUPPLIER_PAYMENT`}
                variant="tonal"
                size="sm"
                icon="check-circle"
              >
                {t('treasury.supplier_payments_decide')}
              </LinkButton>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}
