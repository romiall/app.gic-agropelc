import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { SyncMonitorScreen } from './SyncMonitorScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: '01900000-0000-7000-8000-000000000701',
  }),
}));

const DEV_1 = '01900000-0000-7000-8000-000000000701';
const DEV_2 = '01900000-0000-7000-8000-000000000702';

function serve() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target.startsWith('/api/v1/devices')) {
      return ok({
        devices: [
          {
            id: DEV_1,
            shortCode: '00000701',
            status: 'ACTIVE',
            platform: 'Android 14',
            enrolledByUserId: '01900000-0000-7000-8000-000000000001',
            enrolledByName: 'Admin GIC',
            enrolledAt: '2026-10-01T08:00:00.000Z',
            designatedSiteId: IDS.site,
            lastPushAt: '2026-10-15T09:00:00.000Z',
            lastPullAt: '2026-10-15T09:05:00.000Z',
            lastContactAt: '2026-10-15T09:05:00.000Z',
            stale: false,
            pendingReported: 0,
            statusChangedAt: '2026-10-01T08:00:00.000Z',
            statusReason: null,
          },
          {
            id: DEV_2,
            shortCode: '00000702',
            status: 'ACTIVE',
            platform: 'Android 13',
            enrolledByUserId: '01900000-0000-7000-8000-000000000002',
            enrolledByName: 'Paul Essomba',
            enrolledAt: '2026-10-01T08:00:00.000Z',
            designatedSiteId: null,
            lastPushAt: '2026-10-10T08:00:00.000Z',
            lastPullAt: null,
            lastContactAt: '2026-10-10T08:00:00.000Z',
            stale: true,
            pendingReported: 4,
            statusChangedAt: '2026-10-01T08:00:00.000Z',
            statusReason: null,
          },
        ],
        next_cursor: null,
      });
    }
    if (target.startsWith('/api/v1/sync/conflicts')) {
      return ok({
        conflicts: [{ id: '01900000-0000-7000-8000-000000000799' }],
        next_cursor: null,
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

describe('Supervision de la synchronisation (ECR-SYN-02)', () => {
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

  it('affiche les appareils, leur retard, les opérations en file signalées et le bandeau de conflits ouverts', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/synchronisation/supervision']}>
        <SyncMonitorScreen />
      </MemoryRouter>,
    );

    const staleCard = await screen.findByRole('listitem', { name: 'Appareil 00000702' });
    expect(within(staleCard).getByText('En retard')).toBeInTheDocument();
    expect(within(staleCard).getByText('4 en attente')).toBeInTheDocument();
    expect(
      screen.getByText('1 conflit de synchronisation ouvert attend résolution.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'En retard' }));
    expect(screen.queryByRole('listitem', { name: 'Appareil 00000701' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Appareil 00000702' })).toBeInTheDocument();
  });
});
