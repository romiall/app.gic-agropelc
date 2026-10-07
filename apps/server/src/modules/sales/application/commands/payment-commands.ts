/**
 * Encaissements clients hors vente (P4-08 ; D09 §4 UC-FIN-02 à UC-FIN-05, §7.1 BR-FIN-001 à 008 ;
 * SM-CUSTOMER-PAYMENT ; AV-056, AV-135, AV-139, AV-150) :
 *
 * - `sales.payment.record` (hors ligne) : règlement de créances ou acompte d'une commande. Affectations
 *   explicites (`allocations[]`) ou, à défaut, automatiques aux ventes ouvertes du client, de
 *   l'échéance la plus ancienne à la plus récente (BR-FIN-004) ; le reste est un **crédit client**
 *   (BR-FIN-003). Référence déjà connue : encaissement mis de côté (`SUSPECT_DUPLICATE`), sans
 *   trésorerie ni affectation, validation `PAYMENT_DUPLICATE` (BR-FIN-005) ;
 * - `sales.payment.reallocate` (Finance, en ligne) : libère des affectations (`REALLOCATED`) et
 *   affecte le crédit de l'encaissement à d'autres ventes ou commandes du client ;
 * - `sales.payment.refund` (Finance, en ligne) : rembourse tout ou partie du crédit client ;
 * - `sales.payment.request_cancellation` (en ligne) : demande `PAYMENT_CANCELLATION` ; à la
 *   validation, mouvement de trésorerie inverse et affectations renversées, ce qui rouvre les
 *   créances (BR-FIN-006) ; au rejet, l'encaissement redevient `RECORDED` ;
 * - décision `PAYMENT_DUPLICATE` : approuvé, l'encaissement est enregistré (référence corrigée par
 *   la Finance, `decisionData.correctedReference`, AV-135) et affecté à la vente ou à la commande
 *   visée ; rejeté, il est `REJECTED` sans effet.
 *
 * Ordre de verrous (D04 §15) : commandes, puis ventes (identifiant croissant), puis l'encaissement et
 * ses affectations, puis les comptes de trésorerie. Compteurs `amount_paid_xaf` et `advance_paid_xaf` :
 * un seul `UPDATE` par vente et par commande (`applyCounterDeltas`).
 */
import { z } from 'zod';
import { normalizePaymentReference, type IdGenerator } from '@gic/domain';
import { sql } from 'kysely';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import {
  latestConflictDetails,
  recordConflict,
  resolveOpenConflicts,
} from '../../../../platform/sync/conflicts.js';
import {
  ApprovalDecisionRefused,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import { ownerOfCustomerAt } from '../../../crm/application/public/index.js';
import { findCashAccount, recordCashMovement } from '../../../finance/application/public/index.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  FORBIDDEN_SCOPE,
  activePolicy,
  businessRejection,
  documentYear,
  loadSite,
  rejected,
  type SiteRef,
  type Uow,
} from './shared.js';
import { planPayments } from './sale-payments.js';
import {
  applyCounterDeltas,
  compareByDue,
  customerAccountsOf,
  insertAllocations,
  isAdvanceOrder,
  lockActiveAllocations,
  lockOrdersForPayment,
  lockSalesForPayment,
  newCounterDeltas,
  openSaleIdsOf,
  planSaleAllocations,
  releaseAllocations,
  type CustomerAccounts,
  type OrderForPayment,
  type PlannedAllocation,
  type SaleForPayment,
} from './payment-allocation.js';
import {
  withSalesChanges,
  withSalesDecisionChanges,
  type SalesDecisionRegistry,
} from '../sync-changes.js';

const uuid = z.string().uuid();
const xafPositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const targetSchema = z
  .object({
    saleId: uuid.optional(),
    orderId: uuid.optional(),
    amountXaf: xafPositive,
  })
  .refine(
    (target) => (target.saleId === undefined) !== (target.orderId === undefined),
    'Une cible exactement : vente ou commande.',
  );
type TargetInput = z.infer<typeof targetSchema>;
/** Cible d'une affectation : vente ou commande. */
interface TargetRef {
  readonly saleId?: string | undefined;
  readonly orderId?: string | undefined;
}

const recordSchema = z.object({
  /** Client ; absent seulement pour régler une vente anonyme désignée explicitement. */
  customerId: uuid.optional(),
  /** Site de l'encaissement ; à défaut, celui de la première cible ou de la vente la plus ancienne. */
  siteId: uuid.optional(),
  methodCode: z.string().trim().min(1).max(40),
  amountXaf: xafPositive,
  reference: z.string().trim().min(1).max(80).optional(),
  cashAccountId: uuid.optional(),
  localRef: z.string().trim().min(1).max(20).optional(),
  /** Affectations explicites ; absentes : affectation automatique (BR-FIN-004). */
  allocations: z.array(targetSchema).min(1).max(50).optional(),
});
type RecordPayload = z.infer<typeof recordSchema>;

const reallocateSchema = z.object({
  release: z.array(targetSchema).max(50).optional(),
  allocate: z.array(targetSchema).max(50).optional(),
});
type ReallocatePayload = z.infer<typeof reallocateSchema>;

const refundSchema = z.object({
  amountXaf: xafPositive,
  /** Compte décaissé ; par défaut, celui qui a reçu l'encaissement. */
  cashAccountId: uuid.optional(),
});
type RefundPayload = z.infer<typeof refundSchema>;

const requestCancellationSchema = z.object({
  reasonCodeId: uuid.optional(),
  comment: z.string().trim().min(1).max(2000).optional(),
});
type RequestCancellationPayload = z.infer<typeof requestCancellationSchema>;

type Envelope<P> = Parameters<CommandHandler<P>>[1];
type Warning = 'PAYMENT_SUSPECT_DUPLICATE' | 'PAYMENT_UNALLOCATED';
type PaymentRow = Awaited<ReturnType<typeof lockPayment>>;

const NOT_FOUND = rejected('PAYMENT_NOT_FOUND', 'Encaissement inconnu.');
const ONLINE_REQUIRED = rejected(
  'ONLINE_REQUIRED',
  'Opération de la Finance, en ligne seulement (D09 §12).',
);
/** Référence externe : `varchar(80)` (dictionnaire 05-sales). */
const MAX_REFERENCE_LENGTH = 80;

/** Encaissement verrouillé (après les ventes et commandes, ordre de verrous commun). */
async function lockPayment(uow: Uow, paymentId: string) {
  return uow
    .selectFrom('sales_customer_payments')
    .selectAll()
    .where('id', '=', toBin(paymentId))
    .forUpdate()
    .executeTakeFirst();
}

/** Valeur encore à vendre d'une commande (attente × prix convenu) : plafond d'un acompte (AV-150). */
async function pendingValueXaf(uow: Uow, orderId: string): Promise<number> {
  const lines = await uow
    .selectFrom('sales_sales_order_lines')
    .select(['quantity_base', 'sold_quantity_base', 'quoted_unit_price_xaf'])
    .where('order_id', '=', toBin(orderId))
    // Lecture verrouillante (la commande l'est déjà) : l'état le plus récent, pas l'instantané.
    .forUpdate()
    .execute();
  return lines.reduce((sum, line) => {
    const pendingMilli =
      Math.round(Number(line.quantity_base) * 1000) -
      Math.round(Number(line.sold_quantity_base) * 1000);
    return sum + Math.round((pendingMilli * Number(line.quoted_unit_price_xaf)) / 1000);
  }, 0);
}

interface LockedTargets {
  readonly sales: Map<string, SaleForPayment>;
  readonly orders: Map<string, OrderForPayment>;
}

/** Commandes puis ventes, verrouillées (identifiant croissant). */
async function lockTargets(uow: Uow, targets: readonly TargetRef[]): Promise<LockedTargets> {
  const orders = await lockOrdersForPayment(
    uow,
    targets.flatMap((target) => (target.orderId ? [target.orderId] : [])),
  );
  const sales = await lockSalesForPayment(
    uow,
    targets.flatMap((target) => (target.saleId ? [target.saleId] : [])),
  );
  return { sales, orders };
}

const targetKey = (target: TargetRef) =>
  target.saleId !== undefined ? `S:${target.saleId}` : `O:${target.orderId}`;

/** Une même vente ou commande citée deux fois dans une liste de cibles. */
function hasDuplicateTarget(targets: readonly TargetRef[]): boolean {
  const keys = new Set(targets.map(targetKey));
  return keys.size !== targets.length;
}

/** `ApprovalDecisionRefused` à partir d'un rejet, ou d'une erreur métier (trésorerie, domaine). */
function refusalOf(error: unknown): ApprovalDecisionRefused {
  const outcome = businessRejection(error);
  return outcome.status === 'REJECTED'
    ? new ApprovalDecisionRefused(outcome.errorCode, outcome.messageFr)
    : new ApprovalDecisionRefused('DECISION_REFUSED', 'Décision impossible.');
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator, documentSequences };

  // --- sales.payment.record --------------------------------------------------------------------------

  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const existing = await uow
      .selectFrom('sales_customer_payments')
      .select('doc_number')
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    if (existing) return { status: 'APPLIED', serverRefs: { docNumber: existing.doc_number } };
    try {
      return await recordPayment(uow, envelope);
    } catch (error) {
      return businessRejection(error);
    }
  };

  async function recordPayment(
    uow: Uow,
    envelope: Envelope<RecordPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const paymentId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    // --- Client --------------------------------------------------------------------------------------
    let accounts: CustomerAccounts | undefined;
    if (p.customerId !== undefined) {
      accounts = await customerAccountsOf(uow, p.customerId);
      if (!accounts) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');
      if (accounts.customer.stage === 'MERGED' && !offline) {
        return rejected(
          'CUSTOMER_MERGED',
          'Compte fusionné dans un autre compte : encaisser pour le compte conservé (BR-CRM-007).',
        );
      }
    } else if (p.allocations === undefined || p.allocations.some((target) => !target.saleId)) {
      return rejected(
        'CUSTOMER_REQUIRED',
        'Client obligatoire, sauf pour régler une vente anonyme désignée (BR-FIN-001).',
      );
    }

    // --- Cibles verrouillées : explicites, sinon ventes ouvertes du client (BR-FIN-004) -------------
    const explicit = p.allocations ?? [];
    if (hasDuplicateTarget(explicit)) {
      return rejected('ALLOCATION_INVALID', 'Une même cible est citée deux fois.');
    }
    const auto = explicit.length === 0;
    const candidateSaleIds = auto && accounts ? await openSaleIdsOf(uow, accounts.accountIds) : [];
    const locked = await lockTargets(
      uow,
      auto ? candidateSaleIds.map((saleId) => ({ saleId })) : explicit,
    );

    let planned: PlannedAllocation[] = [];
    let unallocatedXaf: number;
    let divertedXaf = 0;
    if (auto) {
      const plan = planSaleAllocations(p.amountXaf, [...locked.sales.values()].sort(compareByDue));
      planned = [...plan.allocations];
      unallocatedXaf = plan.unallocatedXaf;
    } else {
      const explicitTotal = explicit.reduce((sum, target) => sum + target.amountXaf, 0);
      if (explicitTotal > p.amountXaf) {
        return rejected(
          'ALLOCATION_EXCEEDS',
          'Les affectations dépassent le montant de l’encaissement.',
        );
      }
      const checked = await checkTargets(uow, {
        targets: explicit,
        locked,
        accounts,
        offline,
        availableXaf: explicitTotal,
      });
      if (!checked.ok) return checked.outcome;
      planned = checked.allocations;
      unallocatedXaf = p.amountXaf - planned.reduce((sum, a) => sum + a.amountXaf, 0);
      // Hors ligne seulement : part destinée à une cible devenue non payable, ou au-delà de son reste.
      divertedXaf = explicitTotal - planned.reduce((sum, a) => sum + a.amountXaf, 0);
    }
    if (unallocatedXaf > 0 && !accounts) {
      return rejected(
        'ALLOCATION_EXCEEDS',
        'Un encaissement sans client ne peut pas laisser de crédit : régler le montant dû exact.',
      );
    }

    // --- Site, portée ----------------------------------------------------------------------------------
    const firstTarget: TargetRef | undefined =
      explicit[0] ?? (planned[0] ? { saleId: planned[0].targetId } : undefined);
    const siteId =
      p.siteId ??
      (firstTarget?.saleId !== undefined
        ? locked.sales.get(firstTarget.saleId)?.siteId
        : firstTarget?.orderId !== undefined
          ? locked.orders.get(firstTarget.orderId)?.siteId
          : undefined) ??
      accounts?.customer.homeSiteId ??
      undefined;
    if (!siteId) {
      return rejected(
        'SITE_REQUIRED',
        'Site de l’encaissement à préciser (aucune vente à régler).',
      );
    }
    const site = await loadSite(uow, siteId);
    if (!site) return rejected('REFERENCE_INVALID', 'Site inconnu.');
    const customerId = accounts?.customer.id ?? null;
    const anonymousSale =
      customerId === null && explicit[0]?.saleId ? explicit[0].saleId : undefined;
    const owner =
      customerId !== null
        ? ((await ownerOfCustomerAt(uow, customerId, at)) ?? author)
        : anonymousSale
          ? await sellerOf(uow, anonymousSale)
          : author;
    const access = await evaluateAccess(uow, {
      userId: author,
      permissionCode: 'sales.payment.record',
      occurredAt: at,
      resource: {
        ownerUserId: owner ?? author,
        siteId: site.id,
        zoneId: accounts?.customer.zoneId ?? site.zoneId,
      },
    });
    if (!access.allowed) return FORBIDDEN_SCOPE;

    // --- Moyen, référence, compte, doublons (règles partagées avec la vente) ------------------------
    const plannedPayments = await planPayments(
      uow,
      deps,
      {
        at,
        offline,
        userId: author,
        siteId: site.id,
        atPointOfSale: site.siteType === 'POINT_DE_VENTE',
        customerId,
      },
      [
        {
          methodCode: p.methodCode,
          amountXaf: p.amountXaf,
          ...(p.reference !== undefined ? { reference: p.reference } : {}),
          ...(p.cashAccountId !== undefined ? { cashAccountId: p.cashAccountId } : {}),
        },
      ],
    );
    if (!plannedPayments.ok) return plannedPayments.outcome;
    const payment = plannedPayments.planned[0]!;
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    // Numéro pris après le verrou du compte de trésorerie, comme pour une vente avec encaissement
    // (`sale-payments.ts`) : même ordre de verrous, pas d'interblocage entre les deux.
    const nextNumber = (): Promise<string> =>
      documentSequences.next(uow, {
        docType: 'ENC',
        siteId: site.id,
        codeSite: site.code,
        year: documentYear(at),
      });
    const base = {
      id: toBin(paymentId),
      local_ref: p.localRef ?? null,
      site_id: toBin(site.id),
      customer_id: toBinOrNull(customerId),
      payment_method_code: p.methodCode,
      amount_xaf: p.amountXaf,
      external_reference: p.reference ?? null,
      reference_normalized: payment.referenceNormalized,
      received_by_user_id: toBin(author),
      cash_account_id: toBin(payment.accountId),
      occurred_at: at,
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      command_id: toBin(envelope.command_id),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: offline ? (1 as const) : (0 as const),
      clock_suspect: origin.clockSuspect ? (1 as const) : (0 as const),
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    };

    // --- Doublon de référence : mis de côté, sans trésorerie ni affectation (BR-FIN-005) -----------
    if (payment.status === 'SUSPECT_DUPLICATE') {
      const policy = await activePolicy(
        uow,
        'PAYMENT_DUPLICATE',
        at,
        offline ? origin.receivedAt : undefined,
      );
      if (!policy) return CONTROL_POLICY_MISSING('PAYMENT_DUPLICATE');
      const single = explicit.length === 1 ? explicit[0] : undefined;
      const docNumber = await nextNumber();
      await uow
        .insertInto('sales_customer_payments')
        .values({
          ...base,
          doc_number: docNumber,
          cash_movement_id: null,
          status: 'SUSPECT_DUPLICATE',
          duplicate_of_payment_id: toBin(payment.duplicateOfPaymentId!),
          intended_sale_id: toBinOrNull(single?.saleId ?? null),
          intended_order_id: toBinOrNull(single?.orderId ?? null),
          unallocated_xaf: 0,
        })
        .execute();
      await requestApproval(uow, {
        requestId: idGenerator.newId(),
        operationType: 'PAYMENT_DUPLICATE',
        subjectType: 'CUSTOMER_PAYMENT',
        subjectId: paymentId,
        subjectSummary: `Encaissement ${docNumber} en double (${p.methodCode}, ${p.amountXaf} XAF)`,
        siteId: site.id,
        zoneId: accounts?.customer.zoneId ?? site.zoneId,
        amountXaf: p.amountXaf,
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
      });
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
        entityType: 'CUSTOMER_PAYMENT',
        entityId: paymentId,
        siteId: site.id,
        ownerRole: 'FINANCE',
        applied: false,
        details: {
          methodCode: p.methodCode,
          referenceNormalized: payment.referenceNormalized,
          duplicateOfPaymentId: payment.duplicateOfPaymentId,
          allocations: explicit,
        },
      });
      return {
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['PAYMENT_SUSPECT_DUPLICATE'],
        serverRefs: { docNumber },
      };
    }

    // --- Enregistrement : trésorerie, encaissement, affectations, compteurs --------------------------
    const movement = await recordCashMovement(uow, deps, {
      cashAccountId: payment.accountId,
      direction: 'IN',
      amountXaf: p.amountXaf,
      movementType: 'CUSTOMER_PAYMENT',
      sourceDocType: 'CUSTOMER_PAYMENT',
      sourceDocId: paymentId,
      occurredAt: at,
      createdBy: author,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: envelope.command_id,
      capturedOffline: offline,
      allowNegative: offline,
    });
    const docNumber = await nextNumber();
    await uow
      .insertInto('sales_customer_payments')
      .values({
        ...base,
        doc_number: docNumber,
        cash_movement_id: toBin(movement.movementId),
        status: 'RECORDED',
        unallocated_xaf: unallocatedXaf,
      })
      .execute();
    const deltas = newCounterDeltas();
    await insertAllocations(
      uow,
      deps,
      {
        paymentId,
        allocations: planned,
        allocatedAt: at,
        actorUserId: author,
        commandId: envelope.command_id,
      },
      deltas,
    );
    await applyCounterDeltas(uow, deltas);
    const warnings = new Set<Warning>();
    if (payment.probableDuplicateOfPaymentId !== null) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'DUPLICATE_SUSPECTED',
        entityType: 'CUSTOMER_PAYMENT',
        entityId: paymentId,
        siteId: site.id,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          amountXaf: p.amountXaf,
          similarPaymentId: payment.probableDuplicateOfPaymentId,
        },
      });
      warnings.add('PAYMENT_SUSPECT_DUPLICATE');
    }
    if (divertedXaf > 0) {
      // AV-150 : l'argent reçu hors ligne n'est jamais refusé ; la part non affectable reste en
      // crédit client, avec un conflit appliqué pour la Finance.
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'PAYMENT_UNALLOCATED',
        entityType: 'CUSTOMER_PAYMENT',
        entityId: paymentId,
        siteId: site.id,
        ownerRole: 'FINANCE',
        applied: true,
        details: { divertedXaf, requested: explicit, applied: planned },
      });
      warnings.add('PAYMENT_UNALLOCATED');
    }
    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs: { docNumber } }
      : { status: 'APPLIED', serverRefs: { docNumber } };
  }

  async function sellerOf(uow: Uow, saleId: string): Promise<string | null> {
    const row = await uow
      .selectFrom('sales_sales')
      .select('seller_user_id')
      .where('id', '=', toBin(saleId))
      .executeTakeFirst();
    return row ? fromBin(row.seller_user_id) : null;
  }

  /**
   * Contrôle des affectations explicites sur les cibles verrouillées : cible connue, du client
   * (comptes fusionnés compris), payable ; en ligne, montant ≤ reste dû (vente) ou ≤ reste à vendre
   * (commande, AV-150) ; hors ligne, la part au-delà reste en crédit client (fait accompli).
   */
  async function checkTargets(
    uow: Uow,
    input: {
      readonly targets: readonly TargetInput[];
      readonly locked: LockedTargets;
      readonly accounts: CustomerAccounts | undefined;
      readonly offline: boolean;
      /** Montant affectable (encaissement, ou crédit après libération). */
      readonly availableXaf: number;
      /** Reste dû déjà libéré sur une cible dans la même opération (réaffectation). */
      readonly freedXaf?: ReadonlyMap<string, number>;
    },
  ): Promise<
    | { readonly ok: true; readonly allocations: PlannedAllocation[] }
    | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
  > {
    const allowed = new Set(input.accounts?.accountIds ?? []);
    const allocations: PlannedAllocation[] = [];
    for (const target of input.targets) {
      const freed = input.freedXaf?.get(targetKey(target)) ?? 0;
      let roomXaf: number;
      let customerId: string | null;
      if (target.saleId !== undefined) {
        const sale = input.locked.sales.get(target.saleId);
        if (!sale) return { ok: false, outcome: rejected('SALE_NOT_FOUND', 'Vente inconnue.') };
        customerId = sale.customerId;
        const payable = sale.status === 'CONFIRMED' && (sale.balanceDueXaf > 0 || freed > 0);
        if (!payable) {
          if (!input.offline) {
            return {
              ok: false,
              outcome: rejected(
                'ALLOCATION_TARGET_INVALID',
                'Vente annulée, en cours d’annulation ou déjà soldée.',
              ),
            };
          }
          continue;
        }
        roomXaf = sale.balanceDueXaf + freed;
      } else {
        const order = input.locked.orders.get(target.orderId!);
        if (!order)
          return { ok: false, outcome: rejected('ORDER_NOT_FOUND', 'Commande inconnue.') };
        customerId = order.customerId;
        if (!isAdvanceOrder(order)) {
          if (!input.offline) {
            return {
              ok: false,
              outcome: rejected(
                'ALLOCATION_TARGET_INVALID',
                'Commande livrée, clôturée ou annulée : régler ses ventes.',
              ),
            };
          }
          continue;
        }
        roomXaf = Math.max(
          0,
          (await pendingValueXaf(uow, order.id)) - order.advancePaidXaf + freed,
        );
      }
      const sameCustomer =
        customerId === null ? input.accounts === undefined : allowed.has(customerId);
      if (!sameCustomer) {
        return {
          ok: false,
          outcome: rejected(
            'ALLOCATION_TARGET_INVALID',
            'La vente ou la commande appartient à un autre client.',
          ),
        };
      }
      if (target.amountXaf > roomXaf && !input.offline) {
        return {
          ok: false,
          outcome: rejected(
            'ALLOCATION_EXCEEDS',
            target.saleId !== undefined
              ? 'L’affectation dépasse le reste dû de la vente.'
              : 'L’acompte dépasse ce qui reste à vendre sur la commande (AV-150).',
          ),
        };
      }
      const amount = Math.min(target.amountXaf, roomXaf);
      if (amount > 0) {
        allocations.push(
          target.saleId !== undefined
            ? { kind: 'SALE', targetId: target.saleId, amountXaf: amount }
            : { kind: 'ORDER', targetId: target.orderId!, amountXaf: amount },
        );
      }
    }
    const total = allocations.reduce((sum, allocation) => sum + allocation.amountXaf, 0);
    if (total > input.availableXaf) {
      return {
        ok: false,
        outcome: rejected('ALLOCATION_EXCEEDS', 'Les affectations dépassent le crédit disponible.'),
      };
    }
    return { ok: true, allocations };
  }

  /** Portée d'une commande de la Finance sur un encaissement : client, site et zone de l'encaissement. */
  async function paymentAccess(
    uow: Uow,
    payment: NonNullable<PaymentRow>,
    input: { readonly author: string; readonly at: Date; readonly permissionCode: string },
  ): Promise<{ readonly allowed: boolean; readonly site: SiteRef | undefined }> {
    const site = await loadSite(uow, fromBin(payment.site_id));
    if (!site) return { allowed: false, site };
    const customerId = fromBinOrNull(payment.customer_id);
    const owner = customerId ? await ownerOfCustomerAt(uow, customerId, input.at) : null;
    const access = await evaluateAccess(uow, {
      userId: input.author,
      permissionCode: input.permissionCode,
      occurredAt: input.at,
      resource: {
        ownerUserId: owner ?? fromBin(payment.received_by_user_id),
        siteId: site.id,
        zoneId: site.zoneId,
      },
    });
    return { allowed: access.allowed, site };
  }

  // --- sales.payment.reallocate ------------------------------------------------------------------------

  const reallocate: CommandHandler<ReallocatePayload> = async (uow, envelope) => {
    try {
      const p = envelope.payload;
      const author = envelope.author_user_id;
      const at = new Date(envelope.occurred_at);
      if (envelope.captured_offline) return ONLINE_REQUIRED;
      const release = p.release ?? [];
      const allocate = p.allocate ?? [];
      if (release.length === 0 && allocate.length === 0) {
        return rejected('NOTHING_TO_UPDATE', 'Aucune affectation à libérer ni à créer.');
      }
      if (hasDuplicateTarget(release) || hasDuplicateTarget(allocate)) {
        return rejected('ALLOCATION_INVALID', 'Une même cible est citée deux fois.');
      }
      const locked = await lockTargets(uow, [...release, ...allocate]);
      // Affectations puis encaissement : l'ordre de l'annulation d'une vente (sale-cancellation.ts).
      const allActive = await lockActiveAllocations(uow, envelope.aggregate_id);
      const payment = await lockPayment(uow, envelope.aggregate_id);
      if (!payment) return NOT_FOUND;
      const access = await paymentAccess(uow, payment, {
        author,
        at,
        permissionCode: 'sales.payment.reallocate',
      });
      if (!access.allowed) return FORBIDDEN_SCOPE;
      if (payment.status !== 'RECORDED') {
        return rejected('PAYMENT_STATUS_INVALID', 'Seul un encaissement enregistré se réaffecte.');
      }
      if (payment.customer_id === null) {
        return rejected('ALLOCATION_INVALID', 'Un encaissement sans client ne se réaffecte pas.');
      }
      const accounts = await customerAccountsOf(uow, fromBin(payment.customer_id));
      if (!accounts) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');

      const deltas = newCounterDeltas();
      const freed = new Map<string, number>();
      let releasedXaf = 0;
      for (const target of release) {
        const active = allActive.filter((allocation) =>
          target.saleId !== undefined
            ? allocation.saleId === target.saleId
            : allocation.orderId === target.orderId,
        );
        const activeXaf = active.reduce((sum, allocation) => sum + allocation.amountXaf, 0);
        if (target.amountXaf > activeXaf) {
          return rejected(
            'ALLOCATION_EXCEEDS',
            'Libération supérieure à ce que l’encaissement a affecté à cette cible.',
          );
        }
        const released = await releaseAllocations(
          uow,
          deps,
          {
            allocations: active,
            amountXaf: target.amountXaf,
            cause: 'REALLOCATED',
            reversedAt: at,
            paymentId: envelope.aggregate_id,
            actorUserId: author,
            commandId: envelope.command_id,
          },
          deltas,
        );
        freed.set(targetKey(target), (freed.get(targetKey(target)) ?? 0) + released);
        releasedXaf += released;
      }
      const creditXaf = Number(payment.unallocated_xaf) + releasedXaf;
      const checked = await checkTargets(uow, {
        targets: allocate,
        locked,
        accounts,
        offline: false,
        availableXaf: creditXaf,
        freedXaf: freed,
      });
      if (!checked.ok) return checked.outcome;
      await insertAllocations(
        uow,
        deps,
        {
          paymentId: envelope.aggregate_id,
          allocations: checked.allocations,
          allocatedAt: at,
          actorUserId: author,
          commandId: envelope.command_id,
        },
        deltas,
      );
      await applyCounterDeltas(uow, deltas);
      const allocatedXaf = checked.allocations.reduce((sum, a) => sum + a.amountXaf, 0);
      await uow
        .updateTable('sales_customer_payments')
        .set({
          unallocated_xaf: creditXaf - allocatedXaf,
          updated_by: toBin(author),
        })
        .where('id', '=', payment.id)
        .execute();
      return { status: 'APPLIED', serverRefs: { docNumber: payment.doc_number } };
    } catch (error) {
      return businessRejection(error);
    }
  };

  // --- sales.payment.refund ----------------------------------------------------------------------------

  const refund: CommandHandler<RefundPayload> = async (uow, envelope) => {
    try {
      const p = envelope.payload;
      const author = envelope.author_user_id;
      const at = new Date(envelope.occurred_at);
      if (envelope.captured_offline) return ONLINE_REQUIRED;
      const payment = await lockPayment(uow, envelope.aggregate_id);
      if (!payment) return NOT_FOUND;
      const access = await paymentAccess(uow, payment, {
        author,
        at,
        permissionCode: 'sales.payment.refund',
      });
      if (!access.allowed) return FORBIDDEN_SCOPE;
      if (p.cashAccountId !== undefined && p.cashAccountId !== fromBin(payment.cash_account_id)) {
        // D09 §8 : un compte accessible — pas la caisse personnelle d'un autre utilisateur.
        const account = await findCashAccount(uow, p.cashAccountId);
        if (!account) return rejected('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');
        if (account.accountType === 'CAISSE_UTILISATEUR' && account.holderUserId !== author) {
          return rejected(
            'CASH_ACCOUNT_FORBIDDEN',
            'La caisse personnelle d’un autre utilisateur ne peut pas être décaissée.',
          );
        }
      }
      if (payment.status !== 'RECORDED') {
        return rejected('PAYMENT_STATUS_INVALID', 'Seul un encaissement enregistré se rembourse.');
      }
      if (p.amountXaf > Number(payment.unallocated_xaf)) {
        return rejected(
          'REFUND_EXCEEDS_CREDIT',
          'Le remboursement dépasse le crédit client non affecté de cet encaissement.',
        );
      }
      const origin = await loadCommandOrigin(uow, envelope.command_id);
      // BR-FIN-012 : en ligne, une sortie ne rend jamais négative une caisse physique.
      await recordCashMovement(uow, deps, {
        cashAccountId: p.cashAccountId ?? fromBin(payment.cash_account_id),
        direction: 'OUT',
        amountXaf: p.amountXaf,
        movementType: 'REFUND',
        sourceDocType: 'SALE_REFUND',
        sourceDocId: envelope.aggregate_id,
        occurredAt: at,
        createdBy: author,
        ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
        commandId: envelope.command_id,
        capturedOffline: false,
        allowNegative: false,
      });
      await uow
        .updateTable('sales_customer_payments')
        .set({
          unallocated_xaf: sql<number>`unallocated_xaf - ${p.amountXaf}`,
          refunded_xaf: sql<number>`refunded_xaf + ${p.amountXaf}`,
          updated_by: toBin(author),
        })
        .where('id', '=', payment.id)
        .execute();
      return { status: 'APPLIED', serverRefs: { docNumber: payment.doc_number } };
    } catch (error) {
      return businessRejection(error);
    }
  };

  // --- sales.payment.request_cancellation ---------------------------------------------------------------

  const requestCancellation: CommandHandler<RequestCancellationPayload> = async (uow, envelope) => {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    if (p.reasonCodeId === undefined && p.comment === undefined) {
      return rejected('REASON_REQUIRED', 'Motif ou commentaire obligatoire.');
    }
    if (p.reasonCodeId !== undefined && !(await findReasonCode(uow, p.reasonCodeId))) {
      return rejected('REFERENCE_INVALID', 'Motif d’annulation inconnu.');
    }
    const payment = await lockPayment(uow, envelope.aggregate_id);
    if (!payment) return NOT_FOUND;
    const access = await paymentAccess(uow, payment, {
      author,
      at,
      permissionCode: 'sales.payment.record',
    });
    if (!access.allowed || !access.site) return FORBIDDEN_SCOPE;
    if (payment.status === 'CANCELLED') {
      return rejected('PAYMENT_ALREADY_CANCELLED', 'Cet encaissement est déjà annulé.');
    }
    // Une demande retirée (`approvals.request.withdraw` : `CANCELLED`, sans gestionnaire) ne bloque pas une
    // nouvelle demande : seule une demande encore en attente l'interdit.
    const pendingRequest =
      payment.status === 'CANCELLATION_REQUESTED' && payment.cancel_approval_request_id
        ? await uow
            .selectFrom('approvals_approval_requests')
            .select('status')
            .where('id', '=', payment.cancel_approval_request_id)
            .executeTakeFirst()
        : undefined;
    const requestable =
      payment.status === 'RECORDED' ||
      (payment.status === 'CANCELLATION_REQUESTED' &&
        pendingRequest !== undefined &&
        pendingRequest.status !== 'PENDING');
    if (!requestable) {
      return rejected(
        'PAYMENT_STATUS_INVALID',
        'Seul un encaissement enregistré s’annule (une demande est peut-être déjà en cours).',
      );
    }
    if (Number(payment.refunded_xaf) > 0) {
      return rejected(
        'PAYMENT_PARTIALLY_REFUNDED',
        'Encaissement en partie remboursé : son annulation n’est pas prise en charge.',
      );
    }
    const policy = await activePolicy(uow, 'PAYMENT_CANCELLATION', at);
    if (!policy) return CONTROL_POLICY_MISSING('PAYMENT_CANCELLATION');
    const requestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId,
      operationType: 'PAYMENT_CANCELLATION',
      subjectType: 'CUSTOMER_PAYMENT',
      subjectId: envelope.aggregate_id,
      subjectSummary: `Annulation de l’encaissement ${payment.doc_number} (${payment.amount_xaf} XAF)${
        p.comment ? ` : ${p.comment}` : ''
      }`,
      siteId: access.site.id,
      zoneId: access.site.zoneId,
      amountXaf: Number(payment.amount_xaf),
      requestedBy: author,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('sales_customer_payments')
      .set({
        status: 'CANCELLATION_REQUESTED',
        cancel_reason_code_id: toBinOrNull(p.reasonCodeId ?? null),
        cancel_comment: p.comment ?? null,
        cancel_approval_request_id: toBin(requestId),
        updated_by: toBin(author),
      })
      .where('id', '=', payment.id)
      .execute();
    return { status: 'APPLIED', serverRefs: { docNumber: payment.doc_number } };
  };

  return { record, reallocate, refund, requestCancellation, checkTargets };
}

// --- Décisions de la Finance -------------------------------------------------------------------------

/** Cibles saisies avec un encaissement mis de côté (détails du conflit `PAYMENT_REFERENCE_DUPLICATE`). */
function requestedTargets(details: unknown): TargetInput[] {
  const raw = (details as { allocations?: unknown } | null)?.allocations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): TargetInput[] => {
    const target = entry as { saleId?: unknown; orderId?: unknown; amountXaf?: unknown };
    const amountXaf = typeof target.amountXaf === 'number' ? target.amountXaf : 0;
    if (amountXaf <= 0) return [];
    if (typeof target.saleId === 'string') return [{ saleId: target.saleId, amountXaf }];
    if (typeof target.orderId === 'string') return [{ orderId: target.orderId, amountXaf }];
    return [];
  });
}

function refuse(outcome: CommandHandlerOutcome): never {
  const refusal = outcome.status === 'REJECTED' ? outcome : undefined;
  throw new ApprovalDecisionRefused(
    refusal?.errorCode ?? 'DECISION_REFUSED',
    refusal?.messageFr ?? 'Décision impossible.',
  );
}

function registerDecisions(
  decisionRegistry: SalesDecisionRegistry,
  idGenerator: IdGenerator,
  handlers: ReturnType<typeof buildHandlers>,
): void {
  const deps = { idGenerator };

  // BR-FIN-006 : annulation validée → trésorerie inverse, affectations renversées, créances rouvertes.
  decisionRegistry.register('PAYMENT_CANCELLATION', async (uow, ctx) => {
    const active = await uow
      .selectFrom('sales_payment_allocations')
      .select(['sale_id', 'order_id'])
      .where('payment_id', '=', toBin(ctx.subjectId))
      .where('status', '=', 'ACTIVE')
      .execute();
    await lockTargets(
      uow,
      active.map((row) =>
        row.sale_id ? { saleId: fromBin(row.sale_id) } : { orderId: fromBin(row.order_id!) },
      ),
    );
    // Affectations puis encaissement : l'ordre de l'annulation d'une vente (sale-cancellation.ts).
    const allocations = await lockActiveAllocations(uow, ctx.subjectId);
    const payment = await lockPayment(uow, ctx.subjectId);
    if (!payment) throw new ApprovalDecisionRefused('NOT_FOUND', 'Encaissement introuvable.');
    if (payment.status !== 'CANCELLATION_REQUESTED') {
      throw new ApprovalDecisionRefused(
        'PAYMENT_STATUS_INVALID',
        'Aucune demande d’annulation en cours sur cet encaissement.',
      );
    }
    if (ctx.decision === 'REJECTED') {
      await uow
        .updateTable('sales_customer_payments')
        .set({
          status: 'RECORDED',
          cancel_reason_code_id: null,
          cancel_comment: null,
          cancel_approval_request_id: null,
          updated_by: toBin(ctx.decidedBy),
        })
        .where('id', '=', payment.id)
        .execute();
      return;
    }
    // Une part a pu être remboursée depuis la demande (annulation d'une vente ou d'une commande
    // avec le sort REFUND) : l'inverse du mouvement d'origine la ferait sortir une seconde fois.
    if (Number(payment.refunded_xaf) > 0) {
      throw new ApprovalDecisionRefused(
        'PAYMENT_PARTIALLY_REFUNDED',
        'Une part de l’encaissement a été remboursée depuis la demande : rejeter la demande (AV-151).',
      );
    }
    try {
      const deltas = newCounterDeltas();
      await releaseAllocations(
        uow,
        deps,
        {
          allocations,
          amountXaf: allocations.reduce((sum, allocation) => sum + allocation.amountXaf, 0),
          cause: 'PAYMENT_CANCELLED',
          reversedAt: ctx.decidedAt,
          paymentId: ctx.subjectId,
          actorUserId: ctx.decidedBy,
          commandId: null,
        },
        deltas,
      );
      await applyCounterDeltas(uow, deltas);
      // Correction, non sortie physique : appliquée même si la caisse passe en négatif ou si le
      // compte a été désactivé depuis (DÉDUIT, D09 §15).
      await recordCashMovement(uow, deps, {
        cashAccountId: fromBin(payment.cash_account_id),
        direction: 'OUT',
        amountXaf: Number(payment.amount_xaf),
        movementType: 'CUSTOMER_PAYMENT',
        sourceDocType: 'CUSTOMER_PAYMENT',
        sourceDocId: ctx.subjectId,
        occurredAt: ctx.decidedAt,
        createdBy: ctx.decidedBy,
        allowNegative: true,
        reversesMovementId: fromBin(payment.cash_movement_id!),
      });
    } catch (error) {
      throw refusalOf(error);
    }
    await uow
      .updateTable('sales_customer_payments')
      .set({
        status: 'CANCELLED',
        unallocated_xaf: 0,
        cancelled_at: ctx.decidedAt,
        cancelled_by: toBin(ctx.decidedBy),
        updated_by: toBin(ctx.decidedBy),
      })
      .where('id', '=', payment.id)
      .execute();
  });

  // BR-FIN-005, AV-135 : doublon suspect approuvé (référence corrigée, ou libre) ou rejeté.
  decisionRegistry.register('PAYMENT_DUPLICATE', async (uow, ctx) => {
    const head = await uow
      .selectFrom('sales_customer_payments')
      .select(['customer_id'])
      .where('id', '=', toBin(ctx.subjectId))
      .executeTakeFirst();
    const details = await latestConflictDetails(uow, {
      conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
      entityId: ctx.subjectId,
    });
    // Les cibles et montants saisis sont rejoués ; à défaut (affectation automatique), les ventes
    // ouvertes du client, de l'échéance la plus ancienne à la plus récente (BR-FIN-004).
    const requested = requestedTargets(details);
    const customerId = head ? fromBinOrNull(head.customer_id) : null;
    const accounts = customerId ? await customerAccountsOf(uow, customerId) : undefined;
    const autoSaleIds =
      requested.length === 0 && accounts ? await openSaleIdsOf(uow, accounts.accountIds) : [];
    const locked = await lockTargets(
      uow,
      requested.length > 0 ? requested : autoSaleIds.map((saleId) => ({ saleId })),
    );
    const payment = await lockPayment(uow, ctx.subjectId);
    if (!payment) throw new ApprovalDecisionRefused('NOT_FOUND', 'Encaissement introuvable.');
    if (payment.status !== 'SUSPECT_DUPLICATE') {
      throw new ApprovalDecisionRefused(
        'PAYMENT_STATUS_INVALID',
        'Cet encaissement n’est pas en attente de décision.',
      );
    }
    if (ctx.decision === 'REJECTED') {
      await uow
        .updateTable('sales_customer_payments')
        .set({ status: 'REJECTED', updated_by: toBin(ctx.decidedBy) })
        .where('id', '=', payment.id)
        .execute();
      await resolveOpenConflicts(uow, {
        conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
        entityType: 'CUSTOMER_PAYMENT',
        entityIds: [ctx.subjectId],
        resolution: 'KEEP_SERVER',
        resolvedBy: ctx.decidedBy,
        resolvedAt: ctx.decidedAt,
      });
      return;
    }

    const corrected = ctx.decisionData?.['correctedReference']?.trim();
    if (corrected !== undefined && corrected.length > MAX_REFERENCE_LENGTH) {
      throw new ApprovalDecisionRefused(
        'PAYMENT_REFERENCE_INVALID',
        `Référence corrigée trop longue (${MAX_REFERENCE_LENGTH} caractères au plus).`,
      );
    }
    const normalized =
      corrected !== undefined ? normalizePaymentReference(corrected) : payment.reference_normalized;
    if (normalized === null) {
      throw new ApprovalDecisionRefused('PAYMENT_REFERENCE_REQUIRED', 'Référence corrigée vide.');
    }
    // Lecture verrouillante : une saisie concurrente de la même référence attend la décision.
    const taken = await uow
      .selectFrom('sales_customer_payments')
      .select('id')
      .where('reference_key', '=', `${payment.payment_method_code}:${normalized}`)
      .forUpdate()
      .executeTakeFirst();
    if (taken) {
      throw new ApprovalDecisionRefused(
        'PAYMENT_REFERENCE_DUPLICATE',
        'Cette référence est déjà enregistrée : corriger la référence (decisionData.correctedReference) ou rejeter le doublon.',
      );
    }

    const amountXaf = Number(payment.amount_xaf);
    let allocations: PlannedAllocation[];
    if (requested.length > 0) {
      // Les cibles ont pu changer depuis la saisie : chacune dans la limite de son reste, le surplus
      // en crédit client (l'argent est reçu, il n'est jamais refusé).
      const checked = await handlers.checkTargets(uow, {
        targets: requested,
        locked,
        accounts,
        offline: true,
        availableXaf: amountXaf,
      });
      if (!checked.ok) refuse(checked.outcome);
      allocations = checked.allocations;
    } else {
      allocations = [
        ...planSaleAllocations(amountXaf, [...locked.sales.values()].sort(compareByDue))
          .allocations,
      ];
    }
    const unallocated = amountXaf - allocations.reduce((sum, a) => sum + a.amountXaf, 0);
    if (unallocated > 0 && customerId === null) {
      throw new ApprovalDecisionRefused(
        'ALLOCATION_EXCEEDS',
        'Les ventes anonymes visées sont déjà réglées : rejeter le doublon.',
      );
    }
    try {
      const movement = await recordCashMovement(uow, deps, {
        cashAccountId: fromBin(payment.cash_account_id),
        direction: 'IN',
        amountXaf,
        movementType: 'CUSTOMER_PAYMENT',
        sourceDocType: 'CUSTOMER_PAYMENT',
        sourceDocId: ctx.subjectId,
        occurredAt: payment.occurred_at,
        createdBy: ctx.decidedBy,
        allowNegative: true,
        pastFact: true,
      });
      await uow
        .updateTable('sales_customer_payments')
        .set({
          status: 'RECORDED',
          cash_movement_id: toBin(movement.movementId),
          unallocated_xaf: unallocated,
          ...(corrected !== undefined
            ? { external_reference: corrected, reference_normalized: normalized }
            : {}),
          updated_by: toBin(ctx.decidedBy),
        })
        .where('id', '=', payment.id)
        .execute();
    } catch (error) {
      throw refusalOf(error);
    }
    const deltas = newCounterDeltas();
    await insertAllocations(
      uow,
      deps,
      {
        paymentId: ctx.subjectId,
        allocations,
        allocatedAt: ctx.decidedAt,
        actorUserId: ctx.decidedBy,
        commandId: null,
      },
      deltas,
    );
    await applyCounterDeltas(uow, deltas);
    await resolveOpenConflicts(uow, {
      conflictType: 'PAYMENT_REFERENCE_DUPLICATE',
      entityType: 'CUSTOMER_PAYMENT',
      entityIds: [ctx.subjectId],
      resolution: 'ACCEPT_CLIENT',
      resolvedBy: ctx.decidedBy,
      resolvedAt: ctx.decidedAt,
      ...(corrected !== undefined ? { comment: `Référence corrigée : ${corrected}` } : {}),
    });
  });
}

export function registerPaymentCommands(
  baseRegistry: CommandHandlerRegistry,
  baseDecisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  // P4-11 : chaque commande publie ses changements (jeux `orders`, `sales_recent`, `customers`).
  const registry = withSalesChanges(baseRegistry);
  const decisionRegistry = withSalesDecisionChanges(baseDecisionRegistry);
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'sales.payment.record',
    version: 1,
    payloadSchema: recordSchema,
    permissionCode: 'sales.payment.record',
    handler: handlers.record,
  });
  registry.register({
    commandType: 'sales.payment.reallocate',
    version: 1,
    payloadSchema: reallocateSchema,
    permissionCode: 'sales.payment.reallocate',
    handler: handlers.reallocate,
  });
  registry.register({
    commandType: 'sales.payment.refund',
    version: 1,
    payloadSchema: refundSchema,
    permissionCode: 'sales.payment.refund',
    handler: handlers.refund,
  });
  registry.register({
    commandType: 'sales.payment.request_cancellation',
    version: 1,
    payloadSchema: requestCancellationSchema,
    permissionCode: 'sales.payment.record',
    handler: handlers.requestCancellation,
  });
  registerDecisions(decisionRegistry, idGenerator, handlers);
}
