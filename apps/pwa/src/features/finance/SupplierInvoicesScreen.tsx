/**
 * ECR-FIN-03 « Factures fournisseurs » (UC-FIN-10, UC-FIN-11 ; ADR-043, ADR-047 §4 ; AV-271 à AV-274,
 * AV-278, AV-298). En ligne (`ONLINE_REQUIRED`) ; hors ligne, la dernière lecture reste affichée,
 * périmée, et le brouillon d'une facture est gardé jusqu'au retour du réseau :
 * - dettes fournisseurs (`GET /payables`) : dette, échu, avances, tranches de retard ;
 * - factures par groupe de statuts et par fournisseur (`GET /supplier-invoices`) : écarts de
 *   rapprochement en clair, motifs, facture (photo) lue sur le serveur, lignes et affectations à la
 *   demande ; contester, approuver (jamais sa propre facture) ou annuler (avoir) avec un motif
 *   (`finance.supplier_invoice.*`, Direction et Finance) ; lien vers la file des validations
 *   (`INVOICE_MISMATCH`, ADR-047 §5) ; photo à joindre par l'auteur d'une facture qui n'en a pas ;
 * - saisie d'une facture (Finance, `InvoiceForm`).
 * Toute réponse d'une opération sur les factures relit la liste, les dettes et la saisie.
 * Le Resp. achats lit (AV-298).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { AttachPhoto } from '../attachments/PhotoViews.js';
import { ServerPhoto } from '../attachments/PhotoViews.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDate } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import type { SupplierView } from '../procurement/suppliers.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type ReadResult,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
} from '../sales/submit.js';
import type { ExpenseAttachmentItem } from './expense-follow.js';
import { userName } from './expense-format.js';
import { mismatchText } from './invoice-format.js';
import { InvoiceForm } from './InvoiceForm.js';
import {
  AGING_BUCKETS,
  INVOICE_GROUP_ORDER,
  INVOICE_MAX_PAGES,
  invoiceActions,
  invoiceDecisionPayload,
  invoiceListPaths,
  MAX_INVOICE_REASON,
  sortInvoices,
  type InvoiceGroup,
  type PayablesResponse,
  type SupplierInvoiceDetail,
  type SupplierInvoiceItem,
  type SupplierInvoiceLineItem,
} from './supplier-invoice.js';

type Decision = 'dispute' | 'approve' | 'cancel';

/** Opérations sur les factures (décisions et enregistrement) : leurs réponses relisent l'écran. */
const FAMILY = 'finance.supplier_invoice.';
const COMMANDS: Readonly<Record<Decision, string>> = {
  dispute: 'finance.supplier_invoice.dispute',
  approve: 'finance.supplier_invoice.approve',
  cancel: 'finance.supplier_invoice.cancel',
};
const MANAGED = new Set(Object.values(COMMANDS));

type InvoiceWithPieces = SupplierInvoiceItem & {
  readonly attachments?: readonly ExpenseAttachmentItem[];
};

interface InvoicesRead {
  readonly items: readonly InvoiceWithPieces[];
  readonly more: boolean;
}

async function readInvoices(
  group: InvoiceGroup,
  supplierId: string,
): Promise<ReadResult<InvoicesRead>> {
  const pages = await readPages<InvoiceWithPieces>(
    invoiceListPaths(group, supplierId),
    'supplier_invoices',
    INVOICE_MAX_PAGES,
  );
  if (!pages.ok) return pages;
  return { ok: true, data: { items: sortInvoices(pages.data.items), more: pages.data.more } };
}

/**
 * Clé de relecture de l'écran : chaque opération de l'utilisateur sur les factures et sa phase. Une
 * opération nouvelle ou une réponse, même tardive ou immédiate, relit la liste, les dettes et la saisie.
 */
function familyReloadKey(family: readonly OutboxCommand[], userId: string | undefined): string {
  return family
    .filter((command) => command.author_user_id === userId)
    .map((command) => `${command.command_id}:${phaseOf(command)}`)
    .join(',');
}

export function SupplierInvoicesScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const family =
    useLiveQuery(
      () =>
        getDb()
          .outbox.orderBy('device_seq')
          .filter((command) => command.command_type.startsWith(FAMILY))
          .toArray(),
      [],
    ) ?? [];
  const reloadKey = familyReloadKey(family, userId);
  const suppliers = useOnlineRead(
    userId ? '/api/v1/suppliers' : null,
    (key) => readPath<{ readonly suppliers: readonly SupplierView[] }>(key),
    online,
    '',
  );

  if (!userId || navigation === undefined) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.supplier_invoices')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  const supplierList = suppliers.data?.suppliers ?? [];
  return (
    <section className="sale">
      <h1>{t('nav.screens.supplier_invoices')}</h1>
      {online ? null : (
        <p className="text-warn" role="status">
          {t('supplier_invoice.offline_banner')}
        </p>
      )}
      {suppliers.failed && !suppliers.denied ? (
        <p className="text-warn" role="status">
          {t('supplier_invoice.suppliers_failed')}{' '}
          <button type="button" className="secondary" onClick={suppliers.retry}>
            {t('supplier_invoice.retry_suppliers')}
          </button>
        </p>
      ) : null}
      <Payables suppliers={supplierList} online={online} reloadKey={reloadKey} />
      <InvoiceList
        userId={userId}
        suppliers={supplierList}
        online={online}
        mayDecide={holdsAnyRole(roles, ROLE_SETS.supplierInvoiceApprove)}
        family={family}
        reloadKey={reloadKey}
      />
      {holdsAnyRole(roles, ROLE_SETS.supplierInvoiceRecord) ? (
        <InvoiceForm
          userId={userId}
          suppliers={supplierList}
          online={online}
          reloadKey={reloadKey}
        />
      ) : null}
    </section>
  );
}

/** Dettes fournisseurs (BR-FIN-032, KPI-FIN-05) : totaux et ligne par fournisseur. */
function Payables({
  suppliers,
  online,
  reloadKey,
}: {
  readonly suppliers: readonly SupplierView[];
  readonly online: boolean;
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const read = useOnlineRead(
    '/api/v1/payables',
    (key) => readPath<PayablesResponse>(key),
    online,
    reloadKey,
  );
  useRefreshOnVisible(read.retry);
  const nameOf = (id: string) =>
    suppliers.find((supplier) => supplier.id === id)?.name ?? `…${id.slice(-4)}`;
  const data = read.data;
  return (
    <section className="sale-block" aria-labelledby="payables-title">
      <h2 id="payables-title">{t('supplier_invoice.payables_title')}</h2>
      {read.failed ? (
        <p className="alert alert-error" role="alert">
          {read.denied ? t('supplier_invoice.denied') : t('supplier_invoice.payables_failed')}{' '}
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('supplier_invoice.retry_payables')}
            </button>
          )}
        </p>
      ) : null}
      {!data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          <p>
            {t('supplier_invoice.payables_totals', {
              balance: formatMoney(data.total_balance_xaf),
              advance: formatMoney(data.total_advance_xaf),
              date: formatBusinessDate(data.as_of),
            })}
          </p>
          {data.suppliers.length === 0 ? (
            <p className="home-muted">{t('supplier_invoice.payables_empty')}</p>
          ) : (
            <ul className="line-list">
              {[...data.suppliers]
                .sort((a, b) => b.balanceXaf - a.balanceXaf)
                .map((supplier) => (
                  <li
                    key={supplier.supplierId}
                    className="line-card"
                    aria-label={nameOf(supplier.supplierId)}
                  >
                    <p>
                      <strong>{nameOf(supplier.supplierId)}</strong> ·{' '}
                      {t('supplier_invoice.payable_balance', {
                        amount: formatMoney(supplier.balanceXaf),
                      })}
                    </p>
                    <p className={supplier.overdueXaf > 0 ? 'text-warn' : 'home-muted'}>
                      {t('supplier_invoice.payable_line', {
                        overdue: formatMoney(supplier.overdueXaf),
                        advance: formatMoney(supplier.advanceXaf),
                        net: formatMoney(supplier.netXaf),
                      })}
                    </p>
                    <p className="home-muted">
                      {t('supplier_invoice.buckets_intro')}{' '}
                      {AGING_BUCKETS.map((bucket) =>
                        t('supplier_invoice.bucket', {
                          bucket: t(`supplier_invoice.bucket_label.${bucket}`),
                          amount: formatMoney(supplier.buckets[bucket] ?? 0),
                        }),
                      ).join(' · ')}
                    </p>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function InvoiceList({
  userId,
  suppliers,
  online,
  mayDecide,
  family,
  reloadKey,
}: {
  readonly userId: string;
  readonly suppliers: readonly SupplierView[];
  readonly online: boolean;
  readonly mayDecide: boolean;
  readonly family: readonly OutboxCommand[];
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [group, setGroup] = useState<InvoiceGroup>('TO_DECIDE');
  const [supplierId, setSupplierId] = useState('');
  const [open, setOpen] = useState<{ id: string; decision: Decision } | null>(null);
  const [shownLines, setShownLines] = useState<string | null>(null);
  // Produits des lignes de bon, connus une fois les lignes d'une facture lues (écart de cumul).
  const [lineNames, setLineNames] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<{ commandId: string; decision: Decision }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ids = { group: useId(), supplier: useId(), reason: useId() };
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const lastOpened = useRef<string | null>(null);
  const focusResult = useRef(false);
  useEffect(() => {
    if (open) {
      lastOpened.current = `${open.decision}:${open.id}`;
      reasonRef.current?.focus();
    } else if (lastOpened.current) {
      openers.current.get(lastOpened.current)?.focus();
      lastOpened.current = null;
    }
  }, [open]);
  // Décision envoyée : les boutons de la fiche sont bloqués, le focus va au résultat annoncé.
  useEffect(() => {
    if (!focusResult.current) return;
    focusResult.current = false;
    resultRef.current?.focus();
  }, [last]);
  const managed = family.filter((command) => MANAGED.has(command.command_type));
  const read = useOnlineRead<InvoicesRead>(
    `invoices:${group}:${supplierId}`,
    () => readInvoices(group, supplierId),
    online,
    reloadKey,
  );
  useRefreshOnVisible(read.retry);

  // Retour sur l'écran avec une décision en attente : son résultat est annoncé.
  const adopt = last ? undefined : lastWaitingCommand(managed, FAMILY, userId);
  if (adopt) {
    const decision = (Object.keys(COMMANDS) as Decision[]).find(
      (key) => COMMANDS[key] === adopt.command_type,
    );
    if (decision) setLast({ commandId: adopt.command_id, decision });
  }

  const data = read.data;
  // Retenue derrière une opération plus ancienne d'un autre écran : jugée sur toute l'outbox.
  const outbox = refs?.outbox ?? family;
  const waiting = managed.some(
    (command) => command.author_user_id === userId && isBlockingWait(command, outbox),
  );
  const blocked = busy || waiting || read.stale || !data;
  const nameOf = (id: string) =>
    suppliers.find((supplier) => supplier.id === id)?.name ?? `…${id.slice(-4)}`;

  const toggle = (id: string, decision: Decision) => {
    setOpen((current) =>
      current?.id === id && current.decision === decision ? null : { id, decision },
    );
    setReason('');
    setSaveError(null);
  };

  const decide = async (item: SupplierInvoiceItem, decision: Decision) => {
    if (blocked || reason.trim() === '') return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: COMMANDS[decision],
        aggregateType: 'SUPPLIER_INVOICE',
        aggregateId: item.id,
        payload: invoiceDecisionPayload(reason),
      });
      lastOpened.current = null;
      focusResult.current = true;
      setLast({ commandId: command.command_id, decision });
      setOpen(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const rememberLines = (lines: readonly SupplierInvoiceLineItem[]) => {
    const named = lines.flatMap((line) =>
      line.poLineId
        ? [
            [
              line.poLineId,
              refs?.products.find((product) => product.id === line.productId)?.name ??
                line.description,
            ] as const,
          ]
        : [],
    );
    if (named.every(([poLineId, name]) => lineNames[poLineId] === name)) return;
    setLineNames((current) => ({ ...current, ...Object.fromEntries(named) }));
  };

  const card = (item: InvoiceWithPieces) => {
    const actions = invoiceActions(item, userId, mayDecide);
    const pieces = item.attachments ?? [];
    const opened = open?.id === item.id ? open.decision : null;
    // Photo à joindre par l'auteur quand aucune n'est reçue ni en route (refusée, jamais reçue).
    const scanToAttach =
      item.createdBy === userId &&
      item.status !== 'CANCELLED' &&
      !pieces.some(
        (piece) => piece.uploadStatus === 'AVAILABLE' || piece.uploadStatus === 'PENDING_UPLOAD',
      );
    return (
      <li key={item.id} className="line-card" aria-label={item.docNumber}>
        <p>
          <strong>{item.docNumber}</strong> · {formatMoney(item.totalXaf)}
        </p>
        <p>{nameOf(item.supplierId)}</p>
        <p className="home-muted">
          {t('supplier_invoice.card_dates', {
            ref: item.supplierInvoiceRef,
            date: formatBusinessDate(item.invoiceDate),
            due: formatBusinessDate(item.dueDate),
          })}
        </p>
        <p className="home-muted">
          {t('supplier_invoice.card_author', {
            name: userName(t, refs?.users ?? [], item.createdBy, userId),
          })}
          {item.purchaseOrderId ? '' : ` · ${t('supplier_invoice.no_order')}`}
        </p>
        <p
          className={
            item.status === 'MISMATCH' || item.status === 'DISPUTED' ? 'text-warn' : 'home-muted'
          }
        >
          {t(`supplier_invoice.status.${item.status}`, { defaultValue: item.status })}
          {item.status === 'APPROVED' || item.status === 'PARTIALLY_PAID' || item.status === 'PAID'
            ? ` · ${t('supplier_invoice.card_paid', {
                paid: formatMoney(item.paidXaf),
                balance: formatMoney(item.balanceXaf),
              })}`
            : ''}
        </p>
        {item.mismatchDetails.length > 0 ? (
          <ul className="text-warn">
            {item.mismatchDetails.map((detail, index) => (
              <li key={`${detail.reason}-${index}`}>
                {mismatchText(t, detail, (poLineId) => lineNames[poLineId] ?? null)}
              </li>
            ))}
          </ul>
        ) : null}
        {item.approvalReason ? (
          <p className="home-muted">
            {t('supplier_invoice.approval_reason', { reason: item.approvalReason })}
          </p>
        ) : null}
        {item.disputeReason ? (
          <p className="home-muted">
            {t('supplier_invoice.dispute_reason', { reason: item.disputeReason })}
          </p>
        ) : null}
        {item.cancelReason ? (
          <p className="home-muted">
            {t('supplier_invoice.cancel_reason', { reason: item.cancelReason })}
          </p>
        ) : null}
        {pieces.length === 0 ? (
          <p className="home-muted">{t('supplier_invoice.no_scan')}</p>
        ) : (
          pieces.map((piece) =>
            piece.uploadStatus === 'AVAILABLE' ? (
              <ServerPhoto
                key={piece.id}
                attachmentId={piece.id}
                alt={t('supplier_invoice.scan_alt', { doc: item.docNumber })}
                label={t('supplier_invoice.scan_view', { doc: item.docNumber })}
              />
            ) : (
              <p
                key={piece.id}
                className={piece.uploadStatus === 'PENDING_UPLOAD' ? 'home-muted' : 'text-warn'}
              >
                {t(
                  piece.uploadStatus === 'PENDING_UPLOAD'
                    ? 'supplier_invoice.scan_uploading'
                    : piece.uploadStatus === 'MISSING'
                      ? 'supplier_invoice.scan_missing'
                      : 'supplier_invoice.scan_refused',
                )}
              </p>
            ),
          )
        )}
        {scanToAttach ? (
          <AttachPhoto
            userId={userId}
            target={{
              kind: 'INVOICE',
              ownerType: 'SUPPLIER_INVOICE',
              cited: false,
              ownerId: item.id,
            }}
            label={t('supplier_invoice.attach_scan', { doc: item.docNumber })}
          />
        ) : null}
        <button
          type="button"
          className="secondary"
          aria-expanded={shownLines === item.id}
          onClick={() => setShownLines((current) => (current === item.id ? null : item.id))}
        >
          {t(
            shownLines === item.id ? 'supplier_invoice.lines_hide' : 'supplier_invoice.lines_show',
            {
              doc: item.docNumber,
            },
          )}
        </button>
        {shownLines === item.id ? (
          <InvoiceLines
            invoiceId={item.id}
            docNumber={item.docNumber}
            online={online}
            reloadKey={reloadKey}
            onLines={rememberLines}
          />
        ) : null}
        {actions.ownInvoice &&
        (item.status === 'MISMATCH' || item.status === 'DISPUTED') &&
        mayDecide ? (
          <p className="home-muted">{t('supplier_invoice.own_invoice')}</p>
        ) : null}
        {opened ? (
          <div className="field">
            <label htmlFor={ids.reason}>{t(`supplier_invoice.reason_label.${opened}`)}</label>
            <textarea
              id={ids.reason}
              ref={reasonRef}
              className="text-input"
              rows={2}
              maxLength={MAX_INVOICE_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="result-actions">
              <button
                type="button"
                disabled={blocked || reason.trim() === ''}
                onClick={() => void decide(item, opened)}
              >
                {t(`supplier_invoice.submit_decision.${opened}`)}
              </button>
              <button type="button" className="secondary" onClick={() => setOpen(null)}>
                {t('expense.close_form')}
              </button>
            </div>
          </div>
        ) : actions.dispute || actions.approve || actions.cancel ? (
          <div className="result-actions">
            {(['approve', 'dispute', 'cancel'] as const)
              .filter((decision) => actions[decision])
              .map((decision) => (
                <button
                  key={decision}
                  type="button"
                  className={decision === 'approve' ? undefined : 'secondary'}
                  ref={(element) => {
                    openers.current.set(`${decision}:${item.id}`, element);
                  }}
                  disabled={blocked}
                  onClick={() => toggle(item.id, decision)}
                >
                  {t(`supplier_invoice.open_decision.${decision}`, { doc: item.docNumber })}
                </button>
              ))}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className="sale-block" aria-labelledby="invoices-title">
      <h2 id="invoices-title">{t('supplier_invoice.list_title')}</h2>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.group}>{t('supplier_invoice.group_label')}</label>
          <select
            id={ids.group}
            className="text-input"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value as InvoiceGroup);
              setOpen(null);
            }}
          >
            {INVOICE_GROUP_ORDER.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`supplier_invoice.group.${candidate}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.supplier}>{t('supplier_invoice.filter_supplier')}</label>
          <select
            id={ids.supplier}
            className="text-input"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setOpen(null);
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
      {/* Écarts aussi décidés dans la file des validations (ADR-047 §5), par leurs approbateurs. */}
      {mayDecide && group === 'TO_DECIDE' ? (
        <Link to={`${ROUTES.approvals}?types=INVOICE_MISMATCH`} className="action action-compact">
          <span className="action-label">{t('supplier_invoice.decide_link')}</span>
        </Link>
      ) : null}
      {last ? (
        <div ref={resultRef} tabIndex={-1}>
          <CommandResult
            commandId={last.commandId}
            messages={`supplier_invoice.decision_result.${last.decision}`}
          />
        </div>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>
            {read.denied
              ? t('supplier_invoice.denied')
              : t(data ? 'supplier_invoice.failed_stale' : 'supplier_invoice.failed')}
          </p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('supplier_invoice.retry_list')}
            </button>
          )}
        </div>
      ) : null}
      {!data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          {data.items.length === 0 ? (
            <p className="home-muted">{t('supplier_invoice.empty')}</p>
          ) : (
            <ul className="line-list">{data.items.map((item) => card(item))}</ul>
          )}
          {data.more ? <p className="home-muted">{t('expense.truncated')}</p> : null}
        </>
      )}
    </section>
  );
}

/** Lignes et affectations d'une facture, lues à la demande (`GET /supplier-invoices/{id}`). */
function InvoiceLines({
  invoiceId,
  docNumber,
  online,
  reloadKey,
  onLines,
}: {
  readonly invoiceId: string;
  readonly docNumber: string;
  readonly online: boolean;
  readonly reloadKey: string;
  readonly onLines: (lines: readonly SupplierInvoiceLineItem[]) => void;
}) {
  const { t } = useTranslation();
  const read = useOnlineRead(
    `/api/v1/supplier-invoices/${invoiceId}`,
    (key) => readPath<{ readonly supplier_invoice: SupplierInvoiceDetail }>(key),
    online,
    reloadKey,
  );
  const detail = read.data?.supplier_invoice;
  useEffect(() => {
    if (detail) onLines(detail.lines);
  }, [detail, onLines]);
  if (read.failed) {
    return (
      <p className="text-warn" role="alert">
        {read.denied ? t('supplier_invoice.lines_denied') : t('supplier_invoice.lines_failed')}{' '}
        {read.denied ? null : (
          <button type="button" className="secondary" onClick={read.retry}>
            {t('supplier_invoice.retry_lines', { doc: docNumber })}
          </button>
        )}
      </p>
    );
  }
  if (!detail) return <p className="home-muted">{t('sales.loading')}</p>;
  return (
    <div className="sale-block">
      <ol>
        {detail.lines.map((line) => (
          <li key={line.lineNo}>
            {t('supplier_invoice.line_read', {
              description: line.description,
              quantity:
                line.quantityBase === null ? '—' : String(line.quantityBase).replace('.', ','),
              price: line.unitPriceXaf === null ? '—' : formatMoney(line.unitPriceXaf),
              total: formatMoney(line.lineTotalXaf),
            })}
          </li>
        ))}
      </ol>
      {detail.allocations.length > 0 ? (
        <ul className="home-muted">
          {detail.allocations.map((allocation, index) => (
            <li key={`${allocation.paymentId}-${index}`}>
              {t('supplier_invoice.allocation_line', {
                amount: formatMoney(allocation.amountXaf),
                status: t(`supplier_invoice.allocation_status.${allocation.status}`, {
                  defaultValue: allocation.status,
                }),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
