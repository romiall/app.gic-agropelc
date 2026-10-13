import { describe, expect, it } from 'vitest';
import {
  EXPENSE_REVIEW_ERROR_CODES,
  EXPENSE_REVIEW_REASONS,
  EXPENSE_STATUSES,
  expenseApprovalWithinLimits,
  expenseCarriesCost,
  expenseCostLine,
  expensePhotoRequired,
  expenseRequiresApproval,
  expenseReviewReasons,
  expenseStatusAtRecord,
  expenseTransition,
  type ExpenseStatus,
} from './expenses.js';
import { DomainError } from './errors.js';

const category = { isActive: true, isSystem: false, allowedOnPos: true };
const conforming = {
  category,
  amountXaf: 8_000,
  paidFromPos: false,
  posCapXaf: 50_000,
  photoThresholdXaf: 10_000,
  hasAttachment: false,
  costObject: 'NONE' as const,
};

describe('seuils des dépenses (AV-058, comparaisons strictes)', () => {
  it('validation au-delà de 50 000, pas au seuil', () => {
    expect(expenseRequiresApproval(50_000, 50_000)).toBe(false);
    expect(expenseRequiresApproval(50_001, 50_000)).toBe(true);
  });
  it('justificatif au-delà de 10 000, pas au seuil', () => {
    expect(expensePhotoRequired(10_000, 10_000)).toBe(false);
    expect(expensePhotoRequired(10_001, 10_000)).toBe(true);
  });
});

describe('motifs de revue (ADR-060 §5 et §6)', () => {
  it('dépense conforme : aucun motif', () => {
    expect(expenseReviewReasons(conforming)).toEqual([]);
  });

  it('catégorie désactivée ou système', () => {
    expect(
      expenseReviewReasons({ ...conforming, category: { ...category, isActive: false } }),
    ).toEqual(['CATEGORY_INACTIVE']);
    expect(
      expenseReviewReasons({ ...conforming, category: { ...category, isSystem: true } }),
    ).toEqual(['CATEGORY_INACTIVE']);
  });

  it('caisse du PDV : catégorie non autorisée et plafond, jugés seulement au PDV', () => {
    const notOnPos = { ...category, allowedOnPos: false };
    expect(
      expenseReviewReasons({
        ...conforming,
        category: notOnPos,
        amountXaf: 60_000,
        hasAttachment: true,
      }),
    ).toEqual([]);
    expect(
      expenseReviewReasons({
        ...conforming,
        category: notOnPos,
        paidFromPos: true,
        amountXaf: 60_000,
        hasAttachment: true,
      }),
    ).toEqual(['CATEGORY_NOT_ALLOWED_ON_POS', 'POS_CAP_EXCEEDED']);
    expect(
      expenseReviewReasons({
        ...conforming,
        paidFromPos: true,
        amountXaf: 50_000,
        hasAttachment: true,
      }),
    ).toEqual([]);
  });

  it('justificatif manquant au-delà du seuil photo, présent : aucun motif', () => {
    expect(expenseReviewReasons({ ...conforming, amountXaf: 12_000 })).toEqual([
      'ATTACHMENT_MISSING',
    ]);
    expect(expenseReviewReasons({ ...conforming, amountXaf: 12_000, hasAttachment: true })).toEqual(
      [],
    );
  });

  it('objet de coût clos ; ouvert : aucun motif', () => {
    expect(expenseReviewReasons({ ...conforming, costObject: 'CLOSED' })).toEqual([
      'COST_OBJECT_CLOSED',
    ]);
    expect(expenseReviewReasons({ ...conforming, costObject: 'OPEN' })).toEqual([]);
  });

  it('chaque motif a son code de refus en ligne', () => {
    for (const reason of EXPENSE_REVIEW_REASONS) {
      expect(EXPENSE_REVIEW_ERROR_CODES[reason]).toMatch(/^[A-Z_]+$/);
    }
    expect(EXPENSE_REVIEW_ERROR_CODES.ATTACHMENT_MISSING).toBe('ATTACHMENT_REQUIRED');
  });
});

describe('statut à l’enregistrement (SM-EXPENSE, AV-351)', () => {
  const base = {
    paidNow: false,
    overThreshold: false,
    reviewReasonCount: 0,
    policyAvailable: true,
  };
  it('à payer : RECORDED sous le seuil, PENDING_APPROVAL au-delà ou avec un motif', () => {
    expect(expenseStatusAtRecord(base)).toBe('RECORDED');
    expect(expenseStatusAtRecord({ ...base, overThreshold: true })).toBe('PENDING_APPROVAL');
    expect(expenseStatusAtRecord({ ...base, reviewReasonCount: 1 })).toBe('PENDING_APPROVAL');
  });
  it('payée : PAID ou PAID_PENDING_APPROVAL', () => {
    expect(expenseStatusAtRecord({ ...base, paidNow: true })).toBe('PAID');
    expect(expenseStatusAtRecord({ ...base, paidNow: true, overThreshold: true })).toBe(
      'PAID_PENDING_APPROVAL',
    );
    expect(expenseStatusAtRecord({ ...base, paidNow: true, reviewReasonCount: 2 })).toBe(
      'PAID_PENDING_APPROVAL',
    );
  });
  it('sans politique : jamais de validation', () => {
    const noPolicy = { ...base, policyAvailable: false, overThreshold: true, reviewReasonCount: 1 };
    expect(expenseStatusAtRecord(noPolicy)).toBe('RECORDED');
    expect(expenseStatusAtRecord({ ...noPolicy, paidNow: true })).toBe('PAID');
  });
});

describe('transitions (SM-EXPENSE)', () => {
  it('décisions, paiement, annulation', () => {
    expect(expenseTransition('PENDING_APPROVAL', 'APPROVE')).toBe('APPROVED');
    expect(expenseTransition('PAID_PENDING_APPROVAL', 'APPROVE')).toBe('PAID');
    expect(expenseTransition('PENDING_APPROVAL', 'REJECT')).toBe('REJECTED');
    expect(expenseTransition('PAID_PENDING_APPROVAL', 'REJECT')).toBe('PAID_REJECTED');
    expect(expenseTransition('RECORDED', 'PAY')).toBe('PAID');
    expect(expenseTransition('APPROVED', 'PAY')).toBe('PAID');
    expect(expenseTransition('RECORDED', 'CANCEL')).toBe('CANCELLED');
    expect(expenseTransition('PENDING_APPROVAL', 'CANCEL')).toBe('CANCELLED');
    expect(expenseTransition('APPROVED', 'CANCEL')).toBe('CANCELLED');
  });

  it('hors table : EXPENSE_STATUS_INVALID (une dépense payée ne s’annule pas, ne se repaie pas)', () => {
    for (const [status, action] of [
      ['PAID', 'CANCEL'],
      ['PAID', 'PAY'],
      ['PENDING_APPROVAL', 'PAY'],
      ['RECORDED', 'APPROVE'],
      ['CANCELLED', 'REJECT'],
      ['PAID_REJECTED', 'APPROVE'],
    ] as const) {
      expect(() => expenseTransition(status, action)).toThrow(DomainError);
    }
    try {
      expenseTransition('PAID', 'CANCEL');
    } catch (error) {
      expect((error as DomainError).code).toBe('EXPENSE_STATUS_INVALID');
    }
  });
});

describe('écriture de coût (BR-FIN-022, INV-FIN-08)', () => {
  it('portée seulement par RECORDED, APPROVED, PAID', () => {
    const carrying = EXPENSE_STATUSES.filter((status: ExpenseStatus) => expenseCarriesCost(status));
    expect(carrying).toEqual(['RECORDED', 'APPROVED', 'PAID']);
  });

  it('lot : type de la catégorie s’il est admis, sinon DEPENSE_DIRECTE', () => {
    expect(
      expenseCostLine({
        costObjectType: 'PRODUCTION_LOT',
        speciesGroup: null,
        categoryCostType: 'VETERINAIRE',
      }),
    ).toEqual({ costType: 'VETERINAIRE', speciesGroup: null });
    expect(
      expenseCostLine({
        costObjectType: 'INCUBATION_BATCH',
        speciesGroup: null,
        categoryCostType: null,
      }),
    ).toEqual({ costType: 'DEPENSE_DIRECTE', speciesGroup: null });
    expect(
      expenseCostLine({
        costObjectType: 'PRODUCTION_LOT',
        speciesGroup: null,
        categoryCostType: 'ANIMAUX',
      }),
    ).toEqual({ costType: 'DEPENSE_DIRECTE', speciesGroup: null });
  });

  it('site : frais généraux avec espèce, dépense directe sans espèce (AV-356)', () => {
    expect(
      expenseCostLine({
        costObjectType: 'SITE',
        speciesGroup: 'PORC',
        categoryCostType: 'VETERINAIRE',
      }),
    ).toEqual({ costType: 'FRAIS_GENERAUX', speciesGroup: 'PORC' });
    expect(
      expenseCostLine({
        costObjectType: 'SITE',
        speciesGroup: null,
        categoryCostType: 'VETERINAIRE',
      }),
    ).toEqual({ costType: 'DEPENSE_DIRECTE', speciesGroup: null });
  });

  it('espèce hors d’un site : COST_OBJECT_INVALID', () => {
    expect(() =>
      expenseCostLine({
        costObjectType: 'PRODUCTION_LOT',
        speciesGroup: 'VOLAILLE',
        categoryCostType: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'COST_OBJECT_INVALID' }));
  });
});

describe('plafond d’approbation (RC-06, AV-350)', () => {
  it('le plus permissif des rôles l’emporte ; sans droit, refus', () => {
    expect(expenseApprovalWithinLimits(80_000, [])).toBe(false);
    expect(expenseApprovalWithinLimits(80_000, [null])).toBe(true);
    expect(expenseApprovalWithinLimits(80_000, [{ maxAmountXaf: 50_000 }])).toBe(false);
    expect(expenseApprovalWithinLimits(50_000, [{ maxAmountXaf: 50_000 }])).toBe(true);
    expect(
      expenseApprovalWithinLimits(80_000, [{ maxAmountXaf: 50_000 }, { maxAmountXaf: 100_000 }]),
    ).toBe(true);
    expect(expenseApprovalWithinLimits(80_000, [{ maxAmountXaf: 50_000 }, { autre: 1 }])).toBe(
      true,
    );
  });
});
