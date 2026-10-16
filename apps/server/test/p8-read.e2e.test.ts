/**
 * P8-09 : lectures HTTP de la finance opérationnelle (08-api-events §4.9 ; ADR-042, ADR-043 ; AV-278) —
 * dépenses par portée (site, propriété), factures et paiements fournisseurs, dettes avec ancienneté et
 * avances, payé dans le rapprochement d'un BC (composition de transport), refus 400, 403 et 404 audités.
 * Application complète (`AppModule`), jetons réels, commandes par le pipeline de l'application.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { businessDayOf, receivableAging, type Clock, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { canViewAttachment } from '../src/attachments-api/attachment-access.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  openTestCashSession,
  signTestAccessToken,
} from './helpers.js';
import { fund, newAccount, newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import { newOrder, newSupplier } from './supplier-ledger-fixtures.js';

const DAY = '2026-10-09';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
let deviceSeq = 0;

describe('P8-09 : lectures HTTP de la finance opérationnelle', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  const tokens = new Map<string, string>();
  let root: string;
  let fin: Actor;
  let ach: Actor;
  let admin: Actor;
  let venA: Actor;
  let terrain: Actor;
  let mag: Actor;
  let siteA: string;
  let siteB: string;
  let expenseA: string;
  let expenseTerrain: string;
  let expenseFin: string;
  let supplierId: string;
  let orderId: string;
  let invoiceId: string;
  let rpr: Actor;
  let paymentId: string;

  const get = (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get(actor.userId)!}` },
    });

  const send = async (
    actor: Actor,
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ): Promise<CommandResult> => {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: at('10:00'),
        client_created_at: at('10:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    root = await tx((trx) => insertTestUser(trx));
    const zoneId = await tx((trx) => insertTestZone(trx, root));
    siteA = await tx((trx) => insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' }));
    siteB = await tx((trx) => insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' }));
    fin = await newActor('FINANCE', root);
    ach = await newActor('RESP_ACHATS', root);
    admin = await newActor('ADMIN', root);
    venA = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    terrain = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    mag = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteA });
    rpr = await newActor('RESP_PRODUCTION', root);
    for (const actor of [fin, ach, admin, venA, terrain, mag, rpr]) {
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }

    const categories = new Map(
      (await db.selectFrom('finance_expense_categories').select(['id', 'code']).execute()).map(
        (row) => [row.code, fromBin(row.id)],
      ),
    );
    const posA = await newAccount({ type: 'CAISSE_PDV', responsible: venA.userId, siteId: siteA });
    await fund(idGenerator, posA, 50_000, at('05:00'), root);
    await tx((trx) =>
      openTestCashSession(trx, {
        cashAccountId: posA,
        siteId: siteA,
        openedBy: venA.userId,
        openedAt: new Date(at('06:00')),
      }),
    );
    const own = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, own, 50_000, at('05:00'), root);
    const bank = await newAccount({ type: 'BANQUE', responsible: fin.userId });
    await fund(idGenerator, bank, 5_000_000, at('05:00'), root);

    expenseA = freshUuid();
    await send(venA, 'finance.expense.record', 'EXPENSE', expenseA, {
      categoryId: categories.get('TRANSPORT'),
      amountXaf: 2_000,
      description: 'Moto-taxi',
      siteId: siteA,
      paidNow: true,
      paidFromAccountId: posA,
    });
    expenseTerrain = freshUuid();
    await send(terrain, 'finance.expense.record', 'EXPENSE', expenseTerrain, {
      categoryId: categories.get('CARBURANT'),
      amountXaf: 1_500,
      description: 'Essence',
      siteId: siteB,
      paidNow: true,
      paidFromAccountId: own,
    });
    expenseFin = freshUuid();
    await send(fin, 'finance.expense.record', 'EXPENSE', expenseFin, {
      categoryId: categories.get('DIVERS'),
      amountXaf: 9_000,
      description: 'Petit matériel',
      siteId: siteB,
      paidNow: false,
    });

    supplierId = await newSupplier(root, { paymentTermsDays: 30 });
    const order = await newOrder({
      createdBy: root,
      siteId: siteA,
      supplierId,
      lines: [{ ordered: 10, priceXaf: 15_000, accepted: 10 }],
      occurredAt: at('07:00'),
    });
    orderId = order.orderId;
    invoiceId = freshUuid();
    await send(fin, 'finance.supplier_invoice.record', 'SUPPLIER_INVOICE', invoiceId, {
      supplierId,
      supplierInvoiceRef: `F-${invoiceId.slice(-8)}`,
      invoiceDate: '2026-10-08',
      purchaseOrderId: orderId,
      lines: [
        {
          poLineId: order.lineIds[0],
          description: 'Sacs',
          quantity: 10,
          unitPriceXaf: 15_000,
          lineTotalXaf: 150_000,
        },
      ],
    });
    paymentId = freshUuid();
    await send(fin, 'finance.supplier_payment.record', 'SUPPLIER_PAYMENT', paymentId, {
      supplierId,
      amountXaf: 120_000,
      paymentMethodCode: 'VIREMENT',
      fromAccountId: bank,
      externalReference: 'VIR-001',
      allocations: [{ invoiceId, amountXaf: 100_000 }],
    });
    // Paiement au-delà du seuil, en attente : son affectation prévue ne compte nulle part.
    await send(fin, 'finance.supplier_payment.record', 'SUPPLIER_PAYMENT', freshUuid(), {
      supplierId,
      amountXaf: 600_000,
      paymentMethodCode: 'VIREMENT',
      fromAccountId: bank,
      externalReference: 'VIR-002',
      allocations: [{ invoiceId, amountXaf: 50_000 }],
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /expenses : portée par site et par auteur ; la Finance voit tout', async () => {
    const ids = async (actor: Actor, url: string) => {
      const response = await get(actor, url);
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { expenses: { id: string }[] }).expenses.map(
        (expense) => expense.id,
      );
    };
    expect(await ids(fin, `/api/v1/expenses?site_id=${siteA}`)).toEqual([expenseA]);
    expect((await ids(fin, `/api/v1/expenses?site_id=${siteB}`)).sort()).toEqual(
      [expenseFin, expenseTerrain].sort(),
    );
    expect(await ids(venA, `/api/v1/expenses?site_id=${siteA}`)).toEqual([expenseA]);
    expect(await ids(venA, `/api/v1/expenses?site_id=${siteB}`)).toEqual([]);
    expect(await ids(terrain, `/api/v1/expenses?site_id=${siteB}`)).toEqual([expenseTerrain]);
    const detail = await get(fin, `/api/v1/expenses/${expenseA}`);
    expect(detail.json()).toMatchObject({
      expense: {
        id: expenseA,
        categoryCode: 'TRANSPORT',
        amountXaf: 2_000,
        status: 'PAID',
        siteId: siteA,
        reviewReasons: [],
        attachments: [],
      },
    });
  });

  it('P8E-03 (ADR-047 §3) : chaque dépense rendue porte ses pièces, celles d’une autre dépense exclues', async () => {
    const receipt = freshUuid();
    await send(venA, 'attachments.attachment.register', 'ATTACHMENT', receipt, {
      ownerType: 'EXPENSE',
      ownerId: expenseA,
      kind: 'RECEIPT',
      mimeType: 'image/jpeg',
      sizeBytes: 2_048,
      sha256: 'ab'.repeat(32),
      capturedAt: at('10:00'),
    });
    // Pièce d'un autre document au même identifiant de propriétaire : jamais rendue.
    await send(venA, 'attachments.attachment.register', 'ATTACHMENT', freshUuid(), {
      ownerType: 'STOCK_LOSS',
      ownerId: expenseA,
      kind: 'PHOTO',
      mimeType: 'image/jpeg',
      sizeBytes: 1_024,
      sha256: 'cd'.repeat(32),
      capturedAt: at('10:00'),
    });
    const list = (await get(fin, `/api/v1/expenses?site_id=${siteA}`)).json() as {
      expenses: { id: string; attachments: unknown[] }[];
    };
    expect(list.expenses.find((expense) => expense.id === expenseA)?.attachments).toEqual([
      { id: receipt, kind: 'RECEIPT', uploadStatus: 'PENDING_UPLOAD' },
    ]);
    const detail = (await get(venA, `/api/v1/expenses/${expenseA}`)).json() as {
      expense: { attachments: unknown[] };
    };
    expect(detail.expense.attachments).toEqual([
      { id: receipt, kind: 'RECEIPT', uploadStatus: 'PENDING_UPLOAD' },
    ]);
    const other = (await get(fin, `/api/v1/expenses/${expenseFin}`)).json() as {
      expense: { attachments: unknown[] };
    };
    expect(other.expense.attachments).toEqual([]);
  });

  it('revue de P8E-03 : pièces attribuées à leur dépense dans une page, celles d’un tiers et les remplacées exclues', async () => {
    const register = (actor: Actor, ownerId: string, seed: string) => {
      const id = freshUuid();
      return send(actor, 'attachments.attachment.register', 'ATTACHMENT', id, {
        ownerType: 'EXPENSE',
        ownerId,
        kind: 'RECEIPT',
        mimeType: 'image/jpeg',
        sizeBytes: 1_024,
        sha256: seed.repeat(32),
        capturedAt: at('10:00'),
      }).then(() => id);
    };
    const terrainFirst = await register(terrain, expenseTerrain, '11');
    const terrainSecond = await register(terrain, expenseTerrain, '22');
    const finReceipt = await register(fin, expenseFin, '33');
    // Pièce d'un tiers sur la dépense du commercial : jamais rendue comme son justificatif.
    await register(mag, expenseTerrain, '44');
    // Pièce remplacée : exclue.
    const replaced = await register(fin, expenseFin, '55');
    await db
      .updateTable('attachments_attachments')
      .set({ upload_status: 'SUPERSEDED' })
      .where('id', '=', toBin(replaced))
      .execute();
    const list = (await get(fin, `/api/v1/expenses?site_id=${siteB}`)).json() as {
      expenses: { id: string; attachments: { id: string }[] }[];
    };
    const piecesOf = (id: string) =>
      list.expenses.find((expense) => expense.id === id)?.attachments.map((piece) => piece.id);
    expect(piecesOf(expenseTerrain)).toEqual([terrainFirst, terrainSecond]);
    expect(piecesOf(expenseFin)).toEqual([finReceipt]);
  });

  it('P8E-02 (ADR-047 §3) : pièce d’une dépense lue par l’auteur et ses lecteurs ; d’une facture, par les lecteurs des dettes', async () => {
    const now = clock.now();
    const view = (actor: Actor, ownerType: string, ownerId: string, createdBy: string) =>
      canViewAttachment(db, { createdBy, ownerType, ownerId }, actor.userId, now);
    // Dépense du vendeur du site A : l'auteur, les lecteurs de toute l'entreprise ; pas un autre auteur
    // en portée propre, ni l'Admin (sans `finance.expense.read`).
    expect(await view(venA, 'EXPENSE', expenseA, venA.userId)).toBe(true);
    expect(await view(fin, 'EXPENSE', expenseA, venA.userId)).toBe(true);
    expect(await view(rpr, 'EXPENSE', expenseA, venA.userId)).toBe(true);
    expect(await view(terrain, 'EXPENSE', expenseA, venA.userId)).toBe(false);
    expect(await view(mag, 'EXPENSE', expenseA, venA.userId)).toBe(false);
    expect(await view(admin, 'EXPENSE', expenseA, venA.userId)).toBe(false);
    // Le commercial lit la pièce de sa propre dépense, même déposée par un autre.
    expect(await view(terrain, 'EXPENSE', expenseTerrain, fin.userId)).toBe(true);
    // Facture : lecteurs des dettes (Finance, Achats), pas un vendeur.
    expect(await view(ach, 'SUPPLIER_INVOICE', invoiceId, fin.userId)).toBe(true);
    expect(await view(venA, 'SUPPLIER_INVOICE', invoiceId, fin.userId)).toBe(false);
    // Document inconnu : refusé.
    expect(await view(fin, 'EXPENSE', freshUuid(), venA.userId)).toBe(false);
    expect(await view(fin, 'SUPPLIER_INVOICE', freshUuid(), venA.userId)).toBe(false);
  });

  it('GET /expenses : hors portée 404 audité, droit absent 403, paramètres invalides 400', async () => {
    expect((await get(terrain, `/api/v1/expenses/${expenseFin}`)).statusCode).toBe(404);
    const denied = await db
      .selectFrom('audit_audit_log')
      .select('result')
      .where('entity_id', '=', toBin(expenseFin))
      .where('action', '=', 'access.denied')
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect((await get(ach, `/api/v1/expenses/${expenseFin}`)).statusCode).toBe(200);
    expect((await get(admin, '/api/v1/expenses')).statusCode).toBe(403);
    expect((await get(fin, '/api/v1/expenses?status=INCONNU')).statusCode).toBe(400);
    expect((await get(fin, '/api/v1/expenses?from=2026-10-09&to=2026-10-01')).statusCode).toBe(400);
    expect((await get(fin, `/api/v1/expenses/${freshUuid()}`)).statusCode).toBe(404);
  });

  it('GET /supplier-invoices et /supplier-payments : listes, détails avec lignes et affectations ; 403 sans droit', async () => {
    const invoices = await get(fin, `/api/v1/supplier-invoices?supplier_id=${supplierId}`);
    expect(invoices.json()).toMatchObject({
      supplier_invoices: [
        {
          id: invoiceId,
          status: 'PARTIALLY_PAID',
          totalXaf: 150_000,
          paidXaf: 100_000,
          balanceXaf: 50_000,
        },
      ],
      next_cursor: null,
    });
    const detail = await get(ach, `/api/v1/supplier-invoices/${invoiceId}`);
    expect(detail.json()).toMatchObject({
      supplier_invoice: {
        lines: [{ lineNo: 1, quantityBase: 10, unitPriceXaf: 15_000, lineTotalXaf: 150_000 }],
        allocations: [
          { paymentId, amountXaf: 100_000, status: 'ACTIVE' },
          { amountXaf: 50_000, status: 'PLANNED' },
        ],
      },
    });
    const payments = await get(
      fin,
      `/api/v1/supplier-payments?supplier_id=${supplierId}&status=RECORDED`,
    );
    expect(payments.json()).toMatchObject({
      supplier_payments: [
        { id: paymentId, status: 'RECORDED', amountXaf: 120_000, unallocatedXaf: 20_000 },
      ],
    });
    expect((await get(fin, `/api/v1/supplier-payments/${paymentId}`)).json()).toMatchObject({
      supplier_payment: { allocations: [{ invoiceId, amountXaf: 100_000 }] },
    });
    expect(
      (await get(venA, `/api/v1/supplier-invoices?supplier_id=${supplierId}`)).statusCode,
    ).toBe(403);
    expect((await get(fin, `/api/v1/supplier-payments/${freshUuid()}`)).statusCode).toBe(404);
  });

  it('P8E-05 (ADR-047 §3) : chaque facture rendue porte les pièces de son auteur', async () => {
    const register = (actor: Actor, seed: string, ownerId = invoiceId) => {
      const id = freshUuid();
      return send(actor, 'attachments.attachment.register', 'ATTACHMENT', id, {
        ownerType: 'SUPPLIER_INVOICE',
        ownerId,
        kind: 'INVOICE',
        mimeType: 'image/jpeg',
        sizeBytes: 4_096,
        sha256: seed.repeat(32),
        capturedAt: at('10:00'),
      }).then(() => id);
    };
    // Deux autres factures du fournisseur, sans bon (en écart, hors des dettes) : l'une avec sa
    // photo, l'autre sans. Aucune pièce ne passe d'une facture à l'autre.
    const record = async () => {
      const id = freshUuid();
      await send(fin, 'finance.supplier_invoice.record', 'SUPPLIER_INVOICE', id, {
        supplierId,
        supplierInvoiceRef: `P-${id.slice(-8)}`,
        invoiceDate: '2026-10-08',
        lines: [{ description: 'Transport', lineTotalXaf: 5_000 }],
      });
      return id;
    };
    const second = await record();
    const bare = await record();
    const scan = await register(fin, '66');
    const secondScan = await register(fin, '88', second);
    // Pièce d'un autre utilisateur : jamais présentée comme la facture.
    await register(ach, '77');
    const list = (await get(fin, `/api/v1/supplier-invoices?supplier_id=${supplierId}`)).json() as {
      supplier_invoices: { id: string; attachments: unknown[] }[];
    };
    const piecesOf = (id: string) =>
      list.supplier_invoices.find((item) => item.id === id)?.attachments;
    expect(piecesOf(invoiceId)).toEqual([
      { id: scan, kind: 'INVOICE', uploadStatus: 'PENDING_UPLOAD' },
    ]);
    expect(piecesOf(second)).toEqual([
      { id: secondScan, kind: 'INVOICE', uploadStatus: 'PENDING_UPLOAD' },
    ]);
    expect(piecesOf(bare)).toEqual([]);
    const detail = (await get(ach, `/api/v1/supplier-invoices/${invoiceId}`)).json() as {
      supplier_invoice: { attachments: unknown[]; lines: unknown[] };
    };
    expect(detail.supplier_invoice.attachments).toEqual([
      { id: scan, kind: 'INVOICE', uploadStatus: 'PENDING_UPLOAD' },
    ]);
    expect(detail.supplier_invoice.lines).toHaveLength(1);
  });

  it('GET /payables : solde, ancienneté au jour métier, avance et dette nette', async () => {
    const response = await get(fin, `/api/v1/payables?supplier_id=${supplierId}`);
    expect(response.statusCode, response.body).toBe(200);
    const today = businessDayOf(clock.now());
    const aging = receivableAging('2026-11-07', today);
    expect(response.json()).toMatchObject({
      as_of: today,
      total_balance_xaf: 50_000,
      total_advance_xaf: 20_000,
      suppliers: [
        {
          supplierId,
          balanceXaf: 50_000,
          advanceXaf: 20_000,
          netXaf: 30_000,
          overdueXaf: aging.overdue ? 50_000 : 0,
          invoices: [
            {
              invoiceId,
              dueDate: '2026-11-07',
              balanceXaf: 50_000,
              daysOverdue: aging.daysOverdue,
              bucket: aging.bucket,
            },
          ],
        },
      ],
    });
    expect((await get(terrain, '/api/v1/payables')).statusCode).toBe(403);
  });

  it('GET /purchase-orders/{id}/matching : facturé et payé du BC (masqués sans valorisation)', async () => {
    const valued = await get(fin, `/api/v1/purchase-orders/${orderId}/matching`);
    expect(valued.statusCode, valued.body).toBe(200);
    expect(valued.json()).toMatchObject({
      matching: {
        lines: [{ invoicedQtyBase: 10 }],
        totals: { invoicedValueXaf: 150_000, paidXaf: 100_000 },
      },
    });
    const masked = await get(mag, `/api/v1/purchase-orders/${orderId}/matching`);
    expect(masked.statusCode, masked.body).toBe(200);
    expect(masked.json()).toMatchObject({ matching: { totals: { paidXaf: null } } });
  });

  it('revue de P8-14 : liste pré-filtrée par la portée, date impossible 400, payé du BC réservé aux lecteurs des dettes, solde nul avant approbation', async () => {
    const divers = await db
      .selectFrom('finance_expense_categories')
      .select('id')
      .where('code', '=', 'DIVERS')
      .executeTakeFirstOrThrow();
    // Les plus récentes sont d'un autre site : la première page du vendeur porte quand même la sienne.
    for (let index = 0; index < 3; index++) {
      await send(fin, 'finance.expense.record', 'EXPENSE', freshUuid(), {
        categoryId: fromBin(divers.id),
        amountXaf: 500,
        description: `Autre site ${index}`,
        siteId: siteB,
        paidNow: false,
      });
    }
    const page = await get(venA, '/api/v1/expenses?limit=2');
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toEqual({
      expenses: [expect.objectContaining({ id: expenseA })],
      next_cursor: null,
    });
    const own = await get(terrain, '/api/v1/expenses?limit=1');
    expect((own.json() as { expenses: { id: string }[] }).expenses.map((e) => e.id)).toEqual([
      expenseTerrain,
    ]);
    // Une date impossible au calendrier : 400, jamais 500.
    expect((await get(fin, '/api/v1/expenses?from=2026-02-30')).statusCode).toBe(400);

    // Payé du BC : le Resp. production valorise le BC mais ne lit pas les dettes.
    const production = await get(rpr, `/api/v1/purchase-orders/${orderId}/matching`);
    expect(production.statusCode, production.body).toBe(200);
    expect(production.json()).toMatchObject({
      matching: { totals: { invoicedValueXaf: 150_000, paidXaf: null } },
    });

    // Facture en écart (20 facturés pour 10 acceptés) : pas encore une dette, solde nul.
    const disputed = freshUuid();
    await send(fin, 'finance.supplier_invoice.record', 'SUPPLIER_INVOICE', disputed, {
      supplierId,
      supplierInvoiceRef: `F-${disputed.slice(-8)}`,
      invoiceDate: '2026-10-08',
      purchaseOrderId: orderId,
      lines: [
        {
          poLineId: fromBin(
            (
              await db
                .selectFrom('procurement_purchase_order_lines')
                .select('id')
                .where('order_id', '=', toBin(orderId))
                .executeTakeFirstOrThrow()
            ).id,
          ),
          description: 'Sacs',
          quantity: 20,
          unitPriceXaf: 15_000,
          lineTotalXaf: 300_000,
        },
      ],
    });
    const detail = await get(fin, `/api/v1/supplier-invoices/${disputed}`);
    expect(detail.json()).toMatchObject({
      supplier_invoice: { status: 'MISMATCH', totalXaf: 300_000, balanceXaf: 0 },
    });
  });
});
