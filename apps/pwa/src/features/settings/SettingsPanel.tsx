/**
 * Onglet « Paramètres » de l'écran ECR-ADM-07 (RP-1 ; BR-ADM-015, BR-ADM-016 ; AV-490, AV-491) : les paramètres
 * système groupés par domaine, avec leur valeur en vigueur, leur unité et leurs surcharges de site ; modification
 * contrôlée contre le catalogue (une nouvelle version datée, jamais une réécriture) et historique de chaque clé.
 * Les réglages techniques (synchronisation, plateforme, analyse) sont repliés derrière un interrupteur.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WEEKDAY_VALUES, type SettingDef } from '@gic/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Section,
  Select,
  SkeletonRows,
  Switch,
  Textarea,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { useAdminRead, type useOnlineCommands } from '../admin/admin-online.js';
import { formatDateTime } from '../home/format-home.js';
import type { SiteView } from '../organization/organization.js';
import { SITES_PATH } from '../organization/organization.js';
import {
  REASON_MAX,
  SETTINGS_PATH,
  discountRoleOf,
  draftOf,
  groupSettings,
  labelKeyOf,
  matchesSetting,
  sameValue,
  settingCommand,
  settingHistoryPath,
  valueOfDraft,
  visibilityOf,
  type SettingDraft,
  type SettingRow,
  type SettingVersionView,
} from './settings.js';

interface Props {
  readonly commands: ReturnType<typeof useOnlineCommands>;
}

/** Valeur lisible d'un paramètre (unité comprise). */
function useValueFormat() {
  const { t } = useTranslation();
  return (def: SettingDef | undefined, value: unknown): string => {
    if (def === undefined) return JSON.stringify(value);
    switch (def.kind) {
      case 'bool':
        return value === true ? t('settings.yes') : t('settings.no');
      case 'int':
      case 'number': {
        if (typeof value !== 'number') return String(value);
        const text = new Intl.NumberFormat('fr-FR').format(value).replace(/[\u202f\u00a0]/g, ' ');
        return def.unit ? `${text} ${t(`settings.unit.${def.unit}`)}` : text;
      }
      case 'text':
        return typeof value === 'string' && value !== '' ? value : t('settings.empty_text');
      case 'choice':
        return typeof value === 'string'
          ? t(`settings.option.${value}`, { defaultValue: value })
          : String(value);
      case 'list':
        return Array.isArray(value) && value.length > 0
          ? value.join(', ')
          : t('settings.empty_list');
      case 'weekdays':
        return Array.isArray(value) && value.length > 0
          ? WEEKDAY_VALUES.filter((day) => value.includes(day))
              .map((day) => t(`settings.weekday.${day}`))
              .join(' ')
          : t('settings.empty_list');
      case 'json': {
        const compact = JSON.stringify(value);
        return compact.length > 90 ? `${compact.slice(0, 87)}…` : compact;
      }
    }
  };
}

interface EditorProps extends Props {
  readonly row: SettingRow;
  readonly sites: readonly SiteView[];
  readonly blocked: boolean;
  readonly label: string;
  readonly onDone: () => void;
}

function SettingEditor({ row, sites, blocked, label, commands, onDone }: EditorProps) {
  const { t } = useTranslation();
  const def = row.def;
  const siteScoped = def?.site === true;
  const overrideSiteIds = row.overrides
    .filter((item) => item.scopeType === 'SITE')
    .map((item) => item.scopeId);
  const [siteId, setSiteId] = useState<string>('');
  const versionOfScope =
    siteId === '' ? row.global : row.overrides.find((item) => item.scopeId === siteId);
  const baseline = versionOfScope?.value ?? row.global?.value;
  const [draft, setDraft] = useState<SettingDraft>(() => draftOf(def, baseline));
  const [reason, setReason] = useState('');
  const result = valueOfDraft(def, draft);
  const unchanged =
    result.ok && versionOfScope !== undefined && sameValue(result.value, versionOfScope.value);
  const technical = def?.group === 'technical';

  const changeScope = (next: string) => {
    setSiteId(next);
    const version = next === '' ? row.global : row.overrides.find((item) => item.scopeId === next);
    setDraft(draftOf(def, version?.value ?? row.global?.value));
  };

  const save = async () => {
    if (!result.ok) return;
    const sent = await commands.send(
      settingCommand(
        {
          key: row.key,
          value: result.value,
          siteId: siteId === '' ? null : siteId,
          reason,
          isClientVisible: visibilityOf(row),
        },
        idGenerator.newId(),
      ),
      blocked,
    );
    if (sent) onDone();
  };

  const range =
    def &&
    (def.kind === 'int' || def.kind === 'number') &&
    (def.min !== undefined || def.max !== undefined)
      ? def.min !== undefined && def.max !== undefined
        ? t('settings.hint.range', { min: def.min, max: def.max })
        : def.min !== undefined
          ? t('settings.hint.min', { min: def.min })
          : t('settings.hint.max', { max: def.max })
      : undefined;
  const error =
    !result.ok && (draft.text !== '' || def?.kind === 'json' || def === undefined)
      ? t(`settings.problem.${result.problem}`)
      : undefined;

  return (
    <div
      className="adm-form adm-panel"
      role="group"
      aria-label={t('settings.edit_title', { name: label })}
    >
      {technical ? <Banner tone="warn">{t('settings.technical_warning')}</Banner> : null}
      {siteScoped || overrideSiteIds.length > 0 ? (
        <Field
          label={t('settings.field.scope')}
          hint={siteScoped ? t('settings.hint.scope') : undefined}
        >
          {(control) => (
            <Select
              {...control}
              value={siteId}
              onChange={(event) => changeScope(event.target.value)}
            >
              <option value="">{t('settings.scope.global')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {t('settings.scope.site', { name: site.name })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {def?.kind === 'bool' ? (
        <Switch
          label={label}
          checked={draft.flag}
          onChange={(event) => setDraft({ ...draft, flag: event.target.checked })}
        />
      ) : null}
      {def?.kind === 'weekdays' ? (
        <fieldset className="adm-choices">
          <legend>{label}</legend>
          {WEEKDAY_VALUES.map((day) => (
            <Checkbox
              key={day}
              label={t(`settings.weekday_long.${day}`)}
              checked={draft.days.includes(day)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  days: event.target.checked
                    ? [...draft.days, day]
                    : draft.days.filter((item) => item !== day),
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
      {def?.kind === 'choice' ? (
        <Field label={label}>
          {(control) => (
            <Select
              {...control}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            >
              {(def.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {t(`settings.option.${option}`, { defaultValue: option })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {def && (def.kind === 'int' || def.kind === 'number') ? (
        <Field
          label={label}
          unit={def.unit ? t(`settings.unit.${def.unit}`) : undefined}
          hint={range}
          error={error}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      {def?.kind === 'text' ? (
        <Field
          label={label}
          hint={
            def.maxLength !== undefined
              ? t('settings.hint.max_length', { max: def.maxLength })
              : undefined
          }
          error={error}
        >
          {(control) => (
            <Input
              {...control}
              {...(def.maxLength !== undefined ? { maxLength: def.maxLength } : {})}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      {def?.kind === 'list' ? (
        <Field label={label} hint={t('settings.hint.list')} error={error}>
          {(control) => (
            <Textarea
              {...control}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      {def === undefined || def.kind === 'json' ? (
        <Field label={label} hint={t('settings.hint.json')} error={error}>
          {(control) => (
            <Textarea
              {...control}
              className="settings-json"
              spellCheck={false}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('settings.field.reason')} optional>
        {(control) => (
          <Textarea
            {...control}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      {unchanged ? <p className="adm-note">{t('settings.unchanged')}</p> : null}
      <div className="adm-actions">
        <Button disabled={blocked || !result.ok || unchanged} onClick={() => void save()}>
          {t('settings.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('org.cancel')}
        </Button>
      </div>
    </div>
  );
}

function SettingHistory({
  row,
  sites,
  reloadKey,
}: {
  row: SettingRow;
  sites: readonly SiteView[];
  reloadKey: string;
}) {
  const { t } = useTranslation();
  const format = useValueFormat();
  const read = useAdminRead<{ readonly history: readonly SettingVersionView[] }>(
    settingHistoryPath(row.key),
    reloadKey,
  );
  const siteName = (id: string | null) => sites.find((site) => site.id === id)?.name ?? '—';
  const scopeLabel = (version: Pick<SettingVersionView, 'scopeType' | 'scopeId'>) =>
    version.scopeType === 'GLOBAL'
      ? t('settings.scope.global')
      : version.scopeType === 'SITE'
        ? t('settings.scope.site', { name: siteName(version.scopeId) })
        : t(`settings.scope.${version.scopeType}`, { id: (version.scopeId ?? '').slice(-8) });
  return (
    <div className="adm-panel" role="group" aria-label={t('settings.history_title')}>
      {read.failed ? <Banner tone="bad">{t('settings.history_unavailable')}</Banner> : null}
      {read.data === undefined && !read.failed ? <SkeletonRows rows={2} /> : null}
      {read.data ? (
        <ol className="settings-history">
          {read.data.history.map((version) => (
            <li key={version.id}>
              <strong>{format(row.def, version.value)}</strong>
              <span className="adm-sub">
                {[
                  formatDateTime(version.validFrom),
                  scopeLabel(version),
                  version.createdByName ?? t('org.unknown_user'),
                ].join(' · ')}
              </span>
              {version.reason ? (
                <span className="adm-sub">{t('settings.reason', { reason: version.reason })}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function SettingsPanel({ commands }: Props) {
  const { t } = useTranslation();
  const format = useValueFormat();
  const reads = useAdminRead<{ readonly settings: readonly SettingVersionView[] }>(
    SETTINGS_PATH,
    commands.reloadKey,
  );
  const sitesRead = useAdminRead<{ readonly sites: readonly SiteView[] }>(
    SITES_PATH,
    commands.reloadKey,
  );
  const [search, setSearch] = useState('');
  const [technical, setTechnical] = useState(false);
  const [open, setOpen] = useState<{ key: string; mode: 'EDIT' | 'HISTORY' } | null>(null);
  const blocked = commands.blocked || reads.stale;
  const sites = sitesRead.data?.sites ?? [];
  const siteName = (id: string | null) => sites.find((site) => site.id === id)?.name ?? '—';
  const overrideLabel = (override: SettingVersionView) =>
    override.scopeType === 'SITE'
      ? t('settings.scope.site', { name: siteName(override.scopeId) })
      : t(`settings.scope.${override.scopeType}`, { id: (override.scopeId ?? '').slice(-8) });
  const labelOf = (key: string) => {
    const role = discountRoleOf(key);
    return t(labelKeyOf(key), { defaultValue: key, ...(role !== null ? { role } : {}) });
  };
  const groups = reads.data
    ? groupSettings(reads.data.settings, { includeTechnical: technical })
    : [];

  return (
    <>
      {reads.failed ? (
        <Banner
          tone="bad"
          action={
            reads.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={reads.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {reads.denied ? t('settings.denied') : t('settings.unavailable')}
        </Banner>
      ) : null}
      <div className="adm-toolbar">
        <Field label={t('settings.search_label')}>
          {(control) => (
            <Input
              {...control}
              inputMode="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
        <Switch
          label={t('settings.show_technical')}
          checked={technical}
          onChange={(event) => setTechnical(event.target.checked)}
        />
      </div>
      {reads.data === undefined && !reads.failed ? <SkeletonRows /> : null}
      {reads.data && groups.length === 0 ? (
        <EmptyState icon="sliders" title={t('settings.none')} />
      ) : null}
      {groups.map((view) => {
        const rows = view.rows.filter((row) => matchesSetting(row, labelOf(row.key), search));
        if (rows.length === 0) return null;
        return (
          <Section key={view.group} title={t(`settings.group.${view.group}`)} headingLevel="h2">
            <ul className="adm-cards settings-list">
              {rows.map((row) => {
                const label = labelOf(row.key);
                const here = open?.key === row.key ? open : null;
                return (
                  <li key={row.key} className="line-card" aria-label={label}>
                    <div className="adm-card-head">
                      <span className="adm-card-title">
                        <strong>{label}</strong>
                        <span className="adm-sub">{row.key}</span>
                      </span>
                      <span className="adm-card-value">
                        {row.global ? format(row.def, row.global.value) : t('settings.no_global')}
                      </span>
                    </div>
                    {row.overrides.length > 0 ? (
                      <ul className="settings-overrides">
                        {row.overrides.map((override) => (
                          <li key={override.id}>
                            <Badge tone="info" plain>
                              {overrideLabel(override)}
                            </Badge>
                            <span>{format(row.def, override.value)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {here === null ? (
                      <div className="adm-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={blocked}
                          onClick={() => setOpen({ key: row.key, mode: 'EDIT' })}
                        >
                          {t('settings.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setOpen({ key: row.key, mode: 'HISTORY' })}
                        >
                          {t('settings.history')}
                        </Button>
                      </div>
                    ) : null}
                    {here?.mode === 'EDIT' ? (
                      <SettingEditor
                        row={row}
                        sites={sites}
                        blocked={blocked}
                        label={label}
                        commands={commands}
                        onDone={() => setOpen(null)}
                      />
                    ) : null}
                    {here?.mode === 'HISTORY' ? (
                      <>
                        <SettingHistory row={row} sites={sites} reloadKey={commands.reloadKey} />
                        <div className="adm-actions">
                          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
                            {t('settings.close_history')}
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}
    </>
  );
}
