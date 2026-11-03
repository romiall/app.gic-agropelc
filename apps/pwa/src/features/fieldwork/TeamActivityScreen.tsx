/**
 * ECR-TER-02 « Présences et activité de l'équipe » (RP-3 ; UC-TER-02, UC-TER-03).
 * En ligne seulement : permet au responsable commercial et à la Direction de suivre, pour une équipe
 * et un jour métier, les prises et fins de service, les tentatives refusées hors zone ou imprécises,
 * les demandes de dérogation en attente, ainsi que les visites et échanges enregistrés.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { zonePathLabel } from '../crm/prospect.js';
import { formatClockTime } from '../home/format-home.js';
import type { TeamView } from '../organization/organization.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type Pages,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import {
  ATTENDANCE_FILTERS,
  buildTeamActivity,
  filterMemberActivity,
  interactionsOfDayPath,
  TEAMS_PATH,
  visitsOfDayPath,
  workSessionsPath,
  type AttendanceStatus,
  type InteractionRow,
  type MemberAttendanceFilter,
  type VisitRow,
  type WorkSessionsResponse,
} from './team-activity.js';
import '../users/admin.css';
import './fieldwork.css';

const MAX_PAGES = 5;

const STATUS_TONE: Readonly<Record<AttendanceStatus, BadgeTone>> = {
  IN_SERVICE: 'ok',
  ENDED: 'info',
  PENDING_OVERRIDE: 'warn',
  REJECTED_ONLY: 'bad',
  ABSENT: 'muted',
};

export function TeamActivityScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const today = businessDayOf(clock.now());
  const [date, setDate] = useState(today);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [filter, setFilter] = useState<MemberAttendanceFilter>('ALL');

  const teamsRead = useOnlineRead<{ readonly teams: readonly TeamView[] }>(
    online ? TEAMS_PATH : null,
    (path) => readPath<{ readonly teams: readonly TeamView[] }>(path),
    online,
    date,
  );
  const teams = (teamsRead.data?.teams ?? []).filter((team) => team.isActive);
  const activeTeam =
    teams.find((team) => team.id === selectedTeamId) ??
    teams.find((team) => team.managerUserId === userId) ??
    teams[0];
  const effectiveTeamId = activeTeam?.id ?? null;

  const sessionsRead = useOnlineRead<WorkSessionsResponse>(
    online && effectiveTeamId ? workSessionsPath(effectiveTeamId, date) : null,
    (path) => readPath<WorkSessionsResponse>(path),
    online,
    `${effectiveTeamId ?? ''}:${date}`,
  );
  const visitsRead = useOnlineRead<Pages<VisitRow>>(
    online && effectiveTeamId ? visitsOfDayPath(date) : null,
    (path) => readPages<VisitRow>([path], 'visits', MAX_PAGES),
    online,
    `${effectiveTeamId ?? ''}:${date}`,
  );
  const interactionsRead = useOnlineRead<Pages<InteractionRow>>(
    online && effectiveTeamId ? interactionsOfDayPath(date) : null,
    (path) => readPages<InteractionRow>([path], 'interactions', MAX_PAGES),
    online,
    `${effectiveTeamId ?? ''}:${date}`,
  );

  const refreshAll = () => {
    teamsRead.retry();
    sessionsRead.retry();
    visitsRead.retry();
    interactionsRead.retry();
  };
  useRefreshOnVisible(refreshAll);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.team_activity')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.team_activity')} />
        <Banner tone="muted" role="status">
          {t('team_activity.online_only')}
        </Banner>
      </section>
    );
  }

  const fallbackNames = new Map<string, string>();
  if (refs) {
    for (const u of refs.users) fallbackNames.set(u.id, u.full_name);
  }
  const zoneName = (zoneId: string): string => {
    if (!refs) return zoneId;
    const zone = refs.zones.get(zoneId);
    return zone ? zonePathLabel(refs.zones, zone) : zoneId;
  };

  const { members, summary } = buildTeamActivity(
    activeTeam,
    sessionsRead.data,
    visitsRead.data?.items ?? [],
    interactionsRead.data?.items ?? [],
    fallbackNames,
  );
  const visibleMembers = filterMemberActivity(members, filter);
  const loading =
    (teamsRead.data === undefined && !teamsRead.failed) ||
    (effectiveTeamId !== null && sessionsRead.data === undefined && !sessionsRead.failed);
  const failed = teamsRead.failed || sessionsRead.failed;
  const denied = teamsRead.denied || sessionsRead.denied;

  return (
    <section className="sale adm-screen">
      <PageHeader
        title={t('nav.screens.team_activity')}
        actions={
          <Button
            variant="tonal"
            icon="sync"
            onClick={refreshAll}
            disabled={teamsRead.stale || sessionsRead.stale}
          >
            {t('team_activity.refresh')}
          </Button>
        }
      />
      <HelpDisclosure title={t('team_activity.help_title')}>
        <p>{t('team_activity.intro')}</p>
      </HelpDisclosure>

      {summary.pendingOverridesCount > 0 ? (
        <Banner
          tone="warn"
          action={
            <LinkButton to={`${ROUTES.approvals}?types=CHECKIN_OVERRIDE`} variant="tonal" size="sm">
              {t('team_activity.open_approvals')}
            </LinkButton>
          }
        >
          {t('team_activity.pending_overrides_banner', { count: summary.pendingOverridesCount })}
        </Banner>
      ) : null}

      <div className="adm-toolbar">
        {teams.length > 1 ? (
          <Field label={t('team_activity.team_label')}>
            {(control) => (
              <Select
                {...control}
                value={activeTeam?.id ?? ''}
                onChange={(event) => setSelectedTeamId(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('team_activity.date_label')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              max={today}
              value={date}
              onChange={(event) => setDate(event.target.value || today)}
            />
          )}
        </Field>
        <Segmented
          label={t('team_activity.filter_label')}
          value={filter}
          onChange={setFilter}
          options={ATTENDANCE_FILTERS.map((option) => ({
            value: option,
            label: t(`team_activity.filter.${option}`),
          }))}
        />
      </div>

      {failed ? (
        <Banner
          tone="bad"
          action={
            denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={refreshAll}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {denied ? t('team_activity.denied') : t('team_activity.unavailable')}
        </Banner>
      ) : null}

      {loading ? <SkeletonRows rows={4} /> : null}

      {!loading && !failed && teams.length === 0 ? (
        <EmptyState icon="users" title={t('team_activity.no_team')} />
      ) : null}

      {!loading && !failed && activeTeam ? (
        <>
          <p className="adm-note" role="status">
            {t('team_activity.summary_line', {
              present: summary.presentCount,
              total: summary.membersCount,
              visits: summary.visitsCount,
              interactions: summary.interactionsCount,
              rejected: summary.rejectedCheckinsCount,
            })}
          </p>
          {visibleMembers.length === 0 ? (
            <EmptyState icon="users" title={t('team_activity.empty_filter')} />
          ) : (
            <ul className="adm-cards" aria-label={t('nav.screens.team_activity')}>
              {visibleMembers.map((member) => (
                <li key={member.userId} className="line-card" aria-label={member.fullName}>
                  <div className="adm-card-head">
                    <div className="crm-who">
                      <Avatar name={member.fullName} />
                      <div className="crm-who-text">
                        <strong>{member.fullName}</strong>
                        <small className="adm-sub">
                          {t('team_activity.member_counts', {
                            visits: member.visitsCount,
                            interactions: member.interactionsCount,
                          })}
                        </small>
                      </div>
                    </div>
                    <Badge tone={STATUS_TONE[member.status]}>
                      {t(`team_activity.status.${member.status}`)}
                    </Badge>
                  </div>

                  {member.sessions.map((session) => (
                    <p key={session.id} className="adm-note">
                      {session.endedAt
                        ? t('team_activity.session_closed', {
                            zone: zoneName(session.declaredZoneId),
                            start: formatClockTime(session.startedAt),
                            end: formatClockTime(session.endedAt),
                          })
                        : t('team_activity.session_open', {
                            zone: zoneName(session.declaredZoneId),
                            start: formatClockTime(session.startedAt),
                          })}
                      {session.overrideStatus !== 'NONE'
                        ? ` · ${t(`team_activity.override.${session.overrideStatus}`)}`
                        : ''}
                      {session.overrideReason ? ` (${session.overrideReason})` : ''}
                    </p>
                  ))}

                  {member.checkins.length > 0 ? (
                    <ul className="adm-roles" aria-label={t('team_activity.checkins_aria')}>
                      {member.checkins.map((checkin) => {
                        const accepted = checkin.serverResult === 'ACCEPTED';
                        return (
                          <li key={checkin.id}>
                            <span>
                              <strong>{t(`service.type.${checkin.checkinType}`)}</strong> ·{' '}
                              {zoneName(checkin.declaredZoneId)} ·{' '}
                              {formatClockTime(checkin.occurredAt)}
                              {checkin.distanceM !== null
                                ? ` · ${Math.round(checkin.distanceM)} m`
                                : ''}
                            </span>
                            <Badge tone={accepted ? 'ok' : 'warn'}>
                              {t(`service.attempt_result.${checkin.serverResult}`, {
                                defaultValue: checkin.serverResult,
                              })}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {member.flaggedVisitsCount > 0 ? (
                    <p className="adm-note is-warn">
                      {t('team_activity.flagged_visits', { count: member.flaggedVisitsCount })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
