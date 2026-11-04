import { describe, expect, it, vi } from 'vitest';
import { buildPaperSlipCommandInput } from './report-submit.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

describe('report-submit (PP-B)', () => {
  it('construit la commande pour un Bon de Vente (BV) avec drapeaux et référence', () => {
    const input = buildPaperSlipCommandInput(
      {
        slipType: 'BV',
        paperSlipRef: 'bv 00142',
        occurredAt: '2026-11-03T10:00',
        backdatedReason: '',
        quantity: 5,
        unitPriceXaf: 3000,
        totalAmountXaf: 15000,
        paymentMethod: 'CASH',
      },
      '018f0000-0000-7000-0000-000000000001',
      null,
      '018f0000-0000-7000-0000-000000000099',
    );

    expect(input.commandType).toBe('sales.sale.create');
    expect(input.aggregateType).toBe('SALE');
    expect(input.aggregateId).toBe('018f0000-0000-7000-0000-000000000099');
    expect(input.localFlags).toContain('PAPER_SLIP');
    expect(input.localFlags).toContain('SLIP_TYPE:BV');
    expect(input.localFlags).toContain('PAPER_REF:BV-00142');

    const payload = input.payload as Record<string, unknown>;
    expect(payload.paperSlipRef).toBe('BV-00142');
    expect(payload.localRef).toBe('BV-00142');
    expect(payload.totalAmountXaf).toBe(15000);
  });

  it('construit la commande pour un Bon de Décaissement (BD) avec motif antidaté si > 24h', () => {
    const oldDate = '2026-10-31T08:00'; // > 24h
    const input = buildPaperSlipCommandInput(
      {
        slipType: 'BD',
        paperSlipRef: 'BD-055',
        occurredAt: oldDate,
        backdatedReason: 'Saisie différée de fin de mois',
        bdAmountXaf: 12500,
        bdPayeeName: 'Quincaillerie Centrale',
        bdDescription: 'Achat ampoules et cadenas',
      },
      '018f0000-0000-7000-0000-000000000001',
    );

    expect(input.commandType).toBe('finance.expense.record');
    expect(input.aggregateType).toBe('EXPENSE');
    expect(input.backdatedReason).toBe('Saisie différée de fin de mois');
    const payload = input.payload as Record<string, unknown>;
    expect(payload.amountXaf).toBe(12500);
    expect(payload.payeeName).toBe('Quincaillerie Centrale');
    expect(payload.paperSlipRef).toBe('BD-055');
  });

  it('construit la commande pour un Reçu d encaissement (RE)', () => {
    const input = buildPaperSlipCommandInput(
      {
        slipType: 'RE',
        paperSlipRef: 'RE-0099',
        occurredAt: '2026-11-03T14:30',
        backdatedReason: '',
        reAmountXaf: 50000,
        rePaymentMethod: 'MOMO',
        reNotes: 'Acompte commande poulets',
      },
      '018f0000-0000-7000-0000-000000000001',
    );

    expect(input.commandType).toBe('sales.payment.record');
    expect(input.aggregateType).toBe('PAYMENT');
    const payload = input.payload as Record<string, unknown>;
    expect(payload.amountXaf).toBe(50000);
    expect(payload.paymentMethod).toBe('MOMO');
    expect(payload.paperSlipRef).toBe('RE-0099');
  });
});
