/**
 * Saisie d'une facture fournisseur (ECR-FIN-03, P8E-05 ; ADR-043 §2, ADR-047 §4 ; Finance, en ligne) :
 * fournisseur, bon de commande facultatif (lignes proposées depuis son rapprochement : accepté non
 * facturé, prix du bon, en unité de base du produit), référence, dates, lignes (montant calculé ou lu
 * sur la facture papier), total imprimé, commentaire, photo de la facture citée par l'enregistrement.
 * Aperçu indicatif du rapprochement par la règle partagée, doublon de référence contrôlé sur les
 * factures lues ; le serveur tranche. Hors ligne, le brouillon reste à l'écran, l'envoi attend le réseau.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  ActionBar,
  Banner,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from '../../components/ui/index.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { photoAttachment } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { PhotoField } from '../attachments/PhotoField.js';
import { formatBusinessDate } from '../home/format-home.js';
import type { OrderView } from '../procurement/orders.js';
import type { SupplierView } from '../procurement/suppliers.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, unitLabel } from '../sales/format.js';
import { readPages, readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { saveErrorKey, submitCommand, useOutboxCommand } from '../sales/submit.js';
import { mismatchText } from './invoice-format.js';
import './finance.css';
import {
  duplicateInvoice,
  emptyInvoiceDraft,
  freeLine,
  INVOICE_MAX_PAGES,
  INVOICE_PAGE_LIMIT,
  invoiceIssues,
  invoicePreview,
  invoiceRecordPayload,
  linesFromMatching,
  MAX_INVOICE_COMMENT,
  MAX_INVOICE_LINE_DESCRIPTION,
  MAX_INVOICE_LINES,
  MAX_INVOICE_REF,
  parseInvoiceLine,
  type InvoiceDraft,
  type InvoiceLineDraft,
  type OrderMatchingItem,
  type SupplierInvoiceItem,
} from './supplier-invoice.js';

/** Bons d'un fournisseur qu'une facture peut viser : envoyés, reçus en partie ou en tout, clos. */
const INVOICEABLE_ORDERS = new Set(['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']);

export function InvoiceForm({
  userId,
  suppliers,
  online,
  reloadKey,
}: {
  readonly userId: string;
  readonly suppliers: readonly SupplierView[];
  readonly online: boolean;
  /**
   * Réponses des opérations sur les factures (écran) : bons, rapprochement et factures relus ; la
   * réponse d'un enregistrement relit le rapprochement avant la saisie suivante sur le même bon.
   */
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const today = businessDayOf(clock.now());
  const [draft, setDraft] = useState<InvoiceDraft>(() => emptyInvoiceDraft(today));
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string>();
  const [freeCount, setFreeCount] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const supplierRef = useRef<HTMLSelectElement>(null);
  const addLineRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'title' | 'supplier' | 'add' | null>(null);
  // Focus demandé par une action, posé quand son élément est rendu : les effets du rendu précédent
  // passent avant ceux de l'action (« Nouvelle facture » : le champ n'existe pas encore).
  useEffect(() => {
    const target = focusNext.current;
    const element =
      target === 'title'
        ? titleRef.current
        : target === 'supplier'
          ? supplierRef.current
          : target === 'add'
            ? addLineRef.current
            : null;
    if (!element) return;
    focusNext.current = null;
    element.focus();
  });
  const supplierId = draft.supplierId;
  // Bons du fournisseur et ses factures (doublon de référence), lus au choix du fournisseur ; la
  // dernière lecture reste affichée hors ligne (périmée : l'envoi attend le réseau).
  const orders = useOnlineRead(
    supplierId
      ? `/api/v1/purchase-orders?supplier_id=${supplierId}&limit=${INVOICE_PAGE_LIMIT}`
      : null,
    (key) => readPages<OrderView>([key], 'purchase_orders', INVOICE_MAX_PAGES),
    online,
    reloadKey,
  );
  const invoices = useOnlineRead(
    supplierId
      ? `/api/v1/supplier-invoices?supplier_id=${supplierId}&limit=${INVOICE_PAGE_LIMIT}`
      : null,
    (key) => readPages<SupplierInvoiceItem>([key], 'supplier_invoices', INVOICE_MAX_PAGES),
    online,
    reloadKey,
  );
  const matching = useOnlineRead(
    draft.purchaseOrderId ? `/api/v1/purchase-orders/${draft.purchaseOrderId}/matching` : null,
    (key) => readPath<{ readonly matching: OrderMatchingItem }>(key),
    online,
    reloadKey,
  );

  if (submitted) {
    return (
      <section className="section" aria-labelledby="invoice-new-title">
        <div className="section-head">
          <h2 id="invoice-new-title" ref={titleRef} tabIndex={-1}>
            {t('supplier_invoice.new_title')}
          </h2>
        </div>
        <CommandResult commandId={submitted} messages="supplier_invoice.record_result">
          <Button
            variant="tonal"
            size="sm"
            onClick={() => {
              setDraft(emptyInvoiceDraft(today));
              setPhoto(null);
              setSubmitted(undefined);
              focusNext.current = 'supplier';
            }}
          >
            {t('supplier_invoice.another')}
          </Button>
        </CommandResult>
        <RecordStatus commandId={submitted} />
      </section>
    );
  }

  const supplier = suppliers.find((candidate) => candidate.id === supplierId);
  const activeSuppliers = suppliers
    .filter((candidate) => candidate.status === 'ACTIVE' || candidate.id === supplierId)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const supplierOrders = (orders.data?.items ?? [])
    .filter((order) => INVOICEABLE_ORDERS.has(order.status))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const orderMatching = draft.purchaseOrderId ? (matching.data?.matching ?? null) : null;
  const productOf = (productId: string | null) =>
    refs?.products.find((product) => product.id === productId);
  const lineLabel = (poLineId: string) => {
    const line = orderMatching?.lines.find((candidate) => candidate.poLineId === poLineId);
    return line ? (productOf(line.productId)?.name ?? null) : null;
  };
  const update = (patch: Partial<InvoiceDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateLine = (key: string, patch: Partial<InvoiceLineDraft>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  const chooseOrder = (orderId: string) => {
    update({ purchaseOrderId: orderId, lines: [] });
  };
  // Lignes du bon proposées une fois son rapprochement relu (une seule fois par bon choisi) : un
  // rapprochement périmé proposerait le reliquat d'avant la facture précédente.
  if (
    orderMatching &&
    !matching.stale &&
    orderMatching.orderId === draft.purchaseOrderId &&
    !draft.lines.some((line) => line.poLineId !== null)
  ) {
    const proposed = linesFromMatching(
      orderMatching,
      (line) => productOf(line.productId)?.name ?? t('supplier_invoice.line_default'),
      (line) => productOf(line.productId)?.base_unit_code ?? null,
    );
    if (proposed.length > 0)
      setDraft((current) => ({ ...current, lines: [...proposed, ...current.lines] }));
  }

  const loadedInvoices = invoices.data?.items ?? [];
  const duplicate = duplicateInvoice(draft.supplierInvoiceRef, supplierId, loadedInvoices);
  const issues = invoiceIssues(draft, loadedInvoices);
  const preview = invoicePreview({
    draft,
    matching: orderMatching,
    paymentTermsDays: supplier?.paymentTermsDays ?? null,
  });
  const readFailed =
    (supplierId !== '' && (orders.failed || invoices.failed)) ||
    (draft.purchaseOrderId !== '' && matching.failed);
  const waitingReads =
    (supplierId !== '' && (orders.stale || invoices.stale)) ||
    (draft.purchaseOrderId !== '' && matching.stale);
  const ready =
    online &&
    issues.length === 0 &&
    preview.errorCode === null &&
    !waitingReads &&
    !preparing &&
    !busy;
  const touched = supplierId !== '' || draft.supplierInvoiceRef !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'finance.supplier_invoice.record',
        aggregateType: 'SUPPLIER_INVOICE',
        aggregateId: idGenerator.newId(),
        // Photo de la facture citée par l'enregistrement (ADR-047 §3).
        ...(photo
          ? {
              attachments: [
                photoAttachment(photo, {
                  kind: 'INVOICE',
                  ownerType: 'SUPPLIER_INVOICE',
                  cited: true,
                }),
              ],
            }
          : {}),
        payload: invoiceRecordPayload(draft),
      });
      focusNext.current = 'title';
      setSubmitted(command.command_id);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  /** Échec d'une lecture du formulaire : refus de droit sans relance, panne avec relance. */
  const readProblem = (
    read: { readonly failed: boolean; readonly denied: boolean; readonly retry: () => void },
    failedKey: string,
    retryKey: string,
  ) =>
    read.failed ? (
      <Banner
        tone="warn"
        role="status"
        action={
          read.denied ? undefined : (
            <Button variant="outline" size="sm" onClick={read.retry}>
              {t(retryKey)}
            </Button>
          )
        }
      >
        {read.denied ? t('supplier_invoice.form_denied') : t(failedKey)}
      </Banner>
    ) : null;

  return (
    <section className="section" aria-labelledby="invoice-new-title">
      <div className="section-head">
        <h2 id="invoice-new-title" ref={titleRef} tabIndex={-1}>
          {t('supplier_invoice.new_title')}
        </h2>
      </div>
      {online ? null : (
        <Banner tone="warn" role="status">
          {t('supplier_invoice.form_offline')}
        </Banner>
      )}
      <Card padded className="fin-form">
        <Field label={t('supplier_invoice.supplier_label')}>
          {(control) => (
            <select
              {...control}
              ref={supplierRef}
              className="select"
              value={supplierId}
              onChange={(event) =>
                update({ supplierId: event.target.value, purchaseOrderId: '', lines: [] })
              }
            >
              <option value="">{t('supplier_invoice.supplier_placeholder')}</option>
              {activeSuppliers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {supplierId
          ? readProblem(
              invoices,
              'supplier_invoice.invoices_failed',
              'supplier_invoice.retry_invoices',
            )
          : null}
        {supplierId ? (
          <>
            <Field label={t('supplier_invoice.order_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={draft.purchaseOrderId}
                  onChange={(event) => chooseOrder(event.target.value)}
                >
                  <option value="">{t('supplier_invoice.without_order')}</option>
                  {supplierOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {t('supplier_invoice.order_option', {
                        doc: order.docNumber,
                        status: t(`orders_po.status.${order.status}`, {
                          defaultValue: order.status,
                        }),
                      })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {readProblem(orders, 'supplier_invoice.orders_failed', 'supplier_invoice.retry_orders')}
            {draft.purchaseOrderId
              ? readProblem(
                  matching,
                  'supplier_invoice.matching_failed',
                  'supplier_invoice.retry_matching',
                )
              : null}
          </>
        ) : null}
        <Field
          label={t('supplier_invoice.ref_label')}
          error={
            duplicate ? t('supplier_invoice.duplicate', { doc: duplicate.docNumber }) : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_INVOICE_REF}
              value={draft.supplierInvoiceRef}
              onChange={(event) => update({ supplierInvoiceRef: event.target.value })}
            />
          )}
        </Field>
        <div className="fin-fields">
          <Field label={t('supplier_invoice.date_label')}>
            {(control) => (
              <Input
                {...control}
                type="date"
                value={draft.invoiceDate}
                onChange={(event) => update({ invoiceDate: event.target.value })}
              />
            )}
          </Field>
          <Field
            label={t('supplier_invoice.due_label')}
            hint={
              !draft.dueDate && supplier && preview.dueDate
                ? supplier.paymentTermsDays === null
                  ? t('supplier_invoice.due_default_none', {
                      date: formatBusinessDate(preview.dueDate),
                    })
                  : t('supplier_invoice.due_default', {
                      date: formatBusinessDate(preview.dueDate),
                      count: supplier.paymentTermsDays,
                    })
                : undefined
            }
          >
            {(control) => (
              <Input
                {...control}
                type="date"
                value={draft.dueDate}
                onChange={(event) => update({ dueDate: event.target.value })}
              />
            )}
          </Field>
        </div>
        <fieldset className="field fin-lines">
          <legend>{t('supplier_invoice.lines_legend')}</legend>
          {draft.lines.length === 0 ? (
            <p className="home-muted">
              {draft.purchaseOrderId && !orderMatching && !matching.failed
                ? t('sales.loading')
                : t('supplier_invoice.no_line')}
            </p>
          ) : (
            <ol className="line-list">
              {draft.lines.map((line, index) => {
                const parsed = parseInvoiceLine(line);
                // Unité de base du produit : celle de la quantité proposée, saisie et envoyée.
                const unit = line.unitCode
                  ? unitLabel(line.unitCode, parsed.quantity ?? 0, refs?.units)
                  : null;
                const priceUnit = line.unitCode ? unitLabel(line.unitCode, 1, refs?.units) : null;
                const label = t('supplier_invoice.line_label', { rank: index + 1 });
                return (
                  <li key={line.key} className="line-card" aria-label={label}>
                    <Field label={t('supplier_invoice.line_description', { rank: index + 1 })}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={MAX_INVOICE_LINE_DESCRIPTION}
                          value={line.description}
                          onChange={(event) =>
                            updateLine(line.key, { description: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <div className="line-fields">
                      <Field
                        label={
                          unit
                            ? t('supplier_invoice.line_quantity_unit', { rank: index + 1, unit })
                            : t('supplier_invoice.line_quantity', { rank: index + 1 })
                        }
                      >
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="decimal"
                            value={line.quantityText}
                            onChange={(event) =>
                              updateLine(line.key, { quantityText: event.target.value })
                            }
                          />
                        )}
                      </Field>
                      <Field
                        label={
                          priceUnit
                            ? t('supplier_invoice.line_price_unit', {
                                rank: index + 1,
                                unit: priceUnit,
                              })
                            : t('supplier_invoice.line_price', { rank: index + 1 })
                        }
                      >
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="numeric"
                            value={line.unitPriceText}
                            onChange={(event) =>
                              updateLine(line.key, { unitPriceText: event.target.value })
                            }
                          />
                        )}
                      </Field>
                      <Field label={t('supplier_invoice.line_total', { rank: index + 1 })}>
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="numeric"
                            placeholder={
                              parsed.computedXaf === null ? '' : String(parsed.computedXaf)
                            }
                            value={line.totalText}
                            onChange={(event) =>
                              updateLine(line.key, { totalText: event.target.value })
                            }
                          />
                        )}
                      </Field>
                    </div>
                    <p className="home-muted">
                      {parsed.empty
                        ? t('supplier_invoice.line_skipped')
                        : parsed.totalXaf === null
                          ? t('supplier_invoice.line_incomplete')
                          : t('supplier_invoice.line_amount', {
                              amount: formatMoney(parsed.totalXaf),
                            })}
                    </p>
                    {line.poLineId === null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        onClick={() => {
                          focusNext.current = 'add';
                          setDraft((current) => ({
                            ...current,
                            lines: current.lines.filter((candidate) => candidate.key !== line.key),
                          }));
                        }}
                      >
                        {t('supplier_invoice.line_remove', { rank: index + 1 })}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          <Button
            variant="tonal"
            icon="plus"
            ref={addLineRef}
            disabled={draft.lines.length >= MAX_INVOICE_LINES}
            onClick={() => {
              setFreeCount((count) => count + 1);
              setDraft((current) => ({
                ...current,
                lines: [...current.lines, freeLine(`free:${freeCount + 1}`)],
              }));
            }}
          >
            {t('supplier_invoice.line_add')}
          </Button>
        </fieldset>
        <div className="fin-fields">
          <Field label={t('supplier_invoice.printed_label')}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={draft.printedTotalText}
                onChange={(event) => update({ printedTotalText: event.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label={t('supplier_invoice.comment_label')}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={MAX_INVOICE_COMMENT}
              value={draft.comment}
              onChange={(event) => update({ comment: event.target.value })}
            />
          )}
        </Field>
        <PhotoField
          label={t('supplier_invoice.photo_label')}
          value={photo}
          onChange={setPhoto}
          onBusyChange={setPreparing}
        />
      </Card>
      {preview.errorCode ? (
        <Banner tone="bad" role="alert">
          {t(`supplier_invoice.preview_error.${preview.errorCode}`, {
            defaultValue: t('supplier_invoice.preview_error.INVOICE_LINE_INVALID'),
          })}
        </Banner>
      ) : preview.match ? (
        <Banner tone={preview.match.conforming ? 'ok' : 'warn'} role="status">
          <p>
            {preview.match.conforming
              ? t('supplier_invoice.preview_conforming', {
                  total: formatMoney(preview.match.totalXaf as number),
                })
              : t('supplier_invoice.preview_mismatch', {
                  total: formatMoney(preview.match.totalXaf as number),
                })}
          </p>
          {preview.match.details.length > 0 ? (
            <ul>
              {preview.match.details.map((detail, index) => (
                <li key={`${detail.reason}-${index}`}>{mismatchText(t, detail, lineLabel)}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {touched
        ? issues
            .filter((issue) => issue !== 'DUPLICATE')
            .map((issue) => (
              <p key={issue} className="error-message">
                {t(`supplier_invoice.issue.${issue}`)}
              </p>
            ))
        : null}
      {online && waitingReads && !readFailed ? (
        <p className="home-muted" role="status">
          {t('supplier_invoice.reading')}
        </p>
      ) : null}
      {saveError ? (
        <Banner tone="bad" role="alert">
          {t(saveError)}
        </Banner>
      ) : null}
      <ActionBar>
        <Button
          size="lg"
          className="submit-sale"
          disabled={!ready}
          loading={busy}
          onClick={() => void submit()}
        >
          {busy ? t('sales.submitting') : t('supplier_invoice.submit')}
        </Button>
      </ActionBar>
    </section>
  );
}

/** Statut renvoyé à l'enregistrement : rapprochement conforme (approuvée) ou écart à décider. */
function RecordStatus({ commandId }: { readonly commandId: string }) {
  const { t } = useTranslation();
  const command = useOutboxCommand(commandId);
  const status = command?.server_refs?.status;
  if (status !== 'APPROVED' && status !== 'MISMATCH') return null;
  return (
    <p className="home-muted" role="status">
      {t(`supplier_invoice.after.${status}`)}
    </p>
  );
}
