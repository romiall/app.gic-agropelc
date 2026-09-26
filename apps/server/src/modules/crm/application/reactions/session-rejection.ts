/**
 * Réaction au rejet d'une dérogation de session (SM-WORK-SESSION : « Rejet → activités
 * rattachées : indicateur `session_rejected` » ; BR-TER-005). `crm` s'enregistre auprès du
 * registre de `fieldwork` (inversion de dépendance, `fieldwork` ne connaît pas les visites) ;
 * la réaction s'exécute dans la transaction de la décision. Les visites restent enregistrées :
 * l'indicateur signale, ne bloque pas (AV-023). Les visites saisies après le rejet portent
 * l'indicateur dès leur création (`evaluateVisit`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { emitActivityChange } from '../sync-changes.js';
import {
  SESSION_REJECTED_LISTENERS,
  type SessionRejectedListenerRegistry,
} from '../../../fieldwork/application/public/index.js';

export async function flagVisitsOfRejectedSession(
  uow: UnitOfWork,
  sessionId: string,
): Promise<void> {
  await uow
    .updateTable('crm_visits')
    .set({
      flags: sql<string>`JSON_ARRAY_APPEND(flags, '$', 'SESSION_REJECTED')`,
      version: sql`version + 1`,
    })
    .where('work_session_id', '=', toBin(sessionId))
    .where(sql<boolean>`NOT JSON_CONTAINS(flags, '"SESSION_REJECTED"')`)
    .execute();
  const visits = await uow
    .selectFrom('crm_visits')
    .select(['id', 'occurred_at'])
    .where('work_session_id', '=', toBin(sessionId))
    .execute();
  for (const visit of visits) {
    await emitActivityChange(uow, 'VISIT', fromBin(visit.id), visit.occurred_at);
  }
}

@Injectable()
export class CrmSessionRejectionRegistrar implements OnModuleInit {
  constructor(
    @Inject(SESSION_REJECTED_LISTENERS)
    private readonly listeners: SessionRejectedListenerRegistry,
  ) {}

  onModuleInit(): void {
    this.listeners.register(flagVisitsOfRejectedSession);
  }
}
