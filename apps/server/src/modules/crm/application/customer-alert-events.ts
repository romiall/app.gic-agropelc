/**
 * Signal d'alerte `DUPLICATE_SUSPECTED` pour un compte client créé en doublon (P9-10 ; ADR-061 §2, §4 ;
 * D13 §7.1 ; BR-CRM-006, BR-CRM-007, AV-419). Détecteur **sur fait**, publié dans la transaction de
 * `crm.customer.create`, à côté du conflit informatif `DUPLICATE_CUSTOMER` : le conflit sert à la file de
 * traitement, l'alerte prévient le responsable commercial. Jamais un rejet (BR-SYN-007).
 *
 * - Seul le doublon créé **hors ligne** existe comme fait : en ligne, la création est refusée et rien n'est
 *   enregistré (BR-CRM-006). Le seul critère de comparaison est le téléphone principal normalisé.
 * - Le sujet est le **nouveau** compte (celui qui porte `duplicate_of_id`), jamais le compte d'origine ni la
 *   paire : deux doublons d'un même compte ont chacun leur alerte, et la clé reste celle d'un sujet simple
 *   (l'identifiant du compte), sans collision avec les encaissements et les réceptions du même type d'alerte.
 * - La charge utile ne porte ni téléphone, ni nom du compte d'origine : elle est conservée en entier avec
 *   l'alerte (ADR-061 §4, RC-07). Le nom du nouveau compte sert de référence lisible (aucun code client).
 * - La **fusion** (`crm.customer.merge`) met fin à l'état de doublon en attente et publie
 *   `CustomerDuplicateResolved` : pour le compte absorbé qui portait un `duplicate_of_id`, et pour le compte
 *   conservé dont le `duplicate_of_id` désignait l'absorbé.
 */
import { businessDayOf, type IdGenerator } from '@gic/domain';
import { publishDetectionEvent } from '../../../platform/events/detection-events.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

/** Vocabulaire du champ « Objet » partagé avec `sales` et `procurement` (message de l'alerte). */
export const DUPLICATE_KIND_CUSTOMER = 'Compte client';

/** Motif lisible du doublon (seul critère de comparaison : le téléphone principal). */
export const CUSTOMER_DUPLICATE_REASON_LABEL = 'Même numéro de téléphone principal';

export interface CustomerDuplicateSignal {
  /** Nouveau compte, porteur de `duplicate_of_id` : le sujet de l'alerte. */
  readonly customerId: string;
  readonly displayName: string;
  /** Compte déjà existant qui détient le même téléphone. */
  readonly existingCustomerId: string;
  readonly zoneId: string;
  readonly homeSiteId: string | null;
  /** Titulaire commercial du nouveau compte, absent pour un compte rattaché à un site. */
  readonly ownerUserId: string | null;
  readonly acquiredByUserId: string;
  /** Instant du fait (création hors ligne) : la détection est datée de l'application du fait. */
  readonly occurredAt: Date;
  readonly commandId: string;
  readonly capturedOffline: boolean;
}

export async function publishCustomerDuplicateSuspected(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  signal: CustomerDuplicateSignal,
): Promise<void> {
  await publishDetectionEvent(uow, idGenerator, {
    eventType: 'CustomerDuplicateSuspected',
    producerModule: 'crm',
    aggregateType: 'CUSTOMER',
    aggregateId: signal.customerId,
    occurredAt: signal.occurredAt,
    commandId: signal.commandId,
    payload: {
      kind: DUPLICATE_KIND_CUSTOMER,
      reference: signal.displayName,
      reason: 'SAME_PHONE',
      reason_label: CUSTOMER_DUPLICATE_REASON_LABEL,
      customer_id: signal.customerId,
      existing_customer_id: signal.existingCustomerId,
      zone_id: signal.zoneId,
      site_id: signal.homeSiteId,
      owner_user_id: signal.ownerUserId,
      acquired_by_user_id: signal.acquiredByUserId,
      business_day: businessDayOf(signal.occurredAt),
      captured_offline: signal.capturedOffline,
    },
  });
}

/**
 * Fin de l'état de doublon en attente d'un compte (fusion) : ferme l'alerte `DUPLICATE_SUSPECTED` du même
 * sujet. Sans effet si aucune alerte n'est ouverte pour ce compte.
 */
export async function publishCustomerDuplicateResolved(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  resolution: {
    readonly customerId: string;
    readonly keptCustomerId: string;
    readonly mergedCustomerId: string;
    readonly decidedBy: string;
    readonly decidedAt: Date;
    readonly commandId: string;
  },
): Promise<void> {
  await publishDetectionEvent(uow, idGenerator, {
    eventType: 'CustomerDuplicateResolved',
    producerModule: 'crm',
    aggregateType: 'CUSTOMER',
    aggregateId: resolution.customerId,
    occurredAt: resolution.decidedAt,
    commandId: resolution.commandId,
    payload: {
      customer_id: resolution.customerId,
      resolution: 'MERGE',
      kept_customer_id: resolution.keptCustomerId,
      merged_customer_id: resolution.mergedCustomerId,
      decided_by: resolution.decidedBy,
    },
  });
}
