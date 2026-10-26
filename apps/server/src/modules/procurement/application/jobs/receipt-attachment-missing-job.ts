/**
 * `procurement.receipts.attachment_missing_check` (P9-09 ; D13 §7.1 `ATTACHMENT_MISSING`, BR-APP-014,
 * AV-285, AV-357, AV-399, AV-417) : la part « réceptions » de l'alerte de pièce manquante, chaque jour à
 * 06:15 ; passe à identité de **portée `GOODS_RECEIPT`** (la part « dépenses » de `finance` a la sienne :
 * le marqueur d'une portée ne résout que les alertes de sa portée, ADR-061 §3). Publie un événement
 * `AttachmentMissingDetected` par réception dont la photo du bon de livraison, exigée, n'est toujours pas
 * disponible après `attachments.missing_alert_days` jours (7), puis le marqueur de fin de passe, qui
 * résout les alertes des réceptions revues en règle (pièce arrivée, réception annulée ou rejetée) ou sorties
 * de l'horizon (`attachments.missing_alert_horizon_days`, 90). **0 jour désactive l'alerte** : aucun sujet,
 * mais le marqueur ferme les alertes ouvertes.
 *
 * - **Exigence** : la règle de BR-APP-014 est recalculée (`receiptPhotoRequired` : réception sans BC, ou
 *   valeur acceptée au moins égale à `procurement.receipt_photo_threshold_xaf` lu à la date de la
 *   réception, réglage historisé) ; l'exigence n'est pas mémorisée sur la réception. Une réception dont la
 *   photo est **déclarée mais jamais reçue** (aucun conflit `RECEIPT_PHOTO_MISSING`) est le cas visé.
 * - **Présence** : une pièce `AVAILABLE` de nature `DELIVERY_NOTE` rattachée à la réception (même
 *   critère que la régularisation du conflit, AV-285). L'auteur de la pièce n'est pas contrôlé (AV-417).
 * - **Délai** : depuis la réception par le serveur (`received_at_server`, à défaut la création), non la date
 *   du fait : une réception hors ligne ancienne n'alerte pas dès sa synchronisation.
 * - **Réceptions examinées** : comptabilisées, en revue, en quarantaine ou en annulation demandée ; ni
 *   rejetées (stock jamais entré), ni annulées, ni refusées en revue.
 * Aucune réception n'est modifiée.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import {
  attachmentDaysMissing,
  attachmentMissingAlertDaysOrDefault,
  attachmentScanWindow,
  businessDayOf,
  receiptPhotoRequired,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasAvailableAttachment } from '../../../attachments/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { numberSetting } from '../commands/shared.js';

export const RECEIPT_ATTACHMENT_MISSING_JOB_TYPE = 'procurement.receipts.attachment_missing_check';

/** Portée de la passe : les photos de réception (les justificatifs de dépense sont une autre portée). */
export const RECEIPT_ATTACHMENT_SCOPE = 'GOODS_RECEIPT';

/** Repli du seuil de photo (BR-APP-014, AV-037) : 100 000 XAF. */
export const DEFAULT_RECEIPT_PHOTO_THRESHOLD_XAF = 100_000;

/** Réceptions dont le stock est entré ou en attente de décision : une photo reste due. */
const REVIEWED_STATUSES = [
  'POSTED',
  'POSTED_PENDING_REVIEW',
  'QUARANTINED',
  'CANCELLATION_PENDING',
];

@Injectable()
export class ReceiptAttachmentMissingJob implements OnModuleInit {
  private readonly logger = new Logger(ReceiptAttachmentMissingJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(RECEIPT_ATTACHMENT_MISSING_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const global = { scopeType: 'GLOBAL', scopeId: null, at: now } as const;
      const delayDays = attachmentMissingAlertDaysOrDefault(
        await currentSettingValue(uow, { key: 'attachments.missing_alert_days', ...global }),
      );
      const passId = detectionPassId(
        'ATTACHMENT_MISSING',
        passSlotOf(payload, now),
        RECEIPT_ATTACHMENT_SCOPE,
      );
      const complete = () =>
        publishPassCompleted(uow, {
          producerModule: 'procurement',
          alertType: 'ATTACHMENT_MISSING',
          passId,
          scope: RECEIPT_ATTACHMENT_SCOPE,
          businessDay: today,
          occurredAt: now,
        });
      if (delayDays === 0) {
        await complete();
        this.logger.log('Photos de réception manquantes : alerte désactivée (0 jour).');
        return;
      }
      const { horizonDays, newest, oldest } = attachmentScanWindow(
        now,
        delayDays,
        await currentSettingValue(uow, {
          key: 'attachments.missing_alert_horizon_days',
          ...global,
        }),
      );
      const candidates = await uow
        .selectFrom('procurement_goods_receipts')
        .select([
          'id',
          'doc_number',
          'site_id',
          'received_by',
          'purchase_order_id',
          'total_accepted_value_xaf',
          'status',
          'occurred_at',
          'received_at_server',
          'created_at',
        ])
        .where('status', 'in', REVIEWED_STATUSES)
        .where(
          sql<boolean>`COALESCE(received_at_server, created_at) BETWEEN ${oldest} AND ${newest}`,
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute();

      // Le seuil est historisé à l'instant : une lecture par instant de réception distinct.
      const thresholdAt = new Map<number, number>();
      const photoThresholdAt = async (at: Date): Promise<number> => {
        let value = thresholdAt.get(at.getTime());
        if (value === undefined) {
          // Même lecture que le gestionnaire de réception (`numberSetting` : nombre ou chaîne numérique).
          value = await numberSetting(
            uow,
            'procurement.receipt_photo_threshold_xaf',
            at,
            DEFAULT_RECEIPT_PHOTO_THRESHOLD_XAF,
          );
          thresholdAt.set(at.getTime(), value);
        }
        return value;
      };

      let published = 0;
      for (const receipt of candidates) {
        const receivedAt = receipt.received_at_server ?? receipt.created_at;
        const withoutOrder = receipt.purchase_order_id === null;
        const required = receiptPhotoRequired({
          withoutOrder,
          acceptedValueXaf: Number(receipt.total_accepted_value_xaf),
          thresholdXaf: await photoThresholdAt(receipt.occurred_at),
        });
        if (!required) continue;
        const receiptId = fromBin(receipt.id);
        if (
          await hasAvailableAttachment(uow, {
            ownerType: 'GOODS_RECEIPT',
            ownerId: receiptId,
            kind: 'DELIVERY_NOTE',
          })
        ) {
          continue;
        }
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'AttachmentMissingDetected',
          producerModule: 'procurement',
          aggregateType: 'GOODS_RECEIPT',
          aggregateId: receiptId,
          occurredAt: now,
          passId,
          payload: {
            document_type: 'GOODS_RECEIPT',
            document_id: receiptId,
            document_label: receipt.doc_number,
            days_missing: attachmentDaysMissing(receivedAt, now),
            author_user_id: fromBin(receipt.received_by),
            site_id: fromBin(receipt.site_id),
            status: receipt.status,
            without_order: withoutOrder,
            threshold_days: delayDays,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      await complete();
      this.logger.log(
        `Photos de réception manquantes (${delayDays} j à ${horizonDays} j ; ${today}) : ${published}.`,
      );
    });
  }
}
