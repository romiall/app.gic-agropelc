/**
 * Signal d'alerte `PRICE_MISMATCH` (INFO ; P9-07 ; ADR-061 §2, §4 ; D13 §7.1, BR-VEN-029, AV-395) : le
 * prix figé par l'appareil hors ligne diffère du prix que le serveur aurait résolu à la date du fait. La
 * vente directe et la commande saisies hors ligne sont appliquées telles quelles (jamais un rejet,
 * BR-SYN-007) ; le conflit de synchronisation sert à la file de traitement, l'alerte prévient le
 * responsable commercial. Un événement par document (la première ligne en écart porte le message, le
 * détail suit, 100 lignes au plus), publié dans la transaction de la commande : rien d'autre n'est écrit.
 */
import { businessDayOf, type IdGenerator } from '@gic/domain';
import { publishDetectionEvent } from '../../../../platform/events/detection-events.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';

/** Détail d'une ligne en écart (clés de la charge utile, snake_case). */
export interface PriceMismatchLine {
  readonly lineId: string;
  readonly productId: string;
  readonly productLabel: string;
  readonly appliedPriceXaf: number;
  /** Prix que le serveur aurait résolu à la date du fait ; `null` si aucune règle n'était en vigueur. */
  readonly expectedPriceXaf: number | null;
  /** Prix catalogue déclaré par l'appareil ; `null` si l'appareil n'en déclarait pas. */
  readonly declaredListPriceXaf: number | null;
}

export interface PriceMismatchSignal {
  /** Document concerné : la vente directe ou la commande. */
  readonly documentType: 'SALE' | 'SALES_ORDER';
  readonly documentId: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly zoneId: string | null;
  readonly lines: readonly PriceMismatchLine[];
  readonly sellerUserId: string;
  readonly commercialUserId: string | null;
  readonly capturedOffline: boolean;
  readonly occurredAt: Date;
  readonly commandId: string;
}

const DETAILED_LINES = 100;

export async function publishPriceMismatchDetected(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  signal: PriceMismatchSignal,
): Promise<void> {
  const [first] = signal.lines;
  if (first === undefined) return;
  await publishDetectionEvent(uow, idGenerator, {
    eventType: 'PriceMismatchDetected',
    producerModule: 'sales',
    aggregateType: signal.documentType,
    aggregateId: signal.documentId,
    occurredAt: signal.occurredAt,
    commandId: signal.commandId,
    payload: {
      // `sale_id` ou `order_id` selon le document (le sujet de l'alerte est l'agrégat de l'événement).
      ...(signal.documentType === 'SALE'
        ? { sale_id: signal.documentId }
        : { order_id: signal.documentId }),
      document_type: signal.documentType,
      doc_number: signal.docNumber,
      site_id: signal.siteId,
      zone_id: signal.zoneId,
      product_id: first.productId,
      product_label: first.productLabel,
      applied_price_xaf: first.appliedPriceXaf,
      expected_price_xaf: first.expectedPriceXaf,
      declared_list_price_xaf: first.declaredListPriceXaf,
      lines_count: signal.lines.length,
      lines: signal.lines.slice(0, DETAILED_LINES).map((line) => ({
        line_id: line.lineId,
        product_id: line.productId,
        product_label: line.productLabel,
        applied_price_xaf: line.appliedPriceXaf,
        expected_price_xaf: line.expectedPriceXaf,
        declared_list_price_xaf: line.declaredListPriceXaf,
      })),
      seller_user_id: signal.sellerUserId,
      commercial_user_id: signal.commercialUserId,
      captured_offline: signal.capturedOffline,
      business_day: businessDayOf(signal.occurredAt),
    },
  });
}
