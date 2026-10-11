import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { InventoryCountData, LocationData, ProductData } from '../sales/types.js';
import { CountScreen } from './CountScreen.js';
import { activeCount, countEntries, deviceCounts } from './count.js';

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
  }),
}));

const REASON = '01900000-0000-7000-8000-0000000000f5';

function renderScreen() {
  return render(
    <MemoryRouter>
      <CountScreen />
    </MemoryRouter>,
  );
}

function command(
  type: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  seq: number,
  status: OutboxCommand['status'] = 'LOCAL_ONLY',
): OutboxCommand {
  return {
    command_id: `01900000-0000-7000-8000-0000000003${String(seq).padStart(2, '0')}`,
    device_seq: seq,
    command_type: type,
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'INVENTORY_COUNT',
    aggregate_id: aggregateId,
    base_version: null,
    depends_on: [],
    occurred_at: `2026-10-10T08:${String(seq).padStart(2, '0')}:00.000Z`,
    client_created_at: `2026-10-10T08:${String(seq).padStart(2, '0')}:00.000Z`,
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
  };
}

describe('Inventaire (ECR-STK-05, logique)', () => {
  const projected: InventoryCountData = {
    id: 'cnt-1',
    doc_number: 'INV-2026-000003',
    location_id: 'loc',
    count_type: 'PARTIAL',
    status: 'IN_PROGRESS',
    occurred_at: '2026-10-10T07:00:00.000Z',
    submitted_at: null,
    posted_at: null,
    version: 1,
    lines: [
      {
        id: 'l1',
        product_id: 'p-oeufs',
        lot_id: null,
        counted_at: '2026-10-10T07:30:00.000Z',
        counted_qty_base: '120.000',
        theoretical_qty_base: null,
        variance_qty_base: null,
        variance_reason_code_id: null,
        comment: null,
      },
    ],
  };

  it('saisies de l’appareil reportées sur l’inventaire téléchargé ; fin en vol : plus en cours', () => {
    const record = command(
      'inventory.count.record_lines',
      'cnt-1',
      { countId: 'cnt-1', lines: [{ productId: 'p-oeufs', countedQtyBase: 118 }] },
      1,
    );
    const [view] = deviceCounts([projected], [record], undefined);
    expect(view?.lines.get('p-oeufs:')).toMatchObject({ countedQtyBase: 118, pending: true });
    expect(view?.lineCommandIds).toEqual([record.command_id]);
    expect(activeCount([view!], 'loc')?.id).toBe('cnt-1');

    const submit = command('inventory.count.submit', 'cnt-1', { countId: 'cnt-1' }, 2);
    const after = deviceCounts([projected], [record, submit], undefined);
    expect(activeCount(after, 'loc')).toBeUndefined();
  });

  it('lignes à compter : partiel = produits comptés ou ajoutés ; lot obligatoire = une ligne par lot', () => {
    const products = [
      { id: 'p-oeufs', name: 'Œufs', base_unit_code: 'U', lot_tracking: 'OPTIONAL' },
      { id: 'p-poulets', name: 'Poulets', base_unit_code: 'TETE', lot_tracking: 'REQUIRED' },
      { id: 'p-sacs', name: 'Sacs', base_unit_code: 'U', lot_tracking: 'NONE' },
    ] as unknown as ProductData[];
    const stock = new Map([
      ['loc:p-oeufs', { qty_on_hand: '120.000', lots: [] }],
      [
        'loc:p-poulets',
        {
          qty_on_hand: '30.000',
          lots: [
            { lot_id: 'lot-a', lot_code: 'LOT-A', qty_on_hand: '10.000' },
            { lot_id: 'lot-b', lot_code: 'LOT-B', qty_on_hand: '20.000' },
          ],
        },
      ],
      ['loc:p-sacs', { qty_on_hand: '5.000', lots: [] }],
    ]);
    const refs = { products, stock, pending: new Map() } as unknown as Parameters<
      typeof countEntries
    >[0];
    const location = { id: 'loc' } as LocationData;
    const [view] = deviceCounts([projected], [], undefined);
    expect(countEntries(refs, location, view!, []).map((entry) => entry.key)).toEqual(['p-oeufs:']);
    const full = { ...view!, countType: 'FULL' };
    expect(
      countEntries(refs, location, full, []).map((entry) => [entry.key, entry.expectedQtyBase]),
    ).toEqual([
      ['p-oeufs:', 120],
      ['p-poulets:lot-a', 10],
      ['p-poulets:lot-b', 20],
      ['p-sacs:', 5],
    ]);
  });
});

describe('Inventaire (ECR-STK-05, écran)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: `reason_code:REASON_CODE:${REASON}`,
      dataset: 'reason_code',
      entity_type: 'REASON_CODE',
      entity_id: REASON,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: REASON,
        category: 'INVENTORY_ADJUSTMENT',
        code: 'CASSE_NON_DECLAREE',
        label: 'Casse non déclarée',
        loss_category: null,
        requires_comment: false,
        is_active: true,
      },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : ouverture, comptage avec écart justifié, puis fin qui attend ouverture et comptages', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Ouvrir l’inventaire' }));
    expect(await screen.findByText(/Inventaire numéro à venir — Complet/)).toBeInTheDocument();

    const eggs = screen.getByRole('listitem', { name: 'Œufs de table' });
    await user.type(within(eggs).getByLabelText('Compté (U)'), '298');
    expect(within(eggs).getByText('Écart estimé : -2 U')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Enregistrer les comptages' });
    expect(save).toBeDisabled();
    expect(within(eggs).getByText('Un écart se justifie par un motif.')).toBeInTheDocument();
    await user.selectOptions(within(eggs).getByLabelText('Motif de l’écart'), REASON);
    const chicken = screen.getByRole('listitem', { name: 'Poulet de chair' });
    await user.type(within(chicken).getByLabelText('Compté (U)'), '4');
    expect(within(chicken).getByText('Aucun écart estimé.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminer l’inventaire' })).toBeDisabled();
    await user.click(save);
    expect(await screen.findAllByText('Enregistré sur le téléphone')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Terminer l’inventaire' }));
    expect(await screen.findByText('Fin envoyée, en attente')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ouvrir l’inventaire' })).toBeInTheDocument();

    const [open, record, submit] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(open).toMatchObject({
      command_type: 'inventory.count.open',
      aggregate_type: 'INVENTORY_COUNT',
      captured_offline: true,
      payload: { locationId: IDS.pos, countType: 'FULL' },
    });
    expect(record).toMatchObject({
      command_type: 'inventory.count.record_lines',
      aggregate_id: open?.aggregate_id,
      depends_on: [open?.command_id],
      payload: {
        countId: open?.aggregate_id,
        lines: [
          {
            productId: IDS.eggs,
            countedAt: '2026-10-10T09:00:00.000Z',
            countedQtyBase: 298,
            varianceReasonCodeId: REASON,
          },
          { productId: IDS.chicken, countedAt: '2026-10-10T09:00:00.000Z', countedQtyBase: 4 },
        ],
      },
    });
    expect(submit).toMatchObject({
      command_type: 'inventory.count.submit',
      depends_on: [open?.command_id, record?.command_id],
      payload: { countId: open?.aggregate_id },
    });
  });

  it('abandon : confirmation demandée avant l’envoi', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Type d’inventaire'), 'SPOT');
    await user.click(screen.getByRole('button', { name: 'Ouvrir l’inventaire' }));
    expect(await screen.findByText('Ajoutez les produits à compter.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Abandonner l’inventaire' }));
    expect(await getDb().outbox.count()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Confirmer l’abandon de l’inventaire' }));
    expect(await screen.findByText('Abandon en attente d’envoi')).toBeInTheDocument();
    const cancel = (await getDb().outbox.orderBy('device_seq').toArray())[1];
    expect(cancel).toMatchObject({ command_type: 'inventory.count.cancel' });
  });
});
