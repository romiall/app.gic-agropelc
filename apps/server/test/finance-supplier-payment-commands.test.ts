/**
 * P8-08 : paiements fournisseurs (ADR-043 §6 et §7 ; SM-SUPPLIER-PAYMENT ; BR-FIN-032, BR-FIN-033 ;
 * INV-FIN-07 ; AV-055, AV-275 à AV-277) — validation de la Direction avant décaissement au-delà du seuil
 * (affectations prévues, décaissement daté de la décision), paiement immédiat sous le seuil, avance et
 * affectation ultérieure, revérification à la décision, rejet, annulations, refus (moyen, compte,
 * référence, fournisseur, politique absente).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSupplierInvoiceCommands } from '../src/modules/finance/application/commands/supplier-invoice-commands.js';
import { registerSupplierPaymentCommands } from '../src/modules/finance/application/commands/supplier-payment-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { verifySupplierLedger } from '../src/modules/finance/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  withoutActivePolicies,
} from './helpers.js';
import {
  balanceOf,
  codeOf,
  eventsOf,
  fund,
  newAccount,
  newActor,
  newPosSite,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';
import { newOrder, newSupplier } from './supplier-ledger-fixtures.js';

const DAY = '2026-10-09';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00');
const FUNDED_AT = at('05:00', '2026-10-08');

describe('P8-08 : paiements fournisseurs', { timeout: 60_000 }, () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let root: Actor;
  let zoneId: string;
  let fin1: Actor;
  let fin2: Actor;
  let dir: Actor;
  let bank: string;
  let policyId: string;
  let deviceSeq = 0;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean } = {},
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: type.startsWith('approvals.policy')
          ? 'CONTROL_POLICY'
          : type.startsWith('approvals.')
            ? 'APPROVAL_REQUEST'
            : type.startsWith('finance.supplier_invoice')
              ? 'SUPPLIER_INVOICE'
              : 'SUPPLIER_PAYMENT',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );

  const invoiceRow = (id: string) =>
    db
      .selectFrom('finance_supplier_invoices')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const paymentRow = (id: string) =>
    db
      .selectFrom('finance_supplier_payments')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const allocationsOf = (paymentId: string) =>
    db
      .selectFrom('finance_supplier_payment_allocations')
      .select(['invoice_id', 'amount_xaf', 'status'])
      .where('payment_id', '=', toBin(paymentId))
      .orderBy('created_at')
      .execute();
  const requestOf = (paymentId: string) =>
    db
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status'])
      .where('subject_id', '=', toBin(paymentId))
      .where('operation_type', '=', 'SUPPLIER_PAYMENT')
      .executeTakeFirst();
  const movementsOf = (paymentId: string) =>
    db
      .selectFrom('finance_cash_movements')
      .select(['direction', 'amount_xaf', 'occurred_at', 'is_reversal'])
      .where('source_doc_type', '=', 'SUPPLIER_PAYMENT')
      .where('source_doc_id', '=', toBin(paymentId))
      .orderBy('is_reversal')
      .execute();

  /** Facture approuvée (rapprochement conforme) d'un fournisseur, de `quantity` × `priceXaf`. */
  async function approvedInvoice(
    supplierId: string,
    quantity: number,
    priceXaf: number,
  ): Promise<string> {
    const siteId = await newPosSite(root.userId, zoneId);
    const order = await newOrder({
      createdBy: root.userId,
      siteId,
      supplierId,
      lines: [{ ordered: quantity, priceXaf, accepted: quantity }],
      occurredAt: at('08:00', '2026-10-01'),
    });
    const id = freshUuid();
    const result = await run(fin1, 'finance.supplier_invoice.record', id, at('09:00'), {
      supplierId,
      supplierInvoiceRef: `F-${id.slice(-8)}`,
      invoiceDate: '2026-10-08',
      purchaseOrderId: order.orderId,
      lines: [
        {
          poLineId: order.lineIds[0],
          description: 'Sacs',
          quantity,
          unitPriceXaf: priceXaf,
          lineTotalXaf: quantity * priceXaf,
        },
      ],
    });
    expect(result.status === 'APPLIED' && result.server_refs?.status, JSON.stringify(result)).toBe(
      'APPROVED',
    );
    return id;
  }

  const pay = async (
    actor: Actor,
    payload: Record<string, unknown>,
    options: { readonly occurredAt?: string; readonly offline?: boolean } = {},
  ) => {
    const id = freshUuid();
    const result = await run(
      actor,
      'finance.supplier_payment.record',
      id,
      options.occurredAt ?? at('10:00'),
      payload,
      options,
    );
    return { id, result };
  };
  const transfer = (
    supplierId: string,
    amountXaf: number,
    allocations: readonly { invoiceId: string; amountXaf: number }[],
  ) => ({
    supplierId,
    amountXaf,
    paymentMethodCode: 'VIREMENT',
    fromAccountId: bank,
    externalReference: `VIR-${freshUuid().slice(-6)}`,
    allocations,
  });
  const decide = (
    actor: Actor,
    verb: 'approve' | 'reject' | 'withdraw',
    requestId: string,
    occurredAt = at('16:00'),
  ) =>
    run(actor, `approvals.request.${verb}`, requestId, occurredAt, {
      requestId,
      ...(verb === 'reject' ? { comment: 'Trésorerie insuffisante cette semaine' } : {}),
    });

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
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
    await fund(idGenerator, bank, 10_000_000, FUNDED_AT, root.userId);
    policyId = freshUuid();
    const policy = await run(root, 'approvals.policy.set', policyId, at('00:00'), {
      code: `PAY-TEST-${policyId.slice(-12)}`,
      operationType: 'SUPPLIER_PAYMENT',
      requiresApproval: true,
      approverPermission: 'finance.supplier_payment.approve',
      approverScope: 'ALL',
      validFrom: at('00:00'),
      validTo: at('00:00', '2026-10-10'),
    });
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await neutralizePolicy(policyId);
    await closeTestDb();
  });

  it('AT-025 (paiement) : au-delà du seuil, rien n’est décaissé avant la Direction ; approuvé → décaissé à la date de la décision, facture soldée', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 95, 15_000);
    const before = await balanceOf(bank);
    const { id, result } = await pay(
      fin1,
      transfer(supplierId, 1_425_000, [{ invoiceId, amountXaf: 1_425_000 }]),
    );
    expect(result.status === 'APPLIED' && result.server_refs?.status, JSON.stringify(result)).toBe(
      'PENDING_APPROVAL',
    );
    expect(await paymentRow(id)).toMatchObject({
      status: 'PENDING_APPROVAL',
      cash_movement_id: null,
      unallocated_xaf: 0,
    });
    expect((await paymentRow(id)).doc_number).toMatch(/^PF-[A-Z0-9]{1,10}-2026-\d{6}$/);
    expect((await allocationsOf(id)).map((allocation) => allocation.status)).toEqual(['PLANNED']);
    expect(await movementsOf(id)).toEqual([]);
    expect(await balanceOf(bank)).toBe(before);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'APPROVED', paid_xaf: 0 });

    const request = await requestOf(id);
    const requestId = fromBin(request!.id);
    expect(codeOf(await decide(fin2, 'approve', requestId))).toBe('APPROVER_NOT_ALLOWED');
    expect(codeOf(await decide(dir, 'approve', requestId, at('17:30')))).toBe('APPLIED');
    expect(await paymentRow(id)).toMatchObject({ status: 'RECORDED' });
    expect((await paymentRow(id)).disbursed_at?.toISOString()).toBe(at('17:30'));
    expect(await movementsOf(id)).toEqual([
      {
        direction: 'OUT',
        amount_xaf: 1_425_000,
        occurred_at: new Date(at('17:30')),
        is_reversal: 0,
      },
    ]);
    expect(await balanceOf(bank)).toBe(before - 1_425_000);
    expect((await allocationsOf(id)).map((allocation) => allocation.status)).toEqual(['ACTIVE']);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'PAID', paid_xaf: 1_425_000 });
    const payable = await db
      .selectFrom('finance_v_payables')
      .select('balance_xaf')
      .where('invoice_id', '=', toBin(invoiceId))
      .execute();
    expect(payable).toEqual([]);
    expect((await eventsOf(id, 'SupplierPaymentRecorded')).length).toBe(1);
  });

  it('sous le seuil : décaissé tout de suite ; solde dépassé refusé ; avance puis affectation ultérieure (AV-275)', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 20, 15_000);
    const first = await pay(
      fin1,
      transfer(supplierId, 200_000, [{ invoiceId, amountXaf: 200_000 }]),
    );
    expect(first.result.status === 'APPLIED' && first.result.server_refs?.status).toBe('RECORDED');
    expect(await invoiceRow(invoiceId)).toMatchObject({
      status: 'PARTIALLY_PAID',
      paid_xaf: 200_000,
    });
    expect(
      codeOf(
        (await pay(fin1, transfer(supplierId, 150_000, [{ invoiceId, amountXaf: 150_000 }])))
          .result,
      ),
    ).toBe('ALLOCATION_EXCEEDS');
    const advance = await pay(
      fin1,
      transfer(supplierId, 150_000, [{ invoiceId, amountXaf: 100_000 }]),
    );
    expect(await paymentRow(advance.id)).toMatchObject({
      status: 'RECORDED',
      unallocated_xaf: 50_000,
    });
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'PAID', paid_xaf: 300_000 });

    const later = await approvedInvoice(supplierId, 4, 10_000);
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_payment.allocate', advance.id, at('12:00'), {
          allocations: [{ invoiceId: later, amountXaf: 40_000 }],
        }),
      ),
    ).toBe('APPLIED');
    expect(await paymentRow(advance.id)).toMatchObject({ unallocated_xaf: 10_000 });
    expect(await invoiceRow(later)).toMatchObject({ status: 'PAID', paid_xaf: 40_000 });
    const another = await approvedInvoice(supplierId, 2, 10_000);
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_payment.allocate', advance.id, at('12:30'), {
          allocations: [{ invoiceId: another, amountXaf: 20_000 }],
        }),
      ),
    ).toBe('SUPPLIER_PAYMENT_EXCEEDS');
  });

  it('décision : affectation revérifiée (facture soldée entre-temps, demande en attente) ; rejet → REJECTED, affectations contrepassées ; retrait refusé', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 40, 15_000);
    const a = await pay(fin1, transfer(supplierId, 600_000, [{ invoiceId, amountXaf: 600_000 }]));
    const b = await pay(fin1, transfer(supplierId, 600_000, [{ invoiceId, amountXaf: 600_000 }]));
    const requestA = fromBin((await requestOf(a.id))!.id);
    const requestB = fromBin((await requestOf(b.id))!.id);
    expect(codeOf(await decide(fin1, 'withdraw', requestB))).toBe(
      'SUPPLIER_PAYMENT_NOT_WITHDRAWABLE',
    );
    expect(codeOf(await decide(dir, 'approve', requestA))).toBe('APPLIED');
    // La facture est soldée par A : plus payable (AV-276).
    expect(codeOf(await decide(dir, 'approve', requestB))).toBe('ALLOCATION_INVALID');
    expect((await requestOf(b.id))?.status).toBe('PENDING');
    expect(await movementsOf(b.id)).toEqual([]);
    expect(codeOf(await decide(dir, 'reject', requestB))).toBe('APPLIED');
    expect(await paymentRow(b.id)).toMatchObject({ status: 'REJECTED', cash_movement_id: null });
    expect((await allocationsOf(b.id)).map((allocation) => allocation.status)).toEqual([
      'REVERSED',
    ]);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'PAID', paid_xaf: 600_000 });
  });

  it('annulation : en attente par son auteur (demande retirée) ; décaissé par la Direction seule (mouvement inverse, facture rouverte)', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 50, 15_000);
    const pending = await pay(
      fin1,
      transfer(supplierId, 750_000, [{ invoiceId, amountXaf: 750_000 }]),
    );
    expect(
      codeOf(
        await run(fin2, 'finance.supplier_payment.cancel', pending.id, at('11:00'), {
          reason: 'Erreur',
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_payment.cancel', pending.id, at('11:00'), {
          reason: 'Doublon',
        }),
      ),
    ).toBe('APPLIED');
    expect(await paymentRow(pending.id)).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'Doublon',
    });
    expect((await requestOf(pending.id))?.status).toBe('CANCELLED');
    expect((await allocationsOf(pending.id)).map((allocation) => allocation.status)).toEqual([
      'REVERSED',
    ]);

    const recorded = await pay(
      fin1,
      transfer(supplierId, 300_000, [{ invoiceId, amountXaf: 300_000 }]),
    );
    const before = await balanceOf(bank);
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_payment.cancel', recorded.id, at('13:00'), {
          reason: 'Rejet bancaire',
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      codeOf(
        await run(dir, 'finance.supplier_payment.cancel', recorded.id, at('13:00'), {
          reason: 'Rejet bancaire',
        }),
      ),
    ).toBe('APPLIED');
    expect(await balanceOf(bank)).toBe(before + 300_000);
    expect(
      (await movementsOf(recorded.id)).map((movement) => [
        movement.direction,
        movement.is_reversal,
      ]),
    ).toEqual([
      ['OUT', 0],
      ['IN', 1],
    ]);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'APPROVED', paid_xaf: 0 });
    expect((await allocationsOf(recorded.id)).map((allocation) => allocation.status)).toEqual([
      'REVERSED',
    ]);
  });

  it('refus : hors ligne, moyen et compte incompatibles, référence exigée, facture d’un autre fournisseur, sans politique au-delà du seuil', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 10, 15_000);
    const base = transfer(supplierId, 100_000, [{ invoiceId, amountXaf: 100_000 }]);
    expect(codeOf((await pay(fin1, base, { offline: true })).result)).toBe('ONLINE_REQUIRED');
    expect(codeOf((await pay(fin1, { ...base, paymentMethodCode: 'ESPECES' })).result)).toBe(
      'PAYMENT_METHOD_ACCOUNT_MISMATCH',
    );
    expect(codeOf((await pay(fin1, { ...base, externalReference: undefined })).result)).toBe(
      'PAYMENT_REFERENCE_REQUIRED',
    );
    const other = await newSupplier(root.userId);
    expect(codeOf((await pay(fin1, { ...base, supplierId: other })).result)).toBe(
      'ALLOCATION_INVALID',
    );
    await withoutActivePolicies('SUPPLIER_PAYMENT', new Date(at('00:00')), async () => {
      expect(codeOf((await pay(fin1, transfer(supplierId, 600_000, []))).result)).toBe(
        'CONTROL_POLICY_MISSING',
      );
    });
    const central = await newAccount({ type: 'CAISSE_CENTRALE', responsible: fin1.userId });
    expect(
      codeOf(
        (
          await pay(fin1, {
            ...base,
            paymentMethodCode: 'ESPECES',
            fromAccountId: central,
            externalReference: undefined,
          })
        ).result,
      ),
    ).toBe('CASH_INSUFFICIENT');
  });

  it('revue de P8-14 : complément d’avance sur une facture déjà affectée, regroupé ; annulation intacte ; identifiant en majuscules ; validation par son auteur refusée', async () => {
    const supplierId = await newSupplier(root.userId);
    const invoiceId = await approvedInvoice(supplierId, 10, 20_000);
    // 150 000 dont 50 000 affectés (identifiant en majuscules) : 100 000 d'avance.
    const { id, result } = await pay(
      fin1,
      transfer(supplierId, 150_000, [{ invoiceId: invoiceId.toUpperCase(), amountXaf: 50_000 }]),
    );
    expect(codeOf(result)).toBe('APPLIED');
    expect(await invoiceRow(invoiceId)).toMatchObject({
      status: 'PARTIALLY_PAID',
      paid_xaf: 50_000,
    });
    // Complément de 100 000 sur la même facture : une seule affectation active, de 150 000.
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_payment.allocate', id, at('11:00'), {
          allocations: [{ invoiceId, amountXaf: 100_000 }],
        }),
      ),
    ).toBe('APPLIED');
    expect(await invoiceRow(invoiceId)).toMatchObject({
      status: 'PARTIALLY_PAID',
      paid_xaf: 150_000,
    });
    expect(
      (await allocationsOf(id)).map((allocation) => [allocation.amount_xaf, allocation.status]),
    ).toEqual([
      [50_000, 'REVERSED'],
      [150_000, 'ACTIVE'],
    ]);
    expect((await paymentRow(id)).unallocated_xaf).toBe(0);
    expect(
      (await verifySupplierLedger(db, { invoiceIds: [invoiceId], paymentIds: [id] })).breaches,
    ).toEqual([]);
    // Annulation du paiement : la facture revient à zéro, tout reste cohérent.
    expect(
      codeOf(
        await run(dir, 'finance.supplier_payment.cancel', id, at('13:00'), { reason: 'Erreur' }),
      ),
    ).toBe('APPLIED');
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'APPROVED', paid_xaf: 0 });
    expect(
      (await verifySupplierLedger(db, { invoiceIds: [invoiceId], paymentIds: [id] })).breaches,
    ).toEqual([]);

    // Un directeur qui saisit aussi les paiements ne valide pas le sien (drapeau selfApproved).
    const both = await newActor('DIRECTION', root.userId);
    await tx(async (trx) => {
      const role = await insertTestRole(trx, root.userId);
      await grantTestPermission(trx, role, 'finance.supplier_payment.record', root.userId);
      await assignTestRole(trx, both.userId, role, root.userId);
    });
    const ownBank = await newAccount({ type: 'BANQUE', responsible: both.userId });
    await fund(idGenerator, ownBank, 2_000_000, FUNDED_AT, root.userId);
    const big = await approvedInvoice(supplierId, 60, 15_000);
    const pending = await pay(both, {
      ...transfer(supplierId, 900_000, [{ invoiceId: big, amountXaf: 900_000 }]),
      fromAccountId: ownBank,
    });
    expect(codeOf(pending.result)).toBe('APPLIED');
    const request = (await requestOf(pending.id))!;
    expect(
      codeOf(
        await run(both, 'approvals.request.approve', fromBin(request.id), at('16:00'), {
          requestId: fromBin(request.id),
          selfApproved: true,
          comment: 'Urgence',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await paymentRow(pending.id)).status).toBe('PENDING_APPROVAL');
  });
});
