/**
 * `finance.cash_sessions.open_long_check` (P5-12 ; BR-DIS-006 : « une session ouverte depuis plus de
 * 24 h déclenche une alerte » ; D13 `CASH_SESSION_OPEN_LONG`). Publie un événement
 * `CashSessionOpenLongDetected` par session **ouverte** depuis plus de
 * `finance.cash_session_force_close_hours` (réglage du site, à défaut global, à défaut 24), au plus un
 * par session et par jour métier (rejouable). Aucune session n'est modifiée : la clôture d'office reste
 * une décision de la Finance (`finance.cash_session.force_close`). L'alerte (consommateur NOT) relève
 * de P9 ; la planification, du déploiement (P0-17), comme les autres tâches quotidiennes.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  cashSessionOpenLongerThan,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { cashSetting } from '../cash-session-ledger.js';
import { publishCashSessionEvent } from '../cash-session-events.js';

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
    this.registry.register(CASH_SESSION_OPEN_LONG_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const dayStart = businessDayStartUtc(today);
      const dayEnd = businessDayEndUtc(today);
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
        const already = await uow
          .selectFrom('platform_domain_events')
          .select('seq')
          .where('event_type', '=', 'CashSessionOpenLongDetected')
          .where('aggregate_id', '=', session.id)
          .where('occurred_at', '>=', dayStart)
          .where('occurred_at', '<', dayEnd)
          .executeTakeFirst();
        if (already) continue;
        const sessionId = fromBin(session.id);
        await publishCashSessionEvent(
          uow,
          { idGenerator: this.idGenerator },
          {
            eventType: 'CashSessionOpenLongDetected',
            sessionId,
            occurredAt: now,
            commandId: null,
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
          },
        );
        published += 1;
      }
      this.logger.log(`Sessions de caisse ouvertes trop longtemps (${today}) : ${published}.`);
    });
  }
}
