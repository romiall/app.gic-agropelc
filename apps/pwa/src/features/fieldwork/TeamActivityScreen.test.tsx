import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { TeamActivityScreen } from './TeamActivityScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const TEAM = '01900000-0000-7000-8000-000000000801';
const MEMBER_PRESENT = '01900000-0000-7000-8000-000000000811';
const MEMBER_OVERRIDE = '01900000-0000-7000-8000-000000000812';
const MEMBER_ABSENT = '01900000-0000-7000-8000-000000000813';

function serve() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target === '/api/v1/teams') {
      return ok({
        teams: [
          {
            id: TEAM,
            code: 'EQ-DLA',
            name: 'Équipe Littoral',
            managerUserId: '01900000-0000-7000-8000-000000000001',
            managerName: 'Resp. Commercial',
            isActive: true,
            members: [
              {
                membershipId: 'm1',
                userId: MEMBER_PRESENT,
                since: '2026-10-01T08:00:00.000Z',
                fullName: 'Awa Nde',
              },
              {
                membershipId: 'm2',
                userId: MEMBER_OVERRIDE,
                since: '2026-10-01T08:00:00.000Z',
                fullName: 'Paul Essomba',
              },
              {
                membershipId: 'm3',
                userId: MEMBER_ABSENT,
                since: '2026-10-01T08:00:00.000Z',
                fullName: 'Jean Mbarga',
              },
            ],
          },
        ],
      });
    }
    if (target.startsWith('/api/v1/work-sessions')) {
      return ok({
        teamId: TEAM,
        date: '2026-10-15',
        memberUserIds: [MEMBER_PRESENT, MEMBER_OVERRIDE, MEMBER_ABSENT],
        sessions: [
          {
            id: 's1',
            userId: MEMBER_PRESENT,
            status: 'OPEN',
            declaredZoneId: IDS.zone,
            startedAt: '2026-10-15T07:30:00.000Z',
            endedAt: null,
            closeCause: null,
            overrideStatus: 'NONE',
            overrideReason: null,
            approvalRequestId: null,
          },
          {
            id: 's2',
            userId: MEMBER_OVERRIDE,
            status: 'OPEN',
            declaredZoneId: IDS.zone,
            startedAt: '2026-10-15T08:00:00.000Z',
            endedAt: null,
            closeCause: null,
            overrideStatus: 'PENDING',
            overrideReason: 'GPS bloqué sous hangar',
            approvalRequestId: 'req-1',
          },
        ],
        checkins: [
          {
            id: 'c1',
            workSessionId: 's1',
            userId: MEMBER_PRESENT,
            declaredZoneId: IDS.zone,
            checkinType: 'START_SERVICE',
            occurredAt: '2026-10-15T07:30:00.000Z',
            distanceM: 42,
            accuracyM: 12,
            geofenceRadiusM: 500,
            clientResult: 'ACCEPTED',
            serverResult: 'ACCEPTED',
            resultDivergence: false,
            suspicionFlags: [],
            clockSuspect: false,
          },
        ],
      });
    }
    if (target.startsWith('/api/v1/visits')) {
      return ok({
        visits: [
          {
            id: 'v1',
            userId: MEMBER_PRESENT,
            customerId: IDS.customer,
            workSessionId: 's1',
            outcomeReasonCodeId: 'r1',
            notes: null,
            occurredAt: '2026-10-15T09:00:00.000Z',
            flags: [],
            status: 'RECORDED',
          },
        ],
        next_cursor: null,
      });
    }
    if (target.startsWith('/api/v1/interactions')) {
      return ok({
        interactions: [
          {
            id: 'i1',
            userId: MEMBER_PRESENT,
            customerId: IDS.customer,
            occurredAt: '2026-10-15T09:15:00.000Z',
            channel: 'PHONE',
            direction: 'OUTBOUND',
            summary: null,
            status: 'RECORDED',
          },
        ],
        next_cursor: null,
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

describe('Suivre l’équipe (ECR-TER-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('synthétise les présences, visites, échanges et dérogations en attente avec filtrage', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TeamActivityScreen />
      </MemoryRouter>,
    );

    const presentCard = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(within(presentCard).getByText('En service')).toBeInTheDocument();
    expect(within(presentCard).getByText('1 visite(s) · 1 échange(s)')).toBeInTheDocument();

    const overrideCard = screen.getByRole('listitem', { name: 'Paul Essomba' });
    expect(within(overrideCard).getByText('Dérogation en attente')).toBeInTheDocument();

    const absentCard = screen.getByRole('listitem', { name: 'Jean Mbarga' });
    expect(within(absentCard).getByText('Sans pointage')).toBeInTheDocument();

    expect(
      screen.getByText('1 demande de dérogation de pointage attend validation.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Absents' }));
    expect(screen.queryByRole('listitem', { name: 'Awa Nde' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Jean Mbarga' })).toBeInTheDocument();
  });
});
