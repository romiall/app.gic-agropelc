/**
 * ECR-CRM-06 « Réaffectation de clients » (RP-3 ; UC-CRM-04 ; `crm.customer.reassign`).
 * En ligne seulement : lecture des comptes clients dans la portée (`GET /customers`), filtrage par
 * titulaire actuel, stade et recherche texte, puis réaffectation motivée vers un commercial actif.
 */
import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ROUTES } from '../../app/screens.js';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type Pages,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import { stageTone } from './stage.js';
import {
  ACTIVE_USERS_PATH,
  buildOwnerCatalog,
  CUSTOMERS_PATH,
  filterReassignCustomers,
  REASSIGN_REASON_MAX,
  REASSIGN_STAGE_FILTERS,
  reassignPayload,
  reassignProblem,
  type CommercialUserOption,
  type OnlineTeamRow,
  type OnlineUserRow,
  type ReassignCustomerView,
  type ReassignStageFilter,
} from './reassign.js';
import '../users/admin.css';
import './crm.css';

const COMMAND_TYPE = 'crm.customer.reassign';
const MAX_PAGES = 5;

interface ReassignFormProps {
  readonly customer: ReassignCustomerView;
  readonly options: readonly CommercialUserOption[];
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (newOwnerUserId: string, reason: string) => void;
}

function ReassignForm({ customer, options, blocked, onCancel, onConfirm }: ReassignFormProps) {
  const { t } = useTranslation();
  const candidates = options.filter((option) => option.id !== customer.ownerUserId);
  const [newOwnerUserId, setNewOwnerUserId] = useState(candidates[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const problem = reassignProblem(customer.ownerUserId, newOwnerUserId, reason);

  return (
    <div
      className="adm-panel"
      role="group"
      aria-label={t('reassign.form_aria', { name: customer.displayName })}
    >
      <Field label={t('reassign.new_owner_label')}>
        {(control) => (
          <Select
            {...control}
            value={newOwnerUserId}
            onChange={(event) => setNewOwnerUserId(event.target.value)}
          >
            <option value="">{t('reassign.new_owner_placeholder')}</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.phone
                  ? `${candidate.fullName} (${candidate.phone})`
                  : candidate.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('reassign.reason_label')} hint={t('reassign.reason_hint')}>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            maxLength={REASSIGN_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <div className="adm-actions">
        <Button
          disabled={blocked || problem !== null}
          onClick={() => onConfirm(newOwnerUserId, reason)}
        >
          {t('reassign.confirm')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('price_rules.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function ReassignCustomersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const [stage, setStage] = useState<ReassignStageFilter>('ALL');
  const [ownerFilter, setOwnerFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [openCustomerId, setOpenCustomerId] = useState<string | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const searchId = useId();

  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const lastCommand = outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(outbox, COMMAND_TYPE, userId);
  const syncKey = `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, COMMAND_TYPE, userId)}`;

  const customersRead = useOnlineRead<Pages<ReassignCustomerView>>(
    online ? CUSTOMERS_PATH : null,
    (path) => readPages<ReassignCustomerView>([path], 'customers', MAX_PAGES),
    online,
    syncKey,
  );
  const usersRead = useOnlineRead<Pages<OnlineUserRow>>(
    online ? ACTIVE_USERS_PATH : null,
    (path) => readPages<OnlineUserRow>([path], 'users', MAX_PAGES),
    online,
    syncKey,
  );
  const teamsRead = useOnlineRead<{ readonly teams: readonly OnlineTeamRow[] }>(
    online ? '/api/v1/teams' : null,
    (path) => readPath<{ readonly teams: readonly OnlineTeamRow[] }>(path),
    online,
    syncKey,
  );
  useRefreshOnVisible(customersRead.retry);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.reassign_customers')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.reassign_customers')} />
        <Banner tone="muted" role="status">
          {t('reassign.online_only')}
        </Banner>
      </section>
    );
  }

  const waiting =
    (last !== undefined && (lastCommand === undefined || isBlockingWait(lastCommand, outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || customersRead.stale;
  const adopt = last ? undefined : lastWaitingCommand(outbox, COMMAND_TYPE, userId);
  if (adopt) setLast(adopt.command_id);

  const { namesById, options } = buildOwnerCatalog(
    usersRead.data?.items ?? [],
    teamsRead.data?.teams ?? [],
    refs?.users ?? [],
  );
  const allCustomers = customersRead.data?.items ?? [];
  const rows = filterReassignCustomers(allCustomers, { stage, ownerFilter, query });
  const ownerName = (id: string | null) =>
    id ? (namesById.get(id) ?? t('reassign.owner_unknown')) : t('reassign.owner_none');

  const send = async (customer: ReassignCustomerView, newOwnerUserId: string, reason: string) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: COMMAND_TYPE,
        aggregateType: 'CUSTOMER',
        aggregateId: customer.id,
        payload: reassignPayload(newOwnerUserId, reason),
      });
      setLast(command.command_id);
      setOpenCustomerId(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale adm-screen">
      <PageHeader
        title={t('nav.screens.reassign_customers')}
        actions={
          customersRead.data && !customersRead.failed ? (
            <Button
              variant="tonal"
              icon="sync"
              disabled={customersRead.stale}
              onClick={customersRead.retry}
            >
              {t('reassign.refresh')}
            </Button>
          ) : undefined
        }
      />
      <HelpDisclosure title={t('reassign.help_title')}>
        <p>{t('reassign.intro')}</p>
      </HelpDisclosure>
      {last ? <CommandResult commandId={last} messages="reassign.result" /> : null}
      {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
      <div className="adm-toolbar">
        <Segmented
          label={t('portfolio.stage_label')}
          value={stage}
          onChange={setStage}
          options={REASSIGN_STAGE_FILTERS.map((value) => ({
            value,
            label:
              value === 'ALL'
                ? t('portfolio.stage_all_short')
                : t(`portfolio.stage_filter.${value}`),
          }))}
        />
        <Field label={t('reassign.owner_filter_label')}>
          {(control) => (
            <Select
              {...control}
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
            >
              <option value="ALL">{t('reassign.owner_filter_all')}</option>
              <option value="UNASSIGNED">{t('reassign.owner_none')}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="field">
          <label htmlFor={searchId} className="visually-hidden">
            {t('sales.customer_search')}
          </label>
          <div className="crm-search">
            <Icon name="search" size={18} />
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder={t('sales.customer_search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </div>

      {customersRead.data === undefined && !customersRead.failed ? <SkeletonRows rows={4} /> : null}
      {customersRead.failed ? (
        <Banner
          tone="bad"
          action={
            customersRead.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={customersRead.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {customersRead.denied ? t('reassign.denied') : t('reassign.read_error')}
        </Banner>
      ) : null}
      {customersRead.data && customersRead.stale && !customersRead.failed ? (
        <p className="adm-note" role="status">
          {t('reassign.refreshing')}
        </p>
      ) : null}
      {customersRead.data && rows.length === 0 ? (
        <EmptyState icon="users" title={t('reassign.empty')} />
      ) : null}
      {customersRead.data && rows.length > 0 ? (
        <ul className="adm-cards" aria-label={t('nav.screens.reassign_customers')}>
          {rows.map((customer) => {
            const zone = refs?.zones.get(customer.zoneId)?.name ?? null;
            const isOpen = openCustomerId === customer.id;
            return (
              <li key={customer.id} className="line-card" aria-label={customer.displayName}>
                <div className="adm-card-head">
                  <div className="crm-who">
                    <Avatar name={customer.displayName} />
                    <div className="crm-who-text">
                      <Link to={ROUTES.customer(customer.id)} className="adm-title">
                        {customer.displayName}
                      </Link>
                      <small className="adm-sub">
                        {[customer.phonePrimary, zone].filter(Boolean).join(' · ')}
                      </small>
                    </div>
                  </div>
                  <div className="adm-title-line">
                    <Badge tone={stageTone(customer.stage)}>
                      {t(`portfolio.stage.${customer.stage}`, { defaultValue: customer.stage })}
                    </Badge>
                    <Badge tone={customer.ownerUserId ? 'info' : 'warn'}>
                      {t('reassign.current_owner', { owner: ownerName(customer.ownerUserId) })}
                    </Badge>
                  </div>
                </div>
                {isOpen ? (
                  <ReassignForm
                    customer={customer}
                    options={options}
                    blocked={blocked}
                    onCancel={() => setOpenCustomerId(null)}
                    onConfirm={(newOwner, reason) => void send(customer, newOwner, reason)}
                  />
                ) : (
                  <div className="adm-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={blocked || options.length === 0}
                      onClick={() => setOpenCustomerId(customer.id)}
                    >
                      {t('reassign.open_action')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
