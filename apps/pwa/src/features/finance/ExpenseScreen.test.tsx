import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PhotoModule from '../attachments/photo.js';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expenseRecordPayloadSchema } from '@gic/contracts';
import { FixedClock } from '@gic/domain';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { rememberNavigation } from '../navigation/navigation-store.js';
import {
  approvalRequestRow,
  cashSessionRow,
  controlPolicyRow,
  EXPENSE_IDS,
  expenseCategoryRow,
  expenseRow,
  IDS,
  meSettingRow,
  POS_CASH_ACCOUNT,
  posCashAccountRow,
  roleAssignmentRow,
  seedSalesFixtures,
  siteRow,
} from '../sales/fixtures.js';
import type { CashAccountItem } from '../treasury/treasury.js';
import type { ExpenseItem } from './expense-follow.js';
import { ExpenseScreen } from './ExpenseScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
// Photo : le canevas n'existe pas en test ; le recodage rend un petit JPEG.
vi.mock('../attachments/photo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PhotoModule>();
  return {
    ...actual,
    browserPhotoCodec: {
      decode: async () => ({ width: 1600, height: 1200, source: null }),
      encode: async () =>
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }),
    },
  };
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

const request = vi.mocked(authorizedRequest);
const OTHER_USER = '01900000-0000-7000-8000-000000000002';
const BANK = '01900000-0000-7000-8000-0000000000b5';
const OTHER_PERSONAL = '01900000-0000-7000-8000-0000000000b6';
const SECOND = '01900000-0000-7000-8000-0000000000ca';
const THIRD = '01900000-0000-7000-8000-0000000000cb';
const RECEIPT = '01900000-0000-7000-8000-0000000000cc';

function renderAt(path = '/finance/depenses') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ExpenseScreen />
    </MemoryRouter>,
  );
}

async function outbox() {
  return getDb().outbox.orderBy('device_seq').toArray();
}

async function asRoles(roles: string[]) {
  await rememberNavigation(
    getDb(),
    new FixedClock(new Date('2026-10-10T08:00:00.000Z')),
    IDS.user,
    {
      user: { fullName: 'Awa Mbarga', roles },
      sections: [],
    },
  );
}

function offline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
}

function serve(routes: Record<string, unknown>) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    return Promise.resolve(
      data
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status: 500, message: `route absente : ${path}` },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

function item(overrides: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id: EXPENSE_IDS.expense,
    docNumber: 'DEP-PDV-YDE-2026-000007',
    siteId: IDS.site,
    categoryId: EXPENSE_IDS.transport,
    categoryCode: 'TRANSPORT',
    categoryLabel: 'Transport',
    amountXaf: 5_000,
    payeeName: 'Garage Nkolbisson',
    supplierId: null,
    description: 'Réparation du tricycle',
    costObjectType: 'SITE',
    costObjectId: IDS.site,
    speciesGroup: null,
    paidNow: false,
    paidFromAccountId: null,
    paidAt: null,
    status: 'RECORDED',
    reviewReasons: [],
    approvalRequestId: null,
    reclassifiedCategoryId: null,
    responsibilityUserId: null,
    cancelReason: null,
    occurredAt: '2026-10-10T09:00:00.000Z',
    businessDate: '2026-10-10',
    capturedOffline: false,
    createdBy: OTHER_USER,
    attachments: [{ id: RECEIPT, kind: 'RECEIPT', uploadStatus: 'AVAILABLE' }],
    ...overrides,
  };
}

const bank: CashAccountItem = {
  id: BANK,
  code: 'BANQUE',
  name: 'Banque Atlantique',
  accountType: 'BANQUE',
  siteId: null,
  holderUserId: null,
  balanceXaf: 2_000_000,
  status: 'ACTIVE',
};

async function fillExpense(
  user: ReturnType<typeof userEvent.setup>,
  amount: string,
  description = 'Moto-taxi',
) {
  await user.selectOptions(await screen.findByLabelText('Catégorie'), EXPENSE_IDS.transport);
  await user.type(screen.getByLabelText('Montant (F CFA)'), amount);
  await user.type(screen.getByLabelText('Objet de la dépense'), description);
}

describe('Dépenses (ECR-FIN-02, P8E-03)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      posCashAccountRow(),
      cashSessionRow(),
      expenseCategoryRow(),
      expenseCategoryRow({
        id: EXPENSE_IDS.veterinary,
        code: 'VETERINAIRE',
        label: 'Vétérinaire',
        default_cost_type: 'VETERINAIRE',
        allowed_on_pos: false,
      }),
      expenseCategoryRow({
        id: EXPENSE_IDS.unjustified,
        code: 'NON_JUSTIFIEE',
        label: 'Non justifiée',
        is_system: true,
      }),
      controlPolicyRow(),
      roleAssignmentRow(),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    request.mockReset();
    resetConnectivityForTests();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await db.attachmentFiles.clear();
    await db.attachmentBlobs.clear();
  });

  it('hors ligne : payée par la caisse du PDV, justificatif cité, site et imputation proposés', async () => {
    offline();
    const user = userEvent.setup();
    renderAt();
    expect(await screen.findByText(/Hors ligne : la dépense sera enregistrée/)).toBeInTheDocument();
    // Seule caisse servie et seul site de l'affectation : proposés sans choix.
    expect(screen.getByText('Caisse du PDV de Yaoundé')).toBeInTheDocument();
    expect(screen.getByText('Site : PDV Yaoundé')).toBeInTheDocument();
    expect(screen.getByLabelText('Imputation du coût')).toHaveValue('SITE');
    // Catégories permises au PDV, jamais la catégorie système.
    const categories = within(screen.getByLabelText('Catégorie'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(categories).toEqual(['Choisir la catégorie', 'Transport']);
    await fillExpense(user, '15000');
    await user.type(screen.getByLabelText('Bénéficiaire (facultatif)'), ' Jean ');
    await user.upload(
      screen.getByLabelText('Prendre une photo'),
      new File(['photo'], 'recu.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByText(/Photo prête/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer la dépense' }));
    expect(
      await screen.findByText(
        'Dépense enregistrée sur ce téléphone : elle partira au retour du réseau.',
      ),
    ).toBeInTheDocument();

    const [register, expense] = await outbox();
    expect(expense).toMatchObject({
      command_type: 'finance.expense.record',
      aggregate_type: 'EXPENSE',
      captured_offline: true,
      attachment_ids: [register!.aggregate_id],
      payload: {
        categoryId: EXPENSE_IDS.transport,
        amountXaf: 15_000,
        description: 'Moto-taxi',
        payeeName: 'Jean',
        siteId: IDS.site,
        costObject: { type: 'SITE', id: IDS.site },
        paidNow: true,
        paidFromAccountId: POS_CASH_ACCOUNT,
      },
    });
    expect(expenseRecordPayloadSchema.safeParse(expense!.payload).success).toBe(true);
    expect(register).toMatchObject({
      command_type: 'attachments.attachment.register',
      payload: { ownerType: 'EXPENSE', ownerId: expense!.aggregate_id, kind: 'RECEIPT' },
    });
    // La saisie apparaît dans « Mes dépenses », en attente d'envoi.
    const mine = screen.getByRole('region', { name: 'Mes dépenses' });
    expect(await within(mine).findByText('En attente d’envoi.')).toBeInTheDocument();
    // « Nouvelle dépense » rouvre un formulaire vide.
    await user.click(screen.getByRole('button', { name: 'Nouvelle dépense' }));
    expect(await screen.findByLabelText('Montant (F CFA)')).toHaveValue('');
  });

  it('justificatif manquant au-delà du seuil : envoi bloqué en ligne, validation a posteriori annoncée hors ligne', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt();
    await fillExpense(user, '15000');
    expect(
      await screen.findByText('Envoi impossible en ligne : justificatif manquant.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeDisabled();
    unmount();

    offline();
    renderAt();
    await fillExpense(user, '15000');
    expect(
      await screen.findByText(
        'Hors ligne : la dépense sera enregistrée puis placée en validation a posteriori (justificatif manquant).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeEnabled();
    // Au seuil exactement : aucun justificatif exigé (comparaison stricte).
    await user.clear(screen.getByLabelText('Montant (F CFA)'));
    await user.type(screen.getByLabelText('Montant (F CFA)'), '10000');
    await waitFor(() =>
      expect(screen.queryByText(/validation a posteriori/)).not.toBeInTheDocument(),
    );
  });

  it('caisse du PDV fermée : dépense payée bloquée en ligne ; à payer par la Finance, elle part sans caisse', async () => {
    await getDb().projections.delete(cashSessionRow().key);
    const user = userEvent.setup();
    renderAt();
    await fillExpense(user, '3000');
    expect(
      await screen.findByText(
        /Caisse du point de vente fermée : ouvrez-la avant de payer une dépense/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeDisabled();
    await user.click(screen.getByLabelText('À payer par la Finance'));
    expect(screen.queryByText(/Caisse du point de vente fermée/)).not.toBeInTheDocument();
    // À payer : les catégories non permises au PDV reviennent.
    expect(
      within(screen.getByLabelText('Catégorie')).getByRole('option', { name: 'Vétérinaire' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer la dépense' }));
    expect(await screen.findByText('Dépense en cours d’envoi…')).toBeInTheDocument();
    const [expense] = await outbox();
    expect(expense).toMatchObject({ captured_offline: false, payload: { paidNow: false } });
    expect(expense!.payload).not.toHaveProperty('paidFromAccountId');
  });

  it('hors ligne sans caisse ouverte : la dépense payée part, signalée à la Finance', async () => {
    await getDb().projections.delete(cashSessionRow().key);
    offline();
    const user = userEvent.setup();
    renderAt();
    await fillExpense(user, '3000');
    expect(
      await screen.findByText(/la dépense sera enregistrée et signalée à la Finance/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeEnabled();
  });

  it('seuils lus sur l’appareil : validation annoncée au-delà, justificatif exigé selon le paramètre', async () => {
    await getDb().projections.bulkPut([
      meSettingRow('finance.expense_photo_threshold_xaf', 100_000),
      meSettingRow('finance.expense_approval_threshold_xaf', 40_000),
    ]);
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByLabelText('À payer par la Finance'));
    await fillExpense(user, '45000');
    expect(
      await screen.findByText('Au-delà de 40 000 F CFA : la dépense sera soumise à validation.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Exigé au-delà de 100 000 F CFA/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeEnabled();
  });

  it('plusieurs sites : choix explicite ; une ferme propose les frais généraux d’une espèce', async () => {
    await getDb().projections.bulkPut([
      roleAssignmentRow({ scope_type: 'GLOBAL', scope_site_id: null }),
      siteRow(),
    ]);
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByLabelText('À payer par la Finance'));
    await fillExpense(user, '3000');
    expect(screen.getByLabelText('Site de la dépense')).toHaveValue('');
    expect(screen.getByText('Choisissez le site de la dépense.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la dépense' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Site de la dépense'), EXPENSE_IDS.farm);
    await user.selectOptions(screen.getByLabelText('Imputation du coût'), 'OVERHEAD:PORC');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la dépense' }));
    await screen.findByText('Dépense en cours d’envoi…');
    const [expense] = await outbox();
    expect(expense!.payload).toMatchObject({
      siteId: EXPENSE_IDS.farm,
      costObject: { type: 'SITE', id: EXPENSE_IDS.farm, speciesGroup: 'PORC' },
    });
  });

  it('mes dépenses : statuts, motif du refus, justificatif à joindre, annulation en ligne par l’auteur', async () => {
    await getDb().projections.bulkPut([
      expenseRow(),
      expenseRow({
        id: SECOND,
        doc_number: 'DEP-PDV-YDE-2026-000002',
        status: 'PENDING_APPROVAL',
        paid_now: false,
        paid_from_account_id: null,
        amount_xaf: 15_000,
        review_reasons: ['ATTACHMENT_MISSING'],
        occurred_at: '2026-10-10T08:00:00.000Z',
      }),
      expenseRow({
        id: THIRD,
        doc_number: 'DEP-PDV-YDE-2026-000003',
        status: 'REJECTED',
        paid_now: false,
        paid_from_account_id: null,
        occurred_at: '2026-10-10T07:00:00.000Z',
      }),
      approvalRequestRow({
        subject_id: THIRD,
        status: 'REJECTED',
        decision_comment: 'Reçu illisible',
      }),
    ]);
    const user = userEvent.setup();
    renderAt();
    const mine = await screen.findByRole('region', { name: 'Mes dépenses' });
    const paid = await within(mine).findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000001' });
    expect(within(paid).getByText('Payée')).toBeInTheDocument();
    expect(within(paid).getByText(/Payée par Caisse du PDV de Yaoundé/)).toBeInTheDocument();
    // Payée : jamais annulable.
    expect(within(paid).queryByRole('button', { name: /Annuler/ })).not.toBeInTheDocument();
    const rejected = within(mine).getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000003' });
    expect(within(rejected).getByText('Motif du refus : Reçu illisible')).toBeInTheDocument();
    // Refusée : ni « à payer » ni justificatif à joindre.
    expect(within(rejected).queryByText(/À payer/)).toBeNull();
    const pending = within(mine).getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000002' });
    expect(within(pending).getByText('À revoir : justificatif manquant.')).toBeInTheDocument();
    expect(within(pending).getByText(/À payer après validation/)).toBeInTheDocument();
    // Photos locales du document lues de façon asynchrone : le bouton paraît ensuite.
    expect(
      await within(pending).findByRole('button', {
        name: 'Joindre le justificatif de DEP-PDV-YDE-2026-000002',
      }),
    ).toBeInTheDocument();
    const opener = within(pending).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000002' });
    // Fermé sans envoi : le focus revient au bouton qui l'a ouvert.
    await user.click(opener);
    await user.click(within(pending).getByRole('button', { name: 'Fermer' }));
    await waitFor(() =>
      expect(
        within(pending).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000002' }),
      ).toHaveFocus(),
    );
    await user.click(
      within(pending).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000002' }),
    );
    const reason = within(pending).getByLabelText('Motif de l’annulation');
    expect(reason).toHaveFocus();
    await user.type(reason, 'Saisie en double');
    await user.click(within(pending).getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(await screen.findByText('Annulation en cours d’envoi…')).toBeInTheDocument();
    const [cancel] = await outbox();
    expect(cancel).toMatchObject({
      command_type: 'finance.expense.cancel',
      aggregate_type: 'EXPENSE',
      aggregate_id: SECOND,
      payload: { reason: 'Saisie en double' },
    });
    expect(await within(pending).findByText('Annulation en attente d’envoi.')).toBeInTheDocument();
  });

  it('aucune caisse servie : la dépense part « à payer » ; tablette partagée : les fiches d’un autre ne sont pas montrées', async () => {
    await getDb().projections.delete(posCashAccountRow().key);
    await getDb().projections.bulkPut([expenseRow()]);
    // Données tirées par un autre utilisateur de la tablette (ADR-037 §5).
    const saved = await getDb().syncMeta.get('device');
    await getDb().syncMeta.put({
      key: 'device',
      device_id: '01900000-0000-7000-8000-0000000000d0',
      clock_skew_ms: null,
      last_sync_at: '2026-10-10T08:00:00.000Z',
      data_user_id: OTHER_USER,
    });
    try {
      offline();
      const user = userEvent.setup();
      renderAt();
      expect(
        await screen.findByText(
          'Aucune caisse n’est servie à ce téléphone : la dépense sera payée plus tard par la Finance.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Payée maintenant')).toBeNull();
      const mine = screen.getByRole('region', { name: 'Mes dépenses' });
      expect(within(mine).getByText('Aucune dépense ces 30 derniers jours.')).toBeInTheDocument();
      await fillExpense(user, '3000');
      await user.click(screen.getByRole('button', { name: 'Enregistrer la dépense' }));
      await screen.findByText(/Dépense enregistrée sur ce téléphone/);
      const [expense] = await outbox();
      expect(expense).toMatchObject({ payload: { paidNow: false } });
      expect(expense!.payload).not.toHaveProperty('paidFromAccountId');
    } finally {
      if (saved) await getDb().syncMeta.put(saved);
      else await getDb().syncMeta.delete('device');
    }
  });

  it('hors ligne : l’annulation n’est pas proposée', async () => {
    await getDb().projections.bulkPut([expenseRow({ status: 'RECORDED', paid_now: false })]);
    offline();
    renderAt();
    const card = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000001' });
    expect(within(card).getByText('Annulation possible en ligne seulement.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Annuler/ })).not.toBeInTheDocument();
  });

  it('suivi (Finance) : dépense à payer avec son justificatif, paiement depuis un compte accessible', async () => {
    await asRoles(['FINANCE']);
    serve({
      '/api/v1/expenses?status=RECORDED&limit=200': { expenses: [item()], next_cursor: null },
      '/api/v1/expenses?status=APPROVED&limit=200': { expenses: [], next_cursor: null },
      '/api/v1/cash-accounts': {
        cash_accounts: [
          bank,
          {
            ...bank,
            id: OTHER_PERSONAL,
            name: 'Caisse de Paul',
            accountType: 'CAISSE_UTILISATEUR',
            holderUserId: OTHER_USER,
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt('/finance/depenses?vue=suivi');
    const card = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    expect(within(card).getByText('Enregistrée, à payer')).toBeInTheDocument();
    expect(within(card).getByText(/Garage Nkolbisson/)).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Voir le justificatif de DEP-PDV-YDE-2026-000007' }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/^À payer ·/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Payer DEP-PDV-YDE-2026-000007' }));
    const accountSelect = within(card).getByLabelText('Compte qui paie');
    expect(accountSelect).toHaveFocus();
    // Jamais la caisse personnelle d'un autre ; seul compte : proposé.
    expect(within(accountSelect).queryByRole('option', { name: 'Caisse de Paul' })).toBeNull();
    expect(accountSelect).toHaveValue(BANK);
    await user.click(within(card).getByRole('button', { name: /Payer 5\s000 F CFA/ }));
    expect(await screen.findByText('Paiement en cours d’envoi…')).toBeInTheDocument();
    const [payment] = await outbox();
    expect(payment).toMatchObject({
      command_type: 'finance.expense.pay',
      aggregate_type: 'EXPENSE',
      aggregate_id: EXPENSE_IDS.expense,
      captured_offline: false,
      payload: { paidFromAccountId: BANK },
    });
  });

  it('suivi : en validation, la décision se prend dans la file ; un vendeur ne paie pas mais annule la sienne', async () => {
    await asRoles(['VENDEUR_PDV']);
    serve({
      '/api/v1/expenses?status=RECORDED&limit=200': {
        expenses: [item({ createdBy: IDS.user, docNumber: 'DEP-PDV-YDE-2026-000008' })],
        next_cursor: null,
      },
      '/api/v1/expenses?status=APPROVED&limit=200': {
        expenses: [item({ id: SECOND, status: 'APPROVED' })],
        next_cursor: null,
      },
      '/api/v1/expenses?status=PENDING_APPROVAL&limit=200': {
        expenses: [item({ id: THIRD, status: 'PENDING_APPROVAL', attachments: [] })],
        next_cursor: null,
      },
      '/api/v1/expenses?status=PAID_PENDING_APPROVAL&limit=200': {
        expenses: [],
        next_cursor: null,
      },
    });
    const user = userEvent.setup();
    renderAt('/finance/depenses?vue=suivi');
    const own = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000008' });
    expect(within(own).queryByRole('button', { name: /^Payer/ })).not.toBeInTheDocument();
    expect(
      within(own).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000008' }),
    ).toBeInTheDocument();
    // Dépense d'un autre : ni paiement ni annulation pour un vendeur.
    const theirs = screen.getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    expect(within(theirs).queryByRole('button', { name: /Payer|Annuler/ })).toBeNull();
    // Les comptes ne sont lus que pour qui paie.
    expect(request.mock.calls.map(([, path]) => path)).not.toContain('/api/v1/cash-accounts');
    await user.selectOptions(screen.getByLabelText('Dépenses'), 'TO_DECIDE');
    const waiting = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    expect(within(waiting).getByText('Aucun justificatif joint.')).toBeInTheDocument();
    // Le vendeur n'approuve pas les dépenses : aucun lien vers une file qui serait vide pour lui.
    expect(
      within(waiting).queryByRole('link', { name: 'Décider dans les validations' }),
    ).toBeNull();
  });

  it('suivi (approbateur) : lien de décision, annulation de la dépense d’un autre, état des justificatifs', async () => {
    await asRoles(['DIRECTION']);
    serve({
      '/api/v1/expenses?status=RECORDED&limit=200': {
        expenses: [
          item({ attachments: [{ id: RECEIPT, kind: 'RECEIPT', uploadStatus: 'PENDING_UPLOAD' }] }),
          item({
            id: SECOND,
            docNumber: 'DEP-PDV-YDE-2026-000009',
            attachments: [{ id: RECEIPT, kind: 'RECEIPT', uploadStatus: 'QUARANTINED' }],
          }),
        ],
        next_cursor: null,
      },
      '/api/v1/expenses?status=APPROVED&limit=200': { expenses: [], next_cursor: null },
      '/api/v1/expenses?status=PENDING_APPROVAL&limit=200': {
        expenses: [item({ id: THIRD, status: 'PENDING_APPROVAL' })],
        next_cursor: null,
      },
      '/api/v1/expenses?status=PAID_PENDING_APPROVAL&limit=200': {
        expenses: [],
        next_cursor: null,
      },
    });
    const user = userEvent.setup();
    renderAt('/finance/depenses?vue=suivi');
    const card = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    // Pièce pas encore reçue ou refusée : annoncée, jamais présentée comme lisible.
    expect(
      within(card).getByText('Justificatif en cours d’envoi par l’auteur.'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Voir le justificatif/ })).toBeNull();
    const refused = screen.getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000009' });
    expect(
      within(refused).getByText('Justificatif refusé par le serveur : l’auteur doit le renvoyer.'),
    ).toBeInTheDocument();
    // La Direction ne paie pas ; elle annule la dépense d'un autre (approbateur).
    expect(within(card).queryByRole('button', { name: /^Payer/ })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000007' }));
    const reason = within(card).getByLabelText('Motif de l’annulation');
    expect(reason).toHaveFocus();
    await user.type(reason, 'Doublon de la facture');
    await user.click(within(card).getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(await screen.findByText('Annulation en cours d’envoi…')).toBeInTheDocument();
    const [cancel] = await outbox();
    expect(cancel).toMatchObject({
      command_type: 'finance.expense.cancel',
      aggregate_id: EXPENSE_IDS.expense,
      captured_offline: false,
      payload: { reason: 'Doublon de la facture' },
    });
    await user.selectOptions(screen.getByLabelText('Dépenses'), 'TO_DECIDE');
    const waiting = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    expect(within(waiting).getByText(/^À payer après validation ·/)).toBeInTheDocument();
    expect(
      within(waiting).getByRole('link', { name: 'Décider dans les validations' }),
    ).toHaveAttribute('href', '/validations?types=EXPENSE');
  });

  it('suivi : relecture en échec annoncée avec « Réessayer » ; comptes illisibles, paiement en attente de relecture', async () => {
    await asRoles(['FINANCE']);
    const routes: Record<string, unknown> = {
      '/api/v1/expenses?status=RECORDED&limit=200': { expenses: [item()], next_cursor: null },
      '/api/v1/expenses?status=APPROVED&limit=200': { expenses: [], next_cursor: null },
      // Comptes : route absente, le serveur ne répond pas.
    };
    serve(routes);
    const user = userEvent.setup();
    renderAt('/finance/depenses?vue=suivi');
    const card = await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' });
    await user.click(within(card).getByRole('button', { name: 'Payer DEP-PDV-YDE-2026-000007' }));
    expect(
      within(card).getByText('Comptes indisponibles : le serveur n’a pas répondu. Réessayez.'),
    ).toBeInTheDocument();
    // Le formulaire se ferme : les actions de la carte reviennent.
    await user.click(within(card).getByRole('button', { name: 'Fermer' }));
    expect(
      within(card).getByRole('button', { name: 'Annuler DEP-PDV-YDE-2026-000007' }),
    ).toBeInTheDocument();
    // Les comptes reviennent : le paiement part.
    routes['/api/v1/cash-accounts'] = { cash_accounts: [bank] };
    await user.click(within(card).getByRole('button', { name: 'Payer DEP-PDV-YDE-2026-000007' }));
    await user.click(within(card).getByRole('button', { name: 'Réessayer' }));
    const payButton = await within(
      await screen.findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000007' }),
    ).findByRole('button', { name: /Payer 5\s000 F CFA/ });
    // Relecture finie : le paiement est possible.
    await waitFor(() => expect(payButton).toBeEnabled());
    // La liste relue, la relecture suivante échoue : bandeau d'échec et « Réessayer », jamais
    // « Actualisation en cours » sans fin.
    routes['/api/v1/expenses?status=RECORDED&limit=200'] = undefined;
    await user.click(payButton);
    expect(await screen.findByText(/Actualisation impossible/)).toBeInTheDocument();
    expect(screen.queryByText(/Actualisation en cours/)).toBeNull();
    routes['/api/v1/expenses?status=RECORDED&limit=200'] = { expenses: [], next_cursor: null };
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByText(/Actualisation impossible/)).toBeNull());
    expect(await screen.findByText('Aucune dépense dans ce groupe.')).toBeInTheDocument();
  });

  it('revue de P8E-03 : justificatif refusé à remplacer ; hors ligne sans politique, dépense signalée sans validation ; montant vide', async () => {
    await getDb().projections.bulkPut([
      expenseRow({
        status: 'PAID_PENDING_APPROVAL',
        amount_xaf: 60_000,
        review_reasons: [],
      }),
      expenseRow({
        id: SECOND,
        doc_number: 'DEP-PDV-YDE-2026-000002',
        status: 'PAID',
        review_reasons: ['POS_CAP_EXCEEDED'],
        amount_xaf: 60_000,
      }),
      expenseRow({
        id: THIRD,
        doc_number: 'DEP-PDV-YDE-2026-000003',
        status: 'REJECTED',
        paid_now: false,
        paid_from_account_id: null,
      }),
    ]);
    const refusedFile = (attachmentId: string, ownerId: string) => ({
      attachment_id: attachmentId,
      author_user_id: IDS.user,
      owner_type: 'EXPENSE',
      owner_id: ownerId,
      kind: 'RECEIPT',
      mime_type: 'image/jpeg',
      size_bytes: 8,
      sha256: 'a'.repeat(64),
      captured_at: '2026-10-10T09:00:00.000Z',
      register_command_id: 'enregistrement',
      status: 'QUARANTINED' as const,
      uploaded_bytes: 8,
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
    });
    await getDb().attachmentFiles.bulkPut([
      refusedFile('01900000-0000-7000-8000-0000000004d1', EXPENSE_IDS.expense),
      refusedFile('01900000-0000-7000-8000-0000000004d2', THIRD),
    ]);
    // Une politique servie, mais aucune pour les dépenses : aucune validation ne sera ouverte.
    await getDb().projections.delete(controlPolicyRow().key);
    await getDb().projections.put(
      controlPolicyRow({
        id: '01900000-0000-7000-8000-0000000004d3',
        code: 'LOSS_DEFAULT',
        operation_type: 'LOSS_DECLARATION',
      }),
    );
    offline();
    const user = userEvent.setup();
    renderAt();
    const mine = await screen.findByRole('region', { name: 'Mes dépenses' });
    // Photo citée refusée par le serveur : à remplacer, même sans motif de revue.
    const awaiting = await within(mine).findByRole('listitem', { name: 'DEP-PDV-YDE-2026-000001' });
    expect(
      await within(awaiting).findByRole('button', {
        name: 'Joindre le justificatif de DEP-PDV-YDE-2026-000001',
      }),
    ).toBeInTheDocument();
    // Dépense refusée : rien à joindre, l'état de la photo seulement.
    const rejected = within(mine).getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000003' });
    expect(await within(rejected).findByText(/Photo refusée par le serveur/)).toBeInTheDocument();
    expect(within(rejected).queryByRole('button', { name: /Joindre/ })).toBeNull();
    // Motif d'une dépense close : relevé à la saisie, plafond en clair.
    const closed = within(mine).getByRole('listitem', { name: 'DEP-PDV-YDE-2026-000002' });
    expect(
      within(closed).getByText(
        'Relevé à la saisie : montant au-delà du plafond de la caisse du point de vente (50 000 F CFA).',
      ),
    ).toBeInTheDocument();
    // Saisie hors ligne non conforme, sans politique : signalée, jamais « en validation ».
    await user.selectOptions(await screen.findByLabelText('Catégorie'), EXPENSE_IDS.transport);
    await user.type(screen.getByLabelText('Objet de la dépense'), 'Moto-taxi');
    expect(screen.getByText('Indiquez le montant.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant (F CFA)'), '15000');
    expect(
      await screen.findByText(
        'Hors ligne : la dépense sera enregistrée et signalée à la Finance (justificatif manquant).',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/validation a posteriori/)).toBeNull();
  });

  it('suivi : en ligne seulement ; réservé aux rôles qui lisent les dépenses des autres', async () => {
    offline();
    const { unmount } = renderAt('/finance/depenses?vue=suivi');
    expect(
      await screen.findByText('Suivi des dépenses en ligne seulement : reconnectez-vous.'),
    ).toBeInTheDocument();
    unmount();
    await asRoles(['COMMERCIAL_TERRAIN']);
    renderAt('/finance/depenses?vue=suivi');
    expect(await screen.findByRole('heading', { name: 'Nouvelle dépense' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Suivi des dépenses' })).not.toBeInTheDocument();
  });
});
