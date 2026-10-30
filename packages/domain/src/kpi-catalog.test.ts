import { describe, expect, it } from 'vitest';
import { datasetOf } from './analytics-catalog.js';
import {
  KPI_CATALOG,
  kpiDefinitionOf,
  kpiHasPreviousPeriod,
  kpisToCreate,
  maskProtectedKpi,
} from './kpi-catalog.js';

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
      'KPI-OPS-02-CONFLICTS',
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
    for (const code of [
      'KPI-STK-02',
      'KPI-STK-04',
      'KPI-DIS-05',
      'KPI-FIN-07',
      'KPI-FIN-08',
      'KPI-PRD-09',
      'KPI-PRD-10',
    ]) {
      expect(kpiDefinitionOf(code)?.protected, code).toBe(true);
    }
  });

  it('les fonctions de référence créées en P9-15 et celle de la trésorerie existent ; plus aucun indicateur à créer (AV-462 livré en P9-27)', () => {
    for (const code of [
      'KPI-FIN-06',
      'KPI-STK-05',
      'KPI-COM-12',
      'KPI-COM-15',
      'KPI-PRD-02',
      'KPI-PRD-03',
    ]) {
      expect(kpiDefinitionOf(code)?.state, code).toBe('EXISTING');
    }
    // La mortalité d'un périmètre lit les déclarations de pertes : fonction d'`inventory`.
    expect(kpiDefinitionOf('KPI-PRD-02')?.module).toBe('inventory');
    // AV-462 choix (b) : les cinq indicateurs sans fonction de référence sont livrés en P9-27.
    expect(kpisToCreate()).toEqual([]);
    const delivered: Record<string, string> = {
      'KPI-COM-16': 'sales',
      'KPI-PRD-04': 'production',
      'KPI-PRD-05': 'production',
      'KPI-PRD-09': 'production',
      'KPI-OPS-02': 'sync',
      'KPI-OPS-02-CONFLICTS': 'sync',
    };
    for (const [code, module] of Object.entries(delivered)) {
      expect(kpiDefinitionOf(code)?.state, code).toBe('EXISTING');
      // Le réalisé d'une cible se compose avec les ventes : la fonction ne vit que dans `sales` (graphe).
      expect(kpiDefinitionOf(code)?.module, code).toBe(module);
    }
    // Seul l'aliment consommé a une mesure d'explorateur égale (la troisième assertion vérifie jeu et mesure).
    expect(kpiDefinitionOf('KPI-PRD-04')?.explorer).toEqual({
      dataset: 'f_production_daily',
      measure: 'feed_consumed',
    });
    for (const code of [
      'KPI-COM-16',
      'KPI-PRD-05',
      'KPI-PRD-09',
      'KPI-OPS-02',
      'KPI-OPS-02-CONFLICTS',
    ]) {
      expect(kpiDefinitionOf(code)?.explorer, code).toBeUndefined();
    }
    expect(kpiDefinitionOf('KPI-PRD-09')?.protected).toBe(true);
    expect(kpiDefinitionOf('KPI-OPS-02-CONFLICTS')).toMatchObject({
      nature: 'INSTANT',
      module: 'sync',
      reference: 'syncBacklog',
    });
    for (const kpi of KPI_CATALOG) expect(['EXISTING', 'TO_CREATE'], kpi.code).toContain(kpi.state);
  });

  it('maskProtectedKpi : un indicateur protégé perd valeur, période précédente, variation et lien ; les autres sont inchangés (TB-7)', () => {
    const flow = {
      code: 'KPI-FIN-08',
      value: 1200,
      previousValue: 900,
      variationPct: 33.3,
      explore: { definition: {} },
    };
    expect(maskProtectedKpi(flow)).toEqual({
      code: 'KPI-FIN-08',
      value: null,
      previousValue: null,
      variationPct: null,
      explore: null,
    });
    // Un solde n'a ni période précédente ni variation : les champs absents le restent.
    const instant = maskProtectedKpi({ code: 'KPI-STK-02', value: 5000 });
    expect(instant).toEqual({ code: 'KPI-STK-02', value: null });
    expect(instant).not.toHaveProperty('previousValue');
    // Non protégé ou inconnu : rendu tel quel (même objet).
    const open = { code: 'KPI-STK-06', value: 3, previousValue: null };
    expect(maskProtectedKpi(open)).toBe(open);
    const unknown = { code: 'KPI-INCONNU', value: 1 };
    expect(maskProtectedKpi(unknown)).toBe(unknown);
    // L'entrée n'est pas modifiée.
    expect(flow.value).toBe(1200);
  });

  it('la période précédente ne vaut que pour un flux (ADR-066 §2)', () => {
    expect(kpiHasPreviousPeriod('KPI-COM-08')).toBe(true);
    expect(kpiHasPreviousPeriod('KPI-FIN-01')).toBe(true);
    expect(kpiHasPreviousPeriod('KPI-STK-02')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-FIN-02')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-COM-11')).toBe(false);
    expect(kpiHasPreviousPeriod('KPI-INCONNU')).toBe(false);
    // Les cinq indicateurs de P9-27 : seul l'aliment consommé est un flux.
    expect(kpiHasPreviousPeriod('KPI-PRD-04')).toBe(true);
    for (const code of [
      'KPI-COM-16',
      'KPI-PRD-05',
      'KPI-PRD-09',
      'KPI-OPS-02',
      'KPI-OPS-02-CONFLICTS',
    ]) {
      expect(kpiHasPreviousPeriod(code), code).toBe(false);
    }
  });
});
