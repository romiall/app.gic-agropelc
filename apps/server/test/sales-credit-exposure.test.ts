/**
 * Encours de crédit à la livraison (AV-512, BR-VEN-034) : fonctions pures de `sales` — part livrée d'une ligne
 * (`deliveredShareXaf`) et encours de crédit d'une vente (`saleCreditExposureXaf`). Le calcul de l'encours d'un
 * client sur la base et le contrôle du plafond à la livraison sont éprouvés par `sales-order-fulfil-commands`.
 */
import { describe, expect, it } from 'vitest';
import {
  deliveredShareXaf,
  saleCreditExposureXaf,
} from '../src/modules/sales/application/public/index.js';

describe('part livrée d’une ligne de vente (AV-512)', () => {
  it('rien de livré, rien à payer ; tout livré, exactement le montant de la ligne', () => {
    expect(deliveredShareXaf(10_000, 10_000, 0)).toBe(0);
    expect(deliveredShareXaf(10_000, 10_000, 10_000)).toBe(10_000);
    // Un montant qui ne tombe pas juste au franc (1 001 pour 3 pièces) se retrouve entier au livré complet.
    expect(deliveredShareXaf(1_001, 3_000, 3_000)).toBe(1_001);
  });

  it('prorata de la quantité livrée, arrondi au franc, demi supérieur', () => {
    expect(deliveredShareXaf(10_000, 10_000, 4_000)).toBe(4_000);
    // 1 001 × 1 ÷ 3 = 333,67 → 334 ; 1 001 × 2 ÷ 3 = 667,33 → 667 ; demi : 5 × 1 ÷ 2 = 2,5 → 3.
    expect(deliveredShareXaf(1_001, 3_000, 1_000)).toBe(334);
    expect(deliveredShareXaf(1_001, 3_000, 2_000)).toBe(667);
    expect(deliveredShareXaf(5, 2_000, 1_000)).toBe(3);
    // Une quantité de 0,5 sur 2 : un quart du montant.
    expect(deliveredShareXaf(1_000, 2_000, 500)).toBe(250);
  });

  it('jamais plus que la ligne, jamais négative ; entrées nulles ou absurdes : 0', () => {
    expect(deliveredShareXaf(1_000, 2_000, 5_000)).toBe(1_000);
    expect(deliveredShareXaf(0, 2_000, 1_000)).toBe(0);
    expect(deliveredShareXaf(1_000, 0, 1_000)).toBe(0);
    expect(deliveredShareXaf(-5, 2_000, 1_000)).toBe(0);
    expect(deliveredShareXaf(1_000, 2_000, -1)).toBe(0);
  });

  it('une très grosse ligne ne dépasse pas la précision des entiers (produit intermédiaire en BigInt)', () => {
    // 4 000 000 000 000 F × 99 999 999 999 999 millièmes : le produit dépasse 2^53.
    const total = 4_000_000_000_000;
    const quantity = 99_999_999_999_999;
    expect(deliveredShareXaf(total, quantity, quantity)).toBe(total);
    expect(deliveredShareXaf(total, quantity, quantity / 2 + 0.5)).toBe(total / 2);
  });
});

describe('encours de crédit d’une vente (AV-512)', () => {
  const sale = (overrides: Partial<Parameters<typeof saleCreditExposureXaf>[0]>) =>
    saleCreditExposureXaf({
      saleType: 'ORDER',
      balanceDueXaf: 6_000,
      amountPaidXaf: 0,
      deliveredValueXaf: 0,
      ...overrides,
    });

  it('une vente directe est remise à la vente : son solde dû est son encours', () => {
    expect(sale({ saleType: 'DIRECT', balanceDueXaf: 2_500, deliveredValueXaf: 0 })).toBe(2_500);
    expect(sale({ saleType: 'DIRECT', balanceDueXaf: 0 })).toBe(0);
  });

  it('une vente sur commande : le livré moins le payé, jamais négatif, jamais plus que le solde dû', () => {
    // Rien de livré : aucun crédit, même impayée.
    expect(sale({ deliveredValueXaf: 0 })).toBe(0);
    // Livré 4 000 de 6 000, rien payé : 4 000 de crédit.
    expect(sale({ deliveredValueXaf: 4_000 })).toBe(4_000);
    // 3 000 payés s'imputent d'abord sur le livré : 1 000 de crédit seulement.
    expect(sale({ deliveredValueXaf: 4_000, amountPaidXaf: 3_000, balanceDueXaf: 3_000 })).toBe(
      1_000,
    );
    // Payé au-delà du livré : aucun crédit.
    expect(sale({ deliveredValueXaf: 2_000, amountPaidXaf: 3_000, balanceDueXaf: 3_000 })).toBe(0);
    // Tout livré : le solde dû.
    expect(sale({ deliveredValueXaf: 6_000, amountPaidXaf: 3_000, balanceDueXaf: 3_000 })).toBe(
      3_000,
    );
    // Garde-fou : un livré supérieur au net (incohérent) ne dépasse pas le solde dû.
    expect(sale({ deliveredValueXaf: 9_000, balanceDueXaf: 6_000 })).toBe(6_000);
  });
});
