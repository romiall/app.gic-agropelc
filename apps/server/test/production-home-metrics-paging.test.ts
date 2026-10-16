/**
 * Aperçu de production de l'accueil (`productionOverview`) : la pagination de `listProductionLots` se
 * parcourt par `beforeId` (identifiant du dernier lot de la page). Le curseur était passé sous un nom que
 * la lecture ignorait : dès 201 lots en cours, la première page était relue sans fin (accueil de toute
 * l'entreprise suspendu). La lecture est simulée ; le simulacre échoue après dix appels plutôt que de
 * boucler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/production/application/public/production-query.js', () => ({
  listProductionLots: vi.fn(),
}));

import { listProductionLots } from '../src/modules/production/application/public/production-query.js';
import { productionOverview } from '../src/modules/production/application/public/home-metrics.js';
import { ALL_SCOPE } from '../src/platform/read-scope.js';

const lot = (id: string, status: 'ACTIVE' | 'SELLING', rearing: number) => ({
  id,
  status,
  headcount: { rearing },
});

describe('productionOverview : pagination des lots en cours (aucune boucle sans fin)', () => {
  beforeEach(() => {
    vi.mocked(listProductionLots).mockReset();
  });

  it('parcourt les pages par `beforeId` et totalise tous les lots', async () => {
    let calls = 0;
    vi.mocked(listProductionLots).mockImplementation((async (_executor: unknown, filter: never) => {
      calls += 1;
      if (calls > 10) throw new Error('boucle sans fin : la pagination ne progresse pas');
      const { status, beforeId } = filter as { status: string; beforeId?: string };
      if (status === 'ACTIVE' && beforeId === undefined) {
        return { items: [lot('b', 'ACTIVE', 10), lot('a', 'ACTIVE', 5)], nextCursor: 'a' };
      }
      if (status === 'ACTIVE' && beforeId === 'a') {
        return { items: [lot('9', 'ACTIVE', 7)], nextCursor: null };
      }
      if (status === 'SELLING') {
        return { items: [lot('s', 'SELLING', 3)], nextCursor: null };
      }
      throw new Error(`appel inattendu : ${JSON.stringify(filter)}`);
    }) as never);

    const overview = await productionOverview({} as never, ALL_SCOPE);
    expect(overview).toEqual({ activeLots: 4, rearingHeads: 25, sellingLots: 1 });
    // Deux pages de lots actifs, une de lots en vente ; la seconde page porte le curseur de la première.
    expect(vi.mocked(listProductionLots)).toHaveBeenCalledTimes(3);
    const calls2 = vi.mocked(listProductionLots).mock.calls.map((call) => call[1]);
    expect(calls2[1]).toMatchObject({ status: 'ACTIVE', beforeId: 'a', limit: 200 });
  });

  it('aucun lot en cours : zéros, une seule lecture par statut', async () => {
    vi.mocked(listProductionLots).mockResolvedValue({ items: [], nextCursor: null } as never);
    expect(await productionOverview({} as never, ALL_SCOPE)).toEqual({
      activeLots: 0,
      rearingHeads: 0,
      sellingLots: 0,
    });
    expect(vi.mocked(listProductionLots)).toHaveBeenCalledTimes(2);
  });
});
