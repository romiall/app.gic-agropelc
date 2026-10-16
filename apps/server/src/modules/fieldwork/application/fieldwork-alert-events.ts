/**
 * Signal d'alerte `CHECKIN_SUSPICIOUS` (P9-10 ; ADR-071 §2, §4 ; D13 §7.1 ; BR-TER-010, AV-468). Détecteur
 * **sur fait** : publié dans la transaction de `fieldwork.checkin.record`, après l'écriture du pointage et
 * avant le retour de la commande. Jamais un rejet (BR-SYN-007) : le signal accompagne un pointage déjà
 * enregistré ; il ne bloque rien (limite L-02).
 *
 * - Le calcul des signaux est celui de BR-TER-010 (`detectCheckinSuspicion`, appelé par la commande) ; ce
 *   fichier ne décide que de publier : au moins un signal, quelle que soit la nature du pointage
 *   (prise ou fin de service) et son résultat (accepté ou refusé).
 * - Le sujet est le pointage (agrégat `GEO_CHECKIN`) : un événement par pointage, car une même commande
 *   n'est appliquée qu'une fois (rejeu reconnu avant l'écriture) et le gestionnaire sort avant ce point
 *   pour tout rejet.
 * - La charge utile ne porte ni latitude ni longitude (ADR-071 §4 : elle est conservée en entier avec
 *   l'alerte) ; la distance au centre du géorepère et la précision suffisent à l'écran d'action.
 */
import {
  businessDayOf,
  checkinSuspicionLabel,
  type CheckinSuspicionFlag,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { publishDetectionEvent } from '../../../platform/events/detection-events.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { userFullName } from '../../identity/application/public/index.js';

export interface FieldworkAlertDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface SuspiciousCheckinSignal {
  readonly checkinId: string;
  readonly userId: string;
  readonly zoneId: string;
  readonly checkinType: 'START_SERVICE' | 'END_SERVICE';
  readonly serverResult: string;
  readonly flags: readonly CheckinSuspicionFlag[];
  /** Distance au centre du géorepère (mètres), absente sans position ou sans géorepère. */
  readonly distanceM: number | null;
  readonly accuracyM: number | null;
  /** Instant du pointage (jour métier et date du fait dans la charge utile). */
  readonly occurredAt: Date;
  readonly workSessionId: string | null;
  readonly commandId: string;
  readonly capturedOffline: boolean;
}

/**
 * Publie `CheckInSuspicious` si le pointage porte au moins un signal ; vrai si publié. L'événement est daté
 * de la détection par le serveur (AV-457) : un pointage appliqué tard après une synchronisation hors ligne
 * se lève à son application, le jour métier et l'instant du fait restant dans la charge utile.
 */
export async function signalSuspiciousCheckin(
  uow: UnitOfWork,
  deps: FieldworkAlertDeps,
  signal: SuspiciousCheckinSignal,
): Promise<boolean> {
  if (signal.flags.length === 0) return false;
  const userLabel = (await userFullName(uow, signal.userId)) ?? null;
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'CheckInSuspicious',
    producerModule: 'fieldwork',
    aggregateType: 'GEO_CHECKIN',
    aggregateId: signal.checkinId,
    occurredAt: deps.clock.now(),
    commandId: signal.commandId,
    payload: {
      checkin_id: signal.checkinId,
      user_id: signal.userId,
      user_label: userLabel,
      zone_id: signal.zoneId,
      checkin_type: signal.checkinType,
      server_result: signal.serverResult,
      flags: checkinSuspicionLabel(signal.flags),
      flag_codes: [...signal.flags],
      distance_m: signal.distanceM === null ? null : Math.round(signal.distanceM),
      accuracy_m: signal.accuracyM,
      work_session_id: signal.workSessionId,
      occurred_at: signal.occurredAt.toISOString(),
      business_day: businessDayOf(signal.occurredAt),
      captured_offline: signal.capturedOffline,
    },
  });
  return true;
}
