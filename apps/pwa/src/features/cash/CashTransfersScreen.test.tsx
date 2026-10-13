import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import {
  CASH_TRANSFER_ID,
  CENTRAL_CASH_ACCOUNT,
  cashTransferRow,
  cashTransferTargetRow,
  IDS,
  POS_CASH_ACCOUNT,
  posCashAccountRow,
  seedSalesFixtures,
} from '../sales/fixtures.js';
import { CashTransfersScreen } from './CashTransfersScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T18:00:00.000Z'));
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

const OTHER_USER = '01900000-0000-7000-8000-000000000002';
const BANK = '01900000-0000-7000-8000-0000000000b5';
const INCOMING = '01900000-0000-7000-8000-0000000000b6';

function renderScreen() {
  return render(
    <MemoryRouter>
      <CashTransfersScreen />
    </MemoryRouter>,
  );
}

async function outboxOf(type: string) {
  return (await getDb().outbox.toArray()).filter((command) => command.command_type === type);
}

describe('Remises de fonds (UC-FIN-07)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      posCashAccountRow(),
      cashTransferTargetRow(),
      cashTransferTargetRow({ id: BANK, code: 'BANQUE', name: 'Banque', account_type: 'BANQUE' }),
      // La caisse du PDV est aussi une destination servie : jamais proposée vers elle-même.
      cashTransferTargetRow({
        id: POS_CASH_ACCOUNT,
        code: 'CAISSE-PDV-YDE',
        name: 'Caisse du PDV de Yaoundé',
        account_type: 'CAISSE_PDV',
        site_id: IDS.site,
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : remise de la caisse du PDV, solde indicatif, porteur ; annulée avec un motif', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Caisse du PDV de Yaoundé')).toBeInTheDocument();
    expect(screen.getByText(/Solde indicatif : 20\s000 F CFA/)).toBeInTheDocument();
    const target = screen.getByLabelText('Vers');
    expect(
      within(target)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choisir la destination', 'Banque', 'Caisse centrale']);
    const submit = screen.getByRole('button', { name: 'Envoyer la remise' });
    expect(submit).toBeDisabled();
    await user.selectOptions(target, CENTRAL_CASH_ACCOUNT);
    const amount = screen.getByLabelText('Montant remis (F CFA)');
    await user.type(amount, '25000');
    // Au-delà du solde indicatif : signalé, jamais bloqué (AV-312).
    expect(screen.getByText(/Au-delà du solde indicatif/)).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.clear(amount);
    await user.type(amount, '15000');
    expect(screen.queryByText(/Au-delà du solde indicatif/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Porteur (facultatif)'), 'Paul');
    await user.click(submit);
    expect(
      await screen.findByText(
        'Remise enregistrée sur ce téléphone ; elle sera envoyée au retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [send] = await outboxOf('finance.cash_transfer.send');
    expect(send).toMatchObject({
      aggregate_type: 'CASH_TRANSFER',
      captured_offline: true,
      payload: {
        fromAccountId: POS_CASH_ACCOUNT,
        toAccountId: CENTRAL_CASH_ACCOUNT,
        amountXaf: 15_000,
        carrierName: 'Paul',
      },
    });
    expect(screen.getByLabelText('Montant remis (F CFA)')).toHaveValue('');
    expect(await screen.findByText(/Solde indicatif : 5\s000 F CFA/)).toBeInTheDocument();

    const mine = screen.getByRole('region', { name: 'Mes remises' });
    const card = await within(mine).findByRole('listitem', { name: 'Remise en attente du numéro' });
    expect(
      within(card).getByText('Enregistrée sur ce téléphone, en attente d’envoi.'),
    ).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: 'Annuler la remise Remise en attente du numéro' }),
    );
    const confirm = within(card).getByRole('button', { name: 'Confirmer l’annulation' });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif de l’annulation'), '  Mauvais montant ');
    await user.click(confirm);
    expect(
      await screen.findByText('Annulation enregistrée ; elle sera envoyée au retour du réseau.'),
    ).toBeInTheDocument();
    const [cancel] = await outboxOf('finance.cash_transfer.cancel');
    expect(cancel).toMatchObject({
      aggregate_id: send!.aggregate_id,
      depends_on: [send!.command_id],
      payload: { reason: 'Mauvais montant' },
    });
    expect(
      await within(card).findByText('Annulation enregistrée, en attente d’envoi.'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Annuler la remise/ })).toBeNull();
    // L'envoi et son annulation s'annulent dans le solde indicatif.
    expect(await screen.findByText(/Solde indicatif : 20\s000 F CFA/)).toBeInTheDocument();
  });

  it('réception : écart annoncé, remise perdue ; une remise envoyée par soi n’est jamais à recevoir', async () => {
    await getDb().projections.bulkPut([
      // Envoyée par l'utilisateur, en transit : dans « Mes remises », annulable.
      cashTransferRow({ to_account_id: CENTRAL_CASH_ACCOUNT }),
      // Fonds de caisse envoyé au PDV par la caisse centrale.
      cashTransferRow({
        id: INCOMING,
        doc_number: 'RMF-SIEGE-2026-000004',
        from_account_id: CENTRAL_CASH_ACCOUNT,
        to_account_id: POS_CASH_ACCOUNT,
        amount_sent_xaf: 50_000,
        sent_by: OTHER_USER,
        carrier_name: null,
      }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const incoming = await screen.findByRole('region', { name: 'À recevoir' });
    const card = within(incoming).getByRole('listitem', { name: 'RMF-SIEGE-2026-000004' });
    expect(
      within(card).getByText('Caisse centrale → Caisse du PDV de Yaoundé'),
    ).toBeInTheDocument();
    expect(within(incoming).queryByRole('listitem', { name: 'RMF-YDE-2026-000001' })).toBeNull();
    const mine = screen.getByRole('region', { name: 'Mes remises' });
    const own = within(mine).getByRole('listitem', { name: 'RMF-YDE-2026-000001' });
    expect(within(own).getByText('En transit : pas encore reçue.')).toBeInTheDocument();
    expect(
      within(own).getByRole('button', { name: 'Annuler la remise RMF-YDE-2026-000001' }),
    ).toBeEnabled();

    await user.click(
      within(card).getByRole('button', { name: 'Recevoir la remise RMF-SIEGE-2026-000004' }),
    );
    const received = within(card).getByLabelText('Montant reçu, compté (F CFA)');
    await user.type(received, '0');
    expect(
      within(card).getByText('Rien reçu : la remise sera déclarée perdue et soumise à la Finance.'),
    ).toBeInTheDocument();
    await user.clear(received);
    await user.type(received, '49500');
    expect(
      within(card).getByText(/Écart de .*500 F CFA : il sera soumis à la Finance/),
    ).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: /Confirmer la réception de 49\s500 F CFA/ }),
    );
    expect(await screen.findByText('Réception en cours d’envoi…')).toBeInTheDocument();
    const [receive] = await outboxOf('finance.cash_transfer.receive');
    expect(receive).toMatchObject({
      aggregate_type: 'CASH_TRANSFER',
      aggregate_id: INCOMING,
      payload: { receivedXaf: 49_500 },
    });
    // Plus à recevoir : montrée pour mémoire, réception en attente.
    const pending = await within(incoming).findByText('Réception enregistrée, en attente d’envoi.');
    expect(pending).toBeInTheDocument();
    expect(
      within(incoming).queryByRole('button', { name: /^Recevoir la remise/ }),
    ).not.toBeInTheDocument();
    expect(CASH_TRANSFER_ID).toBeDefined();
  });

  it('aucune caisse de l’appareil : rien à remettre', async () => {
    await getDb().projections.delete(`cash:CASH_ACCOUNT:${POS_CASH_ACCOUNT}`);
    renderScreen();
    expect(
      await screen.findByText('Aucune caisse de ce téléphone ne peut remettre des fonds.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Aucune remise envoyée en cours.')).toBeInTheDocument();
  });
});
