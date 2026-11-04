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
  orderRow,
  posCashAccountRow,
  seedSalesFixtures,
  siteRow,
} from '../sales/fixtures.js';
import { loadSalesReferences, type SalesReferences } from '../sales/references.js';
import type { DraftLine } from '../sales/sale-form.js';
import {
  emptySlipForm,
  previewTotal,
  resolveSlip,
  toLocalInput,
  type SlipContext,
  type SlipForm,
  type SlipIssue,
} from './report-form.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
/** Pièce du matin même : dans les 24 h, aucun motif d'antidatage requis. */
const MORNING = toLocalInput(new Date('2026-11-04T08:00:00.000Z'));

const STORE = '01900000-0000-7000-8000-000000000032';
const SUPPLIER = '01900000-0000-7000-8000-000000000120';
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
