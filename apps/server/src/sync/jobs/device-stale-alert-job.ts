/**
 * `sync.devices.stale_check` (P9-10 ; D13 §7.1 `SYNC_STALE`, AV-472) : toutes les heures, publie un événement
 * `DeviceSyncStale` par appareil **actif** sans synchronisation depuis plus de `sync.stale_hours` heures (24),
 * puis le marqueur de fin de passe : un appareil qui se synchronise de nouveau, qui est bloqué, perdu ou retiré,
 * ou que l'horizon d'oubli écarte, voit son alerte se fermer seule.
 *
 * - **Dernier contact** : celui de la fraîcheur des appareils de l'accueil (`deviceFreshness` : connexion,
 *   dernier envoi, dernier pull) ; le seuil est ici le réglage de l'alerte, non celui de l'accueil (2 h).
 * - **Référence du délai** : le plus récent du dernier contact et de l'**activation** de l'appareil — un appareil
 *   approuvé n'est pas « en retard » avant de s'en être servi.
 * - **Horizon d'oubli** : au-delà de `sync.stale_horizon_days` jours (30, `0` : aucun) de silence, l'appareil
 *   est tenu pour abandonné et n'est plus signalé (l'Admin le retire par `RETIRED`) ; aucun drapeau « de réserve »
 *   n'existe.
 * - **Propriétaire** : l'utilisateur qui a enrôlé l'appareil (convention MP-06) ; son responsable d'équipe reçoit
 *   aussi l'alerte. Une tablette partagée est suivie au niveau de l'appareil, non de ses auteurs.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  deviceStaleness,
  syncStaleHorizonDaysOrDefault,
  syncStaleHoursOrDefault,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../platform/jobs/job-handler-registry.provider.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import { deviceFreshness } from '../device-freshness.js';
import { globalSetting, loadActiveAlertDevices, type SyncAlertDeps } from './sync-alert-support.js';

export const DEVICE_STALE_ALERT_JOB_TYPE = 'sync.devices.stale_check';

export interface DeviceStaleCheckOutcome {
  readonly examined: number;
  readonly stale: number;
  readonly published: number;
  readonly staleHours: number;
  readonly horizonDays: number;
}

export async function runDeviceStaleCheck(
  uow: UnitOfWork,
  deps: SyncAlertDeps,
  payload: unknown,
): Promise<DeviceStaleCheckOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const staleHours = syncStaleHoursOrDefault(await globalSetting(uow, 'sync.stale_hours', now));
  const horizonDays = syncStaleHorizonDaysOrDefault(
    await globalSetting(uow, 'sync.stale_horizon_days', now),
  );

  const devices = await loadActiveAlertDevices(uow);
  const ids = [...devices.keys()].sort();
  const freshness = await deviceFreshness(uow, { deviceIds: ids, now, warningHours: staleHours });
  const passId = detectionPassId('SYNC_STALE', passSlotOf(payload, now));

  let stale = 0;
  let published = 0;
  for (const report of freshness.devices) {
    const device = devices.get(report.deviceId);
    if (device === undefined) continue;
    const staleness = deviceStaleness({
      lastContactAt: report.lastContactAt,
      activatedAt: device.statusChangedAt,
      now,
      staleHours,
      horizonDays,
    });
    if (!staleness.stale) continue;
    stale += 1;
    const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'DeviceSyncStale',
      producerModule: 'sync',
      aggregateType: 'DEVICE',
      aggregateId: device.id,
      occurredAt: now,
      passId,
      payload: {
        device_id: device.id,
        device_label: device.label,
        // « Dernière synchronisation » n'existe que pour un appareil déjà contacté : la date de l'activation d'un
        // appareil jamais utilisé n'en est pas une (le champ est alors omis du message).
        ...(report.lastContactAt !== null
          ? { last_sync_at: report.lastContactAt.toISOString() }
          : {}),
        // Départ du silence quand il diffère de la dernière synchronisation : appareil jamais contacté, ou activé
        // (réactivé) après son dernier contact. Sinon la dernière synchronisation le dit déjà.
        ...(report.lastContactAt === null ||
        staleness.sinceAt.getTime() !== report.lastContactAt.getTime()
          ? { silent_since: staleness.sinceAt.toISOString() }
          : {}),
        hours_since: staleness.hoursSince,
        threshold_hours: staleHours,
        never_contacted: report.lastContactAt === null,
        is_shared: device.isShared,
        user_id: device.enrolledByUserId,
        business_day: today,
        ...(device.designatedSiteId !== null ? { site_id: device.designatedSiteId } : {}),
      },
    });
    if (inserted) published += 1;
  }
  await publishPassCompleted(uow, {
    producerModule: 'sync',
    alertType: 'SYNC_STALE',
    passId,
    businessDay: today,
    occurredAt: now,
  });
  return { examined: freshness.devices.length, stale, published, staleHours, horizonDays };
}

@Injectable()
export class DeviceStaleAlertJob implements OnModuleInit {
  private readonly logger = new Logger(DeviceStaleAlertJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DEVICE_STALE_ALERT_JOB_TYPE, async (uow, payload) => {
      const outcome = await runDeviceStaleCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      this.logger.log(
        `Appareils sans synchronisation depuis plus de ${outcome.staleHours} h : ${outcome.stale} sur ` +
          `${outcome.examined} actif(s), ${outcome.published} signalé(s).`,
      );
    });
  }
}
