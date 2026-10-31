/**
 * ECR-APP-03 « Bons de commande » (responsable des achats ; action `ORDERS` ; en ligne). Liste par
 * statut avec les actions de SM-PURCHASE-ORDER (modifier un brouillon, soumettre, marquer envoyé,
 * clôturer le reliquat, annuler), et création d'un bon depuis des lignes de demandes approuvées ou
 * directement. Relu après chaque opération ; l'opération suivante attend la réponse définitive et la
 * relecture qui la suit (listes périmées gardées à l'écran mais sans action). Un nouveau bon reste
 * saisi jusqu'à la réponse du serveur : refusé, il se corrige sans tout ressaisir.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Checkbox,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeBonCommandeFournisseur } from '../pieces/adaptateurs-achats.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { readPages, readPath, useOnlineRead, type Pages } from '../sales/online-read.js';
import { settingValue } from '../sales/stock.js';
import {
  inRepeatedFailure,
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
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
  requestRemaining,
  type DraftLineEdit,
  type OrderLineDraft,
  type OrderView,
  type RequestView,
} from './orders.js';
import { purchasableProducts, purchaseUnitsOf } from './request.js';
import type { SupplierView } from './suppliers.js';
import { orderStatusTone } from './tones.js';
import './procurement.css';

type Section = 'LIST' | 'NEW';
/** Enregistre la commande ; renvoie son identifiant, `null` si l'enregistrement local a échoué. */
type Send = (input: Parameters<typeof submitCommand>[0]) => Promise<string | null>;

/** Demandes d'achat à commander : approuvées et commandées en partie, toutes pages. */
const REQUEST_PATHS = [
  '/api/v1/purchase-requests?status=APPROVED&limit=200',
  '/api/v1/purchase-requests?status=PARTIALLY_ORDERED&limit=200',
];
const MAX_REQUEST_PAGES = 50;

function OrderCard({
  order,
  refs,
  supplierName,
  send,
  blocked,
  userId,
  remaining,
  remainingStale,
}: {
  readonly order: OrderView;
  readonly refs: SalesReferences;
  readonly supplierName: string;
  readonly send: Send;
  readonly blocked: boolean;
  readonly userId: string;
  /**
   * Reste à commander par ligne de demande (modification d'un brouillon) ; `null` tant que les
   * demandes n'ont jamais été lues.
   */
  readonly remaining: ReadonlyMap<string, number> | null;
  /** Reste à commander pas encore relu : une hausse d'une ligne tirée d'une demande attend. */
  readonly remainingStale: boolean;
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<'EDIT' | 'CANCEL' | 'CLOSE' | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, DraftLineEdit>>(new Map());
  const [date, setDate] = useState(order.expectedDeliveryDate ?? '');
  const [comment, setComment] = useState('');
  const [reasonId, setReasonId] = useState('');
  const actions = orderActions(order.status);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationName =
    refs.locations.find((location) => location.id === order.deliveryLocationId)?.name ?? '';
  const draft = panel === 'EDIT' ? draftUpdate(order, edits, date, remaining) : null;
  // Panneau ouvert sur une saisie neuve (les valeurs du bon relu, pas celles d'une saisie passée).
  const openPanel = (next: 'EDIT' | 'CANCEL' | 'CLOSE') => {
    setEdits(new Map());
    setDate(order.expectedDeliveryDate ?? '');
    setComment('');
    setReasonId('');
    setPanel(next);
  };
  // Seule une hausse d'une ligne tirée d'une demande dépend du reste à commander relu.
  const raisesRequestLine = order.lines.some((line) => {
    if (line.requestLineId === null) return false;
    const edit = edits.get(line.id);
    if (!edit || edit.cancel) return false;
    const quantity = Number(edit.qtyText.trim().replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(quantity) && quantity > line.orderedQtyBase;
  });
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
    <DataRow aria-label={order.docNumber}>
      <DataCell primary>
        <strong>{order.docNumber}</strong>
      </DataCell>
      <DataCell>
        <span className="proc-text">
          {[supplierName, locationName].filter(Boolean).join(' · ')}
        </span>
      </DataCell>
      <DataCell>
        {order.expectedDeliveryDate ? (
          <span className="proc-text">
            {t('orders_po.expected', { date: formatBusinessDay(order.expectedDeliveryDate) })}
          </span>
        ) : null}
      </DataCell>
      <DataCell numeric>{order.totalXaf !== null ? formatMoney(order.totalXaf) : null}</DataCell>
      <DataCell>
        <Badge tone={orderStatusTone(order.status)}>
          {t(`orders_po.status.${order.status}`, { defaultValue: order.status })}
        </Badge>
      </DataCell>
      <DataCell wide>
        <div className="proc-order-body">
          <ul className="proc-order-lines">
            {order.lines
              .filter((line) => line.status !== 'CANCELLED')
              .map((line) => {
                const product = products.get(line.productId);
                const unit = product?.base_unit_code ?? line.unitCode;
                return (
                  <li key={line.id}>
                    <span className="proc-name">
                      <strong>{product?.name ?? line.productId}</strong>
                      <small>
                        {t('orders_po.line_progress', {
                          ordered: formatQuantityUnit(line.orderedQtyBase, unit),
                          remaining: formatQuantityUnit(line.remainingQtyBase, unit),
                        })}
                      </small>
                    </span>
                    <span className="proc-money">
                      {line.lineTotalXaf !== null ? formatMoney(line.lineTotalXaf) : ''}
                    </span>
                  </li>
                );
              })}
          </ul>
          {order.closedReason ? <p className="muted">{order.closedReason}</p> : null}
          {/* Bon de commande fournisseur (lot PP). */}
          <PieceAction
            cle={`BC:${order.id}`}
            annulee={order.status === 'CANCELLED'}
            demande={() => demandeBonCommandeFournisseur(order, refs, supplierName || null)}
          />

          {panel === null ? (
            <div className="proc-actions">
              {actions.edit ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => openPanel('EDIT')}
                >
                  {t('orders_po.edit')}
                </Button>
              ) : null}
              {actions.submit ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => command('procurement.order.submit', {})}
                >
                  {t('orders_po.submit')}
                </Button>
              ) : null}
              {actions.markSent ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => command('procurement.order.mark_sent', {})}
                >
                  {t('orders_po.mark_sent')}
                </Button>
              ) : null}
              {actions.closeRemaining ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => openPanel('CLOSE')}
                >
                  {t('orders_po.close_remaining')}
                </Button>
              ) : null}
              {actions.cancel ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={blocked}
                  onClick={() => openPanel('CANCEL')}
                >
                  {t('orders_po.cancel')}
                </Button>
              ) : null}
            </div>
          ) : null}

          {panel === 'EDIT' && draft ? (
            <div className="proc-panel">
              <Field label={t('orders_po.expected_label')}>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </Field>
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
                    <fieldset key={line.id} className="proc-checks" aria-label={name}>
                      <legend>{name}</legend>
                      <div className="line-fields">
                        <Field label={t('orders_po.qty_base_label', { unit: unitLabel(unit) })}>
                          {(control) => (
                            <Input
                              {...control}
                              inputMode="decimal"
                              disabled={edit.cancel}
                              value={edit.qtyText}
                              onChange={(event) =>
                                setEdit(line.id, line, { qtyText: event.target.value })
                              }
                            />
                          )}
                        </Field>
                        <Field label={t('orders_po.price_label', { unit: unitLabel(unit) })}>
                          {(control) => (
                            <Input
                              {...control}
                              inputMode="numeric"
                              disabled={edit.cancel}
                              value={edit.priceText}
                              onChange={(event) =>
                                setEdit(line.id, line, { priceText: event.target.value })
                              }
                            />
                          )}
                        </Field>
                      </div>
                      <Checkbox
                        label={t('orders_po.cancel_line')}
                        checked={edit.cancel}
                        onChange={(event) =>
                          setEdit(line.id, line, { cancel: event.target.checked })
                        }
                      />
                    </fieldset>
                  );
                })}
              {draft.issues
                .filter((issue) => issue !== 'NOTHING')
                .map((issue) => (
                  <p key={issue} className="field-error">
                    {t(`orders_po.edit_issue.${issue}`)}
                  </p>
                ))}
              <div className="proc-actions">
                <Button variant="ghost" onClick={() => setPanel(null)}>
                  {t('price_rules.cancel')}
                </Button>
                <Button
                  disabled={
                    blocked || draft.issues.length > 0 || (remainingStale && raisesRequestLine)
                  }
                  onClick={() => command('procurement.order.update', draft.payload)}
                >
                  {t('orders_po.save')}
                </Button>
              </div>
            </div>
          ) : null}

          {panel === 'CANCEL' || panel === 'CLOSE' ? (
            <div className="proc-panel">
              {panel === 'CANCEL' && cancellationReasons.length > 0 ? (
                <Field label={t('orders_po.cancel_reason_label')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={reasonId}
                      onChange={(event) => setReasonId(event.target.value)}
                    >
                      <option value="">{t('orders_po.no_reason')}</option>
                      {cancellationReasons.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              <Field
                label={
                  panel === 'CANCEL'
                    ? t('orders_po.cancel_comment_label')
                    : t('orders_po.close_reason_label')
                }
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={2}
                    maxLength={2000}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                  />
                )}
              </Field>
              <div className="proc-actions">
                <Button variant="ghost" onClick={() => setPanel(null)}>
                  {t('price_rules.cancel')}
                </Button>
                <Button
                  variant={panel === 'CANCEL' ? 'danger' : 'primary'}
                  disabled={blocked || !comment.trim()}
                  onClick={() =>
                    panel === 'CANCEL'
                      ? command('procurement.order.cancel', cancelPayload(comment, reasonId))
                      : command('procurement.order.close_remaining', { reason: comment.trim() })
                  }
                >
                  {panel === 'CANCEL'
                    ? t('orders_po.cancel_confirm')
                    : t('orders_po.close_confirm')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DataCell>
    </DataRow>
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
  suppliersFailed,
  requests,
  requestsStale,
  requestsFailed,
  onRetrySuppliers,
  onRetryRequests,
  acceptedCreateId,
  retryingCreateId,
  send,
  blocked,
  userId,
}: {
  readonly refs: SalesReferences;
  readonly suppliers: readonly SupplierView[];
  /** Lecture des fournisseurs en échec : refus de droit ou panne. */
  readonly suppliersFailed: { readonly denied: boolean } | null;
  /** Demandes à commander ; `undefined` pendant la lecture, `null` si indisponibles. */
  readonly requests: readonly RequestView[] | null | undefined;
  /** Demandes pas encore relues : une ligne tirée d'une demande attend la relecture. */
  readonly requestsStale: boolean;
  /** Dernière lecture des demandes en échec (anciennes données gardées ou non). */
  readonly requestsFailed: boolean;
  readonly onRetrySuppliers: () => void;
  readonly onRetryRequests: () => void;
  /** Création acceptée par le serveur (réponse définitive). */
  readonly acceptedCreateId: string | undefined;
  /** Création renvoyée sans succès par le serveur (échec répété), toujours réessayée. */
  readonly retryingCreateId: string | undefined;
  readonly send: Send;
  readonly blocked: boolean;
  readonly userId: string;
}) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState('');
  const [lines, setLines] = useState<readonly OrderLineDraft[]>([]);
  // Création envoyée depuis cette saisie, et charge utile envoyée (comparée à la saisie courante).
  const [sent, setSent] = useState<{ readonly commandId: string; readonly payload: string }>();
  // Création en échec répété et contenu envoyé : la saisie reste (à corriger si le bon est refusé),
  // mais elle ne se renvoie pas telle quelle tant qu'il est réessayé (second bon).
  const [retrying, setRetrying] = useState<{
    readonly commandId: string;
    readonly payload: string;
  }>();
  const [requestPick, setRequestPick] = useState('');
  const [productPick, setProductPick] = useState('');
  // Messages reliés au bouton de création (`aria-describedby`).
  const ids = { requestsWait: useId(), retrying: useId() };
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const activeSuppliers = suppliers
    .filter((supplier) => supplier.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  // Emplacements physiques actifs d'un site actif (le serveur refuse un site fermé).
  const locations = refs.locations
    .filter(
      (location) =>
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        refs.sites.get(location.site_id ?? '')?.status === 'ACTIVE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const purchasable = purchasableProducts(refs.products);
  const purchasableIds = new Set(purchasable.map((product) => product.id));
  const taken = new Set(lines.map((line) => line.requestLineId).filter(Boolean));
  const remainingByLine = requests ? requestRemaining(requests) : null;
  // Lignes de demande d'un produit encore achetable seulement (sinon tout le bon serait refusé).
  const orderable = orderableLines(requests ?? []).filter(
    (line) => !taken.has(line.requestLineId) && purchasableIds.has(line.productId),
  );
  const rows = lines.map((line) => {
    const product = products.get(line.productId);
    const units = product ? purchaseUnitsOf(product, refs) : [];
    const unitCode = line.unitCode || product?.base_unit_code || '';
    // Reste à commander relu à chaque affichage (une autre commande a pu en prendre).
    const remainingBase =
      line.requestLineId !== null && remainingByLine
        ? (remainingByLine.get(line.requestLineId) ?? 0)
        : line.remainingBase;
    const draft = { ...line, unitCode, remainingBase };
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
  const linesValid = checks.every((check) => check.issues.length === 0);
  // Montant hors des entiers sûrs : le serveur refuserait le bon.
  const amountTooLarge = lines.length > 0 && linesValid && total === null;
  const threshold = Number(
    settingValue(refs.settings, 'procurement.po_approval_threshold_xaf', null, clock.now()) ??
      DEFAULT_APPROVAL_THRESHOLD_XAF,
  );
  const fromRequest = lines.some((line) => line.requestLineId !== null);
  const payload = createOrderPayload({
    supplierId,
    deliveryLocationId: locationId,
    expectedDeliveryDate: date,
    lines: checks,
  });
  const stillRetrying = retrying !== undefined && retrying.commandId === retryingCreateId;
  const sameAsRetrying = stillRetrying && JSON.stringify(payload) === retrying.payload;
  const requestsRefreshing = requests !== undefined && requests !== null && requestsStale;
  const ready =
    issues.length === 0 &&
    linesValid &&
    total !== null &&
    !blocked &&
    !sameAsRetrying &&
    !(requestsStale && fromRequest);
  const clear = () => {
    setSupplierId('');
    setLocationId('');
    setDate('');
    setLines([]);
  };
  // Bon accepté : la saisie se vide si elle est toujours celle qui a été envoyée (sinon l'utilisateur
  // l'a reprise : elle reste). Bon en échec répété : la saisie reste, pour la corriger s'il est
  // finalement refusé, mais ne se renvoie pas telle quelle ; acceptée plus tard, elle se vide de même.
  if (sent && acceptedCreateId === sent.commandId) {
    setSent(undefined);
    if (JSON.stringify(payload) === sent.payload) clear();
  } else if (sent && retryingCreateId === sent.commandId) {
    setSent(undefined);
    setRetrying(sent);
  } else if (retrying && acceptedCreateId === retrying.commandId) {
    setRetrying(undefined);
    if (JSON.stringify(payload) === retrying.payload) clear();
  }
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
  // La saisie reste jusqu'à la réponse du serveur (refusé, le bon se corrige sans tout ressaisir).
  const submit = () => {
    if (!ready) return;
    void send({
      authorUserId: userId,
      commandType: 'procurement.order.create',
      aggregateType: 'PURCHASE_ORDER',
      payload,
    }).then((commandId) => {
      if (commandId) setSent({ commandId, payload: JSON.stringify(payload) });
    });
  };

  return (
    <div className="proc-form">
      {suppliersFailed ? (
        <Banner
          tone="bad"
          action={
            suppliersFailed.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={onRetrySuppliers}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {suppliersFailed.denied
            ? t('orders_po.suppliers_denied')
            : t('orders_po.suppliers_unavailable')}
        </Banner>
      ) : null}
      {stillRetrying ? (
        <div id={ids.retrying}>
          <Banner tone="warn" role="status">
            {t('orders_po.create_retrying')}
          </Banner>
        </div>
      ) : null}
      <div className="proc-pair">
        <Field label={t('orders_po.supplier_label')}>
          {(control) => (
            <Select
              {...control}
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">{t('lot_setup.choose')}</option>
              {activeSuppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('orders_po.location_label')}>
          {(control) => (
            <Select
              {...control}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              <option value="">{t('lot_setup.choose')}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label={t('orders_po.expected_label')}>
        {(control) => (
          <Input
            {...control}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        )}
      </Field>

      <ul className="line-list">
        {rows.map(({ line, product, units, check }) => {
          const unit = product?.base_unit_code ?? '';
          const name = product?.name ?? line.productId;
          return (
            <li key={line.key} className="line-card" aria-label={name}>
              <div className="proc-line">
                <div className="line-head">
                  <strong>{name}</strong>
                  {line.requestLineId ? (
                    <Badge tone="info">{t('orders_po.from_request')}</Badge>
                  ) : null}
                </div>
                <div className="line-fields">
                  <Field label={t('sales.quantity_label')}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        value={line.quantityText}
                        onChange={(event) => update(line.key, { quantityText: event.target.value })}
                      />
                    )}
                  </Field>
                  {units.length > 1 ? (
                    <Field label={t('sales.unit_label')}>
                      {(control) => (
                        <Select
                          {...control}
                          value={line.unitCode}
                          onChange={(event) => update(line.key, { unitCode: event.target.value })}
                        >
                          {units.map((candidate) => (
                            <option key={candidate.unitCode} value={candidate.unitCode}>
                              {unitLabel(candidate.unitCode)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ) : null}
                  <Field label={t('orders_po.price_label', { unit: unitLabel(unit) })}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="numeric"
                        value={line.priceText}
                        onChange={(event) => update(line.key, { priceText: event.target.value })}
                      />
                    )}
                  </Field>
                </div>
                {line.remainingBase !== null ? (
                  <p className="muted">
                    {t('orders_po.remaining_request', {
                      quantity: formatQuantity(line.remainingBase),
                      unit: unitLabel(unit, line.remainingBase),
                    })}
                  </p>
                ) : null}
                {check.issues
                  .filter((issue) => issue !== 'QUANTITY_INVALID' || line.quantityText)
                  .filter((issue) => issue !== 'PRICE_INVALID' || line.priceText)
                  .map((issue) => (
                    <p key={issue} className="field-error">
                      {t(`orders_po.line_issue.${issue}`)}
                    </p>
                  ))}
                <div className="proc-line-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    aria-label={t('orders_po.remove_line', { name })}
                    onClick={() =>
                      setLines((current) => current.filter((item) => item.key !== line.key))
                    }
                  >
                    {t('orders_po.remove')}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {requestsRefreshing && !requestsFailed ? (
        <p id={ids.requestsWait} className="muted" role="status">
          {t('orders_po.requests_refreshing')}
        </p>
      ) : null}
      {lines.length < MAX_ORDER_LINES ? (
        <>
          {requestsFailed ? (
            <Banner
              tone="bad"
              action={
                <Button variant="outline" size="sm" onClick={onRetryRequests}>
                  {t('ledger.retry')}
                </Button>
              }
            >
              {requests
                ? t('orders_po.requests_stale_failed')
                : t('orders_po.requests_unavailable')}
            </Banner>
          ) : null}
          {requests === undefined ? (
            <p className="muted">{t('orders_po.requests_loading')}</p>
          ) : requests === null ? null : orderable.length > 0 ? (
            <div className="proc-add">
              <Field label={t('orders_po.request_line_label')}>
                {(control) => (
                  <Select
                    {...control}
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
                          unit: unitLabel(
                            products.get(line.productId)?.base_unit_code ?? '',
                            line.remainingBase,
                          ),
                        })}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button
                variant="outline"
                disabled={!requestPick || requestsStale}
                aria-describedby={
                  requestsRefreshing && !requestsFailed ? ids.requestsWait : undefined
                }
                onClick={addFromRequest}
              >
                {t('orders_po.add_request_line')}
              </Button>
            </div>
          ) : null}
          <div className="proc-add">
            <Field label={t('orders_po.direct_product_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={productPick}
                  onChange={(event) => setProductPick(event.target.value)}
                >
                  <option value="">{t('lot_setup.choose')}</option>
                  {purchasable.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="outline" disabled={!productPick} onClick={addDirect}>
              {t('orders_po.add_direct_line')}
            </Button>
          </div>
        </>
      ) : null}

      {total !== null && lines.length > 0 ? (
        <p className="proc-total">
          <strong>{t('orders_po.total', { total: formatMoney(total) })}</strong>
        </p>
      ) : null}
      {total !== null && total > threshold ? (
        <p className="muted">
          {t('orders_po.approval_hint', { threshold: formatMoney(threshold) })}
        </p>
      ) : null}
      {amountTooLarge ? (
        <p className="field-error">{t('orders_po.issue.AMOUNT_TOO_LARGE')}</p>
      ) : null}
      {issues
        .filter(
          (issue) =>
            issue === 'DATE_INVALID' ||
            issue === 'TOO_MANY_LINES' ||
            issue === 'DUPLICATE_REQUEST_LINE',
        )
        .map((issue) => (
          <p key={issue} className="field-error">
            {t(`orders_po.issue.${issue}`)}
          </p>
        ))}
      <ActionBar
        summary={
          <>
            <span className="action-bar-label">{t('orders_po.summary_total')}</span>
            <strong className="action-bar-value">{formatMoney(total ?? 0)}</strong>
          </>
        }
      >
        <Button
          size="lg"
          className="submit-sale"
          disabled={!ready}
          aria-describedby={
            [
              sameAsRetrying ? ids.retrying : null,
              requestsRefreshing && !requestsFailed && fromRequest ? ids.requestsWait : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onClick={submit}
        >
          {t('orders_po.create')}
        </Button>
      </ActionBar>
    </div>
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
  const [ordersPages, setOrdersPages] = useState(1);
  const [handledCreate, setHandledCreate] = useState<string>();
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const lastCommand = refs?.outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'procurement.order.', userId);
  // Clé de relecture sur la phase (pas le statut brut, qui passe par SYNCING à chaque cycle).
  // Toutes les opérations encore en attente, échec répété compris (leur réponse tardive relit aussi).
  const reloadKey = `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(
    refs?.outbox ?? [],
    'procurement.order.',
    userId,
  )}`;
  const ordersPath = `/api/v1/purchase-orders?limit=200${status ? `&status=${status}` : ''}`;
  const orders = useOnlineRead<Pages<OrderView>>(
    `${ordersPath}#${ordersPages}`,
    () => readPages<OrderView>([ordersPath], 'purchase_orders', ordersPages),
    online,
    reloadKey,
  );
  const suppliers = useOnlineRead<{ suppliers?: SupplierView[] }>(
    '/api/v1/suppliers',
    readPath,
    online,
    reloadKey,
  );
  // Demandes lues dans les deux rubriques : le reste à commander borne aussi un brouillon modifié.
  const requests = useOnlineRead<Pages<RequestView>>(
    REQUEST_PATHS.join('|'),
    () => readPages<RequestView>(REQUEST_PATHS, 'purchase_requests', MAX_REQUEST_PAGES),
    online,
    reloadKey,
  );
  // Bon créé dans cette visite (réponse définitive acceptée) : retour à la liste ; la saisie se vide
  // d'elle-même si elle est encore celle qui a été envoyée.
  const isCreate = lastCommand?.command_type === 'procurement.order.create';
  const created =
    isCreate && (phaseOf(lastCommand) === 'DONE' || phaseOf(lastCommand) === 'WARNING');
  if (created && last !== handledCreate) {
    // Ajustement pendant le rendu (une seule fois par bon créé), sans effet en cascade.
    setHandledCreate(last);
    setSection('LIST');
  }
  const acceptedCreateId = created ? last : undefined;
  const retryingCreateId = isCreate && inRepeatedFailure(lastCommand) ? last : undefined;
  // Création en échec répété : sa saisie est déjà vidée ; son acceptation tardive ne change plus de
  // rubrique (l'utilisateur a pu commencer un autre bon), le résultat l'annonce.
  if (retryingCreateId && retryingCreateId !== handledCreate) setHandledCreate(retryingCreateId);

  if (!refs || !userId) {
    return (
      <section className="sale proc-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.purchase_orders')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const waiting =
    (last !== undefined &&
      (lastCommand === undefined || isBlockingWait(lastCommand, refs.outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || !online;
  // Retour sur l'écran : la dernière opération encore en attente redevient « la dernière », pour que
  // son résultat (refus compris) reste affiché jusqu'à la réponse.
  const adopt = last ? undefined : lastWaitingCommand(refs.outbox, 'procurement.order.', userId);
  if (adopt) {
    setLast(adopt.command_id);
    // Création d'une visite précédente : sa réponse ne touche ni la rubrique ni la saisie.
    if (adopt.command_type === 'procurement.order.create') setHandledCreate(adopt.command_id);
  }
  const shownCommandId = last;
  const shownCommand = refs.outbox.find((command) => command.command_id === shownCommandId);
  const supplierList = suppliers.data?.suppliers ?? [];
  const supplierNames = new Map(supplierList.map((supplier) => [supplier.id, supplier.name]));
  const remaining = requests.data ? requestRemaining(requests.data.items) : null;
  // Actions d'un bon sur une liste relue seulement.
  const cardBlocked = blocked || orders.stale;

  const send: Send = async (input) => {
    if (blocked) return null;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      return command.command_id;
    } catch {
      setSaveError(true);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale proc-screen">
      <PageHeader title={t('nav.screens.purchase_orders')} />
      {!online ? <Banner tone="bad">{t('orders_po.online_only')}</Banner> : null}
      {shownCommandId ? (
        <CommandResult
          commandId={shownCommandId}
          messages={
            shownCommand?.command_type === 'procurement.order.create'
              ? 'orders_po.result_create'
              : 'orders_po.result'
          }
        />
      ) : null}
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      <Segmented
        label={t('orders_po.section_label')}
        value={section}
        onChange={setSection}
        options={(['LIST', 'NEW'] as const).map((value) => ({
          value,
          label: t(`orders_po.section.${value}`),
        }))}
        className="proc-sections"
      />
      <section
        className="proc-section"
        aria-label={t('orders_po.section.LIST')}
        hidden={section !== 'LIST'}
      >
        {/* La rubrique masquée reste montée : une saisie en cours n'est jamais perdue. */}
        <>
          <div className="filter-bar">
            <Field label={t('orders_po.status_filter')}>
              {(control) => (
                <Select
                  {...control}
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setOrdersPages(1);
                  }}
                >
                  <option value="">{t('orders_po.all_statuses')}</option>
                  {ORDER_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {t(`orders_po.status.${value}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {online && orders.data === undefined && !orders.failed ? <SkeletonRows rows={3} /> : null}
          {online && orders.failed ? (
            <Banner
              tone="bad"
              action={
                orders.denied ? undefined : (
                  <Button variant="outline" size="sm" onClick={orders.retry}>
                    {t('ledger.retry')}
                  </Button>
                )
              }
            >
              {orders.denied ? t('orders_po.denied') : t('orders_po.unavailable')}
            </Banner>
          ) : null}
          {online && orders.data && orders.stale && !orders.failed ? (
            <p className="muted" role="status">
              {t('orders_po.refreshing')}
            </p>
          ) : null}
          {online && requests.failed ? (
            <Banner
              tone="bad"
              action={
                <Button variant="outline" size="sm" onClick={requests.retry}>
                  {t('ledger.retry')}
                </Button>
              }
            >
              {t('orders_po.requests_unavailable_list')}
            </Banner>
          ) : null}
          {orders.data ? (
            orders.data.items.length === 0 ? (
              <EmptyState icon="clipboard" title={t('orders_po.none')} />
            ) : (
              <DataList
                aria-label={t('orders_po.section.LIST')}
                columns={[
                  { label: t('orders_po.col.order') },
                  { label: t('orders_po.col.supplier') },
                  { label: t('orders_po.col.delivery') },
                  { label: t('orders_po.col.total'), numeric: true },
                  { label: t('orders_po.col.status') },
                ]}
                template="minmax(13rem, 1.6fr) minmax(0, 2.4fr) minmax(0, 2fr) 9rem 9rem"
              >
                {orders.data.items.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    refs={refs}
                    supplierName={supplierNames.get(order.supplierId) ?? ''}
                    send={send}
                    blocked={cardBlocked}
                    userId={userId}
                    remaining={remaining}
                    remainingStale={requests.stale}
                  />
                ))}
              </DataList>
            )
          ) : null}
          {orders.data?.more ? (
            <div className="proc-more">
              <p className="muted">{t('orders_po.truncated')}</p>
              <Button
                variant="outline"
                disabled={orders.stale}
                onClick={() => setOrdersPages((value) => value + 1)}
              >
                {t('orders_po.older')}
              </Button>
            </div>
          ) : null}
        </>
      </section>
      <section
        className="proc-section"
        aria-label={t('orders_po.section.NEW')}
        hidden={section !== 'NEW'}
      >
        {suppliers.data === undefined && !suppliers.failed ? (
          <SkeletonRows rows={3} />
        ) : (
          <NewOrder
            refs={refs}
            suppliers={supplierList}
            suppliersFailed={suppliers.failed ? { denied: suppliers.denied } : null}
            requests={requests.data ? requests.data.items : requests.failed ? null : undefined}
            requestsStale={requests.stale}
            requestsFailed={requests.failed}
            onRetrySuppliers={suppliers.retry}
            onRetryRequests={requests.retry}
            acceptedCreateId={acceptedCreateId}
            retryingCreateId={retryingCreateId}
            send={send}
            blocked={blocked || (suppliers.stale && !suppliers.failed)}
            userId={userId}
          />
        )}
      </section>
    </section>
  );
}
