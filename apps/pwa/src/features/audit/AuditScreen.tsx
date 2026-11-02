/**
 * ECR-AUD-01 « Journal d'audit » (RP-1 ; DIRECTION, ADMIN, FINANCE ; en ligne seulement) : recherche dans le
 * journal par période, entité, acteur et action, résultats de la plus récente à la plus ancienne, avec le détail
 * (avant et après, motif, appareil, commande) de chaque entrée. Chaque recherche est elle-même inscrite au
 * journal (BR-AUD-009) : l'écran ne relit donc que sur demande, jamais au retour sur l'onglet. La Finance ne voit
 * que les entités financières (AV-493) : le serveur borne la lecture et la liste des types d'entité.
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
  PageHeader,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { AdminGate } from '../admin/AdminGate.js';
import { useAdminPages, useAdminRead } from '../admin/admin-online.js';
import { formatDateTime } from '../home/format-home.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import type { UserView } from '../users/users.js';
import {
  ACTORS_PATH,
  EMPTY_FILTERS,
  ENTITY_TYPES_PATH,
  auditPath,
  changedKeys,
  filterProblem,
  mayHaveMore,
  prettyJson,
  shortId,
  type AuditEntryView,
  type AuditFilters,
  type AuditResult,
} from './audit.js';
import './audit.css';

const RESULT_TONE: Readonly<Record<AuditResult, BadgeTone>> = {
  SUCCESS: 'ok',
  DENIED: 'bad',
  FAILED: 'bad',
  QUARANTINED: 'warn',
};

interface Older {
  /** Recherche à laquelle appartiennent les pages plus anciennes déjà lues. */
  readonly forKey: string;
  readonly pages: readonly (readonly AuditEntryView[])[];
  readonly loading: boolean;
  readonly failed: boolean;
}

function EntryCard({ entry }: { entry: AuditEntryView }) {
  const { t } = useTranslation();
  const changes = changedKeys(entry.before, entry.after);
  const hasDetail =
    entry.before !== null ||
    entry.after !== null ||
    entry.reason !== null ||
    entry.deviceId !== null ||
    entry.commandId !== null;
  return (
    <li className="line-card" aria-label={t('audit.entry_label', { seq: entry.seq })}>
      <div className="adm-card-head">
        <span className="adm-card-title">
          <span className="adm-title-line">
            <strong>{entry.actorName ?? t('audit.unknown_actor')}</strong>
            <Badge tone={RESULT_TONE[entry.result]}>{t(`audit.result.${entry.result}`)}</Badge>
          </span>
          <span className="adm-sub audit-action">{entry.action}</span>
          <span className="adm-sub">
            {[
              t(`audit.entity.${entry.entityType}`, { defaultValue: entry.entityType }),
              entry.entityId ? `…${shortId(entry.entityId)}` : null,
              formatDateTime(entry.recordedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </div>
      {changes.length > 0 ? (
        <p className="adm-note">{t('audit.changed', { fields: changes.join(', ') })}</p>
      ) : null}
      {hasDetail ? (
        <details className="audit-detail">
          <summary>{t('audit.detail')}</summary>
          <dl>
            <dt>{t('audit.occurred_at')}</dt>
            <dd>{formatDateTime(entry.occurredAt)}</dd>
            {entry.actorRoles.length > 0 ? (
              <>
                <dt>{t('audit.roles')}</dt>
                <dd>{entry.actorRoles.join(', ')}</dd>
              </>
            ) : null}
            {entry.reason ? (
              <>
                <dt>{t('audit.reason')}</dt>
                <dd>{entry.reason}</dd>
              </>
            ) : null}
            {entry.deviceId ? (
              <>
                <dt>{t('audit.device')}</dt>
                <dd>…{shortId(entry.deviceId)}</dd>
              </>
            ) : null}
            {entry.commandId ? (
              <>
                <dt>{t('audit.command')}</dt>
                <dd>…{shortId(entry.commandId)}</dd>
              </>
            ) : null}
          </dl>
          {entry.before !== null && entry.before !== undefined ? (
            <>
              <h3 className="audit-block-title">{t('audit.before')}</h3>
              <pre className="audit-json">{prettyJson(entry.before)}</pre>
            </>
          ) : null}
          {entry.after !== null && entry.after !== undefined ? (
            <>
              <h3 className="audit-block-title">{t('audit.after')}</h3>
              <pre className="audit-json">{prettyJson(entry.after)}</pre>
            </>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}

function AuditBody() {
  const { t } = useTranslation();
  const online = useOnline();
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [round, setRound] = useState(0);
  const [older, setOlder] = useState<Older>({
    forKey: '',
    pages: [],
    loading: false,
    failed: false,
  });
  const path = auditPath(applied);
  const searchKey = `${path}#${round}`;
  const first = useOnlineRead<{ readonly entries: readonly AuditEntryView[] }>(
    online ? path : null,
    (key) => readPath<{ entries: AuditEntryView[] }>(key),
    online,
    String(round),
  );
  const entityTypes = useAdminRead<{ readonly entity_types: readonly string[] }>(
    ENTITY_TYPES_PATH,
    '',
  );
  const actors = useAdminPages<UserView>(ACTORS_PATH, 'users', '');
  const problem = filterProblem(draft);
  const actorOptions = actors.data
    ? [...actors.data.items].sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr'))
    : null;
  const entityOptions = entityTypes.data
    ? entityTypes.data.entity_types
        .map((type) => ({ type, label: t(`audit.entity.${type}`, { defaultValue: type }) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
    : null;
  const pages = older.forKey === searchKey ? older.pages : [];
  const entries = first.data ? [...first.data.entries, ...pages.flat()] : undefined;
  const lastPage = pages.at(-1) ?? first.data?.entries ?? [];
  const canLoadMore = entries !== undefined && !first.stale && mayHaveMore(lastPage.length);

  const search = () => {
    if (problem !== null) return;
    setApplied(draft);
    setRound((value) => value + 1);
  };

  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setRound((value) => value + 1);
  };

  const loadMore = async () => {
    const last = entries?.at(-1);
    if (!last || older.loading) return;
    setOlder({ forKey: searchKey, pages, loading: true, failed: false });
    const result = await readPath<{ entries: AuditEntryView[] }>(auditPath(applied, last.seq));
    setOlder(
      result.ok
        ? {
            forKey: searchKey,
            pages: [...pages, result.data.entries],
            loading: false,
            failed: false,
          }
        : { forKey: searchKey, pages, loading: false, failed: true },
    );
  };

  return (
    <>
      <PageHeader title={t('nav.screens.audit')} />
      <HelpDisclosure title={t('audit.help_title')}>
        <p>{t('audit.intro')}</p>
      </HelpDisclosure>
      <form
        className="adm-form audit-filters"
        aria-label={t('audit.filters')}
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <div className="audit-grid">
          <Field label={t('audit.field.from')} optional>
            {(control) => (
              <Input
                {...control}
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            )}
          </Field>
          <Field
            label={t('audit.field.to')}
            optional
            error={problem === 'PERIOD' ? t('audit.problem.PERIOD') : undefined}
          >
            {(control) => (
              <Input
                {...control}
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('audit.field.entity_type')} optional>
            {(control) =>
              entityOptions ? (
                <Select
                  {...control}
                  value={draft.entityType}
                  onChange={(event) => setDraft({ ...draft, entityType: event.target.value })}
                >
                  <option value="">{t('audit.all')}</option>
                  {entityOptions.map(({ type, label }) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  {...control}
                  value={draft.entityType}
                  onChange={(event) => setDraft({ ...draft, entityType: event.target.value })}
                />
              )
            }
          </Field>
          {actorOptions ? (
            <Field label={t('audit.field.actor')} optional>
              {(control) => (
                <Select
                  {...control}
                  value={draft.actorUserId}
                  onChange={(event) => setDraft({ ...draft, actorUserId: event.target.value })}
                >
                  <option value="">{t('audit.all')}</option>
                  {actorOptions.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label={t('audit.field.action')} optional hint={t('audit.hint.action')}>
            {(control) => (
              <Input
                {...control}
                autoCapitalize="none"
                spellCheck={false}
                value={draft.action}
                onChange={(event) => setDraft({ ...draft, action: event.target.value })}
              />
            )}
          </Field>
          <Field
            label={t('audit.field.entity_id')}
            optional
            error={problem === 'ENTITY_ID' ? t('audit.problem.ENTITY_ID') : undefined}
          >
            {(control) => (
              <Input
                {...control}
                autoCapitalize="none"
                spellCheck={false}
                value={draft.entityId}
                onChange={(event) => setDraft({ ...draft, entityId: event.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="adm-actions">
          <Button type="submit" icon="search" disabled={problem !== null || first.stale}>
            {t('audit.search')}
          </Button>
          <Button variant="ghost" onClick={reset} disabled={first.stale}>
            {t('audit.reset')}
          </Button>
        </div>
      </form>
      {first.failed ? (
        <Banner
          tone="bad"
          action={
            first.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={first.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {first.denied ? t('audit.denied') : t('audit.unavailable')}
        </Banner>
      ) : null}
      {entries === undefined && !first.failed ? <SkeletonRows /> : null}
      {entries && entries.length === 0 ? (
        <EmptyState icon="shield" title={t('audit.none')} />
      ) : null}
      {entries && entries.length > 0 ? (
        <>
          <p className="adm-note" role="status">
            {t('audit.count', { count: entries.length })}
          </p>
          <ul className="adm-cards audit-list">
            {entries.map((entry) => (
              <EntryCard key={entry.seq} entry={entry} />
            ))}
          </ul>
        </>
      ) : null}
      {older.forKey === searchKey && older.failed ? (
        <Banner tone="bad">{t('audit.older_unavailable')}</Banner>
      ) : null}
      {canLoadMore ? (
        <div className="adm-actions">
          <Button variant="tonal" loading={older.loading} onClick={() => void loadMore()}>
            {t('audit.older')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function AuditScreen() {
  const { t } = useTranslation();
  return (
    <AdminGate title={t('nav.screens.audit')}>
      <AuditBody />
    </AdminGate>
  );
}
