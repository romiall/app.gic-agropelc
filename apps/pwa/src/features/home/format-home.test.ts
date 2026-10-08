import { describe, expect, it } from 'vitest';
import {
  formatBusinessDay,
  formatClockTime,
  formatKpiValue,
  formatMoment,
  sparklinePoints,
} from './format-home.js';

describe('formatKpiValue', () => {
  it('montants en francs CFA entiers, milliers séparés', () => {
    expect(formatKpiValue(1234567, 'XAF')).toBe('1 234 567 F CFA');
    expect(formatKpiValue(0, 'XAF')).toBe('0 F CFA');
    expect(formatKpiValue(1999.6, 'XAF')).toBe('2 000 F CFA');
  });

  it('valeur absente : tiret, jamais zéro', () => {
    expect(formatKpiValue(null, 'XAF')).toBe('—');
    expect(formatKpiValue(null, 'COUNT')).toBe('—');
  });

  it('effectifs, pourcentages, poids et comptes', () => {
    expect(formatKpiValue(1, 'HEADS')).toBe('1 tête');
    expect(formatKpiValue(1250, 'HEADS')).toBe('1 250 têtes');
    expect(formatKpiValue(12.5, 'PERCENT')).toBe('12,5 %');
    expect(formatKpiValue(80.25, 'KG')).toBe('80,3 kg');
    expect(formatKpiValue(3, 'COUNT')).toBe('3');
  });
});

describe('formatBusinessDay', () => {
  it('jour métier en toutes lettres, sans décalage de fuseau', () => {
    expect(formatBusinessDay('2026-10-08')).toBe('jeudi 8 octobre');
    expect(formatBusinessDay('2026-01-01')).toBe('jeudi 1 janvier');
  });

  it('format inattendu : renvoyé tel quel', () => {
    expect(formatBusinessDay('hier')).toBe('hier');
  });
});

describe('formatClockTime', () => {
  it('heure de Douala (UTC+1)', () => {
    expect(formatClockTime('2026-10-08T13:32:00.000Z')).toBe('14:32');
    expect(formatClockTime('2026-10-08T23:05:00.000Z')).toBe('00:05');
  });

  it('instant invalide : chaîne vide', () => {
    expect(formatClockTime('pas une date')).toBe('');
  });
});

describe('formatMoment', () => {
  it('le jour même : l’heure seule', () => {
    expect(formatMoment('2026-10-08T13:32:00.000Z', '2026-10-08')).toBe('14:32');
  });

  it('un autre jour : la date courte puis l’heure', () => {
    expect(formatMoment('2026-10-06T08:05:00.000Z', '2026-10-08')).toBe('6 oct. 09:05');
  });

  it('le jour est celui de Douala, pas celui d’UTC', () => {
    // 23 h 30 UTC = 00 h 30 le lendemain à Douala.
    expect(formatMoment('2026-10-07T23:30:00.000Z', '2026-10-08')).toBe('00:30');
  });
});

describe('sparklinePoints', () => {
  it('série vide : aucun point', () => {
    expect(sparklinePoints([], 100, 28)).toBe('');
  });

  it('le minimum est en bas, le maximum en haut', () => {
    const points = sparklinePoints([0, 10], 100, 30, 3).split(' ');
    expect(points).toEqual(['3.0,27.0', '97.0,3.0']);
  });

  it('série plate : trait à mi-hauteur', () => {
    const points = sparklinePoints([5, 5, 5], 100, 30, 3).split(' ');
    expect(points.every((point) => point.endsWith(',15.0'))).toBe(true);
  });

  it('un seul point : posé au bord gauche', () => {
    expect(sparklinePoints([7], 100, 30, 3)).toBe('3.0,15.0');
  });
});
