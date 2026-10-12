import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { NewVisitScreen } from './NewVisitScreen.js';
import { EMPTY_VISIT, visitPayload } from './visit.js';

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

const OUTCOME = '01900000-0000-7000-8000-0000000000f1';
const SESSION = '01900000-0000-7000-8000-0000000000f2';

function locateAt(coords: { latitude: number; longitude: number; accuracy: number } | null) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        ok: (position: { coords: typeof coords }) => void,
        fail: (error: unknown) => void,
      ) => (coords ? ok({ coords }) : fail(new Error('refusé'))),
    },
  });
}

async function seedOutcome(): Promise<void> {
  await getDb().projections.put({
    key: `reason_code:REASON_CODE:${OUTCOME}`,
    dataset: 'reason_code',
    entity_type: 'REASON_CODE',
    entity_id: OUTCOME,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: {
      id: OUTCOME,
      category: 'VISIT_OUTCOME',
      code: 'INTERESSE',
      label: 'Intéressé, à relancer',
      loss_category: null,
      requires_comment: false,
      is_active: true,
    },
  });
}

async function locateCustomer(lat: string, lng: string): Promise<void> {
  const db = getDb();
  const key = `customers:CUSTOMER:${IDS.customer}`;
  const row = await db.projections.get(key);
  if (!row) throw new Error('fixture client absente');
  await db.projections.put({ ...row, data: { ...row.data, lat, lng } });
}

async function openSession(): Promise<void> {
  await getDb().projections.put({
    key: `fieldwork:WORK_SESSION:${SESSION}`,
    dataset: 'fieldwork',
    entity_type: 'WORK_SESSION',
    entity_id: SESSION,
    scope_type: 'USER',
    scope_id: IDS.user,
    row_version: 1,
    seq: 1,
    data: {
      id: SESSION,
      user_id: IDS.user,
      declared_zone_id: IDS.zone,
      started_at: '2026-10-10T07:00:00.000Z',
      ended_at: null,
      status: 'OPEN',
      override_status: 'NOT_REQUIRED',
    },
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/clients/visite" element={<NewVisitScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('+ Visite (ECR-CRM-04)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'geolocation');
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('charge utile : position nulle sans GPS, textes vides omis', () => {
    expect(
      visitPayload({ ...EMPTY_VISIT, customerId: IDS.customer, outcomeId: OUTCOME, notes: '  ' }),
    ).toEqual({ customerId: IDS.customer, position: null, outcomeReasonCodeId: OUTCOME });
  });

  it('hors ligne, depuis la fiche : visite géolocalisée hors session, position proposée au compte, activité aussitôt visible', async () => {
    await seedOutcome();
    locateAt({ latitude: 3.8667, longitude: 11.5167, accuracy: 20 });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/clients/visite?client=${IDS.customer}`);

    expect(await screen.findByText('Boutique Mvog-Mbi')).toBeInTheDocument();
    expect(screen.getByText(/Position relevée \(précision 20 m\)/)).toBeInTheDocument();
    expect(screen.getByText(/« hors session »/)).toBeInTheDocument();
    const savePosition = screen.getByLabelText('Enregistrer cette position comme celle du compte');
    expect(savePosition).toBeChecked();

    const submit = screen.getByRole('button', { name: 'Enregistrer la visite' });
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Résultat de la visite'), OUTCOME);
    await user.type(screen.getByLabelText('Commentaire (facultatif)'), 'Stock bas');
    fireEvent.change(screen.getByLabelText('Prochaine action le (facultatif)'), {
      target: { value: '2026-10-12' },
    });
    await user.type(
      screen.getByLabelText('Prochaine action à faire (facultatif)'),
      'Livrer 10 plateaux',
    );
    await user.click(submit);
    expect(await screen.findByText(/Visite enregistrée sur ce téléphone/)).toBeInTheDocument();

    const commands = await getDb().outbox.orderBy('device_seq').toArray();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      command_type: 'crm.visit.record',
      aggregate_type: 'VISIT',
      captured_offline: true,
      depends_on: [],
      payload: {
        customerId: IDS.customer,
        position: { lat: 3.8667, lng: 11.5167, accuracyM: 20 },
        outcomeReasonCodeId: OUTCOME,
        notes: 'Stock bas',
        nextActionAt: '2026-10-12',
        nextActionNote: 'Livrer 10 plateaux',
      },
    });
    expect(commands[1]).toMatchObject({
      command_type: 'crm.customer.update',
      aggregate_type: 'CUSTOMER',
      aggregate_id: IDS.customer,
      base_version: 1,
      payload: { patch: { position: { lat: 3.8667, lng: 11.5167, accuracyM: 20 } } },
    });

    const refs = await loadSalesReferences(getDb());
    expect(refs.visits).toEqual([
      expect.objectContaining({
        customer_id: IDS.customer,
        next_action_at: '2026-10-12',
        pending_command_id: commands[0]?.command_id,
      }),
    ]);
  });

  it('« Autre visite » relève une nouvelle position, jamais celle de la visite précédente', async () => {
    await seedOutcome();
    locateAt({ latitude: 3.8667, longitude: 11.5167, accuracy: 20 });
    const user = userEvent.setup();
    renderAt(`/clients/visite?client=${IDS.customer}`);
    await user.selectOptions(await screen.findByLabelText('Résultat de la visite'), OUTCOME);
    await user.click(screen.getByRole('button', { name: 'Enregistrer la visite' }));
    locateAt({ latitude: 3.9, longitude: 11.55, accuracy: 15 });
    await user.click(await screen.findByRole('button', { name: 'Autre visite' }));
    expect(await screen.findByText(/Position relevée \(précision 15 m\)/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    await user.selectOptions(screen.getByLabelText('Résultat de la visite'), OUTCOME);
    await user.click(screen.getByRole('button', { name: 'Enregistrer la visite' }));
    await screen.findByRole('button', { name: 'Autre visite' });
    const visits = (await getDb().outbox.orderBy('device_seq').toArray()).filter(
      (command) => command.command_type === 'crm.visit.record',
    );
    expect(visits.map((command) => (command.payload as { position: unknown }).position)).toEqual([
      { lat: 3.8667, lng: 11.5167, accuracyM: 20 },
      { lat: 3.9, lng: 11.55, accuracyM: 15 },
    ]);
  });

  it('en session, loin du compte déjà situé : signalement de distance, pas de proposition de position', async () => {
    await seedOutcome();
    await openSession();
    await locateCustomer('3.8480', '11.5021');
    locateAt({ latitude: 3.8667, longitude: 11.5167, accuracy: 10 });
    renderAt(`/clients/visite?client=${IDS.customer}`);

    expect(await screen.findByText(/du compte \(plus de 500 m\)/)).toBeInTheDocument();
    expect(screen.queryByText(/« hors session »/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Enregistrer cette position comme celle du compte'),
    ).not.toBeInTheDocument();
  });

  it('sans résultat paramétré ni position : message explicite, envoi impossible ; prochaine action passée refusée', async () => {
    locateAt(null);
    renderAt(`/clients/visite?client=${IDS.customer}`);
    expect(await screen.findByText(/Aucun résultat de visite n’est paramétré/)).toBeInTheDocument();
    expect(screen.getByText(/Position indisponible/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Prochaine action le (facultatif)'), {
      target: { value: '2026-10-01' },
    });
    expect(
      screen.getByText('La prochaine action ne peut pas être dans le passé.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la visite' })).toBeDisabled();
  });
});
