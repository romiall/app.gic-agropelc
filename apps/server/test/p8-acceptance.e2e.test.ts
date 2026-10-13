/**
 * P8-13 : tests d'acceptation de la finance opérationnelle (09-non-functional/03-plan-de-tests.md), sur
 * l'application complète (`PosWorld` : `AppModule`, vrai pipeline, vrai protocole de synchronisation,
 * jetons réels) :
 * - AT-025 (WF-09 de bout en bout, commandes réelles de P6) : BC de 100 sacs à 15 000 approuvé et
 *   envoyé, réception de 98 livrés dont 3 rejetés (95 acceptés), facture de 98 sacs → `MISMATCH`,
 *   décision de la Direction, dette ; paiement au-delà du seuil → rien n'est décaissé avant la
 *   Direction ; décaissé à la validation, facture soldée, payé visible dans le rapprochement du BC ;
 * - AT-040 « Combien réellement encaissé ? » : `GET /finance/overview` — l'encaissé est distinct du CA,
 *   les créances en sont la différence (lecture en écarts : la vue d'ensemble lit toute la base) ;
 * - journée de PDV hors ligne avec dépenses (ADR-060 §5, §7) : dépenses payées depuis la caisse du PDV
 *   pendant la session, conformes ou mises en validation a posteriori (catégorie, justificatif), sorties
 *   dans l'attendu de la session ; décisions de la Finance ensuite (rejet après paiement reclassé).
 * AT-026 (variante dépense de 140 000), AT-041 et la marge d'un lot abattu : production-acceptance.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '@gic/contracts';
import {
  verifyCashSessions,
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, neutralizePolicy } from './helpers.js';
import { balanceOf, fund, newAccount, newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import { PosWorld, PRICE, codeOf, warningsOf } from './pos-world.js';

const DAY = '2026-07-23';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('P8-13 : acceptation de la finance opérationnelle', { timeout: 300_000 }, () => {
  let world: PosWorld;
  let seller: Actor;
  let buyer: Actor;
  const policies: string[] = [];
  let seq = 0;

  /** Commande en ligne avec justificatifs (le `online` du monde n'en porte pas). */
  const run = (
    actor: Actor,
    type: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    attachmentIds: readonly string[] = [],
  ): Promise<CommandResult> =>
    world.pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 3_000_000 + ++seq,
        command_version: 1,
        command_type: type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [...attachmentIds],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  const ok = async (result: Promise<CommandResult>) => {
    const done = await result;
    expect(done.status, JSON.stringify(done)).toMatch(/^APPLIED/);
    return done;
  };
  const get = async (actor: Actor, url: string) => {
    const response = await world.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await world.token(actor)}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const decide = (actor: Actor, verb: 'approve' | 'reject', requestId: string, occurredAt: string) =>
    run(actor, `approvals.request.${verb}`, 'APPROVAL_REQUEST', requestId, occurredAt, {
      requestId,
      comment: verb === 'approve' ? 'Accord de la Direction' : 'Dépense non justifiée',
    });
  const requestOf = async (
    table: 'finance_supplier_invoices' | 'finance_supplier_payments' | 'finance_expenses',
    id: string,
  ) =>
    fromBin(
      (
        await db
          .selectFrom(table)
          .select('approval_request_id')
          .where('id', '=', toBin(id))
          .executeTakeFirstOrThrow()
      ).approval_request_id!,
    );

  beforeAll(async () => {
    world = await PosWorld.create({ now: at('05:00'), sellers: 1 });
    seller = world.sellers[0]!;
    buyer = await newActor('RESP_ACHATS', world.root);
    // Politiques propres au fichier, bornées à la journée, neutralisées en fin de fichier.
    for (const [operationType, approverPermission] of [
      ['PURCHASE_ORDER', 'procurement.order.approve'],
      ['INVOICE_MISMATCH', 'finance.supplier_invoice.approve'],
      ['SUPPLIER_PAYMENT', 'finance.supplier_payment.approve'],
      ['EXPENSE', 'finance.expense.approve'],
    ] as const) {
      const id = freshUuid();
      await ok(
        run(world.dir, 'approvals.policy.set', 'CONTROL_POLICY', id, at('00:00'), {
          code: `AT-${operationType.slice(0, 10)}-${id.slice(-12)}`,
          operationType,
          requiresApproval: true,
          approverPermission,
          approverScope: 'ALL',
          validFrom: at('00:00'),
          validTo: `2026-07-24T00:00:00.000Z`,
        }),
      );
      policies.push(id);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      for (const id of policies) await neutralizePolicy(id);
      await world?.close(at('23:00'));
    } finally {
      await closeTestDb();
    }
  });

  it('AT-025 (WF-09) : BC, réception de 95 acceptés, facture de 98 en écart, décision, dette ; paiement validé par la Direction avant décaissement', async () => {
    world.setNow(at('09:30'));
    // Référentiels : unité SAC, produit achetable, motif de rejet.
    const productId = freshUuid();
    const reasonId = freshUuid();
    await tx(async (trx) => {
      await trx
        .insertInto('catalog_units')
        .values({ code: 'SAC', name: 'Sac', is_count: 1 })
        .onDuplicateKeyUpdate({ name: 'Sac' })
        .execute();
      await trx
        .insertInto('catalog_products')
        .values({
          id: toBin(productId),
          code: `AT025-${productId.slice(-10)}`,
          name: 'Aliment démarrage',
          category_id: toBin(world.categoryId),
          stock_family: 'INTRANT',
          base_unit_code: 'SAC',
          is_purchasable: 1,
          created_by: toBin(world.root),
        })
        .execute();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(reasonId),
          code: `REJ-${reasonId.slice(-10)}`,
          category: 'REJECTION',
          label: 'Sacs déchirés',
          created_by: toBin(world.root),
        })
        .execute();
    });

    // P6 : fournisseur, BC de 1 500 000 (au-delà du seuil d'approbation), envoi, réception 98/3.
    const supplierId = freshUuid();
    await ok(
      run(buyer, 'procurement.supplier.create', 'SUPPLIER', supplierId, at('06:00'), {
        code: `FRN-${supplierId.slice(-10)}`,
        name: 'Provenderie du Littoral',
        paymentTermsDays: 30,
      }),
    );
    const orderId = freshUuid();
    await ok(
      run(buyer, 'procurement.order.create', 'PURCHASE_ORDER', orderId, at('08:00'), {
        supplierId,
        deliveryLocationId: world.store,
        lines: [{ productId, unitCode: 'SAC', orderedQtyBase: 100, unitPriceXaf: 15_000 }],
      }),
    );
    await ok(run(buyer, 'procurement.order.submit', 'PURCHASE_ORDER', orderId, at('08:05'), {}));
    const orderApproval = fromBin(
      (
        await db
          .selectFrom('procurement_purchase_orders')
          .select('approval_request_id')
          .where('id', '=', toBin(orderId))
          .executeTakeFirstOrThrow()
      ).approval_request_id!,
    );
    await ok(decide(world.dir, 'approve', orderApproval, at('08:10')));
    await ok(run(buyer, 'procurement.order.mark_sent', 'PURCHASE_ORDER', orderId, at('08:15'), {}));
    const poLineId = fromBin(
      (
        await db
          .selectFrom('procurement_purchase_order_lines')
          .select('id')
          .where('order_id', '=', toBin(orderId))
          .executeTakeFirstOrThrow()
      ).id,
    );
    await ok(
      run(
        world.magS,
        'procurement.receipt.record',
        'GOODS_RECEIPT',
        freshUuid(),
        at('09:00'),
        {
          purchaseOrderId: orderId,
          supplierId,
          locationId: world.store,
          supplierDeliveryNoteRef: `BL-${orderId.slice(-8)}`,
          lines: [
            {
              poLineId,
              productId,
              unitCode: 'SAC',
              qtyDeliveredBase: 98,
              qtyRejectedBase: 3,
              rejectionReasonCodeId: reasonId,
            },
          ],
        },
        [freshUuid()],
      ),
    );
    const matching = async () =>
      (await get(world.fin, `/api/v1/purchase-orders/${orderId}/matching`)).matching;
    expect((await matching()).lines[0]).toMatchObject({
      acceptedQtyBase: 95,
      invoicedQtyBase: 0,
    });

    // P8 : facture de 98 sacs pour 95 acceptés → écart, demande INVOICE_MISMATCH, rien de facturé.
    world.setNow(at('10:00'));
    const invoiceId = freshUuid();
    const recorded = await ok(
      run(world.fin, 'finance.supplier_invoice.record', 'SUPPLIER_INVOICE', invoiceId, at('10:00'), {
        supplierId,
        supplierInvoiceRef: `F-${invoiceId.slice(-8)}`,
        invoiceDate: DAY,
        purchaseOrderId: orderId,
        lines: [
          {
            poLineId,
            description: 'Aliment démarrage',
            quantity: 98,
            unitPriceXaf: 15_000,
            lineTotalXaf: 1_470_000,
          },
        ],
      }),
    );
    expect(recorded.status === 'APPLIED' && recorded.server_refs?.status).toBe('MISMATCH');
    expect((await matching()).lines[0].invoicedQtyBase).toBe(0);
    const payables = async () =>
      (await get(world.fin, `/api/v1/payables?supplier_id=${supplierId}`)).suppliers[0];
    expect((await payables())?.balanceXaf ?? 0).toBe(0);

    // La Direction accepte l'écart (trois sacs livrés hors bon) : facture approuvée, dette ouverte.
    world.setNow(at('11:00'));
    await ok(decide(world.dir, 'approve', await requestOf('finance_supplier_invoices', invoiceId), at('11:00')));
    expect((await matching()).lines[0].invoicedQtyBase).toBe(98);
    expect(await payables()).toMatchObject({ balanceXaf: 1_470_000, overdueXaf: 0 });

    // Paiement de 1 470 000 (> 500 000) : en attente, aucun mouvement ; la Finance ne le valide pas.
    const bank = await newAccount({ type: 'BANQUE', responsible: world.fin.userId });
    await fund(world.idGenerator, bank, 5_000_000, at('05:00'), world.root);
    world.setNow(at('12:00'));
    const paymentId = freshUuid();
    const pending = await ok(
      run(world.fin, 'finance.supplier_payment.record', 'SUPPLIER_PAYMENT', paymentId, at('12:00'), {
        supplierId,
        amountXaf: 1_470_000,
        paymentMethodCode: 'VIREMENT',
        fromAccountId: bank,
        externalReference: `VIR-${paymentId.slice(-10)}`,
        allocations: [{ invoiceId, amountXaf: 1_470_000 }],
      }),
    );
    expect(pending.status === 'APPLIED' && pending.server_refs?.status).toBe('PENDING_APPROVAL');
    expect(await balanceOf(bank)).toBe(5_000_000);
    expect((await payables())?.balanceXaf).toBe(1_470_000);
    const paymentRequest = await requestOf('finance_supplier_payments', paymentId);
    expect(codeOf(await decide(world.fin, 'approve', paymentRequest, at('12:00')))).toBe(
      'APPROVER_NOT_ALLOWED',
    );
    expect(await balanceOf(bank)).toBe(5_000_000);

    // Validation de la Direction : décaissé à la date de la décision, facture soldée, payé visible.
    world.setNow(at('15:00'));
    await ok(decide(world.dir, 'approve', paymentRequest, at('15:00')));
    expect(await balanceOf(bank)).toBe(5_000_000 - 1_470_000);
    const payment = await db
      .selectFrom('finance_supplier_payments')
      .select(['status', 'disbursed_at'])
      .where('id', '=', toBin(paymentId))
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('RECORDED');
    expect(payment.disbursed_at?.toISOString()).toBe(at('15:00'));
    const invoice = await db
      .selectFrom('finance_supplier_invoices')
      .select(['status', 'paid_xaf'])
      .where('id', '=', toBin(invoiceId))
      .executeTakeFirstOrThrow();
    expect(invoice).toMatchObject({ status: 'PAID', paid_xaf: 1_470_000 });
    expect((await matching()).totals).toMatchObject({
      acceptedValueXaf: 1_425_000,
      invoicedValueXaf: 1_470_000,
      paidXaf: 1_470_000,
    });
    expect((await payables())?.balanceXaf ?? 0).toBe(0);
    expect(
      (await verifySupplierLedger(db, { invoiceIds: [invoiceId], paymentIds: [paymentId] })).breaches,
    ).toEqual([]);
  });

  it('AT-040 : « combien réellement encaissé ? » — encaissé distinct du CA, créance = CA − encaissé', async () => {
    const overview = () => get(world.fin, `/api/v1/finance/overview?from=${DAY}&to=${DAY}`);
    world.setNow(at('16:00'));
    const before = await overview();
    const product = await world.product('Poulet AT-040');
    await world.stockIn(product.id, 20, at('06:00'));
    const customer = await world.customer('Client AT-040');
    // Vente de 10 à crédit, 2 000 payés tout de suite ; 1 000 encaissés plus tard par la Finance.
    await world.ok(seller, {
      type: 'sales.sale.record',
      aggregateType: 'SALE',
      occurredAt: at('13:00'),
      payload: {
        fromLocationId: world.counter,
        customerId: customer,
        lines: [world.line(product, 10)],
        payments: [
          {
            methodCode: 'MOBILE_MONEY_ORANGE',
            amountXaf: 2_000,
            reference: `OM${freshUuid().replace(/-/g, '').slice(-16)}`,
            cashAccountId: world.mobileAcc,
          },
        ],
      },
    });
    await world.ok(world.fin, {
      type: 'sales.payment.record',
      aggregateType: 'CUSTOMER_PAYMENT',
      occurredAt: at('14:00'),
      payload: {
        customerId: customer,
        methodCode: 'MOBILE_MONEY_ORANGE',
        amountXaf: 1_000,
        reference: `OM${freshUuid().replace(/-/g, '').slice(-16)}`,
        cashAccountId: world.mobileAcc,
      },
    });
    const after = await overview();
    const revenue = after.revenue.netRevenueXaf - before.revenue.netRevenueXaf;
    const collected = after.collected.amountXaf - before.collected.amountXaf;
    const receivable = after.receivables.outstandingXaf - before.receivables.outstandingXaf;
    expect([revenue, collected, receivable]).toEqual([10 * PRICE, 3_000, 10 * PRICE - 3_000]);
    expect(after.collected.paymentsCount - before.collected.paymentsCount).toBe(2);
    expect(after.cash.byAccountType.MOBILE_MONEY - before.cash.byAccountType.MOBILE_MONEY).toBe(
      3_000,
    );
  });

  it('journée de PDV hors ligne avec dépenses : payées pendant la session, conformes ou en validation a posteriori, sorties de l’attendu ; décisions de la Finance', async () => {
    const categories = new Map(
      (
        await db.selectFrom('finance_expense_categories').select(['id', 'code']).execute()
      ).map((row) => [row.code, fromBin(row.id)]),
    );
    const product = await world.product('Poulet du jour');
    await world.stockIn(product.id, 100, at('06:00'));
    world.setNow(at('07:00'));
    const tablet = world.tablet(seller);
    tablet.goOffline();
    const enqueue = (type: string, aggregateType: string, occurredAt: string, payload: unknown, aggregateId?: string) =>
      tablet.enqueue(seller.userId, {
        type,
        aggregateType,
        occurredAt,
        payload,
        ...(aggregateId !== undefined ? { aggregateId } : {}),
      });
    const session = freshUuid();
    enqueue('finance.cash_session.open', 'CASH_SESSION', at('07:55'), {
      cashAccountId: world.posAcc,
      countedXaf: 0,
    }, session);
    const sale = enqueue('sales.sale.record', 'SALE', at('09:00'), {
      fromLocationId: world.counter,
      lines: [world.line(product, 60)],
      payments: [{ methodCode: 'ESPECES', amountXaf: 60 * PRICE }],
    });
    const expense = (code: string, amountXaf: number, occurredAt: string, localRef: string) => {
      const id = freshUuid();
      const envelope = enqueue(
        'finance.expense.record',
        'EXPENSE',
        occurredAt,
        {
          categoryId: categories.get(code)!,
          amountXaf,
          description: `${code} du jour`,
          siteId: world.siteP,
          paidNow: true,
          paidFromAccountId: world.posAcc,
          localRef,
        },
        id,
      );
      return { id, commandId: envelope.command_id };
    };
    // Conforme : catégorie permise au PDV, sous le seuil du justificatif.
    const transport = expense('TRANSPORT', 2_000, at('10:00'), 'D1');
    // Catégorie non permise au PDV : appliquée, validation a posteriori (BR-SYN-007).
    const vet = expense('VETERINAIRE', 3_000, at('11:00'), 'D2');
    // Au-delà du seuil du justificatif, sans photo : appliquée, validation a posteriori.
    const fuel = expense('CARBURANT', 15_000, at('12:00'), 'D3');
    const expected = 60 * PRICE - 2_000 - 3_000 - 15_000;
    enqueue('finance.cash_session.close', 'CASH_SESSION', at('18:00'), { countedXaf: expected }, session);

    world.setNow(at('19:00'));
    tablet.goOnline();
    const results = await tablet.syncUntilSettled(seller.userId);
    expect(
      results.filter((result) => !/^APPLIED/.test(result.status)),
      JSON.stringify(results),
    ).toEqual([]);
    expect(codeOf(tablet.resultOf(sale.command_id)!)).toBe('APPLIED');
    expect(warningsOf(tablet.resultOf(transport.commandId))).toEqual([]);
    for (const reviewed of [vet, fuel]) {
      expect(warningsOf(tablet.resultOf(reviewed.commandId))).toContain('EXPENSE_REVIEW_REQUIRED');
    }
    const expenseRow = (id: string) =>
      db
        .selectFrom('finance_expenses')
        .select(['status', 'review_reasons', 'cash_movement_id'])
        .where('id', '=', toBin(id))
        .executeTakeFirstOrThrow();
    expect((await expenseRow(transport.id)).status).toBe('PAID');
    expect(await expenseRow(vet.id)).toMatchObject({ status: 'PAID_PENDING_APPROVAL' });
    expect(JSON.stringify((await expenseRow(vet.id)).review_reasons)).toContain(
      'CATEGORY_NOT_ALLOWED_ON_POS',
    );
    expect(JSON.stringify((await expenseRow(fuel.id)).review_reasons)).toContain(
      'ATTACHMENT_MISSING',
    );
    // Les trois sorties sont dans la session : attendu = ventes en espèces − dépenses, écart nul.
    const closed = await db
      .selectFrom('finance_cash_sessions')
      .select(['status', 'closing_expected_xaf', 'variance_xaf'])
      .where('id', '=', toBin(session))
      .executeTakeFirstOrThrow();
    expect(closed).toMatchObject({ closing_expected_xaf: expected, variance_xaf: 0 });
    expect(await balanceOf(world.posAcc)).toBe(expected);

    // La Finance décide : le vétérinaire est accepté, le carburant sans reçu est rejeté après paiement.
    world.setNow(at('20:00'));
    await ok(decide(world.fin, 'approve', await requestOf('finance_expenses', vet.id), at('20:00')));
    await ok(decide(world.fin, 'reject', await requestOf('finance_expenses', fuel.id), at('20:05')));
    expect((await expenseRow(vet.id)).status).toBe('PAID');
    const rejected = await db
      .selectFrom('finance_expenses as e')
      .innerJoin('finance_expense_categories as c', 'c.id', 'e.reclassified_category_id')
      .select(['e.status', 'c.code', 'e.responsibility_user_id'])
      .where('e.id', '=', toBin(fuel.id))
      .executeTakeFirstOrThrow();
    expect(rejected.status).toBe('PAID_REJECTED');
    expect(rejected.code).toBe('NON_JUSTIFIEE');
    expect(fromBin(rejected.responsibility_user_id!)).toBe(seller.userId);
    // La caisse ne bouge pas avec les décisions (l'argent est sorti) ; tout reste cohérent.
    expect(await balanceOf(world.posAcc)).toBe(expected);
    expect(
      (await verifyExpenses(db, { expenseIds: [transport.id, vet.id, fuel.id] })).breaches,
    ).toEqual([]);
    expect((await verifyCashSessions(db, { sessionIds: [session] })).breaches).toEqual([]);
    await world.expectCashOk([session], []);
  });
});
