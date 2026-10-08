import { describe, expect, it } from 'vitest';
import { distributionResidual, isDistributionReconciled } from './distribution.js';

describe('identité de rapprochement de la distribution (BR-DIS-012, AT-042)', () => {
  const flows = {
    openingBalance: 100,
    received: 50,
    otherIn: 2,
    soldNet: 120,
    lost: 3,
    otherOut: 4,
    closingBalance: 25,
  };

  it('solde fin − solde début = reçu + autres entrées − vendu net − perdu − autres sorties', () => {
    expect(distributionResidual(flows)).toBe(0);
    expect(isDistributionReconciled(flows)).toBe(true);
  });

  it('un écart non expliqué ressort avec son signe', () => {
    expect(distributionResidual({ ...flows, closingBalance: 24 })).toBe(-1);
    expect(distributionResidual({ ...flows, closingBalance: 27.5 })).toBe(2.5);
    expect(isDistributionReconciled({ ...flows, closingBalance: 24 })).toBe(false);
  });

  it('calcule en millièmes exacts', () => {
    expect(
      isDistributionReconciled({
        openingBalance: 0.1,
        received: 0.2,
        otherIn: 0,
        soldNet: 0,
        lost: 0,
        otherOut: 0,
        closingBalance: 0.3,
      }),
    ).toBe(true);
  });
});
