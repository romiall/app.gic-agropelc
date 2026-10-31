/**
 * ECR-ADM-05 « Appareils » (MP-06 ; UC-ADM-06 ; SM-DEVICE ; BR-ADM-025). En ligne seulement. Liste des
 * appareils de la portée du lecteur (`GET /devices`), filtrée par état (en attente par défaut) et par une
 * recherche locale ; décisions `identity.device.*` proposées selon l'état de l'appareil et les actions que
 * le serveur déclare permises au lecteur (auto-approbation exclue, AV-258). Relue après chaque décision ;
 * la suivante attend la réponse définitive de la précédente. Relue aussi par « Actualiser » et au retour
 * sur l'onglet (MP-11) : l'appareil attendu apparaît sans quitter l'écran.
 *
 * Refonte (ADR-049, lot L9) : filtre d'état en contrôle segmenté, explication repliée, appareils en cartes
 * avec pastille d'état, décision dans un formulaire sous la carte. `DeviceApprovalBanner` est du lot L2.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { readPages, useOnlineRead, useRefreshOnVisible, type Pages } from '../sales/online-read.js';
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
import {
  actionsFor,
  canSend,
  commandOf,
  DEVICE_FILTERS,
  devicesPath,
  matchesSearch,
  REASON_MAX,
  reasonRule,
  type DesignationForm,
  type DeviceAction,
  type DeviceFilter,
  type DeviceView,
} from './devices.js';
import '../users/admin.css';

const PREFIX = 'identity.device.';
/** Pages lues au plus pour un filtre (200 appareils chacune). */
const MAX_PAGES = 5;

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  PENDING: 'warn',
  ACTIVE: 'ok',
  BLOCKED: 'bad',
  LOST: 'muted',
  RETIRED: 'muted',
};

interface DecisionProps {
  readonly device: DeviceView;
  readonly action: DeviceAction;
  readonly thisDevice: boolean;
  readonly sites: readonly { readonly id: string; readonly name: string }[];
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input: { reason: string; designation?: DesignationForm }) => void;
}

function DecisionForm({
  device,
  action,
  thisDevice,
  sites,
  blocked,
  onCancel,
  onConfirm,
}: DecisionProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [designation, setDesignation] = useState<DesignationForm>({
    isShared: device.isShared,
    siteId: device.designatedSiteId ?? '',
  });
  const rule = reasonRule(action);
  const ready = !blocked && canSend(action, reason);
  const loosesThisDevice =
    thisDevice && (action === 'BLOCK' || action === 'LOST' || action === 'RETIRE');
  return (
    <div
      className="adm-panel"
      role="group"
      aria-label={t(`devices.action.${action}`, { code: device.shortCode })}
    >
      {loosesThisDevice ? <Banner tone="warn">{t('devices.this_device_warning')}</Banner> : null}
      {action === 'DESIGNATE' ? (
        <>
          <Checkbox
            checked={designation.isShared}
            onChange={(event) =>
              setDesignation((current) => ({ ...current, isShared: event.target.checked }))
            }
            label={t('devices.shared_label')}
          />
          <Field label={t('devices.site_label')}>
            {(control) => (
              <Select
                {...control}
                value={designation.siteId}
                onChange={(event) =>
                  setDesignation((current) => ({ ...current, siteId: event.target.value }))
                }
              >
                <option value="">{t('devices.no_site')}</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      ) : null}
      {rule !== 'NONE' ? (
        <Field
          label={rule === 'REQUIRED' ? t('devices.reason_required') : t('devices.reason_optional')}
        >
          {(control) => (
            <Textarea
              {...control}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      <div className="adm-actions">
        <Button
          disabled={!ready}
          onClick={() => onConfirm({ reason, ...(action === 'DESIGNATE' ? { designation } : {}) })}
        >
          {t(`devices.confirm.${action}`, { code: device.shortCode })}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('price_rules.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function DevicesScreen() {
  const { t } = useTranslation();
  const { state, deviceId: thisDeviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const [filter, setFilter] = useState<DeviceFilter>('PENDING');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ deviceId: string; action: DeviceAction } | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Commandes d'appareil lues dans la base locale (les références de vente ne les gardent pas).
  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const lastCommand = outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(outbox, PREFIX, userId);
  const read = useOnlineRead<Pages<DeviceView>>(
    online ? devicesPath(filter) : null,
    (path) => readPages<DeviceView>([path], 'devices', MAX_PAGES),
    online,
    `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, PREFIX, userId)}`,
  );
  useRefreshOnVisible(read.retry);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.devices')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.devices')} />
        <Banner tone="muted" role="status">
          {t('devices.online_only')}
        </Banner>
      </section>
    );
  }

  const waiting =
    (last !== undefined && (lastCommand === undefined || isBlockingWait(lastCommand, outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || read.stale;
  const adopt = last ? undefined : lastWaitingCommand(outbox, PREFIX, userId);
  if (adopt) setLast(adopt.command_id);
  const devices = read.data
    ? read.data.items.filter((device) => matchesSearch(device, search))
    : undefined;
  const sites = refs
    ? [...refs.sites.values()]
        .filter((site) => site.status === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    : [];
  const siteName = (id: string | null) => (id ? (refs?.sites.get(id)?.name ?? null) : null);

  const send = async (
    device: DeviceView,
    action: DeviceAction,
    input: { reason: string; designation?: DesignationForm },
  ) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const { commandType, payload } = commandOf(action, input);
      const command = await submitCommand({
        authorUserId: userId,
        commandType,
        aggregateType: 'DEVICE',
        aggregateId: device.id,
        payload,
      });
      setLast(command.command_id);
      setOpen(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale adm-screen">
      <PageHeader
        title={t('nav.screens.devices')}
        actions={
          devices && !read.failed ? (
            <Button variant="tonal" icon="sync" onClick={read.retry} disabled={read.stale}>
              {t('devices.refresh')}
            </Button>
          ) : undefined
        }
      />
      <HelpDisclosure title={t('devices.help_title')}>
        <p>{t('devices.intro')}</p>
      </HelpDisclosure>
      {last ? <CommandResult commandId={last} messages="devices.result" /> : null}
      {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
      <div className="adm-toolbar">
        <Segmented
          label={t('devices.filter_label')}
          value={filter}
          onChange={(option) => {
            setFilter(option);
            setOpen(null);
          }}
          options={DEVICE_FILTERS.map((option) => ({
            value: option,
            label: t(`devices.filter.${option}`),
          }))}
        />
        <Field label={t('devices.search_label')}>
          {(control) => (
            <Input
              {...control}
              inputMode="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>
      {devices === undefined && !read.failed ? <SkeletonRows /> : null}
      {read.failed ? (
        <Banner
          tone="bad"
          action={
            read.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={read.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {read.denied ? t('devices.denied') : t('devices.unavailable')}
        </Banner>
      ) : null}
      {devices && read.stale && !read.failed ? (
        <p className="adm-note" role="status">
          {t('devices.refreshing')}
        </p>
      ) : null}
      {read.data?.more ? <p className="adm-note">{t('devices.truncated')}</p> : null}
      {devices && devices.length === 0 ? (
        <EmptyState icon="phone" title={t(`devices.none.${filter}`)} />
      ) : null}
      {devices && devices.length > 0 ? (
        <ul className="adm-cards">
          {devices.map((device) => {
            const thisDevice = device.id === thisDeviceId;
            const actions = actionsFor(device);
            const site = siteName(device.designatedSiteId);
            const selfPending =
              device.status === 'PENDING' &&
              !device.actions.approve &&
              device.enrolledByUserId === userId;
            return (
              <li
                key={device.id}
                className="line-card"
                aria-label={t('devices.card_label', { code: device.shortCode })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <span className="adm-title-line">
                      <strong>{t('devices.card_label', { code: device.shortCode })}</strong>
                      {thisDevice ? <Badge tone="brand">{t('devices.this_device')}</Badge> : null}
                    </span>
                    <span className="adm-sub">
                      {[
                        device.platform,
                        t('devices.enrolled', {
                          name: device.enrolledByName ?? t('devices.unknown_user'),
                          date: formatDateTime(device.createdAt),
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[device.status] ?? 'muted'}>
                    {t(`devices.status.${device.status}`, { defaultValue: device.status })}
                  </Badge>
                </div>
                <p className={device.stale ? 'adm-note is-warn' : 'adm-note'}>
                  {device.lastContactAt
                    ? t(device.stale ? 'devices.contact_stale' : 'devices.contact', {
                        date: formatDateTime(device.lastContactAt),
                      })
                    : t('devices.contact_never')}
                </p>
                {device.isShared || site ? (
                  <p className="adm-note">
                    {[
                      device.isShared ? t('devices.shared') : null,
                      site ? t('devices.site', { name: site }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                {device.statusReason && device.status !== 'ACTIVE' ? (
                  <p className="adm-note">{t('devices.reason', { reason: device.statusReason })}</p>
                ) : null}
                {selfPending ? <p className="adm-note">{t('devices.self_pending')}</p> : null}
                {open?.deviceId === device.id ? (
                  <DecisionForm
                    device={device}
                    action={open.action}
                    thisDevice={thisDevice}
                    sites={sites}
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(input) => void send(device, open.action, input)}
                  />
                ) : actions.length > 0 ? (
                  <div className="adm-actions">
                    {actions.map((action) =>
                      action === 'APPROVE' || action === 'UNBLOCK' ? (
                        <Button
                          key={action}
                          variant="tonal"
                          disabled={blocked}
                          onClick={() => void send(device, action, { reason: '' })}
                        >
                          {t(`devices.action.${action}`, { code: device.shortCode })}
                        </Button>
                      ) : (
                        <Button
                          key={action}
                          variant="outline"
                          aria-expanded={false}
                          disabled={blocked}
                          onClick={() => setOpen({ deviceId: device.id, action })}
                        >
                          {t(`devices.action.${action}`, { code: device.shortCode })}
                        </Button>
                      ),
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
