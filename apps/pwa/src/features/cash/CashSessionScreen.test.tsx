import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import {
  CASH_SESSION_ID,
  cashSessionRow,
  IDS,
  meSettingRow,
  POS_CASH_ACCOUNT,
  posCashAccountRow,
  seedSalesFixtures,
} from '../sales/fixtures.js';
import { CashSessionScreen } from './CashSessionScreen.js';

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
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

const OTHER_USER = '01900000-0000-7000-8000-0000000000e9';

function renderScreen() {
  return render(
    <MemoryRouter>
      <CashSessionScreen />
    </MemoryRouter>,
  );
}

/** Ouverture de la caisse saisie sur l'appareil, sans réponse. */
function pendingOpen(author: string = IDS.user): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000f1',
    device_seq: 1,
    command_type: 'finance.cash_session.open',
    command_version: 1,
    author_user_id: author,
    aggregate_type: 'CASH_SESSION',
    aggregate_id: '01900000-0000-7000-8000-0000000000f2',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T06:30:00.000Z',
    client_created_at: '2026-10-10T06:30:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: { cashAccountId: POS_CASH_ACCOUNT, countedXaf: 15_000 },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
  };
}

async function outboxOf(type: string) {
  return (await getDb().outbox.toArray()).filter((command) => command.command_type === type);
}

describe('Caisse du PDV (ECR-DIS-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put(posCashAccountRow());
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : ouverture comptée à l’aveugle, enregistrée sur le téléphone, attendu indicatif ensuite', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Ouvrir la caisse' })).toBeInTheDocument();
    expect(screen.getByText('Caisse fermée.')).toBeInTheDocument();
    // Comptage à l'aveugle (AV-232) : aucun montant attendu avant l'enregistrement.
    expect(screen.queryByText(/Attendu/)).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Ouvrir la caisse' });
    expect(submit).toBeDisabled();
    const count = screen.getByLabelText('Montant compté (F CFA)');
    await user.type(count, '19 5x');
    expect(screen.getByText('Saisissez le montant compté en francs entiers.')).toBeInTheDocument();
    expect(count).toHaveAttribute('aria-invalid', 'true');
    expect(submit).toBeDisabled();
    await user.clear(count);
    await user.type(count, '19 500');
    await user.type(screen.getByLabelText('Commentaire (facultatif)'), '  Pièces comptées  ');
    await user.click(submit);

    expect(
      await screen.findByText(
        'Ouverture de la caisse enregistrée sur ce téléphone ; elle sera envoyée au retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [open] = await outboxOf('finance.cash_session.open');
    expect(open).toMatchObject({
      aggregate_type: 'CASH_SESSION',
      captured_offline: true,
      payload: { cashAccountId: POS_CASH_ACCOUNT, countedXaf: 19_500, comment: 'Pièces comptées' },
    });
    // Attendu indicatif après le comptage : le solde servi de la caisse (20 000).
    expect(
      await screen.findByText(/Attendu indicatif \(calculé sur ce téléphone\) : 20\s000 F CFA/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Écart indicatif : -500 F CFA/)).toBeInTheDocument();

    // Retour : la caisse est ouverte sur le téléphone, la clôture attend l'ouverture.
    await user.click(screen.getByRole('button', { name: 'Retour à la caisse' }));
    expect(await screen.findByRole('heading', { name: 'Clôturer la caisse' })).toBeInTheDocument();
    expect(
      screen.getByText('Ouverture enregistrée sur ce téléphone, en attente d’envoi.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant compté (F CFA)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Clôturer la caisse' }));
    await screen.findByText(/Clôture de la caisse enregistrée sur ce téléphone/);
    const [close] = await outboxOf('finance.cash_session.close');
    expect(close).toMatchObject({
      aggregate_type: 'CASH_SESSION',
      aggregate_id: open?.aggregate_id,
      depends_on: [open?.command_id],
      payload: { countedXaf: 25_000 },
    });
    // Attendu indicatif d'une session inconnue du serveur : le fonds compté à l'ouverture.
    expect(await screen.findByText(/Écart indicatif : 5\s500 F CFA/)).toBeInTheDocument();
  });

  it('en ligne : clôture de la session servie, attendu et statut du serveur à sa réponse', async () => {
    await getDb().projections.put(cashSessionRow());
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Clôturer la caisse' })).toBeInTheDocument();
    expect(
      screen.getByText(/Caisse ouverte le .* par vous, fonds compté : 20\s000 F CFA\./),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant compté (F CFA)'), '23000');
    await user.click(screen.getByRole('button', { name: 'Clôturer la caisse' }));
    await screen.findByText('Clôture de la caisse en cours d’envoi…');
    const [close] = await outboxOf('finance.cash_session.close');
    expect(close).toMatchObject({ aggregate_id: CASH_SESSION_ID, depends_on: [] });
    // Réponse du serveur (chaînes décimales) : ses chiffres remplacent l'estimation.
    await getDb().outbox.update(close!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T18:00:00.000Z',
      server_refs: {
        cashSessionId: CASH_SESSION_ID,
        closingExpectedXaf: '23500',
        varianceXaf: '-500',
        status: 'PENDING_VALIDATION',
      },
    });
    expect(await screen.findByText('Caisse clôturée.')).toBeInTheDocument();
    expect(await screen.findByText(/^Attendu : 23\s500 F CFA$/)).toBeInTheDocument();
    expect(screen.getByText(/^Écart : -500 F CFA$/)).toBeInTheDocument();
    expect(screen.getByText('Session à valider par la Finance.')).toBeInTheDocument();
    expect(screen.queryByText(/indicatif/)).not.toBeInTheDocument();
  });

  it('tablette partagée : ouverture d’un autre utilisateur pas encore envoyée, l’utilisateur ouvre la sienne', async () => {
    await getDb().outbox.put(pendingOpen(OTHER_USER));
    const user = userEvent.setup();
    renderScreen();
    // Inconnue du serveur jusqu'à la reconnexion de son auteur : elle ne fait pas une caisse ouverte.
    expect(await screen.findByRole('heading', { name: 'Ouvrir la caisse' })).toBeInTheDocument();
    expect(
      screen.getByText(/Une ouverture saisie par un autre utilisateur de cette tablette attend/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant compté (F CFA)'), '1000');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ouvrir la caisse' })).toBeEnabled(),
    );
  });

  it('tablette partagée : clôture d’un autre utilisateur pas encore envoyée, ouverture bloquée jusqu’à son envoi', async () => {
    // Hors ligne et deux sessions par jour : seule la clôture en attente empêche l'ouverture.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.bulkPut([
      cashSessionRow(),
      meSettingRow('finance.cash_sessions_per_day_max', 2, { type: 'SITE', id: IDS.site }),
    ]);
    await getDb().outbox.put({
      ...pendingOpen(OTHER_USER),
      command_id: '01900000-0000-7000-8000-0000000000f3',
      command_type: 'finance.cash_session.close',
      aggregate_id: CASH_SESSION_ID,
      payload: { countedXaf: 18_000 },
    });
    const user = userEvent.setup();
    renderScreen();
    expect(
      await screen.findByText(
        'Clôture de la caisse enregistrée sur ce téléphone, en attente d’envoi.',
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant compté (F CFA)'), '18000');
    const open = screen.getByRole('button', { name: 'Ouvrir la caisse' });
    expect(open).toBeDisabled();
    const hint = screen.getByText(/Opération saisie sur cette tablette par un autre utilisateur/);
    expect(open).toHaveAttribute('aria-describedby', hint.id);
  });

  it('ouverture hors ligne au-delà de la limite du jour : rattachée, aucune caisse ouverte sur le téléphone', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put(
      cashSessionRow({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T08:00:00.000Z' }),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByLabelText('Montant compté (F CFA)'), '5000');
    expect(screen.getByText(/votre comptage sera rattaché à cette session/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ouvrir la caisse' }));
    await screen.findByText(/Ouverture de la caisse enregistrée sur ce téléphone/);
    await user.click(screen.getByRole('button', { name: 'Retour à la caisse' }));
    // Pas de « Clôturer la caisse » : l'ouverture ne crée aucune session.
    expect(
      await screen.findByText(/est rattachée à une session existante de la journée/),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ouvrir la caisse' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clôturer la caisse' })).not.toBeInTheDocument();
  });

  it('réponse du serveur sans attendu : rattachement ou constat, jamais l’écart indicatif', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByLabelText('Montant compté (F CFA)'), '19000');
    await user.click(screen.getByRole('button', { name: 'Ouvrir la caisse' }));
    await screen.findByText('Ouverture de la caisse en cours d’envoi…');
    // Pendant l'attente : estimation de l'appareil.
    expect(await screen.findByText(/Écart indicatif : -1\s000 F CFA/)).toBeInTheDocument();
    const [open] = await outboxOf('finance.cash_session.open');
    await getDb().outbox.update(open!.command_id, {
      status: 'SYNCED_WITH_WARNING',
      synced_at: '2026-10-10T09:30:00.000Z',
      warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
      server_refs: { cashSessionId: CASH_SESSION_ID, mergedInto: CASH_SESSION_ID },
    });
    expect(
      await screen.findByText(/Comptage rattaché à une session existante de cette caisse/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Ouverture signalée à la Finance : une autre session/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Écart indicatif/)).not.toBeInTheDocument();
  });

  it('ouverture décalée par le serveur (AV-168) : heure retenue annoncée avec ses chiffres', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByLabelText('Montant compté (F CFA)'), '20000');
    await user.click(screen.getByRole('button', { name: 'Ouvrir la caisse' }));
    await screen.findByText('Ouverture de la caisse en cours d’envoi…');
    const [open] = await outboxOf('finance.cash_session.open');
    await getDb().outbox.update(open!.command_id, {
      status: 'SYNCED_WITH_WARNING',
      synced_at: '2026-10-10T09:30:00.000Z',
      warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
      server_refs: {
        cashSessionId: open!.aggregate_id,
        openedAt: '2026-10-10T09:20:00.000Z',
        openingExpectedXaf: '20000',
        openingVarianceXaf: '0',
      },
    });
    expect(
      await screen.findByText(/Ouverture décalée au .*, à la clôture de la session précédente\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Écart : 0 F CFA$/)).toBeInTheDocument();
  });

  it('dernière session validée d’office : pas annoncée « à valider »', async () => {
    await getDb().projections.put(cashSessionRow());
    await getDb().outbox.put({
      ...pendingOpen(),
      command_id: '01900000-0000-7000-8000-0000000000f4',
      command_type: 'finance.cash_session.close',
      aggregate_id: CASH_SESSION_ID,
      payload: { countedXaf: 20_000 },
      status: 'SYNCED',
      synced_at: '2026-10-10T09:30:00.000Z',
      server_refs: { cashSessionId: CASH_SESSION_ID, status: 'VALIDATED' },
    });
    renderScreen();
    expect(
      await screen.findByText('Dernière session close et validée d’office.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/en attente de validation/)).not.toBeInTheDocument();
  });

  it('limite de sessions du jour : refusée en ligne, rattachée hors ligne (AV-154)', async () => {
    await getDb().projections.put(
      cashSessionRow({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T08:00:00.000Z' }),
    );
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    expect(
      await screen.findByText('Dernière session close, en attente de validation par la Finance.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant compté (F CFA)'), '0');
    const refusal = screen.getByText(/Le nombre de sessions de caisse du jour est atteint/);
    const open = screen.getByRole('button', { name: 'Ouvrir la caisse' });
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute('aria-describedby', refusal.id);
    unmount();

    // Deux sessions par jour permises au site : l'ouverture est possible.
    await getDb().projections.put(
      meSettingRow('finance.cash_sessions_per_day_max', 2, { type: 'SITE', id: IDS.site }),
    );
    const { unmount: unmountSecond } = renderScreen();
    await user.type(await screen.findByLabelText('Montant compté (F CFA)'), '0');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ouvrir la caisse' })).toBeEnabled(),
    );
    unmountSecond();

    // Hors ligne, limite à 1 : le comptage sera rattaché à la session du jour.
    await getDb().projections.put(
      meSettingRow(
        'finance.cash_sessions_per_day_max',
        1,
        { type: 'SITE', id: IDS.site },
        '2026-02-01T00:00:00.000Z',
      ),
    );
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    await user.type(await screen.findByLabelText('Montant compté (F CFA)'), '0');
    expect(screen.getByText(/votre comptage sera rattaché à cette session/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ouvrir la caisse' })).toBeEnabled();
  });

  it('caisse ouverte un jour précédent : clôture demandée avant toute autre ouverture', async () => {
    await getDb().projections.put(cashSessionRow({ opened_at: '2026-10-09T06:00:00.000Z' }));
    renderScreen();
    expect(
      await screen.findByText(
        'Caisse ouverte un jour précédent : clôturez-la avant d’en ouvrir une autre.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Clôturer la caisse' })).toBeInTheDocument();
  });

  it('aucune caisse de PDV servie : message, pas de formulaire', async () => {
    await getDb().projections.delete(`cash:CASH_ACCOUNT:${POS_CASH_ACCOUNT}`);
    renderScreen();
    expect(
      await screen.findByText(/Aucune caisse de point de vente sur ce téléphone/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ouvrir la caisse' })).not.toBeInTheDocument();
  });
});
