/**
 * ECR-TER-03 « Présence du personnel » (fiche PT ; PP-E, REQ-306, AV-313) : report de la fiche de présence de la semaine
 * (une feuille par site et par semaine : une ligne par personne, des heures ou un code d'absence par jour) et lecture des
 * feuilles déjà reportées, avec la fiche PT imprimable et l'annulation motivée.
 *
 * - Report : commande `fieldwork.presence.record`, utilisable hors ligne (mise en file, envoyée au retour du réseau).
 * - Lecture et annulation : en ligne (`GET /staff-presence`, `fieldwork.presence.cancel`) ; la fiche PT se prépare depuis
 *   la feuille lue.
 * - Usage statistique et de suivi : ni paie ni discipline (AV-313).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PRESENCE_ABSENCE_CODES,
  PRESENCE_ABSENCE_LABELS,
  PRESENCE_MAX_LINES,
  PRESENCE_WEEK_LENGTH,
  businessDayOf,
  formatWorkedMinutes,
  mondayOf,
  weekDaysOf,
  type PresenceAbsenceCode,
} from '@gic/domain';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROLE_SETS } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { demandePresence } from '../pieces/adaptateurs-terrain.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { phaseOf, saveErrorKey, submitCommand, useOutboxCommand } from '../sales/submit.js';
import {
  MAX_MISSION,
  MAX_PAPER_REF,
  MAX_PERSON_NAME,
  MAX_PERSON_ROLE,
  MAX_RESPONSIBLE,
  checkSheet,
  emptyLine,
  emptySheet,
  lineWorkedMinutes,
  recordPayload,
  serverLineMinutes,
  weekStartOfInput,
  type DayDraft,
  type LineDraft,
  type ServerPresenceSheet,
  type SheetDraft,
} from './presence-form.js';
import './presence.css';

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});

/** « lun. 02/11 » : jour de la semaine et date, sans décalage de fuseau (jour métier). */
function dayLabel(day: string): string {
  return DAY_FORMAT.format(new Date(`${day}T00:00:00.000Z`));
}

const formatDay = (day: string): string => day.split('-').reverse().join('/');

type SheetsState =
  | { readonly status: 'OFFLINE' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'ERROR' }
  | { readonly status: 'OK'; readonly sheets: readonly ServerPresenceSheet[] };

/**
 * Feuilles reportées pour la semaine, lues en ligne ; relecture sur demande (`reload`). Pendant une relecture de la même
 * semaine, la dernière réponse reste affichée : la liste ne se démonte pas sous l'utilisateur (le résultat de
 * l'annulation qu'il vient de lancer reste visible).
 */
function useRecordedSheets(
  weekStart: string,
  online: boolean,
): { readonly state: SheetsState; readonly reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    weekStart: string;
    sheets: readonly ServerPresenceSheet[] | null;
  }>();
  const key = `${weekStart}:${attempt}`;
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void authorizedRequest<{ sheets: readonly ServerPresenceSheet[] }>(
      getDb(),
      `/api/v1/staff-presence?week_start=${weekStart}&include_cancelled=true`,
      { method: 'GET' },
    ).then((result) => {
      if (!cancelled) {
        setLoaded({ key, weekStart, sheets: result.ok ? result.data.sheets : null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, weekStart]);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  if (!online) return { state: { status: 'OFFLINE' }, reload };
  if (loaded?.key === key) {
    return {
      state: loaded.sheets ? { status: 'OK', sheets: loaded.sheets } : { status: 'ERROR' },
      reload,
    };
  }
  if (loaded?.weekStart === weekStart && loaded.sheets) {
    return { state: { status: 'OK', sheets: loaded.sheets }, reload };
  }
  return { state: { status: 'LOADING' }, reload };
}

interface LineEditorProps {
  readonly line: LineDraft;
  readonly index: number;
  readonly weekStart: string;
  readonly onChange: (patch: Partial<LineDraft>) => void;
  readonly onRemove: () => void;
  readonly removable: boolean;
}

function LineEditor({ line, index, weekStart, onChange, onRemove, removable }: LineEditorProps) {
  const { t } = useTranslation();
  const dates = weekDaysOf(weekStart);
  const minutes = lineWorkedMinutes(line, weekStart);
  const setDay = (dayIndex: number, patch: Partial<DayDraft>) =>
    onChange({
      days: line.days.map((day, position) => (position === dayIndex ? { ...day, ...patch } : day)),
    });
  return (
    <fieldset className="presence-line">
      <legend>{t('presence.person_title', { n: index + 1 })}</legend>
      <Field label={t('presence.name_label')}>
        {(control) => (
          <Input
            {...control}
            maxLength={MAX_PERSON_NAME}
            value={line.personName}
            onChange={(event) => onChange({ personName: event.target.value })}
          />
        )}
      </Field>
      <div className="presence-pair">
        <Field label={t('presence.role_label')} optional>
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_PERSON_ROLE}
              value={line.personRole}
              onChange={(event) => onChange({ personRole: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('presence.mission_label')} optional>
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_MISSION}
              value={line.missionLabel}
              onChange={(event) => onChange({ missionLabel: event.target.value })}
            />
          )}
        </Field>
      </div>
      <ul className="presence-days">
        {dates.slice(0, PRESENCE_WEEK_LENGTH).map((date, dayIndex) => {
          const day = line.days[dayIndex]!;
          const absent = day.absence !== '';
          return (
            <li key={date} className="presence-day">
              <span className="presence-day-name">{dayLabel(date)}</span>
              <Field label={t('presence.arrival_label')} className="presence-time">
                {(control) => (
                  <Input
                    {...control}
                    type="time"
                    aria-label={`${t('presence.arrival_label')} ${dayLabel(date)}`}
                    disabled={absent}
                    value={day.arrival}
                    onChange={(event) => setDay(dayIndex, { arrival: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('presence.departure_label')} className="presence-time">
                {(control) => (
                  <Input
                    {...control}
                    type="time"
                    aria-label={`${t('presence.departure_label')} ${dayLabel(date)}`}
                    disabled={absent}
                    value={day.departure}
                    onChange={(event) => setDay(dayIndex, { departure: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('presence.absence_label')} className="presence-code">
                {(control) => (
                  <Select
                    {...control}
                    aria-label={`${t('presence.absence_label')} ${dayLabel(date)}`}
                    value={day.absence}
                    onChange={(event) => {
                      const absence = event.target.value as PresenceAbsenceCode | '';
                      setDay(
                        dayIndex,
                        absence === '' ? { absence } : { absence, arrival: '', departure: '' },
                      );
                    }}
                  >
                    <option value="">{t('presence.absence_none')}</option>
                    {PRESENCE_ABSENCE_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code} — {PRESENCE_ABSENCE_LABELS[code]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </li>
          );
        })}
      </ul>
      <p className="presence-total">
        {t('presence.total_hours', { hours: formatWorkedMinutes(minutes) })}
      </p>
      {removable ? (
        <Button variant="ghost" size="sm" onClick={onRemove}>
          {t('presence.remove_person')}
        </Button>
      ) : null}
    </fieldset>
  );
}

interface RecordedSheetProps {
  readonly sheet: ServerPresenceSheet;
  readonly siteName: string | null;
  readonly canCancel: boolean;
  readonly userId: string;
  readonly onCancelled: () => void;
}

function RecordedSheet({ sheet, siteName, canCancel, userId, onCancelled }: RecordedSheetProps) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [cancelCommand, setCancelCommand] = useState<string>();
  const cancelOutbox = useOutboxCommand(cancelCommand);
  const cancelSettled = cancelOutbox !== undefined && phaseOf(cancelOutbox) !== 'WAITING';
  const cancelled = sheet.status === 'CANCELLED';
  // La liste se relit quand le serveur a répondu à l'annulation (pas avant : la relecture partirait avant l'envoi et
  // montrerait encore la feuille à annuler).
  useEffect(() => {
    if (cancelSettled) onCancelled();
  }, [cancelSettled, onCancelled]);

  const confirm = async () => {
    if (comment.trim() === '' || busy) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'fieldwork.presence.cancel',
        aggregateType: 'PRESENCE_SHEET',
        aggregateId: sheet.id,
        payload: { comment: comment.trim() },
      });
      setCancelCommand(command.command_id);
      setAsking(false);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="presence-sheet">
      <div className="presence-sheet-head">
        <strong>
          {sheet.paperRef
            ? t('presence.sheet_ref', { ref: sheet.paperRef })
            : t('presence.sheet_no_ref')}
        </strong>
        <span className="muted">
          {[siteName, t('presence.sheet_people', { count: sheet.lines.length })]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {cancelled ? <Badge tone="bad">{t('presence.sheet_cancelled')}</Badge> : null}
      </div>
      {sheet.responsibleName ? (
        <p className="muted">{t('presence.sheet_responsible', { name: sheet.responsibleName })}</p>
      ) : null}
      {cancelled && sheet.cancelComment ? (
        <p className="muted">
          {t('presence.sheet_cancelled_comment', { comment: sheet.cancelComment })}
        </p>
      ) : null}
      <ul className="presence-people">
        {sheet.lines.map((line) => (
          <li key={line.lineNo}>
            <span>{line.personName}</span>
            <span className="muted">{formatWorkedMinutes(serverLineMinutes(line))}</span>
          </li>
        ))}
      </ul>
      <PieceAction
        cle={`presence:${sheet.id}`}
        libelle={t('presence.show_sheet')}
        annulee={cancelled}
        demande={() => demandePresence(sheet, siteName)}
      />
      {canCancel && !cancelled && !cancelCommand ? (
        asking ? (
          <div className="presence-cancel">
            <Field label={t('presence.cancel_comment_label')}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={500}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              )}
            </Field>
            {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
            <div className="presence-actions">
              <Button
                variant="danger"
                size="sm"
                disabled={comment.trim() === '' || busy}
                onClick={() => void confirm()}
              >
                {t('presence.cancel_confirm')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
                {t('presence.cancel_abort')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
            {t('presence.cancel')}
          </Button>
        )
      ) : null}
      {cancelCommand ? (
        <CommandResult commandId={cancelCommand} messages="presence.cancel_result" />
      ) : null}
    </li>
  );
}

export function PresenceScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const today = businessDayOf(clock.now());
  const [draft, setDraft] = useState<SheetDraft>(() => emptySheet(mondayOf(today)));
  const [lineCounter, setLineCounter] = useState(1);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [showIssues, setShowIssues] = useState(false);
  // Saisie brute du champ date : une année tapée au clavier passe par des dates absurdes avant « 2026 ».
  const [weekInput, setWeekInput] = useState(draft.weekStart);
  const recorded = useRecordedSheets(draft.weekStart, online);
  const submittedOutbox = useOutboxCommand(submitted);
  const submittedRejected =
    submittedOutbox !== undefined && phaseOf(submittedOutbox) === 'REJECTED';

  if (!refs || !userId) {
    return (
      <section className="sale presence-screen" aria-busy="true">
        <PageHeader title={t('presence.title')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const roles = navigation ? navigation.roles : [];
  const canManage = holdsAnyRole(roles, ROLE_SETS.presence);
  const sites = [...refs.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const issues = checkSheet(draft, clock.now());
  const update = (patch: Partial<SheetDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  const addLine = () => {
    const key = `l${lineCounter + 1}`;
    setLineCounter(lineCounter + 1);
    setDraft((current) => ({ ...current, lines: [...current.lines, emptyLine(key)] }));
  };
  const removeLine = (key: string) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.key !== key),
    }));

  const submit = async () => {
    setShowIssues(true);
    if (issues.length > 0 || busy) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'fieldwork.presence.record',
        aggregateType: 'PRESENCE_SHEET',
        payload: recordPayload(draft),
      });
      setSubmitted(command.command_id);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const siteName = (siteId: string): string | null => refs.sites.get(siteId)?.name ?? null;
  const issueText = (issue: (typeof issues)[number]): string =>
    t(`presence.issue.${issue.code}`, {
      n: issue.line ?? 0,
      max: PRESENCE_MAX_LINES,
      detail: issue.detail ?? '',
    });

  return (
    <section className="sale presence-screen">
      <PageHeader title={t('presence.title')} />
      <p className="muted">{t('presence.intro')}</p>
      {!online ? (
        <Banner tone="warn" role="status">
          {t('presence.offline_banner')}
        </Banner>
      ) : null}

      {submitted ? (
        <CommandResult commandId={submitted} messages="presence.result">
          {submittedRejected ? (
            <Button
              variant="outline"
              onClick={() => {
                // La feuille refusée revient dans le formulaire, telle qu'elle a été saisie.
                setSubmitted(undefined);
                setShowIssues(false);
              }}
            >
              {t('presence.fix')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              setDraft(emptySheet(draft.weekStart, `l${lineCounter + 1}`));
              setLineCounter(lineCounter + 1);
              setSubmitted(undefined);
              setShowIssues(false);
              recorded.reload();
            }}
          >
            {t('presence.another')}
          </Button>
        </CommandResult>
      ) : (
        <Section title={t('presence.new_title')}>
          <div className="presence-pair">
            <Field label={t('presence.site_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={draft.siteId}
                  onChange={(event) => update({ siteId: event.target.value })}
                >
                  <option value="">{t('presence.site_placeholder')}</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('presence.week_label')} hint={t('presence.week_hint')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  min="2020-01-01"
                  value={weekInput}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const next = weekStartOfInput(raw, '');
                    if (next === '') {
                      setWeekInput(raw);
                    } else {
                      setWeekInput(next);
                      update({ weekStart: next });
                    }
                  }}
                  onBlur={() => setWeekInput(draft.weekStart)}
                />
              )}
            </Field>
          </div>
          <div className="presence-pair">
            <Field label={t('presence.paper_ref_label')} optional>
              {(control) => (
                <Input
                  {...control}
                  maxLength={MAX_PAPER_REF}
                  value={draft.paperRef}
                  onChange={(event) => update({ paperRef: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('presence.responsible_label')} optional>
              {(control) => (
                <Input
                  {...control}
                  maxLength={MAX_RESPONSIBLE}
                  value={draft.responsibleName}
                  onChange={(event) => update({ responsibleName: event.target.value })}
                />
              )}
            </Field>
          </div>
          {draft.lines.map((line, index) => (
            <LineEditor
              key={line.key}
              line={line}
              index={index}
              weekStart={draft.weekStart}
              onChange={(patch) => updateLine(line.key, patch)}
              onRemove={() => removeLine(line.key)}
              removable={draft.lines.length > 1}
            />
          ))}
          <Button
            variant="outline"
            onClick={addLine}
            disabled={draft.lines.length >= PRESENCE_MAX_LINES}
          >
            {t('presence.add_person')}
          </Button>
          {showIssues && issues.length > 0 ? (
            <Banner tone="bad" role="alert">
              <strong>{t('presence.issues_title')}</strong>
              <ul>
                {issues.map((issue, position) => (
                  <li key={`${issue.code}-${issue.line ?? 0}-${position}`}>{issueText(issue)}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
          <ActionBar>
            <Button variant="primary" block loading={busy} onClick={() => void submit()}>
              {t('presence.submit')}
            </Button>
          </ActionBar>
        </Section>
      )}

      <Section title={t('presence.recorded_title')}>
        <p className="muted">{t('presence.recorded_week', { date: formatDay(draft.weekStart) })}</p>
        {recorded.state.status === 'OFFLINE' ? (
          <Banner tone="info">{t('presence.recorded_offline')}</Banner>
        ) : recorded.state.status === 'LOADING' ? (
          <SkeletonRows rows={2} />
        ) : recorded.state.status === 'ERROR' ? (
          <Banner tone="warn">
            {t('presence.recorded_error')}{' '}
            <Button variant="ghost" size="sm" onClick={recorded.reload}>
              {t('presence.retry')}
            </Button>
          </Banner>
        ) : recorded.state.sheets.length === 0 ? (
          <p className="muted">{t('presence.recorded_none')}</p>
        ) : (
          <ul className="presence-sheets">
            {recorded.state.sheets.map((sheet) => (
              <RecordedSheet
                key={sheet.id}
                sheet={sheet}
                siteName={siteName(sheet.siteId)}
                canCancel={canManage}
                userId={userId}
                onCancelled={recorded.reload}
              />
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}
