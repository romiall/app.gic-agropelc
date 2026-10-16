/**
 * ECR-APP-05 « Rapprochement » (UC-APP-12, P8E-07 ; ADR-047 §8 ; AV-302). Lecture seule, en ligne ;
 * hors ligne, la dernière lecture reste affichée, périmée :
 * - bons de commande envoyés par groupe (attendus, reçus, clôturés) et par fournisseur
 *   (`GET /purchase-orders`), avec leurs écarts : reliquat, rejeté, en quarantaine, excédent reçu,
 *   facturé au-delà de l'accepté, date prévue dépassée (constat sans seuil, AV-302) ; filtre « écarts
 *   seulement » ;
 * - détail à la demande : commandé, livré, rejeté, accepté, en quarantaine, clôturé, excédent,
 *   reliquat et facturé par ligne, valeurs et payé (`/purchase-orders/{id}/matching`, masqués sans
 *   droit), réceptions du bon (`GET /receipts`), factures du bon pour les lecteurs des dettes
 *   (`GET /supplier-invoices`, lien vers ECR-FIN-03). Chaque lecture a son échec et sa relance.
 * Resp. achats, Finance, Direction (AV-302) ; le serveur revérifie.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDate } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import type { SupplierInvoiceItem } from '../finance/supplier-invoice.js';
import { formatMoney, formatQuantity, unitLabel } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type ReadResult,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import type { SupplierView } from './suppliers.js';
import {
  hasGap,
  lineGaps,
  MATCHING_GROUP_ORDER,
  MATCHING_MAX_PAGES,
  matchingListPaths,
  orderIndicators,
  orderInvoicesPath,
  receiptsPath,
  sortOrders,
  sortReceipts,
  type MatchingDetail,
  type MatchingGroup,
  type MatchingOrder,
  type ReceiptItem,
} from './matching.js';

interface OrdersRead {
  readonly items: readonly MatchingOrder[];
  readonly more: boolean;
}

async function readOrders(
  group: MatchingGroup,
  supplierId: string,
): Promise<ReadResult<OrdersRead>> {
  const pages = await readPages<MatchingOrder>(
    matchingListPaths(group, supplierId),
    'purchase_orders',
    MATCHING_MAX_PAGES,
  );
  if (!pages.ok) return pages;
  return { ok: true, data: { items: sortOrders(pages.data.items), more: pages.data.more } };
}

/** Quantité en unité de base du produit (jamais l'unité d'achat du bon) ; nombre seul si inconnue. */
function useQuantityText() {
  const refs = useSalesReferences();
  const productOf = (productId: string) =>
    refs?.products.find((product) => product.id === productId);
  return {
    productName: (productId: string) => productOf(productId)?.name ?? `…${productId.slice(-4)}`,
    quantity: (productId: string, value: number) => {
      const unit = productOf(productId)?.base_unit_code;
      return unit
        ? `${formatQuantity(value)} ${unitLabel(unit, value, refs?.units)}`.trim()
        : formatQuantity(value);
    },
  };
}

export function MatchingScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const suppliers = useOnlineRead(
    userId ? '/api/v1/suppliers' : null,
    (key) => readPath<{ readonly suppliers: readonly SupplierView[] }>(key),
    online,
    '',
  );
  if (!userId || navigation === undefined) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.order_matching')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  return (
    <section className="sale">
      <h1>{t('nav.screens.order_matching')}</h1>
      {suppliers.failed && !suppliers.denied ? (
        <p className="text-warn" role="status">
          {t('supplier_invoice.suppliers_failed')}{' '}
          <button type="button" className="secondary" onClick={suppliers.retry}>
            {t('supplier_invoice.retry_suppliers')}
          </button>
        </p>
      ) : null}
      <OrderList
        suppliers={suppliers.data?.suppliers ?? []}
        online={online}
        // Factures du bon : lecteurs des dettes seulement (sans droit, un refus serait journalisé).
        mayReadInvoices={holdsAnyRole(roles, ROLE_SETS.payableRead)}
      />
    </section>
  );
}

function OrderList({
  suppliers,
  online,
  mayReadInvoices,
}: {
  readonly suppliers: readonly SupplierView[];
  readonly online: boolean;
  readonly mayReadInvoices: boolean;
}) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<MatchingGroup>('OPEN');
  const [supplierId, setSupplierId] = useState('');
  const [gapsOnly, setGapsOnly] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const ids = { group: useId(), supplier: useId(), gaps: useId() };
  const text = useQuantityText();
  const today = businessDayOf(clock.now());
  const read = useOnlineRead<OrdersRead>(
    `po-matching:${group}:${supplierId}`,
    () => readOrders(group, supplierId),
    online,
    '',
  );
  useRefreshOnVisible(read.retry);
  const nameOf = (id: string) =>
    suppliers.find((supplier) => supplier.id === id)?.name ?? `…${id.slice(-4)}`;
  const data = read.data;
  const orders = (data?.items ?? [])
    .map((order) => ({ order, indicators: orderIndicators(order, today) }))
    .filter((entry) => !gapsOnly || hasGap(entry.indicators));

  const indicatorItems = (indicators: (typeof orders)[number]['indicators']) =>
    [
      indicators.overdueDays !== null ? (
        <li key="overdue">
          {t('order_matching.indicator.overdue', { count: indicators.overdueDays })}
        </li>
      ) : null,
      indicators.remainingLines > 0 ? (
        <li key="remaining" className="home-muted">
          {t('order_matching.indicator.remaining', { count: indicators.remainingLines })}
        </li>
      ) : null,
      indicators.rejected ? <li key="rejected">{t('order_matching.indicator.rejected')}</li> : null,
      indicators.quarantined ? (
        <li key="quarantined">{t('order_matching.indicator.quarantined')}</li>
      ) : null,
      indicators.excess ? <li key="excess">{t('order_matching.indicator.excess')}</li> : null,
      indicators.overInvoiced ? (
        <li key="over">{t('order_matching.indicator.over_invoiced')}</li>
      ) : null,
    ].filter((item) => item !== null);

  const card = ({ order, indicators }: (typeof orders)[number]) => (
    <li key={order.id} className="line-card" aria-label={order.docNumber}>
      <p>
        <strong>{order.docNumber}</strong> ·{' '}
        {t(`orders_po.status.${order.status}`, { defaultValue: order.status })}
      </p>
      <p>{nameOf(order.supplierId)}</p>
      <p className="home-muted">
        {t('order_matching.card_dates', {
          date: formatBusinessDate(businessDayOf(new Date(order.occurredAt))),
        })}
        {order.expectedDeliveryDate
          ? ` · ${t('order_matching.expected', { date: formatBusinessDate(order.expectedDeliveryDate) })}`
          : ''}
        {order.totalXaf !== null
          ? ` · ${t('order_matching.total', { amount: formatMoney(order.totalXaf) })}`
          : ''}
      </p>
      {indicatorItems(indicators).length > 0 ? (
        <ul className="text-warn">{indicatorItems(indicators)}</ul>
      ) : null}
      <ul className="home-muted">
        {order.lines
          .filter((line) => line.status !== 'CANCELLED')
          .map((line) => (
            <li key={line.id}>
              {t('order_matching.line_summary', {
                product: text.productName(line.productId),
                ordered: text.quantity(line.productId, line.orderedQtyBase),
                accepted: text.quantity(line.productId, line.acceptedQtyBase),
                remaining: text.quantity(line.productId, line.remainingQtyBase),
              })}
            </li>
          ))}
      </ul>
      <button
        type="button"
        className="secondary"
        aria-expanded={shown === order.id}
        onClick={() => setShown((current) => (current === order.id ? null : order.id))}
      >
        {t(shown === order.id ? 'order_matching.detail_hide' : 'order_matching.detail_show', {
          doc: order.docNumber,
        })}
      </button>
      {shown === order.id ? (
        <OrderDetail order={order} online={online} mayReadInvoices={mayReadInvoices} />
      ) : null}
    </li>
  );

  return (
    <section className="sale-block" aria-labelledby="po-matching-title">
      <h2 id="po-matching-title">{t('order_matching.list_title')}</h2>
      {online ? null : (
        <p className="text-warn" role="status">
          {t(data ? 'order_matching.offline_banner' : 'order_matching.online_only')}
        </p>
      )}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.group}>{t('order_matching.group_label')}</label>
          <select
            id={ids.group}
            className="text-input"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value as MatchingGroup);
              setShown(null);
            }}
          >
            {MATCHING_GROUP_ORDER.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`order_matching.group.${candidate}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.supplier}>{t('order_matching.filter_supplier')}</label>
          <select
            id={ids.supplier}
            className="text-input"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setShown(null);
            }}
          >
            <option value="">{t('supplier_invoice.all_suppliers')}</option>
            {[...suppliers]
              .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.gaps}>
          <input
            id={ids.gaps}
            type="checkbox"
            checked={gapsOnly}
            onChange={(event) => setGapsOnly(event.target.checked)}
          />{' '}
          {t('order_matching.gaps_only')}
        </label>
      </div>
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>
            {read.denied
              ? t('order_matching.denied')
              : t(data ? 'order_matching.failed_stale' : 'order_matching.failed')}
          </p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('order_matching.retry_list')}
            </button>
          )}
        </div>
      ) : null}
      {!data ? (
        read.failed || !online ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : (
        <>
          {online && read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('order_matching.refreshing')}
            </p>
          ) : null}
          {orders.length === 0 ? (
            <p className="home-muted">
              {t(
                gapsOnly && data.items.length > 0
                  ? 'order_matching.no_gap'
                  : 'order_matching.empty',
              )}
            </p>
          ) : (
            <ul className="line-list">{orders.map(card)}</ul>
          )}
          {data.more ? <p className="home-muted">{t('order_matching.truncated')}</p> : null}
        </>
      )}
    </section>
  );
}

/** Rapprochement d'un bon, ses réceptions et ses factures, lus à la demande, chacun à part. */
function OrderDetail({
  order,
  online,
  mayReadInvoices,
}: {
  readonly order: MatchingOrder;
  readonly online: boolean;
  readonly mayReadInvoices: boolean;
}) {
  const { t } = useTranslation();
  const text = useQuantityText();
  const matching = useOnlineRead(
    `/api/v1/purchase-orders/${order.id}/matching`,
    (key) => readPath<{ readonly matching: MatchingDetail }>(key),
    online,
    '',
  );
  const receipts = useOnlineRead(
    receiptsPath(order.id),
    (key) => readPages<ReceiptItem>([key], 'receipts', MATCHING_MAX_PAGES),
    online,
    '',
  );
  const invoices = useOnlineRead(
    mayReadInvoices ? orderInvoicesPath(order.id) : null,
    (key) => readPages<SupplierInvoiceItem>([key], 'supplier_invoices', MATCHING_MAX_PAGES),
    online,
    '',
  );
  // Retour sur l'onglet : le détail ouvert se relit avec la liste.
  useRefreshOnVisible(() => {
    matching.retry();
    receipts.retry();
    invoices.retry();
  });
  const money = (value: number | null) =>
    value === null ? t('order_matching.not_available') : formatMoney(value);
  /** Section sans lecture : hors ligne, en ligne seulement ; sinon en cours. */
  const waiting = () => (
    <p className="home-muted">{t(online ? 'sales.loading' : 'order_matching.online_only')}</p>
  );
  const refreshing =
    online &&
    [matching, receipts, ...(mayReadInvoices ? [invoices] : [])].some(
      (read) => read.data !== undefined && read.stale && !read.failed,
    );
  const problem = (
    read: { readonly failed: boolean; readonly denied: boolean; readonly retry: () => void },
    failedKey: string,
    retryKey: string,
  ) =>
    read.failed ? (
      <p className="text-warn" role="alert">
        {read.denied ? t('order_matching.section_denied') : t(failedKey)}{' '}
        {read.denied ? null : (
          <button type="button" className="secondary" onClick={read.retry}>
            {t(retryKey, { doc: order.docNumber })}
          </button>
        )}
      </p>
    ) : null;
  const detail = matching.data?.matching;
  return (
    <div className="sale-block">
      {refreshing ? (
        <p className="home-muted" role="status">
          {t('order_matching.refreshing')}
        </p>
      ) : null}
      <h3>{t('order_matching.lines_title')}</h3>
      {problem(matching, 'order_matching.matching_failed', 'order_matching.retry_matching')}
      {!detail ? (
        matching.failed ? null : (
          waiting()
        )
      ) : (
        <>
          <ul className="line-list">
            {detail.lines
              .filter((line) => line.status !== 'CANCELLED')
              .map((line) => {
                const q = (value: number) => text.quantity(line.productId, value);
                const gaps = lineGaps(line);
                return (
                  <li
                    key={line.poLineId}
                    className="line-card"
                    aria-label={t('order_matching.line_label', {
                      product: text.productName(line.productId),
                    })}
                  >
                    <p>
                      <strong>{text.productName(line.productId)}</strong>
                    </p>
                    <p>
                      {t('order_matching.line_flow', {
                        ordered: q(line.orderedQtyBase),
                        delivered: q(line.deliveredQtyBase),
                        rejected: q(line.rejectedQtyBase),
                        accepted: q(line.acceptedQtyBase),
                      })}
                    </p>
                    <p className="home-muted">
                      {t('order_matching.line_rest', {
                        remaining: q(line.remainingQtyBase),
                        closed: q(line.closedQtyBase),
                        invoiced: q(line.invoicedQtyBase),
                      })}
                    </p>
                    {gaps.includes('QUARANTINED') ? (
                      <p className="text-warn">
                        {t('order_matching.line_quarantined', {
                          quantity: q(line.quarantinedQtyBase),
                        })}
                      </p>
                    ) : null}
                    {gaps.includes('EXCESS') ? (
                      <p className="text-warn">
                        {t('order_matching.line_excess', { quantity: q(line.excessQtyBase) })}
                      </p>
                    ) : null}
                    {gaps.includes('OVER_INVOICED') ? (
                      <p className="text-warn">
                        {t('order_matching.line_over_invoiced', {
                          invoiced: q(line.invoicedQtyBase),
                          accepted: q(line.acceptedQtyBase),
                        })}
                      </p>
                    ) : null}
                    {line.orderedValueXaf !== null ? (
                      <p className="home-muted">
                        {t('order_matching.line_values', {
                          ordered: money(line.orderedValueXaf),
                          accepted: money(line.acceptedValueXaf),
                          invoiced: money(line.invoicedValueXaf),
                        })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
          </ul>
          <p>
            {t('order_matching.totals', {
              ordered: money(detail.totals.orderedValueXaf),
              accepted: money(detail.totals.acceptedValueXaf),
              invoiced: money(detail.totals.invoicedValueXaf),
              paid: money(detail.totals.paidXaf),
            })}
          </p>
        </>
      )}
      <h3>{t('order_matching.receipts_title')}</h3>
      {problem(receipts, 'order_matching.receipts_failed', 'order_matching.retry_receipts')}
      {!receipts.data ? (
        receipts.failed ? null : (
          waiting()
        )
      ) : receipts.data.items.length === 0 ? (
        <p className="home-muted">{t('order_matching.no_receipt')}</p>
      ) : (
        <ul className="line-list">
          {sortReceipts(receipts.data.items).map((receipt) => (
            <li key={receipt.id} className="line-card" aria-label={receipt.docNumber}>
              <p>
                <strong>{receipt.docNumber}</strong> ·{' '}
                {t(`purchase_receipt.status.${receipt.status}`, { defaultValue: receipt.status })}
              </p>
              <p className="home-muted">
                {formatBusinessDate(businessDayOf(new Date(receipt.occurredAt)))}
                {receipt.supplierDeliveryNoteRef
                  ? ` · ${t('order_matching.delivery_note', { ref: receipt.supplierDeliveryNoteRef })}`
                  : ''}
              </p>
              <ul className="home-muted">
                {receipt.lines.map((line) => (
                  <li key={line.id}>
                    {t('order_matching.receipt_line', {
                      product: text.productName(line.productId),
                      delivered: text.quantity(line.productId, line.qtyDeliveredBase),
                      rejected: text.quantity(line.productId, line.qtyRejectedBase),
                      accepted: text.quantity(line.productId, line.qtyAcceptedBase),
                    })}
                  </li>
                ))}
              </ul>
              {receipt.cancelComment ? (
                <p className="home-muted">
                  {t('order_matching.cancel_comment', { comment: receipt.cancelComment })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {receipts.data?.more ? <p className="home-muted">{t('order_matching.truncated')}</p> : null}
      {mayReadInvoices ? (
        <>
          <h3>{t('order_matching.invoices_title')}</h3>
          {problem(invoices, 'order_matching.invoices_failed', 'order_matching.retry_invoices')}
          {!invoices.data ? (
            invoices.failed ? null : (
              waiting()
            )
          ) : invoices.data.items.length === 0 ? (
            <p className="home-muted">{t('order_matching.no_invoice')}</p>
          ) : (
            <ul className="line-list">
              {invoices.data.items.map((invoice) => (
                <li key={invoice.id} className="line-card" aria-label={invoice.docNumber}>
                  <p>
                    <strong>{invoice.docNumber}</strong> ·{' '}
                    {t(`supplier_invoice.status.${invoice.status}`, {
                      defaultValue: invoice.status,
                    })}
                  </p>
                  <p className="home-muted">
                    {t('order_matching.invoice_line', {
                      ref: invoice.supplierInvoiceRef,
                      total: formatMoney(invoice.totalXaf),
                      paid: formatMoney(invoice.paidXaf),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link to={ROUTES.supplierInvoices} className="action action-compact">
            <span className="action-label">{t('order_matching.invoices_link')}</span>
          </Link>
        </>
      ) : null}
    </div>
  );
}
