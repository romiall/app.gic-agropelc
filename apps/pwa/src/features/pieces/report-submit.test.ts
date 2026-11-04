/**
 * Envoi d'un report de pièce papier par l'outbox (PP-B ; REQ-303, AV-312, AV-078, AV-502, AV-504) :
 * l'entrée de l'outbox est la commande du serveur, son enveloppe passe le schéma partagé du serveur
 * (`checkEnvelope`), la photo de la souche n'est jointe que là où le serveur la rattache, et le registre
 * des carnets relit les indices locaux de l'appareil.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../storage/db.js';
import { checkEnvelope } from '../../sync/envelope.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { IDS } from '../sales/fixtures.js';
import type { ResolvedSlip } from './report-commands.js';
import type { SlipMeta } from './report-form.js';
import {
  describeReportedPayload,
  loadReportedSlipsFromDb,
  submitPaperSlipReport,
} from './report-submit.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const photo: PreparedPhoto = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer,
  mimeType: 'image/jpeg',
  sizeBytes: 8,
  sha256: 'a'.repeat(64),
  capturedAt: '2026-11-03T09:00:00.000Z',
};

const meta = (overrides: Partial<SlipMeta> = {}): SlipMeta => ({
  paperRef: 'BD-000055',
  occurredAt: '2026-11-03T08:00:00.000Z',
  backdatedReason: null,
  dependsOn: [],
  ...overrides,
});

const expenseSlip: ResolvedSlip = {
  type: 'BD',
  categoryId: id(30),
  siteId: id(31),
  amountXaf: 12_500,
  description: 'Achat ampoules et cadenas',
  payeeName: 'Quincaillerie Centrale',
  paidFromAccountId: id(32),
};

const saleSlip: ResolvedSlip = {
  type: 'BV',
  fromLocationId: id(10),
  lines: [
    {
      productId: id(1),
      quantity: 4,
      unitCode: 'U',
      quantityBase: 4,
      listUnitPriceXaf: 3000,
      priceRuleId: id(2),
      unitPriceXaf: 3000,
    },
  ],
  payment: { methodCode: 'ESPECES', amountXaf: 12_000 },
  totalXaf: 12_000,
};

describe('submitPaperSlipReport : la commande du serveur dans l’outbox', () => {
  beforeEach(async () => {
    await getDb().outbox.clear();
    await getDb().attachmentFiles.clear();
    await getDb().attachmentBlobs.clear();
  });
  afterEach(async () => {
    await getDb().outbox.clear();
    await getDb().attachmentFiles.clear();
    await getDb().attachmentBlobs.clear();
  });

  it('BD avec photo : la dépense, saisie hors ligne à l’heure de la pièce, cite sa photo', async () => {
    await submitPaperSlipReport(
      expenseSlip,
      meta({ backdatedReason: 'Carnet rapporté' }),
      IDS.user,
      photo,
    );
    const rows = await getDb().outbox.orderBy('device_seq').toArray();
    // La photo est enregistrée par sa propre commande, juste avant l'opération (ADR-046).
    expect(rows.map((row) => row.command_type)).toEqual([
      'attachments.attachment.register',
      'finance.expense.record',
    ]);
    const [register, expense] = rows;
    expect(expense).toMatchObject({
      aggregate_type: 'EXPENSE',
      captured_offline: true,
      occurred_at: '2026-11-03T08:00:00.000Z',
      backdated_reason: 'Carnet rapporté',
      status: 'LOCAL_ONLY',
      local_flags: ['PAPER_SLIP', 'SLIP_TYPE:BD', 'PAPER_REF:BD-000055', 'SLIP_AMOUNT:12500'],
      payload: { localRef: 'BD-000055', paidNow: true, paidFromAccountId: id(32), siteId: id(31) },
    });
    expect(expense?.attachment_ids).toHaveLength(1);
    expect(register).toMatchObject({
      payload: { ownerType: 'EXPENSE', ownerId: expense?.aggregate_id, kind: 'RECEIPT' },
    });
    // Les deux enveloppes passent le schéma que le serveur applique au lot entier.
    for (const row of rows) expect(checkEnvelope(row)).toEqual({ ok: true });
  });

  it('BV : le serveur n’a pas de propriétaire de pièce jointe pour une vente, la photo n’est pas jointe', async () => {
    await submitPaperSlipReport(saleSlip, meta({ paperRef: 'BV-000142' }), IDS.user, photo);
    const rows = await getDb().outbox.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command_type: 'sales.sale.record', attachment_ids: [] });
    expect(await getDb().attachmentFiles.count()).toBe(0);
    expect(checkEnvelope(rows[0]!)).toEqual({ ok: true });
  });

  it('une livraison attend la commande encore dans l’outbox (depends_on)', async () => {
    await submitPaperSlipReport(
      { type: 'BL', orderId: id(20), lines: [{ orderLineId: id(21), quantityBase: 3 }] },
      meta({ paperRef: 'BL-000018', dependsOn: [id(500)] }),
      IDS.user,
    );
    const [row] = await getDb().outbox.toArray();
    expect(row).toMatchObject({
      command_type: 'sales.order.fulfil',
      aggregate_type: 'DELIVERY_NOTE',
      depends_on: [id(500)],
    });
  });

  it('le registre des carnets relit les indices locaux : type, numéro, montant, libellé', async () => {
    await submitPaperSlipReport(saleSlip, meta({ paperRef: 'BV-000142' }), IDS.user);
    await submitPaperSlipReport(expenseSlip, meta({ paperRef: 'BD-000055' }), IDS.user, photo);
    const records = await loadReportedSlipsFromDb(getDb());
    expect(
      records.map((record) => [record.slipType, record.paperSlipRef, record.amountXaf]),
    ).toEqual(
      expect.arrayContaining([
        ['BV', 'BV-000142', 12_000],
        ['BD', 'BD-000055', 12_500],
      ]),
    );
    const expense = records.find((record) => record.slipType === 'BD');
    expect(expense).toMatchObject({
      description: 'À : Quincaillerie Centrale — Achat ampoules et cadenas',
      hasAttachment: true,
    });
    // La commande d'enregistrement de la photo n'est pas une pièce.
    expect(records).toHaveLength(2);
  });

  it('libellé d’une pièce reportée, tiré de sa charge utile', () => {
    expect(describeReportedPayload('BV', { lines: [{}, {}] })).toBe('Vente : 2 lignes');
    expect(describeReportedPayload('CC', { lines: [{}] })).toBe('Commande client : 1 ligne');
    expect(describeReportedPayload('RF', null)).toBe('Remise de fonds');
  });

  it('les codes du moyen de paiement et de la nature de perte sont traduits, jamais montrés bruts', () => {
    const labels = {
      paymentMethod: (code: string) => (code === 'ESPECES' ? 'Espèces' : code),
      lossCategory: (code: string) => (code === 'CASSE' ? 'Casse' : code),
    };
    expect(describeReportedPayload('RE', { methodCode: 'ESPECES' }, labels)).toBe(
      'Encaissement (Espèces)',
    );
    expect(describeReportedPayload('FP', { category: 'CASSE' }, labels)).toBe('Perte (Casse)');
    // Un code que le référentiel ne connaît pas reste lisible tel quel plutôt que de disparaître.
    expect(describeReportedPayload('RE', { methodCode: 'INCONNU' }, labels)).toBe(
      'Encaissement (INCONNU)',
    );
    // Sans traduction fournie, le code est rendu tel quel.
    expect(describeReportedPayload('RE', { methodCode: 'ESPECES' })).toBe('Encaissement (ESPECES)');
    expect(describeReportedPayload('FP', { category: 'CASSE' })).toBe('Perte (CASSE)');
  });
});
