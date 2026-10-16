/**
 * `approvals.requests.pending_long_check` (P9-09 ; D13 §7.1 `APPROVAL_PENDING_LONG`, SM-APPROVAL « délai
 * de 24 h dépassé », AV-408, AV-466) : toutes les heures, publie un événement `ApprovalPendingLong` par
 * demande de validation **encore en attente depuis au moins `approvals.pending_long_hours` heures** (24),
 * puis le marqueur de fin de passe, qui résout les alertes des demandes décidées, retirées ou annulées
 * (y compris par une façade d'un module propriétaire, dont l'événement du pipeline ne désigne pas la demande).
 *
 * - **Référence du délai** : la réception par le serveur (`created_at`), non la date du fait
 *   (`requested_at`) : une demande saisie hors ligne puis synchronisée tard n'alerte pas dès sa
 *   synchronisation (AV-449, AV-466).
 * - **Destinataires** : la charge utile porte `approver_permission` (la politique figée sur la demande),
 *   `requester_user_id` et le périmètre (`site_id`, `zone_id`) : le consommateur résout les titulaires de la
 *   permission dans le périmètre du demandeur, demandeur exclu (ADR-072), et la Direction par la règle.
 * - **`escalated_at`** : posé **une fois**, par ce module et nulle part ailleurs, au premier constat du
 *   dépassement (SM-APPROVAL : « escaladée ») ; jamais remis à `NULL`, reste posé si le délai est relevé.
 *   La passe republie **toutes** les demandes en retard (y compris déjà escaladées), sinon son marqueur
 *   fermerait leur alerte.
 * - **Concurrence** : les demandes sont lues `FOR SHARE SKIP LOCKED` ; une demande verrouillée par une
 *   décision en cours est sautée (aucune attente, aucun interblocage), l'alerte d'une demande décidée
 *   entre deux passes n'est pas levée.
 * - **Valeurs au coût** : ni le résumé ni le montant de la demande n'entrent dans la charge utile (RC-05).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  approvalOperationLabel,
  approvalPendingHours,
  approvalPendingLongHoursOrDefault,
  businessDayOf,
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
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const APPROVAL_PENDING_LONG_JOB_TYPE = 'approvals.requests.pending_long_check';
export const APPROVAL_PENDING_LONG_HOURS_KEY = 'approvals.pending_long_hours';

@Injectable()
export class ApprovalPendingLongJob implements OnModuleInit {
  private readonly logger = new Logger(ApprovalPendingLongJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(APPROVAL_PENDING_LONG_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const hours = approvalPendingLongHoursOrDefault(
        await currentSettingValue(uow, {
          key: APPROVAL_PENDING_LONG_HOURS_KEY,
          scopeType: 'GLOBAL',
          scopeId: null,
          at: now,
        }),
      );
      const passId = detectionPassId('APPROVAL_PENDING_LONG', passSlotOf(payload, now));
      const cutoff = new Date(now.getTime() - hours * 3_600_000);

      // Jointure externe : la politique d'une demande est nullable (aucune permission : pas d'approbateur
      // désigné, seule la règle de la Direction s'applique).
      const pending = await uow
        .selectFrom('approvals_approval_requests as r')
        .leftJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
        .select([
          'r.id',
          'r.operation_type',
          'r.subject_type',
          'r.subject_id',
          'r.site_id',
          'r.zone_id',
          'r.requested_by',
          'r.requested_at',
          'r.created_at',
          'r.escalated_at',
          'p.approver_permission',
          'p.approver_scope',
        ])
        .where('r.status', '=', 'PENDING')
        .where('r.created_at', '<=', cutoff)
        .orderBy('r.created_at', 'asc')
        .orderBy('r.id', 'asc')
        .forShare()
        .skipLocked()
        .execute();

      let published = 0;
      let escalated = 0;
      for (const request of pending) {
        const requestId = fromBin(request.id);
        const siteId = fromBinOrNull(request.site_id);
        const zoneId = fromBinOrNull(request.zone_id);
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'ApprovalPendingLong',
          producerModule: 'approvals',
          aggregateType: 'APPROVAL_REQUEST',
          aggregateId: requestId,
          occurredAt: now,
          passId,
          payload: {
            request_id: requestId,
            operation_type: request.operation_type,
            operation_label: approvalOperationLabel(request.operation_type),
            hours_pending: approvalPendingHours(request.created_at, now),
            threshold_hours: hours,
            approver_permission: request.approver_permission,
            approver_scope: request.approver_scope,
            requester_user_id: fromBin(request.requested_by),
            subject_type: request.subject_type,
            subject_id: fromBin(request.subject_id),
            requested_at: request.requested_at.toISOString(),
            escalated: request.escalated_at !== null,
            business_day: today,
            ...(siteId !== null ? { site_id: siteId } : {}),
            ...(zoneId !== null ? { zone_id: zoneId } : {}),
          },
        });
        if (inserted) published += 1;
        if (request.escalated_at === null) {
          // Posé une fois : la clause `escalated_at IS NULL` rend l'écriture idempotente au rejeu.
          const result = await uow
            .updateTable('approvals_approval_requests')
            .set({ escalated_at: now })
            .where('id', '=', toBin(requestId))
            .where('status', '=', 'PENDING')
            .where('escalated_at', 'is', null)
            .executeTakeFirst();
          escalated += Number(result.numUpdatedRows ?? 0);
        }
      }
      await publishPassCompleted(uow, {
        producerModule: 'approvals',
        alertType: 'APPROVAL_PENDING_LONG',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Validations en attente depuis ${hours} h : ${published} signalée(s), ${escalated} escaladée(s) ; ${pending.length} examinée(s).`,
      );
    });
  }
}
