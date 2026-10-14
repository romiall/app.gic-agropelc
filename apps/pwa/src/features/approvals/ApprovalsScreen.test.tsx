import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { fetchAttachmentContent } from '../../sync/attachment-content.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { ApprovalsScreen } from './ApprovalsScreen.js';
import {
  actionsFor,
  blockReason,
  commandOf,
  EMPTY_DECISION,
  inboxPath,
  typesFromQuery,
  type ApprovalView,
} from './approvals.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../sync/attachment-content.js', () => ({ fetchAttachmentContent: vi.fn() }));
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

let seq = 0;
function request(overrides: Partial<ApprovalView> = {}): ApprovalView {
  seq += 1;
  return {
    id: `01900000-0000-7000-8000-0000000001${String(seq).padStart(2, '0')}`,
    operationType: 'PRICE_OVERRIDE',
    subjectType: 'SALE_LINE',
    subjectId: '01900000-0000-7000-8000-0000000002aa',
    subjectSummary: `Remise de 20 % (${seq})`,
    amountXaf: 4_000,
    amountMasked: false,
    siteId: IDS.site,
    zoneId: null,
    requestedBy: '01900000-0000-7000-8000-0000000000bb',
    requestedByName: 'Paul Essomba',
    requestedAt: '2026-10-13T08:00:00.000Z',
    attachmentsPending: false,
    selfRequest: false,
    ...overrides,
  };
}

function serve(requests: readonly ApprovalView[]) {
  vi.mocked(authorizedRequest).mockImplementation(
    (_db, path) =>
      Promise.resolve(
        String(path).startsWith('/api/v1/approvals/inbox')
          ? { ok: true, data: { requests, next_cursor: null } }
          : { ok: false, reason: 'HTTP_ERROR', status: 500, message: `route absente : ${path}` },
      ) as never,
  );
}

function renderScreen(entry = '/validations') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ApprovalsScreen />
    </MemoryRouter>,
  );
}

const lastCommand = async () =>
  (await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray())[0];

describe('Validations : logique (ECR-ADM-08, ADR-018)', () => {
  it('décisions proposées selon le type : un écart de caisse ou de remise s’accepte seulement', () => {
    expect(actionsFor(request())).toEqual(['APPROVE', 'REJECT']);
    expect(actionsFor(request({ operationType: 'CASH_VARIANCE' }))).toEqual(['APPROVE']);
    expect(actionsFor(request({ operationType: 'CASH_TRANSFER_DISCREPANCY' }))).toEqual([
      'APPROVE',
    ]);
    expect(actionsFor(request({ operationType: 'TYPE_FUTUR' }))).toEqual(['APPROVE', 'REJECT']);
  });

  it('écarts : motif obligatoire à l’acceptation (200 caractères), remis au module ; imputation d’une remise', () => {
    const cash = request({ operationType: 'CASH_VARIANCE' });
    expect(blockReason(cash, 'APPROVE', EMPTY_DECISION)).toBe('COMMENT_REQUIRED');
    expect(blockReason(cash, 'APPROVE', { ...EMPTY_DECISION, comment: 'x'.repeat(201) })).toBe(
      'TOO_LONG',
    );
    expect(commandOf(cash, 'APPROVE', { ...EMPTY_DECISION, comment: ' Billet abîmé ' })).toEqual({
      commandType: 'approvals.request.approve',
      payload: {
        requestId: cash.id,
        comment: 'Billet abîmé',
        decisionData: { reason: 'Billet abîmé' },
      },
    });
    const transfer = request({ operationType: 'CASH_TRANSFER_DISCREPANCY' });
    expect(blockReason(transfer, 'APPROVE', { ...EMPTY_DECISION, comment: 'Manque' })).toBe(
      'OPTION_REQUIRED',
    );
    expect(
      commandOf(transfer, 'APPROVE', { ...EMPTY_DECISION, comment: 'Manque', option: 'CARRIER' })
        .payload,
    ).toEqual({
      requestId: transfer.id,
      comment: 'Manque',
      decisionOption: 'CARRIER',
      decisionData: { reason: 'Manque' },
    });
  });

  it('ce qui empêche d’envoyer : pièce attendue, motif du refus, longueur, auto-validation', () => {
    const view = request();
    expect(blockReason(view, 'APPROVE', EMPTY_DECISION)).toBeNull();
    expect(blockReason(view, 'REJECT', EMPTY_DECISION)).toBe('COMMENT_REQUIRED');
    expect(blockReason(view, 'REJECT', { ...EMPTY_DECISION, comment: '  ' })).toBe(
      'COMMENT_REQUIRED',
    );
    expect(blockReason(view, 'REJECT', { ...EMPTY_DECISION, comment: 'x'.repeat(2001) })).toBe(
      'TOO_LONG',
    );
    expect(blockReason(request({ attachmentsPending: true }), 'APPROVE', EMPTY_DECISION)).toBe(
      'ATTACHMENT_PENDING',
    );
    // Le refus reste possible sans la pièce.
    expect(
      blockReason(request({ attachmentsPending: true }), 'REJECT', {
        ...EMPTY_DECISION,
        comment: 'Non',
      }),
    ).toBeNull();
    expect(blockReason(request({ selfRequest: true }), 'APPROVE', EMPTY_DECISION)).toBe(
      'SELF_CONFIRM',
    );
    expect(
      blockReason(request({ selfRequest: true }), 'APPROVE', {
        ...EMPTY_DECISION,
        selfApproved: true,
      }),
    ).toBeNull();
    expect(
      blockReason(request({ operationType: 'PAYMENT_DUPLICATE' }), 'APPROVE', {
        ...EMPTY_DECISION,
        data: { correctedReference: 'x'.repeat(201) },
      }),
    ).toBe('TOO_LONG');
  });

  it('commandes : choix et données du type, auto-validation seulement sur sa propre demande', () => {
    const sale = request({ operationType: 'SALE_CANCELLATION' });
    expect(commandOf(sale, 'APPROVE', { ...EMPTY_DECISION, option: 'REFUND' })).toEqual({
      commandType: 'approvals.request.approve',
      payload: { requestId: sale.id, decisionOption: 'REFUND' },
    });
    const loss = request({ operationType: 'MORTALITY' });
    expect(
      commandOf(loss, 'REJECT', {
        ...EMPTY_DECISION,
        comment: ' Photo floue ',
        option: 'PERTE_NON_JUSTIFIEE',
      }),
    ).toEqual({
      commandType: 'approvals.request.reject',
      payload: {
        requestId: loss.id,
        comment: 'Photo floue',
        decisionOption: 'PERTE_NON_JUSTIFIEE',
      },
    });
    // Option inconnue du type : jamais envoyée.
    expect(
      commandOf(request(), 'APPROVE', { ...EMPTY_DECISION, option: 'REFUND' }).payload,
    ).toEqual({ requestId: expect.any(String) });
    const duplicate = request({ operationType: 'PAYMENT_DUPLICATE' });
    expect(
      commandOf(duplicate, 'APPROVE', {
        ...EMPTY_DECISION,
        data: { correctedReference: ' MOMO-123 ' },
      }).payload,
    ).toEqual({ requestId: duplicate.id, decisionData: { correctedReference: 'MOMO-123' } });
    expect(
      commandOf(request(), 'APPROVE', { ...EMPTY_DECISION, selfApproved: true }).payload,
    ).not.toHaveProperty('selfApproved');
    const own = request({ selfRequest: true });
    expect(commandOf(own, 'APPROVE', { ...EMPTY_DECISION, selfApproved: true }).payload).toEqual({
      requestId: own.id,
      selfApproved: true,
    });
  });

  it('filtre de l’accueil : types lus dans la requête, chemin de lecture', () => {
    expect(typesFromQuery('MORTALITY,ANIMAL_COUNT_ADJUSTMENT,MORTALITY')).toEqual([
      'MORTALITY',
      'ANIMAL_COUNT_ADJUSTMENT',
    ]);
    expect(typesFromQuery('mortality,<script>')).toEqual([]);
    expect(typesFromQuery(null)).toEqual([]);
    expect(inboxPath([])).toBe('/api/v1/approvals/inbox?limit=200');
    expect(inboxPath(['PRICE_OVERRIDE'])).toBe(
      '/api/v1/approvals/inbox?limit=200&types=PRICE_OVERRIDE',
    );
  });
});

describe('Validations (ECR-ADM-08)', () => {
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

  it('approuve une remise : commande sur l’agrégat de la demande ; montant, demandeur et site affichés', async () => {
    const view = request();
    serve([view]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', {
      name: `Remise au-delà du plafond : ${view.subjectSummary}`,
    });
    expect(within(card).getByText('4 000 F CFA')).toBeInTheDocument();
    expect(within(card).getByText(/Demandé par Paul Essomba/)).toBeInTheDocument();
    // Nom du site résolu par les référentiels de l'appareil, lus après la file.
    expect(await within(card).findByText(/Site : PDV Yaoundé/)).toBeInTheDocument();
    expect(within(card).getByText(/Validation a posteriori/)).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: `Approuver : ${view.subjectSummary}` }),
    );
    await user.click(within(card).getByRole('button', { name: 'Confirmer l’approbation' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'approvals.request.approve',
      aggregate_type: 'APPROVAL_REQUEST',
      aggregate_id: view.id,
      payload: { requestId: view.id },
      captured_offline: false,
    });
    expect(await screen.findByText('Décision en cours d’envoi…')).toBeInTheDocument();
  });

  it('refuse une mortalité : motif obligatoire, issue « perte non justifiée »', async () => {
    const view = request({ operationType: 'MORTALITY', subjectSummary: 'Mortalité PRT-0012' });
    serve([view]);
    const user = userEvent.setup();
    renderScreen('/validations?types=MORTALITY,ANIMAL_COUNT_ADJUSTMENT');
    const card = await screen.findByRole('listitem', { name: 'Mortalité : Mortalité PRT-0012' });
    // Chemins seuls : en cas d'échec, afficher la base locale passée en argument épuise la mémoire.
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/approvals/inbox?limit=200&types=MORTALITY,ANIMAL_COUNT_ADJUSTMENT',
    );
    expect(screen.getByText(/Filtre : Mortalité, Écart de comptage d’animaux/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voir toutes les validations' })).toHaveAttribute(
      'href',
      '/validations',
    );
    await user.click(within(card).getByRole('button', { name: 'Refuser : Mortalité PRT-0012' }));
    const confirm = within(card).getByRole('button', { name: 'Confirmer le refus' });
    expect(confirm).toBeDisabled();
    await user.click(within(card).getByLabelText(/Perte non justifiée/));
    await user.type(within(card).getByLabelText('Motif du refus (obligatoire)'), 'Photo floue');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'approvals.request.reject',
      payload: {
        requestId: view.id,
        comment: 'Photo floue',
        decisionOption: 'PERTE_NON_JUSTIFIEE',
      },
    });
  });

  it('justificatif attendu, montant masqué, écart de caisse accepté avec motif, propre demande de la Direction', async () => {
    const waiting = request({
      operationType: 'MORTALITY',
      subjectSummary: 'Mortalité PRT-0013',
      attachmentsPending: true,
      amountXaf: null,
      amountMasked: true,
    });
    const cash = request({ operationType: 'CASH_VARIANCE', subjectSummary: 'Écart de caisse' });
    const own = request({ subjectSummary: 'Remise de la Direction', selfRequest: true });
    serve([waiting, cash, own]);
    const user = userEvent.setup();
    renderScreen();

    const waitingCard = await screen.findByRole('listitem', {
      name: 'Mortalité : Mortalité PRT-0013',
    });
    expect(within(waitingCard).getByText(/Justificatif attendu/)).toBeInTheDocument();
    expect(within(waitingCard).getByText(/Montant au coût masqué/)).toBeInTheDocument();
    expect(
      within(waitingCard).getByRole('button', { name: 'Approuver : Mortalité PRT-0013' }),
    ).toBeDisabled();
    expect(
      within(waitingCard).getByRole('button', { name: 'Refuser : Mortalité PRT-0013' }),
    ).toBeEnabled();

    // Écart de caisse : acceptation seule, motif obligatoire (y compris l'ajustement tardif d'une
    // session validée, que la trésorerie ne liste pas, S-51).
    const cashCard = screen.getByRole('listitem', { name: 'Écart de caisse : Écart de caisse' });
    expect(within(cashCard).queryByRole('button', { name: /Refuser/ })).toBeNull();
    expect(within(cashCard).getByText(/Un écart s’accepte avec son motif/)).toBeInTheDocument();
    await user.click(within(cashCard).getByRole('button', { name: 'Approuver : Écart de caisse' }));
    const accept = within(cashCard).getByRole('button', { name: 'Confirmer l’approbation' });
    expect(accept).toBeDisabled();
    await user.type(
      within(cashCard).getByLabelText(/Motif de l’acceptation \(obligatoire/),
      'Billet abîmé',
    );
    await user.click(accept);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'approvals.request.approve',
      payload: {
        requestId: cash.id,
        comment: 'Billet abîmé',
        decisionData: { reason: 'Billet abîmé' },
      },
    });
    await getDb().outbox.clear();
    cleanup();
    serve([own]);
    renderScreen();

    const ownCard = await screen.findByRole('listitem', {
      name: 'Remise au-delà du plafond : Remise de la Direction',
    });
    expect(within(ownCard).getByText(/Votre propre demande/)).toBeInTheDocument();
    await user.click(
      within(ownCard).getByRole('button', { name: 'Approuver : Remise de la Direction' }),
    );
    const confirm = within(ownCard).getByRole('button', { name: 'Confirmer l’approbation' });
    expect(confirm).toBeDisabled();
    await user.click(within(ownCard).getByLabelText(/J’approuve ma propre demande/));
    await user.click(confirm);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'approvals.request.approve',
      payload: { requestId: own.id, selfApproved: true },
    });
  });

  it('annulation de vente : sort de l’argent au choix de l’approbateur', async () => {
    const view = request({
      operationType: 'SALE_CANCELLATION',
      subjectSummary: 'Annulation VTE-9',
    });
    serve([view]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', {
      name: 'Annulation de vente : Annulation VTE-9',
    });
    await user.click(within(card).getByRole('button', { name: 'Approuver : Annulation VTE-9' }));
    expect(within(card).getByText('Argent déjà payé par le client')).toBeInTheDocument();
    await user.click(within(card).getByLabelText('Garder en crédit au nom du client'));
    await user.click(within(card).getByRole('button', { name: 'Confirmer l’approbation' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      payload: { requestId: view.id, decisionOption: 'CUSTOMER_CREDIT' },
    });
  });

  it('MP-10 (AV-286) : photo reçue du document vue avant de décider ; photo en route non proposée ; hors périmètre', async () => {
    const PHOTO = '01900000-0000-7000-8000-0000000003f1';
    const view = request({
      operationType: 'MORTALITY',
      subjectType: 'STOCK_LOSS',
      subjectSummary: 'Mortalité : 12 têtes',
      attachments: [
        { id: PHOTO, kind: 'PHOTO', uploadStatus: 'AVAILABLE' },
        {
          id: '01900000-0000-7000-8000-0000000003f2',
          kind: 'PHOTO',
          uploadStatus: 'PENDING_UPLOAD',
        },
      ],
    });
    serve([view]);
    const createObjectURL = vi.fn(() => 'blob:photo-recue');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.mocked(fetchAttachmentContent).mockResolvedValue({
      ok: true,
      blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }),
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: /Mortalité : 12 têtes/ });
    const buttons = within(card).getAllByRole('button', { name: 'Voir la photo' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    const image = await within(card).findByRole('img', {
      name: 'Photo jointe : Mortalité : 12 têtes',
    });
    expect(image).toHaveAttribute('src', 'blob:photo-recue');
    expect(fetchAttachmentContent).toHaveBeenCalledWith(expect.anything(), PHOTO);
    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo-recue');

    // Échec réseau puis nouvel essai réussi.
    vi.mocked(fetchAttachmentContent).mockResolvedValueOnce({ ok: false, reason: 'OFFLINE' });
    renderScreen();
    await user.click(
      within(await screen.findByRole('listitem', { name: /Mortalité : 12 têtes/ })).getByRole(
        'button',
        { name: 'Voir la photo' },
      ),
    );
    expect(await screen.findByText(/Photo indisponible hors connexion/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(
      await screen.findByRole('img', { name: 'Photo jointe : Mortalité : 12 têtes' }),
    ).toBeInTheDocument();
    cleanup();

    vi.mocked(fetchAttachmentContent).mockResolvedValue({ ok: false, reason: 'FORBIDDEN' });
    renderScreen();
    await user.click(
      within(await screen.findByRole('listitem', { name: /Mortalité : 12 têtes/ })).getByRole(
        'button',
        { name: 'Voir la photo' },
      ),
    );
    expect(
      await screen.findByText('Cette photo n’est pas dans votre périmètre.'),
    ).toBeInTheDocument();
  });

  it('hors ligne : écran en ligne seulement ; file vide ; droit refusé', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(
      await screen.findByText(
        'Écran en ligne seulement : reconnectez-vous pour décider les validations.',
      ),
    ).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    serve([]);
    renderScreen();
    expect(await screen.findByText('Aucune validation ne vous attend.')).toBeInTheDocument();
    cleanup();
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 403,
      message: 'refusé',
    } as never);
    renderScreen();
    expect(
      await screen.findByText('Lecture des validations refusée : droit insuffisant.'),
    ).toBeInTheDocument();
  });
});
