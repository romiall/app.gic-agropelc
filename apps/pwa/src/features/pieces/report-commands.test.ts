/**
 * Correspondance pièce papier → commande du serveur (PP-B ; REQ-303, AV-308, AV-501 à AV-504).
 *
 * Ces essais décrivent la forme des commandes ; qu'elles soient **acceptées** par le serveur est prouvé
 * par `apps/server/test/pwa-paper-slip-commands.test.ts` (vrai pipeline) et que leurs types existent côté
 * serveur par `apps/server/test/pwa-command-types.test.ts`. Les charges de la dépense et de la remise de
 * fonds sont, en plus, confrontées ici aux schémas partagés du serveur (`@gic/contracts`).
 */
import { describe, expect, it } from 'vitest';
import { cashTransferSendPayloadSchema, expenseRecordPayloadSchema } from '@gic/contracts';
import {
  MAX_SLIP_REF_LENGTH,
  REPORTABLE_SLIP_TYPES,
  NON_REPORTABLE_SLIP_CODES,
  buildReportCommand,
  buildReportCommands,
  carriesLocalRef,
  paperRefPlace,
  slipPhotoTarget,
  withPaperRef,
  type ReportMeta,
  type ReportableSlipType,
  type ResolvedSlip,
} from './report-commands.js';

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const meta = (overrides: Partial<ReportMeta> = {}): ReportMeta => ({
  paperRef: 'BV-000142',
  occurredAt: '2026-11-03T09:00:00.000Z',
  backdatedReason: null,
  aggregateId: id(99),
  ...overrides,
});

const line = {
  productId: id(1),
  quantity: 4,
  unitCode: 'U',
  quantityBase: 4,
  listUnitPriceXaf: 3000,
  priceRuleId: id(2),
  unitPriceXaf: 3000,
};

/** Une pièce résolue de chaque type, aux identifiants des référentiels. */
const SLIPS: Readonly<Record<ReportableSlipType, ResolvedSlip>> = {
  BV: {
    type: 'BV',
    fromLocationId: id(10),
    customerId: id(11),
    channelCode: 'POINT_DE_VENTE',
    lines: [line],
    payment: { methodCode: 'ESPECES', amountXaf: 12000 },
    totalXaf: 12000,
  },
  CC: {
    type: 'CC',
    customerId: id(11),
    fulfilmentLocationId: id(10),
    requestedDeliveryDate: '2026-11-10',
    deliveryAddress: 'Marché Mokolo',
    lines: [line],
    totalXaf: 12000,
  },
  RE: {
    type: 'RE',
    customerId: id(11),
    payment: { methodCode: 'MOBILE_MONEY_MTN', amountXaf: 50000, reference: 'MOMO-1' },
  },
  BL: {
    type: 'BL',
    orderId: id(20),
    recipientName: 'M. Mballa',
    lines: [{ orderLineId: id(21), quantityBase: 3 }],
  },
  BD: {
    type: 'BD',
    categoryId: id(30),
    siteId: id(31),
    amountXaf: 12500,
    description: 'Achat ampoules et cadenas',
    payeeName: 'Quincaillerie Centrale',
    paidFromAccountId: id(32),
  },
  RF: {
    type: 'RF',
    fromAccountId: id(40),
    toAccountId: id(41),
    amountXaf: 100000,
    carrierName: 'Ali',
  },
  BR: {
    type: 'BR',
    supplierId: id(50),
    locationId: id(51),
    lines: [{ productId: id(1), unitCode: 'U', qtyDeliveredBase: 20, unitCostXaf: 300 }],
  },
  BT: {
    type: 'BT',
    fromLocationId: id(60),
    toLocationId: id(61),
    notes: 'Réapprovisionnement',
    lines: [{ productId: id(1), unitCode: 'U', quantityBase: 15 }],
  },
  FP: {
    type: 'FP',
    locationId: id(60),
    productId: id(1),
    unitCode: 'U',
    quantity: 2,
    quantityBase: 2,
    category: 'CASSE',
    comment: 'Cageots tombés',
  },
  DA: {
    type: 'DA',
    siteId: id(70),
    neededByDate: '2026-11-12',
    justification: 'Aliment démarrage à renouveler',
    lines: [
      {
        productId: id(1),
        unitCode: 'SAC',
        quantity: 20,
        quantityBase: 20,
        estimatedUnitPriceXaf: 18500,
      },
      { productId: id(3), unitCode: 'U', quantity: 5, quantityBase: 5 },
    ],
  },
  BC: {
    type: 'BC',
    supplierId: id(71),
    deliveryLocationId: id(60),
    expectedDeliveryDate: '2026-11-10',
    lines: [{ productId: id(1), unitCode: 'SAC', orderedQtyBase: 20, unitPriceXaf: 18000 }],
    totalXaf: 360000,
  },
  VC: {
    type: 'VC',
    customerId: id(11),
    outcomeReasonCodeId: id(72),
    notes: 'Intéressé par 30 plateaux par semaine',
    nextActionAt: '2026-11-17',
    nextActionNote: 'Apporter un échantillon',
  },
  FI: {
    type: 'FI',
    locationId: id(60),
    countType: 'PARTIAL',
    lines: [
      { productId: id(1), countedQtyBase: 118 },
      { productId: id(3), countedQtyBase: 0 },
    ],
  },
};

/** Commandes enregistrées par le serveur pour chaque pièce (voir le tableau de `report-commands.ts`). */
const EXPECTED: Readonly<Record<ReportableSlipType, readonly [string, string]>> = {
  BV: ['sales.sale.record', 'SALE'],
  CC: ['sales.order.place', 'SALES_ORDER'],
  BL: ['sales.order.fulfil', 'DELIVERY_NOTE'],
  RE: ['sales.payment.record', 'CUSTOMER_PAYMENT'],
  BD: ['finance.expense.record', 'EXPENSE'],
  RF: ['finance.cash_transfer.send', 'CASH_TRANSFER'],
  BR: ['procurement.receipt.record', 'GOODS_RECEIPT'],
  BT: ['inventory.transfer.dispatch', 'STOCK_TRANSFER'],
  FP: ['inventory.loss.declare', 'STOCK_LOSS'],
  DA: ['procurement.request.submit', 'PURCHASE_REQUEST'],
  BC: ['procurement.order.create', 'PURCHASE_ORDER'],
  VC: ['crm.visit.record', 'VISIT'],
  FI: ['inventory.count.open', 'INVENTORY_COUNT'],
};

/** Clés que l'ancienne correspondance inventait : le serveur ne les connaît dans aucune charge. */
const INVENTED_KEYS = [
  'saleId',
  'items',
  'paperSlipRef',
  'totalAmountXaf',
  'customerName',
  'transferId',
  'lossDeclarationId',
  'goodsReceiptId',
  'deliveryNoteId',
  'sourceAccountId',
  'destinationAccountId',
  'expenseId',
  'paymentId',
  'expenseCategoryId',
  'sourceLocationId',
  'targetLocationId',
];

describe('buildReportCommand : une pièce, la commande réelle du serveur', () => {
  it.each(REPORTABLE_SLIP_TYPES)('%s : type de commande et agrégat du serveur', (type) => {
    const command = buildReportCommand(SLIPS[type], meta({ paperRef: `${type}-000042` }));
    expect([command.commandType, command.aggregateType]).toEqual(EXPECTED[type]);
    expect(command.aggregateId).toBe(id(99));
    for (const key of INVENTED_KEYS) expect(command.payload).not.toHaveProperty(key);
  });

  it('BV : charge de sales.sale.record (emplacement, lignes au prix inscrit, règlement joint)', () => {
    const { payload } = buildReportCommand(SLIPS.BV, meta());
    expect(payload).toEqual({
      fromLocationId: id(10),
      customerId: id(11),
      channelCode: 'POINT_DE_VENTE',
      localRef: 'BV-000142',
      lines: [
        {
          productId: id(1),
          quantity: 4,
          unitCode: 'U',
          quantityBase: 4,
          listUnitPriceXaf: 3000,
          priceRuleId: id(2),
          unitPriceXaf: 3000,
        },
      ],
      payments: [{ methodCode: 'ESPECES', amountXaf: 12000 }],
    });
  });

  it('BV à crédit : aucun règlement joint ; vente de passage : aucun client', () => {
    const credit = buildReportCommand({ ...SLIPS.BV, payment: undefined } as ResolvedSlip, meta());
    expect(credit.payload).not.toHaveProperty('payments');
    const anonymous = buildReportCommand(
      { ...SLIPS.BV, customerId: undefined } as ResolvedSlip,
      meta(),
    );
    expect(anonymous.payload).not.toHaveProperty('customerId');
  });

  it('une valeur absente n’est pas envoyée (ni null, ni undefined) : le serveur refuse null', () => {
    for (const type of REPORTABLE_SLIP_TYPES) {
      const { payload } = buildReportCommand(SLIPS[type], meta({ paperRef: `${type}-1` }));
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === 'object') {
          for (const [key, entry] of Object.entries(value)) {
            expect(entry, `${type}.${key}`).not.toBeUndefined();
            // Seule exception : `position` d'une visite, clé obligatoire du schéma du serveur, nulle sans GPS.
            if (!(type === 'VC' && key === 'position'))
              expect(entry, `${type}.${key}`).not.toBeNull();
            walk(entry);
          }
        }
      };
      walk(payload);
    }
  });

  it('le numéro de la pièce est localRef, sauf transfert et perte (texte libre)', () => {
    const place = Object.fromEntries(
      REPORTABLE_SLIP_TYPES.map((type) => [type, paperRefPlace(type)]),
    );
    expect(place).toEqual({
      BV: 'LOCAL_REF',
      BD: 'LOCAL_REF',
      RF: 'LOCAL_REF',
      BL: 'LOCAL_REF',
      BR: 'LOCAL_REF',
      CC: 'LOCAL_REF',
      RE: 'LOCAL_REF',
      BT: 'FREE_TEXT',
      FP: 'FREE_TEXT',
      DA: 'LOCAL_REF',
      BC: 'LOCAL_REF',
      VC: 'FREE_TEXT',
      FI: 'LOCAL_REF',
    });
    for (const type of REPORTABLE_SLIP_TYPES) {
      const { payload } = buildReportCommand(SLIPS[type], meta({ paperRef: `${type}-000042` }));
      // L'expédition d'un transfert et la déclaration d'une perte n'acceptent pas `localRef`.
      if (carriesLocalRef(type)) expect(payload['localRef'], type).toBe(`${type}-000042`);
      else expect(payload, type).not.toHaveProperty('localRef');
    }
    const mention = (type: ReportableSlipType, key: string) =>
      buildReportCommand(SLIPS[type], meta({ paperRef: `${type}-000042` })).payload[key];
    expect(mention('BT', 'notes')).toBe('Pièce papier BT-000042 — Réapprovisionnement');
    expect(mention('FP', 'comment')).toBe('Pièce papier FP-000042 — Cageots tombés');
    expect(mention('VC', 'notes')).toBe(
      'Pièce papier VC-000042 — Intéressé par 30 plateaux par semaine',
    );
    // Le texte libre des autres commandes reste celui de l'utilisateur, sans mention.
    expect(mention('BL', 'notes')).toBeUndefined();
    expect(mention('BR', 'observations')).toBeUndefined();
    expect(withPaperRef('FP-4', undefined)).toBe('Pièce papier FP-4');
    expect(withPaperRef('FP-4', 'x'.repeat(3000))).toHaveLength(2000);
  });

  it('un numéro de plus de 20 caractères est refusé là où il devient localRef (schémas du serveur)', () => {
    const tooLong = 'B'.repeat(MAX_SLIP_REF_LENGTH + 1);
    expect(() => buildReportCommand(SLIPS.BV, meta({ paperRef: tooLong }))).toThrow(RangeError);
    expect(() => buildReportCommand(SLIPS.RE, meta({ paperRef: tooLong }))).toThrow(RangeError);
    // Pour un transfert ou une perte, le numéro n'est pas un localRef : la mention reste dans le texte.
    expect(() => buildReportCommand(SLIPS.BT, meta({ paperRef: tooLong }))).not.toThrow();
  });

  it('la pièce est un fait accompli : commande saisie hors ligne, heure et motif de la pièce', () => {
    const command = buildReportCommand(
      SLIPS.BD,
      meta({
        paperRef: 'BD-000055',
        occurredAt: '2026-10-31T08:00:00.000Z',
        backdatedReason: '  Saisie différée de fin de mois  ',
        dependsOn: [id(77)],
      }),
    );
    expect(command.capturedOffline).toBe(true);
    expect(command.occurredAt).toBe('2026-10-31T08:00:00.000Z');
    expect(command.backdatedReason).toBe('Saisie différée de fin de mois');
    expect(command.dependsOn).toEqual([id(77)]);
    const none = buildReportCommand(SLIPS.BD, meta({ backdatedReason: '   ' }));
    expect(none.backdatedReason).toBeNull();
    const long = buildReportCommand(SLIPS.BD, meta({ backdatedReason: 'm'.repeat(900) }));
    expect(long.backdatedReason).toHaveLength(500);
  });

  it('indices locaux : pièce papier, type, numéro et montant (registre des carnets)', () => {
    const sale = buildReportCommand(SLIPS.BV, meta());
    expect(sale.localFlags).toEqual([
      'PAPER_SLIP',
      'SLIP_TYPE:BV',
      'PAPER_REF:BV-000142',
      'SLIP_AMOUNT:12000',
    ]);
    const reception = buildReportCommand(SLIPS.BR, meta({ paperRef: 'BR-000012' }));
    expect(reception.localFlags).toEqual(['PAPER_SLIP', 'SLIP_TYPE:BR', 'PAPER_REF:BR-000012']);
  });

  it('photo de la souche : seulement là où le serveur lit un propriétaire de pièce jointe (ADR-046)', () => {
    expect(slipPhotoTarget('BD')).toEqual({ kind: 'RECEIPT', ownerType: 'EXPENSE', cited: true });
    expect(slipPhotoTarget('BR')).toEqual({
      kind: 'DELIVERY_NOTE',
      ownerType: 'GOODS_RECEIPT',
      cited: true,
    });
    expect(slipPhotoTarget('FP')).toEqual({ kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: false });
    for (const type of ['BV', 'CC', 'BL', 'RE', 'RF', 'BT', 'DA', 'BC', 'VC', 'FI'] as const) {
      expect(slipPhotoTarget(type), type).toBeNull();
    }
  });

  it('DA : charge de procurement.request.submit (site, besoin, justification, lignes en unité de base)', () => {
    const { payload } = buildReportCommand(SLIPS.DA, meta({ paperRef: 'DA-000009' }));
    expect(payload).toEqual({
      siteId: id(70),
      neededByDate: '2026-11-12',
      justification: 'Aliment démarrage à renouveler',
      lines: [
        {
          productId: id(1),
          quantityBase: 20,
          unitCode: 'SAC',
          quantity: 20,
          estimatedUnitPriceXaf: 18500,
        },
        { productId: id(3), quantityBase: 5, unitCode: 'U', quantity: 5 },
      ],
      localRef: 'DA-000009',
    });
  });

  it('BC : create puis submit du même bon, le second attend le premier ; les indices ne sont que sur le premier', () => {
    const commands = buildReportCommands(
      SLIPS.BC,
      meta({ paperRef: 'BC-000031', dependsOn: [id(77)] }),
    );
    expect(commands.map((c) => c.commandType)).toEqual([
      'procurement.order.create',
      'procurement.order.submit',
    ]);
    expect(commands.map((c) => c.aggregateType)).toEqual(['PURCHASE_ORDER', 'PURCHASE_ORDER']);
    expect(commands.map((c) => c.aggregateId)).toEqual([id(99), id(99)]);
    expect(commands.map((c) => c.dependsOnPrevious)).toEqual([false, true]);
    expect(commands[0]!.dependsOn).toEqual([id(77)]);
    expect(commands[1]!.dependsOn).toEqual([]);
    expect(commands[0]!.payload).toEqual({
      supplierId: id(71),
      deliveryLocationId: id(60),
      expectedDeliveryDate: '2026-11-10',
      lines: [{ productId: id(1), unitCode: 'SAC', orderedQtyBase: 20, unitPriceXaf: 18000 }],
      localRef: 'BC-000031',
    });
    expect(commands[1]!.payload).toEqual({});
    expect(commands[0]!.localFlags).toEqual([
      'PAPER_SLIP',
      'SLIP_TYPE:BC',
      'PAPER_REF:BC-000031',
      'SLIP_AMOUNT:360000',
    ]);
    expect(commands[1]!.localFlags).toEqual([]);
    expect(commands.every((c) => c.occurredAt === '2026-11-03T09:00:00.000Z')).toBe(true);
  });

  it('VC : visite sans position, numéro dans les notes, prochaine action', () => {
    const { payload } = buildReportCommand(SLIPS.VC, meta({ paperRef: 'VC-000018' }));
    expect(payload).toEqual({
      customerId: id(11),
      position: null,
      outcomeReasonCodeId: id(72),
      notes: 'Pièce papier VC-000018 — Intéressé par 30 plateaux par semaine',
      nextActionAt: '2026-11-17',
      nextActionNote: 'Apporter un échantillon',
    });
  });

  it('FI : open, record_lines puis submit du même inventaire, lignes datées de l’heure de la pièce', () => {
    const commands = buildReportCommands(SLIPS.FI, meta({ paperRef: 'FI-000004' }));
    expect(commands.map((c) => c.commandType)).toEqual([
      'inventory.count.open',
      'inventory.count.record_lines',
      'inventory.count.submit',
    ]);
    expect(commands.map((c) => c.dependsOnPrevious)).toEqual([false, true, true]);
    expect(commands[0]!.payload).toEqual({
      locationId: id(60),
      countType: 'PARTIAL',
      localRef: 'FI-000004',
    });
    expect(commands[1]!.payload).toEqual({
      countId: id(99),
      lines: [
        { productId: id(1), countedAt: '2026-11-03T09:00:00.000Z', countedQtyBase: 118 },
        { productId: id(3), countedAt: '2026-11-03T09:00:00.000Z', countedQtyBase: 0 },
      ],
    });
    expect(commands[2]!.payload).toEqual({ countId: id(99) });
    expect(commands.slice(1).every((c) => c.localFlags.length === 0 && c.photo === null)).toBe(
      true,
    );
  });

  it('les types à une seule commande n’en produisent qu’une, sans dépendance sur la précédente', () => {
    for (const type of [
      'BV',
      'CC',
      'BL',
      'RE',
      'BD',
      'RF',
      'BR',
      'BT',
      'FP',
      'DA',
      'VC',
    ] as const) {
      const commands = buildReportCommands(SLIPS[type], meta({ paperRef: `${type}-1` }));
      expect(commands, type).toHaveLength(1);
      expect(commands[0]!.dependsOnPrevious, type).toBe(false);
    }
  });

  it('FA, FJC et JE ne se reportent pas : documents imprimés d’après des faits déjà enregistrés', () => {
    expect([...NON_REPORTABLE_SLIP_CODES].sort()).toEqual(['FA', 'FJC', 'JE']);
    for (const code of NON_REPORTABLE_SLIP_CODES) {
      expect(REPORTABLE_SLIP_TYPES as readonly string[]).not.toContain(code);
    }
  });

  it('les charges de la dépense et de la remise de fonds passent les schémas partagés du serveur', () => {
    const expense = buildReportCommand(SLIPS.BD, meta({ paperRef: 'BD-000055' })).payload;
    expect(expenseRecordPayloadSchema.safeParse(expense).success).toBe(true);
    const transfer = buildReportCommand(SLIPS.RF, meta({ paperRef: 'RF-000007' })).payload;
    expect(cashTransferSendPayloadSchema.safeParse(transfer).success).toBe(true);
    // Les deux champs que l'ancienne correspondance omettait ou nommait mal sont bien refusés sans eux.
    expect(expenseRecordPayloadSchema.safeParse({ ...expense, siteId: undefined }).success).toBe(
      false,
    );
    expect(
      cashTransferSendPayloadSchema.safeParse({
        ...transfer,
        toAccountId: transfer['fromAccountId'],
      }).success,
    ).toBe(false);
  });
});
