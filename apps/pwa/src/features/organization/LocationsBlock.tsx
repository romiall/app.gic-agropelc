/**
 * Emplacements d'un site (ECR-ADM-06, onglet « Sites ») : liste lue sur `GET /locations?site_id=`, création,
 * modification du nom et de la capacité, désactivation. Le type, le code et le site d'un emplacement ne se
 * changent pas (AV-497) ; un emplacement virtuel n'est jamais modifié ici.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  Field,
  Input,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { useAdminRead } from '../admin/admin-online.js';
import {
  EMPTY_LOCATION_FORM,
  LIMITS,
  LOCATION_TYPES,
  locationCreateCommand,
  locationDeactivateCommand,
  locationProblems,
  locationUpdateCommand,
  locationsPath,
  parseCapacity,
  type LocationForm,
  type LocationView,
  type SiteView,
} from './organization.js';
import { panelBlocked, type PanelProps } from './panel-props.js';

interface LocationsBlockProps extends PanelProps {
  readonly site: SiteView;
}

interface LocationsRead {
  readonly site: SiteView;
  readonly locations: readonly LocationView[];
}

export function LocationsBlock({ site, data, commands }: LocationsBlockProps) {
  const { t } = useTranslation();
  const blocked = panelBlocked({ data, commands });
  const read = useAdminRead<LocationsRead>(locationsPath(site.id), data.reloadKey);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<LocationForm>(EMPTY_LOCATION_FORM);
  const [editing, setEditing] = useState<{ id: string; name: string; capacity: string } | null>(
    null,
  );
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const locations = read.data?.locations;
  const active = site.status === 'ACTIVE';
  const problems = locationProblems(form);
  const capacityInvalid = problems.includes('CAPACITY');

  const create = async () => {
    const sent = await commands.send(
      locationCreateCommand(site.id, form, idGenerator.newId()),
      blocked,
    );
    if (sent) {
      setCreating(false);
      setForm(EMPTY_LOCATION_FORM);
    }
  };

  const saveEdit = async (locationId: string) => {
    if (!editing) return;
    if (await commands.send(locationUpdateCommand(locationId, editing), blocked)) setEditing(null);
  };

  const deactivate = async (locationId: string) => {
    if (await commands.send(locationDeactivateCommand(locationId), blocked)) setDeactivating(null);
  };

  return (
    <div
      className="adm-panel"
      role="group"
      aria-label={t('org.locations.title', { name: site.name })}
    >
      <h3 className="org-subtitle">{t('org.locations.title', { name: site.name })}</h3>
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
          {read.denied ? t('org.denied') : t('org.locations.unavailable')}
        </Banner>
      ) : null}
      {locations === undefined && !read.failed ? <SkeletonRows rows={2} /> : null}
      {locations && locations.length === 0 ? (
        <p className="adm-note">{t('org.locations.empty')}</p>
      ) : null}
      {locations && locations.length > 0 ? (
        <ul className="org-locations">
          {locations.map((location) => {
            const isEditing = editing?.id === location.id;
            return (
              <li key={location.id}>
                <div className="org-location-head">
                  <span className="adm-card-title">
                    <strong>{location.name}</strong>
                    <span className="adm-sub">
                      {[
                        location.code,
                        t(`org.location_type.${location.locationType}`, {
                          defaultValue: location.locationType,
                        }),
                        location.capacity !== null
                          ? t('org.locations.capacity', { count: location.capacity })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge tone={location.status === 'ACTIVE' ? 'ok' : 'muted'}>
                    {t(`org.location_status.${location.status}`)}
                  </Badge>
                </div>
                {location.status === 'ACTIVE' && !location.isVirtual && !isEditing ? (
                  <div className="adm-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      onClick={() => {
                        setDeactivating(null);
                        setEditing({
                          id: location.id,
                          name: location.name,
                          capacity: location.capacity === null ? '' : String(location.capacity),
                        });
                      }}
                    >
                      {t('org.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      onClick={() => {
                        setEditing(null);
                        setDeactivating(deactivating === location.id ? null : location.id);
                      }}
                    >
                      {t('org.locations.deactivate')}
                    </Button>
                  </div>
                ) : null}
                {isEditing ? (
                  <div className="adm-form">
                    <Field label={t('org.field.name')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={LIMITS.name}
                          value={editing.name}
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        />
                      )}
                    </Field>
                    <Field
                      label={t('org.field.capacity')}
                      optional
                      error={
                        parseCapacity(editing.capacity) === 'INVALID'
                          ? t('org.problem.CAPACITY')
                          : undefined
                      }
                    >
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="numeric"
                          value={editing.capacity}
                          onChange={(event) =>
                            setEditing({ ...editing, capacity: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <div className="adm-actions">
                      <Button
                        disabled={
                          blocked ||
                          editing.name.trim() === '' ||
                          parseCapacity(editing.capacity) === 'INVALID'
                        }
                        onClick={() => void saveEdit(location.id)}
                      >
                        {t('org.save')}
                      </Button>
                      <Button variant="ghost" onClick={() => setEditing(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {deactivating === location.id ? (
                  <div className="adm-form">
                    <Banner tone="warn">{t('org.locations.deactivate_warning')}</Banner>
                    <div className="adm-actions">
                      <Button
                        variant="danger"
                        disabled={blocked}
                        onClick={() => void deactivate(location.id)}
                      >
                        {t('org.locations.deactivate_confirm', { name: location.name })}
                      </Button>
                      <Button variant="ghost" onClick={() => setDeactivating(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {active && locations !== undefined && !creating ? (
        <div className="adm-actions">
          <Button variant="tonal" icon="plus" disabled={blocked} onClick={() => setCreating(true)}>
            {t('org.locations.new')}
          </Button>
        </div>
      ) : null}
      {creating ? (
        <div className="adm-form" role="group" aria-label={t('org.locations.new')}>
          <Field
            label={t('org.field.code')}
            hint={t('org.hint.code', { max: LIMITS.locationCode })}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={LIMITS.locationCode}
                autoCapitalize="characters"
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('org.field.name')}>
            {(control) => (
              <Input
                {...control}
                maxLength={LIMITS.name}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('org.field.location_type')}>
            {(control) => (
              <Select
                {...control}
                value={form.locationType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    locationType: event.target.value as LocationForm['locationType'],
                    custodianUserId: '',
                  })
                }
              >
                {LOCATION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`org.location_type.${type}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {form.locationType === 'MOBILE' ? (
            <Field label={t('org.field.custodian')} hint={t('org.hint.custodian')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.custodianUserId}
                  onChange={(event) => setForm({ ...form, custodianUserId: event.target.value })}
                >
                  <option value="">{t('org.choose')}</option>
                  {data.users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label={t('org.field.parent_location')} optional>
            {(control) => (
              <Select
                {...control}
                value={form.parentLocationId}
                onChange={(event) => setForm({ ...form, parentLocationId: event.target.value })}
              >
                <option value="">{t('org.none')}</option>
                {(locations ?? [])
                  .filter((location) => location.status === 'ACTIVE')
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('org.field.capacity')}
            optional
            error={capacityInvalid ? t('org.problem.CAPACITY') : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={form.capacity}
                onChange={(event) => setForm({ ...form, capacity: event.target.value })}
              />
            )}
          </Field>
          <div className="adm-actions">
            <Button disabled={blocked || problems.length > 0} onClick={() => void create()}>
              {t('org.locations.create_confirm')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setForm(EMPTY_LOCATION_FORM);
              }}
            >
              {t('org.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
