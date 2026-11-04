/**
 * ECR-PIE-01 « Reporter une pièce papier » (PP-B ; REQ-303, AV-078, AV-312, AV-501 à AV-504) : de la
 * saisie à l'outbox, avec les vrais référentiels de l'appareil (projections posées dans la base locale,
 * telles que le serveur les sert) et la vraie base locale — plus aucun mock de l'écran, de ses
 * référentiels ni de son envoi, qui laissaient passer des commandes que le serveur refusait.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../storage/db.js';
import {
  DEVICE_ID,
  EXPENSE_IDS,
  IDS,
  POS_CASH_ACCOUNT,
  expenseCategoryRow,
  posCashAccountRow,
  seedSalesFixtures,
} from '../sales/fixtures.js';
import { PaperSlipReportScreen } from './PaperSlipReportScreen.js';
import type { ResolvedSlip } from './report-commands.js';
import { submitPaperSlipReport } from './report-submit.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: { status: 'unlocked', userId: IDS.user, deviceStatus: 'ACTIVE' },
    deviceId: DEVICE_ID,
  }),
}));

const sale: ResolvedSlip = {
  type: 'BV',
  fromLocationId: IDS.pos,
  lines: [
    {
      productId: IDS.chicken,
      quantity: 1,
      unitCode: 'U',
      quantityBase: 1,
      listUnitPriceXaf: 3500,
      priceRuleId: IDS.ruleChicken,
      unitPriceXaf: 3500,
    },
  ],
  payment: { methodCode: 'ESPECES', amountXaf: 3500 },
  totalXaf: 3500,
};

const meta = (paperRef: string, occurredAt: string) => ({
  paperRef,
  occurredAt,
  backdatedReason: null,
  dependsOn: [],
});

const renderScreen = () =>
  render(
    <MemoryRouter>
      <PaperSlipReportScreen />
    </MemoryRouter>,
  );

describe('PaperSlipReportScreen (PP-B)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.attachmentFiles.clear();
    await db.attachmentBlobs.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([posCashAccountRow(), expenseCategoryRow()]);
  });

  afterEach(async () => {
    cleanup();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.attachmentFiles.clear();
    await db.attachmentBlobs.clear();
  });

  it('affiche le titre de l’écran et le formulaire de report', async () => {
    renderScreen();
    expect(screen.getByText(/Reporter une pièce papier/i)).toBeInTheDocument();
    expect(screen.getByText(/Saisie du report/i)).toBeInTheDocument();
    expect(screen.getByText(/Registre des carnets/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/Numéro de la pièce/i)).toBeInTheDocument();
    // Les champs du type choisi (vente) viennent des référentiels de l'appareil.
    expect(await screen.findByLabelText('Emplacement de vente')).toBeInTheDocument();
  });

  it('alerte en temps réel sur un doublon ou un saut de numérotation', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await submitPaperSlipReport(sale, meta('BV-0010', at), IDS.user);
    await submitPaperSlipReport(sale, meta('BV-0011', at), IDS.user);
    const user = userEvent.setup();
    renderScreen();
    const ref = await screen.findByLabelText(/Numéro de la pièce/i);

    await user.type(ref, 'BV-0010');
    expect(await screen.findByText(/Numéro déjà saisi/i)).toBeInTheDocument();

    await user.clear(ref);
    await user.type(ref, 'BV-0015');
    expect(await screen.findByText(/Saut détecté/i)).toBeInTheDocument();
  });

  it('bascule vers l’onglet Registre des carnets : indicateurs et pièces reportées', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await submitPaperSlipReport(sale, meta('BV-0010', at), IDS.user);
    await submitPaperSlipReport(sale, meta('BV-0013', at), IDS.user);
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('radio', { name: /Registre des carnets/i }));

    expect(await screen.findByText(/Total reporté/i)).toBeInTheDocument();
    expect(screen.getByText(/Plage \(Min - Max\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Sauts détectés/i)).toBeInTheDocument();
    expect(await screen.findByText('BV-0013')).toBeInTheDocument();
    expect(screen.getByText('N° 10 → 13')).toBeInTheDocument();
  });

  it('registre : la continuité se juge par carnet, jamais sur l’ensemble des numéros (AV-312)', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await submitPaperSlipReport(sale, meta('BV-000140', at), IDS.user);
    await submitPaperSlipReport(sale, meta('BV-000141', at), IDS.user);
    await submitPaperSlipReport(
      {
        type: 'RE',
        customerId: IDS.customer,
        siteId: IDS.site,
        payment: { methodCode: 'ESPECES', amountXaf: 25_000 },
      },
      meta('RE-000099', at),
      IDS.user,
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('radio', { name: /Registre des carnets/i }));
    await screen.findByText('RE-000099');

    // Un bon de vente n° 141 et un reçu n° 99 ne forment pas 42 « sauts » : deux carnets, aucun manque.
    const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(value('Total reporté')).toBe('3');
    expect(value('Sauts détectés')).toBe('0');
    expect(value('Doublons détectés')).toBe('0');
    expect(value('Plage (Min - Max)')).toBe('—');
    // État d'envoi en français, pas le code de la file.
    expect(screen.getAllByText('En attente d’envoi')).toHaveLength(3);
    expect(screen.queryByText('LOCAL_ONLY')).toBeNull();

    // Filtré sur un carnet : sa plage.
    await user.selectOptions(screen.getByDisplayValue('Tous les carnets'), 'BV');
    expect(await screen.findByText('N° 140 → 141')).toBeInTheDocument();
  });

  it('registre : moyen de paiement et nature de perte en français, jamais en code brut', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await submitPaperSlipReport(
      {
        type: 'RE',
        customerId: IDS.customer,
        siteId: IDS.site,
        payment: { methodCode: 'ESPECES', amountXaf: 25_000 },
      },
      meta('RE-000099', at),
      IDS.user,
    );
    await submitPaperSlipReport(
      {
        type: 'FP',
        locationId: IDS.pos,
        productId: IDS.chicken,
        unitCode: 'U',
        quantity: 1,
        quantityBase: 1,
        category: 'CASSE',
      },
      meta('FP-000007', at),
      IDS.user,
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('radio', { name: /Registre des carnets/i }));

    // Le libellé du moyen de paiement vient du référentiel de l'appareil, celui de la perte du français.
    expect(await screen.findByText('Encaissement (Espèces)')).toBeInTheDocument();
    expect(await screen.findByText('Perte (Casse)')).toBeInTheDocument();
    expect(screen.queryByText(/ESPECES|CASSE/)).toBeNull();
  });

  it('l’écran ne montre aucun numéro de décision (AV-…) dans son sous-titre ni dans ses consignes', async () => {
    renderScreen();
    expect(
      await screen.findByText('Saisie des pièces de carnets à souche et registre'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bAV-\d{3}\b/);
  });

  it('une pièce incomplète n’est pas enregistrée : l’écran dit ce qui manque', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByLabelText('Emplacement de vente');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    const alert = await screen.findByText(/ne peut pas encore être enregistrée/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('Saisissez le numéro de la pièce.')).toBeInTheDocument();
    expect(screen.getByText('Choisissez l’emplacement.')).toBeInTheDocument();
    expect(screen.getByText('Ajoutez au moins une ligne.')).toBeInTheDocument();
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('BV : la vente est mise en file comme sales.sale.record, au prix catalogue, « saisie hors ligne »', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByLabelText(/Numéro de la pièce/i), 'BV-000142');
    await user.selectOptions(screen.getByLabelText('Emplacement de vente'), IDS.pos);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '4');
    // Total et règlement préremplis au prix catalogue de l'appareil (3 500 × 4).
    expect(await screen.findByText(/Total/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    expect(await screen.findByText(/BV-000142 enregistrée/)).toBeInTheDocument();
    const [row] = await getDb().outbox.toArray();
    expect(row).toMatchObject({
      command_type: 'sales.sale.record',
      aggregate_type: 'SALE',
      captured_offline: true,
      local_flags: ['PAPER_SLIP', 'SLIP_TYPE:BV', 'PAPER_REF:BV-000142', 'SLIP_AMOUNT:14000'],
      payload: {
        fromLocationId: IDS.pos,
        localRef: 'BV-000142',
        channelCode: 'POINT_DE_VENTE',
        lines: [{ productId: IDS.chicken, quantity: 4, quantityBase: 4, unitPriceXaf: 3500 }],
        payments: [{ methodCode: 'ESPECES', amountXaf: 14_000 }],
      },
    });
    // Aucune clé inventée par l'ancienne correspondance.
    expect(row?.payload).not.toHaveProperty('paperSlipRef');
    expect(row?.payload).not.toHaveProperty('items');
    // Le formulaire est prêt pour la pièce suivante : numéro vidé, emplacement gardé.
    expect(screen.getByLabelText(/Numéro de la pièce/i)).toHaveValue('');
    expect(screen.getByLabelText('Emplacement de vente')).toHaveValue(IDS.pos);
  });

  it('BD : la dépense (catégorie, site, compte payeur) est mise en file comme finance.expense.record', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type de pièce'), 'BD');
    await user.type(screen.getByLabelText(/Numéro de la pièce/i), 'BD-000055');
    await user.selectOptions(screen.getByLabelText('Catégorie de dépense'), EXPENSE_IDS.transport);
    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    await user.type(screen.getByLabelText('Montant décaissé (XAF)'), '12500');
    await user.selectOptions(screen.getByLabelText('Compte payeur'), POS_CASH_ACCOUNT);
    await user.type(screen.getByLabelText('Objet de la dépense'), 'Achat ampoules');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    expect(await screen.findByText(/BD-000055 enregistrée/)).toBeInTheDocument();
    const [row] = await getDb().outbox.toArray();
    expect(row).toMatchObject({
      command_type: 'finance.expense.record',
      aggregate_type: 'EXPENSE',
      captured_offline: true,
      payload: {
        categoryId: EXPENSE_IDS.transport,
        siteId: IDS.site,
        amountXaf: 12_500,
        description: 'Achat ampoules',
        paidNow: true,
        paidFromAccountId: POS_CASH_ACCOUNT,
        localRef: 'BD-000055',
      },
    });
  });

  it('la photo de la souche n’est proposée que là où le serveur la rattache (AV-504)', async () => {
    const user = userEvent.setup();
    renderScreen();
    // Vente : aucun propriétaire de pièce jointe côté serveur.
    expect(
      await screen.findByText(/ne peut pas encore être rattachée à ce type de pièce/),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type de pièce'), 'BD');
    expect(screen.queryByText(/ne peut pas encore être rattachée à ce type de pièce/)).toBeNull();
    expect(screen.getByLabelText('Prendre une photo')).toBeInTheDocument();
  });
});
