/**
 * ECR-APP-03 « Bons de commande » (responsable des achats ; action `ORDERS` ; en ligne). Liste par
 * statut avec les actions de SM-PURCHASE-ORDER (modifier un brouillon, soumettre, marquer envoyé,
 * clôturer le reliquat, annuler), et création d'un bon depuis des lignes de demandes approuvées ou
 * directement. Relu après chaque opération ; l'opération suivante attend la réponse définitive.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { settingValue } from '../sales/stock.js';
import { phaseOf, submitCommand, waitingCommands } from '../sales/submit.js';
import {
  cancelPayload,
  checkOrder,
  checkOrderLine,
  createOrderPayload,
  DEFAULT_APPROVAL_THRESHOLD_XAF,
  draftUpdate,
  MAX_ORDER_LINES,
  ORDER_STATUSES,
  orderableLines,
  orderActions,
  orderTotal,
  type DraftLineEdit,
  type OrderLineDraft,
  type OrderView,
  type RequestView,
} from './orders.js';
import { purchasableProducts, purchaseUnitsOf } from './request.js';
import type { SupplierView } from './suppliers.js';

type Section = 'LIST' | 'NEW';
type Send = (input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;

/** Lecture en ligne ; `undefined` pendant la lecture, `null` si indisponible. */
function useRead<T>(path: string | null, online: boolean, reloadKey: string): T | null | undefined {
  const [state, setState] = useState<{ path: string; data: T | null }>();
  useEffect(() => {
    if (!path || !online) return;
    let cancelled = false;
    void authorizedRequest<T>(getDb(), path, { method: 'GET' }).then((result) => {
      if (!cancelled) setState({ path, data: result.ok ? result.data : null });
    });
    return () => {
      cancelled = true;
    };
  }, [path, online, reloadKey]);
  if (!path || !online) return null;
  return state?.path === path ? state.data : undefined;
}

function OrderCard({
  order,
  refs,
  supplierName,
  send,
  blocked,
  userId,
}: {
  readonly order: OrderView;
  readonly refs: SalesReferences;
  readonly supplierName: string;
  readonly send: Send;
  readonly blocked: boolean;
  readonly userId: string;
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<'EDIT' | 'CANCEL' | 'CLOSE' | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, DraftLineEdit>>(new Map());
  const [date, setDate] = useState(order.expectedDeliveryDate ?? '');
  const [comment, setComment] = useState('');
  const [reasonId, setReasonId] = useState('');
  const ids = { date: useId(), comment: useId(), reason: useId() };
  const actions = orderActions(order.status);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationName =
    refs.locations.find((location) => location.id === order.deliveryLocationId)?.name ?? '';
  const draft = panel === 'EDIT' ? draftUpdate(order, edits, date) : null;
  const cancellationReasons = refs.reasonCodes.filter(
    (reason) => reason.category === 'CANCELLATION',
  );
  const command = (commandType: string, payload: Record<string, unknown>) =>
    void send({
      authorUserId: userId,
      commandType,
      aggregateType: 'PURCHASE_ORDER',
      aggregateId: order.id,
      payload,
    }).then((ok) => {
      if (ok) setPanel(null);
    });
  const editOf = (lineId: string, line: OrderView['lines'][number]): DraftLineEdit =>
    edits.get(lineId) ?? {
      qtyText: String(line.orderedQtyBase),
      priceText: line.unitPriceXaf === null ? '' : String(line.unitPriceXaf),
      cancel: false,
    };
  const setEdit = (
    lineId: string,
    line: OrderView['lines'][number],
    patch: Partial<DraftLineEdit>,
  ) => setEdits((current) => new Map(current).set(lineId, { ...editOf(lineId, line), ...patch }));

  return (
    <li className="line-card" aria-label={order.docNumber}>
      <div className="line-head">
        <strong>{order.docNumber}</strong>
        <span className="badge badge-info">
          {t(`orders_po.status.${order.status}`, { defaultValue: order.status })}
        </span>
      </div>
      <p className="home-muted">
        {[
          supplierName,
          locationName,
          order.expectedDeliveryDate
            ? t('orders_po.expected', { date: formatBusinessDay(order.expectedDeliveryDate) })
            : null,
          order.totalXaf !== null ? formatMoney(order.totalXaf) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <ul className="receipt-lines">
        {order.lines
          .filter((line) => line.status !== 'CANCELLED')
          .map((line) => {
            const product = products.get(line.productId);
            const unit = product?.base_unit_code ?? line.unitCode;
            return (
              <li key={line.id}>
                <span>
                  <strong>{product?.name ?? line.productId}</strong>
                  <small>
                    {t('orders_po.line_progress', {
                      ordered: formatQuantity(line.orderedQtyBase),
                      remaining: formatQuantity(line.remainingQtyBase),
                      unit,
                    })}
                  </small>
                </span>
                <span>{line.lineTotalXaf !== null ? formatMoney(line.lineTotalXaf) : ''}</span>
              </li>
            );
          })}
      </ul>
      {order.closedReason ? <p className="home-muted">{order.closedReason}</p> : null}

      {panel === null ? (
        <div className="result-actions">
          {actions.edit ? (
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => setPanel('EDIT')}
            >
              {t('orders_po.edit')}
            </button>
          ) : null}
          {actions.submit ? (
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => command('procurement.order.submit', {})}
            >
              {t('orders_po.submit')}
            </button>
          ) : null}
          {actions.markSent ? (
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => command('procurement.order.mark_sent', {})}
            >
              {t('orders_po.mark_sent')}
            </button>
          ) : null}
          {actions.closeRemaining ? (
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => setPanel('CLOSE')}
            >
              {t('orders_po.close_remaining')}
            </button>
          ) : null}
          {actions.cancel ? (
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => setPanel('CANCEL')}
            >
              {t('orders_po.cancel')}
            </button>
          ) : null}
        </div>
      ) : null}

      {panel === 'EDIT' && draft ? (
        <div className="sale-block">
          <div className="field">
            <label htmlFor={ids.date}>{t('orders_po.expected_label')}</label>
            <input
              id={ids.date}
              type="date"
              className="text-input"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          {order.lines
            .filter((line) => line.status !== 'CANCELLED')
            .map((line) => {
              const product = products.get(line.productId);
              const unit = product?.base_unit_code ?? line.unitCode;
              const edit = editOf(line.id, line);
              const name = t('orders_po.line_legend', {
                name: product?.name ?? line.productId,
                no: line.lineNo,
              });
              return (
                <fieldset key={line.id} className="choice-group" aria-label={name}>
                  <legend>{name}</legend>
                  <div className="line-fields">
                    <div className="field">
                      <label htmlFor={`qty-${line.id}`}>
                        {t('orders_po.qty_base_label', { unit })}
                      </label>
                      <input
                        id={`qty-${line.id}`}
                        className="text-input"
                        inputMode="decimal"
                        disabled={edit.cancel}
                        value={edit.qtyText}
                        onChange={(event) =>
                          setEdit(line.id, line, { qtyText: event.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`price-${line.id}`}>
                        {t('orders_po.price_label', { unit })}
                      </label>
                      <input
                        id={`price-${line.id}`}
                        className="text-input"
                        inputMode="numeric"
                        disabled={edit.cancel}
                        value={edit.priceText}
                        onChange={(event) =>
                          setEdit(line.id, line, { priceText: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={edit.cancel}
                      onChange={(event) => setEdit(line.id, line, { cancel: event.target.checked })}
                    />
                    {t('orders_po.cancel_line')}
                  </label>
                </fieldset>
              );
            })}
          {draft.issues
            .filter((issue) => issue !== 'NOTHING')
            .map((issue) => (
              <p key={issue} className="error-message">
                {t(`orders_po.edit_issue.${issue}`)}
              </p>
            ))}
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={blocked || draft.issues.length > 0}
              onClick={() => command('procurement.order.update', draft.payload)}
            >
              {t('orders_po.save')}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'CANCEL' || panel === 'CLOSE' ? (
        <div className="sale-block">
          {panel === 'CANCEL' && cancellationReasons.length > 0 ? (
            <div className="field">
              <label htmlFor={ids.reason}>{t('orders_po.cancel_reason_label')}</label>
              <select
                id={ids.reason}
                className="text-input"
                value={reasonId}
                onChange={(event) => setReasonId(event.target.value)}
              >
                <option value="">{t('orders_po.no_reason')}</option>
                {cancellationReasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={ids.comment}>
              {panel === 'CANCEL'
                ? t('orders_po.cancel_comment_label')
                : t('orders_po.close_reason_label')}
            </label>
            <textarea
              id={ids.comment}
              className="text-input"
              rows={2}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </div>
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={blocked || !comment.trim()}
              onClick={() =>
                panel === 'CANCEL'
                  ? command('procurement.order.cancel', cancelPayload(comment, reasonId))
                  : command('procurement.order.close_remaining', { reason: comment.trim() })
              }
            >
              {panel === 'CANCEL' ? t('orders_po.cancel_confirm') : t('orders_po.close_confirm')}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

const newLine = (patch: Partial<OrderLineDraft> = {}): OrderLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
  requestLineId: null,
  remainingBase: null,
  priceText: '',
  ...patch,
});

function NewOrder({
  refs,
  suppliers,
  requests,
  send,
  blocked,
  userId,
  onCreated,
}: {
  readonly refs: SalesReferences;
  readonly suppliers: readonly SupplierView[];
  readonly requests: readonly RequestView[] | null | undefined;
  readonly send: Send;
  readonly blocked: boolean;
  readonly userId: string;
  readonly onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState('');
  const [lines, setLines] = useState<readonly OrderLineDraft[]>([]);
  const [requestPick, setRequestPick] = useState('');
  const [productPick, setProductPick] = useState('');
  const ids = {
    supplier: useId(),
    location: useId(),
    date: useId(),
    request: useId(),
    product: useId(),
  };
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const activeSuppliers = suppliers
    .filter((supplier) => supplier.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const locations = refs.locations
    .filter((location) => !location.is_virtual && location.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const taken = new Set(lines.map((line) => line.requestLineId).filter(Boolean));
  const orderable = orderableLines(requests ?? []).filter((line) => !taken.has(line.requestLineId));
  const rows = lines.map((line) => {
    const product = products.get(line.productId);
    const units = product ? purchaseUnitsOf(product, refs) : [];
    const unitCode = line.unitCode || product?.base_unit_code || '';
    const draft = { ...line, unitCode };
    return {
      line: draft,
      product,
      units,
      check: checkOrderLine(
        draft,
        units.find((unit) => unit.unitCode === unitCode),
      ),
    };
  });
  const checks = rows.map((row) => row.check);
  const issues = checkOrder({
    supplierId,
    deliveryLocationId: locationId,
    expectedDeliveryDate: date,
    lines: checks,
  });
  const total = orderTotal(checks);
  const threshold = Number(
    settingValue(refs.settings, 'procurement.po_approval_threshold_xaf', null, clock.now()) ??
      DEFAULT_APPROVAL_THRESHOLD_XAF,
  );
  const ready =
    issues.length === 0 && checks.every((check) => check.issues.length === 0) && !blocked;
  const update = (key: string, patch: Partial<OrderLineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const addFromRequest = () => {
    const picked = orderable.find((line) => line.requestLineId === requestPick);
    if (!picked) return;
    setLines((current) => [
      ...current,
      newLine({
        productId: picked.productId,
        unitCode: products.get(picked.productId)?.base_unit_code ?? picked.unitCode,
        quantityText: String(picked.remainingBase),
        requestLineId: picked.requestLineId,
        remainingBase: picked.remainingBase,
        priceText:
          picked.estimatedUnitPriceXaf === null ? '' : String(picked.estimatedUnitPriceXaf),
      }),
    ]);
    setRequestPick('');
  };
  const addDirect = () => {
    if (!productPick) return;
    setLines((current) => [...current, newLine({ productId: productPick })]);
    setProductPick('');
  };
  const submit = () => {
    if (!ready) return;
    void send({
      authorUserId: userId,
      commandType: 'procurement.order.create',
      aggregateType: 'PURCHASE_ORDER',
      payload: createOrderPayload({
        supplierId,
        deliveryLocationId: locationId,
        expectedDeliveryDate: date,
        lines: checks,
      }),
    }).then((ok) => {
      if (ok) {
        setLines([]);
        onCreated();
      }
    });
  };

  return (
    <>
      <div className="field">
        <label htmlFor={ids.supplier}>{t('orders_po.supplier_label')}</label>
        <select
          id={ids.supplier}
          className="text-input"
          value={supplierId}
          onChange={(event) => setSupplierId(event.target.value)}
        >
          <option value="">{t('lot_setup.choose')}</option>
          {activeSuppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.location}>{t('orders_po.location_label')}</label>
        <select
          id={ids.location}
          className="text-input"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        >
          <option value="">{t('lot_setup.choose')}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.date}>{t('orders_po.expected_label')}</label>
        <input
          id={ids.date}
          type="date"
          className="text-input"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </div>

      <ul className="line-list">
        {rows.map(({ line, product, units, check }) => {
          const unit = product?.base_unit_code ?? '';
          const name = product?.name ?? line.productId;
          return (
            <li key={line.key} className="line-card" aria-label={name}>
              <div className="line-head">
                <strong>{name}</strong>
                {line.requestLineId ? (
                  <span className="badge badge-info">{t('orders_po.from_request')}</span>
                ) : null}
              </div>
              <div className="line-fields">
                <div className="field">
                  <label htmlFor={`new-qty-${line.key}`}>{t('sales.quantity_label')}</label>
                  <input
                    id={`new-qty-${line.key}`}
                    className="text-input"
                    inputMode="decimal"
                    value={line.quantityText}
                    onChange={(event) => update(line.key, { quantityText: event.target.value })}
                  />
                </div>
                {units.length > 1 ? (
                  <div className="field">
                    <label htmlFor={`new-unit-${line.key}`}>{t('sales.unit_label')}</label>
                    <select
                      id={`new-unit-${line.key}`}
                      className="text-input"
                      value={line.unitCode}
                      onChange={(event) => update(line.key, { unitCode: event.target.value })}
                    >
                      {units.map((candidate) => (
                        <option key={candidate.unitCode} value={candidate.unitCode}>
                          {candidate.unitCode}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="field">
                  <label htmlFor={`new-price-${line.key}`}>
                    {t('orders_po.price_label', { unit })}
                  </label>
                  <input
                    id={`new-price-${line.key}`}
                    className="text-input"
                    inputMode="numeric"
                    value={line.priceText}
                    onChange={(event) => update(line.key, { priceText: event.target.value })}
                  />
                </div>
              </div>
              {line.remainingBase !== null ? (
                <p className="home-muted">
                  {t('orders_po.remaining_request', {
                    quantity: formatQuantity(line.remainingBase),
                    unit,
                  })}
                </p>
              ) : null}
              {check.issues
                .filter((issue) => issue !== 'QUANTITY_INVALID' || line.quantityText)
                .filter((issue) => issue !== 'PRICE_INVALID' || line.priceText)
                .map((issue) => (
                  <p key={issue} className="error-message">
                    {t(`orders_po.line_issue.${issue}`)}
                  </p>
                ))}
              <button
                type="button"
                className="link-button"
                aria-label={t('orders_po.remove_line', { name })}
                onClick={() =>
                  setLines((current) => current.filter((item) => item.key !== line.key))
                }
              >
                {t('orders_po.remove')}
              </button>
            </li>
          );
        })}
      </ul>

      {lines.length < MAX_ORDER_LINES ? (
        <>
          {requests === undefined ? (
            <p className="home-muted">{t('orders_po.requests_loading')}</p>
          ) : requests === null ? (
            <p className="alert alert-error">{t('orders_po.requests_unavailable')}</p>
          ) : orderable.length > 0 ? (
            <div className="field">
              <label htmlFor={ids.request}>{t('orders_po.request_line_label')}</label>
              <select
                id={ids.request}
                className="text-input"
                value={requestPick}
                onChange={(event) => setRequestPick(event.target.value)}
              >
                <option value="">{t('lot_setup.choose')}</option>
                {orderable.map((line) => (
                  <option key={line.requestLineId} value={line.requestLineId}>
                    {t('orders_po.request_line', {
                      doc: line.requestDoc,
                      product: products.get(line.productId)?.name ?? line.productId,
                      quantity: formatQuantity(line.remainingBase),
                      unit: products.get(line.productId)?.base_unit_code ?? '',
                    })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary"
                disabled={!requestPick}
                onClick={addFromRequest}
              >
                {t('orders_po.add_request_line')}
              </button>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={ids.product}>{t('orders_po.direct_product_label')}</label>
            <select
              id={ids.product}
              className="text-input"
              value={productPick}
              onChange={(event) => setProductPick(event.target.value)}
            >
              <option value="">{t('lot_setup.choose')}</option>
              {purchasableProducts(refs.products).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" disabled={!productPick} onClick={addDirect}>
              {t('orders_po.add_direct_line')}
            </button>
          </div>
        </>
      ) : null}

      {total !== null && lines.length > 0 ? (
        <p>
          <strong>{t('orders_po.total', { total: formatMoney(total) })}</strong>
        </p>
      ) : null}
      {total !== null && total > threshold ? (
        <p className="home-muted">
          {t('orders_po.approval_hint', { threshold: formatMoney(threshold) })}
        </p>
      ) : null}
      {issues
        .filter(
          (issue) =>
            issue === 'DATE_INVALID' ||
            issue === 'TOO_MANY_LINES' ||
            issue === 'DUPLICATE_REQUEST_LINE',
        )
        .map((issue) => (
          <p key={issue} className="error-message">
            {t(`orders_po.issue.${issue}`)}
          </p>
        ))}
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('orders_po.create')}
      </button>
    </>
  );
}

export function OrdersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [section, setSection] = useState<Section>('LIST');
  const [status, setStatus] = useState('');
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const statusId = useId();
  const lastCommand = refs?.outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'procurement.order.', userId);
  const reloadKey = `${last ?? ''}:${lastCommand?.status ?? ''}|${pendingOps
    .map((command) => command.command_id)
    .join(',')}`;
  const orders = useRead<{ purchase_orders?: OrderView[] }>(
    `/api/v1/purchase-orders?limit=200${status ? `&status=${status}` : ''}`,
    online,
    reloadKey,
  );
  const suppliers = useRead<{ suppliers?: SupplierView[] }>('/api/v1/suppliers', online, reloadKey);
  const requests = useRead<{ purchase_requests?: RequestView[] }>(
    section === 'NEW' ? '/api/v1/purchase-requests?limit=200' : null,
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.purchase_orders')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const waiting =
    (last !== undefined && (lastCommand === undefined || phaseOf(lastCommand) === 'WAITING')) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || !online;
  const shownCommandId = last ?? pendingOps[pendingOps.length - 1]?.command_id;
  const supplierList = suppliers?.suppliers ?? [];
  const supplierNames = new Map(supplierList.map((supplier) => [supplier.id, supplier.name]));

  const send: Send = async (input) => {
    if (blocked) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.purchase_orders')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('orders_po.online_only')}
        </p>
      ) : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="orders_po.result" />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('orders_po.section_label')}</legend>
        {(['LIST', 'NEW'] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="orders-section"
              value={value}
              checked={section === value}
              onChange={() => setSection(value)}
            />
            {t(`orders_po.section.${value}`)}
          </label>
        ))}
      </fieldset>
      {section === 'LIST' ? (
        <section className="sale-block" aria-label={t('orders_po.section.LIST')}>
          <div className="field">
            <label htmlFor={statusId}>{t('orders_po.status_filter')}</label>
            <select
              id={statusId}
              className="text-input"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">{t('orders_po.all_statuses')}</option>
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`orders_po.status.${value}`)}
                </option>
              ))}
            </select>
          </div>
          {online && orders === undefined ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : null}
          {online && orders === null ? (
            <p className="alert alert-error">{t('orders_po.unavailable')}</p>
          ) : null}
          {orders ? (
            (orders.purchase_orders ?? []).length === 0 ? (
              <p className="home-muted">{t('orders_po.none')}</p>
            ) : (
              <ul className="line-list">
                {(orders.purchase_orders ?? []).map((order) => (
                  <OrderCard
                    key={`${order.id}:${reloadKey}`}
                    order={order}
                    refs={refs}
                    supplierName={supplierNames.get(order.supplierId) ?? ''}
                    send={send}
                    blocked={blocked}
                    userId={userId}
                  />
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : (
        <section className="sale-block" aria-label={t('orders_po.section.NEW')}>
          {suppliers === undefined ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : (
            <NewOrder
              refs={refs}
              suppliers={supplierList}
              requests={requests === undefined ? undefined : (requests?.purchase_requests ?? null)}
              send={send}
              blocked={blocked}
              userId={userId}
              onCreated={() => setSection('LIST')}
            />
          )}
        </section>
      )}
    </section>
  );
}
