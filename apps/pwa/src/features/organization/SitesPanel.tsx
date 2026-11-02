/**
 * Onglet « Sites » de l'écran Organisation (ECR-ADM-06 ; UC-ADM-01 ; BR-ADM-008) : sites de la portée avec leur
 * zone et leur état, création d'un site, modification du nom et de l'adresse, fermeture, et emplacements de
 * chaque site (`LocationsBlock`). Un site fermé reste consultable et n'est plus modifié.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Textarea,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { formatBusinessDate } from '../home/format-home.js';
import { LocationsBlock } from './LocationsBlock.js';
import {
  EMPTY_SITE_FORM,
  LIMITS,
  SITE_TYPES,
  flattenZones,
  siteCloseCommand,
  siteCreateCommand,
  siteProblems,
  siteUpdateCommand,
  zoneTree,
  type SiteForm,
  type SiteView,
} from './organization.js';
import { panelBlocked, type PanelProps } from './panel-props.js';

type Open =
  | {
      readonly kind: 'EDIT';
      readonly siteId: string;
      readonly name: string;
      readonly address: string;
      /** Adresse connue à l'ouverture : seule une adresse changée (ou effacée) part. */
      readonly currentAddress: string;
    }
  | { readonly kind: 'CLOSE'; readonly siteId: string }
  | { readonly kind: 'LOCATIONS'; readonly siteId: string };

export function SitesPanel(props: PanelProps) {
  const { t } = useTranslation();
  const { data, commands } = props;
  const blocked = panelBlocked(props);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<SiteForm>(EMPTY_SITE_FORM);
  const [open, setOpen] = useState<Open | null>(null);
  const zoneName = (id: string) => data.zones.find((zone) => zone.id === id)?.name ?? '—';
  const zoneChoices = flattenZones(zoneTree(data.zones.filter((zone) => zone.isActive)));
  const problems = siteProblems(form);

  const create = async () => {
    const sent = await commands.send(siteCreateCommand(form, idGenerator.newId()), blocked);
    if (sent) {
      setCreating(false);
      setForm(EMPTY_SITE_FORM);
    }
  };

  const saveEdit = async () => {
    if (open?.kind !== 'EDIT') return;
    const sent = await commands.send(
      siteUpdateCommand(
        open.siteId,
        { name: open.name, address: open.address },
        open.currentAddress,
      ),
      blocked,
    );
    if (sent) setOpen(null);
  };

  const close = async (site: SiteView) => {
    if (await commands.send(siteCloseCommand(site.id), blocked)) setOpen(null);
  };

  return (
    <>
      {!creating ? (
        <div className="adm-actions org-toolbar">
          <Button
            variant="tonal"
            icon="plus"
            disabled={blocked || data.zones.length === 0}
            onClick={() => {
              setOpen(null);
              setCreating(true);
            }}
          >
            {t('org.sites.new')}
          </Button>
          {data.zones.length === 0 ? (
            <span className="adm-note">{t('org.sites.needs_zone')}</span>
          ) : null}
        </div>
      ) : (
        <div className="card adm-create" role="group" aria-label={t('org.sites.new')}>
          <h2>{t('org.sites.new')}</h2>
          <div className="adm-form">
            <Field label={t('org.field.code')} hint={t('org.hint.code', { max: LIMITS.siteCode })}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={LIMITS.siteCode}
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
            <Field label={t('org.field.site_type')} hint={t('org.hint.site_type')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.siteType}
                  onChange={(event) =>
                    setForm({ ...form, siteType: event.target.value as SiteForm['siteType'] })
                  }
                >
                  {SITE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`org.site_type.${type}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('org.field.zone')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.zoneId}
                  onChange={(event) => setForm({ ...form, zoneId: event.target.value })}
                >
                  <option value="">{t('org.choose')}</option>
                  {zoneChoices.map(({ zone, level }) => (
                    <option key={zone.id} value={zone.id}>
                      {`${'— '.repeat(level)}${zone.name}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('org.field.address')} optional>
              {(control) => (
                <Textarea
                  {...control}
                  maxLength={LIMITS.address}
                  value={form.address}
                  onChange={(event) => setForm({ ...form, address: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('org.field.opened_on')} optional>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={form.openedOn}
                  onChange={(event) => setForm({ ...form, openedOn: event.target.value })}
                />
              )}
            </Field>
            <div className="adm-actions">
              <Button disabled={blocked || problems.length > 0} onClick={() => void create()}>
                {t('org.sites.create_confirm')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setForm(EMPTY_SITE_FORM);
                }}
              >
                {t('org.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {data.sites.length === 0 ? (
        <EmptyState icon="box" title={t('org.sites.empty')} />
      ) : (
        <ul className="adm-cards">
          {data.sites.map((site) => {
            const closed = site.status === 'CLOSED';
            const here = open?.siteId === site.id ? open : null;
            return (
              <li
                key={site.id}
                className="line-card"
                aria-label={t('org.sites.card', { name: site.name })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <span className="adm-title-line">
                      <strong>{site.name}</strong>
                      <Badge tone="brand" plain>
                        {t(`org.site_type.${site.siteType}`, { defaultValue: site.siteType })}
                      </Badge>
                    </span>
                    <span className="adm-sub">
                      {[
                        site.code,
                        t('org.sites.zone', { name: zoneName(site.zoneId) }),
                        site.openedOn
                          ? t('org.sites.opened', { date: formatBusinessDate(site.openedOn) })
                          : null,
                        site.closedOn
                          ? t('org.sites.closed', { date: formatBusinessDate(site.closedOn) })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {site.address ? <span className="adm-sub">{site.address}</span> : null}
                  </span>
                  <Badge tone={closed ? 'muted' : 'ok'}>
                    {t(`org.site_status.${site.status}`)}
                  </Badge>
                </div>
                <div className="adm-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={here?.kind === 'LOCATIONS'}
                    onClick={() =>
                      setOpen(
                        here?.kind === 'LOCATIONS' ? null : { kind: 'LOCATIONS', siteId: site.id },
                      )
                    }
                  >
                    {t('org.sites.locations')}
                  </Button>
                  {!closed ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked}
                        onClick={() =>
                          setOpen({
                            kind: 'EDIT',
                            siteId: site.id,
                            name: site.name,
                            address: site.address ?? '',
                            currentAddress: site.address ?? '',
                          })
                        }
                      >
                        {t('org.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked}
                        onClick={() => setOpen({ kind: 'CLOSE', siteId: site.id })}
                      >
                        {t('org.sites.close')}
                      </Button>
                    </>
                  ) : null}
                </div>
                {here?.kind === 'EDIT' ? (
                  <div className="adm-form adm-panel">
                    <Field label={t('org.field.name')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={LIMITS.name}
                          value={here.name}
                          onChange={(event) => setOpen({ ...here, name: event.target.value })}
                        />
                      )}
                    </Field>
                    <Field label={t('org.field.address')} optional>
                      {(control) => (
                        <Textarea
                          {...control}
                          maxLength={LIMITS.address}
                          value={here.address}
                          onChange={(event) => setOpen({ ...here, address: event.target.value })}
                        />
                      )}
                    </Field>
                    <div className="adm-actions">
                      <Button
                        disabled={blocked || here.name.trim() === ''}
                        onClick={() => void saveEdit()}
                      >
                        {t('org.save')}
                      </Button>
                      <Button variant="ghost" onClick={() => setOpen(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {here?.kind === 'CLOSE' ? (
                  <div className="adm-form adm-panel">
                    <p className="adm-note is-warn">{t('org.sites.close_warning')}</p>
                    <div className="adm-actions">
                      <Button variant="danger" disabled={blocked} onClick={() => void close(site)}>
                        {t('org.sites.close_confirm', { name: site.name })}
                      </Button>
                      <Button variant="ghost" onClick={() => setOpen(null)}>
                        {t('org.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {here?.kind === 'LOCATIONS' ? <LocationsBlock {...props} site={site} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
