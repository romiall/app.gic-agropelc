import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import {
  CASH_SESSION_ID,
  CENTRAL_CASH_ACCOUNT,
  cashSessionRow,
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
const SELF_INCOMING = '01900000-0000-7000-8000-0000000000b7';
const FROM_PERSONAL = '01900000-0000-7000-8000-0000000000b8';
const PERSONAL = '01900000-0000-7000-8000-0000000000b9';

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

function outboxCommand(overrides: Partial<OutboxCommand>): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000f1',
    device_seq: 1,
    command_type: 'sales.sale.record',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'SALE',
    aggregate_id: '01900000-0000-7000-8000-0000000000f2',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T17:00:00.000Z',
    client_created_at: '2026-10-10T17:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {},
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

/** Politique de contrôle servie par le jeu `policies`. */
function policyRow(id: string, data: Record<string, unknown>) {
  return {
    key: `policies:CONTROL_POLICY:${id}`,
    dataset: 'policies',
    entity_type: 'CONTROL_POLICY',
    entity_id: id,
    scope_type: 'GLOBAL',
    scope_id: null,
    data: {
      id,
      code: 'POLITIQUE',
      version: 1,
      requires_approval: true,
      approver_permission: 'finance.cash_session.validate',
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: null,
      ...data,
    },
    seq: 1,
    row_version: 1,
  };
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

  it('hors ligne : caisse du PDV au solde masqué, porteur, deux envois distincts, numéro renvoyé, annulation', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Caisse du PDV de Yaoundé')).toBeInTheDocument();
    // Comptage à l'aveugle (AV-304) : ni solde ni dépassement pour la caisse du PDV.
    expect(
      screen.getByText(/Solde de la caisse non affiché : comptage à l’aveugle/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Solde indicatif/)).toBeNull();
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
    expect(screen.queryByText(/Au-delà du solde indicatif/)).toBeNull();
    await user.clear(amount);
    await user.type(amount, '15000');
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
    // Second envoi : les deux remises sans numéro portent des noms distincts.
    await user.selectOptions(screen.getByLabelText('Vers'), BANK);
    await user.type(screen.getByLabelText('Montant remis (F CFA)'), '5000');
    await user.click(screen.getByRole('button', { name: 'Envoyer la remise' }));
    const mine = screen.getByRole('region', { name: 'Mes remises' });
    const toBank = await within(mine).findByRole('listitem', {
      name: /^Remise de 5\s000 F CFA vers Banque, /,
    });
    const card = within(mine).getByRole('listitem', {
      name: /^Remise de 15\s000 F CFA vers Caisse centrale, /,
    });
    expect(within(card).getByText(/Envoyée le .* par vous/)).toBeInTheDocument();
    expect(
      within(card).getByText('Enregistrée sur ce téléphone, en attente d’envoi.'),
    ).toBeInTheDocument();

    const open = within(card).getByRole('button', {
      name: /^Annuler la remise Remise de 15\s000 F CFA vers Caisse centrale/,
    });
    await user.click(open);
    const reason = within(card).getByLabelText('Motif de l’annulation');
    expect(reason).toHaveFocus();
    const confirm = within(card).getByRole('button', { name: 'Confirmer l’annulation' });
    expect(confirm).toBeDisabled();
    await user.type(reason, '  Mauvais montant ');
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

    // Envoi accepté : le numéro renvoyé par le serveur nomme la remise aussitôt.
    const bankSend = (await outboxOf('finance.cash_transfer.send')).find(
      (command) => (command.payload as { toAccountId?: string }).toAccountId === BANK,
    );
    await getDb().outbox.update(bankSend!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T18:01:00.000Z',
      server_refs: { docNumber: 'RMF-YDE-2026-000012' },
    });
    const numbered = await within(mine).findByRole('listitem', { name: 'RMF-YDE-2026-000012' });
    expect(
      within(numbered).getByText(
        'Envoyée au serveur ; en transit dès la prochaine synchronisation.',
      ),
    ).toBeInTheDocument();
    // Même carte, renommée par son numéro.
    expect(numbered).toBe(toBank);
    expect(
      within(mine).queryByRole('listitem', { name: /^Remise de 5\s000 F CFA vers Banque/ }),
    ).toBeNull();
  });

  it('caisse du PDV après sa clôture par l’utilisateur : solde du compté, dépassement signalé', async () => {
    await getDb().projections.bulkPut([
      posCashAccountRow({ balance_xaf: 50_000 }),
      cashSessionRow(),
    ]);
    // Clôture saisie sur ce téléphone, comptée 45 000 : le registre vaudra ce compté (ADR-032 §4).
    await getDb().outbox.put(
      outboxCommand({
        command_type: 'finance.cash_session.close',
        aggregate_type: 'CASH_SESSION',
        aggregate_id: CASH_SESSION_ID,
        payload: { countedXaf: 45_000 },
      }),
    );
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Solde indicatif : 45\s000 F CFA/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Vers'), CENTRAL_CASH_ACCOUNT);
    await user.type(screen.getByLabelText('Montant remis (F CFA)'), '50000');
    expect(screen.getByText(/Au-delà du solde indicatif/)).toBeInTheDocument();
  });

  it('caisse personnelle : espèces encaissées hors PDV et en attente comptées dans le solde', async () => {
    await getDb().projections.delete(`cash:CASH_ACCOUNT:${POS_CASH_ACCOUNT}`);
    await getDb().projections.put(
      posCashAccountRow({
        id: PERSONAL,
        code: 'CAISSE-CTE',
        name: 'Ma caisse',
        account_type: 'CAISSE_UTILISATEUR',
        site_id: null,
        holder_user_id: IDS.user,
        balance_xaf: 0,
      }),
    );
    // Vente en espèces depuis le stock mobile, en attente : elle crédite la caisse personnelle.
    await getDb().outbox.put(
      outboxCommand({
        payload: {
          fromLocationId: IDS.mobile,
          lines: [],
          payments: [{ methodCode: 'ESPECES', amountXaf: 30_000 }],
        },
      }),
    );
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Solde indicatif : 30\s000 F CFA/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Vers'), CENTRAL_CASH_ACCOUNT);
    await user.type(screen.getByLabelText('Montant remis (F CFA)'), '30000');
    expect(screen.queryByText(/Au-delà du solde indicatif/)).toBeNull();
  });

  it('réception : écart annoncé puis montré, remise perdue ; jamais sa propre remise ; caisse personnelle et expéditeur', async () => {
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
      // Vers la caisse du PDV, mais envoyée par l'utilisateur : jamais à recevoir par lui.
      cashTransferRow({
        id: SELF_INCOMING,
        doc_number: 'RMF-SIEGE-2026-000005',
        from_account_id: CENTRAL_CASH_ACCOUNT,
        to_account_id: POS_CASH_ACCOUNT,
        sent_by: IDS.user,
      }),
      // Depuis la caisse personnelle d'un commercial, inconnue de ce téléphone.
      cashTransferRow({
        id: FROM_PERSONAL,
        doc_number: 'RMF-YDE-2026-000006',
        from_account_id: '01900000-0000-7000-8000-0000000000ba',
        to_account_id: POS_CASH_ACCOUNT,
        sent_by: OTHER_USER,
      }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const incoming = await screen.findByRole('region', { name: 'À recevoir' });
    const card = within(incoming).getByRole('listitem', { name: 'RMF-SIEGE-2026-000004' });
    expect(
      within(card).getByText('Caisse centrale → Caisse du PDV de Yaoundé'),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Envoyée le .* par …0002/)).toBeInTheDocument();
    const personal = within(incoming).getByRole('listitem', { name: 'RMF-YDE-2026-000006' });
    expect(
      within(personal).getByText('caisse personnelle → Caisse du PDV de Yaoundé'),
    ).toBeInTheDocument();
    expect(within(incoming).queryByRole('listitem', { name: 'RMF-YDE-2026-000001' })).toBeNull();
    expect(within(incoming).queryByRole('listitem', { name: 'RMF-SIEGE-2026-000005' })).toBeNull();
    const mine = screen.getByRole('region', { name: 'Mes remises' });
    expect(
      within(mine).getByRole('listitem', { name: 'RMF-SIEGE-2026-000005' }),
    ).toBeInTheDocument();
    const own = within(mine).getByRole('listitem', { name: 'RMF-YDE-2026-000001' });
    expect(within(own).getByText('En transit : pas encore reçue.')).toBeInTheDocument();
    expect(
      within(own).getByRole('button', { name: 'Annuler la remise RMF-YDE-2026-000001' }),
    ).toBeEnabled();

    // Ouvert puis fermé : le focus revient au bouton qui l'a ouvert.
    const openPersonal = within(personal).getByRole('button', {
      name: 'Recevoir la remise RMF-YDE-2026-000006',
    });
    await user.click(openPersonal);
    expect(within(personal).getByLabelText('Montant reçu, compté (F CFA)')).toHaveFocus();
    await user.click(within(personal).getByRole('button', { name: 'Fermer' }));
    await waitFor(() =>
      expect(
        within(personal).getByRole('button', { name: 'Recevoir la remise RMF-YDE-2026-000006' }),
      ).toHaveFocus(),
    );

    await user.click(
      within(card).getByRole('button', { name: 'Recevoir la remise RMF-SIEGE-2026-000004' }),
    );
    const received = within(card).getByLabelText('Montant reçu, compté (F CFA)');
    expect(received).toHaveFocus();
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
    // Plus à recevoir : montrée pour mémoire, avec son écart (elle restera en attente de la Finance).
    expect(
      await within(incoming).findByText(
        /Réception enregistrée avec un écart de .*500 F CFA, en attente d’envoi/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: /^Recevoir la remise/ }),
    ).not.toBeInTheDocument();
  });

  it('sans politique de validation des écarts en vigueur : un écart est annoncé refusé', async () => {
    await getDb().projections.bulkPut([
      cashTransferRow({
        id: INCOMING,
        doc_number: 'RMF-SIEGE-2026-000004',
        from_account_id: CENTRAL_CASH_ACCOUNT,
        to_account_id: POS_CASH_ACCOUNT,
        amount_sent_xaf: 50_000,
        sent_by: OTHER_USER,
      }),
      // Politiques servies : aucune pour les écarts de remise (une autre opération, une échue).
      policyRow('01900000-0000-7000-8000-0000000000e1', { operation_type: 'SALE_CANCELLATION' }),
      policyRow('01900000-0000-7000-8000-0000000000e2', {
        operation_type: 'CASH_TRANSFER_DISCREPANCY',
        valid_to: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const incoming = await screen.findByRole('region', { name: 'À recevoir' });
    const card = within(incoming).getByRole('listitem', { name: 'RMF-SIEGE-2026-000004' });
    await user.click(
      within(card).getByRole('button', { name: 'Recevoir la remise RMF-SIEGE-2026-000004' }),
    );
    const received = within(card).getByLabelText('Montant reçu, compté (F CFA)');
    await user.type(received, '49500');
    expect(
      within(card).getByText(/aucune politique de validation des écarts n’est en vigueur/),
    ).toBeInTheDocument();
    await user.clear(received);
    await user.type(received, '50000');
    expect(within(card).getByText('Montant conforme à l’envoi.')).toBeInTheDocument();
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
