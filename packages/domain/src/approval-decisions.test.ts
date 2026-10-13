import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DECISION_SPECS,
  approvalDecisionSpec,
  canSelfApprove,
} from './approval-decisions.js';

describe('approval-decisions (MP-07, ECR-ADM-08)', () => {
  it('écarts de caisse et de remise : acceptation seule, motif obligatoire, imputation d’une remise (AV-159, AV-174)', () => {
    expect(approvalDecisionSpec('CASH_VARIANCE')).toEqual({
      rejectable: false,
      approveReasonRequired: true,
    });
    expect(approvalDecisionSpec('CASH_TRANSFER_DISCREPANCY')).toEqual({
      rejectable: false,
      approveReasonRequired: true,
      approveOptions: { values: ['SENDER', 'CARRIER', 'RECEIVER', 'COMPANY'], required: true },
    });
  });

  it('pertes et mortalités : issue du refus, erreur de déclaration par défaut (AV-038) ; montant au coût', () => {
    for (const type of ['LOSS_DECLARATION', 'MORTALITY']) {
      expect(approvalDecisionSpec(type).rejectOptions).toEqual({
        values: ['ERREUR_DECLARATION', 'PERTE_NON_JUSTIFIEE'],
        required: false,
        defaultValue: 'ERREUR_DECLARATION',
      });
      expect(approvalDecisionSpec(type).amountIsCost).toBe(true);
    }
    expect(approvalDecisionSpec('PRICE_OVERRIDE').amountIsCost).toBeUndefined();
  });

  it('annulation de vente, doublon d’encaissement, validations a posteriori', () => {
    expect(approvalDecisionSpec('SALE_CANCELLATION').approveOptions?.values).toEqual([
      'REFUND',
      'CUSTOMER_CREDIT',
    ]);
    expect(approvalDecisionSpec('PAYMENT_DUPLICATE').approveData).toEqual([
      { key: 'correctedReference', required: false },
    ]);
    expect(approvalDecisionSpec('PRICE_OVERRIDE').recordOnly).toBe(true);
    expect(approvalDecisionSpec('CREDIT_LIMIT_EXCEEDED').recordOnly).toBe(true);
  });

  it('type sans règle propre (ou inconnu de cette version) : approuver ou refuser simplement', () => {
    expect(approvalDecisionSpec('PURCHASE_REQUEST')).toEqual({ rejectable: true });
    expect(approvalDecisionSpec('TYPE_FUTUR')).toEqual({ rejectable: true });
    expect(Object.keys(APPROVAL_DECISION_SPECS)).not.toContain('PURCHASE_REQUEST');
  });

  it('auto-validation réservée à la Direction (INV-ADM-02)', () => {
    expect(canSelfApprove(['DIRECTION'])).toBe(true);
    expect(canSelfApprove(['RESP_COMMERCIAL', 'DIRECTION'])).toBe(true);
    expect(canSelfApprove(['RESP_COMMERCIAL'])).toBe(false);
    expect(canSelfApprove(['ADMIN'])).toBe(false);
    expect(canSelfApprove([])).toBe(false);
  });
});
