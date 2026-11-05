import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PresenceScreen } from './PresenceScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  // Mercredi 4 novembre 2026 : la semaine en cours commence le lundi 2 novembre.
  const clock = new FixedClock(new Date('2026-11-04T09:00:00.000Z'));
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

const SHEET_ID = '01900000-0000-7000-8000-0000000000a1';

const recordedSheet = (overrides: Record<string, unknown> = {}) => ({
  id: SHEET_ID,
  siteId: IDS.site,
  weekStart: '2026-11-02',
  paperRef: '000042',
  responsibleName: 'Joseph Ngo Bayiha',
  status: 'RECORDED',
  recordedAt: '2026-11-04T08:00:00.000Z',
  cancelledAt: null,
  cancelComment: null,
  lines: [
    {
      lineNo: 1,
      personName: 'Paul Essomba',
      personRole: 'Ouvrier',
      missionLabel: null,
      userId: null,
      days: [
        { date: '2026-11-02', arrival: '07:00', departure: '16:00', absenceCode: null },
        { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'M' },
      ],
    },
  ],
  ...overrides,
});

describe('Présence du personnel (ECR-TER-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    vi.mocked(authorizedRequest).mockReset();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : feuille remplie (heures, code d’absence), mise en file avec la charge du serveur', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Site'), IDS.site);
    expect(screen.getByLabelText('Semaine du (lundi)')).toHaveValue('2026-11-02');
    await user.type(screen.getByLabelText('Numéro de la feuille papier (facultatif)'), '000042');
    await user.type(screen.getByLabelText('Nom et prénom'), 'Paul Essomba');
    fireEvent.change(screen.getAllByLabelText('Arrivée')[0]!, { target: { value: '07:45' } });
    fireEvent.change(screen.getAllByLabelText('Départ')[0]!, { target: { value: '16:30' } });
    expect(screen.getByText('Total : 8 h 45')).toBeInTheDocument();
    await user.selectOptions(screen.getAllByLabelText('Code d’absence')[1]!, 'M');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la feuille' }));
    expect(await screen.findByText(/Feuille enregistrée sur cet appareil/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'fieldwork.presence.record',
      aggregate_type: 'PRESENCE_SHEET',
      captured_offline: true,
      payload: {
        siteId: IDS.site,
        weekStart: '2026-11-02',
        paperRef: '000042',
        responsibleName: null,
        lines: [
          {
            personName: 'Paul Essomba',
            personRole: null,
            missionLabel: null,
            days: [
              { date: '2026-11-02', arrival: '07:45', departure: '16:30', absenceCode: null },
              { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'M' },
            ],
          },
        ],
      },
    });
  });

  it('une feuille incomplète n’est pas envoyée : les points à corriger sont listés', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Enregistrer la feuille' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Choisissez le site.')).toBeInTheDocument();
    expect(within(alert).getByText('Ajoutez au moins une personne.')).toBeInTheDocument();
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('en ligne : feuilles reportées de la semaine, fiche PT, annulation motivée mise en file', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: { sheets: [recordedSheet()] },
    } as never);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Feuille n° 000042')).toBeInTheDocument();
    expect(screen.getByText(/PDV Yaoundé · 1 personne\(s\)/)).toBeInTheDocument();
    expect(screen.getByText('Paul Essomba')).toBeInTheDocument();
    expect(screen.getByText('9 h')).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest)).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/staff-presence?week_start=2026-11-02&include_cancelled=true',
      { method: 'GET' },
    );
    expect(screen.getByRole('button', { name: 'Voir la fiche PT' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Annuler la feuille' }));
    await user.type(screen.getByLabelText('Motif de l’annulation'), 'Saisie en double');
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'fieldwork.presence.cancel',
      aggregate_type: 'PRESENCE_SHEET',
      aggregate_id: SHEET_ID,
      payload: { comment: 'Saisie en double' },
    });
  });

  it('une feuille annulée est marquée et ne propose plus l’annulation', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: {
        sheets: [recordedSheet({ status: 'CANCELLED', cancelComment: 'Saisie en double' })],
      },
    } as never);
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Annulée')).toBeInTheDocument();
    expect(screen.getByText('Annulée : Saisie en double')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Annuler la feuille' })).not.toBeInTheDocument();
  });

  it('feuille refusée par le serveur : « Corriger la feuille » ramène le formulaire tel qu’il a été saisi', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Site'), IDS.site);
    await user.type(screen.getByLabelText('Nom et prénom'), 'Paul Essomba');
    fireEvent.change(screen.getAllByLabelText('Arrivée')[0]!, { target: { value: '07:45' } });
    await user.click(screen.getByRole('button', { name: 'Enregistrer la feuille' }));
    expect(await screen.findByText(/Feuille enregistrée sur cet appareil/)).toBeInTheDocument();
    const [command] = await getDb().outbox.toArray();
    await getDb().outbox.update(command!.command_id, {
      status: 'REJECTED',
      last_error: { code: 'PRESENCE_ID_TAKEN', message_fr: 'Identifiant déjà pris.' },
    });
    expect(await screen.findByText(/Feuille refusée/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Corriger la feuille' }));
    expect(await screen.findByLabelText('Nom et prénom')).toHaveValue('Paul Essomba');
    expect(screen.getByLabelText('Site')).toHaveValue(IDS.site);
  });

  it('la liste reste affichée pendant la relecture et se relit quand le serveur a répondu à l’annulation', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: { sheets: [recordedSheet()] },
    } as never);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Annuler la feuille' }));
    await user.type(screen.getByLabelText('Motif de l’annulation'), 'Saisie en double');
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const reads = () =>
      vi
        .mocked(authorizedRequest)
        .mock.calls.filter((call) => String(call[1]).startsWith('/api/v1/staff-presence')).length;
    // Tant que l'annulation n'est pas partie, la liste n'est pas relue (la relecture précéderait l'envoi).
    expect(reads()).toBe(1);
    const [command] = await getDb().outbox.toArray();
    await getDb().outbox.update(command!.command_id, { status: 'SYNCED' });
    await waitFor(() => expect(reads()).toBe(2));
    // La feuille et le résultat de l'annulation n'ont pas été démontés par la relecture.
    expect(screen.getByText('Feuille annulée.')).toBeInTheDocument();
    expect(screen.getByText('Paul Essomba')).toBeInTheDocument();
  });

  it('une semaine qui n’a pas commencé est refusée avant l’envoi, comme par le serveur', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Site'), IDS.site);
    await user.type(screen.getByLabelText('Nom et prénom'), 'Paul Essomba');
    fireEvent.change(screen.getAllByLabelText('Arrivée')[0]!, { target: { value: '07:45' } });
    fireEvent.change(screen.getByLabelText('Semaine du (lundi)'), {
      target: { value: '2026-11-11' },
    });
    // Le mercredi 11/11 ramène au lundi 09/11, la semaine suivante de celle du 04/11.
    expect(screen.getByLabelText('Semaine du (lundi)')).toHaveValue('2026-11-09');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la feuille' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pas encore commencé/);
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('une année tapée au clavier passe par des dates absurdes sans changer la semaine ni lever d’exception', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    const week = await screen.findByLabelText('Semaine du (lundi)');
    for (const raw of ['0002-11-02', '0202-11-02']) {
      fireEvent.change(week, { target: { value: raw } });
      // La saisie brute reste affichée pendant la frappe…
      expect(week).toHaveValue(raw);
    }
    // … et quand le champ perd le focus sans date plausible, il revient à la semaine de la feuille.
    fireEvent.blur(week);
    expect(week).toHaveValue('2026-11-02');
    fireEvent.change(week, { target: { value: '2026-10-28' } });
    expect(week).toHaveValue('2026-10-26');
  });

  it('en ligne : un avis non bloquant signale le numéro d’une feuille déjà reportée du même site et de la même semaine (AV-514)', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: {
        sheets: [
          recordedSheet(),
          recordedSheet({
            id: '01900000-0000-7000-8000-0000000000a2',
            paperRef: '000050',
            status: 'CANCELLED',
            cancelComment: 'Saisie en double',
          }),
        ],
      },
    } as never);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    await screen.findByText('Feuille n° 000042');
    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    const paperRef = screen.getByLabelText('Numéro de la feuille papier (facultatif)');
    const notice = /Une feuille n° \S+ est déjà reportée pour ce site et cette semaine/;

    await user.type(paperRef, '000043');
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    // La casse et les espaces de bord ne comptent pas ; l'avis nomme le numéro tel qu'il est saisi, sans espaces de bord.
    await user.clear(paperRef);
    await user.type(paperRef, ' 000042 ');
    expect(await screen.findByText(/Une feuille n° 000042 est déjà reportée/)).toBeInTheDocument();
    // Une feuille annulée du même numéro ne compte pas.
    await user.clear(paperRef);
    await user.type(paperRef, '000050');
    expect(screen.queryByText(notice)).not.toBeInTheDocument();

    // L'avis ne bloque pas le report : la feuille part, le serveur la signalera.
    await user.clear(paperRef);
    await user.type(paperRef, '000042');
    expect(await screen.findByText(notice)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nom et prénom'), 'Rose Atangana');
    fireEvent.change(screen.getAllByLabelText('Arrivée')[0]!, { target: { value: '07:45' } });
    await user.click(screen.getByRole('button', { name: 'Enregistrer la feuille' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'fieldwork.presence.record',
      payload: { paperRef: '000042' },
    });
  });

  it('hors ligne : les feuilles déjà reportées se lisent en ligne', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <MemoryRouter>
        <PresenceScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Les feuilles déjà reportées se lisent en ligne.'),
    ).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest)).not.toHaveBeenCalled();
  });
});
