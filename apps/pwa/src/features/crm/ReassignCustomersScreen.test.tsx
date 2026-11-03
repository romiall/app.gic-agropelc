import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { ReassignCustomersScreen } from './ReassignCustomersScreen.js';

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

const OWNER_A = '01900000-0000-7000-8000-000000000901';
const OWNER_B = '01900000-0000-7000-8000-000000000902';
const CUST_1 = '01900000-0000-7000-8000-000000000911';
const CUST_2 = '01900000-0000-7000-8000-000000000912';

function serve() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target.startsWith('/api/v1/customers')) {
      return ok({
        customers: [
          {
            id: CUST_1,
            code: 'C-01',
            displayName: 'Boulangerie Akwa',
            phonePrimary: '+237690000001',
            zoneId: IDS.zone,
            ownerUserId: OWNER_A,
            stage: 'ACTIVE_CUSTOMER',
            lastActivityAt: '2026-10-12T10:00:00.000Z',
            version: 1,
          },
          {
            id: CUST_2,
            code: 'P-02',
            displayName: 'Hôtel du Port',
            phonePrimary: '+237690000002',
            zoneId: IDS.zone,
            ownerUserId: null,
            stage: 'PROSPECT',
            lastActivityAt: null,
            version: 1,
          },
        ],
        next_cursor: null,
      });
    }
    if (target.startsWith('/api/v1/users')) {
      return ok({
        users: [
          {
            id: OWNER_A,
            fullName: 'Awa Nde',
            phone: '+237699111111',
            status: 'ACTIVE',
            roles: ['COMMERCIAL_TERRAIN'],
          },
          {
            id: OWNER_B,
            fullName: 'Paul Essomba',
            phone: '+237699222222',
            status: 'ACTIVE',
            roles: ['COMMERCIAL_TERRAIN'],
          },
        ],
        next_cursor: null,
      });
    }
    if (target === '/api/v1/teams') {
      return ok({ teams: [] });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

describe('Réaffecter un client (ECR-CRM-06)', () => {
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

  it('affiche les clients avec leur titulaire, filtre et soumet crm.customer.reassign avec motif obligatoire', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReassignCustomersScreen />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('listitem', { name: 'Boulangerie Akwa' });
    expect(within(card).getByText('Titulaire : Awa Nde')).toBeInTheDocument();

    const prospectCard = screen.getByRole('listitem', { name: 'Hôtel du Port' });
    expect(within(prospectCard).getByText('Titulaire : Sans titulaire')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Réaffecter…' }));
    const confirmBtn = within(card).getByRole('button', { name: 'Confirmer la réaffectation' });
    expect(confirmBtn).toBeDisabled();

    // Le titulaire actuel (Awa Nde) est exclu des choix : Paul Essomba est présélectionné.
    const select = within(card).getByLabelText('Nouveau titulaire');
    expect(select).toHaveValue(OWNER_B);

    await user.type(
      within(card).getByLabelText('Motif de la réaffectation'),
      'Rééquilibrage du secteur Akwa',
    );
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'crm.customer.reassign',
      aggregate_type: 'CUSTOMER',
      aggregate_id: CUST_1,
      payload: {
        newOwnerUserId: OWNER_B,
        reason: 'Rééquilibrage du secteur Akwa',
      },
    });
  });
});
