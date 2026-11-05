/**
 * Onglet « Zones » de l'écran Organisation (ECR-ADM-06 ; UC-ADM-02 ; BR-ADM-012, BR-TER-001) : arbre des zones,
 * création, et modification du nom, du géorepère de pointage et de la précision GPS maximale. Le géorepère se
 * saisit en latitude, longitude et rayon, ou par « Ma position » (AV-492, pas de carte). Le code et le niveau
 * d'une zone ne se changent pas (AV-497) ; sa parente, si : « Déplacer » place la zone et ses descendantes sous
 * une autre zone ou à la racine (AV-515).
 */
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import {
  EMPTY_ZONE_FORM,
  LIMITS,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  ZONE_LEVELS,
  flattenZones,
  formatCoordinate,
  moveTargetsOf,
  zoneActiveCommand,
  zoneCreateCommand,
  zoneFormOf,
  zoneMoveCommand,
  zoneProblems,
  zoneTree,
  zoneUpdateCommand,
  type FormProblem,
  type ZoneForm,
  type ZoneView,
} from './organization.js';
import { panelBlocked, type PanelProps } from './panel-props.js';
import { useCurrentPosition } from './use-position.js';

interface GeofenceFieldsProps {
  readonly form: ZoneForm;
  readonly problems: readonly FormProblem[];
  readonly onChange: (form: ZoneForm) => void;
}

/** Champs du géorepère et de la précision GPS, avec « Ma position ». */
function GeofenceFields({ form, problems, onChange }: GeofenceFieldsProps) {
  const { t } = useTranslation();
  const position = useCurrentPosition((found) =>
    onChange({ ...form, lat: formatCoordinate(found.lat), lng: formatCoordinate(found.lng) }),
  );
  return (
    <fieldset className="adm-choices org-geofence">
      <legend>{t('org.zones.geofence')}</legend>
      <p className="adm-note">{t('org.zones.geofence_hint')}</p>
      <div className="org-grid">
        <Field
          label={t('org.field.lat')}
          error={problems.includes('LAT') ? t('org.problem.LAT') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={form.lat}
              onChange={(event) => onChange({ ...form, lat: event.target.value })}
            />
          )}
        </Field>
        <Field
          label={t('org.field.lng')}
          error={problems.includes('LNG') ? t('org.problem.LNG') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={form.lng}
              onChange={(event) => onChange({ ...form, lng: event.target.value })}
            />
          )}
        </Field>
        <Field
          label={t('org.field.radius')}
          optional
          unit="m"
          hint={t('org.hint.radius', { min: RADIUS_MIN_M, max: RADIUS_MAX_M })}
          error={problems.includes('RADIUS') ? t('org.problem.RADIUS') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={form.radiusM}
              onChange={(event) => onChange({ ...form, radiusM: event.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="adm-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={position.state.status === 'WAITING'}
          onClick={position.request}
        >
          {position.state.status === 'WAITING' ? t('org.position.waiting') : t('org.position.use')}
        </Button>
      </div>
      {position.state.status === 'ERROR' ? (
        <p className="adm-note is-bad" role="alert">
          {t(`org.position.${position.state.reason}`)}
        </p>
      ) : null}
      <Field
        label={t('org.field.accuracy')}
        optional
        unit="m"
        hint={t('org.hint.accuracy')}
        error={problems.includes('ACCURACY') ? t('org.problem.ACCURACY') : undefined}
      >
        {(control) => (
          <Input
            {...control}
            inputMode="decimal"
            value={form.maxGpsAccuracyM}
            onChange={(event) => onChange({ ...form, maxGpsAccuracyM: event.target.value })}
          />
        )}
      </Field>
    </fieldset>
  );
}

export function ZonesPanel(props: PanelProps) {
  const { t } = useTranslation();
  const { data, commands } = props;
  const blocked = panelBlocked(props);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ZoneForm>(EMPTY_ZONE_FORM);
  const [editing, setEditing] = useState<{ zone: ZoneView; form: ZoneForm } | null>(null);
  const [moving, setMoving] = useState<{ zone: ZoneView; parentId: string } | null>(null);
  const rows = flattenZones(zoneTree(data.zones));
  const createProblems = zoneProblems(form, 'CREATE');
  const editProblems = editing ? zoneProblems(editing.form, 'UPDATE') : [];
  const editCommand = editing ? zoneUpdateCommand(editing.zone, editing.form) : null;

  const create = async () => {
    const sent = await commands.send(zoneCreateCommand(form, idGenerator.newId()), blocked);
    if (sent) {
      setCreating(false);
      setForm(EMPTY_ZONE_FORM);
    }
  };

  const saveEdit = async () => {
    if (!editCommand) return;
    if (await commands.send(editCommand, blocked)) setEditing(null);
  };

  const toggleActive = (zone: ZoneView) =>
    void commands.send(zoneActiveCommand(zone, !zone.isActive), blocked);

  const move = async () => {
    if (!moving) return;
    if (await commands.send(zoneMoveCommand(moving.zone, moving.parentId), blocked))
      setMoving(null);
  };

  return (
    <>
      {!creating ? (
        <div className="adm-actions org-toolbar">
          <Button
            variant="tonal"
            icon="plus"
            disabled={blocked}
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
          >
            {t('org.zones.new')}
          </Button>
        </div>
      ) : (
        <div className="card adm-create" role="group" aria-label={t('org.zones.new')}>
          <h2>{t('org.zones.new')}</h2>
          <div className="adm-form">
            <Field label={t('org.field.code')} hint={t('org.hint.code', { max: LIMITS.zoneCode })}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={LIMITS.zoneCode}
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
            <Field label={t('org.field.level')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.level}
                  onChange={(event) =>
                    setForm({ ...form, level: event.target.value as ZoneForm['level'] })
                  }
                >
                  {ZONE_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {t(`org.zone_level.${level}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('org.field.parent_zone')} optional hint={t('org.hint.parent_zone')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.parentId}
                  onChange={(event) => setForm({ ...form, parentId: event.target.value })}
                >
                  <option value="">{t('org.none')}</option>
                  {rows
                    .filter(({ zone }) => zone.isActive)
                    .map(({ zone, level }) => (
                      <option key={zone.id} value={zone.id}>
                        {`${'— '.repeat(level)}${zone.name}`}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <GeofenceFields form={form} problems={createProblems} onChange={setForm} />
            <div className="adm-actions">
              <Button disabled={blocked || createProblems.length > 0} onClick={() => void create()}>
                {t('org.zones.create_confirm')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setForm(EMPTY_ZONE_FORM);
                }}
              >
                {t('org.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon="box" title={t('org.zones.empty')} />
      ) : (
        <ul className="adm-cards org-zones">
          {rows.map(({ zone, level }) => {
            const isEditing = editing?.zone.id === zone.id;
            return (
              <li
                key={zone.id}
                className="line-card org-zone"
                style={{ '--level': level } as CSSProperties}
                aria-label={t('org.zones.card', { name: zone.name })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <span className="adm-title-line">
                      <strong>{zone.name}</strong>
                      <Badge tone="brand" plain>
                        {t(`org.zone_level.${zone.level}`, { defaultValue: zone.level })}
                      </Badge>
                    </span>
                    <span className="adm-sub">
                      {[
                        zone.code,
                        zone.geofence
                          ? t('org.zones.geofence_value', {
                              lat: formatCoordinate(zone.geofence.lat),
                              lng: formatCoordinate(zone.geofence.lng),
                              radius: zone.geofence.radiusM,
                            })
                          : t('org.zones.no_geofence'),
                      ].join(' · ')}
                    </span>
                  </span>
                  <Badge tone={zone.isActive ? 'ok' : 'muted'}>
                    {zone.isActive ? t('org.zones.active') : t('org.zones.inactive')}
                  </Badge>
                </div>
                {moving?.zone.id === zone.id ? (
                  <div className="adm-form adm-panel">
                    <Field label={t('org.zones.move_label', { name: zone.name })}>
                      {(control) => (
                        <Select
                          {...control}
                          value={moving.parentId}
                          onChange={(event) =>
                            setMoving({ ...moving, parentId: event.target.value })
                          }
                        >
                          {zone.parentId !== null ? (
                            <>
                              <option value={zone.parentId}>
                                {t('org.zones.move_current', {
                                  name:
                                    data.zones.find((candidate) => candidate.id === zone.parentId)
                                      ?.name ?? '…',
                                })}
                              </option>
                              <option value="">{t('org.zones.move_root')}</option>
                            </>
                          ) : (
                            <option value="" disabled>
                              {t('org.zones.move_current_root')}
                            </option>
                          )}
                          {moveTargetsOf(zone, data.zones).map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <p className="adm-note">{t('org.zones.move_hint')}</p>
                    <div className="adm-actions">
                      <Button
                        disabled={blocked || moving.parentId === (zone.parentId ?? '')}
                        onClick={() => void move()}
                      >
                        {t('org.zones.move_confirm', { name: zone.name })}
                      </Button>
                      <Button variant="ghost" onClick={() => setMoving(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : !isEditing ? (
                  <div className="adm-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      onClick={() => {
                        setCreating(false);
                        setMoving(null);
                        setEditing({ zone, form: zoneFormOf(zone) });
                      }}
                    >
                      {t('org.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      aria-label={t('org.zones.move_open', { name: zone.name })}
                      onClick={() => {
                        setCreating(false);
                        setEditing(null);
                        setMoving({ zone, parentId: zone.parentId ?? '' });
                      }}
                    >
                      {t('org.zones.move')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      onClick={() => toggleActive(zone)}
                    >
                      {zone.isActive ? t('org.zones.deactivate') : t('org.zones.reactivate')}
                    </Button>
                  </div>
                ) : (
                  <div className="adm-form adm-panel">
                    <Field label={t('org.field.name')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={LIMITS.name}
                          value={editing.form.name}
                          onChange={(event) =>
                            setEditing({
                              ...editing,
                              form: { ...editing.form, name: event.target.value },
                            })
                          }
                        />
                      )}
                    </Field>
                    <GeofenceFields
                      form={editing.form}
                      problems={editProblems}
                      onChange={(next) => setEditing({ ...editing, form: next })}
                    />
                    {editCommand === null ? (
                      <Banner tone="muted">{t('org.zones.unchanged')}</Banner>
                    ) : null}
                    <div className="adm-actions">
                      <Button
                        disabled={blocked || editProblems.length > 0 || editCommand === null}
                        onClick={() => void saveEdit()}
                      >
                        {t('org.save')}
                      </Button>
                      <Button variant="ghost" onClick={() => setEditing(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
