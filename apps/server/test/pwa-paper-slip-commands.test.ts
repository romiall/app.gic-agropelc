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
 * - le numéro de la pièce papier est enregistré en `local_ref` là où le serveur contrôle le doublon (vente,
 *   dépense, remise de fonds), dans le texte libre pour la livraison, la réception, le transfert et la perte ;
 *   commande client et reçu n'en ont aucun et ne l'envoient pas : leur clé unique ferait échouer à chaque
 *   essai la commande d'un numéro répété (AV-501) ;
 * - un numéro déjà reporté est signalé (`LOCAL_REF_DUPLICATE`), jamais rejeté (AV-312, AV-501) — alors
 *   qu'une commande « en ligne » serait rejetée (raison d'être de `captured_offline`, AV-502) ;
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

  beforeAll(async () => {
    world = await PosWorld.create({ now: NOW, sellers: 1 });
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
    options: { readonly capturedOffline?: boolean } = {},
  ): Promise<{ command: ReportCommand; result: CommandResult }> {
    const command = buildReportCommand(slip, {
      paperRef,
      occurredAt,
      backdatedReason: 'Report de la pièce papier (essai)',
      aggregateId: freshUuid(),
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

  it('CC puis BL : commande client, puis livraison de ses lignes (numéro de la livraison dans les notes)', async () => {
    const order = await report(
      {
        type: 'CC',
        customerId,
        fulfilmentLocationId: world.store,
        requestedDeliveryDate: DAY,
        deliveryAddress: 'Marché Mokolo, Yaoundé',
        lines: [line(6)],
        totalXaf: 6 * product.price,
      },
      'CC-000031',
      at('09:30'),
    );
    expect(order.command.commandType).toBe('sales.order.place');
    applied(order.result);
    orderId = order.command.aggregateId;
    expect(await localRefOf('sales_sales_orders', orderId)).toBeNull();

    const lines = await db
      .selectFrom('sales_sales_order_lines')
      .select(['id'])
      .where('order_id', '=', toBin(orderId))
      .execute();
    expect(lines).toHaveLength(1);
    const delivery = await report(
      {
        type: 'BL',
        orderId,
        recipientName: 'M. Mballa',
        notes: 'Livré au restaurant',
        lines: [{ orderLineId: fromBin(lines[0]!.id), quantityBase: 6 }],
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
    expect(note.local_ref).toBeNull();
    expect(note.notes).toBe('Pièce papier BL-000018 — Livré au restaurant');
  });

  it('RE : sales.payment.record — encaissement du client ; un numéro répété n’est jamais rejoué sans fin', async () => {
    const { command, result } = await report(
      {
        type: 'RE',
        customerId,
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
    expect(await localRefOf('sales_customer_payments', command.aggregateId)).toBeNull();
    // Même numéro de reçu saisi deux fois : sans localRef, la clé unique du serveur n'est pas en jeu et
    // le second est appliqué (le registre des carnets le signale sur l'appareil, AV-312).
    const again = await report(
      {
        type: 'RE',
        customerId,
        payment: {
          methodCode: 'MOBILE_MONEY_ORANGE',
          amountXaf: 5_000,
          reference: 'OM-PP-0100',
          cashAccountId: world.mobileAcc,
        },
      },
      'RE-000099',
      at('10:05'),
    );
    applied(again.result);
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

  it('BR : procurement.receipt.record — réception sans bon de commande, numéro dans les observations', async () => {
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
    const receipt = await db
      .selectFrom('procurement_goods_receipts')
      .select(['observations', 'local_ref'])
      .where('id', '=', toBin(command.aggregateId))
      .executeTakeFirstOrThrow();
    expect(receipt.local_ref).toBeNull();
    expect(receipt.observations).toBe('Pièce papier BR-000012 — Sacs reçus en bon état');
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
      // Seul le doublon volontaire « en ligne » du deuxième essai est refusé.
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
});
