import { describe, expect, it } from 'vitest';
import {
  analyzeContinuity,
  checkInputContinuity,
  evaluateBackdating,
  extractSlipNumber,
  normalizeSlipRef,
} from './registre-carnets.js';

describe('registre-carnets (AV-308, AV-312, AV-078)', () => {
  describe('extractSlipNumber & normalizeSlipRef', () => {
    it('extrait le numéro dans des formats de référence variés', () => {
      expect(extractSlipNumber('BV-000142')).toBe(142);
      expect(extractSlipNumber('RE 45')).toBe(45);
      expect(extractSlipNumber('BD/2026/089')).toBe(89);
      expect(extractSlipNumber('00052')).toBe(52);
      expect(extractSlipNumber('TEST')).toBeNull();
      expect(extractSlipNumber('')).toBeNull();
    });

    it('normalise la référence', () => {
      expect(normalizeSlipRef(' bv 0012 ')).toBe('BV-0012');
      expect(normalizeSlipRef('re-045')).toBe('RE-045');
    });
  });

  describe('analyzeContinuity (AV-312)', () => {
    it('renvoie un rapport vide pour une liste vide', () => {
      const res = analyzeContinuity([]);
      expect(res.totalCount).toBe(0);
      expect(res.minNumber).toBeNull();
      expect(res.maxNumber).toBeNull();
      expect(res.missingNumbers).toEqual([]);
      expect(res.duplicates).toEqual([]);
    });

    it('détecte la continuité parfaite sans manquant ni doublon', () => {
      const refs = ['BV-001', 'BV-002', 'BV-003', 'BV-004'];
      const res = analyzeContinuity(refs);
      expect(res.totalCount).toBe(4);
      expect(res.uniqueCount).toBe(4);
      expect(res.minNumber).toBe(1);
      expect(res.maxNumber).toBe(4);
      expect(res.missingNumbers).toEqual([]);
      expect(res.duplicates).toEqual([]);
    });

    it('détecte les sauts dans la numérotation (numéros manquants)', () => {
      const refs = ['BV-001', 'BV-002', 'BV-005', 'BV-008'];
      const res = analyzeContinuity(refs);
      expect(res.minNumber).toBe(1);
      expect(res.maxNumber).toBe(8);
      expect(res.missingNumbers).toEqual([3, 4, 6, 7]);
    });

    it('détecte les doublons de référence', () => {
      const refs = ['RE-10', 'RE-11', 'RE-10', 'RE-12', 'RE-10'];
      const res = analyzeContinuity(refs);
      expect(res.totalCount).toBe(5);
      expect(res.uniqueCount).toBe(3);
      expect(res.duplicates).toEqual([{ ref: 'RE-10', count: 3 }]);
    });
  });

  describe('checkInputContinuity', () => {
    const existing = ['BV-0010', 'BV-0011', 'BV-0012'];

    it('signale un doublon si la référence existe déjà', () => {
      const check = checkInputContinuity('BV-0011', existing);
      expect(check.isDuplicate).toBe(true);
      expect(check.isGap).toBe(false);
    });

    it('signale un saut si le numéro est supérieur à max + 1', () => {
      const check = checkInputContinuity('BV-0015', existing);
      expect(check.isDuplicate).toBe(false);
      expect(check.isGap).toBe(true);
      expect(check.missingBefore).toEqual([13, 14]);
      expect(check.lastMaxNumber).toBe(12);
    });

    it('accepte le numéro suivant direct sans alerte de saut', () => {
      const check = checkInputContinuity('BV-0013', existing);
      expect(check.isDuplicate).toBe(false);
      expect(check.isGap).toBe(false);
      expect(check.missingBefore).toEqual([]);
    });
  });

  describe('evaluateBackdating (AV-078)', () => {
    const now = new Date('2026-11-03T18:00:00Z');

    it('détecte une saisie dans le délai courant (≤ 24 h)', () => {
      const occurred = '2026-11-03T10:00:00Z'; // 8 h avant
      const evalRes = evaluateBackdating(occurred, now);
      expect(evalRes.isBackdated).toBe(false);
      expect(evalRes.isCriticalDelay).toBe(false);
      expect(evalRes.requiresReason).toBe(false);
      expect(evalRes.isFuture).toBe(false);
    });

    it('impose un motif pour un report > 24 h', () => {
      const occurred = '2026-11-02T12:00:00Z'; // 30 h avant
      const evalRes = evaluateBackdating(occurred, now);
      expect(evalRes.isBackdated).toBe(true);
      expect(evalRes.isCriticalDelay).toBe(false);
      expect(evalRes.requiresReason).toBe(true);
    });

    it('signale un dépassement du délai maximal de 72 h', () => {
      const occurred = '2026-10-30T10:00:00Z'; // > 100 h avant
      const evalRes = evaluateBackdating(occurred, now);
      expect(evalRes.isBackdated).toBe(true);
      expect(evalRes.isCriticalDelay).toBe(true);
      expect(evalRes.requiresReason).toBe(true);
    });

    it('détecte une date future', () => {
      const occurred = '2026-11-04T12:00:00Z';
      const evalRes = evaluateBackdating(occurred, now);
      expect(evalRes.isFuture).toBe(true);
    });
  });
});
