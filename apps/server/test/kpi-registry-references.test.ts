/**
 * P9-25 (EP-5 ; ADR-065 §1, BR-ANA-009) — les références du registre des indicateurs sont exactes, sans base : chaque
 * fonction de référence d'un indicateur `EXISTING` est exportée par l'API publique de son module ; aucune fonction de
 * référence d'un indicateur `TO_CREATE` ne l'est encore (le jour où elle existe, l'état doit changer). Depuis P9-27
 * (AV-462 choix (b)) aucun indicateur n'est plus à créer : la liste `TO_CREATE` est vide.
 *
 * Aucune connexion de base : les API publiques sont importées statiquement, `helpers.ts` ne l'est pas (il lève sans
 * `SERVER_DATABASE_URL`) et rien ne ferme de connexion. Le module `sync` n'a pas d'API publique : ses fonctions de
 * référence vivent dans `sync/device-freshness.ts`, `sync/sync-backlog.ts` et `platform/sync/conflicts.ts`.
 */
import { describe, expect, it } from 'vitest';
import { KPI_CATALOG } from '@gic/domain';
import * as crm from '../src/modules/crm/application/public/index.js';
import * as sales from '../src/modules/sales/application/public/index.js';
import * as inventory from '../src/modules/inventory/application/public/index.js';
import * as production from '../src/modules/production/application/public/index.js';
import * as fieldwork from '../src/modules/fieldwork/application/public/index.js';
import * as finance from '../src/modules/finance/application/public/index.js';
import * as procurement from '../src/modules/procurement/application/public/index.js';
import * as deviceFreshness from '../src/sync/device-freshness.js';
import * as syncBacklog from '../src/sync/sync-backlog.js';
import * as conflicts from '../src/platform/sync/conflicts.js';

const PUBLIC_API: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  crm: { ...crm },
  sales: { ...sales },
  inventory: { ...inventory },
  production: { ...production },
  fieldwork: { ...fieldwork },
  finance: { ...finance },
  procurement: { ...procurement },
  sync: { ...deviceFreshness, ...conflicts, ...syncBacklog },
};

describe('P9-25 (EP-5) : les références du registre des indicateurs existent', () => {
  it('chaque module du registre a une entrée dans la table des API publiques (un module nouveau fait échouer l’essai)', () => {
    for (const kpi of KPI_CATALOG) {
      expect(PUBLIC_API[kpi.module], `${kpi.code} : module ${kpi.module}`).toBeDefined();
    }
  });

  it('indicateur EXISTING : la fonction de référence est exportée par l’API publique de son module', () => {
    const existing = KPI_CATALOG.filter((kpi) => kpi.state === 'EXISTING');
    expect(existing.length).toBeGreaterThan(0);
    for (const kpi of existing) {
      const api = PUBLIC_API[kpi.module]!;
      expect(typeof api[kpi.reference], `${kpi.code} : ${kpi.module}.${kpi.reference}`).toBe(
        'function',
      );
    }
  });

  it('aucun indicateur n’est plus à créer (AV-462 livré en P9-27) ; un indicateur éventuel à créer n’a pas encore sa fonction', () => {
    const toCreate = KPI_CATALOG.filter((kpi) => kpi.state === 'TO_CREATE');
    expect(toCreate).toEqual([]);
    for (const kpi of toCreate) {
      const api = PUBLIC_API[kpi.module]!;
      expect(
        api[kpi.reference],
        `${kpi.code} : ${kpi.module}.${kpi.reference} existe désormais : état à passer à EXISTING, avec son essai d'équivalence`,
      ).toBeUndefined();
    }
  });
});
