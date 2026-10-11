import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { ReceiptScreen } from './ReceiptScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const ORDER = '01900000-0000-7000-8000-0000000004a1';
const LINE_EGGS = '01900000-0000-7000-8000-0000000004a2';
const LINE_CHICKEN = '01900000-0000-7000-8000-0000000004a3';
const SUPPLIER = '01900000-0000-7000-8000-0000000004a4';
const REJECT = '01900000-0000-7000-8000-0000000004a5';

function projection(dataset: string, type: string, id: string, data: object, scope = 'GLOBAL') {
  return {
    key: `${dataset}:${type}:${id}`,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: scope,
    scope_id: scope === 'SITE' ? IDS.site : null,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/achats/receptions" element={<ReceiptScreen key="liste" />} />
        <Route path="/achats/receptions/:orderId" element={<ReceiptScreen key="detail" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Réceptionner (ECR-APP-04)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('procurement', 'SUPPLIER', SUPPLIER, { code: 'F-01', name: 'Ferme du Centre' }),
      projection('reason_code', 'REASON_CODE', REJECT, {
        category: 'REJECTION',
        code: 'CASSE',
        label: 'Marchandise cassée',
        loss_category: null,
        requires_comment: false,
        is_active: true,
      }),
      projection(
        'procurement',
        'PURCHASE_ORDER',
        ORDER,
        {
          doc_number: 'BC-2026-000004',
          site_id: IDS.site,
          supplier_id: SUPPLIER,
          delivery_location_id: IDS.pos,
          expected_delivery_date: '2026-10-10',
          status: 'PARTIALLY_RECEIVED',
          sent_at: '2026-10-05T08:00:00.000Z',
          version: 3,
          lines: [
            {
              id: LINE_EGGS,
              line_no: 1,
              product_id: IDS.eggs,
              unit_code: 'U',
              ordered_qty_base: '300.000',
              accepted_qty_base: '0.000',
              closed_qty_base: '0.000',
              remaining_qty_base: '300.000',
              status: 'OPEN',
            },
            {
              id: LINE_CHICKEN,
              line_no: 2,
              product_id: IDS.chicken,
              unit_code: 'U',
              ordered_qty_base: '10.000',
              accepted_qty_base: '6.000',
              closed_qty_base: '0.000',
              remaining_qty_base: '4.000',
              status: 'PARTIALLY_RECEIVED',
            },
          ],
        },
        'SITE',
      ),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : rejet motivé, dépassement mis en quarantaine, rien au disponible, accepté déduit du reste', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt('/achats/receptions');
    await user.click(
      await screen.findByRole('link', { name: 'Réceptionner le bon de commande BC-2026-000004' }),
    );
    const eggs = await screen.findByRole('listitem', { name: 'Œufs de table' });
    expect(within(eggs).getByLabelText('Livré (U)')).toHaveValue('300');
    await user.type(within(eggs).getByLabelText('Rejeté (U)'), '30');
    expect(within(eggs).getByText('Un rejet se justifie par un motif.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Enregistrer la réception' });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(eggs).getByLabelText('Motif du rejet'), REJECT);
    expect(within(eggs).getByText('Accepté : 270 U')).toBeInTheDocument();

    const chicken = screen.getByRole('listitem', { name: 'Poulet de chair' });
    const delivered = within(chicken).getByLabelText('Livré (U)');
    await user.clear(delivered);
    await user.type(delivered, '6');
    expect(within(chicken).getByText(/mise en quarantaine/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('N° du bon de livraison du fournisseur'), 'BL-77');
    await user.click(submit);
    expect(await screen.findByText(/Réception enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'procurement.receipt.record',
      aggregate_type: 'GOODS_RECEIPT',
      captured_offline: true,
    });
    expect(command?.payload).toEqual({
      purchaseOrderId: ORDER,
      supplierId: SUPPLIER,
      locationId: IDS.pos,
      supplierDeliveryNoteRef: 'BL-77',
      lines: [
        {
          poLineId: LINE_EGGS,
          productId: IDS.eggs,
          unitCode: 'U',
          qtyDeliveredBase: 300,
          qtyRejectedBase: 30,
          rejectionReasonCodeId: REJECT,
        },
        { poLineId: LINE_CHICKEN, productId: IDS.chicken, unitCode: 'U', qtyDeliveredBase: 6 },
      ],
    });
    // Quarantaine annoncée (mode par défaut) : aucun effet de stock avant décision (INV-APP-03).
    expect(command?.local_flags).toEqual(['EXPECTED_QUARANTINE']);
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBeUndefined();

    // Le reste à recevoir tient compte de la réception en attente.
    await user.click(screen.getByRole('link', { name: '← Bons de commande à recevoir' }));
    await user.click(
      await screen.findByRole('link', { name: 'Réceptionner le bon de commande BC-2026-000004' }),
    );
    const again = await screen.findByRole('listitem', { name: 'Œufs de table' });
    expect(within(again).getByText('Reste à recevoir : 30 U')).toBeInTheDocument();
  });

  it('en ligne : accepté au-delà du reste à recevoir, réception bloquée', async () => {
    const user = userEvent.setup();
    renderAt(`/achats/receptions/${ORDER}`);
    const chicken = await screen.findByRole('listitem', { name: 'Poulet de chair' });
    const delivered = within(chicken).getByLabelText('Livré (U)');
    await user.clear(delivered);
    await user.type(delivered, '5');
    expect(within(chicken).getByRole('alert')).toHaveTextContent(/de 1 U : le serveur refuserait/);
    expect(screen.getByRole('button', { name: 'Enregistrer la réception' })).toBeDisabled();
  });
});
