/**
 * `finance.cash_sessions.open_long_check` (P5-12 ; BR-DIS-006 : « une session ouverte depuis plus de
 * 24 h déclenche une alerte » ; D13 `CASH_SESSION_OPEN_LONG` ; P9-07 : passe de détection à identité,
 * ADR-061 §3). Publie un événement `CashSessionOpenLongDetected` par session **ouverte** depuis plus de
 * `finance.cash_session_force_close_hours` (réglage du site, à défaut global, à défaut 24), puis le
 * marqueur de fin de passe : l'alerte d'état se résout seule quand la session n'est plus revue (clôture
 * ordinaire ou d'office). Aucune session n'est modifiée : la clôture d'office reste une décision de la
 * Finance (`finance.cash_session.force_close`).
 *
 * La tâche est horaire (le seuil se compte en heures) : un événement par session et **par passe** ;
 * le compteur d'occurrences de l'alerte compte des heures, sans renotification. Un rejeu du même
 * créneau ne republie rien (identifiants d'événement dérivés de la passe).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  cashSessionOpenLongerThan,
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
import { cashSetting } from '../cash-session-ledger.js';

export const CASH_SESSION_OPEN_LONG_JOB_TYPE = 'finance.cash_sessions.open_long_check';

/** Seuil par défaut si le paramètre manque ou est invalide (seed P5-03). */
const DEFAULT_HOURS = 24;

@Injectable()
export class CashSessionOpenLongJob implements OnModuleInit {
  private readonly logger = new Logger(CashSessionOpenLongJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CASH_SESSION_OPEN_LONG_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('CASH_SESSION_OPEN_LONG', passSlotOf(payload, now));
      // Sessions ouvertes (une par caisse de PDV au plus, INV-FIN-06) ; le seuil se lit par site.
      const candidates = await uow
        .selectFrom('finance_cash_sessions')
        .select(['id', 'cash_account_id', 'site_id', 'opened_by', 'opened_at'])
        .where('status', '=', 'OPEN')
        .where('opened_at', '<', now)
        .orderBy('opened_at')
        .execute();
      let published = 0;
      for (const session of candidates) {
        const siteId = fromBin(session.site_id);
        const setting = await cashSetting(uow, 'forceCloseHours', siteId, now);
        const thresholdHours = Number.isFinite(setting) && setting > 0 ? setting : DEFAULT_HOURS;
        if (!cashSessionOpenLongerThan(session.opened_at, now, thresholdHours)) continue;
        const sessionId = fromBin(session.id);
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'CashSessionOpenLongDetected',
          producerModule: 'finance',
          aggregateType: 'CASH_SESSION',
          aggregateId: sessionId,
          occurredAt: now,
          passId,
          payload: {
            session_id: sessionId,
            cash_account_id: fromBin(session.cash_account_id),
            site_id: siteId,
            opened_by: fromBin(session.opened_by),
            opened_at: session.opened_at.toISOString(),
            hours_open: Math.floor((now.getTime() - session.opened_at.getTime()) / 3_600_000),
            threshold_hours: thresholdHours,
            business_day: today,
          },
        });
        if (inserted) published += 1;
      }
      // Passe complète : une session close depuis la passe précédente n'est plus revue, donc résolue.
      await publishPassCompleted(uow, {
        producerModule: 'finance',
        alertType: 'CASH_SESSION_OPEN_LONG',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(`Sessions de caisse ouvertes trop longtemps (${today}) : ${published}.`);
    });
  }
}
