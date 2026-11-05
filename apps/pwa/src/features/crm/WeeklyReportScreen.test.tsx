import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { WeeklyReportScreen } from './WeeklyReportScreen.js';
import { weeklyReportId } from './weekly-report.js';

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

const FIGURES = {
  visits: 14,
  newProspects: 5,
  newCustomers: 2,
  salesXaf: 1_250_000,
  collectedXaf: 980_000,
  lossDeclarations: 1,
  lossValueXaf: null,
};

const serverReport = (overrides: Record<string, unknown> = {}) => ({
  id: 'r-1',
  userId: IDS.user,
  weekStart: '2026-11-02',
  successes: 'Deux commandes',
  difficulties: null,
  needs: null,
  priorities: null,
  marketInfo: null,
  status: 'SUBMITTED',
  lastEditedAt: '2026-11-04T08:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  managerComment: null,
  version: 1,
  ...overrides,
});

/**
 * Réponses du serveur selon la route lue. `reports` répond au bilan du commercial (`user_id=me`) et, sans `team`, à la
 * liste de l'équipe ; `team` répond seul à la liste de l'équipe.
 */
function serve(
  options: { reports?: unknown[]; team?: unknown[]; figures?: unknown | null; own?: 'ERROR' } = {},
) {
  vi.mocked(authorizedRequest).mockImplementation((async (_db: unknown, path: string) => {
    if (path.startsWith('/api/v1/weekly-reports/figures')) {
      return options.figures === null
        ? { ok: false }
        : {
            ok: true,
            data: {
              user_id: IDS.user,
              week_start: '2026-11-02',
              figures: options.figures ?? FIGURES,
            },
          };
    }
    if (path.includes('user_id=me')) {
      return options.own === 'ERROR'
        ? { ok: false }
        : { ok: true, data: { reports: options.reports ?? [] } };
    }
    return { ok: true, data: { reports: options.team ?? options.reports ?? [] } };
  }) as never);
}

const OTHER_USER = '01900000-0000-7000-8000-0000000000aa';
const teamPaths = () =>
  vi
    .mocked(authorizedRequest)
    .mock.calls.map((call) => String(call[1]))
    .filter((path) => path.startsWith('/api/v1/weekly-reports?week_start='));

/** Commande de l'outbox sous l'identifiant du bilan, comme celle d'une rédaction de l'appareil. */
const submitCommandRow = (aggregateId: string, overrides: Record<string, unknown>) =>
  ({
    command_id: 'c-draft',
    device_seq: 1,
    command_type: 'crm.weekly_report.submit',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'WEEKLY_REPORT',
    aggregate_id: aggregateId,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-11-04T09:00:00.000Z',
    client_created_at: '2026-11-04T09:00:00.000Z',
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: { weekStart: '2026-11-02', successes: 'Texte de l’appareil' },
    status: 'SYNCED',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  }) as never;

describe('Bilan hebdomadaire (ECR-CRM-08)', () => {
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

  it('chiffres de la semaine calculés par le serveur ; rédaction mise en file sous l’identifiant du couple commercial, semaine', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Visites sur place')).toBeInTheDocument();
    expect(await screen.findByText('14')).toBeInTheDocument();
    expect(screen.getByText('Nouveaux clients')).toBeInTheDocument();
    // Valeur des pertes au coût : masquée sans le droit de valorisation.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Semaine du 02/11/2026 au 08/11/2026')).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest)).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/weekly-reports/figures?week_start=2026-11-02',
      { method: 'GET' },
    );

    const submit = screen.getByRole('button', { name: 'Enregistrer le bilan' });
    expect(submit).toBeDisabled();
    await user.type(
      screen.getByLabelText('Réussites de la semaine (facultatif)'),
      'Deux commandes',
    );
    await user.type(
      screen.getByLabelText('Besoins et demandes à la direction (facultatif)'),
      'Plateaux',
    );
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'crm.weekly_report.submit',
      aggregate_type: 'WEEKLY_REPORT',
      aggregate_id: await weeklyReportId(IDS.user, '2026-11-02'),
      payload: { weekStart: '2026-11-02', successes: 'Deux commandes', needs: 'Plateaux' },
    });
  });

  it('bilan déjà envoyé : textes repris du serveur, statut, correction possible', async () => {
    serve({ reports: [serverReport()] });
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Deux commandes')).toBeInTheDocument();
    expect(screen.getByText('Envoyé, pas encore vu par le responsable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la correction' })).toBeEnabled();
  });

  it('bilan vu par le responsable : figé, commentaire affiché', async () => {
    serve({
      reports: [
        serverReport({
          status: 'REVIEWED',
          reviewedAt: '2026-11-05T10:00:00.000Z',
          reviewedBy: 'm-1',
          managerComment: 'Bon rythme',
        }),
      ],
    });
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Bilan vu par le responsable : il n’est plus modifiable.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Commentaire du responsable : Bon rythme')).toBeInTheDocument();
    expect(screen.getByLabelText('Réussites de la semaine (facultatif)')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Enregistrer la correction' }),
    ).not.toBeInTheDocument();
  });

  it('une rédaction encore dans la file de l’appareil prime sur le bilan du serveur', async () => {
    serve({ reports: [serverReport()] });
    const aggregateId = await weeklyReportId(IDS.user, '2026-11-02');
    await getDb().outbox.put({
      command_id: 'c-pending',
      device_seq: 1,
      command_type: 'crm.weekly_report.submit',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'WEEKLY_REPORT',
      aggregate_id: aggregateId,
      base_version: null,
      depends_on: [],
      occurred_at: '2026-11-04T09:00:00.000Z',
      client_created_at: '2026-11-04T09:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { weekStart: '2026-11-02', successes: 'Texte corrigé hors ligne' },
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    } as never);
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Texte corrigé hors ligne')).toBeInTheDocument();
  });

  it('un bilan corrigé depuis un autre appareil prime sur la rédaction déjà acceptée de celui-ci', async () => {
    // Le serveur a le texte de 08 h ; la rédaction acceptée de cet appareil date de 07 h : le serveur fait foi.
    serve({
      reports: [
        serverReport({ successes: 'Texte du serveur', lastEditedAt: '2026-11-04T08:00:00.000Z' }),
      ],
    });
    await getDb().outbox.put(
      submitCommandRow(await weeklyReportId(IDS.user, '2026-11-02'), {
        occurred_at: '2026-11-04T07:00:00.000Z',
      }),
    );
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Texte du serveur')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Texte de l’appareil')).not.toBeInTheDocument();
  });

  it('une rédaction refusée par le serveur (bilan déjà vu) ne remplace pas le texte figé', async () => {
    serve({
      reports: [
        serverReport({
          status: 'REVIEWED',
          reviewedAt: '2026-11-05T10:00:00.000Z',
          reviewedBy: 'm-1',
          successes: 'Texte figé',
        }),
      ],
    });
    await getDb().outbox.put(
      submitCommandRow(await weeklyReportId(IDS.user, '2026-11-02'), {
        status: 'REJECTED',
        last_error: { code: 'REPORT_LOCKED', message_fr: 'Bilan déjà vu.' },
      }),
    );
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Texte figé')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Texte de l’appareil')).not.toBeInTheDocument();
  });

  it('tant que le bilan déjà envoyé n’est pas relu, l’envoi est bloqué : il remplacerait les textes du serveur', async () => {
    vi.mocked(authorizedRequest).mockImplementation((() => new Promise(() => undefined)) as never);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    await user.type(
      await screen.findByLabelText('Réussites de la semaine (facultatif)'),
      'Un texte',
    );
    expect(screen.getByRole('button', { name: 'Enregistrer le bilan' })).toBeDisabled();
    // Pas d'« envoyé » ni de « pas encore envoyé » tant que le serveur n'a pas répondu.
    expect(screen.queryByText('Pas encore envoyé')).not.toBeInTheDocument();
  });

  it('relecture du bilan en échec : message et nouvel essai, envoi bloqué', async () => {
    serve({ own: 'ERROR' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Le bilan déjà envoyé n’a pas pu être relu/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Réussites de la semaine (facultatif)'), 'Un texte');
    expect(screen.getByRole('button', { name: 'Enregistrer le bilan' })).toBeDisabled();
  });

  it('un brouillon de l’appareil non encore envoyé s’envoie même sans relire le serveur', async () => {
    serve({ own: 'ERROR' });
    await getDb().outbox.put(
      submitCommandRow(await weeklyReportId(IDS.user, '2026-11-02'), { status: 'LOCAL_ONLY' }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue('Texte de l’appareil')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Réussites de la semaine (facultatif)'), ' complété');
    // Le bilan du serveur n'a pas été relu : le bouton est celui d'un premier envoi, et il part (brouillon local).
    expect(screen.getByRole('button', { name: 'Enregistrer le bilan' })).toBeEnabled();
  });

  describe('bilans de l’équipe : « vu » du responsable', () => {
    const teamReport = (overrides: Record<string, unknown> = {}) =>
      serverReport({ id: 'r-team', userId: OTHER_USER, version: 3, ...overrides });

    it('le « vu » porte la version lue par le responsable ; sans commentaire, la charge est vide', async () => {
      serve({ team: [teamReport()] });
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <WeeklyReportScreen />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('button', { name: 'Marquer comme vu' }));
      await user.click(screen.getByRole('button', { name: 'Valider' }));
      await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
      const [command] = await getDb().outbox.toArray();
      expect(command).toMatchObject({
        command_type: 'crm.weekly_report.review',
        aggregate_id: 'r-team',
        base_version: 3,
        payload: {},
      });
    });

    it('bilan déjà vu : le commentaire est repris pour être modifié, vidé il s’efface', async () => {
      serve({
        team: [
          teamReport({
            status: 'REVIEWED',
            reviewedAt: '2026-11-05T10:00:00.000Z',
            reviewedBy: 'm-1',
            managerComment: 'Bon rythme',
          }),
        ],
      });
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <WeeklyReportScreen />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('button', { name: 'Modifier le commentaire' }));
      const comment = screen.getByLabelText('Commentaire (facultatif)');
      expect(comment).toHaveValue('Bon rythme');
      await user.clear(comment);
      await user.click(screen.getByRole('button', { name: 'Valider' }));
      await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
      const [command] = await getDb().outbox.toArray();
      expect(command).toMatchObject({ base_version: 3, payload: { comment: null } });
    });

    it('la liste reste affichée pendant la relecture et se relit quand le serveur a répondu au « vu »', async () => {
      serve({ team: [teamReport()] });
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <WeeklyReportScreen />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('button', { name: 'Marquer comme vu' }));
      await user.click(screen.getByRole('button', { name: 'Valider' }));
      await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
      // Tant que la commande n'est pas partie, la liste n'est pas relue (la relecture précéderait l'envoi).
      expect(teamPaths()).toHaveLength(1);
      const [command] = await getDb().outbox.toArray();
      await getDb().outbox.update(command!.command_id, { status: 'SYNCED' });
      await waitFor(() => expect(teamPaths()).toHaveLength(2));
      // Le bilan et le résultat de l'opération n'ont pas été démontés par la relecture.
      expect(screen.getByText('Bilan marqué comme vu.')).toBeInTheDocument();
      expect(screen.getByText('Commercial inconnu de cet appareil')).toBeInTheDocument();
    });
  });

  it('hors ligne : chiffres et bilans lus en ligne seulement, rédaction possible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Les chiffres de la semaine se calculent en ligne.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Réussites de la semaine (facultatif)')).toBeEnabled();
    expect(vi.mocked(authorizedRequest)).not.toHaveBeenCalled();
  });

  it('semaines voisines : la semaine suivante n’est pas proposée au-delà de la semaine en cours', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <WeeklyReportScreen />
      </MemoryRouter>,
    );
    const next = await screen.findByRole('button', { name: 'Semaine suivante' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    expect(await screen.findByText('Semaine du 26/10/2026 au 01/11/2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Semaine suivante' })).toBeEnabled();
  });
});
