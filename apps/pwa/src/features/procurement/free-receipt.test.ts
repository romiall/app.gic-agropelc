import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../app/screens.js';
import type { LocationData, ProductData } from '../sales/types.js';
import {
  checkFreeLine,
  emptyFreeLine,
  freeReceiptLocations,
  freeReceiptPayload,
  freeReceiptSuppliers,
  MAX_UNIT_COST_XAF,
  type FreeLineDraft,
} from './free-receipt.js';
import { FREE_RECEIPT_SEGMENT } from './receipt.js';

const draft = (patch: Partial<FreeLineDraft>): FreeLineDraft => ({
  ...emptyFreeLine('1'),
  ...patch,
});

const EGGS = 'p-eggs';

describe('Réception sans bon de commande (ECR-APP-04, BR-APP-011, AV-519)', () => {
  it('le segment de l’adresse est celui de la route du registre des écrans', () => {
    expect(ROUTES.purchaseReceiptFree).toBe(`/achats/receptions/${FREE_RECEIPT_SEGMENT}`);
  });

  it('une ligne vide, ou un produit sans quantité livrée, n’est pas envoyé et ne bloque rien', () => {
    expect(checkFreeLine(emptyFreeLine('1'))).toMatchObject({ delivered: null, issues: [] });
    expect(checkFreeLine(draft({ productId: EGGS }))).toMatchObject({
      delivered: null,
      issues: [],
    });
    // Un prix tapé sans produit ni quantité n'est pas une ligne non plus… mais un produit manquant se signale.
    expect(checkFreeLine(draft({ deliveredText: '5' })).issues).toContain('PRODUCT_REQUIRED');
    expect(checkFreeLine(draft({ unitCostText: '100' }))).toMatchObject({
      delivered: null,
      issues: ['PRODUCT_REQUIRED'],
    });
  });

  it('prix unitaire exigé sans bon (entier, borné) : vide, décimal ou démesuré sont refusés', () => {
    const base = { productId: EGGS, deliveredText: '10' };
    expect(checkFreeLine(draft(base)).issues).toEqual(['COST_INVALID']);
    expect(checkFreeLine(draft({ ...base, unitCostText: '12,5' })).issues).toEqual([
      'COST_INVALID',
    ]);
    expect(checkFreeLine(draft({ ...base, unitCostText: 'abc' })).issues).toEqual(['COST_INVALID']);
    expect(
      checkFreeLine(draft({ ...base, unitCostText: String(MAX_UNIT_COST_XAF + 1) })).issues,
    ).toEqual(['COST_INVALID']);
    const ok = checkFreeLine(draft({ ...base, unitCostText: ' 1 250 ' }));
    expect(ok).toMatchObject({ delivered: 10, accepted: 10, unitCostXaf: 1250, issues: [] });
    expect(checkFreeLine(draft({ ...base, unitCostText: '0' })).unitCostXaf).toBe(0);
  });

  it('quantités : virgule admise, rejet motivé, rejeté au plus égal au livré, accepté = livré − rejeté', () => {
    const base = { productId: EGGS, unitCostText: '100' };
    expect(checkFreeLine(draft({ ...base, deliveredText: '0' })).issues).toEqual([
      'QUANTITY_INVALID',
    ]);
    expect(checkFreeLine(draft({ ...base, deliveredText: '1,5x' })).issues).toEqual([
      'QUANTITY_INVALID',
    ]);
    const rejected = checkFreeLine(draft({ ...base, deliveredText: '12,5', rejectedText: '2' }));
    expect(rejected).toMatchObject({ delivered: 12.5, rejected: 2, accepted: 10.5 });
    expect(rejected.issues).toEqual(['REASON_REQUIRED']);
    expect(
      checkFreeLine(draft({ ...base, deliveredText: '12,5', rejectedText: '2', reasonId: 'r1' }))
        .issues,
    ).toEqual([]);
    expect(
      checkFreeLine(draft({ ...base, deliveredText: '3', rejectedText: '4', reasonId: 'r1' }))
        .issues,
    ).toEqual(['REJECTED_OVER_DELIVERED']);
    expect(
      checkFreeLine(draft({ ...base, deliveredText: '3', expiryDate: '12/2026' })).issues,
    ).toEqual(['EXPIRY_INVALID']);
  });

  it('charge utile : unité de base du produit, prix déclaré, ni bon ni ligne de bon ; lignes non livrées écartées', () => {
    const eggs: Pick<ProductData, 'id' | 'base_unit_code'> = { id: EGGS, base_unit_code: 'OEUF' };
    const chicken: Pick<ProductData, 'id' | 'base_unit_code'> = {
      id: 'p-ch',
      base_unit_code: 'TETE',
    };
    const first = draft({
      key: '1',
      productId: EGGS,
      deliveredText: '300',
      rejectedText: '30',
      reasonId: 'r1',
      unitCostText: '90',
      lotRef: ' L-12 ',
      expiryDate: '2026-12-31',
    });
    const second = draft({ key: '2', productId: 'p-ch' });
    const payload = freeReceiptPayload({
      supplierId: 's1',
      locationId: 'l1',
      deliveryNoteRef: ' BL-9 ',
      observations: '  ',
      lines: [
        { product: eggs, draft: first, check: checkFreeLine(first) },
        { product: chicken, draft: second, check: checkFreeLine(second) },
      ],
    });
    expect(payload).toEqual({
      supplierId: 's1',
      locationId: 'l1',
      supplierDeliveryNoteRef: 'BL-9',
      lines: [
        {
          productId: EGGS,
          unitCode: 'OEUF',
          qtyDeliveredBase: 300,
          qtyRejectedBase: 30,
          rejectionReasonCodeId: 'r1',
          unitCostXaf: 90,
          supplierLotRef: 'L-12',
          expiryDate: '2026-12-31',
        },
      ],
    });
    expect(payload).not.toHaveProperty('purchaseOrderId');
  });

  it('fournisseurs par nom ; emplacements physiques et actifs d’un site seulement', () => {
    expect(
      freeReceiptSuppliers(
        new Map([
          ['b', { id: 'b', code: 'F-2', name: 'Zoo Centre' }],
          ['a', { id: 'a', code: 'F-1', name: 'Agri Nord' }],
        ]),
      ).map((supplier) => supplier.id),
    ).toEqual(['a', 'b']);
    const location = (id: string, patch: Partial<LocationData>): LocationData => ({
      id,
      site_id: 'site',
      code: id,
      name: id,
      location_type: 'STORE',
      is_virtual: false,
      custody_mode: 'SHARED',
      custodian_user_id: null,
      designated_device_id: null,
      status: 'ACTIVE',
      ...patch,
    });
    expect(
      freeReceiptLocations([
        location('Magasin B', {}),
        location('Magasin A', {}),
        location('Virtuel', { is_virtual: true }),
        location('Fermé', { status: 'INACTIVE' }),
        location('Sans site', { site_id: null }),
      ]).map((candidate) => candidate.id),
    ).toEqual(['Magasin A', 'Magasin B']);

    // Seuls les sites de l'utilisateur : un emplacement d'un autre site serait refusé par le serveur (FORBIDDEN_SCOPE),
    // y compris hors ligne, et la réception serait perdue.
    expect(
      freeReceiptLocations(
        [
          location('Magasin A', { site_id: 'site' }),
          location('Magasin A', { site_id: 'autre-site' }),
          location('Dépôt', { site_id: 'autre-site' }),
        ],
        new Set(['site']),
      ).map((candidate) => [candidate.id, candidate.site_id]),
    ).toEqual([['Magasin A', 'site']]);
    expect(freeReceiptLocations([location('Magasin A', {})], new Set())).toEqual([]);
  });
});
