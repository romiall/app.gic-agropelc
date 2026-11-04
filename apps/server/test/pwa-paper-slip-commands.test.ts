/**
 * Pièces papier reportées (PP-B ; REQ-303, AV-308, AV-501 à AV-504) : chaque type de pièce de l'écran de
 * report produit une commande que le serveur accepte. L'essai rejoue la **vraie** correspondance de la PWA
 * (`apps/pwa/src/features/pieces/report-commands.ts`, logique pure importée telle quelle) à travers
 * l'application complète : appareil virtuel, vrai service de synchronisation (`/sync/push`), vrais
 * gestionnaires, règles du seed, sous une horloge fixe. Il remplace les essais de l'écran qui figeaient
 * des types de commande inventés (constaté le 04/11/2026 : sept types sur neuf n'existaient pas).
 *
 * Attendu :
 * - le lot est valide (`pushRequestSchema`, enveloppes UUIDv7) et chaque commande est appliquée, jamais
 *   rejetée ni mise en quarantaine : une pièce reportée est un fait accompli (BR-SYN-007, AV-502) ;
 * - le numéro de la pièce papier est enregistré en `local_ref` pour les sept commandes qui l'acceptent, dans
 *   le texte libre pour l'expédition d'un transfert et la déclaration d'une perte ;
 * - un numéro déjà reporté est signalé (`LOCAL_REF_DUPLICATE`), jamais rejeté ni rejoué sans fin, pour la
 *   vente, la commande, la livraison, l'encaissement et la réception — alors qu'une commande « en ligne »
 *   serait refusée (raison d'être de `captured_offline`, AV-312, AV-501, AV-502) ;
 * - la photo de la souche vise un propriétaire de pièce jointe que le serveur lit (ADR-046, AV-504).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  rawCommandEnvelopeSchema,
  type CommandResult,
} from '@gic/contracts';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  buildReportCommand,
  slipPhotoTarget,
  REPORTABLE_SLIP_TYPES,
  type ReportCommand,
  type ResolvedSlip,
} from '../../pwa/src/features/pieces/report-commands.js';
import type { OfflineDevice } from './device-harness.js';
import { fund, tx, type Actor } from './cash-transfer-fixtures.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  recentBusinessDay,
} from './helpers.js';
import { PosWorld, codeOf, warningsOf, type Sellable } from './pos-world.js';
import { allowDeliveryWithoutPayment } from './delivery-payment-fixtures.js';

const DAY = recentBusinessDay(3);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const NOW = at('18:00');

/** Droits qu'exigent les neuf commandes (portée `ALL` : l'essai ne porte pas sur le RBAC). */
const PERMISSIONS = [
  'sales.sale.record',
  'sales.credit_sale.record',
  'sales.order.create',
  'sales.order.fulfil',
  'sales.payment.record',
  'finance.expense.record',
  'finance.cash_transfer.record',
  'procurement.receipt.record',
  'inventory.transfer.dispatch',
  'inventory.loss.declare',
] as const;

describe('pièces papier reportées (PP-B) : le serveur accepte chaque type de pièce', () => {
  let world: PosWorld;
  let reporter: Actor;
  let device: OfflineDevice;
  let product: Sellable;
  let customerId: string;
  let supplierId: string;
  let expenseCategoryId: string;
  let orderId = '';
  let orderLineId = '';

  beforeAll(async () => {
    world = await PosWorld.create({ now: NOW, sellers: 1 });
    // AV-511 : le paiement avant livraison est levé sur les sites d'essai (les pièces reportées livrent des
    // commandes sans les payer, pour éprouver autre chose), puis rétabli à 17 h pour l'essai qui l'éprouve.
    for (const site of [world.siteS, world.siteP]) {
      await allowDeliveryWithoutPayment(site, world.root);
      await allowDeliveryWithoutPayment(site, world.root, true, at('17:00'));
    }
    // Le déclarant : un utilisateur et un appareil actifs, tous les droits des neuf commandes.
    reporter = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const roleId = await insertTestRole(trx, world.root);
      for (const permission of PERMISSIONS) {
        await grantTestPermission(trx, roleId, permission, world.root);
      }
      await assignTestRole(trx, userId, roleId, world.root, { scopeType: 'GLOBAL' });
      return { userId, deviceId };
    });
    device = world.tablet(reporter);
    product = await world.product('Poulet de chair');
    // Achetable : l'écran de report ne propose, pour une réception, que des produits achetables.
    await db
      .updateTable('catalog_products')
      .set({ is_purchasable: 1 })
      .where('id', '=', toBin(product.id))
      .execute();
    customerId = await world.customer('Restaurant du marché');
    await world.stockIn(product.id, 200, at('06:00'), world.counter);
    await world.stockIn(product.id, 200, at('06:00'), world.store);
    // Caisse du PDV approvisionnée : la remise de fonds et la dépense sont des sorties de caisse.
    await fund(world.idGenerator, world.posAcc, 500_000, at('06:00'), world.root);
    supplierId = freshUuid();
    await db
      .insertInto('procurement_suppliers')
      .values({
        id: toBin(supplierId),
        code: `F-${supplierId.slice(-10)}`,
        name: 'Provenderie du Littoral',
        supplied_categories: JSON.stringify([]),
        status: 'ACTIVE',
        created_by: toBin(world.root),
      })
      .execute();
    const category = await db
      .selectFrom('finance_expense_categories')
      .select('id')
      .where('code', '=', 'TRANSPORT')
      .executeTakeFirstOrThrow();
    expenseCategoryId = fromBin(category.id);
  });

  afterAll(async () => {
    await world.close(NOW);
    await closeTestDb();
  });

  /** Pièce résolue → commande de la PWA → file de l'appareil → `/sync/push` → réponse du serveur. */
  async function report(
    slip: ResolvedSlip,
    paperRef: string,
    occurredAt: string,
    options: { readonly capturedOffline?: boolean; readonly aggregateId?: string } = {},
  ): Promise<{ command: ReportCommand; result: CommandResult }> {
    const command = buildReportCommand(slip, {
      paperRef,
      occurredAt,
      backdatedReason: 'Report de la pièce papier (essai)',
      aggregateId: options.aggregateId ?? freshUuid(),
    });
    const envelope = device.enqueue(reporter.userId, {
      type: command.commandType,
      aggregateType: command.aggregateType,
      aggregateId: command.aggregateId,
      occurredAt: command.occurredAt,
      payload: command.payload,
      dependsOn: command.dependsOn,
      capturedOffline: options.capturedOffline ?? command.capturedOffline,
      backdatedReason: command.backdatedReason,
    });
    expect(rawCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
    await device.syncUntilSettled(reporter.userId);
    const result = device.resultOf(envelope.command_id);
    expect(result, `aucune réponse pour ${command.commandType}`).toBeDefined();
    return { command, result: result! };
  }

  const applied = (result: CommandResult) =>
    expect(codeOf(result), JSON.stringify(result)).toMatch(/^APPLIED/);

  const line = (quantity: number) => ({
    productId: product.id,
    quantity,
    unitCode: 'PIECE',
    quantityBase: quantity,
    listUnitPriceXaf: product.price,
    priceRuleId: product.ruleId,
    unitPriceXaf: product.price,
  });

  const localRefOf = async (table: string, id: string): Promise<string | null | undefined> => {
    const row = await db
      .selectFrom(table as 'sales_sales')
      .select('local_ref')
      .where('id', '=', toBin(id))
      .executeTakeFirst();
    return row?.local_ref;
  };

  it('BV : sales.sale.record — vente du comptoir, règlement joint, numéro en local_ref', async () => {
    const { command, result } = await report(
      {
        type: 'BV',
        fromLocationId: world.counter,
        customerId,
        lines: [line(4)],
        payment: {
          methodCode: 'MOBILE_MONEY_MTN',
          amountXaf: 4 * product.price,
          reference: 'MOMO-PP-0001',
          cashAccountId: world.mobileAcc,
        },
        totalXaf: 4 * product.price,
      },
      'BV-000142',
      at('09:00'),
    );
    expect(command.commandType).toBe('sales.sale.record');
    applied(result);
    expect(await localRefOf('sales_sales', command.aggregateId)).toBe('BV-000142');
  });

  it('BV : un numéro de pièce déjà reporté est signalé, jamais rejeté — sauf commande « en ligne »', async () => {
    const duplicate = await report(
      { type: 'BV', fromLocationId: world.counter, customerId, lines: [line(1)] },
      'BV-000142',
      at('09:05'),
    );
    applied(duplicate.result);
    expect(warningsOf(duplicate.result)).toContain('LOCAL_REF_DUPLICATE');
    expect(await localRefOf('sales_sales', duplicate.command.aggregateId)).toBeNull();

    // Même pièce saisie « en ligne » : rejet, ce qui ferait échouer le report d'un fait accompli.
    const online = await report(
      { type: 'BV', fromLocationId: world.counter, customerId, lines: [line(1)] },
      'BV-000142',
      at('09:06'),
      { capturedOffline: false },
    );
    expect(codeOf(online.result)).toBe('LOCAL_REF_DUPLICATE');
  });

  it('CC puis BL : commande client, puis livraison de ses lignes, numéros en local_ref', async () => {
    const order = await report(
      {
        type: 'CC',
        customerId,
        fulfilmentLocationId: world.store,
        requestedDeliveryDate: DAY,
        deliveryAddress: 'Marché Mokolo, Yaoundé',
        lines: [line(10)],
        totalXaf: 10 * product.price,
      },
      'CC-000031',
      at('09:30'),
    );
    expect(order.command.commandType).toBe('sales.order.place');
    applied(order.result);
    orderId = order.command.aggregateId;
    expect(await localRefOf('sales_sales_orders', orderId)).toBe('CC-000031');

    const lines = await db
      .selectFrom('sales_sales_order_lines')
      .select(['id'])
      .where('order_id', '=', toBin(orderId))
      .execute();
    expect(lines).toHaveLength(1);
    orderLineId = fromBin(lines[0]!.id);
    const delivery = await report(
      {
        type: 'BL',
        orderId,
        recipientName: 'M. Mballa',
        notes: 'Livré au restaurant',
        lines: [{ orderLineId, quantityBase: 4 }],
      },
      'BL-000018',
      at('11:00'),
    );
    expect(delivery.command.commandType).toBe('sales.order.fulfil');
    applied(delivery.result);
    const note = await db
      .selectFrom('sales_delivery_notes')
      .select(['notes', 'local_ref'])
      .where('id', '=', toBin(delivery.command.aggregateId))
      .executeTakeFirstOrThrow();
    expect(note.local_ref).toBe('BL-000018');
    expect(note.notes).toBe('Livré au restaurant');
  });

  it('RE : sales.payment.record — encaissement du client, numéro en local_ref', async () => {
    const { command, result } = await report(
      {
        type: 'RE',
        customerId,
        siteId: world.siteP,
        payment: {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 25_000,
          reference: 'OM-PP-0099',
          cashAccountId: world.mobileAcc,
        },
      },
      'RE-000099',
      at('10:00'),
    );
    expect(command.commandType).toBe('sales.payment.record');
    applied(result);
    expect(await localRefOf('sales_customer_payments', command.aggregateId)).toBe('RE-000099');
  });

  it('BD : finance.expense.record — dépense payée sur la caisse du PDV, numéro en local_ref', async () => {
    const { command, result } = await report(
      {
        type: 'BD',
        categoryId: expenseCategoryId,
        siteId: world.siteP,
        amountXaf: 12_500,
        description: 'Transport des cageots',
        payeeName: 'Taxi Mballa',
        paidFromAccountId: world.posAcc,
      },
      'BD-000055',
      at('10:30'),
    );
    expect(command.commandType).toBe('finance.expense.record');
    applied(result);
    expect(await localRefOf('finance_expenses', command.aggregateId)).toBe('BD-000055');
  });

  it('RF : finance.cash_transfer.send — remise de la caisse du PDV à la caisse centrale', async () => {
    const { command, result } = await report(
      {
        type: 'RF',
        fromAccountId: world.posAcc,
        toAccountId: world.central,
        amountXaf: 100_000,
        carrierName: 'Ali, convoyeur',
        comment: 'Remise de fin de journée',
      },
      'RF-000007',
      at('16:00'),
    );
    expect(command.commandType).toBe('finance.cash_transfer.send');
    applied(result);
    expect(await localRefOf('finance_cash_transfers', command.aggregateId)).toBe('RF-000007');
  });

  it('BR : procurement.receipt.record — réception sans bon de commande, numéro en local_ref', async () => {
    const { command, result } = await report(
      {
        type: 'BR',
        supplierId,
        locationId: world.store,
        supplierDeliveryNoteRef: 'BL-FOUR-8841',
        observations: 'Sacs reçus en bon état',
        lines: [
          {
            productId: product.id,
            unitCode: 'PIECE',
            qtyDeliveredBase: 20,
            unitCostXaf: 300,
          },
        ],
      },
      'BR-000012',
      at('08:30'),
    );
    expect(command.commandType).toBe('procurement.receipt.record');
    applied(result);
    expect(await localRefOf('procurement_goods_receipts', command.aggregateId)).toBe('BR-000012');
  });

  it('BT : inventory.transfer.dispatch — expédition du magasin au comptoir, numéro dans les notes', async () => {
    const { command, result } = await report(
      {
        type: 'BT',
        fromLocationId: world.store,
        toLocationId: world.counter,
        carrierName: 'Ali, convoyeur',
        notes: 'Réapprovisionnement du comptoir',
        lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 15 }],
      },
      'BT-000023',
      at('07:30'),
    );
    expect(command.commandType).toBe('inventory.transfer.dispatch');
    applied(result);
    const row = await db
      .selectFrom('inventory_stock_transfers')
      .select(['notes', 'status'])
      .where('id', '=', toBin(command.aggregateId))
      .executeTakeFirstOrThrow();
    expect(row.notes).toContain('BT-000023');
    expect(row.notes).toContain('Réapprovisionnement du comptoir');
  });

  it('FP : inventory.loss.declare — perte déclarée au magasin, numéro dans le commentaire', async () => {
    const { command, result } = await report(
      {
        type: 'FP',
        locationId: world.store,
        productId: product.id,
        unitCode: 'PIECE',
        quantity: 2,
        quantityBase: 2,
        category: 'CASSE',
        comment: 'Cageots tombés au déchargement',
      },
      'FP-000004',
      at('12:00'),
    );
    expect(command.commandType).toBe('inventory.loss.declare');
    applied(result);
    const row = await db
      .selectFrom('inventory_loss_declarations')
      .select(['comment', 'category'])
      .where('id', '=', toBin(command.aggregateId))
      .executeTakeFirstOrThrow();
    expect(row.category).toBe('CASSE');
    expect(row.comment).toContain('FP-000004');
  });

  it('un numéro de pièce déjà reporté est signalé sur la commande, la livraison, l’encaissement et la réception', async () => {
    const signalled = async (
      slip: ResolvedSlip,
      paperRef: string,
      table: string,
      occurredAt: string,
      onlineSlip?: ResolvedSlip,
    ) => {
      // Hors ligne, comme un report de pièce : appliqué sans le numéro, avec l'avertissement.
      const offline = await report(slip, paperRef, occurredAt);
      applied(offline.result);
      expect(warningsOf(offline.result), table).toContain('LOCAL_REF_DUPLICATE');
      expect(await localRefOf(table, offline.command.aggregateId), table).toBeNull();
      // « En ligne » : refusé. Sans le contrôle, la clé unique ferait échouer l'écriture à chaque essai.
      const online = await report(onlineSlip ?? slip, paperRef, occurredAt, {
        capturedOffline: false,
      });
      expect(codeOf(online.result), table).toBe('LOCAL_REF_DUPLICATE');
    };

    await signalled(
      { type: 'CC', customerId, fulfilmentLocationId: world.store, lines: [line(1)] },
      'CC-000031',
      'sales_sales_orders',
      at('13:00'),
    );
    await signalled(
      { type: 'BL', orderId, lines: [{ orderLineId, quantityBase: 1 }] },
      'BL-000018',
      'sales_delivery_notes',
      at('13:10'),
    );
    await signalled(
      {
        type: 'RE',
        customerId,
        siteId: world.siteP,
        payment: {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 5_000,
          reference: 'OM-PP-0100',
          cashAccountId: world.mobileAcc,
        },
      },
      'RE-000099',
      'sales_customer_payments',
      at('13:20'),
      {
        type: 'RE',
        customerId,
        siteId: world.siteP,
        payment: {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 6_000,
          reference: 'OM-PP-0101',
          cashAccountId: world.mobileAcc,
        },
      },
    );
    await signalled(
      {
        type: 'BR',
        supplierId,
        locationId: world.store,
        lines: [
          { productId: product.id, unitCode: 'PIECE', qtyDeliveredBase: 5, unitCostXaf: 300 },
        ],
      },
      'BR-000012',
      'procurement_goods_receipts',
      at('13:30'),
    );
  });

  it('chaque type reportable a été rejoué, et aucune commande n’a été mise en quarantaine', () => {
    const seen = new Set(
      device
        .outbox()
        .map((entry) => entry.envelope.command_type)
        .filter((type) => !type.startsWith('attachments.')),
    );
    expect([...seen].sort()).toEqual(
      [
        'finance.cash_transfer.send',
        'finance.expense.record',
        'inventory.loss.declare',
        'inventory.transfer.dispatch',
        'procurement.receipt.record',
        'sales.order.fulfil',
        'sales.order.place',
        'sales.payment.record',
        'sales.sale.record',
      ].sort(),
    );
    expect(REPORTABLE_SLIP_TYPES).toHaveLength(9);
    for (const entry of device.outbox()) {
      const code = codeOf(entry.result);
      // Seuls les doublons volontaires « en ligne » des essais de numéro répété sont refusés.
      if (code === 'LOCAL_REF_DUPLICATE') continue;
      expect(code, entry.envelope.command_type).toMatch(/^APPLIED/);
    }
  });

  it('la photo de la souche vise un propriétaire que le serveur lit (ADR-046), sinon aucune', () => {
    const withPhoto = REPORTABLE_SLIP_TYPES.filter((type) => slipPhotoTarget(type) !== null);
    expect(withPhoto.sort()).toEqual(['BD', 'BR', 'FP']);
    for (const type of withPhoto) {
      const target = slipPhotoTarget(type)!;
      expect(ATTACHMENT_OWNER_TYPES).toContain(target.ownerType);
      expect(ATTACHMENT_KINDS).toContain(target.kind);
    }
  });

  it('rechargement (PP-C) : la même pièce, sous le même identifiant et un autre command_id, n’est reportée qu’une fois', async () => {
    // Le chargement par fichier dérive l'identifiant d'une pièce de son auteur, de son type, de son numéro et de son
    // contenu (`authorImportId`) : recharger le fichier renvoie la même commande sous un autre `command_id`. Le serveur doit la reconnaître,
    // sans doublon ni exception (une écriture qui échouerait serait rejouée sans fin par l'appareil).
    const cases: readonly {
      readonly type: string;
      readonly table: string;
      readonly hhmm: string;
      readonly slip: ResolvedSlip;
    }[] = [
      {
        type: 'BV',
        table: 'sales_sales',
        hhmm: '14:00',
        slip: { type: 'BV', fromLocationId: world.counter, customerId, lines: [line(1)] },
      },
      {
        type: 'CC',
        table: 'sales_sales_orders',
        hhmm: '14:05',
        slip: {
          type: 'CC',
          customerId,
          fulfilmentLocationId: world.store,
          lines: [line(1)],
          totalXaf: product.price,
        },
      },
      {
        type: 'RE',
        table: 'sales_customer_payments',
        hhmm: '14:10',
        slip: {
          type: 'RE',
          customerId,
          siteId: world.siteP,
          payment: {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 1_000,
            reference: 'OM-IDEM-1',
            cashAccountId: world.mobileAcc,
          },
        },
      },
      {
        type: 'BD',
        table: 'finance_expenses',
        hhmm: '14:15',
        slip: {
          type: 'BD',
          categoryId: expenseCategoryId,
          siteId: world.siteP,
          amountXaf: 1_500,
          description: 'Sacs de rechange',
          paidFromAccountId: world.posAcc,
        },
      },
      {
        type: 'RF',
        table: 'finance_cash_transfers',
        hhmm: '14:20',
        slip: {
          type: 'RF',
          fromAccountId: world.posAcc,
          toAccountId: world.central,
          amountXaf: 2_000,
        },
      },
      {
        type: 'BR',
        table: 'procurement_goods_receipts',
        hhmm: '14:25',
        slip: {
          type: 'BR',
          supplierId,
          locationId: world.store,
          lines: [
            { productId: product.id, unitCode: 'PIECE', qtyDeliveredBase: 2, unitCostXaf: 300 },
          ],
        },
      },
      {
        type: 'BT',
        table: 'inventory_stock_transfers',
        hhmm: '14:30',
        slip: {
          type: 'BT',
          fromLocationId: world.store,
          toLocationId: world.counter,
          lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase: 1 }],
        },
      },
      {
        type: 'FP',
        table: 'inventory_loss_declarations',
        hhmm: '14:35',
        slip: {
          type: 'FP',
          locationId: world.store,
          productId: product.id,
          unitCode: 'PIECE',
          quantity: 1,
          quantityBase: 1,
          category: 'CASSE',
        },
      },
    ];
    for (const entry of cases) {
      const id = freshUuid();
      const ref = `IDEM-${entry.type}`;
      const first = await report(entry.slip, ref, at(entry.hhmm), { aggregateId: id });
      applied(first.result);
      // Une file qui ne se règle pas (renvoi sans fin d'une écriture qui échoue) est nommée par son type de pièce.
      const again = await report(entry.slip, ref, at(entry.hhmm), { aggregateId: id }).catch(
        (error: unknown) => {
          throw new Error(
            `${entry.type} : ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      expect(codeOf(again.result), `${entry.type} : ${JSON.stringify(again.result)}`).toMatch(
        /^APPLIED/,
      );
      const rows = await db
        .selectFrom(entry.table as 'sales_sales')
        .select('id')
        .where('id', '=', toBin(id))
        .execute();
      expect(rows, entry.type).toHaveLength(1);
    }
  });

  it('un autre contenu sous le même identifiant n’est jamais pris pour un rejeu (transfert direct, perte)', async () => {
    // Le rejeu est reconnu à l'identité de la pièce, pas au seul identifiant : une autre quantité, un autre
    // produit ou un autre déclarant qui réutiliserait l'identifiant est refusé, jamais avalé en silence.
    const transferId = freshUuid();
    const dispatch = (quantityBase: number) =>
      report(
        {
          type: 'BT',
          fromLocationId: world.store,
          toLocationId: world.counter,
          lines: [{ productId: product.id, unitCode: 'PIECE', quantityBase }],
        },
        'IDEM-BT-2',
        at('15:00'),
        { aggregateId: transferId },
      );
    applied((await dispatch(1)).result);
    expect(codeOf((await dispatch(1)).result)).toMatch(/^APPLIED/); // même contenu : rejeu reconnu
    expect(codeOf((await dispatch(2)).result)).toBe('TRANSFER_ID_TAKEN'); // autre quantité
    const lines = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('dispatched_qty_base')
      .where('transfer_id', '=', toBin(transferId))
      .execute();
    expect(lines.map((row) => Number(row.dispatched_qty_base))).toEqual([1]);

    const lossId = freshUuid();
    const loss = (quantity: number, category = 'CASSE') =>
      report(
        {
          type: 'FP',
          locationId: world.store,
          productId: product.id,
          unitCode: 'PIECE',
          quantity,
          quantityBase: quantity,
          category,
        },
        'IDEM-FP-2',
        at('15:05'),
        { aggregateId: lossId },
      );
    applied((await loss(1)).result);
    expect(codeOf((await loss(1)).result)).toMatch(/^APPLIED/);
    expect(codeOf((await loss(3)).result)).toBe('LOSS_ID_TAKEN');
    expect(codeOf((await loss(1, 'DETERIORATION')).result)).toBe('LOSS_ID_TAKEN');
    const declarations = await db
      .selectFrom('inventory_loss_declarations')
      .select(['quantity_base', 'category'])
      .where('id', '=', toBin(lossId))
      .execute();
    expect(declarations.map((row) => [Number(row.quantity_base), row.category])).toEqual([
      [1, 'CASSE'],
    ]);
  });

  it('AV-511 : le bon de livraison d’une commande non payée est reporté hors ligne — appliqué et signalé à la Finance, jamais refusé ; saisi « en ligne », il le serait', async () => {
    // Le paiement avant livraison est rétabli à 17 h sur les sites d'essai (levé avant, pour les autres essais).
    const order = await report(
      {
        type: 'CC',
        customerId,
        fulfilmentLocationId: world.store,
        lines: [line(2)],
        totalXaf: 2 * product.price,
      },
      'CC-000090',
      at('17:00'),
    );
    applied(order.result);
    const unpaidOrderId = order.command.aggregateId;
    const unpaidLine = await db
      .selectFrom('sales_sales_order_lines')
      .select('id')
      .where('order_id', '=', toBin(unpaidOrderId))
      .executeTakeFirstOrThrow();
    const slip: ResolvedSlip = {
      type: 'BL',
      orderId: unpaidOrderId,
      lines: [{ orderLineId: fromBin(unpaidLine.id), quantityBase: 2 }],
    };

    // En ligne : refusé, aucun bon (la règle du serveur).
    const online = await report(slip, 'BL-000090', at('17:05'), { capturedOffline: false });
    expect(codeOf(online.result)).toBe('ORDER_NOT_PAID');
    expect(await localRefOf('sales_delivery_notes', online.command.aggregateId)).toBeUndefined();

    // Reporté comme il l'est par l'écran (hors ligne) : la remise a eu lieu, le bon est enregistré et signalé.
    const reported = await report(slip, 'BL-000090', at('17:10'));
    applied(reported.result);
    expect(warningsOf(reported.result)).toContain('DELIVERY_UNPAID');
    expect(await localRefOf('sales_delivery_notes', reported.command.aggregateId)).toBe(
      'BL-000090',
    );
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .select(['owner_role', 'applied'])
      .where('entity_id', '=', toBin(unpaidOrderId))
      .where('conflict_type', '=', 'DELIVERY_UNPAID')
      .executeTakeFirst();
    expect(conflict).toMatchObject({ owner_role: 'FINANCE', applied: 1 });
  });
});
