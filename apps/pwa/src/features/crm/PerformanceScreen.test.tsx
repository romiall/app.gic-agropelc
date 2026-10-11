import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PerformanceScreen } from './PerformanceScreen.js';
import { periodOf } from './performance.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

function activity(type: 'VISIT' | 'INTERACTION' | 'SALES_TARGET', id: string, data: object) {
  return {
    key: `crm_activity:${type}:${id}`,
    dataset: 'crm_activity',
    entity_type: type,
    entity_id: id,
    scope_type: 'USER',
    scope_id: IDS.user,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

const visit = (id: string, at: string) =>
  activity('VISIT', id, {
    customer_id: IDS.customer,
    user_id: IDS.user,
    outcome_reason_code_id: null,
    notes: null,
    next_action_at: null,
    next_action_note: null,
    flags: [],
    status: 'RECORDED',
    occurred_at: at,
  });

const target = (id: string, metric: string, value: string) =>
  activity('SALES_TARGET', id, {
    target_type: 'USER',
    user_id: IDS.user,
    team_id: null,
    site_id: null,
    metric,
    product_id: null,
    period_start: '2026-10-01',
    period_end: '2026-10-31',
    target_value: value,
    status: 'ACTIVE',
  });

function renderScreen() {
  return render(
    <MemoryRouter>
      <PerformanceScreen />
    </MemoryRouter>,
  );
}

describe('Mes objectifs (ECR-CRM-05)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      visit('v1', '2026-10-02T09:00:00.000Z'),
      visit('v2', '2026-10-09T15:00:00.000Z'),
      // Mois précédent : hors période.
      visit('v3', '2026-09-28T09:00:00.000Z'),
      target('t1', 'VISITES', '10'),
      target('t2', 'CA', '500000'),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('période : mois en cours jusqu’à aujourd’hui, ou le jour', () => {
    expect(periodOf('MONTH', '2026-10-10')).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(periodOf('TODAY', '2026-10-10')).toEqual({ from: '2026-10-10', to: '2026-10-10' });
  });

  it('hors ligne : estimation de l’appareil, chiffre d’affaires en ligne seulement', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Hors ligne : estimation de ce téléphone/)).toBeInTheDocument();
    const effort = within(screen.getByRole('region', { name: 'Mon activité' }));
    expect(effort.getByText('Visites').nextElementSibling).toHaveTextContent('2');
    expect(effort.getByText('Nouveaux clients').nextElementSibling).toHaveTextContent('en ligne');
    const targets = within(screen.getByRole('region', { name: 'Mes objectifs' }));
    expect(targets.getByText('2 sur 10')).toBeInTheDocument();
    expect(targets.getByText('20 %')).toBeInTheDocument();
    expect(targets.getByText(/réalisé en ligne/)).toBeInTheDocument();
    expect(authorizedRequest).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText('Aujourd’hui'));
    expect(effort.getByText('Visites').nextElementSibling).toHaveTextContent('0');
  });

  it('en ligne : chiffres du serveur, chiffre d’affaires réalisé', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: {
        effort: {
          prospectsCreated: 3,
          visits: 7,
          customersVisited: 5,
          prospectsVisited: 2,
          interactions: 4,
          newCustomers: 1,
        },
        targets: [
          {
            id: 't2',
            metric: 'CA',
            productId: null,
            periodStart: '2026-10-01',
            periodEnd: '2026-10-31',
            targetValue: 500000,
            realized: 150000,
          },
        ],
      },
    });
    renderScreen();
    expect(await screen.findByText(/Chiffres du serveur/)).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/performance/commercial?from=2026-10-01&to=2026-10-10',
      { method: 'GET' },
    );
    const effort = within(screen.getByRole('region', { name: 'Mon activité' }));
    expect(effort.getByText('Visites').nextElementSibling).toHaveTextContent('7');
    expect(effort.getByText('Nouveaux clients').nextElementSibling).toHaveTextContent('1');
    const targets = within(screen.getByRole('region', { name: 'Mes objectifs' }));
    expect(targets.getByText(/150\s000\sF\sCFA sur 500\s000\sF\sCFA/)).toBeInTheDocument();
    expect(targets.getByText('30 %')).toBeInTheDocument();
  });
});
