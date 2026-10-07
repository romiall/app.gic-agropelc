/**
 * Encaissements joints à une vente (BR-VEN-023, BR-FIN-001 à 005 ; AV-056, AV-139) : un
 * encaissement par moyen de paiement, dans la même transaction que la vente, affecté en entier à
 * cette vente.
 *
 * - Compte crédité : `finance.cashAccountFor` (désigné par l'appareil et contrôlé, sinon déduit du
 *   contexte) ; le mouvement de trésorerie précède l'encaissement (`cash_movement_id`).
 * - Doublon de référence (même moyen, même référence normalisée) : l'encaissement est mis de côté
 *   (`SUSPECT_DUPLICATE`), **sans** mouvement de trésorerie ni affectation, jusqu'à la décision de
 *   la Finance (validation `PAYMENT_DUPLICATE`) ; la vente reste enregistrée avec un reste dû.
 * - Doublon probable sans référence (même client, même montant, fenêtre paramétrée) : c'est un
 *   fait, l'encaissement est enregistré, une anomalie informative est ouverte pour la Finance.
 */
import { isProbableDuplicatePayment, normalizePaymentReference, xaf } from '@gic/domain';
import type { IdGenerator } from '@gic/domain';
import type { CommandEnvelope } from '@gic/contracts';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import type { CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { requestApproval } from '../../../approvals/application/public/index.js';
import {
  cashAccountFor,
  findPaymentMethod,
  recordCashMovement,
} from '../../../finance/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  activePolicy,
  documentYear,
  numberSetting,
  rejected,
  type SiteRef,
  type Uow,
} from './shared.js';
import type { SalePaymentInput } from './sale-payload.js';

export interface PlannedPayment {
  readonly index: number;
  readonly id: string;
  readonly input: SalePaymentInput;
  readonly referenceNormalized: string | null;
  readonly accountId: string;
  readonly status: 'RECORDED' | 'SUSPECT_DUPLICATE';
  /** Encaissement déjà enregistré portant la même référence (doublon). */
  readonly duplicateOfPaymentId: string | null;
  /** Encaissement récent de même client, même montant, sans référence (doublon probable). */
  readonly probableDuplicateOfPaymentId: string | null;
}

export interface PaymentPlanContext {
  readonly at: Date;
  readonly offline: boolean;
  readonly userId: string;
  readonly siteId: string;
  readonly atPointOfSale: boolean;
  readonly customerId: string | null;
}

export type PaymentPlanResult =
  | { readonly ok: true; readonly planned: readonly PlannedPayment[] }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/** Contrôles et résolutions des encaissements (références, comptes, doublons), sans écriture. */
export async function planPayments(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  context: PaymentPlanContext,
  payments: readonly SalePaymentInput[],
): Promise<PaymentPlanResult> {
  const windowMinutes = await numberSetting(
    uow,
    'sales.duplicate_payment_window_minutes',
    context.at,
    10,
  );
  const planned: PlannedPayment[] = [];
  const keysInCommand = new Set<string>();
  for (const [index, input] of payments.entries()) {
    const method = await findPaymentMethod(uow, input.methodCode);
    if (!method || (!method.isActive && !context.offline)) {
      return {
        ok: false,
        outcome: rejected('PAYMENT_METHOD_INVALID', 'Moyen de paiement inconnu ou désactivé.'),
      };
    }
    const referenceNormalized = normalizePaymentReference(input.reference);
    if (method.requiresReference && referenceNormalized === null) {
      return {
        ok: false,
        outcome: rejected(
          'PAYMENT_REFERENCE_REQUIRED',
          `Référence obligatoire pour ce moyen de paiement (${method.label}).`,
        ),
      };
    }
    const resolution = await cashAccountFor(
      uow,
      {
        paymentMethodCode: input.methodCode,
        receivedByUserId: context.userId,
        siteId: context.siteId,
        atPointOfSale: context.atPointOfSale,
        requestedAccountId: input.cashAccountId ?? null,
      },
      { allowInactiveMethod: context.offline },
    );
    if (!resolution.ok) {
      return { ok: false, outcome: rejected(resolution.code, resolution.messageFr) };
    }

    let duplicateOf: string | null = null;
    let probableDuplicateOf: string | null = null;
    if (referenceNormalized !== null) {
      const key = `${input.methodCode}:${referenceNormalized}`;
      if (keysInCommand.has(key)) {
        return {
          ok: false,
          outcome: rejected(
            'PAYMENT_REFERENCE_DUPLICATE',
            'Même référence saisie deux fois dans la vente.',
          ),
        };
      }
      keysInCommand.add(key);
      const existing = await uow
        .selectFrom('sales_customer_payments')
        .select('id')
        .where('reference_key', '=', key)
        .executeTakeFirst();
      if (existing) duplicateOf = fromBin(existing.id);
    } else if (context.customerId !== null) {
      const margin = windowMinutes * 60_000;
      const recent = await uow
        .selectFrom('sales_customer_payments')
        .select(['id', 'customer_id', 'amount_xaf', 'occurred_at'])
        .where('customer_id', '=', toBin(context.customerId))
        .where('amount_xaf', '=', input.amountXaf)
        .where('status', '=', 'RECORDED')
        .where('occurred_at', '>=', new Date(context.at.getTime() - margin))
        .where('occurred_at', '<=', new Date(context.at.getTime() + margin))
        .execute();
      const probable = recent.find((row) =>
        isProbableDuplicatePayment({
          a: {
            customerId: context.customerId,
            amountXaf: xaf(input.amountXaf),
            occurredAt: context.at,
          },
          b: {
            customerId: row.customer_id ? fromBin(row.customer_id) : null,
            amountXaf: xaf(Number(row.amount_xaf)),
            occurredAt: row.occurred_at,
          },
          windowMinutes,
        }),
      );
      if (probable) probableDuplicateOf = fromBin(probable.id);
    }
    planned.push({
      index,
      id: deps.idGenerator.newId(),
      input,
      referenceNormalized,
      accountId: resolution.account.id,
      status: duplicateOf !== null ? 'SUSPECT_DUPLICATE' : 'RECORDED',
      duplicateOfPaymentId: duplicateOf,
      probableDuplicateOfPaymentId: probableDuplicateOf,
    });
  }
  return { ok: true, planned };
}

export interface PaymentWriteContext {
  readonly envelope: CommandEnvelope<unknown>;
  readonly origin: CommandOrigin;
  readonly at: Date;
  readonly offline: boolean;
  readonly userId: string;
  readonly saleId: string;
  readonly customerId: string | null;
  readonly site: SiteRef;
  readonly zoneId: string;
}

export interface PaymentWriteResult {
  /** Σ des encaissements affectés à la vente (RECORDED). */
  readonly paidXaf: number;
  readonly docNumbers: ReadonlyMap<number, string>;
  readonly warnings: readonly 'PAYMENT_SUSPECT_DUPLICATE'[];
  readonly rejection?: CommandHandlerOutcome;
}

/** Écrit les encaissements planifiés ; la vente existe déjà (affectation, mise de côté). */
export async function writePayments(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator; readonly documentSequences: DocumentSequenceService },
  context: PaymentWriteContext,
  planned: readonly PlannedPayment[],
): Promise<PaymentWriteResult> {
  const docNumbers = new Map<number, string>();
  const warnings = new Set<'PAYMENT_SUSPECT_DUPLICATE'>();
  let paidXaf = 0;
  const { envelope, origin, at } = context;
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
    customer_id: toBinOrNull(context.customerId),
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

  // Comptes verrouillés dans un ordre constant (identifiant) : pas d'interblocage entre ventes.
  const recorded = planned
    .filter((payment) => payment.status === 'RECORDED')
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.index - b.index);
  // Passe 1 : tous les mouvements de trésorerie, comptes dans l'ordre de leur identifiant ; passe 2 :
  // numéros et documents. Aucun verrou de compteur n'est pris entre deux verrous de compte.
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
    const movementId = movements.get(payment.index)!;
    const docNumber = await nextNumber();
    docNumbers.set(payment.index, docNumber);
    await uow
      .insertInto('sales_customer_payments')
      .values({
        ...base(payment),
        doc_number: docNumber,
        cash_movement_id: toBin(movementId),
        status: 'RECORDED',
      })
      .execute();
    await uow
      .insertInto('sales_payment_allocations')
      .values({
        id: toBin(deps.idGenerator.newId()),
        payment_id: toBin(payment.id),
        sale_id: toBin(context.saleId),
        amount_xaf: payment.input.amountXaf,
        allocated_at: at,
        command_id: toBin(envelope.command_id),
        created_by: toBin(context.userId),
      })
      .execute();
    paidXaf += payment.input.amountXaf;
    if (payment.probableDuplicateOfPaymentId !== null) {
      await recordConflict(uow, {
        id: deps.idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'DUPLICATE_SUSPECTED',
        entityType: 'CUSTOMER_PAYMENT',
        entityId: payment.id,
        siteId: context.site.id,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          saleId: context.saleId,
          amountXaf: payment.input.amountXaf,
          similarPaymentId: payment.probableDuplicateOfPaymentId,
        },
      });
      warnings.add('PAYMENT_SUSPECT_DUPLICATE');
    }
  }

  for (const payment of planned.filter((candidate) => candidate.status === 'SUSPECT_DUPLICATE')) {
    const policy = await activePolicy(
      uow,
      'PAYMENT_DUPLICATE',
      at,
      context.offline ? origin.receivedAt : undefined,
    );
    if (!policy)
      return {
        paidXaf,
        docNumbers,
        warnings: [],
        rejection: CONTROL_POLICY_MISSING('PAYMENT_DUPLICATE'),
      };
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
        intended_sale_id: toBin(context.saleId),
      })
      .execute();
    await requestApproval(uow, {
      requestId: deps.idGenerator.newId(),
      operationType: 'PAYMENT_DUPLICATE',
      subjectType: 'CUSTOMER_PAYMENT',
      subjectId: payment.id,
      subjectSummary: `Encaissement ${docNumber} en double (${payment.input.methodCode}, ${payment.input.amountXaf} XAF)`,
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
      // Quarantaine : l'encaissement n'a aucun effet de trésorerie tant que la Finance n'a pas décidé.
      applied: false,
      details: {
        saleId: context.saleId,
        methodCode: payment.input.methodCode,
        referenceNormalized: payment.referenceNormalized,
        duplicateOfPaymentId: payment.duplicateOfPaymentId,
      },
    });
    warnings.add('PAYMENT_SUSPECT_DUPLICATE');
  }
  return { paidXaf, docNumbers, warnings: [...warnings] };
}
