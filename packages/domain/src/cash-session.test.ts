import { describe, expect, it } from 'vitest';
import {
  adjustmentTreatment,
  cashInTransitXaf,
  cashSessionWindowsOverlap,
  cashVarianceXaf,
  expectedCashXaf,
  isAllowedCashValidator,
  isInCashSessionWindow,
  openingVarianceXaf,
  reevaluationDeltaXaf,
  statusAfterClose,
  transferDiscrepancyXaf,
  transferStatusAfterReceive,
  varianceMovement,
  varianceSeverity,
  type CashMovementAmount,
} from './cash-session.js';

const at = (iso: string) => new Date(iso);

describe('fenêtre d’une session (ADR-032 §2)', () => {
  const window = { openedAt: at('2026-10-08T07:00:00Z'), closedAt: at('2026-10-08T18:00:00Z') };

  it('couvre [ouverture, clôture[ : l’ouverture incluse, la clôture exclue', () => {
    expect(isInCashSessionWindow(at('2026-10-08T07:00:00Z'), window)).toBe(true);
    expect(isInCashSessionWindow(at('2026-10-08T17:59:59Z'), window)).toBe(true);
    expect(isInCashSessionWindow(at('2026-10-08T18:00:00Z'), window)).toBe(false);
    expect(isInCashSessionWindow(at('2026-10-08T06:59:59Z'), window)).toBe(false);
  });

  it('une session ouverte n’a pas de fin', () => {
    expect(
      isInCashSessionWindow(at('2030-01-01T00:00:00Z'), {
        openedAt: window.openedAt,
        closedAt: null,
      }),
    ).toBe(true);
  });

  it('chevauchement de fenêtres d’un même compte', () => {
    const next = { openedAt: at('2026-10-08T18:00:00Z'), closedAt: null };
    expect(cashSessionWindowsOverlap(window, next)).toBe(false); // bout à bout : pas de chevauchement
    expect(
      cashSessionWindowsOverlap(window, { openedAt: at('2026-10-08T17:00:00Z'), closedAt: null }),
    ).toBe(true);
    expect(
      cashSessionWindowsOverlap({ openedAt: at('2026-10-07T07:00:00Z'), closedAt: null }, next),
    ).toBe(true);
  });
});

describe('solde attendu et écart (BR-DIS-007, ADR-032 §3 et §4)', () => {
  it('WF-15 : fonds 20 000 + ventes espèces 180 000 − remboursement 4 500 − dépense 2 000 = 193 500', () => {
    const movements: CashMovementAmount[] = [
      { direction: 'IN', movementType: 'CUSTOMER_PAYMENT', amountXaf: 180_000 },
      { direction: 'OUT', movementType: 'REFUND', amountXaf: 4_500 },
      { direction: 'OUT', movementType: 'EXPENSE', amountXaf: 2_000 },
    ];
    expect(expectedCashXaf(20_000, movements)).toBe(193_500);
    expect(cashVarianceXaf(193_000, 193_500)).toBe(-500);
  });

  it('les écarts et le solde d’ouverture n’entrent jamais dans l’attendu', () => {
    const movements: CashMovementAmount[] = [
      { direction: 'IN', movementType: 'SESSION_VARIANCE', amountXaf: 20_000 },
      { direction: 'IN', movementType: 'OPENING_BALANCE', amountXaf: 5_000 },
      { direction: 'IN', movementType: 'CUSTOMER_PAYMENT', amountXaf: 1_000 },
    ];
    expect(expectedCashXaf(20_000, movements)).toBe(21_000);
  });

  it('une remise envoyée est une sortie ordinaire du registre', () => {
    expect(
      expectedCashXaf(0, [
        { direction: 'IN', movementType: 'CUSTOMER_PAYMENT', amountXaf: 193_000 },
        { direction: 'OUT', movementType: 'TRANSFER_OUT', amountXaf: 173_000 },
      ]),
    ).toBe(20_000);
  });

  it('un attendu peut être négatif (sorties hors ligne au-delà du fonds)', () => {
    expect(
      expectedCashXaf(1_000, [{ direction: 'OUT', movementType: 'REFUND', amountXaf: 3_000 }]),
    ).toBe(-2_000);
  });

  it('refuse un montant négatif ou non entier', () => {
    expect(() =>
      expectedCashXaf(0, [{ direction: 'IN', movementType: 'X', amountXaf: -1 }]),
    ).toThrow();
    expect(() => expectedCashXaf(0.5, [])).toThrow();
  });

  it('écart d’ouverture : fonds compté − solde du compte (la première session d’une caisse neuve fait +20 000)', () => {
    expect(openingVarianceXaf(20_000, 0)).toBe(20_000);
    expect(openingVarianceXaf(19_500, 20_000)).toBe(-500);
    expect(openingVarianceXaf(20_000, 20_000)).toBe(0);
  });

  it('un écart signé devient un mouvement positif avec son sens', () => {
    expect(varianceMovement(-500)).toEqual({ amount: 500, direction: 'OUT' });
    expect(varianceMovement(700)).toEqual({ amount: 700, direction: 'IN' });
    expect(varianceMovement(0)).toEqual({ amount: 0, direction: 'IN' });
  });
});

describe('réévaluation par le delta (ADR-032 §6, AT-031, INV-FIN-11)', () => {
  it('AT-031 : écart −500 validé, puis vente tardive de 700 dans la fenêtre → delta −700, Σ des écarts = compté − attendu', () => {
    const counted = 193_000;
    const movements: CashMovementAmount[] = [
      { direction: 'IN', movementType: 'CUSTOMER_PAYMENT', amountXaf: 180_000 },
      { direction: 'OUT', movementType: 'REFUND', amountXaf: 4_500 },
      { direction: 'OUT', movementType: 'EXPENSE', amountXaf: 2_000 },
    ];
    const closing = cashVarianceXaf(counted, expectedCashXaf(20_000, movements));
    expect(closing).toBe(-500);
    expect(statusAfterClose(closing)).toBe('PENDING_VALIDATION');

    const late = [
      ...movements,
      { direction: 'IN' as const, movementType: 'CUSTOMER_PAYMENT', amountXaf: 700 },
    ];
    const newExpected = expectedCashXaf(20_000, late);
    expect(newExpected).toBe(194_200);
    const delta = reevaluationDeltaXaf({
      countedXaf: counted,
      expectedXaf: newExpected,
      postedVarianceXaf: closing,
    });
    expect(delta).toBe(-700);
    expect(varianceMovement(delta)).toEqual({ amount: 700, direction: 'OUT' });
    // INV-FIN-11 : l'écart n'est compté qu'une fois.
    expect(closing + delta).toBe(cashVarianceXaf(counted, newExpected));
  });

  it('rien ne change : delta nul', () => {
    expect(
      reevaluationDeltaXaf({ countedXaf: 100, expectedXaf: 150, postedVarianceXaf: -50 }),
    ).toBe(0);
  });

  it('plusieurs réévaluations s’additionnent sans double compte', () => {
    let posted = -500;
    for (const expected of [194_200, 194_200, 193_900]) {
      posted += reevaluationDeltaXaf({
        countedXaf: 193_000,
        expectedXaf: expected,
        postedVarianceXaf: posted,
      });
    }
    expect(posted).toBe(cashVarianceXaf(193_000, 193_900));
  });
});

describe('statut, gravité et traitement', () => {
  it('écart nul : validé d’office ; sinon à valider (AV-057)', () => {
    expect(statusAfterClose(0)).toBe('VALIDATED');
    expect(statusAfterClose(-1)).toBe('PENDING_VALIDATION');
    expect(statusAfterClose(1)).toBe('PENDING_VALIDATION');
  });

  it('tolérance paramétrée : l’écart dans la tolérance est validé d’office', () => {
    expect(statusAfterClose(-200, 200)).toBe('VALIDATED');
    expect(statusAfterClose(-201, 200)).toBe('PENDING_VALIDATION');
    expect(() => statusAfterClose(0, -1)).toThrow(/tolérance/);
  });

  it('gravité de l’alerte : critique à partir du seuil (10 000 XAF, D13)', () => {
    expect(varianceSeverity(-9_999, 10_000)).toBe('WARNING');
    expect(varianceSeverity(-10_000, 10_000)).toBe('CRITICAL');
    expect(varianceSeverity(12_000, 10_000)).toBe('CRITICAL');
  });

  it('traitement d’une opération tardive selon l’état de la session', () => {
    expect(adjustmentTreatment('OPEN')).toBe('ABSORBED');
    expect(adjustmentTreatment('PENDING_VALIDATION')).toBe('INCLUDED_IN_VALIDATION');
    expect(adjustmentTreatment('VALIDATED')).toBe('OWN_APPROVAL');
  });

  it('séparation des tâches : le valideur n’est ni l’ouvreur, ni le clôtureur, ni l’auteur de la clôture forcée', () => {
    const involved = { openedBy: 'vendeur-1', closedBy: 'vendeur-2', forcedBy: 'responsable' };
    expect(isAllowedCashValidator('finance', involved)).toBe(true);
    expect(isAllowedCashValidator('vendeur-1', involved)).toBe(false);
    expect(isAllowedCashValidator('vendeur-2', involved)).toBe(false);
    expect(isAllowedCashValidator('responsable', involved)).toBe(false);
    expect(isAllowedCashValidator('finance', { openedBy: 'a', closedBy: null })).toBe(true);
  });
});

describe('remises de fonds (AV-153, ADR-032 §7)', () => {
  it('écart = reçu − envoyé : manque négatif, excédent positif', () => {
    expect(transferDiscrepancyXaf(173_000, 170_000)).toBe(-3_000);
    expect(transferDiscrepancyXaf(173_000, 173_000)).toBe(0);
    expect(transferDiscrepancyXaf(173_000, 174_000)).toBe(1_000);
  });

  it('statut à la réception', () => {
    expect(transferStatusAfterReceive(173_000, 173_000)).toBe('RECEIVED');
    expect(transferStatusAfterReceive(173_000, 170_000)).toBe('DISCREPANCY_PENDING');
    expect(transferStatusAfterReceive(173_000, 0)).toBe('DISCREPANCY_PENDING');
  });

  it('refuse des montants invalides', () => {
    expect(() => transferDiscrepancyXaf(0, 0)).toThrow(/invalides/);
    expect(() => transferDiscrepancyXaf(100, -1)).toThrow(/invalides/);
    expect(() => transferDiscrepancyXaf(100.5, 100)).toThrow();
  });

  it('aucun second débit : le manque est déjà dans les livres (envoi − réception)', () => {
    const sent = 173_000;
    const received = 170_000;
    const sourceDebit = sent; // TRANSFER_OUT du montant envoyé
    const destinationCredit = received; // TRANSFER_IN du montant reçu
    // L'argent disparu = débit − crédit = 3 000, jamais débité une seconde fois.
    expect(sourceDebit - destinationCredit).toBe(-transferDiscrepancyXaf(sent, received));
  });

  it('argent en transit : somme des remises envoyées et pas encore reçues', () => {
    expect(
      cashInTransitXaf([
        { status: 'SENT', amountSentXaf: 100_000 },
        { status: 'SENT', amountSentXaf: 23_000 },
        { status: 'RECEIVED', amountSentXaf: 50_000 },
        { status: 'CANCELLED', amountSentXaf: 9_000 },
      ]),
    ).toBe(123_000);
    expect(cashInTransitXaf([])).toBe(0);
  });
});
