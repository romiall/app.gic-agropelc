import { describe, expect, it } from 'vitest';
import { datasetOf } from './analytics-catalog.js';
import { KPI_CATALOG, kpiDefinitionOf, kpiHasPreviousPeriod, kpisToCreate } from './kpi-catalog.js';

/** Codes de D11 §7.1 (hors codes locaux de l'accueil, testés à part). */
const D11_CODES = [
  ...Array.from({ length: 18 }, (_, i) => `KPI-COM-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, i) => `KPI-STK-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, i) => `KPI-DIS-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `KPI-PRD-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `KPI-FIN-${String(i + 1).padStart(2, '0')}`),
  'KPI-APP-01',
  'KPI-APP-02',
  'KPI-OPS-01',
  'KPI-OPS-02',
];

describe('registre des indicateurs (BR-ANA-009, ADR-065 §1)', () => {
  it('couvre chaque code de D11 §7.1 et les codes locaux de distribution, sans doublon', () => {
    const codes = KPI_CATALOG.map((k) => k.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of D11_CODES) expect(codes).toContain(code);
    for (const local of [
      'KPI-FIN-CS-PENDING',
      'KPI-FIN-CS-VAR',
      'KPI-FIN-TRANSFERS',
      'KPI-DIS-QUOTAS',
    ]) {
      expect(codes).toContain(local);
    }
  });

  it('la définition du chiffre d’affaires et des ventes est celle de period-activity (ADR-041)', () => {
    for (const code of ['KPI-COM-07', 'KPI-COM-08', 'KPI-COM-09']) {
      const kpi = kpiDefinitionOf(code)!;
      expect(kpi.module).toBe('sales');
      expect(kpi.reference).toBe('salesActivityByDay');
      expect(kpi.state).toBe('EXISTING');
    }
  });

  it('chaque indicateur d’explorateur désigne un jeu et une mesure déclarés ; protégé = mesure protégée', () => {
    for (const kpi of KPI_CATALOG) {
      if (kpi.explorer === undefined) continue;
      const dataset = datasetOf(kpi.explorer.dataset);
      expect(dataset, `${kpi.code} : jeu ${kpi.explorer.dataset}`).toBeDefined();
      const measure = dataset!.measures.find((m) => m.name === kpi.explorer!.measure);
      expect(measure, `${kpi.code} : mesure ${kpi.explorer.measure}`).toBeDefined();
      if (measure!.protected === true) expect(kpi.protected).toBe(true);
    }
  });

  it('un indicateur valorisé au coût est marqué protégé (RC-05)', () => {
    for (const code of ['KPI-STK-02', 'KPI-FIN-07', 'KPI-FIN-08', 'KPI-PRD-09', 'KPI-PRD-10']) {
      expect(kpiDefinitionOf(code)?.protected).toBe(true);
    }
  });

  it('toutes les fonctions de référence créées en P9-15 existent : plus aucun indicateur à créer', () => {
    expect(kpisToCreate()).toEqual([]);
    for (const code of ['KPI-STK-05', 'KPI-COM-12', 'KPI-COM-15', 'KPI-PRD-02', 'KPI-PRD-03']) {
      expect(kpiDefinitionOf(code)?.state).toBe('EXISTING');
    }
    // La mortalité d'un périmètre lit les déclarations de pertes : fonction d'`inventory`.
    expect(kpiDefinitionOf('KPI-PRD-02')?.module).toBe('inventory');
  });

  it('la période précédente ne vaut que pour un flux (ADR-066 §2)', () => {
    expect(kpiHasPreviousPeriod('KPI-COM-08')).toBe(true);
    expect(kpiHasPreviousPeriod('KPI-FIN-01')).toBe(true);
    expect(kpiHasPreviousPeriod('KPI-STK-02')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-FIN-02')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-COM-11')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-INCONNU')).toBe(false);
  });
});
