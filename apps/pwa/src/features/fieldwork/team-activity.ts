/**
 * Règles pures de l'écran ECR-TER-02 « Présences et activité de l'équipe » (RP-3 ; UC-TER-02, UC-TER-03).
 * Agrège par membre d'équipe les sessions de travail, les tentatives de pointage (`GET /work-sessions`),
 * les visites (`GET /visits`) et les échanges (`GET /interactions`) d'un jour métier.
 */
import type { TeamView } from '../organization/organization.js';

export const TEAMS_PATH = '/api/v1/teams';

export type MemberAttendanceFilter = 'ALL' | 'PRESENT' | 'ABSENT' | 'ANOMALY';

export const ATTENDANCE_FILTERS: readonly MemberAttendanceFilter[] = [
  'ALL',
  'PRESENT',
  'ABSENT',
  'ANOMALY',
];

export interface WorkSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly overrideStatus: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly declaredZoneId: string;
  readonly closeCause: string | null;
  readonly overrideReason: string | null;
  readonly approvalRequestId: string | null;
}

export interface CheckinRow {
  readonly id: string;
  readonly userId: string;
  readonly checkinType: string;
  readonly declaredZoneId: string;
  readonly accuracyM: number | null;
  readonly distanceM: number | null;
  readonly geofenceRadiusM: number | null;
  readonly clientResult: string;
  readonly serverResult: string;
  readonly resultDivergence: boolean;
  readonly workSessionId: string | null;
  readonly suspicionFlags: readonly string[];
  readonly occurredAt: string;
  readonly clockSuspect: boolean;
}

export interface WorkSessionsResponse {
  readonly date: string;
  readonly sessions: readonly WorkSessionRow[];
  readonly checkins: readonly CheckinRow[];
}

export interface VisitRow {
  readonly id: string;
  readonly customerId: string;
  readonly userId: string;
  readonly workSessionId: string | null;
  readonly outcomeReasonCodeId: string;
  readonly notes: string | null;
  readonly flags: readonly string[];
  readonly status: string;
  readonly occurredAt: string;
}

export interface InteractionRow {
  readonly id: string;
  readonly customerId: string;
  readonly userId: string;
  readonly channel: string;
  readonly direction: string;
  readonly summary: string | null;
  readonly status: string;
  readonly occurredAt: string;
}

export type AttendanceStatus =
  'IN_SERVICE' | 'ENDED' | 'PENDING_OVERRIDE' | 'REJECTED_ONLY' | 'ABSENT';

export interface MemberDailyActivity {
  readonly userId: string;
  readonly fullName: string;
  readonly status: AttendanceStatus;
  readonly sessions: readonly WorkSessionRow[];
  readonly checkins: readonly CheckinRow[];
  readonly visitsCount: number;
  readonly flaggedVisitsCount: number;
  readonly interactionsCount: number;
  readonly rejectedCheckinsCount: number;
  readonly hasPendingOverride: boolean;
  readonly hasAnomaly: boolean;
}

export interface TeamDailySummary {
  readonly membersCount: number;
  readonly presentCount: number;
  readonly absentCount: number;
  readonly pendingOverridesCount: number;
  readonly rejectedCheckinsCount: number;
  readonly visitsCount: number;
  readonly interactionsCount: number;
}

export function workSessionsPath(teamId: string, date: string): string {
  return `/api/v1/work-sessions?team_id=${encodeURIComponent(teamId)}&date=${encodeURIComponent(date)}`;
}

export function visitsOfDayPath(date: string): string {
  return `/api/v1/visits?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`;
}

export function interactionsOfDayPath(date: string): string {
  return `/api/v1/interactions?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`;
}

function deriveAttendanceStatus(
  sessions: readonly WorkSessionRow[],
  checkins: readonly CheckinRow[],
): AttendanceStatus {
  if (sessions.some((s) => s.overrideStatus === 'PENDING')) {
    return 'PENDING_OVERRIDE';
  }
  const validSessions = sessions.filter((s) => s.overrideStatus !== 'REJECTED');
  if (validSessions.some((s) => s.endedAt === null && s.status === 'OPEN')) {
    return 'IN_SERVICE';
  }
  if (validSessions.length > 0) {
    return 'ENDED';
  }
  if (checkins.length > 0) {
    return 'REJECTED_ONLY';
  }
  return 'ABSENT';
}

export function buildTeamActivity(
  team: TeamView | undefined,
  workSessions: WorkSessionsResponse | undefined,
  visits: readonly VisitRow[],
  interactions: readonly InteractionRow[],
  fallbackNames: ReadonlyMap<string, string>,
): {
  readonly members: readonly MemberDailyActivity[];
  readonly summary: TeamDailySummary;
} {
  const sessions = workSessions?.sessions ?? [];
  const checkins = workSessions?.checkins ?? [];

  const memberMap = new Map<string, string>();
  if (team) {
    for (const member of team.members) {
      memberMap.set(
        member.userId,
        member.fullName ?? fallbackNames.get(member.userId) ?? member.userId,
      );
    }
  }
  for (const s of sessions) {
    if (!memberMap.has(s.userId)) {
      memberMap.set(s.userId, fallbackNames.get(s.userId) ?? s.userId);
    }
  }
  for (const c of checkins) {
    if (!memberMap.has(c.userId)) {
      memberMap.set(c.userId, fallbackNames.get(c.userId) ?? c.userId);
    }
  }

  const members: MemberDailyActivity[] = [...memberMap.entries()]
    .map(([userId, fullName]) => {
      const userSessions = sessions.filter((s) => s.userId === userId);
      const userCheckins = checkins.filter((c) => c.userId === userId);
      const userVisits = visits.filter((v) => v.userId === userId && v.status === 'RECORDED');
      const userInteractions = interactions.filter(
        (i) => i.userId === userId && i.status === 'RECORDED',
      );
      const status = deriveAttendanceStatus(userSessions, userCheckins);
      const rejectedCheckinsCount = userCheckins.filter(
        (c) => c.serverResult !== 'ACCEPTED',
      ).length;
      const flaggedVisitsCount = userVisits.filter((v) => v.flags.length > 0).length;
      const hasPendingOverride = userSessions.some((s) => s.overrideStatus === 'PENDING');
      const hasAnomaly =
        rejectedCheckinsCount > 0 ||
        flaggedVisitsCount > 0 ||
        hasPendingOverride ||
        userCheckins.some(
          (c) => c.resultDivergence || c.clockSuspect || c.suspicionFlags.length > 0,
        );

      return {
        userId,
        fullName,
        status,
        sessions: userSessions,
        checkins: userCheckins,
        visitsCount: userVisits.length,
        flaggedVisitsCount,
        interactionsCount: userInteractions.length,
        rejectedCheckinsCount,
        hasPendingOverride,
        hasAnomaly,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr'));

  const presentCount = members.filter(
    (m) => m.status === 'IN_SERVICE' || m.status === 'ENDED',
  ).length;
  const absentCount = members.filter((m) => m.status === 'ABSENT').length;
  const pendingOverridesCount = members.filter((m) => m.hasPendingOverride).length;
  const rejectedCheckinsCount = members.reduce((sum, m) => sum + m.rejectedCheckinsCount, 0);
  const visitsCount = members.reduce((sum, m) => sum + m.visitsCount, 0);
  const interactionsCount = members.reduce((sum, m) => sum + m.interactionsCount, 0);

  return {
    members,
    summary: {
      membersCount: members.length,
      presentCount,
      absentCount,
      pendingOverridesCount,
      rejectedCheckinsCount,
      visitsCount,
      interactionsCount,
    },
  };
}

export function filterMemberActivity(
  members: readonly MemberDailyActivity[],
  filter: MemberAttendanceFilter,
): MemberDailyActivity[] {
  return members.filter((member) => {
    if (filter === 'PRESENT') {
      return member.status === 'IN_SERVICE' || member.status === 'ENDED';
    }
    if (filter === 'ABSENT') {
      return member.status === 'ABSENT' || member.status === 'REJECTED_ONLY';
    }
    if (filter === 'ANOMALY') {
      return member.hasAnomaly;
    }
    return true;
  });
}
