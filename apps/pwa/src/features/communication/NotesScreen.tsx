/**
 * ECR-NOT-02 « Notes de direction (lecture et accusé) » (tous rôles, hors ligne possible)
 * et ECR-NOT-03 « Publication et suivi d'une note de direction » (DIRECTION, en ligne).
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type {
  NoteAcknowledgementsResponse,
  NoteAudienceEntry,
  NoteCategory,
  NoteItem,
  NoteListResponse,
} from '@gic/contracts';
import { ROUTES } from '../../app/screens.js';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  TabPanel,
  Tabs,
  Textarea,
  type BadgeTone,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { useAdminRead, useOnlineCommands } from '../admin/admin-online.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import type { SiteData, UserData, ZoneData } from '../sales/types.js';
import { ROLE_CODES } from './alerts.js';
import {
  buildNoteAckPayload,
  buildNoteArchivePayload,
  buildNoteSaveOrPublishPayload,
  filterProjectedNotes,
  NOTE_AUDIENCE_TYPES,
  NOTE_CATEGORIES,
  NOTE_STATUSES,
  noteAckFollowUpPath,
  notesInboxPath,
  notesManagePath,
  type NoteAudienceType,
  type NoteStatus,
} from './notes.js';
import './communication.css';

const categoryTone = (category: NoteCategory): BadgeTone => {
  if (category === 'PRIX' || category === 'INSTRUCTION') return 'warn';
  if (category === 'PROCEDURE') return 'info';
  return 'muted';
};

/** ECR-NOT-02 : Lecture et accusé de réception des notes de direction. */
export function NotesScreen() {
  const { t } = useTranslation();
  const online = useOnline();
  const { state } = useAuth();
  const unlocked = state.status === 'unlocked' ? state : undefined;
  const navigation = useRememberedNavigation(unlocked?.userId);
  const isDirection = Boolean(navigation?.roles.includes('DIRECTION'));

  const [pendingAckOnly, setPendingAckOnly] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastCmdId, setLastCmdId] = useState<string | undefined>(undefined);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const inboxRead = useAdminRead<NoteListResponse>(
    online ? notesInboxPath({ pendingAckOnly }) : null,
    String(reloadKey),
  );

  const offlineNotes = useLiveQuery(async () => {
    const db = getDb();
    const records = await listProjected<unknown>(db, 'comms', 'NOTE');
    return filterProjectedNotes(records, { pendingAckOnly });
  }, [pendingAckOnly, reloadKey]);

  const useOfflineFallback = !online || inboxRead.failed || inboxRead.data === undefined;
  const items: readonly NoteItem[] = useOfflineFallback
    ? (offlineNotes?.items ?? [])
    : (inboxRead.data?.items ?? []);
  const pendingAcknowledgements = useOfflineFallback
    ? (offlineNotes?.pendingAcknowledgements ?? 0)
    : (inboxRead.data?.pendingAcknowledgements ?? 0);

  const handleAck = async (note: NoteItem, kind: 'READ' | 'ACKNOWLEDGE') => {
    if (!unlocked) return;
    const built = buildNoteAckPayload(kind);
    if (!built.ok) return;
    setSubmittingId(note.id);
    setLocalError(null);
    try {
      const sent = await submitCommand({
        authorUserId: unlocked.userId,
        commandType: built.commandType,
        aggregateType: 'INTERNAL_NOTE',
        aggregateId: note.id,
        payload: built.payload,
      });
      setLastCmdId(sent.command_id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setLocalError(saveErrorKey(err));
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="comm-screen">
      <PageHeader
        title={t('nav.screens.notes')}
        subtitle={
          pendingAcknowledgements > 0
            ? t('comm.notes.pendingSubtitle', { count: pendingAcknowledgements })
            : t('comm.notes.subtitle')
        }
        actions={
          <div className="comm-inline-actions">
            {isDirection ? (
              <Link className="btn btn-outline btn-sm" to={ROUTES.notesPublish}>
                {t('comm.notes.openPublish')}
              </Link>
            ) : null}
            <Button
              variant="tonal"
              size="sm"
              icon="sync"
              onClick={() => inboxRead.retry()}
              disabled={!online || inboxRead.stale}
            >
              {t('comm.refresh')}
            </Button>
          </div>
        }
      />

      {!online ? <Banner tone="info">{t('comm.notes.offlineBanner')}</Banner> : null}
      {localError ? <Banner tone="bad">{t(localError)}</Banner> : null}
      {lastCmdId ? <CommandResult commandId={lastCmdId} messages="comm.result" /> : null}

      <div className="comm-toolbar">
        <Checkbox
          label={t('comm.notes.filterPendingAck')}
          checked={pendingAckOnly}
          onChange={(e) => setPendingAckOnly(e.target.checked)}
        />
      </div>

      {online && inboxRead.data === undefined && !inboxRead.failed ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyState icon="file" title={t('comm.notes.emptyTitle')}>
          {t('comm.notes.emptyHint')}
        </EmptyState>
      ) : (
        <ul className="comm-list">
          {items.map((note) => {
            const needsAck = note.requiresAck && !note.acknowledgedAt;
            return (
              <li key={note.id} className={`comm-card${needsAck ? ' comm-card--unread' : ''}`}>
                <div className="comm-card__head">
                  <h2 className="comm-card__title">{note.title}</h2>
                  <div className="comm-badges">
                    <Badge tone={categoryTone(note.category)}>
                      {t(`comm.notes.category.${note.category}`)}
                    </Badge>
                    {note.acknowledgedAt ? (
                      <Badge tone="ok">{t('comm.notes.statusAcked')}</Badge>
                    ) : note.requiresAck ? (
                      <Badge tone="warn">{t('comm.notes.statusAckRequired')}</Badge>
                    ) : note.readAt ? (
                      <Badge tone="muted">{t('comm.notes.statusRead')}</Badge>
                    ) : (
                      <Badge tone="info">{t('comm.notes.statusUnread')}</Badge>
                    )}
                  </div>
                </div>
                <p className="comm-card__body">{note.body}</p>
                <div className="comm-card__meta">
                  {note.publishedAt ? (
                    <span>
                      {t('comm.notes.publishedAt', {
                        date: formatDateTime(note.publishedAt),
                      })}
                    </span>
                  ) : null}
                  {note.expiresAt ? (
                    <span>
                      {t('comm.notes.expiresAt', {
                        date: formatDateTime(note.expiresAt),
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="comm-card__actions">
                  {needsAck ? (
                    <Button
                      variant="tonal"
                      size="sm"
                      disabled={submittingId === note.id}
                      onClick={() => void handleAck(note, 'ACKNOWLEDGE')}
                    >
                      {t('comm.notes.acknowledgeAction')}
                    </Button>
                  ) : !note.readAt ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={submittingId === note.id}
                      onClick={() => void handleAck(note, 'READ')}
                    >
                      {t('comm.notes.markReadAction')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type PublishTab = 'compose' | 'manage';
const PUBLISH_TABS: readonly PublishTab[] = ['compose', 'manage'];

/** ECR-NOT-03 : Publication et suivi d'une note de direction (DIRECTION, en ligne). */
export function NotePublishScreen() {
  const { t } = useTranslation();
  const online = useOnline();
  const commands = useOnlineCommands('communication.');

  const [tab, setTab] = useState<PublishTab>('compose');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<NoteCategory>('INSTRUCTION');
  const [requiresAck, setRequiresAck] = useState(true);
  const [expiresAtDate, setExpiresAtDate] = useState('');
  const [audience, setAudience] = useState<NoteAudienceEntry[]>([{ type: 'ALL' }]);
  const [audienceType, setAudienceType] = useState<NoteAudienceType>('ROLE');
  const [audienceRef, setAudienceRef] = useState<string>(ROLE_CODES[0]);
  const [formError, setFormError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'' | NoteStatus>('');
  const [archiveNoteId, setArchiveNoteId] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [followUpNoteId, setFollowUpNoteId] = useState<string | null>(null);

  const refs = useLiveQuery(async () => {
    const db = getDb();
    const [sites, zones, users] = await Promise.all([
      listProjected<SiteData>(db, 'reference', 'SITE'),
      listProjected<ZoneData>(db, 'reference', 'ZONE'),
      listProjected<UserData>(db, 'reference', 'USER_PUBLIC'),
    ]);
    return {
      sites: sites.filter((s) => s.status === 'ACTIVE'),
      zones: zones.filter((z) => z.is_active !== false && z.is_active !== 0),
      users: users.filter((u) => u.status === 'ACTIVE'),
    };
  }, []);

  const manageRead = useAdminRead<NoteListResponse>(
    online && tab === 'manage' ? notesManagePath({ status: statusFilter }) : null,
    commands.reloadKey,
  );

  const followUpRead = useAdminRead<NoteAcknowledgementsResponse>(
    online && followUpNoteId ? noteAckFollowUpPath(followUpNoteId) : null,
    commands.reloadKey,
  );

  const resetForm = () => {
    setEditingNoteId(null);
    setTitle('');
    setBody('');
    setCategory('INSTRUCTION');
    setRequiresAck(true);
    setExpiresAtDate('');
    setAudience([{ type: 'ALL' }]);
    setFormError(null);
  };

  const handleAddAudience = () => {
    if (audienceType === 'ALL') {
      setAudience([{ type: 'ALL' }]);
      return;
    }
    if (!audienceRef) return;
    const filtered = audience.filter((a) => a.type !== 'ALL');
    const exists = filtered.some(
      (a) => a.type === audienceType && 'ref' in a && a.ref === audienceRef,
    );
    if (!exists) {
      setAudience([...filtered, { type: audienceType, ref: audienceRef } as NoteAudienceEntry]);
    }
  };

  const handleRemoveAudience = (index: number) => {
    const next = audience.filter((_, idx) => idx !== index);
    setAudience(next.length > 0 ? next : [{ type: 'ALL' }]);
  };

  const formatAudienceEntry = (entry: NoteAudienceEntry): string => {
    if (entry.type === 'ALL') return t('comm.notes.audienceType.ALL');
    if (entry.type === 'ROLE') {
      return `${t('comm.notes.audienceType.ROLE')} : ${t(`users.role.${entry.ref}`, { defaultValue: entry.ref })}`;
    }
    if (entry.type === 'SITE') {
      const site = refs?.sites.find((s) => s.id === entry.ref);
      return `${t('comm.notes.audienceType.SITE')} : ${site?.name ?? entry.ref}`;
    }
    if (entry.type === 'ZONE') {
      const zone = refs?.zones.find((z) => z.id === entry.ref);
      return `${t('comm.notes.audienceType.ZONE')} : ${zone?.name ?? entry.ref}`;
    }
    const user = refs?.users.find((u) => u.id === entry.ref);
    return `${t('comm.notes.audienceType.USER')} : ${user?.full_name ?? entry.ref}`;
  };

  const handleSaveOrPublish = async (mode: 'DRAFT' | 'PUBLISH') => {
    setFormError(null);
    const built = buildNoteSaveOrPublishPayload(
      { title, body, category, requiresAck, expiresAtDate, audience },
      mode,
    );
    if (!built.ok) {
      setFormError(t('comm.notes.errorRequired'));
      return;
    }
    const aggregateId = editingNoteId ?? idGenerator.newId();
    const ok = await commands.send({
      commandType: built.commandType,
      aggregateType: 'INTERNAL_NOTE',
      aggregateId,
      payload: built.payload,
    });
    if (ok) {
      resetForm();
      setTab('manage');
    }
  };

  const handleEditDraft = (note: NoteItem) => {
    setEditingNoteId(note.id);
    setTitle(note.title);
    setBody(note.body);
    setCategory(note.category);
    setRequiresAck(note.requiresAck);
    setExpiresAtDate(note.expiresAt ? note.expiresAt.slice(0, 10) : '');
    setAudience(note.audience && note.audience.length > 0 ? [...note.audience] : [{ type: 'ALL' }]);
    setTab('compose');
  };

  const handleArchive = async (noteId: string) => {
    const built = buildNoteArchivePayload(archiveReason);
    if (!built.ok) return;
    const ok = await commands.send({
      commandType: built.commandType,
      aggregateType: 'INTERNAL_NOTE',
      aggregateId: noteId,
      payload: built.payload,
    });
    if (ok) {
      setArchiveNoteId(null);
      setArchiveReason('');
    }
  };

  return (
    <div className="comm-screen">
      <PageHeader
        title={t('nav.screens.notes_publish')}
        subtitle={t('comm.notes.publishSubtitle')}
        backTo={ROUTES.notes}
      />

      {!online ? <Banner tone="warn">{t('comm.notes.publishOffline')}</Banner> : null}
      {commands.saveError ? <Banner tone="bad">{t(commands.saveError)}</Banner> : null}
      {commands.last ? <CommandResult commandId={commands.last} messages="comm.result" /> : null}

      <Tabs
        idPrefix="comm-notes-publish"
        label={t('nav.screens.notes_publish')}
        items={PUBLISH_TABS.map((id) => ({
          id,
          label: t(`comm.notes.tab.${id}`),
        }))}
        value={tab}
        onChange={setTab}
      />

      <TabPanel idPrefix="comm-notes-publish" id="compose" active={tab === 'compose'}>
        <div className="comm-card">
          <Field label={t('comm.notes.fieldTitle')}>
            {(control) => (
              <Input
                {...control}
                value={title}
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>

          <Field label={t('comm.notes.fieldCategory')}>
            {(control) => (
              <Select
                {...control}
                value={category}
                onChange={(e) => setCategory(e.target.value as NoteCategory)}
              >
                {NOTE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`comm.notes.category.${c}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t('comm.notes.fieldBody')}>
            {(control) => (
              <Textarea
                {...control}
                rows={5}
                maxLength={8000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            )}
          </Field>

          <div className="comm-toolbar">
            <Checkbox
              label={t('comm.notes.fieldRequiresAck')}
              checked={requiresAck}
              onChange={(e) => setRequiresAck(e.target.checked)}
            />
            <Field label={t('comm.notes.fieldExpiresAt')} optional>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={expiresAtDate}
                  onChange={(e) => setExpiresAtDate(e.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="comm-form-panel">
            <strong>{t('comm.notes.fieldAudience')}</strong>
            <div className="comm-audience-chips">
              {audience.map((entry, idx) => (
                <span key={`${entry.type}-${idx}`} className="comm-audience-chip">
                  <span>{formatAudienceEntry(entry)}</span>
                  {audience.length > 1 ? (
                    <Button variant="ghost" size="sm" onClick={() => handleRemoveAudience(idx)}>
                      ×
                    </Button>
                  ) : null}
                </span>
              ))}
            </div>

            <div className="comm-toolbar">
              <Field label={t('comm.notes.audienceTargetType')}>
                {(control) => (
                  <Select
                    {...control}
                    value={audienceType}
                    onChange={(e) => {
                      const nextType = e.target.value as NoteAudienceType;
                      setAudienceType(nextType);
                      if (nextType === 'ROLE') setAudienceRef(ROLE_CODES[0]);
                      else if (nextType === 'SITE') setAudienceRef(refs?.sites[0]?.id ?? '');
                      else if (nextType === 'ZONE') setAudienceRef(refs?.zones[0]?.id ?? '');
                      else if (nextType === 'USER') setAudienceRef(refs?.users[0]?.id ?? '');
                      else setAudienceRef('');
                    }}
                  >
                    {NOTE_AUDIENCE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`comm.notes.audienceType.${type}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              {audienceType === 'ROLE' ? (
                <Field label={t('comm.notes.audienceTargetRef')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={audienceRef}
                      onChange={(e) => setAudienceRef(e.target.value)}
                    >
                      {ROLE_CODES.map((role) => (
                        <option key={role} value={role}>
                          {t(`users.role.${role}`, { defaultValue: role })}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}

              {audienceType === 'SITE' ? (
                <Field label={t('comm.notes.audienceTargetRef')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={audienceRef}
                      onChange={(e) => setAudienceRef(e.target.value)}
                    >
                      {(refs?.sites ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}

              {audienceType === 'ZONE' ? (
                <Field label={t('comm.notes.audienceTargetRef')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={audienceRef}
                      onChange={(e) => setAudienceRef(e.target.value)}
                    >
                      {(refs?.zones ?? []).map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}

              {audienceType === 'USER' ? (
                <Field label={t('comm.notes.audienceTargetRef')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={audienceRef}
                      onChange={(e) => setAudienceRef(e.target.value)}
                    >
                      {(refs?.users ?? []).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}

              <Button variant="tonal" size="sm" onClick={handleAddAudience}>
                {t('comm.notes.addAudience')}
              </Button>
            </div>
          </div>

          {formError ? <Banner tone="bad">{formError}</Banner> : null}

          <div className="comm-card__actions">
            <Button
              variant="primary"
              disabled={!online || commands.blocked}
              onClick={() => void handleSaveOrPublish('PUBLISH')}
            >
              {t('comm.notes.publishAction')}
            </Button>
            <Button
              variant="outline"
              disabled={!online || commands.blocked}
              onClick={() => void handleSaveOrPublish('DRAFT')}
            >
              {t('comm.notes.saveDraftAction')}
            </Button>
            {editingNoteId ? (
              <Button variant="ghost" onClick={resetForm}>
                {t('comm.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      </TabPanel>

      <TabPanel idPrefix="comm-notes-publish" id="manage" active={tab === 'manage'}>
        <div className="comm-toolbar">
          <Field label={t('comm.notes.filterStatus')}>
            {(control) => (
              <Select
                {...control}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as '' | NoteStatus)}
              >
                <option value="">{t('comm.alerts.allOption')}</option>
                {NOTE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`comm.notes.status.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {manageRead.data === undefined && !manageRead.failed ? (
          <SkeletonRows rows={3} />
        ) : (manageRead.data?.items ?? []).length === 0 ? (
          <EmptyState icon="file" title={t('comm.notes.emptyManageTitle')}>
            {t('comm.notes.emptyManageHint')}
          </EmptyState>
        ) : (
          <ul className="comm-list">
            {(manageRead.data?.items ?? []).map((note) => (
              <li key={note.id} className="comm-card">
                <div className="comm-card__head">
                  <h2 className="comm-card__title">{note.title}</h2>
                  <div className="comm-badges">
                    <Badge tone={categoryTone(note.category)}>
                      {t(`comm.notes.category.${note.category}`)}
                    </Badge>
                    <Badge
                      tone={
                        note.status === 'PUBLISHED'
                          ? 'ok'
                          : note.status === 'DRAFT'
                            ? 'warn'
                            : 'muted'
                      }
                    >
                      {t(`comm.notes.status.${note.status}`)}
                    </Badge>
                  </div>
                </div>
                <p className="comm-card__body">{note.body}</p>
                <div className="comm-card__actions">
                  {note.status === 'DRAFT' ? (
                    <Button variant="outline" size="sm" onClick={() => handleEditDraft(note)}>
                      {t('comm.notes.editDraftAction')}
                    </Button>
                  ) : null}
                  {note.status === 'PUBLISHED' ? (
                    <Button
                      variant="tonal"
                      size="sm"
                      onClick={() => setFollowUpNoteId(followUpNoteId === note.id ? null : note.id)}
                    >
                      {t('comm.notes.followUpAction')}
                    </Button>
                  ) : null}
                  {note.status !== 'ARCHIVED' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setArchiveNoteId(note.id);
                        setArchiveReason('');
                      }}
                    >
                      {t('comm.notes.archiveAction')}
                    </Button>
                  ) : null}
                </div>

                {followUpNoteId === note.id && followUpRead.data?.noteId === note.id ? (
                  <div className="comm-form-panel">
                    <div className="comm-summary-strip">
                      <div className="comm-summary-pill">
                        <span className="comm-summary-pill__label">
                          {t('comm.notes.followUpAudience')}
                        </span>
                        <span className="comm-summary-pill__value">
                          {followUpRead.data.audienceSize}
                        </span>
                      </div>
                      <div className="comm-summary-pill">
                        <span className="comm-summary-pill__label">
                          {t('comm.notes.followUpRead')}
                        </span>
                        <span className="comm-summary-pill__value">{followUpRead.data.read}</span>
                      </div>
                      <div className="comm-summary-pill">
                        <span className="comm-summary-pill__label">
                          {t('comm.notes.followUpAcked')}
                        </span>
                        <span className="comm-summary-pill__value">
                          {followUpRead.data.acknowledged}
                        </span>
                      </div>
                      <div className="comm-summary-pill">
                        <span className="comm-summary-pill__label">
                          {t('comm.notes.followUpMissing')}
                        </span>
                        <span className="comm-summary-pill__value">
                          {followUpRead.data.missingTotal}
                        </span>
                      </div>
                    </div>
                    {followUpRead.data.missing.length > 0 ? (
                      <p className="comm-card__body">
                        {t('comm.notes.followUpMissingNames', {
                          names: followUpRead.data.missing.map((m) => m.fullName).join(', '),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {archiveNoteId === note.id ? (
                  <div className="comm-form-panel">
                    <Field label={t('comm.notes.archiveReasonLabel')}>
                      {(control) => (
                        <Textarea
                          {...control}
                          rows={2}
                          value={archiveReason}
                          onChange={(e) => setArchiveReason(e.target.value)}
                        />
                      )}
                    </Field>
                    <div className="comm-inline-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={commands.blocked || !archiveReason.trim()}
                        onClick={() => void handleArchive(note.id)}
                      >
                        {t('comm.notes.confirmArchive')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setArchiveNoteId(null)}>
                        {t('comm.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </TabPanel>
    </div>
  );
}
