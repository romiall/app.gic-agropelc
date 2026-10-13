/**
 * ECR-ADM-05 « Appareils » (MP-06 ; UC-ADM-06 ; SM-DEVICE ; BR-ADM-025). En ligne seulement. Liste des
 * appareils de la portée du lecteur (`GET /devices`), filtrée par état (en attente par défaut) et par une
 * recherche locale ; décisions `identity.device.*` proposées selon l'état de l'appareil et les actions que
 * le serveur déclare permises au lecteur (auto-approbation exclue, AV-258). Relue après chaque décision ;
 * la suivante attend la réponse définitive de la précédente.
 */
import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { readPages, useOnlineRead, type Pages } from '../sales/online-read.js';
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

const PREFIX = 'identity.device.';
/** Pages lues au plus pour un filtre (200 appareils chacune). */
const MAX_PAGES = 5;

const STATUS_BADGE: Record<string, string> = {
  PENDING: 'badge-warn',
  ACTIVE: 'badge-ok',
  BLOCKED: 'badge-warn',
  LOST: 'badge-muted',
  RETIRED: 'badge-muted',
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
  const ids = { reason: useId(), site: useId() };
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
    <div className="sale-block" role="group" aria-label={t(`devices.action.${action}`)}>
      {loosesThisDevice ? (
        <p className="text-warn" role="alert">
          {t('devices.this_device_warning')}
        </p>
      ) : null}
      {action === 'DESIGNATE' ? (
        <>
          <label className="choice">
            <input
              type="checkbox"
              checked={designation.isShared}
              onChange={(event) =>
                setDesignation((current) => ({ ...current, isShared: event.target.checked }))
              }
            />
            {t('devices.shared_label')}
          </label>
          <div className="field">
            <label htmlFor={ids.site}>{t('devices.site_label')}</label>
            <select
              id={ids.site}
              className="text-input"
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
            </select>
          </div>
        </>
      ) : null}
      {rule !== 'NONE' ? (
        <div className="field">
          <label htmlFor={ids.reason}>
            {rule === 'REQUIRED' ? t('devices.reason_required') : t('devices.reason_optional')}
          </label>
          <textarea
            id={ids.reason}
            className="text-input"
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      ) : null}
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          onClick={() => onConfirm({ reason, ...(action === 'DESIGNATE' ? { designation } : {}) })}
        >
          {t(`devices.confirm.${action}`, { code: device.shortCode })}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
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
  const searchId = useId();
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

  if (!userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.devices')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.devices')}</h1>
        <p className="home-muted">{t('devices.online_only')}</p>
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
    <section className="sale">
      <h1>{t('nav.screens.devices')}</h1>
      <p className="home-muted">{t('devices.intro')}</p>
      {last ? <CommandResult commandId={last} messages="devices.result" /> : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('devices.filter_label')}</legend>
        {DEVICE_FILTERS.map((option) => (
          <label key={option} className="choice">
            <input
              type="radio"
              name="device-filter"
              checked={filter === option}
              onChange={() => {
                setFilter(option);
                setOpen(null);
              }}
            />
            {t(`devices.filter.${option}`)}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={searchId}>{t('devices.search_label')}</label>
        <input
          id={searchId}
          className="text-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {devices === undefined && !read.failed ? (
        <p className="home-muted">{t('sales.loading')}</p>
      ) : null}
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{read.denied ? t('devices.denied') : t('devices.unavailable')}</p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
          )}
        </div>
      ) : null}
      {devices && read.stale && !read.failed ? (
        <p className="home-muted" role="status">
          {t('devices.refreshing')}
        </p>
      ) : null}
      {read.data?.more ? <p className="home-muted">{t('devices.truncated')}</p> : null}
      {devices && devices.length === 0 ? (
        <p className="home-muted">{t(`devices.none.${filter}`)}</p>
      ) : null}
      {devices && devices.length > 0 ? (
        <ul className="line-list">
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
                <div className="line-head">
                  <strong>{t('devices.card_label', { code: device.shortCode })}</strong>
                  <span className={`badge ${STATUS_BADGE[device.status] ?? 'badge-muted'}`}>
                    {t(`devices.status.${device.status}`, { defaultValue: device.status })}
                  </span>
                </div>
                {thisDevice ? <p className="home-muted">{t('devices.this_device')}</p> : null}
                <p className="home-muted">
                  {[
                    device.platform,
                    t('devices.enrolled', {
                      name: device.enrolledByName ?? t('devices.unknown_user'),
                      date: formatDateTime(device.createdAt),
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className={device.stale ? 'text-warn' : 'home-muted'}>
                  {device.lastContactAt
                    ? t(device.stale ? 'devices.contact_stale' : 'devices.contact', {
                        date: formatDateTime(device.lastContactAt),
                      })
                    : t('devices.contact_never')}
                </p>
                {device.isShared || site ? (
                  <p className="home-muted">
                    {[
                      device.isShared ? t('devices.shared') : null,
                      site ? t('devices.site', { name: site }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                {device.statusReason && device.status !== 'ACTIVE' ? (
                  <p className="home-muted">
                    {t('devices.reason', { reason: device.statusReason })}
                  </p>
                ) : null}
                {selfPending ? <p className="home-muted">{t('devices.self_pending')}</p> : null}
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
                  <div className="result-actions">
                    {actions.map((action) =>
                      action === 'APPROVE' || action === 'UNBLOCK' ? (
                        <button
                          key={action}
                          type="button"
                          className="secondary"
                          disabled={blocked}
                          onClick={() => void send(device, action, { reason: '' })}
                        >
                          {t(`devices.action.${action}`, { code: device.shortCode })}
                        </button>
                      ) : (
                        <button
                          key={action}
                          type="button"
                          className="secondary"
                          aria-expanded={false}
                          disabled={blocked}
                          onClick={() => setOpen({ deviceId: device.id, action })}
                        >
                          {t(`devices.action.${action}`, { code: device.shortCode })}
                        </button>
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
