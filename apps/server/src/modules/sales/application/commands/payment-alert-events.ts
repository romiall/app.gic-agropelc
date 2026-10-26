/**
 * Signal d'alerte `DUPLICATE_SUSPECTED` pour un encaissement signalé en doublon (P9-07 ; ADR-061 §2, §4 ;
 * D13 §7.1 ; BR-FIN-005, BR-FIN-006). Un événement par encaissement signalé, publié dans la transaction
 * de la commande, à côté du conflit de synchronisation : le conflit sert à la file de traitement, l'alerte
 * prévient la Finance. Jamais un rejet (BR-SYN-007) : la publication n'écrit rien d'autre.
 *
 * Deux familles sous un même type (le champ `reason` les distingue) :
 * - `SAME_REFERENCE` : référence déjà vue (mis de côté, sans trésorerie, décision `PAYMENT_DUPLICATE`) ;
 * - `PROBABLE_SAME_AMOUNT` : même montant dans la fenêtre (appliqué, simple signalement).
 *
 * Le sujet est l'encaissement suspect, jamais l'encaissement d'origine : deux alertes ne se confondent pas.
 */
import { businessDayOf, type IdGenerator } from '@gic/domain';
import { publishDetectionEvent } from '../../../../platform/events/detection-events.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';

/** Vocabulaire du champ « Objet » partagé avec `crm` et `procurement` (message de l'alerte). */
export const DUPLICATE_KIND_PAYMENT = 'Encaissement';

export interface PaymentDuplicateSignal {
  readonly paymentId: string;
  readonly docNumber: string;
  readonly reason: 'SAME_REFERENCE' | 'PROBABLE_SAME_AMOUNT';
  /** Encaissement d'origine (référence identique) ou encaissement semblable (montant identique). */
  readonly otherPaymentId: string | null;
  readonly methodCode: string;
  readonly amountXaf: number;
  readonly externalReference: string | null;
  readonly customerId: string | null;
  readonly saleId?: string | null;
  readonly orderId?: string | null;
  readonly receivedByUserId: string;
  readonly siteId: string;
  readonly zoneId: string | null;
  readonly occurredAt: Date;
  readonly commandId: string;
  readonly capturedOffline: boolean;
}

/**
 * Décision de la Finance sur un encaissement en doublon (approuvé ou rejeté) : résout l'alerte
 * `DUPLICATE_SUSPECTED` du même sujet, qui sans cela resterait ouverte (une seule file à traiter).
 */
export async function publishPaymentDuplicateDecided(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  decision: {
    readonly paymentId: string;
    readonly decision: 'APPROVED' | 'REJECTED';
    readonly decidedBy: string;
    readonly decidedAt: Date;
  },
): Promise<void> {
  await publishDetectionEvent(uow, idGenerator, {
    eventType: 'PaymentDuplicateDecided',
    producerModule: 'sales',
    aggregateType: 'CUSTOMER_PAYMENT',
    aggregateId: decision.paymentId,
    occurredAt: decision.decidedAt,
    payload: {
      payment_id: decision.paymentId,
      decision: decision.decision,
      decided_by: decision.decidedBy,
    },
  });
}

export async function publishPaymentFlaggedDuplicate(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  signal: PaymentDuplicateSignal,
): Promise<void> {
  await publishDetectionEvent(uow, idGenerator, {
    eventType: 'PaymentFlaggedDuplicate',
    producerModule: 'sales',
    aggregateType: 'CUSTOMER_PAYMENT',
    aggregateId: signal.paymentId,
    occurredAt: signal.occurredAt,
    commandId: signal.commandId,
    payload: {
      kind: DUPLICATE_KIND_PAYMENT,
      reference: signal.docNumber,
      payment_id: signal.paymentId,
      reason: signal.reason,
      ...(signal.reason === 'SAME_REFERENCE'
        ? { duplicate_of_payment_id: signal.otherPaymentId }
        : { similar_payment_id: signal.otherPaymentId }),
      method_code: signal.methodCode,
      amount_xaf: signal.amountXaf,
      external_reference: signal.externalReference,
      customer_id: signal.customerId,
      sale_id: signal.saleId ?? null,
      order_id: signal.orderId ?? null,
      received_by_user_id: signal.receivedByUserId,
      site_id: signal.siteId,
      zone_id: signal.zoneId,
      business_day: businessDayOf(signal.occurredAt),
      captured_offline: signal.capturedOffline,
    },
  });
}
