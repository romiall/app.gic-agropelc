/**
 * ECR-FIN-01 « Créances » (P8E-09 ; ADR-047 §9 ; AV-304, AV-305). Lecture en ligne de
 * `GET /receivables` ; hors ligne, la dernière lecture reste affichée, périmée :
 * - encours du jour : total, échu, à échoir, échu par tranche de retard (synthèse du serveur) ;
 * - créances par client ou par titulaire (commercial attributaire, à défaut vendeur), le plus en retard
 *   d'abord, filtrées par échéance, tranche ou site ; ventes du groupe à la demande ;
 * - « Encaisser » et « Encaisser le reste dû » mènent à ECR-VEN-06 pour les rôles qui encaissent, sur
 *   le compte conservé d'un client fusionné (l'encaissement sur un compte absorbé est refusé en ligne,
 *   BR-CRM-007) ; appel du client quand son téléphone est connu ; fiche du client si l'appareil l'a.
 * Les relances ne sont pas enregistrées dans l'application (AV-304). Finance, Direction et Resp.
 * commercial ; le serveur reste seul juge de la portée (TEAM pour le Resp. commercial).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDate } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { formatMoney } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type OnlineRead,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { familyReloadKey, useCommandFamilyState } from './command-family.js';
import {
  canonicalCustomer,
  CUSTOMER_NAME_MAX_PAGES,
  CUSTOMER_NAME_PATHS,
  customerDirectory,
  customersToName,
  groupReceivables,
  matchesView,
  NO_CUSTOMER,
  notDueXaf,
  ownerOf,
  RECEIVABLE_GROUPINGS,
  RECEIVABLE_VIEWS,
  RECEIVABLES_PATH,
  sortGroups,
  summarizeLines,
  telHref,
  USER_NAME_MAX_PAGES,
  USER_NAME_PATH,
  type ReceivableGroup,
  type ReceivableGrouping,
  type ReceivableItem,
  type ReceivablesResponse,
  type ReceivableView,
  type RemoteCustomerName,
  type RemoteUserName,
} from './receivables.js';
import { AGING_BUCKETS } from './supplier-invoice.js';

const shortId = (id: string) => `…${id.slice(-4)}`;
const NO_USERS: readonly RemoteUserName[] = [];

/** Échec d'une lecture : refus sans relance, panne avec sa relance. */
function ReadProblem({
  read,
  failedKey,
  retryKey,
}: {
  readonly read: Pick<OnlineRead<unknown>, 'failed' | 'denied' | 'retry'>;
  readonly failedKey: string;
  readonly retryKey: string;
}) {
  const { t } = useTranslation();
  if (!read.failed) return null;
  return (
    <p className="text-warn" role="alert">
      {read.denied ? t('receivables.denied') : t(failedKey)}{' '}
      {read.denied ? null : (
        <button type="button" className="secondary" onClick={read.retry}>
          {t(retryKey)}
        </button>
      )}
    </p>
  );
}

export function ReceivablesScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  // Un encaissement de l'utilisateur (envoyé, accepté, refusé) fait relire les créances ; la lecture
  // attend celle de l'outbox, sinon elle partirait deux fois au montage.
  const payments = useCommandFamilyState('sales.payment.');
  const read = useOnlineRead(
    payments === undefined ? null : RECEIVABLES_PATH,
    (key) => readPath<ReceivablesResponse>(key),
    online,
    familyReloadKey(payments ?? [], userId),
  );
  useRefreshOnVisible(read.retry);
  const [view, setView] = useState<ReceivableView>('ALL');
  const [siteId, setSiteId] = useState('');
  const [grouping, setGrouping] = useState<ReceivableGrouping>('customer');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const ids = { view: useId(), site: useId(), grouping: useId() };

  const lines = read.data?.receivables ?? [];
  const local = customerDirectory(refs?.customers ?? [], refs?.customerAlias ?? new Map(), []);
  // Noms des clients absents de l'appareil, relus seulement quand un client encore jamais demandé
  // apparaît (la liste des clients demandés ne fait que croître : une créance soldée n'y change rien).
  const missingCustomers = refs ? customersToName(lines, local) : [];
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  if (missingCustomers.some((id) => !asked.has(id))) {
    setAsked(new Set([...asked, ...missingCustomers]));
  }
  const remoteCustomers = useOnlineRead(
    missingCustomers.length > 0 ? 'receivable-customers' : null,
    () => readPages<RemoteCustomerName>(CUSTOMER_NAME_PATHS, 'customers', CUSTOMER_NAME_MAX_PAGES),
    online,
    [...new Set([...asked, ...missingCustomers])].sort().join(','),
  );
  const users = refs?.users ?? [];
  const missingOwners =
    grouping === 'owner'
      ? [...new Set(lines.map(ownerOf))].filter(
          (id) => id !== userId && !users.some((user) => user.id === id),
        )
      : [];
  const remoteUsers = useOnlineRead(
    missingOwners.length > 0 ? 'receivable-users' : null,
    () => readPages<RemoteUserName>([USER_NAME_PATH], 'users', USER_NAME_MAX_PAGES),
    online,
    '',
  );

  if (!userId || navigation === undefined || !refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.receivables')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  const mayCollect = holdsAnyRole(roles, ROLE_SETS.paymentRecord);
  const directory = customerDirectory(
    refs.customers,
    refs.customerAlias,
    remoteCustomers.data?.items ?? [],
  );
  const customerKey = (line: ReceivableItem) =>
    line.customerId === null ? NO_CUSTOMER : canonicalCustomer(line.customerId, directory.alias);
  const customerName = (key: string) =>
    key === NO_CUSTOMER
      ? t('receivables.no_customer')
      : (directory.cards.get(key)?.name ?? t('receivables.customer_unknown', { id: shortId(key) }));
  const knownUsers = [
    ...users,
    ...(remoteUsers.data?.items ?? NO_USERS).map((user) => ({
      id: user.id,
      full_name: user.fullName,
    })),
  ];
  const ownerName = (id: string) =>
    id === userId
      ? t('receivables.owner_self')
      : (knownUsers.find((user) => user.id === id)?.full_name ?? shortId(id));
  const siteName = (id: string) => refs.sites.get(id)?.name ?? shortId(id);
  const nameOf = grouping === 'customer' ? customerName : ownerName;

  const data = read.data;
  const sites = [...new Set(lines.map((line) => line.siteId))].sort((a, b) =>
    siteName(a).localeCompare(siteName(b), 'fr'),
  );
  // Un site choisi qui n'a plus de créance n'est plus proposé : la sélection revient à « tous ».
  const site = sites.includes(siteId) ? siteId : '';
  // Le site choisi n'a plus de créance (soldée, relecture) : le choix est oublié, il ne reviendrait pas
  // en silence avec une créance ultérieure.
  if (data && siteId !== '' && !sites.includes(siteId)) setSiteId('');
  const selected = lines.filter(
    (line) => matchesView(line, view) && (site === '' || line.siteId === site),
  );
  const filtered = view !== 'ALL' || site !== '';
  const selection = summarizeLines(selected);
  const groups = sortGroups(
    groupReceivables(selected, grouping === 'customer' ? customerKey : ownerOf),
    nameOf,
  );
  // Noms des groupes ; deux groupes de même nom se distinguent par le téléphone, à défaut l'identifiant.
  const baseName = new Map(groups.map((group) => [group.key, nameOf(group.key)]));
  const sameName = (name: string) => groups.filter((g) => baseName.get(g.key) === name).length > 1;
  const labelOf = (key: string) => {
    const name = baseName.get(key) ?? nameOf(key);
    if (!sameName(name)) return name;
    const phone = grouping === 'customer' ? directory.cards.get(key)?.phone : null;
    return `${name} (${phone ?? shortId(key)})`;
  };
  // Client à encaisser : son compte conservé ; aucun lien pour un client que la lecture complète des
  // clients ne connaît pas (hors de la portée de l'utilisateur : la fiche répondrait « refusé »).
  const namesComplete = remoteCustomers.data !== undefined && !remoteCustomers.data.more;
  const reachable = (key: string) =>
    key !== NO_CUSTOMER && (directory.cards.has(key) || !namesComplete);
  const payerOf = (line: ReceivableItem): string | null => {
    const key = customerKey(line);
    return line.customerId !== null && reachable(key) ? key : null;
  };
  // Noms de clients qui manquent encore alors que la liste lue est partielle.
  const unnamedCustomer = selected.some(
    (line) => line.customerId !== null && !directory.cards.has(customerKey(line)),
  );
  const toggle = (key: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="sale">
      <h1>{t('nav.screens.receivables')}</h1>
      {online ? null : (
        <p className="text-warn" role="status">
          {t('receivables.offline_banner')}
        </p>
      )}
      <section className="sale-block" aria-labelledby="receivables-summary-title">
        <h2 id="receivables-summary-title">{t('receivables.summary_title')}</h2>
        <ReadProblem read={read} failedKey="receivables.failed" retryKey="receivables.retry" />
        {online && data && read.stale && !read.failed ? (
          <p className="home-muted" role="status">
            {t('receivables.refreshing')}
          </p>
        ) : null}
        {!data ? (
          read.failed ? null : (
            <p className="home-muted" aria-busy={online}>
              {t(online ? 'sales.loading' : 'receivables.online_only')}
            </p>
          )
        ) : (
          <>
            <p className="home-muted">
              {t('receivables.as_of', { date: formatBusinessDate(data.as_of) })}
            </p>
            <p>
              {t('receivables.total', {
                amount: formatMoney(data.summary.totalXaf),
                count: data.summary.count,
              })}
            </p>
            <p className={data.summary.overdueXaf > 0 ? 'text-warn' : undefined}>
              {t('receivables.overdue', { amount: formatMoney(data.summary.overdueXaf) })}
            </p>
            <p>{t('receivables.not_due', { amount: formatMoney(notDueXaf(data.summary)) })}</p>
            <ul className="home-muted" aria-label={t('receivables.buckets_label')}>
              {AGING_BUCKETS.map((bucket) => (
                <li key={bucket}>
                  {t('receivables.bucket_line', {
                    label: t(`receivables.bucket.${bucket}`),
                    amount: formatMoney(data.summary.buckets[bucket] ?? 0),
                  })}
                </li>
              ))}
            </ul>
            <p className="home-muted">{t('receivables.scope_note')}</p>
          </>
        )}
      </section>
      {data ? (
        <section className="sale-block" aria-labelledby="receivables-list-title">
          <h2 id="receivables-list-title">{t('receivables.list_title')}</h2>
          <div className="line-fields">
            <div className="field">
              <label htmlFor={ids.view}>{t('receivables.view_label')}</label>
              <select
                id={ids.view}
                className="text-input"
                value={view}
                onChange={(event) => setView(event.target.value as ReceivableView)}
              >
                {RECEIVABLE_VIEWS.map((code) => (
                  <option key={code} value={code}>
                    {t(`receivables.view.${code}`)}
                  </option>
                ))}
              </select>
            </div>
            {sites.length > 1 ? (
              <div className="field">
                <label htmlFor={ids.site}>{t('receivables.site_label')}</label>
                <select
                  id={ids.site}
                  className="text-input"
                  value={site}
                  onChange={(event) => setSiteId(event.target.value)}
                >
                  <option value="">{t('receivables.all_sites')}</option>
                  {sites.map((id) => (
                    <option key={id} value={id}>
                      {siteName(id)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor={ids.grouping}>{t('receivables.grouping_label')}</label>
              <select
                id={ids.grouping}
                className="text-input"
                value={grouping}
                onChange={(event) => {
                  setGrouping(event.target.value as ReceivableGrouping);
                  setOpened(new Set());
                }}
              >
                {RECEIVABLE_GROUPINGS.map((code) => (
                  <option key={code} value={code}>
                    {t(`receivables.grouping.${code}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ReadProblem
            read={remoteCustomers}
            failedKey="receivables.names_failed"
            retryKey="receivables.retry_names"
          />
          {grouping === 'owner' ? (
            <ReadProblem
              read={remoteUsers}
              failedKey="receivables.owners_failed"
              retryKey="receivables.retry_owners"
            />
          ) : null}
          {remoteCustomers.data?.more && unnamedCustomer ? (
            <p className="home-muted">{t('receivables.names_truncated')}</p>
          ) : null}
          {filtered && selected.length > 0 ? (
            <p>
              {t('receivables.selection', {
                amount: formatMoney(selection.totalXaf),
                overdue: formatMoney(selection.overdueXaf),
                count: selection.count,
              })}
            </p>
          ) : null}
          {lines.length === 0 ? (
            <p className="home-muted">{t('receivables.empty')}</p>
          ) : groups.length === 0 ? (
            <p className="home-muted">{t('receivables.filter_empty')}</p>
          ) : (
            <ul className="line-list">
              {groups.map((group) => (
                <GroupCard
                  key={group.key}
                  group={group}
                  grouping={grouping}
                  name={labelOf(group.key)}
                  self={grouping === 'owner' && group.key === userId}
                  opened={opened.has(group.key)}
                  onToggle={() => toggle(group.key)}
                  phone={
                    grouping === 'customer' ? (directory.cards.get(group.key)?.phone ?? null) : null
                  }
                  onDevice={
                    grouping === 'customer' && (directory.cards.get(group.key)?.onDevice ?? false)
                  }
                  groupPayer={grouping === 'customer' && reachable(group.key) ? group.key : null}
                  mayCollect={mayCollect}
                  payerOf={payerOf}
                  customerName={(line) => customerName(customerKey(line))}
                />
              ))}
            </ul>
          )}
          <p className="home-muted">{t('receivables.reminder_note')}</p>
        </section>
      ) : null}
    </section>
  );
}

function GroupCard({
  group,
  grouping,
  name,
  self,
  opened,
  onToggle,
  phone,
  onDevice,
  groupPayer,
  mayCollect,
  payerOf,
  customerName,
}: {
  readonly group: ReceivableGroup;
  readonly grouping: ReceivableGrouping;
  readonly name: string;
  /** Groupe de l'utilisateur lui-même (regroupement par titulaire). */
  readonly self: boolean;
  readonly opened: boolean;
  readonly onToggle: () => void;
  readonly phone: string | null;
  readonly onDevice: boolean;
  /** Compte à encaisser pour un groupe de client ; `null` : aucun lien (client hors portée). */
  readonly groupPayer: string | null;
  readonly mayCollect: boolean;
  /** Compte conservé de la vente à encaisser ; `null` : aucun lien. */
  readonly payerOf: (line: ReceivableItem) => string | null;
  readonly customerName: (line: ReceivableItem) => string;
}) {
  const { t } = useTranslation();
  const byCustomer = grouping === 'customer';
  return (
    <li className="line-card" aria-label={name}>
      <p>
        <strong>{name}</strong> · {formatMoney(group.balanceXaf)}
      </p>
      {group.overdueXaf > 0 ? (
        <p className="text-warn">
          {t('receivables.group_overdue', {
            amount: formatMoney(group.overdueXaf),
            count: group.maxDaysOverdue,
          })}
        </p>
      ) : (
        <p className="home-muted">{t('receivables.group_not_due')}</p>
      )}
      <p className="home-muted">
        {t('receivables.group_sales', {
          count: group.lines.length,
          date: formatBusinessDate(group.oldestDueDate),
        })}
      </p>
      <div className="result-actions">
        {phone ? (
          <a className="action action-compact" href={telHref(phone)}>
            <span className="action-label">{t('receivables.call', { phone })}</span>
          </a>
        ) : null}
        {groupPayer !== null && onDevice ? (
          <Link to={ROUTES.customer(groupPayer)} className="action action-compact">
            <span className="action-label">{t('receivables.customer_sheet', { name })}</span>
          </Link>
        ) : null}
        {groupPayer !== null && mayCollect ? (
          <Link to={ROUTES.collectFor(groupPayer)} className="action action-compact">
            <span className="action-label">{t('receivables.collect', { name })}</span>
          </Link>
        ) : null}
        <button type="button" className="secondary" aria-expanded={opened} onClick={onToggle}>
          {t(
            self
              ? opened
                ? 'receivables.hide_sales_self'
                : 'receivables.show_sales_self'
              : opened
                ? 'receivables.hide_sales'
                : 'receivables.show_sales',
            { name },
          )}
        </button>
      </div>
      {opened ? (
        <ul className="doc-list">
          {group.lines.map((line) => (
            <li key={line.saleId} className="doc-row sale-row" aria-label={line.docNumber}>
              <div className="doc-main">
                <p>
                  <strong>{line.docNumber}</strong>
                  {byCustomer ? null : ` · ${customerName(line)}`}
                </p>
                <p className="home-muted">
                  {t('receivables.sale_dates', {
                    sold: formatBusinessDate(businessDayOf(new Date(line.occurredAt))),
                    due: formatBusinessDate(line.dueDate),
                  })}
                </p>
                <p className={line.overdue ? 'text-warn' : 'home-muted'}>
                  {line.overdue
                    ? t('receivables.days_overdue', { count: line.daysOverdue })
                    : t('receivables.sale_not_due')}
                </p>
              </div>
              <div className="doc-side">
                <p>
                  {t('receivables.sale_balance', {
                    balance: formatMoney(line.balanceDueXaf),
                    total: formatMoney(line.netTotalXaf),
                    paid: formatMoney(line.amountPaidXaf),
                  })}
                </p>
                {mayCollect && payerOf(line) !== null ? (
                  <Link
                    to={ROUTES.collectFor(payerOf(line) ?? '', line.saleId)}
                    className="action action-compact"
                  >
                    <span className="action-label">
                      {t('receivables.collect_sale', { doc: line.docNumber })}
                    </span>
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
