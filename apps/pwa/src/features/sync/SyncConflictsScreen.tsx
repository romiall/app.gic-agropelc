/**
 * ECR-SYN-03 « Résolution des conflits » (RP-3 ; UC-SYN-07 ; SM-CONFLICT ; BR-SYN-017 ; AV-190).
 * En ligne seulement : file des conflits de synchronisation et anomalies hors ligne (`GET /sync/conflicts`)
 * visibles par le rôle propriétaire, avec clôture motivée (`sync.conflict.resolve` et `sync.conflict.dismiss`).
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../../app/screens.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Radio,
  Segmented,
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
  allowedResolutions,
  canDismissConflict,
  canResolveConflict,
  COMMENT_MAX,
  CONFLICT_STATUS_FILTERS,
  conflictCommandOf,
  conflictsPath,
  decisionProblem,
  isManagedElsewhere,
  isSelfAppliedConflict,
  type ConflictActionMode,
  type ConflictResolution,
  type ConflictStatusFilter,
  type ConflictView,
} from './sync-conflicts.js';
import '../users/admin.css';

const PREFIX = 'sync.conflict.';
const MAX_PAGES = 5;

const STATUS_TONE: Readonly<Record<ConflictStatusFilter, BadgeTone>> = {
  OPEN: 'warn',
  RESOLVED: 'ok',
  DISMISSED: 'muted',
};

interface ConflictDecisionFormProps {
  readonly conflict: ConflictView;
  readonly mode: ConflictActionMode;
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input: {
    readonly mode: ConflictActionMode;
    readonly resolution: ConflictResolution;
    readonly comment: string;
    readonly refsText: string;
  }) => void;
}

function ConflictDecisionForm({
  conflict,
  mode,
  blocked,
  onCancel,
  onConfirm,
}: ConflictDecisionFormProps) {
  const { t } = useTranslation();
  const resolutions = allowedResolutions(conflict);
  const [resolution, setResolution] = useState<ConflictResolution>(resolutions[0] ?? 'KEEP_SERVER');
  const [comment, setComment] = useState('');
  const [refsText, setRefsText] = useState('');
  const problem = decisionProblem({ mode, resolution, comment, refsText });

  return (
    <div className="adm-panel" role="group" aria-label={t(`sync_conflicts.action.${mode}`)}>
      {mode === 'RESOLVE' ? (
        <>
          <fieldset className="adm-choices">
            <legend>{t('sync_conflicts.resolution_legend')}</legend>
            {resolutions.map((option) => (
              <Radio
                key={option}
                name={`resolution-${conflict.id}`}
                checked={resolution === option}
                onChange={() => setResolution(option)}
                label={t(`sync_conflicts.resolution.${option}`)}
              />
            ))}
          </fieldset>
          <Field
            label={
              resolution === 'COMPENSATE'
                ? t('sync_conflicts.refs_required_label')
                : t('sync_conflicts.refs_optional_label')
            }
            hint={t('sync_conflicts.refs_hint')}
          >
            {(control) => (
              <Input
                {...control}
                value={refsText}
                onChange={(event) => setRefsText(event.target.value)}
              />
            )}
          </Field>
        </>
      ) : null}
      <Field label={t('sync_conflicts.comment_label')}>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            maxLength={COMMENT_MAX}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        )}
      </Field>
      {problem && problem !== 'COMMENT_REQUIRED' ? (
        <p className="adm-note is-warn">{t(`sync_conflicts.problem.${problem}`)}</p>
      ) : null}
      <div className="adm-actions">
        <Button
          disabled={blocked || problem !== null}
          onClick={() => onConfirm({ mode, resolution, comment, refsText })}
        >
          {t(`sync_conflicts.confirm.${mode}`)}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('price_rules.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function SyncConflictsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const [statusFilter, setStatusFilter] = useState<ConflictStatusFilter>('OPEN');
  const [open, setOpen] = useState<{ id: string; mode: ConflictActionMode } | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const lastCommand = outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(outbox, PREFIX, userId);
  const read = useOnlineRead<Pages<ConflictView>>(
    online ? conflictsPath(statusFilter) : null,
    (path) => readPages<ConflictView>([path], 'conflicts', MAX_PAGES),
    online,
    `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, PREFIX, userId)}`,
  );
  useRefreshOnVisible(read.retry);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.sync_conflicts')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.sync_conflicts')} />
        <Banner tone="muted" role="status">
          {t('sync_conflicts.online_only')}
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

  const conflicts = read.data?.items;
  const siteName = (id: string | null) => (id ? (refs?.sites.get(id)?.name ?? null) : null);
  const userName = (id: string | null) => {
    if (!id) return null;
    const found = refs?.users.find((u) => u.id === id);
    return found?.full_name ?? id;
  };
  const typeLabel = (type: string) => t(`sync_conflicts.type.${type}`, { defaultValue: type });

  const send = async (
    conflict: ConflictView,
    input: {
      readonly mode: ConflictActionMode;
      readonly resolution: ConflictResolution;
      readonly comment: string;
      readonly refsText: string;
    },
  ) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const { commandType, payload } = conflictCommandOf(input);
      const command = await submitCommand({
        authorUserId: userId,
        commandType,
        aggregateType: 'SYNC_CONFLICT',
        aggregateId: conflict.id,
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
        title={t('nav.screens.sync_conflicts')}
        actions={
          conflicts && !read.failed ? (
            <Button variant="tonal" icon="sync" onClick={read.retry} disabled={read.stale}>
              {t('sync_conflicts.refresh')}
            </Button>
          ) : undefined
        }
      />
      <HelpDisclosure title={t('sync_conflicts.help_title')}>
        <p>{t('sync_conflicts.intro')}</p>
      </HelpDisclosure>
      {last ? <CommandResult commandId={last} messages="sync_conflicts.result" /> : null}
      {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}

      <div className="adm-toolbar">
        <Segmented
          label={t('sync_conflicts.filter_label')}
          value={statusFilter}
          onChange={(option) => {
            setStatusFilter(option);
            setOpen(null);
          }}
          options={CONFLICT_STATUS_FILTERS.map((option) => ({
            value: option,
            label: t(`sync_conflicts.status.${option}`),
          }))}
        />
      </div>

      {conflicts === undefined && !read.failed ? <SkeletonRows /> : null}
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
          {read.denied ? t('sync_conflicts.denied') : t('sync_conflicts.unavailable')}
        </Banner>
      ) : null}
      {conflicts && read.stale && !read.failed ? (
        <p className="adm-note" role="status">
          {t('sync_conflicts.refreshing')}
        </p>
      ) : null}

      {conflicts && conflicts.length === 0 ? (
        <EmptyState icon="check-circle" title={t(`sync_conflicts.none.${statusFilter}`)} />
      ) : null}

      {conflicts && conflicts.length > 0 ? (
        <ul className="adm-cards" aria-label={t('nav.screens.sync_conflicts')}>
          {conflicts.map((conflict) => {
            const site = siteName(conflict.siteId);
            const author = userName(conflict.authorUserId);
            const managedElsewhere = isManagedElsewhere(conflict);
            const selfApplied = isSelfAppliedConflict(conflict, userId);
            const resolvable = canResolveConflict(conflict, userId);
            const dismissable = canDismissConflict(conflict, userId);

            return (
              <li
                key={conflict.id}
                className="line-card"
                aria-label={typeLabel(conflict.conflictType)}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <span className="adm-title-line">
                      <strong>{typeLabel(conflict.conflictType)}</strong>
                      <Badge tone={conflict.applied ? 'info' : 'bad'}>
                        {conflict.applied
                          ? t('sync_conflicts.badge_applied')
                          : t('sync_conflicts.badge_quarantined')}
                      </Badge>
                    </span>
                    <span className="adm-sub">
                      {[
                        formatDateTime(conflict.createdAt),
                        site ? t('devices.site', { name: site }) : null,
                        author ? t('sync_conflicts.author', { name: author }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[conflict.status]}>
                    {t(`sync_conflicts.status.${conflict.status}`)}
                  </Badge>
                </div>

                <p className="adm-note">
                  {t('sync_conflicts.entity_line', {
                    entityType: conflict.entityType,
                    ownerRole: conflict.ownerRole,
                  })}
                </p>

                {conflict.status !== 'OPEN' && conflict.resolutionComment ? (
                  <p className="adm-note">
                    {conflict.resolution
                      ? `${t(`sync_conflicts.resolution.${conflict.resolution}`)} — `
                      : ''}
                    {conflict.resolutionComment}
                  </p>
                ) : null}

                {conflict.status === 'OPEN' && managedElsewhere ? (
                  <p className="adm-note is-warn">
                    {t('sync_conflicts.managed_elsewhere')}{' '}
                    <LinkButton to={ROUTES.approvals} variant="tonal" size="sm">
                      {t('nav.screens.approvals')}
                    </LinkButton>
                  </p>
                ) : null}

                {conflict.status === 'OPEN' && selfApplied ? (
                  <p className="adm-note is-warn">{t('sync_conflicts.self_forbidden')}</p>
                ) : null}

                {open?.id === conflict.id ? (
                  <ConflictDecisionForm
                    conflict={conflict}
                    mode={open.mode}
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(input) => void send(conflict, input)}
                  />
                ) : resolvable ? (
                  <div className="adm-actions">
                    <Button
                      variant="tonal"
                      size="sm"
                      disabled={blocked}
                      onClick={() => setOpen({ id: conflict.id, mode: 'RESOLVE' })}
                    >
                      {t('sync_conflicts.action.RESOLVE')}
                    </Button>
                    {dismissable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked}
                        onClick={() => setOpen({ id: conflict.id, mode: 'DISMISS' })}
                      >
                        {t('sync_conflicts.action.DISMISS')}
                      </Button>
                    ) : null}
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
