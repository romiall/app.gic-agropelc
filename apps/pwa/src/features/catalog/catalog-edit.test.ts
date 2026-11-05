import { describe, expect, it } from 'vitest';
import {
  checkProductEdit,
  checkStandardCost,
  parseCostXaf,
  productEditFormOf,
  productUpdatePayload,
  standardCostPayload,
  standardCostsPath,
  type ProductView,
} from './catalog.js';

const product: ProductView = {
  id: 'p1',
  code: 'OEUF',
  name: 'Œufs',
  categoryId: 'c1',
  stockFamily: 'PRODUCTION_COMMERCIALISABLE',
  baseUnitCode: 'U',
  lotTracking: 'OPTIONAL',
  isSellable: true,
  isPurchasable: false,
  isProducible: true,
  isConsumable: false,
  pricingMode: 'PER_UNIT',
  species: null,
  status: 'ACTIVE',
};

describe('Catalogue : modification d’un produit (AV-516)', () => {
  it('saisie de départ = le produit ; rien de modifié, rien à envoyer', () => {
    const form = productEditFormOf(product);
    expect(form).toEqual({
      name: 'Œufs',
      categoryId: 'c1',
      isSellable: true,
      isPurchasable: false,
      isProducible: true,
      isConsumable: false,
    });
    expect(productUpdatePayload(product, form)).toEqual({});
    expect(checkProductEdit(form)).toEqual([]);
  });

  it('seuls les champs modifiés partent, le nom sans espaces autour', () => {
    const form = productEditFormOf(product);
    expect(productUpdatePayload(product, { ...form, name: '  Œufs frais ' })).toEqual({
      name: 'Œufs frais',
    });
    expect(
      productUpdatePayload(product, {
        ...form,
        categoryId: 'c2',
        isSellable: false,
        isPurchasable: true,
        isProducible: false,
        isConsumable: true,
      }),
    ).toEqual({
      categoryId: 'c2',
      isSellable: false,
      isPurchasable: true,
      isProducible: false,
      isConsumable: true,
    });
  });

  it('un nom vide ou trop long et une catégorie absente sont signalés', () => {
    const form = productEditFormOf(product);
    expect(checkProductEdit({ ...form, name: '   ' })).toEqual(['NAME_REQUIRED']);
    expect(checkProductEdit({ ...form, name: 'x'.repeat(201) })).toEqual(['NAME_REQUIRED']);
    expect(checkProductEdit({ ...form, categoryId: '' })).toEqual(['CATEGORY_REQUIRED']);
  });
});

describe('Catalogue : coût standard daté (AV-516)', () => {
  it('chemin de l’historique', () => {
    expect(standardCostsPath('abc')).toBe('/api/v1/products/abc/standard-costs');
  });

  it('montant en francs entiers, espaces tolérés ; le reste est refusé', () => {
    expect(parseCostXaf('1650')).toBe(1650);
    expect(parseCostXaf(' 1 650 ')).toBe(1650);
    expect(parseCostXaf('1 650')).toBe(1650);
    expect(parseCostXaf('0')).toBe(0);
    expect(parseCostXaf('')).toBeNull();
    expect(parseCostXaf('12,5')).toBeNull();
    expect(parseCostXaf('-3')).toBeNull();
    expect(parseCostXaf('abc')).toBeNull();
    expect(parseCostXaf('9'.repeat(16))).toBeNull();
  });

  it('défauts de la saisie : montant, motif trop long', () => {
    expect(checkStandardCost('1650', '')).toEqual([]);
    expect(checkStandardCost('', '')).toEqual(['COST_INVALID']);
    expect(checkStandardCost('1650', 'x'.repeat(501))).toEqual(['REASON_TOO_LONG']);
    expect(checkStandardCost('abc', 'x'.repeat(501))).toEqual(['COST_INVALID', 'REASON_TOO_LONG']);
  });

  it('charge de catalog.product_standard_cost.set : le motif n’est envoyé que s’il y en a un', () => {
    expect(standardCostPayload('p1', '1 650', ' Nouvelle ration ')).toEqual({
      productId: 'p1',
      unitCostXaf: 1650,
      reason: 'Nouvelle ration',
    });
    expect(standardCostPayload('p1', '0', '  ')).toEqual({ productId: 'p1', unitCostXaf: 0 });
  });
});
