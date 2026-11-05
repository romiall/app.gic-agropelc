import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { LedgerScreen } from './LedgerScreen.js';
import { downloadTextFile } from '../../platform/download.js';
import {
  checkPeriod,
  closingInstant,
  defaultPeriod,
  ledgerCsvColumns,
  ledgerCsvRows,
  ledgerFileName,
  openingInstant,
  type MoveView,
} from './ledger.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/download.js', () => ({ downloadTextFile: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});

const move = (overrides: Partial<MoveView>): MoveView => ({
  id: 'm1',
  productId: IDS.eggs,
  lotId: null,
  direction: 'IN',
  quantity: 50,
  counterpartLocationId: IDS.mobile,
  moveType: 'TRANSFER_RECEIPT',
  reasonCodeId: null,
  unitCostXaf: null,
  valueXaf: null,
  occurredAt: '2026-10-08T09:00:00.000Z',
  businessDate: '2026-10-08',
  recordedAt: '2026-10-08T09:00:01.000Z',
  sourceDocType: 'STOCK_TRANSFER',
  sourceDocId: 't1',
  isReversal: false,
  capturedOffline: false,
  ...overrides,
});

const FIRST = [
  move({}),
  move({
    id: 'm2',
    direction: 'OUT',
    quantity: 30,
    moveType: 'SALE',
    counterpartLocationId: 'virtuel-inconnu',
    capturedOffline: true,
    occurredAt: '2026-10-09T10:00:00.000Z',
  }),
];
const SECOND = [
  move({
    id: 'm3',
    productId: IDS.chicken,
    direction: 'OUT',
    quantity: 2,
    moveType: 'LOSS',
    occurredAt: '2026-10-10T07:00:00.000Z',
  }),
];

function answer(path: string, closing: number) {
  const url = new URL(path, 'http://local');
  if (url.pathname === '/api/v1/stock/at') {
    const quantity = url.searchParams.get('at') === openingInstant('2026-10-04') ? 100 : closing;
    return {
      ok: true,
      data: { balances: [{ productId: IDS.eggs, lotId: null, qtyOnHand: quantity }] },
    };
  }
  const productId = url.searchParams.get('product_id');
  if (url.searchParams.get('cursor') === 'page-2') {
    return { ok: true, data: { moves: SECOND, next_cursor: null } };
  }
  if (productId) {
    return {
      ok: true,
      data: { moves: FIRST.filter((m) => m.productId === productId), next_cursor: null },
    };
  }
  return { ok: true, data: { moves: FIRST, next_cursor: 'page-2' } };
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <LedgerScreen />
    </MemoryRouter>,
  );
}

describe('Registre des mouvements (ECR-STK-07)', () => {
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
    vi.mocked(downloadTextFile).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('AV-519 : export CSV — toutes les pages sont lues, sorties signées, sans colonne de valeur sans droit', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    const moves = within(await screen.findByRole('region', { name: 'Mouvements' }));
    await moves.findByRole('listitem', { name: 'Vente' });
    // La page 2 n'est pas affichée : l'export la lit avant de produire le fichier.
    await user.click(moves.getByRole('button', { name: 'Exporter en CSV' }));
    await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('cursor=page-2'),
      { method: 'GET' },
    );
    const [name, text] = vi.mocked(downloadTextFile).mock.calls[0]!;
    expect(name).toBe('registre-stock_comptoir-yaounde_2026-10-04_2026-10-10.csv');
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'Date et heure;Jour métier;Mouvement;Produit;Sens;Quantité (unité de base);Unité;Contrepartie;Lot;Contre-écriture;Saisi hors ligne;Type de pièce;Identifiant de la pièce',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(
      /^2026-10-08 10:00;2026-10-08;Réception de transfert;Œufs de table;Entrée;50;/,
    );
    expect(lines[2]).toMatch(/^2026-10-09 11:00;2026-10-08;Vente;Œufs de table;Sortie;-30;/);
    expect(lines[2]).toMatch(/;oui;STOCK_TRANSFER;t1$/);
    expect(lines[3]).toMatch(/;Perte;Poulet de chair;Sortie;-2;/);
    expect(await moves.findByText('Fichier CSV téléchargé.')).toBeInTheDocument();
  });

  it('AV-519 : un échec de lecture pendant l’export n’écrit aucun fichier et le dit', async () => {
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) =>
      new URL(path, 'http://local').searchParams.get('cursor') === 'page-2'
        ? ({ ok: false, reason: 'NETWORK_ERROR' } as never)
        : (answer(path, 120) as never),
    );
    const user = userEvent.setup();
    renderScreen();
    const moves = within(await screen.findByRole('region', { name: 'Mouvements' }));
    await moves.findByRole('listitem', { name: 'Vente' });
    await user.click(moves.getByRole('button', { name: 'Exporter en CSV' }));
    expect(await moves.findByRole('alert')).toHaveTextContent(/Export interrompu/);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('registre d’un emplacement sur sept jours, page par page', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    const moves = within(await screen.findByRole('region', { name: 'Mouvements' }));
    const sale = await moves.findByRole('listitem', { name: 'Vente' });
    expect(sale).toHaveTextContent(/− 30 U/);
    // Contrepartie virtuelle (absente de l'appareil) nommée d'après le type de mouvement.
    expect(sale).toHaveTextContent(/vers client/);
    expect(sale).toHaveTextContent(/saisi hors ligne/);
    expect(moves.getByRole('listitem', { name: 'Réception de transfert' })).toHaveTextContent(
      /\+ 50 U/,
    );
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/stock-moves?location_id=${IDS.pos}&from=2026-10-04&to=2026-10-10&limit=100`,
      { method: 'GET' },
    );
    await user.click(moves.getByRole('button', { name: 'Afficher la suite' }));
    expect(await moves.findByRole('listitem', { name: 'Perte' })).toHaveTextContent(/− 2 U/);
    expect(moves.queryByRole('button', { name: 'Afficher la suite' })).not.toBeInTheDocument();
  });

  it('produit choisi : soldes au début et à la fin, écart expliqué ou non', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 115) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const explain = within(await screen.findByRole('region', { name: 'Explication de l’écart' }));
    expect(await explain.findByText('Solde au début')).toBeInTheDocument();
    expect(explain.getByText('Solde au début').nextElementSibling).toHaveTextContent('100 U');
    expect(explain.getByText('Entrées').nextElementSibling).toHaveTextContent('+ 50 U');
    expect(explain.getByText('Sorties').nextElementSibling).toHaveTextContent('− 30 U');
    expect(explain.getByText(/Écart non expliqué : [-−]5 U/)).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/stock/at?location_id=${IDS.pos}&at=${encodeURIComponent(closingInstant('2026-10-10'))}&product_id=${IDS.eggs}`,
      { method: 'GET' },
    );
    // Les opérations enregistrées entre-temps sont relues : l'écart disparaît.
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    await user.click(explain.getByRole('button', { name: 'Actualiser' }));
    expect(
      await explain.findByText('Les mouvements listés expliquent tout l’écart.'),
    ).toBeInTheDocument();
    expect(
      within(explain.getByText('Vente').closest('li') as HTMLElement).getByText(/− 30/),
    ).toBeInTheDocument();
    expect(
      within(explain.getByText('Réception de transfert').closest('li') as HTMLElement).getByText(
        /\+ 50/,
      ),
    ).toBeInTheDocument();
  });

  it('soldes lus une fois la liste complète ; échecs relus par « Réessayer »', async () => {
    // Liste du produit en deux pages : les soldes attendent la seconde.
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => {
      const url = new URL(path, 'http://local');
      if (url.pathname === '/api/v1/stock-moves' && url.searchParams.get('product_id')) {
        return (
          url.searchParams.get('cursor') === 'eggs-2'
            ? { ok: true, data: { moves: [FIRST[1]], next_cursor: null } }
            : { ok: true, data: { moves: [FIRST[0]], next_cursor: 'eggs-2' } }
        ) as never;
      }
      return answer(path, 120) as never;
    });
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const moves = within(await screen.findByRole('region', { name: 'Mouvements' }));
    await moves.findByRole('listitem', { name: 'Réception de transfert' });
    const stockAt = () =>
      vi
        .mocked(authorizedRequest)
        .mock.calls.filter(([, path]) => String(path).startsWith('/api/v1/stock/at')).length;
    expect(stockAt()).toBe(0);
    await user.click(moves.getByRole('button', { name: 'Afficher la suite' }));
    const explain = within(screen.getByRole('region', { name: 'Explication de l’écart' }));
    expect(
      await explain.findByText('Les mouvements listés expliquent tout l’écart.'),
    ).toBeInTheDocument();
    expect(stockAt()).toBe(2);

    // Soldes en échec après la seconde page : « Réessayer » relit les soldes seuls.
    cleanup();
    let balancesFail = true;
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => {
      const url = new URL(path, 'http://local');
      if (url.pathname === '/api/v1/stock/at' && balancesFail) {
        return { ok: false, reason: 'HTTP_ERROR', status: 500, body: null } as never;
      }
      if (url.pathname === '/api/v1/stock-moves' && url.searchParams.get('product_id')) {
        return (
          url.searchParams.get('cursor') === 'eggs-2'
            ? { ok: true, data: { moves: [FIRST[1]], next_cursor: null } }
            : { ok: true, data: { moves: [FIRST[0]], next_cursor: 'eggs-2' } }
        ) as never;
      }
      return answer(path, 120) as never;
    });
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const paged = within(await screen.findByRole('region', { name: 'Mouvements' }));
    await paged.findByRole('listitem', { name: 'Réception de transfert' });
    await user.click(paged.getByRole('button', { name: 'Afficher la suite' }));
    const pagedExplain = within(screen.getByRole('region', { name: 'Explication de l’écart' }));
    expect(await pagedExplain.findByText(/Soldes indisponibles/)).toBeInTheDocument();
    const movesReads = () =>
      vi
        .mocked(authorizedRequest)
        .mock.calls.filter(([, path]) => String(path).startsWith('/api/v1/stock-moves')).length;
    const before = movesReads();
    balancesFail = false;
    await user.click(pagedExplain.getByRole('button', { name: 'Réessayer' }));
    expect(
      await pagedExplain.findByText('Les mouvements listés expliquent tout l’écart.'),
    ).toBeInTheDocument();
    expect(movesReads()).toBe(before);

    // Soldes en échec : annoncés, relus par « Réessayer ».
    cleanup();
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) =>
        (String(path).startsWith('/api/v1/stock/at')
          ? { ok: false, reason: 'HTTP_ERROR', status: 403, body: null }
          : answer(path, 120)) as never,
    );
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const failed = within(await screen.findByRole('region', { name: 'Explication de l’écart' }));
    expect(await failed.findByText(/Soldes indisponibles/)).toBeInTheDocument();
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    await user.click(failed.getByRole('button', { name: 'Réessayer' }));
    expect(
      await failed.findByText('Les mouvements listés expliquent tout l’écart.'),
    ).toBeInTheDocument();

    // Mouvements en échec : l'explication ne reste pas « Chargement… ».
    cleanup();
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: false, reason: 'OFFLINE' } as never);
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    expect(
      await screen.findByText('Explication indisponible tant que les mouvements ne sont pas lus.'),
    ).toBeInTheDocument();
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(
      await screen.findByText('Les mouvements listés expliquent tout l’écart.'),
    ).toBeInTheDocument();
  });

  it('emplacement hors de la portée du registre : refus annoncé comme tel', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 404,
      body: {},
    } as never);
    renderScreen();
    expect(
      await screen.findByText(/Emplacement hors de votre périmètre de registre/),
    ).toBeInTheDocument();
  });

  it('période invalide : aucune lecture ; hors ligne : écran en ligne seulement', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) => answer(path, 120) as never,
    );
    renderScreen();
    await screen.findByRole('region', { name: 'Mouvements' });
    vi.mocked(authorizedRequest).mockClear();
    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-10-11' } });
    expect(screen.getByText('La fin de la période doit suivre son début.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mouvements' })).not.toBeInTheDocument();
    // Aucune lecture avec la période invalide (une relecture de la période précédente peut finir).
    await waitFor(() =>
      expect(
        vi
          .mocked(authorizedRequest)
          .mock.calls.some(([, path]) => String(path).includes('from=2026-10-11')),
      ).toBe(false),
    );

    cleanup();
    vi.mocked(authorizedRequest).mockClear();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

describe('Registre : période et bornes', () => {
  it('sept jours jusqu’à aujourd’hui ; ordre, futur et durée contrôlés', () => {
    expect(defaultPeriod('2026-10-10')).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(checkPeriod('2026-10-04', '2026-10-10', '2026-10-10')).toBeNull();
    expect(checkPeriod('2026-10-11', '2026-10-10', '2026-10-10')).toBe('ORDER');
    expect(checkPeriod('2026-10-04', '2026-10-11', '2026-10-10')).toBe('FUTURE');
    expect(checkPeriod('2025-01-01', '2026-10-10', '2026-10-10')).toBe('TOO_LONG');
    expect(checkPeriod('2026-13-01', '2026-10-10', '2026-10-10')).toBe('DATE_INVALID');
  });

  it('soldes juste avant le premier jour et juste avant minuit du dernier (heure de Douala)', () => {
    expect(openingInstant('2026-10-04')).toBe('2026-10-03T22:59:59.999Z');
    expect(closingInstant('2026-10-10')).toBe('2026-10-10T22:59:59.999Z');
  });
});

describe('Registre : export CSV (AV-519)', () => {
  const lookups = {
    when: (iso: string) => iso,
    header: (column: string) => column,
    moveType: (moveType: string) => moveType,
    product: (id: string) => `produit ${id}`,
    unit: () => 'kg',
    counterpart: () => 'fournisseur',
    direction: (direction: 'IN' | 'OUT') => (direction === 'IN' ? 'Entrée' : 'Sortie'),
    yes: 'oui',
    no: 'non',
  };

  it('les colonnes de valeur n’existent que si le serveur a servi une valeur (droit de valorisation)', () => {
    expect(ledgerCsvColumns([move({})])).not.toContain('VALUE');
    expect(ledgerCsvColumns([move({}), move({ id: 'm2', valueXaf: 5000 })])).toEqual(
      expect.arrayContaining(['UNIT_COST', 'VALUE']),
    );
  });

  it('quantités signées à virgule décimale, valeurs vides quand elles sont masquées', () => {
    const moves = [
      move({ quantity: 1.5, unitCostXaf: 200, valueXaf: 300 }),
      move({ id: 'm2', direction: 'OUT', quantity: 0.25, isReversal: true, lotId: 'lot-1' }),
    ];
    const columns = ledgerCsvColumns(moves);
    const rows = ledgerCsvRows(moves, columns, lookups);
    const at = (row: number, column: (typeof columns)[number]) =>
      rows[row]![columns.indexOf(column)];
    expect(rows[0]).toEqual(columns);
    expect(at(1, 'QUANTITY')).toBe('1,5');
    expect(at(1, 'VALUE')).toBe('300');
    expect(at(2, 'QUANTITY')).toBe('-0,25');
    expect(at(2, 'VALUE')).toBe('');
    expect(at(2, 'UNIT_COST')).toBe('');
    expect(at(2, 'REVERSAL')).toBe('oui');
    expect(at(2, 'LOT')).toBe('lot-1');
    expect(at(1, 'REVERSAL')).toBe('non');
  });

  it('nom de fichier : emplacement, produit et période, sans accent ni espace', () => {
    expect(
      ledgerFileName({
        locationName: 'Magasin Bonabéri (Douala)',
        productName: 'Œufs de table',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toBe('registre-stock_magasin-bonaberi-douala_oeufs-de-table_2026-10-01_2026-10-31.csv');
    expect(
      ledgerFileName({ locationName: '', productName: null, from: '2026-10-01', to: '2026-10-31' }),
    ).toBe('registre-stock_2026-10-01_2026-10-31.csv');
  });
});
