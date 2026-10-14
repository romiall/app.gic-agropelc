import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { ReceiptScreen } from './ReceiptScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
// Photo : le canevas n'existe pas en test ; le recodage rend un petit JPEG (MP-10).
vi.mock('../attachments/photo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attachments/photo.js')>();
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
    await getDb().attachmentFiles.clear();
    await getDb().attachmentBlobs.clear();
  });

  const image = () => new File(['bon'], 'bon.jpg', { type: 'image/jpeg' });

  it('MP-10 : photo du bon jointe — enregistrée juste avant la réception, citée par elle ; état affiché', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/achats/receptions/${ORDER}`);
    await screen.findByRole('listitem', { name: 'Œufs de table' });
    await user.upload(screen.getByLabelText('Choisir une image'), image());
    expect(await screen.findByText(/Photo prête/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer la réception' }));
    expect(await screen.findByText(/Réception enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [register, receipt] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(register).toMatchObject({
      command_type: 'attachments.attachment.register',
      depends_on: [],
      payload: {
        ownerType: 'GOODS_RECEIPT',
        ownerId: receipt!.aggregate_id,
        kind: 'DELIVERY_NOTE',
        mimeType: 'image/jpeg',
        sizeBytes: 8,
      },
    });
    expect(receipt).toMatchObject({
      command_type: 'procurement.receipt.record',
      attachment_ids: [register!.aggregate_id],
      depends_on: [],
    });
    expect(await screen.findByText(/Photo enregistrée sur ce téléphone/)).toBeInTheDocument();
  });

  it('revue de MP-10 : photo du bon refusée — à reprendre depuis la liste ; reçue — plus de badge', async () => {
    const RECEIPT = '01900000-0000-7000-8000-0000000004c1';
    await getDb().projections.put(
      projection(
        'procurement',
        'GOODS_RECEIPT',
        RECEIPT,
        {
          doc_number: 'REC-2026-000010',
          purchase_order_id: ORDER,
          supplier_id: SUPPLIER,
          location_id: IDS.pos,
          supplier_delivery_note_ref: null,
          status: 'POSTED',
          occurred_at: '2026-10-10T09:00:00.000Z',
          lines: [],
        },
        'SITE',
      ),
    );
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000004c2',
      device_seq: 1,
      command_type: 'procurement.receipt.record',
      command_version: 1,
      author_user_id: '01900000-0000-7000-8000-000000000001',
      aggregate_type: 'GOODS_RECEIPT',
      aggregate_id: RECEIPT,
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T09:00:00.000Z',
      client_created_at: '2026-10-10T09:00:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: ['01900000-0000-7000-8000-0000000004c3'],
      payload: {},
      status: 'SYNCED',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    const refusedFile = {
      attachment_id: '01900000-0000-7000-8000-0000000004c3',
      author_user_id: '01900000-0000-7000-8000-000000000001',
      owner_type: 'GOODS_RECEIPT',
      owner_id: RECEIPT,
      kind: 'DELIVERY_NOTE',
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
    };
    await getDb().attachmentFiles.put(refusedFile);
    const user = userEvent.setup();
    renderAt('/achats/receptions');
    expect(await screen.findByText('Photo manquante')).toBeInTheDocument();
    expect(await screen.findByText(/Photo refusée par le serveur/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Joindre la photo du bon' }));
    await user.upload(screen.getByLabelText('Choisir une image'), image());
    await screen.findByText(/Photo prête/);
    await user.click(screen.getByRole('button', { name: 'Envoyer la photo' }));
    expect(await screen.findByText(/Photo enregistrée sur ce téléphone/)).toBeInTheDocument();
    // Nouvelle photo en route : badge retiré, ancienne photo refusée plus montrée.
    expect(screen.queryByText('Photo manquante')).toBeNull();
    expect(screen.queryByText(/Photo refusée par le serveur/)).toBeNull();
  });

  it('MP-10 (AV-285) : réception « photo manquante » — badge et photo du bon jointe après coup, seule', async () => {
    const RECEIPT = '01900000-0000-7000-8000-0000000004b1';
    await getDb().projections.put(
      projection(
        'procurement',
        'GOODS_RECEIPT',
        RECEIPT,
        {
          doc_number: 'REC-2026-000009',
          purchase_order_id: ORDER,
          supplier_id: SUPPLIER,
          location_id: IDS.pos,
          supplier_delivery_note_ref: null,
          status: 'POSTED',
          occurred_at: '2026-10-10T08:00:00.000Z',
          lines: [],
        },
        'SITE',
      ),
    );
    const accepted: OutboxCommand = {
      command_id: '01900000-0000-7000-8000-0000000004b2',
      device_seq: 1,
      command_type: 'procurement.receipt.record',
      command_version: 1,
      author_user_id: '01900000-0000-7000-8000-000000000001',
      aggregate_type: 'GOODS_RECEIPT',
      aggregate_id: RECEIPT,
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:00:00.000Z',
      client_created_at: '2026-10-10T08:00:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'SYNCED_WITH_WARNING',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: { docNumber: 'REC-2026-000009' },
      warnings: ['RECEIPT_PHOTO_MISSING'],
    };
    await getDb().outbox.put(accepted);
    const user = userEvent.setup();
    renderAt('/achats/receptions');
    expect(await screen.findByText('Photo manquante')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Joindre la photo du bon' }));
    const send = screen.getByRole('button', { name: 'Envoyer la photo' });
    expect(send).toBeDisabled();
    await user.upload(screen.getByLabelText('Choisir une image'), image());
    await screen.findByText(/Photo prête/);
    await user.click(screen.getByRole('button', { name: 'Envoyer la photo' }));
    expect(await screen.findByText(/Photo enregistrée sur ce téléphone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Joindre la photo du bon' })).toBeNull();
    // Photo en route : le badge « photo manquante » disparaît (revue de MP-10).
    expect(screen.queryByText('Photo manquante')).toBeNull();

    const added = (await getDb().outbox.orderBy('device_seq').toArray()).filter(
      (command) => command.command_id !== accepted.command_id,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      command_type: 'attachments.attachment.register',
      payload: { ownerType: 'GOODS_RECEIPT', ownerId: RECEIPT, kind: 'DELIVERY_NOTE' },
    });
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

    // Réception attendue en quarantaine : elle n'avance pas le bon (le serveur ne le fait qu'en
    // comptabilisant), le reste à recevoir est inchangé.
    await user.click(screen.getByRole('link', { name: '← Bons de commande à recevoir' }));
    await user.click(
      await screen.findByRole('link', { name: 'Réceptionner le bon de commande BC-2026-000004' }),
    );
    const again = await screen.findByRole('listitem', { name: 'Œufs de table' });
    expect(within(again).getByText('Reste à recevoir : 300 U')).toBeInTheDocument();
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
