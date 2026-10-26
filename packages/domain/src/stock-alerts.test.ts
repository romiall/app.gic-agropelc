import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIGH_LOSS_ALERT_XAF,
  DEFAULT_HIGH_LOSS_SALES_PCT,
  DEFAULT_LOT_EXPIRING_DAYS,
  DEFAULT_POS_REPLENISH_SCOPE,
  DEFAULT_TRANSFER_NOT_RECEIVED_HOURS,
  elapsedHours,
  highLossAlertXafOrDefault,
  highLossSalesPctOrDefault,
  isHighLossAbsolute,
  isHighLossSalesShare,
  isTransferNotReceived,
  lossSalesSharePct,
  lotDaysLeft,
  MAX_LOT_EXPIRING_DAYS,
  lotExpiringDaysOrDefault,
  lotExpiringHorizonDay,
  needsReplenishment,
  posReplenishScopeOrDefault,
  stockLevelChanges,
  stockLevelOfState,
  stockThresholdStateOf,
  transferNotReceivedHoursOrDefault,
} from './stock-alerts.js';

describe('stockThresholdStateOf (BR-STK-051)', () => {
  it('rupture à zéro et en dessous, bas sous le minimum, sinon correct', () => {
    expect(stockThresholdStateOf({ available: 0, minQty: 10 })).toBe('STOCK_OUT');
    expect(stockThresholdStateOf({ available: -3, minQty: 10 })).toBe('STOCK_OUT');
    expect(stockThresholdStateOf({ available: 0.001, minQty: 10 })).toBe('STOCK_LOW');
    expect(stockThresholdStateOf({ available: 9.999, minQty: 10 })).toBe('STOCK_LOW');
    expect(stockThresholdStateOf({ available: 10, minQty: 10 })).toBe('OK');
  });
  it('un minimum nul : jamais bas, seulement en rupture', () => {
    expect(stockThresholdStateOf({ available: 0, minQty: 0 })).toBe('STOCK_OUT');
    expect(stockThresholdStateOf({ available: 1, minQty: 0 })).toBe('OK');
  });
});

describe('stockLevelChanges (AV-355)', () => {
  it('sans changement d’état : aucun événement', () => {
    expect(stockLevelChanges('OK', 'OK')).toEqual([]);
    expect(stockLevelChanges('STOCK_LOW', 'STOCK_LOW')).toEqual([]);
    expect(stockLevelChanges('STOCK_OUT', 'STOCK_OUT')).toEqual([]);
  });
  it('OK → LOW : lève LOW', () => {
    expect(stockLevelChanges('OK', 'STOCK_LOW')).toEqual([{ level: 'LOW', breached: true }]);
  });
  it('OK → OUT : lève OUT seul', () => {
    expect(stockLevelChanges('OK', 'STOCK_OUT')).toEqual([{ level: 'OUT', breached: true }]);
  });
  it('LOW → OUT : met fin à LOW puis lève OUT', () => {
    expect(stockLevelChanges('STOCK_LOW', 'STOCK_OUT')).toEqual([
      { level: 'LOW', breached: false },
      { level: 'OUT', breached: true },
    ]);
  });
  it('OUT → LOW : met fin à OUT puis lève LOW', () => {
    expect(stockLevelChanges('STOCK_OUT', 'STOCK_LOW')).toEqual([
      { level: 'OUT', breached: false },
      { level: 'LOW', breached: true },
    ]);
  });
  it('retour à la normale : met fin au niveau quitté', () => {
    expect(stockLevelChanges('STOCK_LOW', 'OK')).toEqual([{ level: 'LOW', breached: false }]);
    expect(stockLevelChanges('STOCK_OUT', 'OK')).toEqual([{ level: 'OUT', breached: false }]);
  });
  it('niveau de l’état', () => {
    expect(stockLevelOfState('OK')).toBeNull();
    expect(stockLevelOfState('STOCK_LOW')).toBe('LOW');
    expect(stockLevelOfState('STOCK_OUT')).toBe('OUT');
  });
});

describe('POS_REPLENISH (AV-402)', () => {
  it('portée par défaut : sous la cible ; valeur invalide : défaut', () => {
    expect(DEFAULT_POS_REPLENISH_SCOPE).toBe('BELOW_TARGET');
    expect(posReplenishScopeOrDefault('BELOW_MINIMUM')).toBe('BELOW_MINIMUM');
    expect(posReplenishScopeOrDefault('BELOW_TARGET')).toBe('BELOW_TARGET');
    expect(posReplenishScopeOrDefault('autre')).toBe('BELOW_TARGET');
    expect(posReplenishScopeOrDefault(12)).toBe('BELOW_TARGET');
    expect(posReplenishScopeOrDefault(undefined)).toBe('BELOW_TARGET');
  });
  it('sous la cible : toute suggestion positive', () => {
    expect(needsReplenishment({ scope: 'BELOW_TARGET', state: 'OK', suggestedQty: 1 })).toBe(true);
    expect(needsReplenishment({ scope: 'BELOW_TARGET', state: 'OK', suggestedQty: 0 })).toBe(false);
  });
  it('sous le minimum : la suggestion doit être positive et l’état dégradé', () => {
    expect(needsReplenishment({ scope: 'BELOW_MINIMUM', state: 'OK', suggestedQty: 5 })).toBe(
      false,
    );
    expect(
      needsReplenishment({ scope: 'BELOW_MINIMUM', state: 'STOCK_LOW', suggestedQty: 5 }),
    ).toBe(true);
    expect(
      needsReplenishment({ scope: 'BELOW_MINIMUM', state: 'STOCK_OUT', suggestedQty: 5 }),
    ).toBe(true);
    // Le transit entrant couvre déjà la cible : plus rien à suggérer.
    expect(
      needsReplenishment({ scope: 'BELOW_MINIMUM', state: 'STOCK_LOW', suggestedQty: 0 }),
    ).toBe(false);
  });
});

describe('TRANSFER_NOT_RECEIVED (AV-408)', () => {
  it('repli à 48 h pour un paramètre absent, nul, négatif ou non numérique', () => {
    expect(DEFAULT_TRANSFER_NOT_RECEIVED_HOURS).toBe(48);
    expect(transferNotReceivedHoursOrDefault(24)).toBe(24);
    expect(transferNotReceivedHoursOrDefault(0)).toBe(48);
    expect(transferNotReceivedHoursOrDefault(-5)).toBe(48);
    expect(transferNotReceivedHoursOrDefault('12')).toBe(48);
    expect(transferNotReceivedHoursOrDefault(undefined)).toBe(48);
    expect(transferNotReceivedHoursOrDefault(Number.NaN)).toBe(48);
  });
  it('échéance : borne atteinte comprise', () => {
    const dispatched = new Date('2026-10-10T08:00:00.000Z');
    expect(isTransferNotReceived(dispatched, new Date('2026-10-12T07:59:59.999Z'), 48)).toBe(false);
    expect(isTransferNotReceived(dispatched, new Date('2026-10-12T08:00:00.000Z'), 48)).toBe(true);
  });
  it('heures écoulées : entières, jamais négatives', () => {
    const since = new Date('2026-10-10T08:00:00.000Z');
    expect(elapsedHours(since, new Date('2026-10-12T09:59:59.000Z'))).toBe(49);
    expect(elapsedHours(since, new Date('2026-10-10T07:00:00.000Z'))).toBe(0);
  });
});

describe('LOT_EXPIRING (AV-404)', () => {
  it('repli à 15 jours ; 0 admis (périmé ou périmant aujourd’hui)', () => {
    expect(DEFAULT_LOT_EXPIRING_DAYS).toBe(15);
    expect(lotExpiringDaysOrDefault(30)).toBe(30);
    expect(lotExpiringDaysOrDefault(0)).toBe(0);
    expect(lotExpiringDaysOrDefault(-1)).toBe(15);
    expect(lotExpiringDaysOrDefault(2.5)).toBe(15);
    expect(lotExpiringDaysOrDefault('7')).toBe(15);
    // Plafond de dix ans : un horizon démesuré reste une date valide (la passe ne lève pas).
    expect(lotExpiringDaysOrDefault(3650)).toBe(3650);
    expect(lotExpiringDaysOrDefault(MAX_LOT_EXPIRING_DAYS + 1)).toBe(3650);
    expect(lotExpiringDaysOrDefault(Number.MAX_SAFE_INTEGER)).toBe(3650);
    expect(lotExpiringHorizonDay('2026-10-16', Number.MAX_SAFE_INTEGER)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
  it('horizon et jours restants en jours du calendrier', () => {
    expect(lotExpiringHorizonDay('2026-10-15', 15)).toBe('2026-10-30');
    expect(lotExpiringHorizonDay('2026-12-20', 15)).toBe('2027-01-04');
    expect(lotDaysLeft('2026-10-30', '2026-10-15')).toBe(15);
    expect(lotDaysLeft('2026-10-15', '2026-10-15')).toBe(0);
    expect(lotDaysLeft('2026-10-10', '2026-10-15')).toBe(-5);
  });
});

describe('HIGH_LOSS (AV-356, AV-403)', () => {
  it('seuil absolu : repli à 50 000, 0 admis, borne atteinte comprise', () => {
    expect(DEFAULT_HIGH_LOSS_ALERT_XAF).toBe(50_000);
    expect(highLossAlertXafOrDefault(80_000)).toBe(80_000);
    expect(highLossAlertXafOrDefault(0)).toBe(0);
    expect(highLossAlertXafOrDefault(-1)).toBe(50_000);
    expect(highLossAlertXafOrDefault('x')).toBe(50_000);
    expect(isHighLossAbsolute({ valueXaf: 49_999, thresholdXaf: 50_000 })).toBe(false);
    expect(isHighLossAbsolute({ valueXaf: 50_000, thresholdXaf: 50_000 })).toBe(true);
  });
  it('une perte sans valeur n’alerte jamais, même avec un seuil nul', () => {
    expect(isHighLossAbsolute({ valueXaf: 0, thresholdXaf: 0 })).toBe(false);
    expect(isHighLossAbsolute({ valueXaf: 1, thresholdXaf: 0 })).toBe(true);
  });
});

describe('HIGH_LOSS : part des ventes du jour (AV-356, AV-405)', () => {
  it('pourcentage : repli à 5, strictement positif', () => {
    expect(DEFAULT_HIGH_LOSS_SALES_PCT).toBe(5);
    expect(highLossSalesPctOrDefault(2.5)).toBe(2.5);
    expect(highLossSalesPctOrDefault(0)).toBe(5);
    expect(highLossSalesPctOrDefault(-3)).toBe(5);
    expect(highLossSalesPctOrDefault(null)).toBe(5);
  });
  it('part de la perte : au dixième, absente sans vente', () => {
    expect(lossSalesSharePct(5_000, 100_000)).toBe(5);
    expect(lossSalesSharePct(1_234, 100_000)).toBe(1.2);
    expect(lossSalesSharePct(10, 0)).toBeNull();
    expect(lossSalesSharePct(10, -5)).toBeNull();
  });
  it('seuil atteint : borne comprise, sans vente ou sans perte jamais', () => {
    expect(isHighLossSalesShare({ lossValueXaf: 4_999, salesNetXaf: 100_000, pct: 5 })).toBe(false);
    expect(isHighLossSalesShare({ lossValueXaf: 5_000, salesNetXaf: 100_000, pct: 5 })).toBe(true);
    expect(isHighLossSalesShare({ lossValueXaf: 5_000, salesNetXaf: 0, pct: 5 })).toBe(false);
    expect(isHighLossSalesShare({ lossValueXaf: 0, salesNetXaf: 100_000, pct: 5 })).toBe(false);
  });
  it('un pourcentage invalide retombe sur 5 %', () => {
    expect(isHighLossSalesShare({ lossValueXaf: 5_000, salesNetXaf: 100_000, pct: -1 })).toBe(true);
    expect(isHighLossSalesShare({ lossValueXaf: 4_000, salesNetXaf: 100_000, pct: -1 })).toBe(
      false,
    );
  });
});
