import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { SyncConflictsScreen } from './SyncConflictsScreen.js';

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

const CONFLICT_APPLIED = '01900000-0000-7000-8000-000000000601';
const CONFLICT_SELF = '01900000-0000-7000-8000-000000000602';
const CONFLICT_MANAGED = '01900000-0000-7000-8000-000000000603';
const COMPENSATING_REF = '01900000-0000-7000-8000-000000000699';

function serve() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target.startsWith('/api/v1/sync/conflicts')) {
      return ok({
        conflicts: [
          {
            id: CONFLICT_APPLIED,
            commandId: '01900000-0000-7000-8000-000000000611',
            conflictType: 'STOCK_NEGATIVE',
            entityType: 'STOCK_POSITION',
            entityId: '01900000-0000-7000-8000-000000000621',
            siteId: IDS.site,
            authorUserId: '01900000-0000-7000-8000-000000000002',
            ownerRole: 'MAGASINIER',
            applied: true,
            details: {},
            status: 'OPEN',
            resolvedByUserId: null,
            resolvedAt: null,
            resolution: null,
            resolutionComment: null,
            compensatingCommandRefs: null,
            createdAt: '2026-10-15T08:00:00.000Z',
          },
          {
            id: CONFLICT_SELF,
            commandId: '01900000-0000-7000-8000-000000000612',
            conflictType: 'PRICE_MISMATCH',
            entityType: 'SALE',
            entityId: '01900000-0000-7000-8000-000000000622',
            siteId: IDS.site,
            authorUserId: '01900000-0000-7000-8000-000000000001',
            ownerRole: 'RESP_COMMERCIAL',
            applied: true,
            details: {},
            status: 'OPEN',
            resolvedByUserId: null,
            resolvedAt: null,
            resolution: null,
            resolutionComment: null,
            compensatingCommandRefs: null,
            createdAt: '2026-10-15T08:30:00.000Z',
          },
          {
            id: CONFLICT_MANAGED,
            commandId: '01900000-0000-7000-8000-000000000613',
            conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
            entityType: 'PAYMENT',
            entityId: '01900000-0000-7000-8000-000000000623',
            siteId: IDS.site,
            authorUserId: '01900000-0000-7000-8000-000000000002',
            ownerRole: 'FINANCE',
            applied: false,
            details: {},
            status: 'OPEN',
            resolvedByUserId: null,
            resolvedAt: null,
            resolution: null,
            resolutionComment: null,
            compensatingCommandRefs: null,
            createdAt: '2026-10-15T09:00:00.000Z',
          },
        ],
        next_cursor: null,
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

describe('Conflits de synchronisation (ECR-SYN-03)', () => {
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

  it('respecte AV-192 (auto-clôture interdite), renvoie les doublons de référence de paiement vers les validations et soumet sync.conflict.resolve', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SyncConflictsScreen />
      </MemoryRouter>,
    );

    const selfCard = await screen.findByRole('listitem', { name: 'Prix différent du catalogue' });
    expect(
      within(selfCard).getByText(/Vous êtes l’auteur de cette opération déjà appliquée/),
    ).toBeInTheDocument();
    expect(within(selfCard).queryByRole('button', { name: 'Résoudre…' })).toBeNull();

    const managedCard = screen.getByRole('listitem', { name: 'Référence de paiement en double' });
    expect(
      within(managedCard).getByText(
        /Ce doublon de référence de paiement se décide par sa validation dédiée/,
      ),
    ).toBeInTheDocument();
    expect(within(managedCard).queryByRole('button', { name: 'Résoudre…' })).toBeNull();

    const appliedCard = screen.getByRole('listitem', { name: 'Stock devenu négatif' });
    await user.click(within(appliedCard).getByRole('button', { name: 'Résoudre…' }));
    await user.click(
      within(appliedCard).getByRole('radio', {
        name: 'Régulariser par opération(s) compensatoire(s)',
      }),
    );

    const confirmBtn = within(appliedCard).getByRole('button', { name: 'Confirmer la résolution' });
    expect(confirmBtn).toBeDisabled();

    await user.type(
      within(appliedCard).getByLabelText(
        'Identifiant(s) UUID des opérations compensatoires (exigé)',
      ),
      COMPENSATING_REF,
    );
    await user.type(
      within(appliedCard).getByLabelText('Commentaire justificatif (exigé)'),
      'Inventaire de régularisation comptabilisé',
    );
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'sync.conflict.resolve',
      aggregate_type: 'SYNC_CONFLICT',
      aggregate_id: CONFLICT_APPLIED,
      payload: {
        resolution: 'COMPENSATE',
        comment: 'Inventaire de régularisation comptabilisé',
        refs: [COMPENSATING_REF],
      },
    });
  });
});
