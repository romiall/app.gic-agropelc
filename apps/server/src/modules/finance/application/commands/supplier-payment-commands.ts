/**
 * Paiements fournisseurs (P8-08 ; ADR-061 §6 et §7 ; SM-SUPPLIER-PAYMENT ; D09 BR-FIN-032, BR-FIN-033 ;
 * INV-FIN-07 ; AV-055, AV-362 à AV-364) : enregistrement, décision `SUPPLIER_PAYMENT` de la Direction,
 * affectation d'une avance, annulation. Toutes en ligne (`ONLINE_REQUIRED` sinon).
 *
 * - **Validation avant décaissement** (BR-FIN-033) : au-delà de `finance.supplier_payment_approval_xaf`
 *   (strict), le paiement attend la Direction (`PENDING_APPROVAL`), ses affectations sont `PLANNED`,
 *   aucun mouvement ; sans politique `SUPPLIER_PAYMENT` active, refus `CONTROL_POLICY_MISSING`. À
 *   l'approbation : affectations revérifiées (`ALLOCATION_EXCEEDS` si une facture a été payée
 *   entre-temps), décaissement daté de la décision (AV-363), affectations `ACTIVE`.
 * - **Affectations** (INV-FIN-07, BR-FIN-032) : `planSupplierPayment` (domaine) ; le reste est une
 *   avance si `finance.supplier_advance_allowed` (AV-362), affectable plus tard par `.allocate`.
 * - **Moyen et compte** : le moyen doit être actif et compatible avec le compte (espèces → caisse,
 *   sinon le type de compte du moyen) ; une référence est exigée si le moyen l'exige ; une caisse de PDV
 *   exige une session ouverte (ADR-060 §5).
 * - **Annulation** (AV-364) : en attente, par son auteur (`finance.supplier_payment.record`) ; décaissé,
 *   par la Direction (`finance.supplier_payment.approve`) : mouvement inverse, affectations contrepassées,
 *   factures recalculées. Permission grossière commune `finance.payable.read`, contrôle fin ici.
 * - **Verrous** (ADR-061 §9) : paiement, factures (par identifiant), compte, session, demande, compteur.
 */
import {
  planSupplierPayment,
  supplierPaymentRequiresApproval,
  supplierPaymentTransition,
  type IdGenerator,
  type PayableInvoice,
} from '@gic/domain';
import {
  supplierPaymentAllocatePayloadSchema,
  supplierPaymentCancelPayloadSchema,
  supplierPaymentRecordPayloadSchema,
  type SupplierPaymentAllocatePayload,
  type SupplierPaymentCancelPayload,
  type SupplierPaymentRecordPayload,
} from '@gic/contracts';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../../identity/application/public/index.js';
import {
  ApprovalDecisionRefused,
  cancelApprovalRequest,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findSupplier } from '../../../procurement/application/public/index.js';
import { CashMovementError, recordCashMovement } from '../public/cash-movements.js';
import { findCashAccount, type CashAccountSummary } from '../public/cash-accounts.js';
import { findPaymentMethod } from '../public/cash-account-resolution.js';
import { findCashSessionCovering } from '../public/cash-sessions.js';
import {
  CASH_ACCOUNT_FORBIDDEN,
  canActOnCashAccount,
  financeBusinessRejection,
  rejected,
} from '../cash-transfer-support.js';
import {
  PAYMENT_APPROVE_PERMISSION,
  PAYMENT_RECORD_PERMISSION,
  SUPPLIER_PAYMENT_DOC_TYPE,
  adjustInvoicePaid,
  decisionPolicy,
  insertSupplierEvent,
  lockSupplierInvoices,
  nextSupplierDocNumber,
  numberSettingAt,
  settingAt,
  type SupplierInvoiceRow,
} from '../supplier-ledger-support.js';

type Uow = Transaction<DB>;
type Envelope<P> = Parameters<CommandHandler<P>>[1];

const ONLINE_REQUIRED = rejected(
  'ONLINE_REQUIRED',
  'Les paiements fournisseurs se gèrent en ligne.',
);
const NOT_FOUND = rejected('NOT_FOUND', 'Paiement fournisseur introuvable.');
const DEFAULT_APPROVAL_THRESHOLD_XAF = 500_000;

interface PaymentRow {
  readonly id: string;
  readonly docNumber: string;
  readonly supplierId: string;
  readonly amountXaf: number;
  readonly fromAccountId: string;
  readonly status: 'PENDING_APPROVAL' | 'RECORDED' | 'REJECTED' | 'CANCELLED';
  readonly unallocatedXaf: number;
  readonly cashMovementId: string | null;
  readonly approvalRequestId: string | null;
  readonly createdBy: string;
}

async function loadPayment(uow: Uow, paymentId: string): Promise<PaymentRow | undefined> {
  const row = await uow
    .selectFrom('finance_supplier_payments')
    .select([
      'id',
      'doc_number',
      'supplier_id',
      'amount_xaf',
      'from_account_id',
      'status',
      'unallocated_xaf',
      'cash_movement_id',
      'approval_request_id',
      'created_by',
    ])
    .where('id', '=', toBin(paymentId))
    .forUpdate()
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        docNumber: row.doc_number,
        supplierId: fromBin(row.supplier_id),
        amountXaf: Number(row.amount_xaf),
        fromAccountId: fromBin(row.from_account_id),
        status: row.status as PaymentRow['status'],
        unallocatedXaf: Number(row.unallocated_xaf),
        cashMovementId: fromBinOrNull(row.cash_movement_id),
        approvalRequestId: fromBinOrNull(row.approval_request_id),
        createdBy: fromBin(row.created_by),
      }
    : undefined;
}

async function allocationsOf(uow: Uow, paymentId: string, status: 'PLANNED' | 'ACTIVE') {
  const rows = await uow
    .selectFrom('finance_supplier_payment_allocations')
    .select(['id', 'invoice_id', 'amount_xaf'])
    .where('payment_id', '=', toBin(paymentId))
    .where('status', '=', status)
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    invoiceId: fromBin(row.invoice_id),
    amountXaf: Number(row.amount_xaf),
  }));
}

const payableOf = (
  invoices: ReadonlyMap<string, SupplierInvoiceRow>,
): ReadonlyMap<string, PayableInvoice> =>
  new Map(
    [...invoices].map(([id, invoice]) => [
      id,
      {
        supplierId: invoice.supplierId,
        status: invoice.status,
        balanceXaf: invoice.totalXaf - invoice.paidXaf,
      },
    ]),
  );

/** Espèces vers une caisse, tout autre moyen vers le type de compte qu'il désigne (AV-056). */
function methodFitsAccount(defaultAccountType: string, account: CashAccountSummary): boolean {
  if (defaultAccountType.startsWith('CAISSE_')) return account.accountType.startsWith('CAISSE_');
  return account.accountType === defaultAccountType;
}

export function registerSupplierPaymentCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const deps = { idGenerator };

  /** Décaissement : session de caisse au PDV, sortie `SUPPLIER_PAYMENT` (refus sans écrire sinon). */
  async function payOut(
    uow: Uow,
    input: {
      readonly paymentId: string;
      readonly account: CashAccountSummary;
      readonly amountXaf: number;
      readonly at: Date;
      readonly by: string;
      readonly commandId: string | null;
    },
  ): Promise<
    | { readonly movementId: string }
    | { readonly refusal: { readonly code: string; readonly messageFr: string } }
  > {
    const sessionRefusal = {
      code: 'CASH_SESSION_REQUIRED',
      messageFr:
        'Aucune session de caisse ouverte sur ce point de vente : ouvrir la caisse avant de payer en espèces.',
    };
    if (input.account.accountType === 'CAISSE_PDV') {
      const covering = await findCashSessionCovering(uow, input.account.id, input.at);
      if (covering?.status !== 'OPEN') return { refusal: sessionRefusal };
    }
    const movement = await recordCashMovement(uow, deps, {
      cashAccountId: input.account.id,
      direction: 'OUT',
      amountXaf: input.amountXaf,
      movementType: 'SUPPLIER_PAYMENT',
      sourceDocType: 'SUPPLIER_PAYMENT',
      sourceDocId: input.paymentId,
      occurredAt: input.at,
      createdBy: input.by,
      ...(input.commandId !== null ? { commandId: input.commandId } : {}),
      capturedOffline: false,
      allowNegative: false,
    });
    // Contrôle repris sous le verrou du compte (une clôture validée entre-temps, P5-14).
    if (input.account.accountType === 'CAISSE_PDV' && movement.cashSessionId === null) {
      return { refusal: sessionRefusal };
    }
    return { movementId: movement.movementId };
  }

  /** Affectations prévues activées, factures payées (déjà verrouillées), événement du décaissement. */
  async function settle(
    uow: Uow,
    input: {
      readonly paymentId: string;
      readonly docNumber: string;
      readonly accountId: string;
      readonly amountXaf: number;
      readonly at: Date;
      readonly by: string;
      readonly commandId: string | null;
      readonly allocations: readonly {
        readonly id: string;
        readonly invoiceId: string;
        readonly amountXaf: number;
      }[];
      readonly invoices: ReadonlyMap<string, SupplierInvoiceRow>;
    },
  ): Promise<void> {
    for (const allocation of input.allocations) {
      await uow
        .updateTable('finance_supplier_payment_allocations')
        .set({ status: 'ACTIVE', activated_at: input.at })
        .where('id', '=', toBin(allocation.id))
        .execute();
      await adjustInvoicePaid(uow, {
        invoice: input.invoices.get(allocation.invoiceId)!,
        deltaXaf: allocation.amountXaf,
        by: input.by,
      });
    }
    await insertSupplierEvent(uow, idGenerator, {
      eventType: 'SupplierPaymentRecorded',
      aggregateType: 'SUPPLIER_PAYMENT',
      aggregateId: input.paymentId,
      occurredAt: input.at,
      commandId: input.commandId,
      payload: {
        docNumber: input.docNumber,
        amountXaf: input.amountXaf,
        cashAccountId: input.accountId,
        allocations: input.allocations.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amountXaf: allocation.amountXaf,
        })),
      },
    });
  }

  // --- finance.supplier_payment.record -----------------------------------------------------------

  const record: CommandHandler<SupplierPaymentRecordPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const existing = await uow
      .selectFrom('finance_supplier_payments')
      .select(['doc_number', 'status'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    if (existing) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: existing.doc_number, status: existing.status },
      };
    }
    try {
      return await recordPayment(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function recordPayment(
    uow: Uow,
    envelope: Envelope<SupplierPaymentRecordPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const paymentId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    const supplier = await findSupplier(uow, p.supplierId);
    if (!supplier) return rejected('NOT_FOUND', 'Fournisseur inconnu.');
    const method = await findPaymentMethod(uow, p.paymentMethodCode);
    if (!method || !method.isActive)
      return rejected('PAYMENT_METHOD_INVALID', 'Moyen de paiement inconnu ou désactivé.');
    if (method.requiresReference && p.externalReference === undefined) {
      return rejected(
        'PAYMENT_REFERENCE_REQUIRED',
        `Le moyen « ${method.label} » exige une référence (AV-056).`,
      );
    }
    const account = await findCashAccount(uow, p.fromAccountId);
    if (!account) return rejected('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');
    if (account.status !== 'ACTIVE')
      return rejected('CASH_ACCOUNT_INACTIVE', 'Le compte de trésorerie est désactivé.');
    if (!methodFitsAccount(method.defaultAccountType, account)) {
      return rejected(
        'PAYMENT_METHOD_ACCOUNT_MISMATCH',
        `Le moyen « ${method.label} » ne se paie pas depuis un compte ${account.accountType}.`,
      );
    }
    if (
      !(await canActOnCashAccount(uow, {
        userId: author,
        at,
        account,
        permissionCode: PAYMENT_RECORD_PERMISSION,
      }))
    ) {
      return CASH_ACCOUNT_FORBIDDEN;
    }

    // Factures verrouillées (paiement neuf, puis factures par identifiant), affectations vérifiées.
    const invoices = await lockSupplierInvoices(
      uow,
      p.allocations.map((allocation) => allocation.invoiceId),
    );
    const advanceAllowed = (await settingAt(uow, 'finance.supplier_advance_allowed', at)) !== false;
    const plan = planSupplierPayment({
      supplierId: p.supplierId,
      availableXaf: p.amountXaf,
      allocations: p.allocations,
      invoices: payableOf(invoices),
      advanceAllowed,
    });
    const threshold = await numberSettingAt(
      uow,
      'finance.supplier_payment_approval_xaf',
      at,
      DEFAULT_APPROVAL_THRESHOLD_XAF,
    );
    const pending = supplierPaymentRequiresApproval(p.amountXaf, threshold);

    // Demande (N11) avant le numéro (N12), ADR-038.
    let approvalRequestId: string | null = null;
    if (pending) {
      const policy = await decisionPolicy(uow, 'SUPPLIER_PAYMENT', at);
      if (!policy) {
        return rejected(
          'CONTROL_POLICY_MISSING',
          'Aucune politique de validation des paiements fournisseurs : un paiement au-delà du seuil ne peut pas être enregistré (BR-FIN-033).',
        );
      }
      approvalRequestId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: approvalRequestId,
        operationType: 'SUPPLIER_PAYMENT',
        subjectType: 'SUPPLIER_PAYMENT',
        subjectId: paymentId,
        subjectSummary: `Paiement de ${p.amountXaf} XAF à ${supplier.name} (${method.label})`,
        ...(account.siteId !== null ? { siteId: account.siteId } : {}),
        amountXaf: p.amountXaf,
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
        ...(envelope.attachment_ids.length > 0
          ? { requiredAttachmentIds: envelope.attachment_ids }
          : {}),
      });
    }
    // Sous le seuil : décaissement d'abord (compte N9, session N10), le paiement naît `RECORDED`.
    let movementId: string | null = null;
    if (!pending) {
      const paid = await payOut(uow, {
        paymentId,
        account,
        amountXaf: p.amountXaf,
        at,
        by: author,
        commandId: envelope.command_id,
      });
      if ('refusal' in paid) return rejected(paid.refusal.code, paid.refusal.messageFr);
      movementId = paid.movementId;
    }
    const docNumber = await nextSupplierDocNumber(uow, documentSequences, {
      docType: SUPPLIER_PAYMENT_DOC_TYPE,
      at,
    });
    const status: PaymentRow['status'] = pending ? 'PENDING_APPROVAL' : 'RECORDED';
    await uow
      .insertInto('finance_supplier_payments')
      .values({
        id: toBin(paymentId),
        doc_number: docNumber,
        site_id: toBinOrNull(account.siteId),
        supplier_id: toBin(p.supplierId),
        amount_xaf: p.amountXaf,
        payment_method_code: method.code,
        from_account_id: toBin(account.id),
        external_reference: p.externalReference ?? null,
        status,
        unallocated_xaf: plan.unallocatedXaf as number,
        cash_movement_id: toBinOrNull(movementId),
        disbursed_at: movementId !== null ? at : null,
        approval_request_id: toBinOrNull(approvalRequestId),
        comment: p.comment ?? null,
        occurred_at: at,
        command_id: toBin(envelope.command_id),
        created_by: toBin(author),
      })
      .execute();
    const allocations = p.allocations.map((allocation) => ({
      id: idGenerator.newId(),
      ...allocation,
    }));
    if (allocations.length > 0) {
      await uow
        .insertInto('finance_supplier_payment_allocations')
        .values(
          allocations.map((allocation) => ({
            id: toBin(allocation.id),
            payment_id: toBin(paymentId),
            invoice_id: toBin(allocation.invoiceId),
            amount_xaf: allocation.amountXaf,
            status: 'PLANNED',
            created_by: toBin(author),
          })),
        )
        .execute();
    }
    if (movementId !== null) {
      await settle(uow, {
        paymentId,
        docNumber,
        accountId: account.id,
        amountXaf: p.amountXaf,
        at,
        by: author,
        commandId: envelope.command_id,
        allocations,
        invoices,
      });
    }
    return {
      status: 'APPLIED',
      serverRefs: {
        docNumber,
        status,
        ...(approvalRequestId !== null ? { approvalRequestId } : {}),
      },
      audit: {
        after: {
          status,
          docNumber,
          supplierId: p.supplierId,
          amountXaf: p.amountXaf,
          paymentMethodCode: method.code,
          fromAccountId: account.id,
          allocations: p.allocations,
          unallocatedXaf: plan.unallocatedXaf,
          approvalRequestId,
        },
      },
    };
  }

  // --- Décision SUPPLIER_PAYMENT (Direction) -----------------------------------------------------

  decisionRegistry.register('SUPPLIER_PAYMENT', async (uow, ctx) => {
    const payment = await loadPayment(uow, ctx.subjectId);
    if (!payment)
      throw new ApprovalDecisionRefused('NOT_FOUND', 'Paiement fournisseur introuvable.');
    if (payment.status !== 'PENDING_APPROVAL') {
      throw new ApprovalDecisionRefused(
        'SUPPLIER_PAYMENT_STATUS_INVALID',
        `Paiement ${payment.status} : aucune décision attendue.`,
      );
    }
    const planned = await allocationsOf(uow, payment.id, 'PLANNED');
    if (ctx.decision === 'REJECTED') {
      for (const allocation of planned) {
        await uow
          .updateTable('finance_supplier_payment_allocations')
          .set({
            status: 'REVERSED',
            reversed_at: ctx.decidedAt,
            reversed_by: toBin(ctx.decidedBy),
            reversal_reason: 'Paiement rejeté par la Direction',
          })
          .where('id', '=', toBin(allocation.id))
          .execute();
      }
      await uow
        .updateTable('finance_supplier_payments')
        .set({
          status: supplierPaymentTransition(payment.status, 'REJECT'),
          decided_by: toBin(ctx.decidedBy),
          decided_at: ctx.decidedAt,
          updated_by: toBin(ctx.decidedBy),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(payment.id))
        .execute();
      return;
    }
    // AV-363 : affectations revérifiées sous verrou, décaissement daté de la décision.
    const invoices = await lockSupplierInvoices(
      uow,
      planned.map((allocation) => allocation.invoiceId),
    );
    try {
      planSupplierPayment({
        supplierId: payment.supplierId,
        availableXaf: payment.amountXaf,
        allocations: planned,
        invoices: payableOf(invoices),
        advanceAllowed: true,
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'ALLOCATION_EXCEEDS';
      throw new ApprovalDecisionRefused(
        code,
        'Une facture affectée a changé depuis la saisie (payée ou annulée) : rejeter ce paiement et le saisir à nouveau.',
      );
    }
    const account = (await findCashAccount(uow, payment.fromAccountId))!;
    let done;
    try {
      done = await payOut(uow, {
        paymentId: payment.id,
        account,
        amountXaf: payment.amountXaf,
        at: ctx.decidedAt,
        by: ctx.decidedBy,
        commandId: null,
      });
    } catch (error) {
      if (error instanceof CashMovementError)
        throw new ApprovalDecisionRefused(error.code, error.message);
      throw error;
    }
    if ('refusal' in done)
      throw new ApprovalDecisionRefused(done.refusal.code, done.refusal.messageFr);
    await settle(uow, {
      paymentId: payment.id,
      docNumber: payment.docNumber,
      accountId: account.id,
      amountXaf: payment.amountXaf,
      at: ctx.decidedAt,
      by: ctx.decidedBy,
      commandId: null,
      allocations: planned,
      invoices,
    });
    await uow
      .updateTable('finance_supplier_payments')
      .set({
        status: supplierPaymentTransition(payment.status, 'APPROVE'),
        cash_movement_id: toBin(done.movementId),
        disbursed_at: ctx.decidedAt,
        decided_by: toBin(ctx.decidedBy),
        decided_at: ctx.decidedAt,
        updated_by: toBin(ctx.decidedBy),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(payment.id))
      .execute();
  });
  decisionRegistry.registerWithdrawalGuard('SUPPLIER_PAYMENT', async () => {
    throw new ApprovalDecisionRefused(
      'SUPPLIER_PAYMENT_NOT_WITHDRAWABLE',
      'Un paiement en attente s’annule par « Annuler le paiement » ; sa demande ne se retire pas.',
    );
  });

  // --- finance.supplier_payment.allocate ---------------------------------------------------------

  const allocate: CommandHandler<SupplierPaymentAllocatePayload> = async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    try {
      const at = new Date(envelope.occurred_at);
      const author = envelope.author_user_id;
      const payment = await loadPayment(uow, envelope.aggregate_id);
      if (!payment) return NOT_FOUND;
      if (payment.status !== 'RECORDED') {
        return rejected(
          'SUPPLIER_PAYMENT_STATUS_INVALID',
          'Seul un paiement décaissé affecte son avance.',
        );
      }
      const invoices = await lockSupplierInvoices(
        uow,
        envelope.payload.allocations.map((allocation) => allocation.invoiceId),
      );
      const plan = planSupplierPayment({
        supplierId: payment.supplierId,
        availableXaf: payment.unallocatedXaf,
        allocations: envelope.payload.allocations,
        invoices: payableOf(invoices),
        advanceAllowed: true,
      });
      for (const allocation of envelope.payload.allocations) {
        await uow
          .insertInto('finance_supplier_payment_allocations')
          .values({
            id: toBin(idGenerator.newId()),
            payment_id: toBin(payment.id),
            invoice_id: toBin(allocation.invoiceId),
            amount_xaf: allocation.amountXaf,
            status: 'ACTIVE',
            activated_at: at,
            created_by: toBin(author),
          })
          .execute();
        await adjustInvoicePaid(uow, {
          invoice: invoices.get(allocation.invoiceId)!,
          deltaXaf: allocation.amountXaf,
          by: author,
        });
      }
      await uow
        .updateTable('finance_supplier_payments')
        .set({
          unallocated_xaf: plan.unallocatedXaf as number,
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(payment.id))
        .execute();
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: payment.docNumber, unallocatedXaf: String(plan.unallocatedXaf) },
        audit: {
          before: { unallocatedXaf: payment.unallocatedXaf },
          after: { unallocatedXaf: plan.unallocatedXaf, allocations: envelope.payload.allocations },
        },
      };
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  // --- finance.supplier_payment.cancel -----------------------------------------------------------

  const cancel: CommandHandler<SupplierPaymentCancelPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    try {
      const at = new Date(envelope.occurred_at);
      const author = envelope.author_user_id;
      const payment = await loadPayment(uow, envelope.aggregate_id);
      if (!payment) return NOT_FOUND;
      const next = supplierPaymentTransition(payment.status, 'CANCEL');
      // AV-364 : en attente, son auteur ; décaissé, la Direction.
      const allowed =
        payment.status === 'PENDING_APPROVAL'
          ? payment.createdBy === author &&
            (await hasPermissionAt(uow, toBin(author), PAYMENT_RECORD_PERMISSION, at))
          : await hasPermissionAt(uow, toBin(author), PAYMENT_APPROVE_PERMISSION, at);
      if (!allowed) {
        return rejected(
          'FORBIDDEN_SCOPE',
          payment.status === 'PENDING_APPROVAL'
            ? 'Seul l’auteur annule un paiement en attente de validation.'
            : 'Seule la Direction annule un paiement décaissé.',
        );
      }
      const status = payment.status === 'PENDING_APPROVAL' ? 'PLANNED' : 'ACTIVE';
      const allocations = await allocationsOf(uow, payment.id, status);
      const invoices = await lockSupplierInvoices(
        uow,
        allocations.map((allocation) => allocation.invoiceId),
      );
      let cancelMovementId: string | null = null;
      if (payment.cashMovementId !== null) {
        const reversal = await recordCashMovement(uow, deps, {
          cashAccountId: payment.fromAccountId,
          direction: 'IN',
          amountXaf: payment.amountXaf,
          movementType: 'SUPPLIER_PAYMENT',
          sourceDocType: 'SUPPLIER_PAYMENT',
          sourceDocId: payment.id,
          occurredAt: at,
          createdBy: author,
          commandId: envelope.command_id,
          capturedOffline: false,
          allowNegative: false,
          reversesMovementId: payment.cashMovementId,
        });
        cancelMovementId = reversal.movementId;
      }
      for (const allocation of allocations) {
        await uow
          .updateTable('finance_supplier_payment_allocations')
          .set({
            status: 'REVERSED',
            reversed_at: at,
            reversed_by: toBin(author),
            reversal_reason: envelope.payload.reason,
          })
          .where('id', '=', toBin(allocation.id))
          .execute();
        if (status === 'ACTIVE') {
          await adjustInvoicePaid(uow, {
            invoice: invoices.get(allocation.invoiceId)!,
            deltaXaf: -allocation.amountXaf,
            by: author,
          });
        }
      }
      if (payment.approvalRequestId !== null && payment.status === 'PENDING_APPROVAL') {
        await cancelApprovalRequest(uow, {
          requestId: payment.approvalRequestId,
          cancelledBy: author,
        });
      }
      await uow
        .updateTable('finance_supplier_payments')
        .set({
          status: next,
          cancel_movement_id: toBinOrNull(cancelMovementId),
          cancel_reason: envelope.payload.reason,
          cancelled_by: toBin(author),
          cancelled_at: at,
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(payment.id))
        .execute();
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: payment.docNumber, status: next },
        audit: {
          before: { status: payment.status },
          after: { status: next, reason: envelope.payload.reason, cancelMovementId },
        },
      };
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  registry.register({
    commandType: 'finance.supplier_payment.record',
    version: 1,
    payloadSchema: supplierPaymentRecordPayloadSchema,
    permissionCode: PAYMENT_RECORD_PERMISSION,
    handler: record,
  });
  registry.register({
    commandType: 'finance.supplier_payment.allocate',
    version: 1,
    payloadSchema: supplierPaymentAllocatePayloadSchema,
    permissionCode: PAYMENT_RECORD_PERMISSION,
    handler: allocate,
  });
  registry.register({
    commandType: 'finance.supplier_payment.cancel',
    version: 1,
    payloadSchema: supplierPaymentCancelPayloadSchema,
    // Permission grossière commune (Finance, Direction) ; contrôle fin dans le gestionnaire (AV-364).
    permissionCode: 'finance.payable.read',
    handler: cancel,
  });
}
