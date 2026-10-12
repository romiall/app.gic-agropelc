import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { CustomerScreen } from './CustomerScreen.js';
import { InteractionScreen } from './InteractionScreen.js';
import { EMPTY_INTERACTION, interactionPayload } from './interaction.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/clients/:customerId" element={<CustomerScreen />} />
        <Route path="/clients/:customerId/echange" element={<InteractionScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Noter un échange (ECR-CRM-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('charge utile : textes vides omis, sens par défaut vers le client', () => {
    expect(
      interactionPayload(IDS.customer, { ...EMPTY_INTERACTION, channel: 'SMS', summary: ' ' }),
    ).toEqual({ customerId: IDS.customer, channel: 'SMS', direction: 'SORTANT' });
  });

  it('hors ligne, depuis la fiche : appel noté, aussitôt visible dans l’activité du compte', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/clients/${IDS.customer}`);
    await user.click(await screen.findByRole('link', { name: 'Noter un échange' }));
    const submit = await screen.findByRole('button', { name: 'Enregistrer l’échange' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Appel'));
    await user.click(screen.getByLabelText('Du client'));
    await user.type(screen.getByLabelText('Résumé (facultatif)'), 'Demande 20 plateaux');
    fireEvent.change(screen.getByLabelText('Prochaine action le (facultatif)'), {
      target: { value: '2026-10-11' },
    });
    await user.click(submit);
    expect(await screen.findByText(/Échange enregistré sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'crm.interaction.record',
      aggregate_type: 'INTERACTION',
      captured_offline: true,
      payload: {
        customerId: IDS.customer,
        channel: 'APPEL',
        direction: 'ENTRANT',
        summary: 'Demande 20 plateaux',
        nextActionAt: '2026-10-11',
      },
    });

    await user.click(screen.getByRole('link', { name: '← Fiche du compte' }));
    const activity = within(
      await screen.findByRole('region', { name: 'Visites et échanges (90 jours)' }),
    );
    expect(activity.getByText('Demande 20 plateaux')).toBeInTheDocument();
    expect(activity.getByText('Non confirmé')).toBeInTheDocument();
  });
});
