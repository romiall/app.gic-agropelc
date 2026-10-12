import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import type { StockTransferData } from '../sales/types.js';
import { lotsAt } from './transfer.js';
import { TransferScreen } from './TransferScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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

const DEVICE = '01900000-0000-7000-8000-0000000000d0';
const OTHER_DEVICE = '01900000-0000-7000-8000-0000000000d2';
const OTHER_USER = '01900000-0000-7000-8000-0000000000e9';
const REJECTED_DISPATCH = '01900000-0000-7000-8000-0000000000d1';

const STORE = IDS.mobile;
const REQUEST = '01900000-0000-7000-8000-0000000000c9';
const REQUEST_LINE = '01900000-0000-7000-8000-0000000000ca';
const OTHER_SITE_STORE = '01900000-0000-7000-8000-0000000000cb';
const PAUL_MOBILE = '01900000-0000-7000-8000-0000000000cd';
const LOT_1 = '01900000-0000-7000-8000-0000000000ce';
const LOT_2 = '01900000-0000-7000-8000-0000000000cf';

/** Navigation dans l'historique du routeur de test. */
function History() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => void navigate(-1)}>
        Retour arrière
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        Page suivante
      </button>
    </>
  );
}

function renderAt(
  path: string,
  entries: readonly (string | { pathname: string; state: unknown })[] = [path],
) {
  return render(
    <MemoryRouter initialEntries={[...entries]} initialIndex={entries.length - 1}>
      <History />
      <Routes>
        <Route path="/stock/transferts" element={<TransferScreen key="liste" />} />
        <Route path="/stock/transferts/:transferId" element={<TransferScreen key="detail" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Demande de transfert relue avec d'autres valeurs (statut, unité de saisie). */
async function setRequest(patch: Partial<StockTransferData>) {
  const db = getDb();
  const key = `transfers:STOCK_TRANSFER:${REQUEST}`;
  const row = await db.projections.get(key);
  if (!row) throw new Error('demande absente');
  await db.projections.put({
    ...row,
    data: { ...(row.data as unknown as StockTransferData), ...patch },
  });
}

/** Expédition de la demande refusée par le serveur (demande plus à expédier, S-40). */
async function addRejectedDispatch(commandId = REJECTED_DISPATCH, seq = 1) {
  await getDb().outbox.add({
    command_id: commandId,
    device_seq: seq,
    command_type: 'inventory.transfer.dispatch',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'STOCK_TRANSFER',
    aggregate_id: REQUEST,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      transferId: REQUEST,
      lines: [
        {
          transferLineId: REQUEST_LINE,
          productId: IDS.eggs,
          unitCode: 'PLATEAU',
          quantityBase: 60,
        },
      ],
    },
    status: 'REJECTED',
    attempts: 1,
    next_attempt_at: null,
    last_error: {
      code: 'TRANSFER_STATUS_INVALID',
      message_fr: 'Le transfert doit être au statut REQUESTED.',
    },
    server_refs: null,
  });
}

/** Emplacement du site principal, sous la garde donnée. */
function siteLocation(
  id: string,
  name: string,
  custody: { mode: string; user?: string; device?: string },
) {
  return {
    key: `location:LOCATION:${id}`,
    dataset: 'location',
    entity_type: 'LOCATION',
    entity_id: id,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: {
      id,
      site_id: IDS.site,
      code: id.slice(-4),
      name,
      location_type: 'STORE',
      is_virtual: false,
      custody_mode: custody.mode,
      custodian_user_id: custody.user ?? null,
      designated_device_id: custody.device ?? null,
      status: 'ACTIVE',
    },
  };
}

/** Œufs du PDV répartis en lots. */
function eggLots(lots: { id: string; code: string; qty: string }[]) {
  const total = lots.reduce((sum, lot) => sum + Number(lot.qty), 0);
  return {
    key: `stock:STOCK_BALANCE:${IDS.pos}:${IDS.eggs}`,
    dataset: 'stock',
    entity_type: 'STOCK_BALANCE',
    entity_id: IDS.eggs,
    scope_type: 'LOCATION',
    scope_id: IDS.pos,
    row_version: 1,
    seq: 1,
    data: {
      id: IDS.eggs,
      location_id: IDS.pos,
      product_id: IDS.eggs,
      qty_on_hand: String(total),
      qty_reserved: '0',
      qty_allocated: '0',
      lots: lots.map((lot) => ({ lot_id: lot.id, lot_code: lot.code, qty_on_hand: lot.qty })),
    },
  };
}

describe('Transférer (ECR-STK-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      {
        key: `location:LOCATION:${STORE}`,
        dataset: 'location',
        entity_type: 'LOCATION',
        entity_id: STORE,
        scope_type: 'GLOBAL',
        scope_id: null,
        row_version: 1,
        seq: 1,
        data: {
          id: STORE,
          site_id: IDS.site,
          code: 'MAG-YDE',
          name: 'Magasin central',
          location_type: 'STORE',
          is_virtual: false,
          custody_mode: 'SHARED',
          custodian_user_id: null,
          designated_device_id: null,
          status: 'ACTIVE',
        },
      },
      {
        key: `transfers:STOCK_TRANSFER:${REQUEST}`,
        dataset: 'transfers',
        entity_type: 'STOCK_TRANSFER',
        entity_id: REQUEST,
        scope_type: 'LOCATION',
        scope_id: IDS.pos,
        row_version: 1,
        seq: 1,
        data: {
          id: REQUEST,
          doc_number: 'TRF-2026-000012',
          transfer_kind: 'STANDARD',
          from_location_id: IDS.pos,
          to_location_id: STORE,
          status: 'REQUESTED',
          dispatched_at: null,
          carrier_name: null,
          notes: null,
          occurred_at: '2026-10-10T07:00:00.000Z',
          version: 1,
          lines: [
            {
              id: REQUEST_LINE,
              product_id: IDS.eggs,
              lot_id: null,
              unit_code: 'U',
              requested_qty_base: '60.000',
              dispatched_qty_base: null,
              received_qty_base: null,
            },
          ],
        },
      },
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : expédition directe en conditionnement, convertie, retirée aussitôt du disponible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.selectOptions(await screen.findByLabelText('Vers'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '2');
    await user.selectOptions(within(line).getByLabelText('Unité'), 'PLATEAU');
    await user.type(screen.getByLabelText('Transporteur (facultatif)'), 'Paul');
    await user.click(screen.getByRole('button', { name: 'Expédier' }));
    expect(await screen.findByText(/Expédition enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.dispatch',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: IDS.pos,
        toLocationId: STORE,
        lines: [{ productId: IDS.eggs, unitCode: 'PLATEAU', quantityBase: 60 }],
        carrierName: 'Paul',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(60);
  });

  it('en ligne : quantité supérieure au disponible bloquée', async () => {
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.selectOptions(await screen.findByLabelText('Vers'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(line).getByLabelText('Quantité'), '5');
    expect(screen.getByRole('alert')).toHaveTextContent(/Poulet de chair/);
    expect(screen.getByRole('button', { name: 'Expédier' })).toBeDisabled();
  });

  it('demande reçue : quantités préremplies, expédition partielle, demande signalée en attente', async () => {
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.click(
      await screen.findByRole('link', { name: 'Expédier la demande TRF-2026-000012' }),
    );
    const quantity = await screen.findByLabelText('Expédié (U)');
    expect(quantity).toHaveValue('60');
    await user.clear(quantity);
    await user.type(quantity, '50');
    await user.click(screen.getByRole('button', { name: 'Expédier la demande' }));
    expect(
      await screen.findByText(/Expédition en cours d’envoi|Expédition enregistrée/),
    ).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.dispatch',
      aggregate_id: REQUEST,
      payload: {
        transferId: REQUEST,
        lines: [
          { transferLineId: REQUEST_LINE, productId: IDS.eggs, unitCode: 'U', quantityBase: 50 },
        ],
      },
    });
    await user.click(screen.getByRole('link', { name: 'Autre expédition' }));
    expect(await screen.findByText('Expédition en attente d’envoi')).toBeInTheDocument();
  });

  it('demande reçue refusée en ligne avec un motif exigé, puis signalée en attente sans nouvelle expédition', async () => {
    const user = userEvent.setup();
    renderAt(`/stock/transferts/${REQUEST}`);
    await user.click(await screen.findByRole('button', { name: 'Refuser la demande' }));
    // Focus porté sur le motif, exigé avant de confirmer.
    const motif = screen.getByLabelText('Motif du refus');
    expect(motif).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Confirmer le refus' });
    expect(confirm).toBeDisabled();
    // « Ne pas refuser » rend le focus au bouton d'ouverture.
    await user.click(screen.getByRole('button', { name: 'Ne pas refuser' }));
    expect(screen.getByRole('button', { name: 'Refuser la demande' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Refuser la demande' }));
    await user.type(screen.getByLabelText('Motif du refus'), '  Rupture au PDV ');
    await user.click(screen.getByRole('button', { name: 'Confirmer le refus' }));
    expect(await screen.findByText(/Refus (en cours d’envoi|enregistré)/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.decline',
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: REQUEST,
      payload: { transferId: REQUEST, comment: 'Rupture au PDV' },
    });
    // Rien ne quitte le disponible pour un refus.
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBeUndefined();
    await user.click(screen.getByRole('link', { name: 'Autre expédition' }));
    expect(await screen.findByText('Refus en attente d’envoi')).toBeInTheDocument();
    cleanup();
    renderAt(`/stock/transferts/${REQUEST}`);
    expect(await screen.findByText(/déjà refusée depuis ce téléphone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expédier la demande' })).not.toBeInTheDocument();
  });

  it('hors ligne : refus d’une demande indisponible (décision en ligne)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderAt(`/stock/transferts/${REQUEST}`);
    const decline = await screen.findByRole('button', { name: 'Refuser la demande' });
    expect(decline).toBeDisabled();
    expect(decline).toHaveAccessibleDescription(/Le refus d’une demande se fait en ligne/);
  });

  it('expédition hors ligne refusée après avoir quitté le résultat : retrouvée, ressaisie en unité de base, préremplissage consommé', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const request = (await getDb().projections.get(`transfers:STOCK_TRANSFER:${REQUEST}`))
      ?.data as unknown as StockTransferData;
    // Demande saisie en plateaux : 2 PLATEAU, soit 60 œufs en unité de base.
    await setRequest({ lines: request.lines.map((line) => ({ ...line, unit_code: 'PLATEAU' })) });
    const user = userEvent.setup();
    renderAt(`/stock/transferts/${REQUEST}`);
    await user.click(await screen.findByRole('button', { name: 'Expédier la demande' }));
    await screen.findByText(/Expédition enregistrée sur ce téléphone/);
    const [sent] = await getDb().outbox.toArray();
    expect(sent?.payload).toMatchObject({ lines: [{ unitCode: 'PLATEAU', quantityBase: 60 }] });

    // L'utilisateur a quitté l'écran ; au retour du réseau le serveur refuse, la demande est relue
    // refusée.
    cleanup();
    await getDb().outbox.update(sent?.command_id as string, {
      status: 'REJECTED',
      last_error: {
        code: 'TRANSFER_STATUS_INVALID',
        message_fr: 'Le transfert doit être au statut REQUESTED.',
      },
    });
    await setRequest({ status: 'DECLINED' });
    renderAt('/stock/transferts');
    expect(
      await screen.findByRole('listitem', { name: 'Expédition non acceptée TRF-2026-000012' }),
    ).toHaveTextContent(/refusée ou annulée avant votre expédition/);
    // La fiche de la demande la propose aussi, au lieu de « plus à expédier ».
    cleanup();
    renderAt(`/stock/transferts/${REQUEST}`);
    const card = await screen.findByRole('listitem', {
      name: 'Expédition non acceptée TRF-2026-000012',
    });
    expect(screen.queryByText(/n’est plus à expédier/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Ressaisir en expédition directe' }));
    expect(await screen.findByText(/quantités en unité de base/)).toBeInTheDocument();
    expect(screen.getByLabelText('Vers')).toHaveValue(STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    expect(within(line).getByLabelText('Produit')).toHaveValue(IDS.eggs);
    expect(within(line).getByLabelText('Quantité')).toHaveValue('60');
    // Rien en mode « Déplacer » : la mention ne s'y affiche pas.
    await user.click(screen.getByRole('radio', { name: 'Déplacer dans le même site' }));
    expect(screen.queryByText(/quantités en unité de base/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Expédier vers un autre emplacement' }));
    await user.click(screen.getByRole('button', { name: 'Expédier' }));
    await screen.findByText(/Expédition enregistrée sur ce téléphone/);

    const direct = (await getDb().outbox.toArray()).find(
      (command) => command.command_id !== sent?.command_id,
    );
    // 60 œufs, et non 60 plateaux.
    expect(direct?.payload).toMatchObject({
      fromLocationId: IDS.pos,
      toLocationId: STORE,
      lines: [{ productId: IDS.eggs, unitCode: 'U', quantityBase: 60 }],
    });
    expect((await getDb().outbox.get(sent?.command_id as string))?.local_flags).toEqual([
      'REENTERED',
    ]);
    // Le préremplissage est consommé : revenir sur l'entrée de l'envoi ne le repropose pas, et
    // l'expédition refusée n'est plus proposée.
    await user.click(screen.getByRole('button', { name: 'Retour arrière' }));
    expect(await screen.findByText(/n’est plus à expédier/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Page suivante' }));
    const fresh = await screen.findByRole('listitem', { name: 'Ligne 1' });
    expect(within(fresh).getByLabelText('Quantité')).toHaveValue('');
    expect(screen.queryByText(/quantités en unité de base/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('listitem', { name: /Expédition non acceptée/ }),
    ).not.toBeInTheDocument();
  });

  it('expédition refusée : demande non relue en attente, déjà expédiée ailleurs ressaisie sur confirmation, puis ignorée', async () => {
    await addRejectedDispatch();
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    const name = 'Expédition non acceptée TRF-2026-000012';
    // Demande encore « à expédier » sur l'appareil : attendre la relecture, pas de ressaisie.
    let card = await screen.findByRole('listitem', { name });
    expect(card).toHaveTextContent(/paraît encore à expédier/);
    expect(
      within(card).queryByRole('button', { name: 'Ressaisir en expédition directe' }),
    ).not.toBeInTheDocument();
    // Relue expédiée depuis un autre appareil : ressaisie seulement après confirmation.
    await setRequest({ status: 'DISPATCHED' });
    await waitFor(() =>
      expect(screen.getByRole('listitem', { name })).toHaveTextContent(
        /déjà été expédiée depuis un autre appareil/,
      ),
    );
    card = screen.getByRole('listitem', { name });
    const reenter = within(card).getByRole('button', { name: 'Ressaisir en expédition directe' });
    expect(reenter).toBeDisabled();
    await user.click(within(card).getByLabelText('Une seconde expédition a réellement eu lieu'));
    expect(reenter).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: 'Ignorer' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name })).not.toBeInTheDocument());
    expect((await getDb().outbox.get(REJECTED_DISPATCH))?.local_flags).toEqual(['DISMISSED']);
  });

  it('mouvement interne : jamais le stock d’un autre détenteur ; lot désigné quand la source en a plusieurs', async () => {
    const db = getDb();
    await db.projections.bulkPut([
      {
        key: `location:LOCATION:${PAUL_MOBILE}`,
        dataset: 'location',
        entity_type: 'LOCATION',
        entity_id: PAUL_MOBILE,
        scope_type: 'GLOBAL',
        scope_id: null,
        row_version: 1,
        seq: 1,
        data: {
          id: PAUL_MOBILE,
          site_id: IDS.site,
          code: 'MOB-PAUL',
          name: 'Stock mobile de Paul',
          location_type: 'MOBILE',
          is_virtual: false,
          custody_mode: 'EXCLUSIVE_USER',
          custodian_user_id: OTHER_USER,
          designated_device_id: null,
          status: 'ACTIVE',
        },
      },
      siteLocation('01900000-0000-7000-8000-0000000000d3', 'Magasin de Jean', {
        mode: 'EXCLUSIVE_USER',
        user: OTHER_USER,
      }),
      siteLocation('01900000-0000-7000-8000-0000000000d4', 'Chambre de ce téléphone', {
        mode: 'EXCLUSIVE_DEVICE',
        device: DEVICE,
      }),
      siteLocation('01900000-0000-7000-8000-0000000000d5', 'Chambre d’un autre téléphone', {
        mode: 'EXCLUSIVE_DEVICE',
        device: OTHER_DEVICE,
      }),
      {
        key: `stock:STOCK_BALANCE:${PAUL_MOBILE}:${IDS.eggs}`,
        dataset: 'stock',
        entity_type: 'STOCK_BALANCE',
        entity_id: IDS.eggs,
        scope_type: 'LOCATION',
        scope_id: PAUL_MOBILE,
        row_version: 1,
        seq: 1,
        data: {
          id: IDS.eggs,
          location_id: PAUL_MOBILE,
          product_id: IDS.eggs,
          qty_on_hand: '90',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [],
        },
      },
      {
        key: `stock:STOCK_BALANCE:${IDS.pos}:${IDS.eggs}`,
        dataset: 'stock',
        entity_type: 'STOCK_BALANCE',
        entity_id: IDS.eggs,
        scope_type: 'LOCATION',
        scope_id: IDS.pos,
        row_version: 1,
        seq: 1,
        data: {
          id: IDS.eggs,
          location_id: IDS.pos,
          product_id: IDS.eggs,
          qty_on_hand: '300',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [
            { lot_id: LOT_1, lot_code: 'COL-1', qty_on_hand: '200' },
            { lot_id: LOT_2, lot_code: 'COL-2', qty_on_hand: '100' },
          ],
        },
      },
    ]);
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.click(await screen.findByRole('radio', { name: 'Déplacer dans le même site' }));
    for (const field of ['Depuis', 'Vers']) {
      for (const other of [
        'Stock mobile de Paul',
        'Magasin de Jean',
        'Chambre d’un autre téléphone',
      ]) {
        expect(
          within(screen.getByLabelText(field)).queryByRole('option', { name: other }),
        ).not.toBeInTheDocument();
      }
    }
    // Emplacement désigné pour ce téléphone : proposé.
    expect(
      within(screen.getByLabelText('Vers')).getByRole('option', {
        name: 'Chambre de ce téléphone',
      }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Vers'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '150');
    const lotField = within(line).getByLabelText('Lot déplacé');
    expect(lotField).toHaveAttribute('aria-invalid', 'true');
    expect(lotField).toHaveAccessibleDescription(/choisissez le lot déplacé/);
    // Solde du lot en unité de base.
    expect(within(lotField).getByRole('option', { name: 'COL-1 (200 U)' })).toBeInTheDocument();
    const move = screen.getByRole('button', { name: 'Déplacer' });
    expect(move).toBeDisabled();
    // Lot de 100 : 150 dépasse son solde (bloqué en ligne) ; lot de 200 : admis.
    await user.selectOptions(within(line).getByLabelText('Lot déplacé'), LOT_2);
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait le mouvement/);
    expect(move).toBeDisabled();
    await user.selectOptions(within(line).getByLabelText('Lot déplacé'), LOT_1);
    await waitFor(() => expect(move).toBeEnabled());
    expect(lotField).toHaveAttribute('aria-invalid', 'false');
    await user.click(move);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command?.payload).toMatchObject({
      lines: [{ productId: IDS.eggs, quantityBase: 150, lotId: LOT_1 }],
    });
  });

  it('mouvement interne : lot oublié au changement de produit, totaux par lot en millièmes', async () => {
    await getDb().projections.put(
      eggLots([
        { id: LOT_1, code: 'COL-1', qty: '3.3' },
        { id: LOT_2, code: 'COL-2', qty: '1' },
      ]),
    );
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.click(await screen.findByRole('radio', { name: 'Déplacer dans le même site' }));
    await user.selectOptions(screen.getByLabelText('Vers'), STORE);
    // 1,1 + 2,2 sur le lot de 3,3 : admis (pas de faux dépassement en flottants).
    let line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '1.1');
    await user.selectOptions(within(line).getByLabelText('Lot déplacé'), LOT_1);
    await user.click(screen.getByRole('button', { name: /Ajouter une ligne/ }));
    const second = screen.getByRole('listitem', { name: 'Ligne 2' });
    await user.selectOptions(within(second).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(second).getByLabelText('Quantité'), '2.2');
    await user.selectOptions(within(second).getByLabelText('Lot déplacé'), LOT_1);
    const move = screen.getByRole('button', { name: 'Déplacer' });
    await waitFor(() => expect(move).toBeEnabled());
    expect(screen.queryByText(/le serveur refuserait le mouvement/)).not.toBeInTheDocument();
    // Changement de produit après la désignation du lot : le lot n'est plus envoyé.
    await user.click(screen.getByRole('button', { name: 'Retirer la ligne 2' }));
    line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.clear(within(line).getByLabelText('Quantité'));
    await user.type(within(line).getByLabelText('Quantité'), '2');
    await waitFor(() => expect(move).toBeEnabled());
    await user.click(move);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    const [sentLine] = (command?.payload as { lines: object[] }).lines;
    expect(sentLine).toMatchObject({ productId: IDS.chicken, quantityBase: 2 });
    expect(sentLine).not.toHaveProperty('lotId');
  });

  it('lots désignables : bornés par le disponible du produit, prudence pour les sorties sans lot', async () => {
    await getDb().projections.put(
      eggLots([
        { id: LOT_1, code: 'COL-1', qty: '200' },
        { id: LOT_2, code: 'COL-2', qty: '100' },
      ]),
    );
    const refs = await loadSalesReferences(getDb());
    // Vente de 250 œufs sans lot en attente : le serveur la prendra au plus ancien.
    const withSale = {
      ...refs,
      pending: new Map([[`${IDS.pos}:${IDS.eggs}`, 250]]),
      pendingOut: new Map([[`${IDS.pos}:${IDS.eggs}`, 250]]),
    };
    expect(lotsAt(withSale, IDS.pos, IDS.eggs)).toEqual([
      { lotId: LOT_1, lotCode: 'COL-1', quantity: 50, cautious: 0 },
      { lotId: LOT_2, lotCode: 'COL-2', quantity: 50, cautious: 0 },
    ]);
    expect(lotsAt(refs, IDS.pos, IDS.eggs)).toEqual([
      { lotId: LOT_1, lotCode: 'COL-1', quantity: 200, cautious: 200 },
      { lotId: LOT_2, lotCode: 'COL-2', quantity: 100, cautious: 100 },
    ]);
    // 8 œufs de COL-1 désignés et 5 sans lot en attente : COL-2 garde au pire 100 − 5 = 95 (les
    // sorties sans lot ne se retranchent qu'une fois du disponible du produit).
    const mixed = {
      ...refs,
      pending: new Map([[`${IDS.pos}:${IDS.eggs}`, 13]]),
      pendingOut: new Map([[`${IDS.pos}:${IDS.eggs}`, 13]]),
      pendingLots: new Map([[`${IDS.pos}:${IDS.eggs}:${LOT_1}`, 8]]),
    };
    expect(lotsAt(mixed, IDS.pos, IDS.eggs)).toEqual([
      { lotId: LOT_1, lotCode: 'COL-1', quantity: 192, cautious: 187 },
      { lotId: LOT_2, lotCode: 'COL-2', quantity: 100, cautious: 95 },
    ]);
  });

  it('préremplissage resté dans une entrée d’historique plus ancienne : pas repris une fois ressaisi', async () => {
    await addRejectedDispatch();
    await setRequest({ status: 'DECLINED' });
    await getDb().outbox.update(REJECTED_DISPATCH, { local_flags: ['REENTERED'] });
    const prefill = {
      fromLocationId: IDS.pos,
      toLocationId: STORE,
      lines: [{ productId: IDS.eggs, quantityBase: 60 }],
      originCommandIds: [REJECTED_DISPATCH],
    };
    const user = userEvent.setup();
    // Entrée plus ancienne qui porte le préremplissage, puis la page courante.
    renderAt('/stock/transferts', [
      { pathname: '/stock/transferts', state: { prefill } },
      '/stock/transferts/autre',
    ]);
    await screen.findByText(/n’est plus à expédier/);
    await user.click(screen.getByRole('button', { name: 'Retour arrière' }));
    const line = await screen.findByRole('listitem', { name: 'Ligne 1' });
    expect(within(line).getByLabelText('Quantité')).toHaveValue('');
    expect(screen.queryByText(/quantités en unité de base/)).not.toBeInTheDocument();
  });

  it('deux expéditions refusées de la même demande : une seule carte, écartées ensemble ; fiche sans nouvel envoi', async () => {
    const SECOND = '01900000-0000-7000-8000-0000000000d6';
    await addRejectedDispatch();
    await addRejectedDispatch(SECOND, 2);
    const user = userEvent.setup();
    // Demande encore « à expédier » sur l'appareil (relecture en échec) : la fiche n'en propose plus
    // l'expédition, le serveur l'a refusée.
    renderAt(`/stock/transferts/${REQUEST}`);
    expect(
      await screen.findByRole('listitem', { name: 'Expédition non acceptée TRF-2026-000012' }),
    ).toHaveTextContent(/paraît encore à expédier/);
    expect(screen.queryByRole('button', { name: 'Expédier la demande' })).not.toBeInTheDocument();
    cleanup();
    await setRequest({ status: 'DECLINED' });
    renderAt('/stock/transferts');
    const cards = await screen.findAllByRole('listitem', { name: /Expédition non acceptée/ });
    expect(cards).toHaveLength(1);
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Ignorer' }));
    await waitFor(async () => {
      const flags = (await getDb().outbox.bulkGet([REJECTED_DISPATCH, SECOND])).map(
        (command) => command?.local_flags,
      );
      expect(flags).toEqual([['DISMISSED'], ['DISMISSED']]);
    });
  });

  it('hors ligne : mouvement interne vers un emplacement du même site, sortie et entrée aussitôt comptées', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put({
      key: `location:LOCATION:${OTHER_SITE_STORE}`,
      dataset: 'location',
      entity_type: 'LOCATION',
      entity_id: OTHER_SITE_STORE,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: OTHER_SITE_STORE,
        site_id: '01900000-0000-7000-8000-0000000000cc',
        code: 'MAG-DLA',
        name: 'Magasin de Douala',
        location_type: 'STORE',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      },
    });
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    // L'expédition propose aussi les emplacements des autres sites.
    expect(
      within(await screen.findByLabelText('Vers')).getByRole('option', {
        name: 'Magasin de Douala',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Déplacer dans le même site' }));
    expect(screen.getByRole('heading', { name: 'Mouvement interne' })).toBeInTheDocument();
    const destination = screen.getByLabelText('Vers');
    expect(
      within(destination).queryByRole('option', { name: 'Magasin de Douala' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Transporteur (facultatif)')).not.toBeInTheDocument();
    await user.selectOptions(destination, STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '30');
    await user.type(screen.getByLabelText('Note (facultatif)'), 'Rangement');
    await user.click(screen.getByRole('button', { name: 'Déplacer' }));
    expect(await screen.findByText(/Mouvement enregistré sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.move_internal',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: IDS.pos,
        toLocationId: STORE,
        lines: [{ productId: IDS.eggs, unitCode: 'U', quantityBase: 30 }],
        notes: 'Rangement',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(30);
    expect(refs.pending.get(`${STORE}:${IDS.eggs}`)).toBe(-30);
  });
});
