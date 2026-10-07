/**
 * Acomptes d'une commande (ADR-028 §8 ; AV-033, défaut : l'acompte passe à la vente à sa
 * confirmation) : encaissements joints à `sales.order.place`, **affectés à la commande** tant qu'aucune
 * vente n'existe, puis reportés sur la vente par `confirmOrderPending` (`order-sale.ts`).
 *
 * Même traitement que les encaissements joints d'une vente directe (`sale-payments.ts`) : compte
 * résolu par `finance.cashAccountFor`, mouvement de trésorerie d'abord, doublon de référence mis de
 * côté (`SUSPECT_DUPLICATE`, `intended_order_id`), comptes verrouillés dans l'ordre de leur
 * identifiant puis numéros `ENC` (aucun verrou de compteur entre deux verrous de compte).
 */
import type { IdGenerator } from '@gic/domain';
import type { CommandEnvelope } from '@gic/contracts';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import type { CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { requestApproval } from '../../../approvals/application/public/index.js';
import { recordCashMovement } from '../../../finance/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  activePolicy,
  documentYear,
  type SiteRef,
  type Uow,
} from './shared.js';
import type { PlannedPayment } from './sale-payments.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';

export interface AdvanceWriteContext {
  readonly envelope: CommandEnvelope<unknown>;
  readonly origin: CommandOrigin;
  readonly at: Date;
  readonly offline: boolean;
  readonly userId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly site: SiteRef;
  readonly zoneId: string;
}

export interface AdvanceWriteResult {
  /** Σ des acomptes affectés à la commande (RECORDED). */
  readonly advanceXaf: number;
  readonly docNumbers: ReadonlyMap<number, string>;
  readonly warnings: readonly 'PAYMENT_SUSPECT_DUPLICATE'[];
  readonly rejection?: CommandHandlerOutcome;
}

export async function writeAdvancePayments(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator; readonly documentSequences: DocumentSequenceService },
  context: AdvanceWriteContext,
  planned: readonly PlannedPayment[],
): Promise<AdvanceWriteResult> {
  const { envelope, origin, at } = context;
  const docNumbers = new Map<number, string>();
  const warnings = new Set<'PAYMENT_SUSPECT_DUPLICATE'>();
  let advanceXaf = 0;
  const base = (payment: PlannedPayment) => ({
    occurred_at: at,
    client_created_at: new Date(envelope.client_created_at),
    received_at_server: origin.receivedAt,
    command_id: toBin(envelope.command_id),
    created_device_id: toBinOrNull(origin.deviceId),
    captured_offline: context.offline ? (1 as const) : (0 as const),
    clock_suspect: origin.clockSuspect ? (1 as const) : (0 as const),
    backdated_reason: envelope.backdated_reason,
    created_by: toBin(context.userId),
    id: toBin(payment.id),
    site_id: toBin(context.site.id),
    customer_id: toBin(context.customerId),
    payment_method_code: payment.input.methodCode,
    amount_xaf: payment.input.amountXaf,
    external_reference: payment.input.reference ?? null,
    reference_normalized: payment.referenceNormalized,
    received_by_user_id: toBin(context.userId),
    cash_account_id: toBin(payment.accountId),
    unallocated_xaf: 0,
  });
  const nextNumber = (): Promise<string> =>
    deps.documentSequences.next(uow, {
      docType: 'ENC',
      siteId: context.site.id,
      codeSite: context.site.code,
      year: documentYear(at),
    });

  const recorded = planned
    .filter((payment) => payment.status === 'RECORDED')
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.index - b.index);
  const movements = new Map<number, string>();
  for (const payment of recorded) {
    const movement = await recordCashMovement(uow, deps, {
      cashAccountId: payment.accountId,
      direction: 'IN',
      amountXaf: payment.input.amountXaf,
      movementType: 'CUSTOMER_PAYMENT',
      sourceDocType: 'CUSTOMER_PAYMENT',
      sourceDocId: payment.id,
      occurredAt: at,
      createdBy: context.userId,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: envelope.command_id,
      capturedOffline: context.offline,
      allowNegative: context.offline,
    });
    movements.set(payment.index, movement.movementId);
  }
  for (const payment of recorded) {
    const docNumber = await nextNumber();
    docNumbers.set(payment.index, docNumber);
    await uow
      .insertInto('sales_customer_payments')
      .values({
        ...base(payment),
        doc_number: docNumber,
        cash_movement_id: toBin(movements.get(payment.index)!),
        status: 'RECORDED',
      })
      .execute();
    await uow
      .insertInto('sales_payment_allocations')
      .values({
        id: toBin(deps.idGenerator.newId()),
        payment_id: toBin(payment.id),
        order_id: toBin(context.orderId),
        amount_xaf: payment.input.amountXaf,
        allocated_at: at,
        command_id: toBin(envelope.command_id),
        created_by: toBin(context.userId),
      })
      .execute();
    advanceXaf += payment.input.amountXaf;
  }

  for (const payment of planned.filter((candidate) => candidate.status === 'SUSPECT_DUPLICATE')) {
    const policy = await activePolicy(
      uow,
      'PAYMENT_DUPLICATE',
      at,
      context.offline ? origin.receivedAt : undefined,
    );
    if (!policy) {
      return {
        advanceXaf,
        docNumbers,
        warnings: [],
        rejection: CONTROL_POLICY_MISSING('PAYMENT_DUPLICATE'),
      };
    }
    const docNumber = await nextNumber();
    docNumbers.set(payment.index, docNumber);
    await uow
      .insertInto('sales_customer_payments')
      .values({
        ...base(payment),
        doc_number: docNumber,
        cash_movement_id: null,
        status: 'SUSPECT_DUPLICATE',
        duplicate_of_payment_id: toBin(payment.duplicateOfPaymentId!),
        intended_order_id: toBin(context.orderId),
      })
      .execute();
    await requestApproval(uow, {
      requestId: deps.idGenerator.newId(),
      operationType: 'PAYMENT_DUPLICATE',
      subjectType: 'CUSTOMER_PAYMENT',
      subjectId: payment.id,
      subjectSummary: `Acompte ${docNumber} en double (${payment.input.methodCode}, ${payment.input.amountXaf} XAF)`,
      siteId: context.site.id,
      zoneId: context.zoneId,
      amountXaf: payment.input.amountXaf,
      requestedBy: context.userId,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
      entityType: 'CUSTOMER_PAYMENT',
      entityId: payment.id,
      siteId: context.site.id,
      ownerRole: 'FINANCE',
      applied: false,
      details: {
        orderId: context.orderId,
        methodCode: payment.input.methodCode,
        referenceNormalized: payment.referenceNormalized,
        duplicateOfPaymentId: payment.duplicateOfPaymentId,
      },
    });
    warnings.add('PAYMENT_SUSPECT_DUPLICATE');
  }

  if (advanceXaf > 0) {
    await uow
      .updateTable('sales_sales_orders')
      .set((eb) => ({ advance_paid_xaf: eb('advance_paid_xaf', '+', advanceXaf) }))
      .where('id', '=', toBin(context.orderId))
      .execute();
  }
  return { advanceXaf, docNumbers, warnings: [...warnings] };
}
