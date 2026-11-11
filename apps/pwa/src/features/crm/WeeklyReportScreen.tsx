/**
 * ECR-CRM-08 « Bilan hebdomadaire » (fiche BH ; PP-E, REQ-307, AV-314) : le commercial rédige le bilan de sa semaine (cinq
 * rubriques) avec les chiffres calculés par le serveur ; le responsable lit les bilans de son équipe et les marque comme vus.
 *
 * - Rédaction : commande `crm.weekly_report.submit`, utilisable hors ligne ; la renvoyer corrige le bilan tant que le
 *   responsable ne l'a pas vu (identifiant propre au couple commercial, semaine).
 * - Chiffres (visites, nouveaux prospects et clients, CA, encaissé, casses et pertes) : lus en ligne, jamais saisis.
 * - Lecture et « vu » du responsable : en ligne (`GET /weekly-reports`, `crm.weekly_report.review`).
 * - Hors ligne, le commercial relit son propre bilan d'après le jeu `weekly_reports` de l'appareil (AV-514 (4)).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { addBusinessDays, businessDayOf } from '@gic/domain';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Field,
  PageHeader,
  Section,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { holdsAnyRole } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useProjected } from '../../storage/projections.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { demandeBilan } from '../pieces/adaptateurs-terrain.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { phaseOf, saveErrorKey, submitCommand, useOutboxCommand } from '../sales/submit.js';
import {
  EMPTY_REPORT_DRAFT,
  WEEKLY_REPORT_REVIEW,
  WEEKLY_REPORT_SUBMIT,
  WEEKLY_REPORT_TEXT_FIELDS,
  WEEKLY_REPORT_TEXT_MAX,
  currentWeek,
  draftFingerprint,
  draftFromReport,
  hasUnsentReport,
  isDraftReady,
  nextWeek,
  pendingReportDraft,
  previousWeek,
  reportPayload,
  weeklyReportId,
  type ReportDraft,
  type ServerFigures,
  type ServerWeeklyReport,
  type WeeklyFigures,
  type WeeklyReportTextField,
} from './weekly-report.js';
import './crm.css';

/** Les commerciaux qui rédigent ; les responsables qui lisent et valident (`crm.weekly_report.*`). */
const WRITER_ROLES = ['COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'];
const REVIEWER_ROLES = ['RESP_COMMERCIAL', 'DIRECTION'];

const formatDay = (day: string): string => day.split('-').reverse().join('/');

type ReadState<T> =
  | { readonly status: 'OFFLINE' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'ERROR' }
  | { readonly status: 'OK'; readonly data: T };

/**
 * Lecture en ligne d'une ressource du serveur ; `path` nul : rien à lire. Relue quand `attempt` change ou sur `retry`.
 * Pendant une relecture du même chemin, la dernière réponse reste affichée : la liste ne se démonte pas sous
 * l'utilisateur (le résultat d'une opération qu'il vient de lancer reste visible).
 */
function useServerRead<T>(
  path: string | null,
  online: boolean,
  attempt = 0,
): { readonly state: ReadState<T>; readonly retry: () => void } {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; path: string; data: T | null }>();
  const key = `${path}:${attempt}:${nonce}`;
  useEffect(() => {
    if (!online || path === null) return;
    let cancelled = false;
    void authorizedRequest<T>(getDb(), path, { method: 'GET' }).then((result) => {
      if (!cancelled) setLoaded({ key, path, data: result.ok ? result.data : null });
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, path]);
  const retry = useCallback(() => setNonce((current) => current + 1), []);
  if (!online) return { state: { status: 'OFFLINE' }, retry };
  if (loaded?.key === key) {
    return {
      state: loaded.data !== null ? { status: 'OK', data: loaded.data } : { status: 'ERROR' },
      retry,
    };
  }
  if (loaded?.path === path && loaded.data !== null) {
    return { state: { status: 'OK', data: loaded.data }, retry };
  }
  return { state: { status: 'LOADING' }, retry };
}

function FiguresList({ figures }: { readonly figures: WeeklyFigures }) {
  const { t } = useTranslation();
  const rows: readonly (readonly [string, string])[] = [
    ['visits', String(figures.visits)],
    ['prospects', String(figures.newProspects)],
    ['customers', String(figures.newCustomers)],
    ['sales', formatMoney(figures.salesXaf)],
    ['collected', formatMoney(figures.collectedXaf)],
    ['losses', figures.lossValueXaf === null ? '—' : formatMoney(figures.lossValueXaf)],
  ];
  return (
    <dl className="weekly-figures">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{t(`weekly_report.figure.${key}`)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FiguresState({
  state,
  retry,
}: {
  readonly state: ReadState<ServerFigures>;
  readonly retry: () => void;
}) {
  const { t } = useTranslation();
  if (state.status === 'OFFLINE')
    return <Banner tone="info">{t('weekly_report.figures_offline')}</Banner>;
  if (state.status === 'LOADING') return <SkeletonRows rows={2} />;
  if (state.status === 'ERROR') {
    return (
      <Banner tone="warn">
        {t('weekly_report.figures_error')}{' '}
        <Button variant="ghost" size="sm" onClick={retry}>
          {t('weekly_report.retry')}
        </Button>
      </Banner>
    );
  }
  return <FiguresList figures={state.data.figures} />;
}

function StatusLine({ report }: { readonly report: ServerWeeklyReport | undefined }) {
  const { t } = useTranslation();
  if (!report) return <Badge tone="muted">{t('weekly_report.status_draft')}</Badge>;
  if (report.status !== 'REVIEWED') {
    return <Badge tone="warn">{t('weekly_report.status_submitted')}</Badge>;
  }
  return (
    <>
      <Badge tone="ok">{t('weekly_report.status_reviewed')}</Badge>
      {report.reviewedAt ? (
        <span className="muted">
          {' '}
          {t('weekly_report.reviewed_at', {
            date: formatDay(businessDayOf(new Date(report.reviewedAt))),
          })}
        </span>
      ) : null}
      {report.managerComment ? (
        <p className="muted">
          {t('weekly_report.manager_comment', { comment: report.managerComment })}
        </p>
      ) : null}
    </>
  );
}

interface TeamReportProps {
  readonly report: ServerWeeklyReport;
  readonly author: string;
  readonly userId: string;
  readonly online: boolean;
  readonly onReviewed: () => void;
}

/** Bilan d'un commercial de l'équipe : ses textes, ses chiffres, la fiche BH et le « vu » du responsable. */
function TeamReport({ report, author, userId, online, onReviewed }: TeamReportProps) {
  const { t } = useTranslation();
  const figures = useServerRead<ServerFigures>(
    `/api/v1/weekly-reports/figures?user_id=${report.userId}&week_start=${report.weekStart}`,
    online,
  );
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState(report.managerComment ?? '');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [reviewCommand, setReviewCommand] = useState<string>();
  const reviewOutbox = useOutboxCommand(reviewCommand);
  const reviewPhase = reviewOutbox ? phaseOf(reviewOutbox) : undefined;
  const reviewSettled = reviewPhase !== undefined && reviewPhase !== 'WAITING';
  // La liste se relit quand le serveur a répondu au « vu » (pas avant : la relecture partirait avant l'envoi et
  // montrerait encore le bilan à valider).
  useEffect(() => {
    if (reviewSettled) onReviewed();
  }, [reviewSettled, onReviewed]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const trimmed = comment.trim();
      const command = await submitCommand({
        authorUserId: userId,
        commandType: WEEKLY_REPORT_REVIEW,
        aggregateType: 'WEEKLY_REPORT',
        aggregateId: report.id,
        // Le « vu » vaut pour la version que le responsable a lue : le serveur refuse si le bilan a été corrigé depuis.
        baseVersion: report.version,
        // Sans commentaire, celui qui existe reste ; un champ vidé par le responsable l'efface (`null`).
        payload:
          trimmed !== '' ? { comment: trimmed } : report.managerComment ? { comment: null } : {},
      });
      setReviewCommand(command.command_id);
      setAsking(false);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="weekly-team-report">
      <div className="weekly-team-head">
        <strong>{author}</strong>
        <StatusLine report={report} />
      </div>
      <FiguresState state={figures.state} retry={figures.retry} />
      {WEEKLY_REPORT_TEXT_FIELDS.filter((field) => report[field]).map((field) => (
        <div key={field}>
          <h4 className="weekly-field-title">{t(`weekly_report.field.${field}`)}</h4>
          <p className="weekly-field-text">{report[field]}</p>
        </div>
      ))}
      <PieceAction
        cle={`bilan:${report.id}:${report.version}`}
        libelle={t('weekly_report.show_sheet')}
        demande={() =>
          demandeBilan(report, {
            commercial: author,
            chiffres: figures.state.status === 'OK' ? figures.state.data.figures : null,
          })
        }
      />
      {!reviewCommand ? (
        asking ? (
          <div className="weekly-review">
            <Field label={t('weekly_report.review_comment_label')} optional>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  maxLength={WEEKLY_REPORT_TEXT_MAX}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              )}
            </Field>
            {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
            <div className="weekly-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void confirm()}>
                {t('weekly_report.review_confirm')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
                {t('weekly_report.review_abort')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setComment(report.managerComment ?? '');
              setAsking(true);
            }}
          >
            {report.status === 'REVIEWED'
              ? t('weekly_report.review_edit')
              : t('weekly_report.review')}
          </Button>
        )
      ) : (
        <CommandResult commandId={reviewCommand} messages="weekly_report.review_result" />
      )}
    </li>
  );
}

export function WeeklyReportScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const today = businessDayOf(clock.now());
  const thisWeek = currentWeek(today);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [edits, setEdits] = useState<Partial<ReportDraft>>({});
  const [identified, setIdentified] = useState<{ readonly key: string; readonly id: string }>();
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const roles = navigation ? navigation.roles : [];
  const isWriter = holdsAnyRole(roles, WRITER_ROLES);
  const isReviewer = holdsAnyRole(roles, REVIEWER_ROLES);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void weeklyReportId(userId, weekStart).then((id) => {
      if (!cancelled) setIdentified({ key: `${userId}:${weekStart}`, id });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, weekStart]);
  // L'identifiant se calcule en asynchrone : celui d'une autre semaine (ou d'un autre compte) ne sert jamais.
  const aggregateId =
    userId && identified?.key === `${userId}:${weekStart}` ? identified.id : undefined;

  const knownReports = useProjected<ServerWeeklyReport>('weekly_reports', 'WEEKLY_REPORT');
  const own = useServerRead<{ reports: readonly ServerWeeklyReport[] }>(
    isWriter && userId ? `/api/v1/weekly-reports?user_id=me&week_start=${weekStart}` : null,
    online,
  );
  const figures = useServerRead<ServerFigures>(
    isWriter && userId ? `/api/v1/weekly-reports/figures?week_start=${weekStart}` : null,
    online,
  );
  const team = useServerRead<{ reports: readonly ServerWeeklyReport[] }>(
    isReviewer && userId ? `/api/v1/weekly-reports?week_start=${weekStart}` : null,
    online,
  );
  const outbox = useLiveQuery(
    async () =>
      getDb()
        .outbox.filter((command) => command.command_type === WEEKLY_REPORT_SUBMIT)
        .toArray(),
    [],
  );

  // Sans réseau, le bilan que l'appareil connaît (jeu `weekly_reports`) tient lieu de lecture (AV-514 (4)).
  const ownReport =
    own.state.status === 'OK'
      ? own.state.data.reports[0]
      : own.state.status === 'OFFLINE'
        ? knownReports?.find((report) => report.userId === userId && report.weekStart === weekStart)
        : undefined;
  const base = useMemo<ReportDraft>(() => {
    const pending =
      aggregateId && outbox ? pendingReportDraft(outbox, aggregateId, ownReport) : undefined;
    return pending ?? (ownReport ? draftFromReport(ownReport) : EMPTY_REPORT_DRAFT);
  }, [aggregateId, outbox, ownReport]);
  const draft: ReportDraft = { ...base, ...edits };
  // En ligne, tant que le bilan déjà envoyé n'est pas relu (et sans brouillon local), le formulaire n'est pas celui du
  // serveur : l'envoyer remplacerait ses textes par les seuls champs saisis.
  const unsent = aggregateId && outbox ? hasUnsentReport(outbox, aggregateId) : false;
  const readPending = (own.state.status === 'LOADING' || own.state.status === 'ERROR') && !unsent;
  // Le bilan se relit quand le serveur a répondu à l'envoi, pas avant (la relecture partirait avant l'envoi).
  const submittedOutbox = useOutboxCommand(submitted);
  const submittedSettled = submittedOutbox !== undefined && phaseOf(submittedOutbox) !== 'WAITING';
  const retryOwn = own.retry;
  useEffect(() => {
    if (submittedSettled) retryOwn();
  }, [submittedSettled, retryOwn]);

  if (!refs || !userId) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <PageHeader title={t('weekly_report.title')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const locked = ownReport?.status === 'REVIEWED';
  const weekEnd = addBusinessDays(weekStart, 6);
  const nameOf = (id: string): string =>
    refs.users.find((user) => user.id === id)?.full_name ?? t('weekly_report.unknown_author');
  const goToWeek = (next: string) => {
    setWeekStart(next);
    setEdits({});
    setSubmitted(undefined);
    setSaveError(undefined);
  };

  const submit = async () => {
    if (!isDraftReady(draft) || locked || busy || readPending || !aggregateId) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: WEEKLY_REPORT_SUBMIT,
        aggregateType: 'WEEKLY_REPORT',
        aggregateId,
        payload: reportPayload(weekStart, draft),
      });
      setSubmitted(command.command_id);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const teamReports =
    team.state.status === 'OK'
      ? team.state.data.reports.filter((report) => report.userId !== userId)
      : [];

  return (
    <section className="sale crm-screen">
      <PageHeader title={t('weekly_report.title')} />
      <p className="muted">{t('weekly_report.intro')}</p>
      {!online ? (
        <Banner tone="warn" role="status">
          {t('weekly_report.offline_banner')}
        </Banner>
      ) : null}

      <div className="weekly-week">
        <Button
          variant="outline"
          size="sm"
          aria-label={t('weekly_report.week_prev')}
          onClick={() => goToWeek(previousWeek(weekStart))}
        >
          ‹
        </Button>
        <strong>
          {t('weekly_report.week_of', { from: formatDay(weekStart), to: formatDay(weekEnd) })}
        </strong>
        <Button
          variant="outline"
          size="sm"
          aria-label={t('weekly_report.week_next')}
          disabled={nextWeek(weekStart) > thisWeek}
          onClick={() => goToWeek(nextWeek(weekStart))}
        >
          ›
        </Button>
      </div>

      {isWriter ? (
        <>
          <Section title={t('weekly_report.figures_title')}>
            <FiguresState state={figures.state} retry={figures.retry} />
          </Section>
          <Section title={t('weekly_report.title')}>
            {own.state.status === 'LOADING' ? (
              <SkeletonRows rows={1} />
            ) : (
              <div className="weekly-status">
                <StatusLine report={ownReport} />
              </div>
            )}
            {own.state.status === 'ERROR' ? (
              <Banner tone="warn">
                {t('weekly_report.own_error')}{' '}
                <Button variant="ghost" size="sm" onClick={own.retry}>
                  {t('weekly_report.retry')}
                </Button>
              </Banner>
            ) : null}
            {locked ? <Banner tone="info">{t('weekly_report.locked')}</Banner> : null}
            {WEEKLY_REPORT_TEXT_FIELDS.map((field: WeeklyReportTextField) => (
              <Field key={field} label={t(`weekly_report.field.${field}`)} optional>
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    maxLength={WEEKLY_REPORT_TEXT_MAX}
                    disabled={locked}
                    value={draft[field]}
                    onChange={(event) =>
                      setEdits((current) => ({ ...current, [field]: event.target.value }))
                    }
                  />
                )}
              </Field>
            ))}
            {!isDraftReady(draft) && Object.keys(edits).length > 0 ? (
              <Banner tone="warn">{t('weekly_report.empty_error')}</Banner>
            ) : null}
            {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
            {submitted ? (
              <CommandResult commandId={submitted} messages="weekly_report.result" />
            ) : null}
            <PieceAction
              cle={`bilan:${userId}:${weekStart}:${draftFingerprint(draft)}`}
              libelle={t('weekly_report.show_sheet')}
              demande={() =>
                demandeBilan(
                  {
                    weekStart,
                    successes: draft.successes || null,
                    difficulties: draft.difficulties || null,
                    needs: draft.needs || null,
                    priorities: draft.priorities || null,
                    marketInfo: draft.marketInfo || null,
                    status: ownReport?.status ?? 'SUBMITTED',
                    managerComment: ownReport?.managerComment ?? null,
                  },
                  {
                    commercial: nameOf(userId),
                    chiffres: figures.state.status === 'OK' ? figures.state.data.figures : null,
                  },
                )
              }
            />
            {!locked ? (
              <ActionBar>
                <Button
                  variant="primary"
                  block
                  loading={busy}
                  disabled={!isDraftReady(draft) || readPending || !aggregateId}
                  onClick={() => void submit()}
                >
                  {ownReport ? t('weekly_report.resubmit') : t('weekly_report.submit')}
                </Button>
              </ActionBar>
            ) : null}
          </Section>
        </>
      ) : null}

      {isReviewer ? (
        <Section title={t('weekly_report.team_title')}>
          {team.state.status === 'OFFLINE' ? (
            <Banner tone="info">{t('weekly_report.team_offline')}</Banner>
          ) : team.state.status === 'LOADING' ? (
            <SkeletonRows rows={2} />
          ) : team.state.status === 'ERROR' ? (
            <Banner tone="warn">
              {t('weekly_report.team_error')}{' '}
              <Button variant="ghost" size="sm" onClick={team.retry}>
                {t('weekly_report.retry')}
              </Button>
            </Banner>
          ) : teamReports.length === 0 ? (
            <p className="muted">{t('weekly_report.team_none')}</p>
          ) : (
            <ul className="weekly-team">
              {teamReports.map((report) => (
                <TeamReport
                  key={report.id}
                  report={report}
                  author={nameOf(report.userId)}
                  userId={userId}
                  online={online}
                  onReviewed={team.retry}
                />
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </section>
  );
}
