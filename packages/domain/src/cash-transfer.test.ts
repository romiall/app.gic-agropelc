import { describe, expect, it } from 'vitest';
import {
  CASH_TRANSFER_DEFAULT_SERIES_CODE,
  DEFAULT_CASH_TRANSFER_PAIRS,
  DEFAULT_CASH_TRANSFER_UNRECEIVED_HOURS,
  cashTransferPairsFrom,
  cashTransferSeriesCodeFrom,
  cashTransferUnreceivedHoursFrom,
  checkTransferImputation,
  decideCashTransferAction,
  isAllowedTransferReceiver,
  isAllowedTransferValidator,
  isCashTransferPairAllowed,
  isTransferUnreceived,
} from './cash-transfer.js';
import { DomainError } from './errors.js';

const at = (iso: string) => new Date(iso);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'AUTRE';
  }
  return undefined;
}

describe('paires de comptes admises (AV-158)', () => {
  it('défaut : caisses vers la centrale ou la banque, fonds de PDV, retrait de banque, mobile money', () => {
    const allowed = (from: string, to: string) => isCashTransferPairAllowed(from, to);
    expect(allowed('CAISSE_PDV', 'CAISSE_CENTRALE')).toBe(true);
    expect(allowed('CAISSE_PDV', 'BANQUE')).toBe(true);
    expect(allowed('CAISSE_UTILISATEUR', 'CAISSE_CENTRALE')).toBe(true);
    expect(allowed('CAISSE_UTILISATEUR', 'BANQUE')).toBe(true);
    expect(allowed('CAISSE_CENTRALE', 'CAISSE_PDV')).toBe(true);
    expect(allowed('CAISSE_CENTRALE', 'BANQUE')).toBe(true);
    expect(allowed('BANQUE', 'CAISSE_CENTRALE')).toBe(true);
    expect(allowed('MOBILE_MONEY', 'CAISSE_CENTRALE')).toBe(true);
    expect(allowed('MOBILE_MONEY', 'BANQUE')).toBe(true);
  });

  it('défaut : aucune remise vers une caisse d’utilisateur, du mobile money, ni d’un type vers lui-même', () => {
    const allowed = (from: string, to: string) => isCashTransferPairAllowed(from, to);
    expect(allowed('CAISSE_PDV', 'CAISSE_UTILISATEUR')).toBe(false);
    expect(allowed('CAISSE_CENTRALE', 'CAISSE_UTILISATEUR')).toBe(false);
    expect(allowed('BANQUE', 'CAISSE_PDV')).toBe(false);
    expect(allowed('CAISSE_PDV', 'MOBILE_MONEY')).toBe(false);
    expect(allowed('CAISSE_PDV', 'CAISSE_PDV')).toBe(false);
    expect(allowed('INCONNU', 'BANQUE')).toBe(false);
  });

  it('paramètre : un objet valide remplace le défaut', () => {
    const pairs = cashTransferPairsFrom({ CAISSE_PDV: ['BANQUE'] });
    expect(isCashTransferPairAllowed('CAISSE_PDV', 'BANQUE', pairs)).toBe(true);
    expect(isCashTransferPairAllowed('CAISSE_PDV', 'CAISSE_CENTRALE', pairs)).toBe(false);
    expect(isCashTransferPairAllowed('CAISSE_CENTRALE', 'BANQUE', pairs)).toBe(false);
  });

  it('paramètre mal formé ou absent : repli sur le défaut', () => {
    for (const value of [
      undefined,
      null,
      42,
      'CAISSE_PDV',
      ['CAISSE_PDV'],
      { CAISSE_PDV: 'BANQUE' },
      { CAISSE_PDV: ['COFFRE'] },
      { COFFRE: ['BANQUE'] },
      { CAISSE_PDV: [1] },
    ]) {
      expect(cashTransferPairsFrom(value)).toBe(DEFAULT_CASH_TRANSFER_PAIRS);
    }
  });
});

describe('séparation des tâches (AV-158, AV-172, AV-174)', () => {
  it('le récepteur n’est jamais l’expéditeur', () => {
    expect(isAllowedTransferReceiver('u1', 'u1')).toBe(false);
    expect(isAllowedTransferReceiver('u2', 'u1')).toBe(true);
  });

  it('le valideur n’est ni l’expéditeur, ni le récepteur, ni le porteur', () => {
    const involved = { sentBy: 'e', receivedBy: 'r', carrierUserId: 'p' };
    expect(isAllowedTransferValidator('e', involved)).toBe(false);
    expect(isAllowedTransferValidator('r', involved)).toBe(false);
    expect(isAllowedTransferValidator('p', involved)).toBe(false);
    expect(isAllowedTransferValidator('f', involved)).toBe(true);
    expect(isAllowedTransferValidator('f', { ...involved, carrierUserId: null })).toBe(true);
  });
});

describe('imputation d’un écart (AV-153, AV-174)', () => {
  const noCarrier = { carrierUserId: null, carrierName: null };
  it('une imputation connue est retenue', () => {
    expect(checkTransferImputation('COMPANY', noCarrier)).toBe('COMPANY');
    expect(checkTransferImputation('CARRIER', { carrierUserId: null, carrierName: 'Paul' })).toBe(
      'CARRIER',
    );
    expect(checkTransferImputation('CARRIER', { carrierUserId: 'p', carrierName: null })).toBe(
      'CARRIER',
    );
  });

  it('absente ou inconnue : exigée ; porteur sans porteur connu : invalide', () => {
    expect(codeOf(() => checkTransferImputation(undefined, noCarrier))).toBe(
      'CASH_TRANSFER_IMPUTATION_REQUIRED',
    );
    expect(codeOf(() => checkTransferImputation('VOLEUR', noCarrier))).toBe(
      'CASH_TRANSFER_IMPUTATION_REQUIRED',
    );
    expect(codeOf(() => checkTransferImputation('CARRIER', noCarrier))).toBe(
      'CASH_TRANSFER_IMPUTATION_INVALID',
    );
  });
});

describe('remise non reçue (AV-158 : 48 h)', () => {
  const sentAt = at('2026-10-06T17:00:00Z');

  it('en retard à partir de sent_at + heures, bord inclus', () => {
    expect(isTransferUnreceived(sentAt, at('2026-10-08T16:59:00Z'), 48)).toBe(false);
    expect(isTransferUnreceived(sentAt, at('2026-10-08T17:00:00Z'), 48)).toBe(true);
    expect(isTransferUnreceived(sentAt, at('2026-10-08T18:00:00Z'), 48)).toBe(true);
  });

  it('heures invalides : erreur de domaine', () => {
    expect(codeOf(() => isTransferUnreceived(sentAt, sentAt, 0))).toBe('HOURS_INVALID');
    expect(codeOf(() => isTransferUnreceived(sentAt, sentAt, 1.5))).toBe('HOURS_INVALID');
  });

  it('paramètre : entier strictement positif, sinon 48', () => {
    expect(cashTransferUnreceivedHoursFrom(24)).toBe(24);
    expect(cashTransferUnreceivedHoursFrom('72')).toBe(72);
    for (const value of [undefined, null, 0, -5, 1.5, 'abc', '', {}]) {
      expect(cashTransferUnreceivedHoursFrom(value)).toBe(DEFAULT_CASH_TRANSFER_UNRECEIVED_HOURS);
    }
  });
});

describe('série globale de numérotation (AV-176)', () => {
  it('code de 1 à 10 lettres majuscules ou chiffres, sinon SIEGE', () => {
    expect(cashTransferSeriesCodeFrom('BUREAU1')).toBe('BUREAU1');
    for (const value of [undefined, '', 'siege', 'SIEGE-1', 'A'.repeat(11), 12]) {
      expect(cashTransferSeriesCodeFrom(value)).toBe(CASH_TRANSFER_DEFAULT_SERIES_CODE);
    }
  });
});

describe('transitions et courses hors ligne (SM-CASH-TRANSFER, ADR-032 §8, AV-173)', () => {
  it('une remise envoyée se reçoit ou s’annule, en ligne comme hors ligne', () => {
    for (const offline of [false, true]) {
      expect(decideCashTransferAction('SENT', 'RECEIVE', offline)).toEqual({ kind: 'APPLY' });
      expect(decideCashTransferAction('SENT', 'CANCEL', offline)).toEqual({ kind: 'APPLY' });
    }
  });

  it('remise annulée : seconde annulation sans effet ; réception refusée en ligne, observée hors ligne', () => {
    expect(decideCashTransferAction('CANCELLED', 'CANCEL', false)).toEqual({ kind: 'NOOP' });
    expect(decideCashTransferAction('CANCELLED', 'CANCEL', true)).toEqual({ kind: 'NOOP' });
    expect(decideCashTransferAction('CANCELLED', 'RECEIVE', false)).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_TRANSFER_CANCELLED',
    });
    expect(decideCashTransferAction('CANCELLED', 'RECEIVE', true)).toEqual({
      kind: 'OBSERVE',
      code: 'CASH_TRANSFER_RECEIVED_AFTER_CANCEL',
    });
  });

  it.each(['RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED'])(
    'remise déjà reçue (%s) : refus en ligne, observation hors ligne',
    (status) => {
      expect(decideCashTransferAction(status, 'RECEIVE', false)).toMatchObject({
        kind: 'REJECT',
        code: 'CASH_TRANSFER_ALREADY_RECEIVED',
        messageFr: 'Remise déjà reçue.',
      });
      expect(decideCashTransferAction(status, 'CANCEL', false)).toMatchObject({
        kind: 'REJECT',
        code: 'CASH_TRANSFER_ALREADY_RECEIVED',
      });
      expect(decideCashTransferAction(status, 'RECEIVE', true)).toEqual({
        kind: 'OBSERVE',
        code: 'CASH_TRANSFER_RECEIVED_TWICE',
      });
      expect(decideCashTransferAction(status, 'CANCEL', true)).toEqual({
        kind: 'OBSERVE',
        code: 'CASH_TRANSFER_CANCEL_AFTER_RECEIVE',
      });
    },
  );

  it('état inconnu : erreur de domaine', () => {
    expect(codeOf(() => decideCashTransferAction('PERDU', 'RECEIVE', false))).toBe(
      'CASH_TRANSFER_STATUS_INVALID',
    );
  });
});
