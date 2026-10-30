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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import {
  Badge,
  Banner,
  Button,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  KpiTile,
  LinkButton,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import type { OutboxCommand } from '../../storage/db.js';
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
  saveErrorKey,
  submitCommand,
} from '../sales/submit.js';
import { familyReloadKey, useCommandFamily } from './command-family.js';
import type { ExpenseAttachmentItem } from './expense-follow.js';
import { userName } from './expense-format.js';
import { mismatchText } from './invoice-format.js';
import { InvoiceForm } from './InvoiceForm.js';
import './finance.css';
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

export function SupplierInvoicesScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const family = useCommandFamily(FAMILY);
  // Toute opération sur les factures (décision, enregistrement) relit la liste, les dettes et la saisie.
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
        <PageHeader title={t('nav.screens.supplier_invoices')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  const supplierList = suppliers.data?.suppliers ?? [];
  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.supplier_invoices')} />
      {online ? null : (
        <Banner tone="warn" role="status">
          {t('supplier_invoice.offline_banner')}
        </Banner>
      )}
      {suppliers.failed && !suppliers.denied ? (
        <Banner
          tone="warn"
          role="status"
          action={
            <Button variant="outline" size="sm" onClick={suppliers.retry}>
              {t('supplier_invoice.retry_suppliers')}
            </Button>
          }
        >
          {t('supplier_invoice.suppliers_failed')}
        </Banner>
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

/** Ton de la pastille d'une facture : l'écart se décide, la contestation alerte, le payé rassure. */
function invoiceStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'MISMATCH':
      return 'warn';
    case 'DISPUTED':
      return 'bad';
    case 'APPROVED':
    case 'PARTIALLY_PAID':
      return 'info';
    case 'PAID':
      return 'ok';
    default:
      return 'muted';
  }
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
    <Section title={t('supplier_invoice.payables_title')}>
      {read.failed ? (
        <Banner
          tone="bad"
          role="alert"
          action={
            read.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t('supplier_invoice.retry_payables')}
              </Button>
            )
          }
        >
          {read.denied ? t('supplier_invoice.denied') : t('supplier_invoice.payables_failed')}
        </Banner>
      ) : null}
      {!data ? (
        read.failed ? null : online ? (
          <SkeletonRows rows={2} />
        ) : (
          <EmptyState icon="offline" title={t('supplier_invoice.online_only')} />
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          <p className="home-muted">
            {t('supplier_invoice.payables_as_of', { date: formatBusinessDate(data.as_of) })}
          </p>
          <div className="fin-kpis">
            <KpiTile
              icon="receipt"
              label={t('supplier_invoice.tile_balance')}
              value={formatMoney(data.total_balance_xaf)}
            />
            <KpiTile
              icon="cash"
              label={t('supplier_invoice.tile_advance')}
              value={formatMoney(data.total_advance_xaf)}
            />
          </div>
          {data.suppliers.length === 0 ? (
            <EmptyState icon="check-circle" title={t('supplier_invoice.payables_empty')} />
          ) : (
            <DataList
              template="minmax(0, 2.2fr) minmax(7rem, 1fr) minmax(0, 2.4fr)"
              columns={[
                { label: t('supplier_invoice.col_supplier') },
                { label: t('supplier_invoice.col_debt'), numeric: true },
                { label: t('supplier_invoice.col_position') },
              ]}
            >
              {[...data.suppliers]
                .sort((a, b) => b.balanceXaf - a.balanceXaf)
                .map((supplier) => (
                  <DataRow key={supplier.supplierId} aria-label={nameOf(supplier.supplierId)}>
                    <DataCell primary>
                      <strong>{nameOf(supplier.supplierId)}</strong>
                    </DataCell>
                    <DataCell label={t('supplier_invoice.col_debt')} numeric>
                      {formatMoney(supplier.balanceXaf)}
                    </DataCell>
                    <DataCell>
                      <span className={supplier.overdueXaf > 0 ? 'text-warn' : 'home-muted'}>
                        {t('supplier_invoice.payable_line', {
                          overdue: formatMoney(supplier.overdueXaf),
                          advance: formatMoney(supplier.advanceXaf),
                          net: formatMoney(supplier.netXaf),
                        })}
                      </span>
                    </DataCell>
                    <DataCell wide>
                      <small className="fin-group-meta">
                        {t('supplier_invoice.buckets_intro')}{' '}
                        {AGING_BUCKETS.map((bucket) =>
                          t('supplier_invoice.bucket', {
                            bucket: t(`supplier_invoice.bucket_label.${bucket}`),
                            amount: formatMoney(supplier.buckets[bucket] ?? 0),
                          }),
                        ).join(' · ')}
                      </small>
                    </DataCell>
                  </DataRow>
                ))}
            </DataList>
          )}
        </>
      )}
    </Section>
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
    const decisions = (['approve', 'dispute', 'cancel'] as const).filter(
      (decision) => actions[decision],
    );
    // Photo à joindre par l'auteur quand aucune n'est reçue ni en route (refusée, jamais reçue).
    const scanToAttach =
      item.createdBy === userId &&
      item.status !== 'CANCELLED' &&
      !pieces.some(
        (piece) => piece.uploadStatus === 'AVAILABLE' || piece.uploadStatus === 'PENDING_UPLOAD',
      );
    return (
      <DataRow key={item.id} aria-label={item.docNumber}>
        <DataCell primary>
          <strong>{item.docNumber}</strong>
          <small className="fin-group-meta">{nameOf(item.supplierId)}</small>
        </DataCell>
        <DataCell>
          <span className="fin-meta">
            {t('supplier_invoice.card_dates', {
              ref: item.supplierInvoiceRef,
              date: formatBusinessDate(item.invoiceDate),
              due: formatBusinessDate(item.dueDate),
            })}
          </span>
        </DataCell>
        <DataCell label={t('supplier_invoice.col_total')} numeric>
          {formatMoney(item.totalXaf)}
        </DataCell>
        <DataCell label={t('supplier_invoice.col_status')}>
          <Badge tone={invoiceStatusTone(item.status)}>
            {t(`supplier_invoice.status.${item.status}`, { defaultValue: item.status })}
          </Badge>
          {item.status === 'APPROVED' ||
          item.status === 'PARTIALLY_PAID' ||
          item.status === 'PAID' ? (
            <small className="fin-group-meta">
              {t('supplier_invoice.card_paid', {
                paid: formatMoney(item.paidXaf),
                balance: formatMoney(item.balanceXaf),
              })}
            </small>
          ) : null}
        </DataCell>
        {decisions.length > 0 && !opened ? (
          <DataCell actions>
            {decisions.map((decision) => (
              <Button
                key={decision}
                variant={decision === 'approve' ? 'tonal' : 'outline'}
                size="sm"
                ref={(element) => {
                  openers.current.set(`${decision}:${item.id}`, element);
                }}
                disabled={blocked}
                aria-label={t(`supplier_invoice.open_decision.${decision}`, {
                  doc: item.docNumber,
                })}
                onClick={() => toggle(item.id, decision)}
              >
                {t(`supplier_invoice.decision_short.${decision}`)}
              </Button>
            ))}
          </DataCell>
        ) : null}
        <DataCell wide>
          <div className="fin-detail">
            <p className="home-muted">
              {t('supplier_invoice.card_author', {
                name: userName(t, refs?.users ?? [], item.createdBy, userId),
              })}
              {item.purchaseOrderId ? '' : ` · ${t('supplier_invoice.no_order')}`}
            </p>
            {item.mismatchDetails.length > 0 ? (
              <ul className="fin-mismatch">
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
            <div className="result-actions">
              <Button
                variant="ghost"
                size="sm"
                iconEnd={shownLines === item.id ? 'chevron-up' : 'chevron-down'}
                aria-expanded={shownLines === item.id}
                aria-label={t(
                  shownLines === item.id
                    ? 'supplier_invoice.lines_hide'
                    : 'supplier_invoice.lines_show',
                  { doc: item.docNumber },
                )}
                onClick={() => setShownLines((current) => (current === item.id ? null : item.id))}
              >
                {t(
                  shownLines === item.id
                    ? 'supplier_invoice.lines_hide_short'
                    : 'supplier_invoice.lines_show_short',
                )}
              </Button>
            </div>
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
              <div className="fin-decision">
                <Field label={t(`supplier_invoice.reason_label.${opened}`)}>
                  {(control) => (
                    <textarea
                      {...control}
                      ref={reasonRef}
                      className="textarea"
                      rows={2}
                      maxLength={MAX_INVOICE_REASON}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  )}
                </Field>
                <div className="result-actions">
                  <Button
                    disabled={blocked || reason.trim() === ''}
                    onClick={() => void decide(item, opened)}
                  >
                    {t(`supplier_invoice.submit_decision.${opened}`)}
                  </Button>
                  <Button variant="ghost" onClick={() => setOpen(null)}>
                    {t('expense.close_form')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DataCell>
      </DataRow>
    );
  };

  return (
    <Section title={t('supplier_invoice.list_title')}>
      <div className="filter-bar">
        <Field label={t('supplier_invoice.group_label')}>
          {(control) => (
            <Select
              {...control}
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
            </Select>
          )}
        </Field>
        <Field label={t('supplier_invoice.filter_supplier')}>
          {(control) => (
            <Select
              {...control}
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
            </Select>
          )}
        </Field>
      </div>
      {/* Écarts aussi décidés dans la file des validations (ADR-047 §5), par leurs approbateurs. */}
      {mayDecide && group === 'TO_DECIDE' ? (
        <div className="chip-row">
          <LinkButton
            to={`${ROUTES.approvals}?types=INVOICE_MISMATCH`}
            variant="tonal"
            size="sm"
            icon="check-circle"
          >
            {t('supplier_invoice.decide_link')}
          </LinkButton>
        </div>
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
        <Banner tone="bad" role="alert">
          {t(saveError)}
        </Banner>
      ) : null}
      {read.failed ? (
        <Banner
          tone="bad"
          role="alert"
          action={
            read.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t('supplier_invoice.retry_list')}
              </Button>
            )
          }
        >
          {read.denied
            ? t('supplier_invoice.denied')
            : t(data ? 'supplier_invoice.failed_stale' : 'supplier_invoice.failed')}
        </Banner>
      ) : null}
      {!data ? (
        read.failed ? null : online ? (
          <SkeletonRows rows={3} />
        ) : (
          <EmptyState icon="offline" title={t('supplier_invoice.online_only')} />
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          {data.items.length === 0 ? (
            <EmptyState icon="file" title={t('supplier_invoice.empty')} />
          ) : (
            <DataList
              className="fin-invoices"
              template="minmax(0, 1.8fr) minmax(0, 2.4fr) minmax(7rem, 1fr) minmax(0, 1.6fr) minmax(0, 1.8fr)"
              columns={[
                { label: t('supplier_invoice.col_invoice') },
                { label: t('supplier_invoice.col_dates') },
                { label: t('supplier_invoice.col_total'), numeric: true },
                { label: t('supplier_invoice.col_status') },
                { label: '' },
              ]}
            >
              {data.items.map((item) => card(item))}
            </DataList>
          )}
          {data.more ? <p className="home-muted">{t('expense.truncated')}</p> : null}
        </>
      )}
    </Section>
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
      <Banner
        tone="warn"
        role="alert"
        action={
          read.denied ? undefined : (
            <Button variant="outline" size="sm" onClick={read.retry}>
              {t('supplier_invoice.retry_lines', { doc: docNumber })}
            </Button>
          )
        }
      >
        {read.denied ? t('supplier_invoice.lines_denied') : t('supplier_invoice.lines_failed')}
      </Banner>
    );
  }
  if (!detail) return <p className="home-muted">{t('sales.loading')}</p>;
  return (
    <div className="fin-invoice-lines">
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
