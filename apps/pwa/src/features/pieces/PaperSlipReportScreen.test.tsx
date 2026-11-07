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
import { getDb, type Projection } from '../../storage/db.js';
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

const SUPPLIER = '01900000-0000-7000-8000-000000000120';

/** Une ligne de référentiel telle que le serveur la sert. */
const projection = (
  dataset: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
): Projection => ({
  key: `${dataset}:${entityType}:${entityId}`,
  dataset,
  entity_type: entityType,
  entity_id: entityId,
  scope_type: 'GLOBAL',
  scope_id: null,
  seq: 1,
  row_version: 1,
  data,
});

/** Œufs achetables et un fournisseur : de quoi reporter un bon de commande. */
const purchasingRows = (): Projection[] => [
  projection('procurement', 'SUPPLIER', SUPPLIER, {
    id: SUPPLIER,
    code: 'F-LIT',
    name: 'Provenderie',
  }),
  projection('product', 'PRODUCT', IDS.eggs, {
    id: IDS.eggs,
    code: 'OEUF',
    name: 'Œufs de table',
    category_id: IDS.zone,
    base_unit_code: 'U',
    stock_family: 'MARCHANDISE',
    is_sellable: true,
    is_purchasable: true,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
  }),
];

const LOT = '01900000-0000-7000-8000-000000000140';
const BUILDING = '01900000-0000-7000-8000-000000000141';
const FEED = '01900000-0000-7000-8000-000000000142';

/** Un lot actif, son bâtiment et un aliment consommable : de quoi reporter une fiche de suivi de lot. */
const lotSheetRows = (): Projection[] => [
  projection('location', 'LOCATION', BUILDING, {
    id: BUILDING,
    site_id: IDS.site,
    code: 'FERME-B1',
    name: 'Bâtiment 1',
    location_type: 'BUILDING',
    is_virtual: false,
    custody_mode: null,
    custodian_user_id: null,
    designated_device_id: null,
    status: 'ACTIVE',
  }),
  projection('production', 'PRODUCTION_LOT', LOT, {
    id: LOT,
    lot_code: 'LOT-CH-001',
    lot_type: 'POULET_CHAIR',
    product_id: IDS.chicken,
    stock_lot_id: '01900000-0000-7000-8000-000000000146',
    site_id: IDS.site,
    main_location_id: BUILDING,
    strain: null,
    status: 'ACTIVE',
    start_date: '2026-10-01',
    planned_end_date: null,
    initial_quantity: 500,
    occurred_at: '2026-10-01T08:00:00.000Z',
  }),
  projection('product', 'PRODUCT', FEED, {
    id: FEED,
    code: 'PROV-CH',
    name: 'Provende chair',
    category_id: IDS.zone,
    base_unit_code: 'KG',
    stock_family: 'INTRANT',
    is_sellable: false,
    is_purchasable: true,
    is_consumable: true,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
  }),
];

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

  it('les quatorze types sont proposés, FA, FJC et JE ne le sont pas (documents dérivés)', async () => {
    renderScreen();
    const select = await screen.findByLabelText('Type de pièce');
    const labels = Array.from(select.querySelectorAll('option')).map(
      (option) => option.textContent,
    );
    expect(labels).toHaveLength(14);
    for (const code of ['DA', 'BC', 'VC', 'FI', 'FL']) {
      expect(
        labels.some((label) => label?.startsWith(`${code} —`)),
        code,
      ).toBe(true);
    }
    for (const code of ['FA', 'FJC', 'JE']) {
      expect(
        labels.some((label) => label?.startsWith(`${code} —`)),
        code,
      ).toBe(false);
    }
  });

  it('BC : le bon de commande est mis en file en deux commandes, création puis soumission, la seconde attend la première', async () => {
    await getDb().projections.bulkPut(purchasingRows());
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type de pièce'), 'BC');
    await user.type(screen.getByLabelText(/Numéro de la pièce/i), 'BC-000031');
    await user.selectOptions(screen.getByLabelText('Fournisseur'), SUPPLIER);
    await user.selectOptions(screen.getByLabelText('Emplacement de livraison'), IDS.pos);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText(/^Quantité/), '300');
    await user.type(screen.getByLabelText('Prix unitaire du bon (XAF)'), '85');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    expect(await screen.findByText(/BC-000031 enregistrée/)).toBeInTheDocument();
    const rows = await getDb().outbox.orderBy('device_seq').toArray();
    expect(rows.map((row) => row.command_type)).toEqual([
      'procurement.order.create',
      'procurement.order.submit',
    ]);
    expect(rows[0]).toMatchObject({
      aggregate_type: 'PURCHASE_ORDER',
      captured_offline: true,
      payload: {
        supplierId: SUPPLIER,
        deliveryLocationId: IDS.pos,
        lines: [{ productId: IDS.eggs, unitCode: 'U', orderedQtyBase: 300, unitPriceXaf: 85 }],
        localRef: 'BC-000031',
      },
    });
    expect(rows[1]!.aggregate_id).toBe(rows[0]!.aggregate_id);
    expect(rows[1]!.depends_on).toEqual([rows[0]!.command_id]);
    // Seule la première commande porte les indices du registre des carnets.
    expect(rows[0]!.local_flags).toContain('PAPER_SLIP');
    expect(rows[1]!.local_flags ?? []).toEqual([]);
  });

  it('FI : la fiche d’inventaire est mise en file en trois commandes, chacune dépendant de la précédente', async () => {
    await getDb().projections.bulkPut(purchasingRows());
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type de pièce'), 'FI');
    await user.type(screen.getByLabelText(/Numéro de la pièce/i), 'FI-000004');
    await user.selectOptions(screen.getByLabelText('Emplacement compté'), IDS.pos);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText(/^Quantité/), '118');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    expect(await screen.findByText(/FI-000004 enregistrée/)).toBeInTheDocument();
    const rows = await getDb().outbox.orderBy('device_seq').toArray();
    expect(rows.map((row) => row.command_type)).toEqual([
      'inventory.count.open',
      'inventory.count.record_lines',
      'inventory.count.submit',
    ]);
    expect(rows[0]).toMatchObject({
      aggregate_type: 'INVENTORY_COUNT',
      payload: { locationId: IDS.pos, countType: 'PARTIAL', localRef: 'FI-000004' },
    });
    expect(rows[1]!.depends_on).toEqual([rows[0]!.command_id]);
    expect(rows[2]!.depends_on).toEqual([rows[1]!.command_id]);
    expect(rows[1]).toMatchObject({
      payload: {
        countId: rows[0]!.aggregate_id,
        lines: [{ productId: IDS.eggs, countedQtyBase: 118 }],
      },
    });
  });

  it('FL : chaque mesure d’une ligne est une saisie du jour du lot, indépendante des autres', async () => {
    await getDb().projections.bulkPut(lotSheetRows());
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type de pièce'), 'FL');
    await user.type(screen.getByLabelText(/Numéro de la pièce/i), 'FL-000012');
    await user.selectOptions(await screen.findByLabelText('Lot de production'), LOT);
    // Le bâtiment est celui du lot ; le magasin d'aliment se choisit.
    expect(screen.getByLabelText(/Bâtiment \/ case/)).toHaveValue(BUILDING);
    await user.selectOptions(screen.getByLabelText(/Magasin d’aliment/), IDS.pos);
    await user.type(screen.getByLabelText(/Mortalité : nombre/), '3');
    await user.selectOptions(screen.getByLabelText(/Aliment : produit/), FEED);
    await user.type(screen.getByLabelText(/Aliment : quantité/), '45');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le report' }));

    expect(await screen.findByText(/FL-000012 enregistrée/)).toBeInTheDocument();
    const rows = await getDb().outbox.orderBy('device_seq').toArray();
    expect(rows.map((row) => row.command_type)).toEqual([
      'production.mortality.record',
      'production.input.record',
    ]);
    expect(rows[0]).toMatchObject({
      aggregate_type: 'STOCK_LOSS',
      captured_offline: true,
      payload: { productionLotId: LOT, locationId: BUILDING, quantity: 3 },
    });
    expect(rows[1]).toMatchObject({
      aggregate_type: 'CONSUMPTION',
      payload: {
        productionLotId: LOT,
        locationId: IDS.pos,
        productId: FEED,
        quantityBase: 45,
        unitCode: 'KG',
        costType: 'ALIMENT',
      },
    });
    // Deux écritures distinctes, sans dépendance de l'une envers l'autre ; seule la première porte les indices.
    expect(new Set(rows.map((row) => row.aggregate_id)).size).toBe(2);
    expect(rows.every((row) => (row.depends_on ?? []).length === 0)).toBe(true);
    expect(rows[0]!.local_flags).toContain('SLIP_TYPE:FL');
    expect(rows[1]!.local_flags ?? []).toEqual([]);
  });

  it('FL : une ligne se retire, un jour se rajoute (sept au plus), le jour proposé suit le précédent', async () => {
    await getDb().projections.bulkPut(lotSheetRows());
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type de pièce'), 'FL');
    expect(screen.getAllByLabelText('Jour')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retirer la ligne' })).toBeNull();
    for (let i = 0; i < 6; i++) {
      await user.click(screen.getByRole('button', { name: 'Ajouter un jour' }));
    }
    expect(screen.getAllByLabelText('Jour')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: 'Ajouter un jour' })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Retirer la ligne' })[0]!);
    expect(screen.getAllByLabelText('Jour')).toHaveLength(6);
    // Les œufs ne sont pas sur cette fiche : l'écran renvoie vers la collecte d'œufs.
    expect(screen.getByText(/Collecte d’œufs/)).toBeInTheDocument();
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
