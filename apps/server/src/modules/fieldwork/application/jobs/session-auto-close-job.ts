/**
 * `fieldwork.session.auto_close` (BR-TER-008, AV-023 : « toute session non clôturée l'est
 * automatiquement à 23:59 (heure de Douala), statut `AUTO_CLOSED` : sur l'appareil s'il est hors
 * ligne, sinon par le serveur »). Clôt les sessions encore ouvertes dont l'heure de clôture
 * automatique est passée (`resolveSessionEnd`, packages/domain : 23:59:00 de leur jour de début).
 * Une fin de service antérieure reçue plus tard l'emporte (checkin-commands.ts). Même limite que
 * les autres tâches (P0-07, P2-07) : aucun ordonnanceur récurrent réel n'existe encore.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { resolveSessionEnd, type Clock } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { emitWorkSessionChanges } from '../sync-changes.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';

export const SESSION_AUTO_CLOSE_JOB_TYPE = 'fieldwork.session.auto_close';

@Injectable()
export class SessionAutoCloseJob implements OnModuleInit {
  private readonly logger = new Logger(SessionAutoCloseJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(SESSION_AUTO_CLOSE_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      // Au plus une session ouverte par utilisateur (INV-TER-01) : volume borné par l'effectif.
      const open = await uow
        .selectFrom('fieldwork_work_sessions')
        .select(['id', 'started_at'])
        .where('status', '=', 'OPEN')
        .where('started_at', '<', now)
        .forUpdate()
        .execute();
      let closed = 0;
      for (const session of open) {
        const end = resolveSessionEnd({ startedAt: session.started_at, supersededAt: null, now });
        if (end === null) continue;
        await uow
          .updateTable('fieldwork_work_sessions')
          .set({
            status: 'AUTO_CLOSED',
            ended_at: end.endedAt,
            close_cause: end.cause,
            version: sql`version + 1`,
          })
          .where('id', '=', session.id)
          .execute();
        await emitWorkSessionChanges(uow, [session.id]);
        closed += 1;
      }
      this.logger.log(`Sessions clôturées automatiquement (23:59) : ${closed}.`);
    });
  }
}
