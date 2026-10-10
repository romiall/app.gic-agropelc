import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type GicDatabase } from './db.js';
import { getProjected, listProjected } from './projections.js';

describe('storage/projections', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-projections-${Math.random()}`);
    const base = { scope_type: 'GLOBAL', scope_id: null, row_version: 1, seq: 1 };
    await db.projections.bulkPut([
      {
        ...base,
        key: 'product:PRODUCT:p1',
        dataset: 'product',
        entity_type: 'PRODUCT',
        entity_id: 'p1',
        data: { id: 'p1', name: 'Poulet' },
      },
      {
        ...base,
        key: 'product:PRODUCT:p2',
        dataset: 'product',
        entity_type: 'PRODUCT',
        entity_id: 'p2',
        data: { id: 'p2', name: 'Œufs' },
      },
      {
        ...base,
        key: 'catalog:PAYMENT_METHOD:m1',
        dataset: 'catalog',
        entity_type: 'PAYMENT_METHOD',
        entity_id: 'm1',
        data: { code: 'CASH' },
      },
    ]);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('liste les données d’un type d’entité d’un jeu, et lit une entité par son identifiant', async () => {
    const products = await listProjected<{ name: string }>(db, 'product', 'PRODUCT');
    expect(products.map((p) => p.name).sort()).toEqual(['Poulet', 'Œufs']);
    expect(await getProjected(db, 'catalog', 'PAYMENT_METHOD', 'm1')).toEqual({ code: 'CASH' });
    expect(await getProjected(db, 'catalog', 'PAYMENT_METHOD', 'absent')).toBeUndefined();
  });
});
