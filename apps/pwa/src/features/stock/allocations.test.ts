import { describe, expect, it } from 'vitest';
import {
  activeQuotas,
  grantPayload,
  knownHolders,
  parsePositiveQuantity,
  parseValidityHours,
  unallocated,
  type AllocationItem,
} from './allocations.js';

function item(overrides: Partial<AllocationItem>): AllocationItem {
  return {
    id: 'a',
    locationId: 'pdv',
    productId: 'oeuf',
    lotId: null,
    holderUserId: 'u1',
    holderDeviceId: 'd1',
    quantityGranted: 10,
    quantityRemaining: 10,
    validUntil: null,
    status: 'ACTIVE',
    revocationPending: false,
    version: 1,
    ...overrides,
  };
}

describe('Quotas d’un emplacement (ECR-STK-06)', () => {
  it('actifs par produit ; détenteurs connus sans doublon, soi-même d’abord', () => {
    const items = [
      item({ id: 'c', productId: 'poulet' }),
      item({ id: 'b' }),
      item({ id: 'x', status: 'REVOKED', holderUserId: 'u2', holderDeviceId: 'd2' }),
      item({ id: 'y', status: 'CLOSED' }),
      item({ id: 'z', holderUserId: null, holderDeviceId: null }),
    ];
    expect(activeQuotas(items).map((q) => q.id)).toEqual(['b', 'z', 'c']);
    expect(knownHolders(items, { userId: 'moi', deviceId: 'tel' })).toEqual([
      { userId: 'moi', deviceId: 'tel' },
      { userId: 'u1', deviceId: 'd1' },
      { userId: 'u2', deviceId: 'd2' },
    ]);
    expect(knownHolders(items, null)).toHaveLength(2);
  });

  it('non alloué indicatif, quantités et durée, charge utile de l’octroi', () => {
    const page = {
      active_totals: [{ productId: 'oeuf', activeCount: 2, quantityRemaining: 12.5 }],
    };
    expect(unallocated(40, page, 'oeuf')).toBe(27.5);
    expect(unallocated(40, page, 'poulet')).toBe(40);
    expect(unallocated(40, {}, 'oeuf')).toBe(40);
    expect(parsePositiveQuantity('0')).toBeNull();
    expect(parsePositiveQuantity('2,5')).toBe(2.5);
    expect(parseValidityHours('744')).toBe(744);
    expect(parseValidityHours('745')).toBeNull();
    expect(parseValidityHours('0')).toBeNull();
    expect(parseValidityHours('x')).toBeNull();
    const holder = { userId: 'u1', deviceId: 'd1' };
    expect(
      grantPayload({
        holder,
        locationId: 'pdv',
        productId: 'oeuf',
        quantityBase: 5,
        validityHours: null,
      }),
    ).toEqual({
      holderUserId: 'u1',
      holderDeviceId: 'd1',
      locationId: 'pdv',
      productId: 'oeuf',
      quantityBase: 5,
    });
    expect(
      grantPayload({
        holder,
        locationId: 'pdv',
        productId: 'oeuf',
        quantityBase: 5,
        validityHours: 8,
      }),
    ).toMatchObject({ validityHours: 8 });
  });
});
