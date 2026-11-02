/**
 * Onglet « Points de vente » de l'écran Organisation (ECR-ADM-06 ; UC-DIS-01 ; BR-DIS-002, BR-DIS-014 ; ADR-033) :
 * configuration d'un point de vente — emplacement de vente (type `POS` du site), magasin source du
 * réapprovisionnement (`STORE` d'un autre site), mode de garde (partagé, ou appareil désigné) et horaires.
 * La commande `organization.pos.configure` est idempotente (le site est son agrégat) : configurer de nouveau
 * revient à modifier. Les refus du serveur (appareil rattaché ailleurs, quotas actifs, appareil encore chargé
 * d'opérations…) s'affichent tels quels.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAdminRead } from '../admin/admin-online.js';
import { readPath, useOnlineRead, type ReadResult } from '../sales/online-read.js';
import {
  CUSTODY_MODES,
  EMPTY_POS_FORM,
  LIMITS,
  locationsPath,
  posConfigureCommand,
  posFormOf,
  posProblems,
  salesLocationChoices,
  sourceChoices,
  type LocationView,
  type PosForm,
  type PosView,
} from './organization.js';
import { panelBlocked, type PanelProps } from './panel-props.js';

interface LocationsRead {
  readonly locations: readonly LocationView[];
}

/** Emplacements de plusieurs sites, par site (magasins sources possibles). */
function useLocationsOfSites(siteIds: readonly string[], reloadKey: string) {
  const online = useOnline();
  const key = siteIds.length > 0 ? `locations:${siteIds.join(',')}` : null;
  return useOnlineRead<ReadonlyMap<string, readonly LocationView[]>>(
    online ? key : null,
    async (value): Promise<ReadResult<ReadonlyMap<string, readonly LocationView[]>>> => {
      const ids = value.slice('locations:'.length).split(',');
      const results = await Promise.all(
        ids.map((id) => readPath<LocationsRead>(locationsPath(id))),
      );
      const bySite = new Map<string, readonly LocationView[]>();
      for (const [index, result] of results.entries()) {
        if (!result.ok) return result;
        bySite.set(ids[index] ?? '', result.data.locations);
      }
      return { ok: true, data: bySite };
    },
    online,
    reloadKey,
  );
}

interface PosFormBlockProps extends PanelProps {
  readonly siteId: string;
  readonly initial: PosForm;
  readonly onDone: () => void;
}

function PosFormBlock({ siteId, initial, onDone, data, commands }: PosFormBlockProps) {
  const { t } = useTranslation();
  const blocked = panelBlocked({ data, commands });
  const [form, setForm] = useState<PosForm>(initial);
  const own = useAdminRead<LocationsRead>(locationsPath(siteId), data.reloadKey);
  const otherSiteIds = data.sites
    .filter((site) => site.id !== siteId && site.status === 'ACTIVE')
    .map((site) => site.id);
  const others = useLocationsOfSites(otherSiteIds, data.reloadKey);
  const salesChoices = salesLocationChoices(own.data?.locations ?? []);
  const sources = others.data ? sourceChoices(others.data, siteId) : [];
  const problems = posProblems(form);
  const loading =
    (own.data === undefined && !own.failed) || (others.data === undefined && !others.failed);

  const save = async () => {
    if (await commands.send(posConfigureCommand(siteId, form), blocked)) onDone();
  };

  return (
    <div className="adm-form adm-panel">
      {own.failed || others.failed ? (
        <Banner tone="bad">{t('org.pos.locations_unavailable')}</Banner>
      ) : null}
      {!loading && salesChoices.length === 0 ? (
        <Banner tone="warn">{t('org.pos.no_sales_location')}</Banner>
      ) : null}
      <Field label={t('org.field.sales_location')} hint={t('org.hint.sales_location')}>
        {(control) => (
          <Select
            {...control}
            value={form.salesLocationId}
            onChange={(event) => setForm({ ...form, salesLocationId: event.target.value })}
          >
            <option value="">{t('org.choose')}</option>
            {salesChoices.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('org.field.source_location')} optional hint={t('org.hint.source_location')}>
        {(control) => (
          <Select
            {...control}
            value={form.replenishmentSourceLocationId}
            onChange={(event) =>
              setForm({ ...form, replenishmentSourceLocationId: event.target.value })
            }
          >
            <option value="">{t('org.none')}</option>
            {sources.map((location) => (
              <option key={location.id} value={location.id}>
                {`${data.sites.find((site) => site.id === location.siteId)?.name ?? ''} · ${location.name}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Segmented
        label={t('org.field.custody_mode')}
        value={form.custodyMode}
        onChange={(custodyMode) =>
          setForm({
            ...form,
            custodyMode,
            designatedDeviceId: custodyMode === 'SHARED' ? '' : form.designatedDeviceId,
          })
        }
        options={CUSTODY_MODES.map((mode) => ({ value: mode, label: t(`org.custody.${mode}`) }))}
      />
      <p className="adm-note">{t(`org.custody_hint.${form.custodyMode}`)}</p>
      {form.custodyMode === 'EXCLUSIVE_DEVICE' ? (
        <Field label={t('org.field.designated_device')} hint={t('org.hint.designated_device')}>
          {(control) => (
            <Select
              {...control}
              value={form.designatedDeviceId}
              onChange={(event) => setForm({ ...form, designatedDeviceId: event.target.value })}
            >
              <option value="">{t('org.choose')}</option>
              {data.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <Field label={t('org.field.opening_hours')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={LIMITS.openingHours}
            value={form.openingHours}
            onChange={(event) => setForm({ ...form, openingHours: event.target.value })}
          />
        )}
      </Field>
      <div className="adm-actions">
        <Button disabled={blocked || loading || problems.length > 0} onClick={() => void save()}>
          {t('org.pos.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('org.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function PosPanel(props: PanelProps) {
  const { t } = useTranslation();
  const { data } = props;
  const blocked = panelBlocked(props);
  const [creatingFor, setCreatingFor] = useState<string | null | 'CHOOSE'>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const configured = new Set(data.pointsOfSale.map((point) => point.siteId));
  const candidates = data.sites.filter(
    (site) =>
      site.siteType === 'POINT_DE_VENTE' && site.status === 'ACTIVE' && !configured.has(site.id),
  );
  const deviceLabel = (id: string | null) =>
    id
      ? (data.devices.find((device) => device.id === id)?.label ?? t('org.pos.device_unknown'))
      : null;

  const card = (point: PosView) => (
    <li
      key={point.siteId}
      className="line-card"
      aria-label={t('org.pos.card', { name: point.siteName })}
    >
      <div className="adm-card-head">
        <span className="adm-card-title">
          <strong>{point.siteName}</strong>
          <span className="adm-sub">
            {[
              point.siteCode,
              t(`org.custody.${point.custodyMode}`),
              deviceLabel(point.designatedDeviceId),
              point.openingHours,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <Badge tone={point.siteStatus === 'ACTIVE' ? 'ok' : 'muted'}>
          {t(`org.site_status.${point.siteStatus}`, { defaultValue: point.siteStatus })}
        </Badge>
      </div>
      {editing === point.siteId ? (
        <PosFormBlock
          {...props}
          siteId={point.siteId}
          initial={posFormOf(point)}
          onDone={() => setEditing(null)}
        />
      ) : (
        <div className="adm-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={blocked || point.siteStatus !== 'ACTIVE'}
            onClick={() => {
              setCreatingFor(null);
              setEditing(point.siteId);
            }}
          >
            {t('org.edit')}
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <>
      <div className="adm-actions org-toolbar">
        <Button
          variant="tonal"
          icon="plus"
          disabled={blocked || candidates.length === 0 || creatingFor !== null}
          onClick={() => {
            setEditing(null);
            setCreatingFor('CHOOSE');
          }}
        >
          {t('org.pos.new')}
        </Button>
        {candidates.length === 0 && creatingFor === null ? (
          <span className="adm-note">{t('org.pos.needs_site')}</span>
        ) : null}
      </div>
      {creatingFor !== null ? (
        <div className="card adm-create" role="group" aria-label={t('org.pos.new')}>
          <h2>{t('org.pos.new')}</h2>
          <Field label={t('org.field.pos_site')}>
            {(control) => (
              <Select
                {...control}
                value={creatingFor === 'CHOOSE' ? '' : creatingFor}
                onChange={(event) => setCreatingFor(event.target.value || 'CHOOSE')}
              >
                <option value="">{t('org.choose')}</option>
                {candidates.map((site) => (
                  <option key={site.id} value={site.id}>
                    {`${site.name} (${site.code})`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {creatingFor !== 'CHOOSE' ? (
            <PosFormBlock
              key={creatingFor}
              {...props}
              siteId={creatingFor}
              initial={EMPTY_POS_FORM}
              onDone={() => setCreatingFor(null)}
            />
          ) : (
            <div className="adm-actions">
              <Button variant="ghost" onClick={() => setCreatingFor(null)}>
                {t('org.cancel')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {data.pointsOfSale.length === 0 ? (
        <EmptyState icon="store" title={t('org.pos.empty')} />
      ) : (
        <ul className="adm-cards">{data.pointsOfSale.map(card)}</ul>
      )}
    </>
  );
}
