import { describe, expect, it } from 'vitest';
import { xaf } from './money.js';
import {
  findConflicts,
  resolvePrice,
  specificityOf,
  type PriceRule,
} from './pricing-engine.js';

const PRODUCT = 'product-poulet-chair';

function rule(overrides: Partial<PriceRule> & { id: string }): PriceRule {
  return {
    productId: PRODUCT,
    unitPriceXaf: xaf(1000),
    pricingUnitCode: 'TETE',
    zoneId: null,
    zoneDepth: null,
    siteId: null,
    customerCategoryId: null,
    channelCode: null,
    minQuantity: null,
    commercialCampaignId: null,
    priority: 0,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

// Exemple chiffré de docs/02-domain-model/04-strategie-pricing.md §5.
describe('resolvePrice — exemple de la stratégie pricing (§5)', () => {
  const r1 = rule({ id: '1', unitPriceXaf: xaf(4500) }); // global
  const r2 = rule({ id: '2', unitPriceXaf: xaf(4700), zoneId: 'douala', zoneDepth: 1 });
  const r3 = rule({ id: '3', unitPriceXaf: xaf(4800), zoneId: 'mboppi', zoneDepth: 2 });
  const r4 = rule({ id: '4', unitPriceXaf: xaf(4900), siteId: 'pdv-mboppi' });
  const r5 = rule({
    id: '5',
    unitPriceXaf: xaf(4400),
    customerCategoryId: 'revendeur',
    zoneId: 'douala',
    zoneDepth: 1,
  });
  const r6 = rule({
    id: '6',
    unitPriceXaf: xaf(4300),
    minQuantity: 20,
    zoneId: 'douala',
    zoneDepth: 1,
  });
  const r7 = rule({
    id: '7',
    unitPriceXaf: xaf(4200),
    priority: 100,
    commercialCampaignId: 'fetes-2026',
  });
  const allRules = [r1, r2, r3, r4, r5, r6, r7];

  it('vente au PDV Mboppi, client anonyme, 2 têtes, hors campagne -> R4 (le plus spécifique)', () => {
    const result = resolvePrice(
      { productId: PRODUCT, at: new Date('2026-02-01'), siteId: 'pdv-mboppi', zonePath: ['mboppi', 'douala'], quantity: 2 },
      allRules,
    );
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('4');
  });

  it('commercial terrain à Akwa (Douala), 2 têtes -> R2', () => {
    const result = resolvePrice(
      { productId: PRODUCT, at: new Date('2026-02-01'), zonePath: ['douala'], quantity: 2 },
      allRules,
    );
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('2');
  });

  it('revendeur à Akwa, 2 têtes -> R5 (spécificité 19 > 3)', () => {
    const result = resolvePrice(
      {
        productId: PRODUCT,
        at: new Date('2026-02-01'),
        zonePath: ['douala'],
        customerCategoryId: 'revendeur',
        quantity: 2,
      },
      allRules,
    );
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('5');
  });

  it('revendeur au PDV Mboppi, 25 têtes -> R4 (le PDV prime sur la catégorie, 32 > 19)', () => {
    const result = resolvePrice(
      {
        productId: PRODUCT,
        at: new Date('2026-02-01'),
        siteId: 'pdv-mboppi',
        zonePath: ['mboppi', 'douala'],
        customerCategoryId: 'revendeur',
        quantity: 25,
      },
      allRules,
    );
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('4');
  });

  it('même contexte pendant la campagne -> R7 (priorité 100)', () => {
    const result = resolvePrice(
      {
        productId: PRODUCT,
        at: new Date('2026-02-01'),
        siteId: 'pdv-mboppi',
        zonePath: ['mboppi', 'douala'],
        customerCategoryId: 'revendeur',
        quantity: 25,
        activeCampaignIds: ['fetes-2026'],
      },
      allRules,
    );
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('7');
  });

  it('aucune candidate -> PRICE_NOT_FOUND', () => {
    const result = resolvePrice(
      { productId: 'autre-produit', at: new Date('2026-02-01'), quantity: 1 },
      allRules,
    );
    expect(result.found).toBe(false);
  });
});

describe('specificityOf — BR-PRX-005', () => {
  it('somme les poids des dimensions renseignées', () => {
    expect(specificityOf(rule({ id: '1' }))).toBe(0);
    expect(specificityOf(rule({ id: '2', siteId: 's' }))).toBe(32);
    expect(specificityOf(rule({ id: '3', customerCategoryId: 'c' }))).toBe(16);
    expect(specificityOf(rule({ id: '4', zoneId: 'z', zoneDepth: 4 }))).toBe(12);
    expect(specificityOf(rule({ id: '5', channelCode: 'ch' }))).toBe(2);
    expect(specificityOf(rule({ id: '6', minQuantity: 5 }))).toBe(1);
  });
});

describe('resolvePrice — déterminisme (INV-PRX-04)', () => {
  it('à candidates de même priorité/spécificité/min_quantity, valid_from le plus récent gagne', () => {
    const older = rule({ id: '1', validFrom: new Date('2026-01-01'), unitPriceXaf: xaf(100) });
    const newer = rule({ id: '2', validFrom: new Date('2026-02-01'), unitPriceXaf: xaf(200) });
    const result = resolvePrice({ productId: PRODUCT, at: new Date('2026-03-01'), quantity: 1 }, [
      older,
      newer,
    ]);
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe('2');
  });

  it('à tout le reste égal, l\'identifiant le plus grand (UUIDv7 le plus récent) gagne', () => {
    const a = rule({ id: '0190aaaa-0000-7000-8000-000000000001' });
    const b = rule({ id: '0190bbbb-0000-7000-8000-000000000002' });
    const result = resolvePrice({ productId: PRODUCT, at: new Date('2026-03-01'), quantity: 1 }, [
      a,
      b,
    ]);
    expect(result.found).toBe(true);
    if (result.found) expect(result.resolution.rule.id).toBe(b.id);
  });

  it('une règle DRAFT ou hors période n\'est jamais candidate', () => {
    const draft = rule({ id: '1', status: 'DRAFT' });
    const future = rule({ id: '2', validFrom: new Date('2099-01-01') });
    const ended = rule({ id: '3', validTo: new Date('2020-01-01') });
    const result = resolvePrice({ productId: PRODUCT, at: new Date('2026-03-01'), quantity: 1 }, [
      draft,
      future,
      ended,
    ]);
    expect(result.found).toBe(false);
  });
});

describe('findConflicts — BR-PRX-006', () => {
  it('deux règles actives du même produit, même priorité/spécificité, périodes chevauchantes, sans dimension distinctive -> conflit', () => {
    const existing = rule({ id: '1', validFrom: new Date('2026-01-01'), validTo: null });
    const candidate = rule({ id: '2', validFrom: new Date('2026-06-01'), validTo: null });
    expect(findConflicts(candidate, [existing])).toHaveLength(1);
  });

  it('une dimension distinctive (zone différente) exclut le conflit', () => {
    const existing = rule({ id: '1', zoneId: 'douala', zoneDepth: 1 });
    const candidate = rule({ id: '2', zoneId: 'yaounde', zoneDepth: 1 });
    expect(findConflicts(candidate, [existing])).toHaveLength(0);
  });

  it('des périodes disjointes excluent le conflit', () => {
    const existing = rule({
      id: '1',
      validFrom: new Date('2026-01-01'),
      validTo: new Date('2026-02-01'),
    });
    const candidate = rule({ id: '2', validFrom: new Date('2026-02-01'), validTo: null });
    expect(findConflicts(candidate, [existing])).toHaveLength(0);
  });

  it('un min_quantity différent exclut le conflit (exact, pas « ou nul »)', () => {
    const existing = rule({ id: '1', minQuantity: 10 });
    const candidate = rule({ id: '2', minQuantity: 20 });
    expect(findConflicts(candidate, [existing])).toHaveLength(0);
  });

  it('une priorité différente exclut le conflit', () => {
    const existing = rule({ id: '1', priority: 0 });
    const candidate = rule({ id: '2', priority: 100 });
    expect(findConflicts(candidate, [existing])).toHaveLength(0);
  });
});
