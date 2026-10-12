import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Change } from '@gic/contracts';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { applyChange, KNOWN_DATASETS } from './pull.js';

function orderChange(overrides: Partial<Change>): Change {
  return {
    seq: 1,
    dataset: 'orders',
    entity_type: 'SALES_ORDER',
    entity_id: 'order-1',
    change_type: 'UPSERT',
    scope_type: 'USER',
    scope_id: 'user-1',
    row_version: 1,
    data: { number: 'CMD-1' },
    ...overrides,
  } as Change;
}

describe('sync/pull — jeux publiés et périmètres (applyChange)', () => {
  let db: GicDatabase;

  beforeEach(() => {
    db = createTestDb(`test-apply-${Math.random()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('télécharge les jeux publiés depuis P1, jamais le coût standard (RC-05)', () => {
    for (const dataset of [
      'product',
      'price_rule',
      'catalog',
      'stock',
      'transfers',
      'counts',
      'customers',
      'crm_activity',
      'fieldwork',
      'procurement',
      'production',
      'orders',
      'sales_recent',
      'cash',
      'comms',
    ]) {
      expect(KNOWN_DATASETS).toContain(dataset);
    }
    expect(KNOWN_DATASETS).not.toContain('product_standard_cost');
    // Jeux de P5-18 : quotas juste après le stock (la garde de vente hors ligne en dépend), PDV,
    // paramètres visibles et politiques.
    expect(KNOWN_DATASETS.indexOf('allocations')).toBe(KNOWN_DATASETS.indexOf('stock') + 1);
    for (const dataset of ['org', 'me', 'policies']) expect(KNOWN_DATASETS).toContain(dataset);
    expect(new Set(KNOWN_DATASETS).size).toBe(KNOWN_DATASETS.length);
  });

  it('SCOPE_EXIT d’un périmètre garde l’entité tenue par un autre ; le dernier la retire', async () => {
    await applyChange(db, orderChange({ seq: 1 }));
    await applyChange(db, orderChange({ seq: 2, scope_type: 'LOCATION', scope_id: 'loc-1' }));
    let row = await db.projections.get('orders:SALES_ORDER:order-1');
    expect(row?.scopes).toEqual(['USER:user-1', 'LOCATION:loc-1']);

    // Commande déplacée : elle quitte l'ancien emplacement mais reste chez son titulaire.
    await applyChange(
      db,
      orderChange({ seq: 3, change_type: 'SCOPE_EXIT', scope_type: 'LOCATION', scope_id: 'loc-1' }),
    );
    row = await db.projections.get('orders:SALES_ORDER:order-1');
    expect(row?.scopes).toEqual(['USER:user-1']);
    expect(row?.data).toEqual({ number: 'CMD-1' });

    // Livraison complète : sortie du dernier périmètre.
    await applyChange(db, orderChange({ seq: 4, change_type: 'SCOPE_EXIT' }));
    expect(await db.projections.get('orders:SALES_ORDER:order-1')).toBeUndefined();
  });

  it('un UPSERT répété par le même périmètre ne duplique pas ce périmètre', async () => {
    await applyChange(db, orderChange({ seq: 1 }));
    await applyChange(db, orderChange({ seq: 2, data: { number: 'CMD-1', status: 'CONFIRMED' } }));
    const row = await db.projections.get('orders:SALES_ORDER:order-1');
    expect(row?.scopes).toEqual(['USER:user-1']);
    expect(row?.data).toEqual({ number: 'CMD-1', status: 'CONFIRMED' });
  });

  it('ligne antérieure au champ scopes : son périmètre est repris de scope_type/scope_id', async () => {
    await db.projections.put({
      key: 'orders:SALES_ORDER:order-1',
      dataset: 'orders',
      entity_type: 'SALES_ORDER',
      entity_id: 'order-1',
      scope_type: 'TEAM',
      scope_id: 'team-1',
      row_version: 1,
      data: {},
      seq: 1,
    });
    await applyChange(db, orderChange({ seq: 2 }));
    expect((await db.projections.get('orders:SALES_ORDER:order-1'))?.scopes).toEqual([
      'TEAM:team-1',
      'USER:user-1',
    ]);
    await applyChange(
      db,
      orderChange({ seq: 3, change_type: 'SCOPE_EXIT', scope_type: 'TEAM', scope_id: 'team-1' }),
    );
    expect((await db.projections.get('orders:SALES_ORDER:order-1'))?.scopes).toEqual([
      'USER:user-1',
    ]);
  });

  it('solde de stock : un même produit sur deux emplacements donne deux projections', async () => {
    const balance = (locationId: string, onHand: string): Change =>
      orderChange({
        dataset: 'stock',
        entity_type: 'STOCK_BALANCE',
        entity_id: 'product-1',
        scope_type: 'LOCATION',
        scope_id: locationId,
        data: { location_id: locationId, product_id: 'product-1', qty_on_hand: onHand },
      });
    await applyChange(db, balance('loc-a', '5'));
    await applyChange(db, balance('loc-b', '7'));
    expect((await db.projections.get('stock:STOCK_BALANCE:loc-a:product-1'))?.data).toMatchObject({
      qty_on_hand: '5',
    });
    expect((await db.projections.get('stock:STOCK_BALANCE:loc-b:product-1'))?.data).toMatchObject({
      qty_on_hand: '7',
    });
  });

  it('SCOPE_EXIT d’une entité inconnue et DELETE : sans erreur, rien ne reste', async () => {
    await applyChange(db, orderChange({ change_type: 'SCOPE_EXIT' }));
    expect(await db.projections.count()).toBe(0);
    await applyChange(db, orderChange({ seq: 1 }));
    await applyChange(db, orderChange({ seq: 2, scope_type: 'TEAM', scope_id: 'team-1' }));
    await applyChange(db, orderChange({ seq: 3, change_type: 'DELETE' }));
    expect(await db.projections.count()).toBe(0);
  });
});
