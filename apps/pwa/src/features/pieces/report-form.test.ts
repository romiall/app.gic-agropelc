/**
 * Résolution du formulaire de report en pièce (PP-B ; REQ-303, AV-078, AV-312, AV-501 à AV-504) : les
 * mêmes référentiels de l'appareil et les mêmes aides que les écrans d'origine (vente, commande,
 * livraison, encaissement, dépense, remise de fonds, réception, transfert, perte), à la date de la pièce.
 * Les référentiels sont lus de la vraie base locale (projections telles que le serveur les sert).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, type Projection } from '../../storage/db.js';
import {
  CENTRAL_CASH_ACCOUNT,
  EXPENSE_IDS,
  IDS,
  ORDER_ID,
  ORDER_LINE_ID,
  POS_CASH_ACCOUNT,
  cashTransferTargetRow,
  expenseCategoryRow,
  meSettingRow,
  orderRow,
  posCashAccountRow,
  seedSalesFixtures,
  siteRow,
} from '../sales/fixtures.js';
import { loadSalesReferences, type SalesReferences } from '../sales/references.js';
import type { ResolvedSlip as ResolvedSlipOf } from './report-commands.js';
import type { DraftLine } from '../sales/sale-form.js';
import {
  backdatingBasis,
  emptySlipForm,
  previewTotal,
  resolveSlip,
  toLocalInput,
  type LotDayForm,
  type SlipContext,
  type SlipForm,
  type SlipIssue,
} from './report-form.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
/** Pièce du matin même : dans les 24 h, aucun motif d'antidatage requis. */
const MORNING = toLocalInput(new Date('2026-11-04T08:00:00.000Z'));

const STORE = '01900000-0000-7000-8000-000000000032';
const SUPPLIER = '01900000-0000-7000-8000-000000000120';
const VISIT_OUTCOME = '01900000-0000-7000-8000-000000000130';
const PURCHASE_ORDER = '01900000-0000-7000-8000-000000000121';
const PO_LINE = '01900000-0000-7000-8000-000000000122';
const LOSS_REASON = '01900000-0000-7000-8000-000000000123';

function put(
  dataset: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
): Projection {
  return {
    key: `${dataset}:${entityType}:${entityId}`,
    dataset,
    entity_type: entityType,
    entity_id: entityId,
    scope_type: 'GLOBAL',
    scope_id: null,
    seq: 1,
    row_version: 1,
    data,
  };
}

const line = (overrides: Partial<DraftLine> = {}): DraftLine => ({
  key: 'k1',
  productId: IDS.chicken,
  unitCode: 'U',
  quantityText: '4',
  weightText: '',
  priceText: null,
  overrideReasonId: null,
  ...overrides,
});

const form = (overrides: Partial<SlipForm> = {}): SlipForm => ({
  ...emptySlipForm(NOW),
  paperRef: 'BV-000142',
  occurredAt: MORNING,
  ...overrides,
});

let refs: SalesReferences;
const context = (): SlipContext => ({ refs, userId: IDS.user, roles: null, now: NOW });
const resolve = (overrides: Partial<SlipForm>) => resolveSlip(form(overrides), context());

function issuesOf(overrides: Partial<SlipForm>): readonly SlipIssue[] {
  const result = resolve(overrides);
  if (result.ok) throw new Error(`Pièce acceptée : ${JSON.stringify(result.slip)}`);
  return result.issues;
}

function slipOf(overrides: Partial<SlipForm>) {
  const result = resolve(overrides);
  if (!result.ok) throw new Error(`Pièce refusée : ${result.issues.join(', ')}`);
  return result;
}

beforeEach(async () => {
  const db = getDb();
  await db.projections.clear();
  await db.outbox.clear();
  await seedSalesFixtures(db);
  await db.projections.bulkPut([
    posCashAccountRow(),
    cashTransferTargetRow(),
    expenseCategoryRow(),
    expenseCategoryRow({
      id: EXPENSE_IDS.unjustified,
      code: 'NON_JUSTIFIEE',
      label: 'Non justifiée',
      is_system: true,
    }),
    orderRow(),
    put('location', 'LOCATION', STORE, {
      id: STORE,
      site_id: IDS.site,
      code: 'PDV-YDE-MAG',
      name: 'Magasin Yaoundé',
      location_type: 'STORE',
      is_virtual: false,
      custody_mode: null,
      custodian_user_id: null,
      designated_device_id: null,
      status: 'ACTIVE',
    }),
    // Œufs achetables : seuls les produits achetables sont reçus sans bon de commande.
    put('product', 'PRODUCT', IDS.eggs, {
      id: IDS.eggs,
      code: 'OEUF',
      name: 'Œufs de table',
      category_id: IDS.zone,
      base_unit_code: 'U',
      stock_family: 'MARCHANDISE',
      is_sellable: true,
      is_purchasable: true,
      pricing_mode: 'PER_UNIT',
      status: 'ACTIVE',
    }),
    put('procurement', 'SUPPLIER', SUPPLIER, { id: SUPPLIER, code: 'F-LIT', name: 'Provenderie' }),
    put('procurement', 'PURCHASE_ORDER', PURCHASE_ORDER, {
      id: PURCHASE_ORDER,
      doc_number: 'BC-2026-000007',
      site_id: IDS.site,
      supplier_id: SUPPLIER,
      delivery_location_id: IDS.pos,
      expected_delivery_date: '2026-11-04',
      status: 'SENT',
      sent_at: '2026-11-01T08:00:00.000Z',
      version: 1,
      lines: [
        {
          id: PO_LINE,
          line_no: 1,
          product_id: IDS.eggs,
          unit_code: 'U',
          ordered_qty_base: '300.000',
          accepted_qty_base: '0.000',
          closed_qty_base: '0.000',
          remaining_qty_base: '300.000',
          status: 'OPEN',
        },
      ],
    }),
    put('reason_code', 'REASON_CODE', LOSS_REASON, {
      id: LOSS_REASON,
      category: 'LOSS',
      code: 'CHUTE',
      label: 'Chute en manutention',
      loss_category: 'CASSE',
      requires_comment: false,
      is_active: true,
    }),
  ]);
  refs = await loadSalesReferences(db);
});

describe('défauts communs : numéro, date, motif d’antidatage (AV-078, AV-312)', () => {
  it('numéro absent ou de plus de 20 caractères', () => {
    expect(issuesOf({ paperRef: '  ' })).toContain('REF_REQUIRED');
    expect(issuesOf({ paperRef: 'B'.repeat(21) })).toContain('REF_TOO_LONG');
    expect(issuesOf({ paperRef: 'B'.repeat(20) })).not.toContain('REF_TOO_LONG');
  });

  it('date invalide ou dans le futur', () => {
    expect(issuesOf({ occurredAt: '' })).toContain('DATE_INVALID');
    expect(issuesOf({ occurredAt: toLocalInput(new Date('2026-11-05T10:00:00.000Z')) })).toContain(
      'DATE_FUTURE',
    );
  });

  it('au-delà de 24 h le motif est exigé ; il est transmis tel quel', () => {
    const old = toLocalInput(new Date('2026-11-02T10:00:00.000Z'));
    const valid = {
      locationId: IDS.pos,
      lines: [line()],
      customerId: IDS.customer,
      occurredAt: old,
    };
    expect(issuesOf(valid)).toContain('BACKDATE_REASON_REQUIRED');
    const accepted = slipOf({ ...valid, backdatedReason: '  Retour de tournée  ' });
    expect(accepted.meta.backdatedReason).toBe('Retour de tournée');
    expect(accepted.meta.occurredAt).toBe(new Date(old).toISOString());
    expect(accepted.meta.paperRef).toBe('BV-000142');
  });

  it('la fenêtre vient des paramètres de l’appareil (AV-078) : 48 h avant le motif, ici, au lieu de 24 h', async () => {
    const old = toLocalInput(new Date('2026-11-03T02:00:00.000Z')); // 32 h avant NOW
    const valid = {
      locationId: IDS.pos,
      lines: [line()],
      customerId: IDS.customer,
      occurredAt: old,
    };
    expect(issuesOf(valid)).toContain('BACKDATE_REASON_REQUIRED');
    await getDb().projections.put(meSettingRow('sync.justification_after_hours', 48));
    await getDb().projections.put(meSettingRow('sync.backdate_max_hours', 96));
    refs = await loadSalesReferences(getDb());
    expect(issuesOf({ ...valid, paperRef: '  ' })).not.toContain('BACKDATE_REASON_REQUIRED');
    expect(resolve(valid).ok).toBe(true);
  });

  it('numéro normalisé comme le registre des carnets', () => {
    const accepted = slipOf({
      paperRef: 'bv 00142',
      locationId: IDS.pos,
      lines: [line()],
      customerId: IDS.customer,
    });
    expect(accepted.meta.paperRef).toBe('BV-00142');
  });
});

describe('BV : vente (sales.sale.record)', () => {
  const base = { slipType: 'BV' as const, locationId: IDS.pos, customerId: IDS.customer };

  it('prix catalogue de la date de la pièce, règlement en espèces égal au total', () => {
    const { slip } = slipOf({ ...base, lines: [line()] });
    expect(slip).toMatchObject({
      type: 'BV',
      fromLocationId: IDS.pos,
      customerId: IDS.customer,
      channelCode: 'POINT_DE_VENTE',
      totalXaf: 14_000,
      payment: { methodCode: 'ESPECES', amountXaf: 14_000 },
    });
    expect(slip.type === 'BV' && slip.lines).toEqual([
      {
        productId: IDS.chicken,
        quantity: 4,
        unitCode: 'U',
        quantityBase: 4,
        listUnitPriceXaf: 3500,
        priceRuleId: IDS.ruleChicken,
        unitPriceXaf: 3500,
      },
    ]);
  });

  it('un conditionnement convertit en unité de base ; une ligne laissée vide est ignorée', () => {
    const { slip } = slipOf({
      ...base,
      lines: [
        line({ productId: IDS.eggs, unitCode: 'PLATEAU', quantityText: '2' }),
        line({ key: 'k2', productId: '', quantityText: '' }),
      ],
    });
    expect(slip.type === 'BV' && slip.lines).toMatchObject([
      { quantity: 2, unitCode: 'PLATEAU', quantityBase: 60, unitPriceXaf: 100 },
    ]);
  });

  it('prix inscrit différent du catalogue : motif de dérogation exigé, puis transmis', () => {
    const cheaper = [line({ priceText: '3000' })];
    expect(issuesOf({ ...base, lines: cheaper })).toContain('PRICE_REASON_REQUIRED');
    const { slip } = slipOf({ ...base, lines: cheaper, overrideReasonId: IDS.reason });
    expect(slip.type === 'BV' && slip.lines[0]).toMatchObject({
      unitPriceXaf: 3000,
      listUnitPriceXaf: 3500,
      overrideReasonCodeId: IDS.reason,
    });
    expect(slip.type === 'BV' && slip.totalXaf).toBe(12_000);
  });

  it('vente à crédit : un client est obligatoire ; vente de passage : payée en totalité', () => {
    const credit = {
      ...base,
      lines: [line()],
      payment: { ...emptySlipForm(NOW).payment, amountText: '0' },
    };
    const { slip } = slipOf(credit);
    expect(slip.type === 'BV' && slip.payment).toBeUndefined();
    expect(issuesOf({ ...credit, customerId: null })).toContain('CUSTOMER_REQUIRED');
    const partial = { ...credit, payment: { ...credit.payment, amountText: '5000' } };
    expect(issuesOf({ ...partial, customerId: null })).toContain('CUSTOMER_REQUIRED');
    expect(slipOf(partial).slip).toMatchObject({ payment: { amountXaf: 5000 } });
    expect(
      issuesOf({ ...base, lines: [line()], payment: { ...credit.payment, amountText: '20000' } }),
    ).toContain('PAYMENT_EXCEEDS_TOTAL');
  });

  it('moyen à référence : exigée, puis transmise', () => {
    const orange = { ...emptySlipForm(NOW).payment, methodCode: 'MOBILE_MONEY_ORANGE' };
    expect(issuesOf({ ...base, lines: [line()], payment: orange })).toContain('PAYMENT_INVALID');
    const { slip } = slipOf({
      ...base,
      lines: [line()],
      payment: { ...orange, reference: ' OM-1 ' },
    });
    expect(slip).toMatchObject({
      payment: { methodCode: 'MOBILE_MONEY_ORANGE', reference: 'OM-1' },
    });
  });

  it('emplacement, lignes et client inconnus', () => {
    expect(issuesOf({ ...base, locationId: '', lines: [line()] })).toContain('LOCATION_REQUIRED');
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(issuesOf({ ...base, lines: [line({ quantityText: 'abc' })] })).toContain('LINE_INVALID');
    expect(issuesOf({ ...base, customerId: 'inconnu', lines: [line()] })).toContain(
      'CUSTOMER_UNKNOWN',
    );
  });

  it('total de la saisie, pour l’affichage', () => {
    expect(previewTotal(form({ ...base, lines: [line()] }), context())).toBe(14_000);
    expect(previewTotal(form({ ...base, slipType: 'RE' }), context())).toBeNull();
    expect(previewTotal(form({ ...base, lines: [line()], occurredAt: '' }), context())).toBeNull();
  });
});

describe('CC : commande client (sales.order.place)', () => {
  const base = {
    slipType: 'CC' as const,
    paperRef: 'CC-000031',
    customerId: IDS.customer,
    locationId: IDS.pos,
    lines: [line()],
  };

  it('client obligatoire ; date de livraison au format du serveur', () => {
    const { slip } = slipOf({
      ...base,
      requestedDeliveryDate: '2026-11-10',
      deliveryAddress: ' Mokolo ',
    });
    expect(slip).toMatchObject({
      type: 'CC',
      customerId: IDS.customer,
      fulfilmentLocationId: IDS.pos,
      requestedDeliveryDate: '2026-11-10',
      deliveryAddress: 'Mokolo',
      totalXaf: 14_000,
    });
    expect(issuesOf({ ...base, customerId: null })).toContain('CUSTOMER_REQUIRED');
    expect(issuesOf({ ...base, requestedDeliveryDate: '10/11/2026' })).toContain(
      'DELIVERY_DATE_INVALID',
    );
  });
});

describe('RE : reçu d’encaissement (sales.payment.record)', () => {
  const base = { slipType: 'RE' as const, paperRef: 'RE-000099', customerId: IDS.customer };

  it('client, moyen et montant', () => {
    const payment = { ...emptySlipForm(NOW).payment, amountText: '25000' };
    expect(slipOf({ ...base, payment }).slip).toMatchObject({
      type: 'RE',
      customerId: IDS.customer,
      payment: { methodCode: 'ESPECES', amountXaf: 25_000 },
    });
    expect(issuesOf({ ...base, payment: emptySlipForm(NOW).payment })).toContain('AMOUNT_INVALID');
    expect(issuesOf({ ...base, customerId: null, payment })).toContain('CUSTOMER_REQUIRED');
    expect(
      issuesOf({ ...base, payment: { ...payment, methodCode: 'MOBILE_MONEY_ORANGE' } }),
    ).toContain('PAYMENT_INVALID');
  });
});

describe('BL : bon de livraison (sales.order.fulfil)', () => {
  const base = { slipType: 'BL' as const, paperRef: 'BL-000018', orderId: ORDER_ID };

  it('par défaut tout ce qui reste à livrer, sinon les quantités saisies', () => {
    expect(slipOf(base).slip).toMatchObject({
      type: 'BL',
      orderId: ORDER_ID,
      lines: [{ orderLineId: ORDER_LINE_ID, quantityBase: 4 }],
    });
    const { slip } = slipOf({
      ...base,
      quantities: { [ORDER_LINE_ID]: '3' },
      recipient: ' M. Mballa ',
    });
    expect(slip).toMatchObject({ recipientName: 'M. Mballa', lines: [{ quantityBase: 3 }] });
  });

  it('au-delà du reste à livrer, rien à livrer, commande inconnue', () => {
    expect(issuesOf({ ...base, quantities: { [ORDER_LINE_ID]: '5' } })).toContain(
      'QUANTITY_INVALID',
    );
    expect(issuesOf({ ...base, quantities: { [ORDER_LINE_ID]: '0' } })).toContain(
      'QUANTITY_REQUIRED',
    );
    expect(issuesOf({ ...base, orderId: 'inconnue' })).toContain('ORDER_REQUIRED');
  });
});

describe('BD : bon de décaissement (finance.expense.record)', () => {
  const base = {
    slipType: 'BD' as const,
    paperRef: 'BD-000055',
    categoryId: EXPENSE_IDS.transport,
    siteId: IDS.site,
    accountId: POS_CASH_ACCOUNT,
    amountText: '12500',
    description: ' Achat ampoules ',
    payeeName: 'Quincaillerie Centrale',
  };

  it('catégorie, site, compte payeur, montant et objet', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'BD',
      categoryId: EXPENSE_IDS.transport,
      siteId: IDS.site,
      amountXaf: 12_500,
      description: 'Achat ampoules',
      payeeName: 'Quincaillerie Centrale',
      paidFromAccountId: POS_CASH_ACCOUNT,
    });
  });

  it('catégorie système, site, compte, montant et objet manquants', () => {
    expect(issuesOf({ ...base, categoryId: EXPENSE_IDS.unjustified })).toContain(
      'CATEGORY_REQUIRED',
    );
    expect(issuesOf({ ...base, siteId: '' })).toContain('SITE_REQUIRED');
    expect(issuesOf({ ...base, accountId: '' })).toContain('ACCOUNT_REQUIRED');
    expect(issuesOf({ ...base, amountText: '0' })).toContain('AMOUNT_INVALID');
    expect(issuesOf({ ...base, description: '  ' })).toContain('DESCRIPTION_REQUIRED');
  });
});

describe('RF : remise de fonds (finance.cash_transfer.send)', () => {
  const base = {
    slipType: 'RF' as const,
    paperRef: 'RF-000007',
    accountId: POS_CASH_ACCOUNT,
    toAccountId: CENTRAL_CASH_ACCOUNT,
    amountText: '100000',
    carrierName: 'Ali',
  };

  it('source, destination admise (paires du paramètre), montant', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'RF',
      fromAccountId: POS_CASH_ACCOUNT,
      toAccountId: CENTRAL_CASH_ACCOUNT,
      amountXaf: 100_000,
      carrierName: 'Ali',
    });
    expect(issuesOf({ ...base, accountId: '' })).toContain('ACCOUNT_REQUIRED');
    expect(issuesOf({ ...base, toAccountId: POS_CASH_ACCOUNT })).toContain('DESTINATION_REQUIRED');
    expect(issuesOf({ ...base, amountText: '' })).toContain('AMOUNT_INVALID');
  });
});

describe('BR : bon de réception (procurement.receipt.record)', () => {
  const base = { slipType: 'BR' as const, paperRef: 'BR-000012', locationId: IDS.pos };

  it('sur bon de commande : fournisseur du bon, quantités reçues par ligne', () => {
    const { slip } = slipOf({
      ...base,
      orderId: PURCHASE_ORDER,
      quantities: { [PO_LINE]: '120' },
      deliveryNoteRef: ' BL-FOUR-1 ',
    });
    expect(slip).toEqual({
      type: 'BR',
      purchaseOrderId: PURCHASE_ORDER,
      supplierId: SUPPLIER,
      locationId: IDS.pos,
      supplierDeliveryNoteRef: 'BL-FOUR-1',
      lines: [{ poLineId: PO_LINE, productId: IDS.eggs, unitCode: 'U', qtyDeliveredBase: 120 }],
    });
    expect(issuesOf({ ...base, orderId: PURCHASE_ORDER })).toContain('QUANTITY_REQUIRED');
    expect(issuesOf({ ...base, orderId: 'inconnu' })).toContain('ORDER_REQUIRED');
  });

  it('sans bon de commande : fournisseur, produits achetables et prix d’achat déclarés', () => {
    const free = {
      ...base,
      supplierId: SUPPLIER,
      lines: [line({ productId: IDS.eggs, quantityText: '300', priceText: '85' })],
    };
    expect(slipOf(free).slip).toMatchObject({
      type: 'BR',
      supplierId: SUPPLIER,
      lines: [{ productId: IDS.eggs, unitCode: 'U', qtyDeliveredBase: 300, unitCostXaf: 85 }],
    });
    const sansBon = slipOf(free).slip;
    expect(sansBon.type === 'BR' && sansBon.purchaseOrderId).toBeUndefined();
    expect(issuesOf({ ...free, supplierId: '' })).toContain('SUPPLIER_REQUIRED');
    expect(
      issuesOf({ ...free, lines: [line({ productId: IDS.eggs, quantityText: '300' })] }),
    ).toContain('COST_REQUIRED');
    // Le poulet du jeu d'essai n'est pas achetable : le serveur le refuserait (PRODUCT_NOT_PURCHASABLE).
    expect(issuesOf({ ...free, lines: [line({ quantityText: '3', priceText: '85' })] })).toContain(
      'LINE_INVALID',
    );
  });
});

describe('DA : demande d’achat (procurement.request.submit)', () => {
  const base = {
    slipType: 'DA' as const,
    paperRef: 'DA-000009',
    siteId: IDS.site,
    description: ' Renouveler le stock d’œufs ',
    requestedDeliveryDate: '2026-11-12',
    lines: [line({ productId: IDS.eggs, quantityText: '300', priceText: '85' })],
  };

  it('site, justification, besoin et lignes en unité de base ; le prix estimé est facultatif', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'DA',
      siteId: IDS.site,
      neededByDate: '2026-11-12',
      justification: 'Renouveler le stock d’œufs',
      lines: [
        {
          productId: IDS.eggs,
          unitCode: 'U',
          quantity: 300,
          quantityBase: 300,
          estimatedUnitPriceXaf: 85,
        },
      ],
    });
    const bare = slipOf({
      ...base,
      requestedDeliveryDate: '',
      lines: [line({ productId: IDS.eggs, quantityText: '300' })],
    }).slip;
    expect(bare).toEqual({
      type: 'DA',
      siteId: IDS.site,
      justification: 'Renouveler le stock d’œufs',
      lines: [{ productId: IDS.eggs, unitCode: 'U', quantity: 300, quantityBase: 300 }],
    });
  });

  it('défauts : site, justification, date, lignes, produit non achetable, prix invalide', () => {
    expect(issuesOf({ ...base, siteId: '' })).toContain('SITE_REQUIRED');
    expect(issuesOf({ ...base, description: '  ' })).toContain('DESCRIPTION_REQUIRED');
    expect(issuesOf({ ...base, requestedDeliveryDate: '12/11/2026' })).toContain(
      'DELIVERY_DATE_INVALID',
    );
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(
      issuesOf({ ...base, lines: [line({ productId: IDS.eggs, quantityText: '0' })] }),
    ).toContain('LINE_INVALID');
    // Le poulet du jeu d'essai n'est pas achetable : le serveur le refuserait (BR-APP-001).
    expect(issuesOf({ ...base, lines: [line({ quantityText: '3' })] })).toContain('LINE_INVALID');
    expect(
      issuesOf({
        ...base,
        lines: [line({ productId: IDS.eggs, quantityText: '3', priceText: 'abc' })],
      }),
    ).toContain('LINE_INVALID');
  });
});

describe('BC : bon de commande fournisseur (procurement.order.create puis .submit)', () => {
  const base = {
    slipType: 'BC' as const,
    paperRef: 'BC-000031',
    supplierId: SUPPLIER,
    locationId: IDS.pos,
    requestedDeliveryDate: '2026-11-10',
    lines: [line({ productId: IDS.eggs, quantityText: '300', priceText: '85' })],
  };

  it('fournisseur, emplacement de livraison, prix de chaque ligne ; total pour le registre', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'BC',
      supplierId: SUPPLIER,
      deliveryLocationId: IDS.pos,
      expectedDeliveryDate: '2026-11-10',
      lines: [{ productId: IDS.eggs, unitCode: 'U', orderedQtyBase: 300, unitPriceXaf: 85 }],
      totalXaf: 25_500,
    });
    expect(slipOf({ ...base, requestedDeliveryDate: '' }).slip).not.toHaveProperty(
      'expectedDeliveryDate',
    );
  });

  it('défauts : fournisseur, emplacement, date, lignes, prix de chaque ligne, produit non achetable', () => {
    expect(issuesOf({ ...base, supplierId: '' })).toContain('SUPPLIER_REQUIRED');
    expect(issuesOf({ ...base, locationId: '' })).toContain('LOCATION_REQUIRED');
    expect(issuesOf({ ...base, requestedDeliveryDate: 'demain' })).toContain(
      'DELIVERY_DATE_INVALID',
    );
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(
      issuesOf({ ...base, lines: [line({ productId: IDS.eggs, quantityText: '300' })] }),
    ).toContain('COST_REQUIRED');
    expect(issuesOf({ ...base, lines: [line({ quantityText: '3', priceText: '85' })] })).toContain(
      'LINE_INVALID',
    );
  });
});

describe('VC : fiche de visite (crm.visit.record)', () => {
  const base = {
    slipType: 'VC' as const,
    paperRef: 'VC-000018',
    customerId: IDS.customer,
    visitOutcomeId: VISIT_OUTCOME,
    notes: ' Intéressé par 30 plateaux par semaine ',
    nextActionDate: '2026-11-17',
    nextActionNote: ' Apporter un échantillon ',
  };

  async function withOutcome(active = true): Promise<void> {
    await getDb().projections.put(
      put('reason_code', 'REASON_CODE', VISIT_OUTCOME, {
        id: VISIT_OUTCOME,
        category: 'VISIT_OUTCOME',
        code: 'INTERESSE',
        label: 'Intéressé',
        loss_category: null,
        requires_comment: false,
        is_active: active,
      }),
    );
    refs = await loadSalesReferences(getDb());
  }

  it('client, résultat, compte rendu et prochaine action ; sans position', async () => {
    await withOutcome();
    expect(slipOf(base).slip).toEqual({
      type: 'VC',
      customerId: IDS.customer,
      outcomeReasonCodeId: VISIT_OUTCOME,
      notes: 'Intéressé par 30 plateaux par semaine',
      nextActionAt: '2026-11-17',
      nextActionNote: 'Apporter un échantillon',
    });
    const bare = slipOf({ ...base, notes: '', nextActionDate: '', nextActionNote: '' }).slip;
    expect(bare).toEqual({
      type: 'VC',
      customerId: IDS.customer,
      outcomeReasonCodeId: VISIT_OUTCOME,
    });
  });

  it('défauts : client, résultat (actif seulement), date de la prochaine action', async () => {
    await withOutcome();
    expect(issuesOf({ ...base, customerId: null })).toContain('CUSTOMER_REQUIRED');
    expect(issuesOf({ ...base, customerId: 'inconnu' })).toContain('CUSTOMER_UNKNOWN');
    expect(issuesOf({ ...base, visitOutcomeId: '' })).toContain('OUTCOME_REQUIRED');
    expect(issuesOf({ ...base, nextActionDate: '17/11' })).toContain('NEXT_ACTION_INVALID');
    await withOutcome(false);
    expect(issuesOf(base)).toContain('OUTCOME_REQUIRED');
  });
});

describe('FI : fiche d’inventaire (inventory.count.open, .record_lines puis .submit)', () => {
  const base = {
    slipType: 'FI' as const,
    paperRef: 'FI-000004',
    locationId: STORE,
    countType: 'FULL' as const,
    lines: [
      line({ key: 'k1', productId: IDS.eggs, quantityText: '118' }),
      line({ key: 'k2', quantityText: '0' }),
    ],
  };

  it('emplacement, nature et quantités comptées en unité de base, zéro compris', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'FI',
      locationId: STORE,
      countType: 'FULL',
      lines: [
        { productId: IDS.eggs, countedQtyBase: 118 },
        { productId: IDS.chicken, countedQtyBase: 0 },
      ],
    });
  });

  it('défauts : emplacement, lignes, quantité obligatoire, produit en double', () => {
    expect(issuesOf({ ...base, locationId: '' })).toContain('LOCATION_REQUIRED');
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(
      issuesOf({ ...base, lines: [line({ productId: IDS.eggs, quantityText: '' })] }),
    ).toContain('LINE_INVALID');
    expect(
      issuesOf({
        ...base,
        lines: [
          line({ key: 'k1', productId: IDS.eggs, quantityText: '10' }),
          line({ key: 'k2', productId: IDS.eggs, quantityText: '12' }),
        ],
      }),
    ).toContain('LINE_INVALID');
  });
});

describe('FL : fiche de suivi de lot (saisies du jour du lot)', () => {
  const LOT = '01900000-0000-7000-8000-000000000140';
  const BUILDING = '01900000-0000-7000-8000-000000000141';
  const FEED = '01900000-0000-7000-8000-000000000142';
  const CAUSE = '01900000-0000-7000-8000-000000000143';
  const CAUSE_COMMENT = '01900000-0000-7000-8000-000000000144';
  const SACK_FEED = '01900000-0000-7000-8000-000000000145';
  const OTHER_SITE_STORE = '01900000-0000-7000-8000-000000000146';
  const OTHER_SITE = '01900000-0000-7000-8000-000000000147';

  const day = (overrides: Partial<LotDayForm> = {}): LotDayForm => ({
    key: 'd1',
    date: '2026-11-03',
    deathsText: '',
    deathReasonId: '',
    feedProductId: '',
    feedKgText: '',
    sampleText: '',
    avgWeightText: '',
    observation: '',
    ...overrides,
  });
  const full = day({
    deathsText: '3',
    deathReasonId: CAUSE,
    feedProductId: FEED,
    feedKgText: '45',
    sampleText: '20',
    avgWeightText: '1250',
    observation: ' Vaccin Newcastle ',
  });
  const base = {
    slipType: 'FL' as const,
    paperRef: 'FL-000012',
    lotId: LOT,
    locationId: BUILDING,
    feedLocationId: STORE,
    lotDays: [full],
  };
  const noonOf = (date: string) => new Date(`${date}T12:00`).toISOString();

  beforeEach(async () => {
    const location = (id: string, siteId: string, type: string, name: string) =>
      put('location', 'LOCATION', id, {
        id,
        site_id: siteId,
        code: `L-${id.slice(-3)}`,
        name,
        location_type: type,
        is_virtual: false,
        custody_mode: null,
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      });
    const feed = (id: string, name: string, baseUnit: string) =>
      put('product', 'PRODUCT', id, {
        id,
        code: `PRV-${id.slice(-3)}`,
        name,
        category_id: IDS.zone,
        base_unit_code: baseUnit,
        stock_family: 'INTRANT',
        is_sellable: false,
        is_purchasable: true,
        is_consumable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
      });
    const cause = (id: string, label: string, requiresComment: boolean) =>
      put('reason_code', 'REASON_CODE', id, {
        id,
        category: 'LOSS',
        code: `C-${id.slice(-3)}`,
        label,
        loss_category: 'MORTALITE',
        requires_comment: requiresComment,
        is_active: true,
      });
    await getDb().projections.bulkPut([
      location(BUILDING, IDS.site, 'BUILDING', 'Bâtiment 1'),
      location(OTHER_SITE_STORE, OTHER_SITE, 'STORE', 'Magasin d’une autre ferme'),
      put('production', 'PRODUCTION_LOT', LOT, {
        id: LOT,
        lot_code: 'LOT-CH-001',
        lot_type: 'POULET_CHAIR',
        product_id: IDS.chicken,
        stock_lot_id: IDS.chicken,
        site_id: IDS.site,
        main_location_id: BUILDING,
        strain: null,
        status: 'ACTIVE',
        start_date: '2026-10-01',
        planned_end_date: null,
        initial_quantity: 500,
        occurred_at: '2026-10-01T08:00:00.000Z',
      }),
      feed(FEED, 'Provende chair', 'KG'),
      // Un aliment que l'on ne compte qu'en sacs : la fiche est en kilogrammes.
      feed(SACK_FEED, 'Provende en sacs', 'SAC'),
      cause(CAUSE, 'Maladie', false),
      cause(CAUSE_COMMENT, 'Cause inconnue', true),
    ]);
    refs = await loadSalesReferences(getDb());
  });

  it('lot, bâtiment, magasin et une saisie par mesure renseignée, à midi du jour de la ligne', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'FL',
      lotId: LOT,
      locationId: BUILDING,
      feedLocationId: STORE,
      days: [
        {
          date: '2026-11-03',
          occurredAt: noonOf('2026-11-03'),
          mortality: { quantity: 3, reasonCodeId: CAUSE },
          input: { productId: FEED, unitCode: 'KG', quantity: 45, quantityBase: 45 },
          weighing: { sampleSize: 20, avgWeightG: 1250 },
          observation: 'Vaccin Newcastle',
        },
      ],
    });
  });

  it('lignes triées par jour ; une ligne vide n’en est pas une ; le magasin n’est exigé qu’avec de l’aliment', () => {
    const result = slipOf({
      ...base,
      feedLocationId: '',
      // La ligne la plus ancienne date de plus de 24 h : un motif d'antidatage est exigé.
      backdatedReason: 'Fiche remplie sur place',
      lotDays: [
        day({ key: 'd3', date: '2026-11-03', deathsText: '2' }),
        day({ key: 'd0' }),
        day({ key: 'd2', date: '2026-11-02', sampleText: '15', avgWeightText: '980,5' }),
      ],
    });
    expect(result.slip).toMatchObject({ type: 'FL', days: expect.any(Array) });
    const slip = result.slip as Extract<typeof result.slip, { type: 'FL' }>;
    expect(slip.days.map((entry) => entry.date)).toEqual(['2026-11-02', '2026-11-03']);
    expect(slip.days[0]!.weighing).toEqual({ sampleSize: 15, avgWeightG: 980.5 });
    expect(slip.days[1]!.mortality).toEqual({ quantity: 2 });
    expect(slip).not.toHaveProperty('feedLocationId');
  });

  it('une ligne du jour même, avant midi, part à l’instant du contrôle (jamais dans le futur)', () => {
    const slip = slipOf({
      ...base,
      lotDays: [day({ date: '2026-11-04', deathsText: '1' })],
    }).slip as Extract<ResolvedSlipOf, { type: 'FL' }>;
    expect(slip.days[0]!.occurredAt).toBe(NOW.toISOString());
  });

  it('défauts : lot, bâtiment du lot, lignes', () => {
    expect(issuesOf({ ...base, lotId: '' })).toContain('LOT_REQUIRED');
    expect(issuesOf({ ...base, locationId: '' })).toContain('LOCATION_REQUIRED');
    // Un magasin n'est pas un bâtiment d'élevage.
    expect(issuesOf({ ...base, locationId: STORE })).toContain('LOCATION_REQUIRED');
    expect(issuesOf({ ...base, lotDays: [day()] })).toContain('DAYS_REQUIRED');
    expect(issuesOf({ ...base, lotDays: [] })).toContain('DAYS_REQUIRED');
  });

  it('défauts : jour invalide, dans le futur ou répété', () => {
    const row = (key: string, date: string) => day({ key, date, deathsText: '1' });
    expect(issuesOf({ ...base, lotDays: [row('a', '2026-11-05')] })).toContain('DAY_INVALID');
    expect(issuesOf({ ...base, lotDays: [row('a', '2026-02-31')] })).toContain('DAY_INVALID');
    expect(issuesOf({ ...base, lotDays: [row('a', '')] })).toContain('DAY_INVALID');
    expect(
      issuesOf({ ...base, lotDays: [row('a', '2026-11-03'), row('b', '2026-11-03')] }),
    ).toContain('DAY_INVALID');
  });

  it('défauts : mortalité, aliment et pesée incomplets ou invalides', () => {
    const measure = (overrides: Partial<LotDayForm>) =>
      issuesOf({ ...base, lotDays: [day({ deathsText: '', ...overrides })] });
    expect(measure({ deathsText: 'abc' })).toContain('MEASURE_INVALID');
    expect(measure({ deathsText: '0' })).toContain('MEASURE_INVALID');
    expect(measure({ deathsText: '2,5' })).toContain('MEASURE_INVALID');
    // Une cause sans nombre de morts, ou une cause inconnue.
    expect(measure({ deathReasonId: CAUSE, observation: 'x' })).toContain('MEASURE_INVALID');
    expect(measure({ deathsText: '2', deathReasonId: IDS.eggs })).toContain('MEASURE_INVALID');
    // Aliment : produit et quantité vont ensemble, en kg, sur un produit consommable.
    expect(measure({ feedProductId: FEED })).toContain('MEASURE_INVALID');
    expect(measure({ feedKgText: '45' })).toContain('MEASURE_INVALID');
    expect(measure({ feedProductId: FEED, feedKgText: '-4' })).toContain('MEASURE_INVALID');
    expect(measure({ feedProductId: SACK_FEED, feedKgText: '45' })).toContain('MEASURE_INVALID');
    expect(measure({ feedProductId: IDS.eggs, feedKgText: '45' })).toContain('MEASURE_INVALID');
    // Pesée : l'échantillon et le poids moyen vont ensemble.
    expect(measure({ sampleText: '20' })).toContain('MEASURE_INVALID');
    expect(measure({ avgWeightText: '1250' })).toContain('MEASURE_INVALID');
    expect(measure({ sampleText: '20', avgWeightText: 'lourd' })).toContain('MEASURE_INVALID');
    expect(measure({ sampleText: '0', avgWeightText: '1250' })).toContain('MEASURE_INVALID');
  });

  it('une cause qui exige un commentaire prend celui de la ligne ; sans lui, la ligne est refusée', () => {
    const withCause = (observation: string) =>
      day({ deathsText: '4', deathReasonId: CAUSE_COMMENT, observation });
    expect(issuesOf({ ...base, lotDays: [withCause('')] })).toContain('COMMENT_REQUIRED');
    const slip = slipOf({ ...base, lotDays: [withCause(' Mortalité brutale la nuit ')] })
      .slip as Extract<ResolvedSlipOf, { type: 'FL' }>;
    expect(slip.days[0]!.mortality).toEqual({
      quantity: 4,
      reasonCodeId: CAUSE_COMMENT,
      comment: 'Mortalité brutale la nuit',
    });
  });

  it('aliment : le magasin est exigé, et il doit être de la ferme du lot', () => {
    const feeding = [day({ feedProductId: FEED, feedKgText: '45' })];
    expect(issuesOf({ ...base, feedLocationId: '', lotDays: feeding })).toContain(
      'FEED_LOCATION_REQUIRED',
    );
    expect(issuesOf({ ...base, feedLocationId: OTHER_SITE_STORE, lotDays: feeding })).toContain(
      'FEED_LOCATION_REQUIRED',
    );
  });

  it('les défauts sont rendus ensemble, une seule fois chacun', () => {
    const issues = issuesOf({
      ...base,
      lotId: '',
      paperRef: '',
      lotDays: [
        day({ key: 'a', deathsText: 'x' }),
        day({ key: 'b', date: '2026-11-02', deathsText: 'y' }),
      ],
    });
    expect(issues).toContain('REF_REQUIRED');
    expect(issues).toContain('LOT_REQUIRED');
    expect(issues.filter((issue) => issue === 'MEASURE_INVALID')).toHaveLength(1);
  });

  it('l’antidatage se juge sur la ligne la plus ancienne : motif au-delà de 24 h, heure de la pièce = cette ligne', () => {
    const rows = [
      day({ key: 'a', date: '2026-11-03', deathsText: '1' }),
      day({ key: 'b', date: '2026-11-02', deathsText: '2' }),
    ];
    expect(issuesOf({ ...base, lotDays: rows })).toContain('BACKDATE_REASON_REQUIRED');
    const ok = slipOf({ ...base, lotDays: rows, backdatedReason: ' Fiche remplie sur place ' });
    expect(ok.meta.occurredAt).toBe(noonOf('2026-11-02'));
    expect(ok.meta.backdatedReason).toBe('Fiche remplie sur place');
    // Une ligne du jour seule n'exige aucun motif.
    expect(
      slipOf({ ...base, lotDays: [day({ date: '2026-11-04', deathsText: '1' })] }).meta
        .backdatedReason,
    ).toBeNull();
  });

  it('backdatingBasis : l’heure de la pièce, sauf pour une fiche de lot qui prend sa ligne la plus ancienne', () => {
    const typed = form({ occurredAt: MORNING });
    expect(backdatingBasis(typed, NOW)).toBe(MORNING);
    expect(backdatingBasis({ ...typed, slipType: 'FL' }, NOW)).toBe(MORNING);
    expect(
      backdatingBasis(
        {
          ...typed,
          slipType: 'FL',
          lotDays: [
            day({ key: 'a', date: '2026-11-03', deathsText: '1' }),
            day({ key: 'b', date: 'x', deathsText: '1' }),
          ],
        },
        NOW,
      ),
    ).toBe(toLocalInput(new Date(noonOf('2026-11-03'))));
  });
});

describe('BT : bon de transfert (inventory.transfer.dispatch)', () => {
  const base = {
    slipType: 'BT' as const,
    paperRef: 'BT-000023',
    locationId: STORE,
    toLocationId: IDS.pos,
    lines: [line({ productId: IDS.eggs, unitCode: 'PLATEAU', quantityText: '2' })],
    notes: 'Réapprovisionnement',
  };

  it('départ, arrivée différente, lignes en unité de base', () => {
    expect(slipOf(base).slip).toEqual({
      type: 'BT',
      fromLocationId: STORE,
      toLocationId: IDS.pos,
      notes: 'Réapprovisionnement',
      lines: [{ productId: IDS.eggs, unitCode: 'PLATEAU', quantityBase: 60 }],
    });
    expect(issuesOf({ ...base, toLocationId: STORE })).toContain('DESTINATION_REQUIRED');
    expect(issuesOf({ ...base, locationId: '' })).toContain('LOCATION_REQUIRED');
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(issuesOf({ ...base, lines: [line({ quantityText: '0' })] })).toContain('LINE_INVALID');
  });
});

describe('FP : fiche de perte (inventory.loss.declare)', () => {
  const base = {
    slipType: 'FP' as const,
    paperRef: 'FP-000004',
    locationId: IDS.pos,
    lines: [line({ productId: IDS.eggs, quantityText: '3' })],
    lossCategory: 'CASSE' as const,
    notes: 'Cageots tombés',
  };

  it('emplacement, produit, quantité, catégorie, motif facultatif et commentaire', () => {
    expect(slipOf({ ...base, lossReasonId: LOSS_REASON }).slip).toEqual({
      type: 'FP',
      locationId: IDS.pos,
      productId: IDS.eggs,
      unitCode: 'U',
      quantity: 3,
      quantityBase: 3,
      category: 'CASSE',
      reasonCodeId: LOSS_REASON,
      comment: 'Cageots tombés',
    });
    expect(issuesOf({ ...base, lossCategory: '' })).toContain('LOSS_CATEGORY_REQUIRED');
    expect(issuesOf({ ...base, lines: [] })).toContain('LINES_REQUIRED');
    expect(
      issuesOf({ ...base, lines: [line({ productId: IDS.eggs, quantityText: '' })] }),
    ).toContain('LINE_INVALID');
  });

  it('un vol suspecté exige un commentaire ; un motif d’une autre catégorie est écarté', () => {
    expect(issuesOf({ ...base, lossCategory: 'VOL_SUSPECTE', notes: '' })).toContain(
      'COMMENT_REQUIRED',
    );
    const { slip } = slipOf({ ...base, lossCategory: 'VOL_SUSPECTE', lossReasonId: LOSS_REASON });
    expect(slip.type === 'FP' && slip.reasonCodeId).toBeUndefined();
  });
});

describe('gardes du serveur reprises par le formulaire', () => {
  it('RE : sans site d’attache du client, le site de l’encaissement est obligatoire (SITE_REQUIRED)', async () => {
    await getDb().projections.put(
      put('customers', 'CUSTOMER', IDS.customer, {
        id: IDS.customer,
        stage: 'CUSTOMER',
        display_name: 'Boutique Mvog-Mbi',
        contact_name: null,
        category_id: null,
        phone_primary: '+237 699 11 22 33',
        zone_id: IDS.zone,
        owner_user_id: IDS.user,
        home_site_id: null,
        merged_into_id: null,
        credit_allowed: true,
        credit_limit_xaf: 50_000,
        payment_terms_days: 30,
        outstanding_xaf: 0,
        version: 1,
      }),
    );
    refs = await loadSalesReferences(getDb());
    const base = {
      slipType: 'RE' as const,
      paperRef: 'RE-000099',
      customerId: IDS.customer,
      payment: { ...emptySlipForm(NOW).payment, amountText: '25000' },
    };
    expect(issuesOf(base)).toContain('SITE_REQUIRED');
    expect(slipOf({ ...base, siteId: IDS.site }).slip).toMatchObject({
      type: 'RE',
      siteId: IDS.site,
    });
  });

  it('BR : une réception hors du site du bon de commande exige son motif dans les observations (AV-096)', async () => {
    const FARM_STORE = '01900000-0000-7000-8000-000000000033';
    await getDb().projections.bulkPut([
      siteRow(),
      put('location', 'LOCATION', FARM_STORE, {
        id: FARM_STORE,
        site_id: EXPENSE_IDS.farm,
        code: 'FERME-MAG',
        name: 'Magasin de la ferme',
        location_type: 'STORE',
        is_virtual: false,
        custody_mode: null,
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      }),
    ]);
    refs = await loadSalesReferences(getDb());
    const base = {
      slipType: 'BR' as const,
      paperRef: 'BR-000012',
      orderId: PURCHASE_ORDER,
      locationId: FARM_STORE,
      quantities: { [PO_LINE]: '10' },
    };
    expect(issuesOf(base)).toContain('OBSERVATIONS_REQUIRED');
    const { slip } = slipOf({ ...base, notes: 'Livré à la ferme sur instruction du responsable' });
    expect(slip.type === 'BR' && slip.observations).toBe(
      'Livré à la ferme sur instruction du responsable',
    );
    // Sur le site du bon de commande, aucun motif n'est exigé.
    expect(issuesOf({ ...base, locationId: IDS.pos, quantities: {} })).not.toContain(
      'OBSERVATIONS_REQUIRED',
    );
  });
});

describe('contrôle des fixtures', () => {
  it('le jeu d’essai porte bien les référentiels utilisés ci-dessus', () => {
    expect(refs.cashAccounts.map((account) => account.id)).toContain(POS_CASH_ACCOUNT);
    expect(refs.cashTransferTargets.map((target) => target.id)).toContain(CENTRAL_CASH_ACCOUNT);
    expect(refs.expenseCategories).toHaveLength(2);
    expect(refs.suppliers.has(SUPPLIER)).toBe(true);
  });
});
