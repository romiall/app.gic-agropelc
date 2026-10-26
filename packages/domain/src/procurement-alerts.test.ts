import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_PENDING_LONG_HOURS,
  APPROVAL_OPERATION_LABELS,
  MAX_APPROVAL_PENDING_LONG_HOURS,
  approvalOperationLabel,
  approvalPendingHours,
  approvalPendingLongHoursOrDefault,
} from './approval-alerts.js';
import {
  DEFAULT_ATTACHMENT_MISSING_ALERT_DAYS,
  DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS,
  MAX_ATTACHMENT_ALERT_DAYS,
  attachmentDaysMissing,
  attachmentMissingAlertDaysOrDefault,
  attachmentScanWindow,
  wholeDaysOrDefault,
} from './attachment-alerts.js';
import {
  DEFAULT_RECEIPT_INCOMPLETE_ALERT_DAYS,
  receiptIncompleteAlertDaysOrDefault,
  receiptIncompleteState,
  type ReceiptIncompleteLine,
} from './procurement-alerts.js';

const line = (overrides: Partial<ReceiptIncompleteLine> = {}): ReceiptIncompleteLine => ({
  ordered: 100,
  accepted: 0,
  closed: 0,
  cancelled: false,
  rejected: 0,
  unitCode: 'KG',
  ...overrides,
});

describe('receiptIncompleteState (BR-APP-015, AV-360, AV-414)', () => {
  const base = { today: '2026-10-20', thresholdDays: 2 };

  it('délai : 2 jours exactement n’alertent pas, le troisième jour oui (strict)', () => {
    const at = (expected: string) =>
      receiptIncompleteState({ ...base, lines: [line()], expectedDeliveryDay: expected });
    expect(at('2026-10-19')).toMatchObject({ daysLate: 1, overdue: false, incomplete: false });
    expect(at('2026-10-18')).toMatchObject({ daysLate: 2, overdue: false, incomplete: false });
    expect(at('2026-10-17')).toMatchObject({
      daysLate: 3,
      overdue: true,
      incomplete: true,
      reason: 'OVERDUE',
    });
  });

  it('date prévue absente, du jour ou à venir : jamais de retard', () => {
    for (const expected of [null, '2026-10-20', '2026-10-25']) {
      const state = receiptIncompleteState({
        ...base,
        lines: [line()],
        expectedDeliveryDay: expected,
      });
      expect(state).toMatchObject({ daysLate: null, overdue: false, incomplete: false });
    }
  });

  it('une quantité rejetée avec un reliquat alerte, même dans les délais ; sans reliquat, non', () => {
    const rejected = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-25',
      lines: [line({ accepted: 40, rejected: 5 })],
    });
    expect(rejected).toMatchObject({
      remaining: true,
      hasRejection: true,
      rejectedQuantity: 5,
      reason: 'REJECTED',
      incomplete: true,
    });
    const complete = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-25',
      lines: [line({ accepted: 100, rejected: 5 })],
    });
    expect(complete).toMatchObject({ remaining: false, incomplete: false, reason: null });
  });

  it('un reliquat clôturé ou une ligne annulée ne compte pas ; retard et rejet : BOTH', () => {
    const closed = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-01',
      lines: [line({ accepted: 60, closed: 40 }), line({ cancelled: true })],
    });
    expect(closed).toMatchObject({ remaining: false, remainingLines: 0, incomplete: false });
    const both = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-01',
      lines: [line({ accepted: 50, rejected: 2 })],
    });
    expect(both).toMatchObject({ reason: 'BOTH', daysLate: 19, remainingLines: 1 });
  });

  it('quantité rejetée de plusieurs unités : omise (une somme n’aurait pas de sens)', () => {
    const state = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-25',
      lines: [line({ rejected: 3, unitCode: 'KG' }), line({ rejected: 4, unitCode: 'SAC' })],
    });
    expect(state).toMatchObject({ hasRejection: true, rejectedQuantity: null, incomplete: true });
    const same = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-25',
      lines: [line({ rejected: 3 }), line({ rejected: 4.5 })],
    });
    expect(same.rejectedQuantity).toBe(7.5);
  });

  it('les décimales à trois chiffres se comparent sans erreur d’arrondi', () => {
    const state = receiptIncompleteState({
      ...base,
      expectedDeliveryDay: '2026-10-01',
      lines: [line({ ordered: 0.3, accepted: 0.1 + 0.2 })],
    });
    expect(state.remaining).toBe(false);
  });

  it('délai : 0 est admis (dès le lendemain), une valeur invalide revient à 2', () => {
    expect(DEFAULT_RECEIPT_INCOMPLETE_ALERT_DAYS).toBe(2);
    expect(receiptIncompleteAlertDaysOrDefault(0)).toBe(0);
    for (const bad of [undefined, null, -1, 1.5, '2', Number.NaN]) {
      expect(receiptIncompleteAlertDaysOrDefault(bad)).toBe(2);
    }
    const nextDay = receiptIncompleteState({
      today: '2026-10-20',
      thresholdDays: 0,
      expectedDeliveryDay: '2026-10-19',
      lines: [line()],
    });
    expect(nextDay.overdue).toBe(true);
  });
});

describe('demande de validation en attente depuis longtemps (AV-358, AV-416)', () => {
  const created = new Date('2026-10-19T08:00:00.000Z');

  it('24 h par défaut ; un nombre fini strictement positif est conservé', () => {
    expect(DEFAULT_APPROVAL_PENDING_LONG_HOURS).toBe(24);
    for (const bad of [undefined, null, 0, -4, Number.NaN, '12']) {
      expect(approvalPendingLongHoursOrDefault(bad)).toBe(24);
    }
    expect(approvalPendingLongHoursOrDefault(6)).toBe(6);
    expect(approvalPendingLongHoursOrDefault(0.5)).toBe(0.5);
  });

  it('plafond : un délai démesuré est ramené à dix ans (la coupure reste une date valide)', () => {
    expect(MAX_APPROVAL_PENDING_LONG_HOURS).toBe(87_600);
    expect(approvalPendingLongHoursOrDefault(87_600)).toBe(87_600);
    expect(approvalPendingLongHoursOrDefault(87_601)).toBe(87_600);
    expect(approvalPendingLongHoursOrDefault(1e12)).toBe(87_600);
    const now = new Date('2026-10-20T08:00:00.000Z');
    const cutoff = new Date(
      now.getTime() - approvalPendingLongHoursOrDefault(Number.MAX_SAFE_INTEGER) * 3_600_000,
    );
    expect(Number.isNaN(cutoff.getTime())).toBe(false);
  });

  it('heures entières d’attente, jamais négatives', () => {
    expect(approvalPendingHours(created, new Date('2026-10-20T15:59:59.000Z'))).toBe(31);
    expect(approvalPendingHours(created, new Date('2026-10-19T07:00:00.000Z'))).toBe(0);
  });

  it('libellés français : un type inconnu retombe sur son code, les 22 types connus sont libellés', () => {
    expect(Object.keys(APPROVAL_OPERATION_LABELS)).toHaveLength(22);
    expect(approvalOperationLabel('MORTALITY')).toBe('Mortalité');
    expect(approvalOperationLabel('INCONNU')).toBe('INCONNU');
  });
});

describe('pièce manquante (AV-357, AV-399, AV-417)', () => {
  it('délai : 7 jours par défaut, 0 désactive, une valeur invalide revient au défaut', () => {
    expect(DEFAULT_ATTACHMENT_MISSING_ALERT_DAYS).toBe(7);
    expect(attachmentMissingAlertDaysOrDefault(0)).toBe(0);
    expect(attachmentMissingAlertDaysOrDefault(14)).toBe(14);
    for (const bad of [undefined, null, -1, 2.5, '7', Number.NaN]) {
      expect(attachmentMissingAlertDaysOrDefault(bad)).toBe(7);
    }
    expect(wholeDaysOrDefault(3, 9)).toBe(3);
    expect(wholeDaysOrDefault('x', 9)).toBe(9);
  });

  it('fenêtre : horizon de 90 jours, jamais sous le délai plus un jour', () => {
    const now = new Date('2026-10-20T06:15:00.000Z');
    expect(DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS).toBe(90);
    const standard = attachmentScanWindow(now, 7, undefined);
    expect(standard.horizonDays).toBe(90);
    expect(standard.newest.toISOString()).toBe('2026-10-13T06:15:00.000Z');
    expect(standard.oldest.toISOString()).toBe('2026-07-22T06:15:00.000Z');
    // Horizon trop court ou nul : le délai plus un jour (ou le défaut pour 0).
    expect(attachmentScanWindow(now, 7, 3).horizonDays).toBe(8);
    expect(attachmentScanWindow(now, 7, 0).horizonDays).toBe(90);
    expect(attachmentScanWindow(now, 100, undefined).horizonDays).toBe(101);
  });

  it('plafond : un délai ou un horizon démesuré est ramené à dix ans (la fenêtre reste valide)', () => {
    expect(MAX_ATTACHMENT_ALERT_DAYS).toBe(3650);
    expect(wholeDaysOrDefault(3650, 7)).toBe(3650);
    expect(wholeDaysOrDefault(3651, 7)).toBe(3650);
    expect(attachmentMissingAlertDaysOrDefault(Number.MAX_SAFE_INTEGER)).toBe(3650);
    const now = new Date('2026-10-20T06:15:00.000Z');
    const window = attachmentScanWindow(now, 3650, Number.MAX_SAFE_INTEGER);
    expect(window.horizonDays).toBe(3651);
    expect(Number.isNaN(window.oldest.getTime())).toBe(false);
    expect(Number.isNaN(window.newest.getTime())).toBe(false);
  });

  it('jours écoulés depuis la réception par le serveur', () => {
    const now = new Date('2026-10-20T06:15:00.000Z');
    expect(attachmentDaysMissing(new Date('2026-10-12T06:15:00.000Z'), now)).toBe(8);
    expect(attachmentDaysMissing(new Date('2026-10-13T06:15:01.000Z'), now)).toBe(6);
    expect(attachmentDaysMissing(new Date('2026-10-21T06:15:00.000Z'), now)).toBe(0);
  });
});
