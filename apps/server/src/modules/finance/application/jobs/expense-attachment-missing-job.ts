/**
 * `finance.expenses.attachment_missing_check` (P9-07 ; D13 §7.1 `ATTACHMENT_MISSING`, BR-FIN-020 :
 * justificatif exigé au-delà du seuil ; AV-357, AV-399). Passe de détection quotidienne à identité et
 * **portée `EXPENSE`** (ADR-061 §3 ; les réceptions sans photo ont leur propre passe, P9-09) : publie un
 * événement `AttachmentMissingDetected` par dépense dont le justificatif n'est toujours pas disponible
 * après `attachments.missing_alert_days` jours (7), puis le marqueur de fin de passe de sa portée, qui
 * résout les alertes des dépenses revues en règle (pièce arrivée, dépense annulée ou rejetée) ou sorties
 * de l'horizon. **0 jour désactive l'alerte** : la passe ne publie aucun sujet mais publie son marqueur,
 * donc les alertes ouvertes au moment de la désactivation se ferment (aucune ne reste sans issue).
 *
 * - **Dépenses examinées** : non annulées ni rejetées, au-dessus du seuil de justificatif
 *   (`finance.expense_photo_threshold_xaf`, lu à la date de la dépense : réglage historisé), reçues par le
 *   serveur depuis au moins N jours et au plus `attachments.missing_alert_horizon_days` jours (90 ;
 *   borne le balayage, au moins un jour de plus que le délai, AV-399). Une dépense qui sort de
 *   l'horizon sans pièce n'est plus revue : son alerte se ferme à la passe suivante (décision d'AV-399).
 * - **Référence du délai** (AV-399, DÉDUIT) : la réception par le serveur (`received_at_server`, à défaut
 *   la création), non la date du fait : une dépense hors ligne ancienne n'alerte pas dès sa synchronisation.
 * - **Présence** : une pièce `AVAILABLE` rattachée à la dépense (`owner_type = EXPENSE`), via l'API
 *   publique d'`attachments`. Une pièce déclarée mais jamais reçue (en attente, en quarantaine) compte
 *   comme absente : c'est le cas que l'alerte vise.
 * Aucune dépense n'est modifiée.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import {
  attachmentDaysMissing,
  attachmentMissingAlertDaysOrDefault,
  attachmentScanWindow,
  businessDayOf,
  expensePhotoRequired,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
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
import { hasAvailableAttachment } from '../../../attachments/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { expenseSettingsAt } from '../expense-support.js';

export const EXPENSE_ATTACHMENT_MISSING_JOB_TYPE = 'finance.expenses.attachment_missing_check';

/** Portée de la passe : les justificatifs de dépense (les réceptions sont une autre portée). */
export const EXPENSE_ATTACHMENT_SCOPE = 'EXPENSE';

/** Fenêtre de balayage partagée avec les réceptions (`packages/domain/src/attachment-alerts.ts`, P9-09). */
export { attachmentScanWindow };

/** États dont la dépense reste due d'un justificatif (SM-EXPENSE : ni annulée, ni rejetée). */
const LIVE_STATUSES = ['RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'PAID_PENDING_APPROVAL'];

@Injectable()
export class ExpenseAttachmentMissingJob implements OnModuleInit {
  private readonly logger = new Logger(ExpenseAttachmentMissingJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(EXPENSE_ATTACHMENT_MISSING_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const global = { scopeType: 'GLOBAL', scopeId: null, at: now } as const;
      const delayDays = attachmentMissingAlertDaysOrDefault(
        await currentSettingValue(uow, { key: 'attachments.missing_alert_days', ...global }),
      );
      const passId = detectionPassId(
        'ATTACHMENT_MISSING',
        passSlotOf(payload, now),
        EXPENSE_ATTACHMENT_SCOPE,
      );
      const complete = () =>
        publishPassCompleted(uow, {
          producerModule: 'finance',
          alertType: 'ATTACHMENT_MISSING',
          passId,
          scope: EXPENSE_ATTACHMENT_SCOPE,
          businessDay: today,
          occurredAt: now,
        });
      if (delayDays === 0) {
        // Désactivée (AV-357) : aucun sujet, mais une passe complète : les alertes déjà ouvertes se ferment.
        await complete();
        this.logger.log('Justificatifs de dépense manquants : alerte désactivée (0 jour).');
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
        .selectFrom('finance_expenses')
        .select([
          'id',
          'doc_number',
          'site_id',
          'created_by',
          'amount_xaf',
          'status',
          'review_reasons',
          'occurred_at',
          'received_at_server',
          'created_at',
        ])
        .where('status', 'in', LIVE_STATUSES)
        // Fenêtre de balayage : reçue depuis au moins N jours et au plus l'horizon (borne l'ensemble).
        .where(
          sql<boolean>`COALESCE(received_at_server, created_at) BETWEEN ${oldest} AND ${newest}`,
        )
        .orderBy('created_at')
        .execute();

      // Le seuil est historisé à l'instant : une lecture par instant de dépense distinct (jamais par jour,
      // un changement de réglage en cours de journée serait sinon ignoré).
      const thresholdAt = new Map<number, number>();
      const photoThresholdAt = async (at: Date): Promise<number> => {
        let value = thresholdAt.get(at.getTime());
        if (value === undefined) {
          value = (await expenseSettingsAt(uow, at)).photoThresholdXaf;
          thresholdAt.set(at.getTime(), value);
        }
        return value;
      };

      let published = 0;
      for (const expense of candidates) {
        const receivedAt = expense.received_at_server ?? expense.created_at;
        const amount = Number(expense.amount_xaf);
        if (!expensePhotoRequired(amount, await photoThresholdAt(expense.occurred_at))) continue;
        const expenseId = fromBin(expense.id);
        if (await hasAvailableAttachment(uow, { ownerType: 'EXPENSE', ownerId: expenseId }))
          continue;
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'AttachmentMissingDetected',
          producerModule: 'finance',
          aggregateType: 'EXPENSE',
          aggregateId: expenseId,
          occurredAt: now,
          passId,
          payload: {
            document_type: 'EXPENSE',
            document_id: expenseId,
            document_label: expense.doc_number,
            days_missing: attachmentDaysMissing(receivedAt, now),
            author_user_id: fromBin(expense.created_by),
            site_id: fromBin(expense.site_id),
            amount_xaf: amount,
            status: expense.status,
            review_reasons: expense.review_reasons,
            threshold_days: delayDays,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      await complete();
      this.logger.log(
        `Justificatifs de dépense manquants (${delayDays} j à ${horizonDays} j ; ${today}) : ${published}.`,
      );
    });
  }
}
