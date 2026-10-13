import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type {
  CashAccountItem,
  CashMovementItem,
  CashSessionDetailResponse,
  CashSessionItem,
  CashTransferItem,
} from './treasury.js';
import { TreasuryScreen } from './TreasuryScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
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

const request = vi.mocked(authorizedRequest);
const VENDOR = '01900000-0000-7000-8000-0000000000e1';
const RECEIVER = '01900000-0000-7000-8000-0000000000e2';
const PDV_CASH = '01900000-0000-7000-8000-0000000000c1';
const CENTRAL = '01900000-0000-7000-8000-0000000000c2';
const SESSION = '01900000-0000-7000-8000-0000000000c3';
const OWN_SESSION = '01900000-0000-7000-8000-0000000000c4';
const GAP = '01900000-0000-7000-8000-0000000000c5';
const GAP_MINE = '01900000-0000-7000-8000-0000000000c6';
const TRANSIT = '01900000-0000-7000-8000-0000000000c7';
const REQUEST = '01900000-0000-7000-8000-0000000000c8';
const OWN_TRANSIT = '01900000-0000-7000-8000-0000000000c9';

const accounts: CashAccountItem[] = [
  {
    id: PDV_CASH,
    code: 'CAISSE-PDV-YDE',
    name: 'Caisse du PDV de Yaoundé',
    accountType: 'CAISSE_PDV',
    siteId: IDS.site,
    holderUserId: null,
    balanceXaf: 18_000,
    status: 'ACTIVE',
  },
  {
    id: CENTRAL,
    code: 'CAISSE-CENTRALE',
    name: 'Caisse centrale',
    accountType: 'CAISSE_CENTRALE',
    siteId: null,
    holderUserId: null,
    balanceXaf: 1_250_000,
    status: 'ACTIVE',
  },
];

function session(overrides: Partial<CashSessionItem> = {}): CashSessionItem {
  return {
    id: SESSION,
    cashAccountId: PDV_CASH,
    siteId: IDS.site,
    businessDate: '2026-10-10',
    status: 'PENDING_VALIDATION',
    openedBy: VENDOR,
    openedAt: '2026-10-10T06:00:00.000Z',
    openingCountedXaf: 20_000,
    openingExpectedXaf: 20_000,
    openingVarianceXaf: 0,
    closedBy: VENDOR,
    closedAt: '2026-10-10T17:00:00.000Z',
    closingCountedXaf: 172_500,
    closingExpectedXaf: 173_000,
    varianceXaf: -500,
    forceClosed: false,
    forcedBy: null,
    approvalRequestId: null,
    clockSuspect: false,
    version: 2,
    ...overrides,
  };
}

function transfer(overrides: Partial<CashTransferItem> = {}): CashTransferItem {
  return {
    id: GAP,
    docNumber: 'RMF-YDE-2026-000007',
    fromAccountId: PDV_CASH,
    toAccountId: CENTRAL,
    amountSentXaf: 173_000,
    amountReceivedXaf: 172_000,
    discrepancyXaf: -1_000,
    status: 'DISCREPANCY_PENDING',
    sentBy: VENDOR,
    sentAt: '2026-10-10T17:30:00.000Z',
    carrierUserId: null,
    carrierName: null,
    receivedBy: RECEIVER,
    receivedAt: '2026-10-10T19:00:00.000Z',
    approvalRequestId: REQUEST,
    ...overrides,
  };
}

const detail: CashSessionDetailResponse = {
  cash_session: session(),
  adjustments: [],
  flows: {
    window: { from: '2026-10-10T06:00:00.000Z', to: '2026-10-10T17:00:00.000Z' },
    sellers: [{ userId: VENDOR, receivedXaf: 153_000, paymentsCount: 12 }],
    unattributedReceivedXaf: 0,
    otherMovements: [{ movementType: 'REFUND', direction: 'OUT', amountXaf: 0, count: 0 }],
    netFlowsXaf: 153_000,
    expectedNowXaf: 173_000,
  },
};

function movement(id: string, amountXaf: number): CashMovementItem {
  return {
    id,
    direction: 'IN',
    amountXaf,
    movementType: 'CUSTOMER_PAYMENT',
    occurredAt: '2026-10-10T10:00:00.000Z',
    isReversal: false,
  };
}

type Routes = Record<string, unknown>;

function baseRoutes(): Routes {
  return {
    '/api/v1/cash-accounts': { cash_accounts: accounts },
    '/api/v1/cash-sessions?status=PENDING_VALIDATION&limit=200': {
      cash_sessions: [
        session(),
        // Même caisse, même jour, plus tard : nommée par ses heures.
        session({
          id: OWN_SESSION,
          closedBy: IDS.user,
          openedAt: '2026-10-10T11:00:00.000Z',
          closedAt: '2026-10-10T16:00:00.000Z',
        }),
      ],
      next_cursor: null,
    },
    [`/api/v1/cash-sessions/${SESSION}`]: detail,
    '/api/v1/cash-transfers?status=DISCREPANCY_PENDING&limit=200': {
      cash_transfers: [
        transfer(),
        // Reçue par l'utilisateur : il ne décide pas de son propre écart.
        transfer({ id: GAP_MINE, docNumber: 'RMF-YDE-2026-000008', receivedBy: IDS.user }),
      ],
      next_cursor: null,
    },
    '/api/v1/cash-transfers?status=SENT&limit=200': {
      cash_transfers: [
        transfer({
          id: TRANSIT,
          docNumber: 'RMF-YDE-2026-000009',
          status: 'SENT',
          amountReceivedXaf: null,
          discrepancyXaf: null,
          receivedBy: null,
          receivedAt: null,
          carrierName: 'Paul',
          approvalRequestId: null,
        }),
        // Envoyée par l'utilisateur : il ne la reçoit jamais (`CASH_TRANSFER_SELF_RECEIVE`).
        transfer({
          id: OWN_TRANSIT,
          docNumber: 'RMF-SIEGE-2026-000010',
          fromAccountId: CENTRAL,
          toAccountId: PDV_CASH,
          status: 'SENT',
          sentBy: IDS.user,
          amountReceivedXaf: null,
          discrepancyXaf: null,
          receivedBy: null,
          receivedAt: null,
          approvalRequestId: null,
        }),
      ],
      next_cursor: null,
    },
    [`/api/v1/cash-accounts/${CENTRAL}/movements?limit=50`]: {
      movements: [movement('m1', 5_000)],
      next_cursor: 'm1',
    },
    [`/api/v1/cash-accounts/${CENTRAL}/movements?limit=50&cursor=m1`]: {
      movements: [movement('m2', 7_000)],
      next_cursor: 'm2',
    },
    [`/api/v1/cash-accounts/${CENTRAL}/movements?limit=50&cursor=m2`]: {
      movements: [movement('m3', 9_000)],
      next_cursor: null,
    },
  };
}

function serve(routes: Routes) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    return Promise.resolve(
      data
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status: 500, message: `route absente : ${path}` },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

async function rememberRoles(roles: readonly string[]) {
  await getDb().navigation.put({
    user_id: IDS.user,
    roles: [...roles],
    sections: [],
    saved_at: '2026-10-10T08:00:00.000Z',
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <TreasuryScreen />
    </MemoryRouter>,
  );
}

async function outboxOf(type: string) {
  return (await getDb().outbox.toArray()).filter((command) => command.command_type === type);
}

describe('Trésorerie (ECR-FIN-05)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    serve(baseRoutes());
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
    await getDb().navigation.clear();
  });

  it('session à valider : flux par vendeur, motif exigé par l’écart, validation', async () => {
    const user = userEvent.setup();
    renderScreen();
    const sessions = await screen.findByRole('region', { name: 'Sessions de caisse à valider' });
    // Deux sessions de la même caisse le même jour : noms distincts par leurs heures (Douala).
    const card = within(sessions).getByRole('listitem', {
      name: /^Caisse du PDV de Yaoundé du .*, 07:00–18:00$/,
    });
    expect(
      within(sessions).getByRole('listitem', {
        name: /^Caisse du PDV de Yaoundé du .*, 12:00–17:00$/,
      }),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/Écart de clôture : .*500 F CFA \(compté 172\s500 F CFA/),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /^Examiner la session/ }));
    expect(
      await within(card).findByText(/…00e1 : 153\s000 F CFA \(12 encaissements\)/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/Flux nets : 153\s000 F CFA ; attendu recalculé : 173\s000 F CFA/),
    ).toBeInTheDocument();
    const validate = within(card).getByRole('button', { name: 'Valider la session' });
    expect(validate).toBeDisabled();
    await user.type(
      within(card).getByLabelText(
        'Motif de la validation (obligatoire : la session présente un écart)',
      ),
      '  Erreur de rendu de monnaie ',
    );
    await user.click(validate);
    expect(await screen.findByText('Validation en cours d’envoi…')).toBeInTheDocument();
    const [command] = await outboxOf('finance.cash_session.validate');
    expect(command).toMatchObject({
      aggregate_type: 'CASH_SESSION',
      aggregate_id: SESSION,
      captured_offline: false,
      payload: { reason: 'Erreur de rendu de monnaie' },
    });
  });

  it('session clôturée par soi : validation impossible, raison donnée', async () => {
    serve({
      ...baseRoutes(),
      // Sans écart : seul le valideur impliqué grise le bouton (aucun motif exigé).
      [`/api/v1/cash-sessions/${OWN_SESSION}`]: {
        ...detail,
        cash_session: session({
          id: OWN_SESSION,
          closedBy: IDS.user,
          varianceXaf: 0,
          closingCountedXaf: 173_000,
        }),
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const sessions = await screen.findByRole('region', { name: 'Sessions de caisse à valider' });
    const cards = within(sessions).getAllByRole('listitem');
    const own = cards.find((item) => within(item).queryByText(/clôturée par vous/));
    await user.click(within(own!).getByRole('button', { name: /^Examiner la session/ }));
    expect(
      await within(own!).findByText(
        'Vous avez ouvert, clôturé ou forcé cette session : un autre valideur doit la valider.',
      ),
    ).toBeInTheDocument();
    const validate = within(own!).getByRole('button', { name: 'Valider la session' });
    expect(validate).toBeDisabled();
    expect(validate).toHaveAccessibleDescription(
      'Vous avez ouvert, clôturé ou forcé cette session : un autre valideur doit la valider.',
    );
  });

  it('session déjà validée par un autre : annoncée comme telle, liste relue à la demande', async () => {
    serve({
      ...baseRoutes(),
      [`/api/v1/cash-sessions/${SESSION}`]: {
        ...detail,
        cash_session: session({ status: 'VALIDATED' }),
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const sessions = await screen.findByRole('region', { name: 'Sessions de caisse à valider' });
    const card = within(sessions).getByRole('listitem', { name: /07:00–18:00$/ });
    await user.click(within(card).getByRole('button', { name: /^Examiner la session/ }));
    expect(
      await within(card).findByText('Cette session n’est plus en attente de validation.'),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/Vous avez ouvert, clôturé ou forcé/)).toBeNull();
    expect(within(card).getByRole('button', { name: 'Valider la session' })).toBeDisabled();
    const before = request.mock.calls.length;
    await user.click(within(card).getByRole('button', { name: 'Relire la liste' }));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  });

  it('décision en attente : actions bloquées, reprise au retour sur l’écran, liste relue à sa réponse', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    const gaps = await screen.findByRole('region', { name: 'Écarts de remise à décider' });
    const card = within(gaps).getByRole('listitem', { name: 'RMF-YDE-2026-000007' });
    await user.click(
      within(card).getByRole('button', {
        name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
      }),
    );
    await user.selectOptions(within(card).getByLabelText('Imputation de l’écart'), 'SENDER');
    await user.type(
      within(card).getByLabelText('Motif (obligatoire, 200 caractères au plus)'),
      'Erreur de comptage',
    );
    await user.click(within(card).getByRole('button', { name: 'Clore l’écart' }));
    expect(await screen.findByText('Décision en cours d’envoi…')).toBeInTheDocument();
    unmount();

    // Retour sur l'écran : la décision en attente est reprise et bloque les actions.
    renderScreen();
    expect(await screen.findByText('Décision en cours d’envoi…')).toBeInTheDocument();
    const again = await screen.findByRole('region', { name: 'Écarts de remise à décider' });
    await waitFor(() =>
      expect(
        within(again).getByRole('button', {
          name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
        }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByRole('button', { name: 'Recevoir la remise RMF-YDE-2026-000009' }),
    ).toBeDisabled();
    // Réponse du serveur : la liste est relue, l'écart clos en sort.
    serve({
      ...baseRoutes(),
      '/api/v1/cash-transfers?status=DISCREPANCY_PENDING&limit=200': {
        cash_transfers: [
          transfer({ id: GAP_MINE, docNumber: 'RMF-YDE-2026-000008', receivedBy: IDS.user }),
        ],
        next_cursor: null,
      },
    });
    const [decision] = await outboxOf('approvals.request.approve');
    await getDb().outbox.update(decision!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T19:30:00.000Z',
    });
    expect(await screen.findByText('Écart de remise clos.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(again).queryByRole('listitem', { name: 'RMF-YDE-2026-000007' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('relecture en échec après une opération : annoncée avec « Réessayer », puis débloquée', async () => {
    const user = userEvent.setup();
    renderScreen();
    const sessions = await screen.findByRole('region', { name: 'Sessions de caisse à valider' });
    const card = within(sessions).getByRole('listitem', { name: /07:00–18:00$/ });
    await user.click(within(card).getByRole('button', { name: /^Examiner la session/ }));
    await user.type(
      await within(card).findByLabelText(
        'Motif de la validation (obligatoire : la session présente un écart)',
      ),
      'Erreur de rendu',
    );
    await user.click(within(card).getByRole('button', { name: 'Valider la session' }));
    await screen.findByText('Validation en cours d’envoi…');
    // Le serveur répond, mais la relecture échoue : la liste d'avant reste, annoncée périmée.
    serve({});
    const [validation] = await outboxOf('finance.cash_session.validate');
    await getDb().outbox.update(validation!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T19:30:00.000Z',
    });
    expect(await screen.findByText(/Actualisation impossible/)).toBeInTheDocument();
    expect(within(sessions).getByRole('listitem', { name: /07:00–18:00$/ })).toBeInTheDocument();
    const decide = screen.getByRole('button', {
      name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
    });
    expect(decide).toBeDisabled();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByText(/Actualisation impossible/)).toBeNull());
    await waitFor(() => expect(decide).toBeEnabled());
  });

  it('mouvements ouverts et relecture en échec : annoncée, la liste d’avant gardée', async () => {
    const user = userEvent.setup();
    renderScreen();
    const accountsRegion = await screen.findByRole('region', { name: 'Comptes de trésorerie' });
    const central = within(accountsRegion).getByRole('listitem', { name: 'Caisse centrale' });
    await user.click(
      within(central).getByRole('button', { name: 'Mouvements de Caisse centrale' }),
    );
    expect(await within(central).findByText(/Encaissement : \+5\s000 F CFA/)).toBeInTheDocument();
    // Une opération gérée de l'utilisateur (saisie ailleurs) change la clé : relecture, en échec.
    serve({});
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000000fa',
      device_seq: 1,
      command_type: 'finance.cash_session.validate',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'CASH_SESSION',
      aggregate_id: SESSION,
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T19:00:00.000Z',
      client_created_at: '2026-10-10T19:00:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { reason: 'Vu' },
      status: 'PENDING_SYNC',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    expect(
      await within(central).findByText(/Actualisation des mouvements impossible/),
    ).toBeInTheDocument();
    expect(within(central).getByText(/Encaissement : \+5\s000 F CFA/)).toBeInTheDocument();
  });

  it('retour du réseau : la liste d’avant la coupure reste bloquée jusqu’à sa relecture', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    renderScreen();
    const decide = await screen.findByRole('button', {
      name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
    });
    await waitFor(() => expect(decide).toBeEnabled());
    online.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText(/Trésorerie en ligne seulement/)).toBeInTheDocument();
    // Relecture retenue jusqu'à `release` : la liste d'avant s'affiche, actions bloquées.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routes = baseRoutes();
    request.mockImplementation(async (_db, path) => {
      await gate;
      return { ok: true, data: routes[path] } as Awaited<ReturnType<typeof authorizedRequest>>;
    });
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    const back = await screen.findByRole('button', {
      name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
    });
    expect(back).toBeDisabled();
    expect(screen.getByText(/Actualisation en cours/)).toBeInTheDocument();
    release();
    await waitFor(() => expect(back).toBeEnabled());
  });

  it('formulaire de décision : focus sur l’imputation à l’ouverture, rendu au bouton à la fermeture', async () => {
    const user = userEvent.setup();
    renderScreen();
    const gaps = await screen.findByRole('region', { name: 'Écarts de remise à décider' });
    const card = within(gaps).getByRole('listitem', { name: 'RMF-YDE-2026-000007' });
    await user.click(
      within(card).getByRole('button', {
        name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
      }),
    );
    expect(within(card).getByLabelText('Imputation de l’écart')).toHaveFocus();
    await user.click(within(card).getByRole('button', { name: 'Fermer' }));
    await waitFor(() =>
      expect(
        within(card).getByRole('button', {
          name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
        }),
      ).toHaveFocus(),
    );
  });

  it('écart de remise : imputation et motif, décision sur la demande ; son propre écart exclu', async () => {
    const user = userEvent.setup();
    renderScreen();
    const gaps = await screen.findByRole('region', { name: 'Écarts de remise à décider' });
    const mine = within(gaps).getByRole('listitem', { name: 'RMF-YDE-2026-000008' });
    expect(
      within(mine).getByText(/Vous avez envoyé, porté ou reçu cette remise/),
    ).toBeInTheDocument();
    expect(within(mine).queryByRole('button')).toBeNull();
    const card = within(gaps).getByRole('listitem', { name: 'RMF-YDE-2026-000007' });
    expect(within(card).getByText(/écart de .*1\s000 F CFA/)).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', {
        name: 'Décider de l’écart de la remise RMF-YDE-2026-000007',
      }),
    );
    // Porteur inconnu : l'écart ne peut pas lui être imputé.
    const imputation = within(card).getByLabelText('Imputation de l’écart');
    expect(within(imputation).getByRole('option', { name: 'Porteur' })).toBeDisabled();
    const submit = within(card).getByRole('button', { name: 'Clore l’écart' });
    await user.selectOptions(imputation, 'COMPANY');
    expect(submit).toBeDisabled();
    await user.type(
      within(card).getByLabelText('Motif (obligatoire, 200 caractères au plus)'),
      'Billet abîmé refusé',
    );
    await user.click(submit);
    expect(await screen.findByText('Décision en cours d’envoi…')).toBeInTheDocument();
    const [decision] = await outboxOf('approvals.request.approve');
    expect(decision).toMatchObject({
      aggregate_type: 'APPROVAL_REQUEST',
      aggregate_id: REQUEST,
      payload: {
        requestId: REQUEST,
        decisionOption: 'COMPANY',
        decisionData: { reason: 'Billet abîmé refusé' },
      },
    });
  });

  it('remise en transit reçue par la Finance ; la Direction ne reçoit pas', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    const transit = await screen.findByRole('region', { name: 'Remises en transit' });
    const card = await within(transit).findByRole('listitem', { name: 'RMF-YDE-2026-000009' });
    expect(within(card).getByText(/porteur : Paul/)).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: 'Recevoir la remise RMF-YDE-2026-000009' }),
    );
    await user.type(within(card).getByLabelText('Montant reçu, compté (F CFA)'), '173000');
    expect(within(card).getByText('Montant conforme à l’envoi.')).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: /Confirmer la réception de 173\s000 F CFA/ }),
    );
    expect(await screen.findByText('Réception en cours d’envoi…')).toBeInTheDocument();
    const [receive] = await outboxOf('finance.cash_transfer.receive');
    expect(receive).toMatchObject({ aggregate_id: TRANSIT, payload: { receivedXaf: 173_000 } });
    const own = within(transit).getByRole('listitem', { name: 'RMF-SIEGE-2026-000010' });
    expect(within(own).queryByRole('button', { name: /^Recevoir la remise/ })).toBeNull();
    unmount();

    await getDb().outbox.clear();
    await rememberRoles(['DIRECTION']);
    renderScreen();
    const again = await screen.findByRole('region', { name: 'Remises en transit' });
    await within(again).findByRole('listitem', { name: 'RMF-YDE-2026-000009' });
    expect(within(again).queryByRole('button', { name: /^Recevoir la remise/ })).toBeNull();
  });

  it('au-delà des pages lues : liste des sessions annoncée partielle', async () => {
    const path = '/api/v1/cash-sessions?status=PENDING_VALIDATION&limit=200';
    const routes = baseRoutes();
    for (let page = 0; page < 5; page += 1) {
      routes[page === 0 ? path : `${path}&cursor=p${page}`] = {
        cash_sessions: [session({ id: `01900000-0000-7000-8000-00000000f00${page}` })],
        next_cursor: `p${page + 1}`,
      };
    }
    serve(routes);
    renderScreen();
    expect(
      await screen.findByText('Liste partielle : seules les 5 plus récentes sont montrées.'),
    ).toBeInTheDocument();
  });

  it('comptes et mouvements, les plus anciens à la demande ; hors ligne, en ligne seulement', async () => {
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    const accountsRegion = await screen.findByRole('region', { name: 'Comptes de trésorerie' });
    const central = within(accountsRegion).getByRole('listitem', { name: 'Caisse centrale' });
    expect(within(central).getByText(/Solde : 1\s250\s000 F CFA/)).toBeInTheDocument();
    await user.click(
      within(central).getByRole('button', { name: 'Mouvements de Caisse centrale' }),
    );
    expect(await within(central).findByText(/Encaissement : \+5\s000 F CFA/)).toBeInTheDocument();
    await user.click(within(central).getByRole('button', { name: 'Mouvements plus anciens' }));
    expect(await within(central).findByText(/Encaissement : \+7\s000 F CFA/)).toBeInTheDocument();
    await user.click(within(central).getByRole('button', { name: 'Mouvements plus anciens' }));
    // Les pages s'ajoutent : la première et la deuxième restent.
    expect(await within(central).findByText(/Encaissement : \+9\s000 F CFA/)).toBeInTheDocument();
    expect(within(central).getByText(/Encaissement : \+7\s000 F CFA/)).toBeInTheDocument();
    expect(within(central).getByText(/Encaissement : \+5\s000 F CFA/)).toBeInTheDocument();
    expect(
      within(central).queryByRole('button', { name: 'Mouvements plus anciens' }),
    ).not.toBeInTheDocument();
    unmount();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByText(/Trésorerie en ligne seulement/)).toBeInTheDocument();
  });
});
