/**
 * P8-12 : ordre de verrouillage de la finance opérationnelle (ADR-038 ; ADR-061 §3) éprouvé en
 * concurrence, sur le vrai pipeline (isolation réelle de chaque commande) : aucune paire d'opérations
 * concurrentes sur un même document ne s'interbloque — un interblocage serait rendu `RETRY_LATER` par
 * l'étape 7 du pipeline — et l'issue, quel que soit le gagnant, respecte les invariants (INV-FIN-07,
 * facturé des BC, coût et mouvement des dépenses).
 *
 * Paires jouées en tours concurrents (`Promise.all`), sur des entités neuves, par deux auteurs
 * distincts : deux paiements d'une même facture ; deux factures d'une même ligne de BC ; paiement et
 * annulation d'une dépense ; décision et annulation d'un paiement en attente ; paiement et annulation
 * d'une facture ; décision d'une facture en écart et nouvelle facture du même BC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerExpenseCommands } from '../src/modules/finance/application/commands/expense-commands.js';
import { registerSupplierInvoiceCommands } from '../src/modules/finance/application/commands/supplier-invoice-commands.js';
import { registerSupplierPaymentCommands } from '../src/modules/finance/application/commands/supplier-payment-commands.js';
import {
  recordCashMovement,
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/index.js';
import type { DB } from '../src/platform/kysely/database.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
} from './helpers.js';
import { fund, newAccount, newActor, newPosSite, tx, type Actor } from './cash-transfer-fixtures.js';
import { newOrder, newSupplier } from './supplier-ledger-fixtures.js';

const DAY = '2026-10-06';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00');
const ROUNDS = 4;
const retried = (results: readonly CommandResult[]) =>
  results.filter((result) => result.status === 'RETRY_LATER');
const applied = (results: readonly CommandResult[]) =>
  results.filter((result) => result.status === 'APPLIED' || result.status === 'APPLIED_WITH_WARNINGS');

describe('P8-12 : ordre de verrouillage de la finance opérationnelle', { timeout: 300_000 }, () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let root: Actor;
  let zoneId: string;
  let fin1: Actor;
  let fin2: Actor;
  let dir: Actor;
  let bank: string;
  let transportCategory: string;
  const policies: string[] = [];
  let deviceSeq = 0;

  const aggregateOf = (type: string) =>
    type.startsWith('approvals.policy')
      ? 'CONTROL_POLICY'
      : type.startsWith('approvals.')
        ? 'APPROVAL_REQUEST'
        : type.startsWith('finance.expense')
          ? 'EXPENSE'
          : type.startsWith('finance.supplier_invoice')
            ? 'SUPPLIER_INVOICE'
            : 'SUPPLIER_PAYMENT';
  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: aggregateOf(type),
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
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
  const ok = async (result: Promise<CommandResult>) => {
    const done = await result;
    expect(applied([done]), JSON.stringify(done)).toHaveLength(1);
    return done;
  };

  /** BC d'une ligne (100 reçus à 10 000) d'un fournisseur neuf. */
  async function order() {
    const supplierId = await newSupplier(root.userId);
    const siteId = await newPosSite(root.userId, zoneId);
    const po = await newOrder({
      createdBy: root.userId,
      siteId,
      supplierId,
      lines: [{ ordered: 100, priceXaf: 10_000, accepted: 100 }],
      occurredAt: at('08:00', '2026-10-01'),
    });
    return { supplierId, orderId: po.orderId, poLineId: po.lineIds[0]! };
  }
  const invoicePayload = (
    po: Awaited<ReturnType<typeof order>>,
    quantity: number,
    unitPriceXaf = 10_000,
  ) => ({
    supplierId: po.supplierId,
    supplierInvoiceRef: `F-${freshUuid().slice(-10)}`,
    invoiceDate: '2026-10-05',
    purchaseOrderId: po.orderId,
    lines: [
      {
        poLineId: po.poLineId,
        description: 'Sacs',
        quantity,
        unitPriceXaf,
        lineTotalXaf: quantity * unitPriceXaf,
      },
    ],
  });
  const recordInvoice = (actor: Actor, payload: unknown, id = freshUuid()) =>
    run(actor, 'finance.supplier_invoice.record', id, at('09:00'), payload);
  /** Facture approuvée de `quantity` × 10 000 sur un BC neuf. */
  async function approvedInvoice(quantity: number) {
    const po = await order();
    const id = freshUuid();
    const result = await ok(recordInvoice(fin1, invoicePayload(po, quantity), id));
    expect(result.status === 'APPLIED' && result.server_refs?.status).toBe('APPROVED');
    return { ...po, invoiceId: id };
  }
  const payment = (supplierId: string, invoiceId: string, amountXaf: number) => ({
    supplierId,
    amountXaf,
    paymentMethodCode: 'VIREMENT',
    fromAccountId: bank,
    externalReference: `VIR-${freshUuid().slice(-10)}`,
    allocations: [{ invoiceId, amountXaf }],
  });
  const pay = (actor: Actor, payload: unknown, id = freshUuid()) =>
    run(actor, 'finance.supplier_payment.record', id, at('10:00'), payload);
  const invoicedOf = async (poLineId: string) =>
    Number(
      (
        await db
          .selectFrom('procurement_purchase_order_lines')
          .select('invoiced_qty_base')
          .where('id', '=', toBin(poLineId))
          .executeTakeFirstOrThrow()
      ).invoiced_qty_base,
    );
  /** Σ des quantités des factures du BC qui portent leur facturé (ADR-061 §3). */
  const approvedQuantityOf = async (poLineId: string) => {
    const { rows } = await sql<{ q: string | null }>`
      SELECT SUM(il.quantity_base) AS q FROM finance_supplier_invoice_lines il
      JOIN finance_supplier_invoices i ON i.id = il.invoice_id
      WHERE il.po_line_id = ${toBin(poLineId)} AND i.status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID')`.execute(
      db,
    );
    return Number(rows[0]?.q ?? 0);
  };
  const requestIdOf = async (table: 'finance_supplier_invoices' | 'finance_supplier_payments', id: string) => {
    const row = await db
      .selectFrom(table)
      .select('approval_request_id')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return fromBin(row.approval_request_id!);
  };
  const expectLedgerOk = async (invoiceIds: readonly string[], paymentIds: readonly string[]) =>
    expect(
      (await verifySupplierLedger(db, { invoiceIds, paymentIds })).breaches,
    ).toEqual([]);

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerExpenseCommands(registry, idGenerator, sequences);
    registerSupplierInvoiceCommands(registry, decisions, idGenerator, sequences);
    registerSupplierPaymentCommands(registry, decisions, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    root = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, userId);
      await grantTestPermission(trx, role, 'approvals.policy.manage', userId);
      await assignTestRole(trx, userId, role, userId);
      zoneId = await insertTestZone(trx, userId);
      return { userId, deviceId };
    });
    fin1 = await newActor('FINANCE', root.userId);
    fin2 = await newActor('FINANCE', root.userId);
    dir = await newActor('DIRECTION', root.userId);
    bank = await newAccount({ type: 'BANQUE', responsible: fin1.userId });
    await fund(idGenerator, bank, 50_000_000, at('05:00', '2026-10-05'), root.userId);
    transportCategory = fromBin(
      (
        await db
          .selectFrom('finance_expense_categories')
          .select('id')
          .where('code', '=', 'TRANSPORT')
          .executeTakeFirstOrThrow()
      ).id,
    );
    // Politiques propres au fichier, bornées à la journée du test, neutralisées en fin de fichier.
    for (const [operationType, approverPermission] of [
      ['SUPPLIER_PAYMENT', 'finance.supplier_payment.approve'],
      ['INVOICE_MISMATCH', 'finance.supplier_invoice.approve'],
      ['EXPENSE', 'finance.expense.approve'],
    ] as const) {
      const id = freshUuid();
      await ok(
        run(root, 'approvals.policy.set', id, at('00:00'), {
          code: `LOCK-${operationType.slice(0, 8)}-${id.slice(-12)}`,
          operationType,
          requiresApproval: true,
          approverPermission,
          approverScope: 'ALL',
          validFrom: at('00:00'),
          validTo: at('00:00', '2026-10-07'),
        }),
      );
      policies.push(id);
    }
  });

  afterAll(async () => {
    try {
      for (const id of policies) await neutralizePolicy(id);
    } finally {
      await closeTestDb();
    }
  });

  it('deux paiements d’une même facture : jamais d’interblocage, jamais de surpaiement (INV-FIN-07)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { supplierId, invoiceId } = await approvedInvoice(40);
      const ids = [freshUuid(), freshUuid()];
      const results = await Promise.all([
        pay(fin1, payment(supplierId, invoiceId, 300_000), ids[0]),
        pay(fin2, payment(supplierId, invoiceId, 300_000), ids[1]),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(applied(results), JSON.stringify(results)).toHaveLength(1);
      await expectLedgerOk([invoiceId], ids);
    }
  });

  it('deux factures d’une même ligne de BC : jamais d’interblocage ; une seule porte le facturé', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const po = await order();
      const results = await Promise.all([
        recordInvoice(fin1, invoicePayload(po, 100)),
        recordInvoice(fin2, invoicePayload(po, 100)),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(
        results.map((result) => result.status === 'APPLIED' && result.server_refs?.status).sort(),
      ).toEqual(['APPROVED', 'MISMATCH']);
      expect(await invoicedOf(po.poLineId)).toBe(100);
      expect(await approvedQuantityOf(po.poLineId)).toBe(100);
    }
  });

  it('décision d’une facture en écart et nouvelle facture du même BC : jamais d’interblocage ; facturé = Σ factures approuvées', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const po = await order();
      const disputed = freshUuid();
      const first = await ok(recordInvoice(fin1, invoicePayload(po, 100, 10_500), disputed));
      expect(first.status === 'APPLIED' && first.server_refs?.status).toBe('MISMATCH');
      const requestId = await requestIdOf('finance_supplier_invoices', disputed);
      const results = await Promise.all([
        run(dir, 'approvals.request.approve', requestId, at('14:00'), {
          requestId,
          comment: 'Hausse acceptée',
        }),
        recordInvoice(fin2, invoicePayload(po, 100)),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(await invoicedOf(po.poLineId)).toBe(await approvedQuantityOf(po.poLineId));
    }
  });

  it('paiement et annulation d’une facture : jamais d’interblocage ; jamais de facture annulée avec un payé', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { supplierId, invoiceId, poLineId } = await approvedInvoice(40);
      const paymentId = freshUuid();
      const results = await Promise.all([
        pay(fin1, payment(supplierId, invoiceId, 200_000), paymentId),
        run(fin2, 'finance.supplier_invoice.cancel', invoiceId, at('10:00'), {
          reason: 'Avoir total',
        }),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(applied(results), JSON.stringify(results)).toHaveLength(1);
      await expectLedgerOk([invoiceId], [paymentId]);
      expect(await invoicedOf(poLineId)).toBe(await approvedQuantityOf(poLineId));
    }
  });

  it('décision et annulation d’un paiement en attente : jamais d’interblocage ; décaissé seulement s’il est approuvé', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { supplierId, invoiceId } = await approvedInvoice(60);
      const paymentId = freshUuid();
      const pending = await ok(pay(fin1, payment(supplierId, invoiceId, 600_000), paymentId));
      expect(pending.status === 'APPLIED' && pending.server_refs?.status).toBe('PENDING_APPROVAL');
      const requestId = await requestIdOf('finance_supplier_payments', paymentId);
      const results = await Promise.all([
        run(dir, 'approvals.request.approve', requestId, at('16:00'), { requestId }),
        run(fin1, 'finance.supplier_payment.cancel', paymentId, at('16:00'), {
          reason: 'Doublon',
        }),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(applied(results), JSON.stringify(results)).toHaveLength(1);
      await expectLedgerOk([invoiceId], [paymentId]);
    }
  });

  it('paiement et annulation d’une dépense : jamais d’interblocage ; mouvement et coût selon le gagnant', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const expenseId = freshUuid();
      await ok(
        run(fin1, 'finance.expense.record', expenseId, at('09:00'), {
          categoryId: transportCategory,
          amountXaf: 8_000,
          description: `Transport ${round}`,
          siteId: await newPosSite(root.userId, zoneId),
          paidNow: false,
        }),
      );
      const results = await Promise.all([
        run(fin1, 'finance.expense.pay', expenseId, at('15:00'), { paidFromAccountId: bank }),
        run(dir, 'finance.expense.cancel', expenseId, at('15:00'), { reason: 'Non engagée' }),
      ]);
      expect(retried(results), JSON.stringify(results)).toEqual([]);
      expect(applied(results), JSON.stringify(results)).toHaveLength(1);
      expect((await verifyExpenses(db, { expenseIds: [expenseId] })).breaches).toEqual([]);
    }
  });

  it('les vérifications de la réconciliation nomment chaque écart (écart posé dans une transaction annulée)', async () => {
    const paid = await approvedInvoice(40);
    const other = await approvedInvoice(10);
    const paymentId = freshUuid();
    await ok(pay(fin1, payment(paid.supplierId, paid.invoiceId, 100_000), paymentId));
    const waiting = await approvedInvoice(60);
    const pendingId = freshUuid();
    await ok(pay(fin1, payment(waiting.supplierId, waiting.invoiceId, 600_000), pendingId));
    const siteId = await newPosSite(root.userId, zoneId);
    const expenseId = freshUuid();
    await ok(
      run(fin1, 'finance.expense.record', expenseId, at('09:00'), {
        categoryId: transportCategory,
        amountXaf: 8_000,
        description: 'Transport à vérifier',
        siteId,
        paidNow: false,
      }),
    );
    const supplierMovement = (
      await db
        .selectFrom('finance_supplier_payments')
        .select('cash_movement_id')
        .where('id', '=', toBin(paymentId))
        .executeTakeFirstOrThrow()
    ).cash_movement_id!;
    const fundingMovement = (
      await db
        .selectFrom('finance_cash_movements')
        .select('id')
        .where('cash_account_id', '=', toBin(bank))
        .where('direction', '=', 'IN')
        .executeTakeFirstOrThrow()
    ).id;
    const scope = {
      invoiceIds: [paid.invoiceId, other.invoiceId, waiting.invoiceId],
      paymentIds: [paymentId, pendingId],
    };
    expect((await verifySupplierLedger(db, scope)).breaches).toEqual([]);
    expect((await verifyExpenses(db, { expenseIds: [expenseId] })).breaches).toEqual([]);

    class Rollback extends Error {}
    /** Invariants rompus par `corrupt`, lus dans la même transaction, puis annulée. */
    const breached = async (
      corrupt: (trx: Transaction<DB>) => Promise<unknown>,
    ): Promise<string[]> => {
      let found: string[] = [];
      await db
        .transaction()
        .execute(async (trx) => {
          await corrupt(trx);
          const suppliers = await verifySupplierLedger(trx, scope);
          const expenses = await verifyExpenses(trx, { expenseIds: [expenseId] });
          found = [...suppliers.breaches, ...expenses.breaches].map(
            (breach) => `${breach.invariant} ${breach.ref}`,
          );
          throw new Rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
      return found.map((line) => line.split(' ')[0]!).sort();
    };
    const paidExpense = (trx: Transaction<DB>, extra: Record<string, unknown> = {}) =>
      trx
        .updateTable('finance_expenses')
        .set({
          status: 'PAID',
          paid_at: new Date(at('15:00')),
          paid_from_account_id: toBin(bank),
          paid_by: toBin(fin1.userId),
          cash_movement_id: supplierMovement,
          ...extra,
        })
        .where('id', '=', toBin(expenseId))
        .execute();

    // INV-FIN-07 : un payé écrit sans affectation.
    expect(
      await breached((trx) =>
        trx
          .updateTable('finance_supplier_invoices')
          .set({ paid_xaf: sql`paid_xaf + 1` })
          .where('id', '=', toBin(paid.invoiceId))
          .execute(),
      ),
    ).toEqual(['INVOICE_PAID']);
    // Une affectation active de plus que le montant du paiement (et que le payé de l'autre facture).
    expect(
      await breached((trx) =>
        trx
          .insertInto('finance_supplier_payment_allocations')
          .values({
            id: toBin(freshUuid()),
            payment_id: toBin(paymentId),
            invoice_id: toBin(other.invoiceId),
            amount_xaf: 1,
            status: 'ACTIVE',
            activated_at: new Date(at('10:00')),
            created_by: toBin(fin1.userId),
          })
          .execute(),
      ),
    ).toEqual(['INVOICE_PAID', 'PAYMENT_ALLOCATION']);
    // Paiement en attente marqué décaissé sur un mouvement qui n'est pas le sien.
    expect(
      await breached((trx) =>
        trx
          .updateTable('finance_supplier_payments')
          .set({
            status: 'RECORDED',
            cash_movement_id: fundingMovement,
            disbursed_at: new Date(at('16:00')),
          })
          .where('id', '=', toBin(pendingId))
          .execute(),
      ),
    ).toEqual(['PAYMENT_ALLOCATION', 'PAYMENT_MOVEMENT']);
    // Dépense payée sur un mouvement qui n'est pas le sien.
    expect(await breached((trx) => paidExpense(trx))).toEqual(['EXPENSE_MOVEMENT']);
    // Coût écrit pour une dépense non imputée (INV-FIN-08), sur un objet qui n'est pas le sien.
    expect(
      await breached((trx) =>
        trx
          .insertInto('inventory_cost_entries')
          .values({
            id: toBin(freshUuid()),
            cost_object_type: 'SITE',
            cost_object_id: toBin(siteId),
            cost_type: 'DEPENSE_DIRECTE',
            amount_xaf: 8_000,
            direction: 'DEBIT',
            source_type: 'EXPENSE',
            source_id: toBin(expenseId),
            occurred_at: new Date(at('09:00')),
            created_by: toBin(fin1.userId),
          })
          .execute(),
      ),
    ).toEqual(['EXPENSE_COST', 'EXPENSE_COST_OBJECT']);
    // Rejetée après paiement sans la catégorie système (AV-355).
    expect(
      await breached((trx) =>
        paidExpense(trx, {
          status: 'PAID_REJECTED',
          reclassified_category_id: toBin(transportCategory),
          responsibility_user_id: toBin(fin1.userId),
        }),
      ),
    ).toEqual(['EXPENSE_MOVEMENT', 'EXPENSE_RECLASSIFICATION']);
    // Rien n'est resté.
    expect((await verifySupplierLedger(db, scope)).breaches).toEqual([]);
    expect((await verifyExpenses(db, { expenseIds: [expenseId] })).breaches).toEqual([]);
  });

  it('revue de P8-14 : compte payeur, objet de coût, mouvement d’origine d’un paiement annulé et facturé des BC sont contrôlés (écart posé dans une transaction annulée)', async () => {
    const paid = await approvedInvoice(40);
    const paymentId = freshUuid();
    await ok(pay(fin1, payment(paid.supplierId, paid.invoiceId, 100_000), paymentId));
    const waiting = await approvedInvoice(60);
    const pendingId = freshUuid();
    await ok(pay(fin1, payment(waiting.supplierId, waiting.invoiceId, 600_000), pendingId));
    // Frais généraux de volaille d'une ferme : écriture de coût sur le site, avec l'espèce.
    const farm = await tx((trx) => insertTestSite(trx, root.userId, zoneId, { siteType: 'FERME' }));
    const otherFarm = await tx((trx) =>
      insertTestSite(trx, root.userId, zoneId, { siteType: 'FERME' }),
    );
    const expenseId = freshUuid();
    await ok(
      run(fin1, 'finance.expense.record', expenseId, at('09:00'), {
        categoryId: transportCategory,
        amountXaf: 8_000,
        description: 'Transport des poussins',
        siteId: farm,
        costObject: { type: 'SITE', id: farm, speciesGroup: 'VOLAILLE' },
        paidNow: false,
      }),
    );
    const otherBank = await newAccount({ type: 'BANQUE', responsible: fin1.userId });
    await fund(idGenerator, otherBank, 1_000_000, at('05:00', '2026-10-05'), root.userId);
    const scope = {
      invoiceIds: [paid.invoiceId, waiting.invoiceId],
      paymentIds: [paymentId, pendingId],
    };
    expect((await verifySupplierLedger(db, scope)).breaches).toEqual([]);
    expect((await verifyExpenses(db, { expenseIds: [expenseId] })).breaches).toEqual([]);

    class Rollback extends Error {}
    const breached = async (
      corrupt: (trx: Transaction<DB>) => Promise<unknown>,
    ): Promise<string[]> => {
      let found: string[] = [];
      await db
        .transaction()
        .execute(async (trx) => {
          await corrupt(trx);
          const suppliers = await verifySupplierLedger(trx, scope);
          const expenses = await verifyExpenses(trx, { expenseIds: [expenseId] });
          found = [...suppliers.breaches, ...expenses.breaches].map((b) => b.invariant).sort();
          throw new Rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
      return found;
    };
    const movement = (
      trx: Transaction<DB>,
      input: { account: string; direction: 'OUT'; amount: number; source: string },
    ) =>
      recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId: input.account,
          direction: input.direction,
          amountXaf: input.amount,
          movementType: 'SUPPLIER_PAYMENT',
          sourceDocType: 'SUPPLIER_PAYMENT',
          sourceDocId: input.source,
          occurredAt: new Date(at('16:00')),
          createdBy: fin1.userId,
          allowNegative: true,
        },
      );

    // Décaissé sur un autre compte que le compte payeur.
    expect(
      await breached(async (trx) => {
        const out = await movement(trx, {
          account: otherBank,
          direction: 'OUT',
          amount: 600_000,
          source: pendingId,
        });
        await trx
          .updateTable('finance_supplier_payments')
          .set({
            status: 'RECORDED',
            cash_movement_id: toBin(out.movementId),
            disbursed_at: new Date(at('16:00')),
          })
          .where('id', '=', toBin(pendingId))
          .execute();
      }),
    ).toEqual(['PAYMENT_ALLOCATION', 'PAYMENT_MOVEMENT']);
    // Annulé avec une simple entrée (pas l'inverse de la sortie d'origine).
    expect(
      await breached(async (trx) => {
        // Une simple entrée de même montant, pas l'inverse de la sortie d'origine.
        const back = await recordCashMovement(
          trx,
          { idGenerator },
          {
            cashAccountId: bank,
            direction: 'IN',
            amountXaf: 100_000,
            movementType: 'OPENING_BALANCE',
            sourceDocType: 'CASH_SESSION',
            sourceDocId: freshUuid(),
            occurredAt: new Date(at('16:00')),
            createdBy: fin1.userId,
            allowNegative: false,
          },
        );
        await trx
          .updateTable('finance_supplier_payments')
          .set({
            status: 'CANCELLED',
            cancel_movement_id: toBin(back.movementId),
            cancelled_at: new Date(at('16:00')),
            cancelled_by: toBin(dir.userId),
            cancel_reason: 'Essai',
          })
          .where('id', '=', toBin(paymentId))
          .execute();
      }),
    ).toContain('PAYMENT_MOVEMENT');
    // Annulé avec l'inverse exact d'une sortie faite depuis un autre compte : l'origine est contrôlée.
    expect(
      await breached(async (trx) => {
        const out = await movement(trx, {
          account: otherBank,
          direction: 'OUT',
          amount: 600_000,
          source: pendingId,
        });
        const back = await recordCashMovement(
          trx,
          { idGenerator },
          {
            cashAccountId: otherBank,
            direction: 'IN',
            amountXaf: 600_000,
            movementType: 'SUPPLIER_PAYMENT',
            sourceDocType: 'SUPPLIER_PAYMENT',
            sourceDocId: pendingId,
            occurredAt: new Date(at('16:00')),
            createdBy: fin1.userId,
            allowNegative: false,
            reversesMovementId: out.movementId,
          },
        );
        await trx
          .updateTable('finance_supplier_payments')
          .set({
            status: 'CANCELLED',
            cash_movement_id: toBin(out.movementId),
            disbursed_at: new Date(at('16:00')),
            cancel_movement_id: toBin(back.movementId),
            cancelled_at: new Date(at('16:00')),
            cancelled_by: toBin(dir.userId),
            cancel_reason: 'Essai',
          })
          .where('id', '=', toBin(pendingId))
          .execute();
      }),
    ).toEqual(['PAYMENT_ALLOCATION', 'PAYMENT_MOVEMENT']);
    // Dépense payée par un mouvement EXPENSE juste, mais d'un autre compte que le compte payeur.
    expect(
      await breached(async (trx) => {
        const out = await recordCashMovement(
          trx,
          { idGenerator },
          {
            cashAccountId: otherBank,
            direction: 'OUT',
            amountXaf: 8_000,
            movementType: 'EXPENSE',
            sourceDocType: 'EXPENSE',
            sourceDocId: expenseId,
            occurredAt: new Date(at('16:00')),
            createdBy: fin1.userId,
            allowNegative: false,
          },
        );
        await trx
          .updateTable('finance_expenses')
          .set({
            status: 'PAID',
            paid_at: new Date(at('16:00')),
            paid_from_account_id: toBin(bank),
            paid_by: toBin(fin1.userId),
            cash_movement_id: toBin(out.movementId),
          })
          .where('id', '=', toBin(expenseId))
          .execute();
      }),
    ).toEqual(['EXPENSE_MOVEMENT']);
    // Coût contrepassé puis réimputé à une autre ferme : net juste, objet faux.
    expect(
      await breached(async (trx) => {
        const original = await trx
          .selectFrom('inventory_cost_entries')
          .selectAll()
          .where('source_type', '=', 'EXPENSE')
          .where('source_id', '=', toBin(expenseId))
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('inventory_cost_entries')
          .values({
            ...original,
            id: toBin(freshUuid()),
            direction: 'CREDIT',
            source_id: toBin(freshUuid()),
            reverses_entry_id: original.id,
          })
          .execute();
        await trx
          .insertInto('inventory_cost_entries')
          .values({ ...original, id: toBin(freshUuid()), cost_object_id: toBin(otherFarm) })
          .execute();
      }),
    ).toEqual(['EXPENSE_COST_OBJECT']);
    // Facturé d'une ligne de BC écrit à côté des factures.
    expect(
      await breached((trx) =>
        trx
          .updateTable('procurement_purchase_order_lines')
          .set({ invoiced_qty_base: sql`invoiced_qty_base + 1` })
          .where('id', '=', toBin(paid.poLineId))
          .execute(),
      ),
    ).toEqual(['INVOICED_QTY_DRIFT']);
  });
});
