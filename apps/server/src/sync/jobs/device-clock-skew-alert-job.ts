/**
 * `sync.devices.clock_skew_check` (P9-10 ; D13 §7.1 `CLOCK_SKEW`, BR-SYN-011, AV-216, AV-474) : toutes les
 * heures, publie un événement `ClockSkewDetected` par appareil actif dont le **dernier envoi** (dans les
 * `sync.stale_hours` dernières heures) accusait un écart d'horloge au-delà de `sync.clock_skew_flag_minutes`
 * (5 minutes), puis le marqueur de fin de passe : un appareil remis à l'heure (son envoi suivant est dans la
 * tolérance), silencieux depuis plus de `sync.stale_hours` heures (`SYNC_STALE` prend le relais) ou bloqué voit
 * son alerte se fermer seule.
 *
 * - **Passe et non publication à l'envoi** (D13 disait « sur synchronisation ») : `/sync/push` n'ouvre pas de
 *   transaction sur son chemin chaud, et une alerte d'état exige un événement de fin ; le dernier écart
 *   mesuré (`last_clock_skew_ms`, écrasé à chaque envoi) est lu à l'instant de la passe.
 * - **Seuil** : lu à l'instant de la passe, comme le pipeline le lit à la réception (AV-216) ; le drapeau figé
 *   par commande (`clock_suspect`) reste celui de la réception.
 * - **Signe** : `skew_minutes` est l'heure du serveur moins celle de l'appareil — positif : l'appareil est en
 *   retard, négatif : en avance.
 * - **Propriétaire** : l'auteur du dernier envoi de l'appareil (ligne `_a:` la plus récente).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  clockSkewMinutes,
  clockSkewThresholdMsFrom,
  isClockSkewSuspect,
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
import { fromBin } from '../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import { AUTHOR_DATASET_LIKE, DEVICE_DATASET, authorOfDataset } from '../sync-state-datasets.js';
import { globalSetting, loadAlertDevices, type SyncAlertDeps } from './sync-alert-support.js';

export const DEVICE_CLOCK_SKEW_JOB_TYPE = 'sync.devices.clock_skew_check';

export interface DeviceClockSkewOutcome {
  readonly examined: number;
  readonly skewed: number;
  readonly published: number;
  readonly thresholdMinutes: number;
}

export async function runDeviceClockSkewCheck(
  uow: UnitOfWork,
  deps: SyncAlertDeps,
  payload: unknown,
): Promise<DeviceClockSkewOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const thresholdMs = clockSkewThresholdMsFrom(
    await globalSetting(uow, 'sync.clock_skew_flag_minutes', now),
  );
  const windowHours = syncStaleHoursOrDefault(await globalSetting(uow, 'sync.stale_hours', now));
  const from = new Date(now.getTime() - windowHours * 3_600_000);

  const states = await uow
    .selectFrom('sync_device_sync_state')
    .select(['device_id', 'last_push_at', 'last_clock_skew_ms'])
    .where('dataset', '=', DEVICE_DATASET)
    .where('last_clock_skew_ms', 'is not', null)
    .where('last_push_at', '>', from)
    .where('last_push_at', '<=', now)
    .execute();
  const devices = await loadAlertDevices(
    uow,
    states.map((state) => fromBin(state.device_id)),
  );
  const examined = states.filter(
    (state) => devices.get(fromBin(state.device_id))?.status === 'ACTIVE',
  );
  const skewed = examined
    .filter((state) => isClockSkewSuspect(state.last_clock_skew_ms!, thresholdMs))
    .sort((a, b) => fromBin(a.device_id).localeCompare(fromBin(b.device_id)));

  // Auteur du dernier envoi de chaque appareil écarté (ligne `_a:` la plus récente).
  const authorRows =
    skewed.length === 0
      ? []
      : await uow
          .selectFrom('sync_device_sync_state')
          .select(['device_id', 'dataset', 'last_push_at'])
          .where(
            'device_id',
            'in',
            skewed.map((state) => state.device_id),
          )
          .where('dataset', 'like', AUTHOR_DATASET_LIKE)
          .where('last_push_at', 'is not', null)
          .execute();
  const lastAuthor = new Map<string, { userId: string; at: Date }>();
  for (const row of authorRows) {
    const userId = authorOfDataset(row.dataset);
    if (userId === null || row.last_push_at === null) continue;
    const key = fromBin(row.device_id);
    const known = lastAuthor.get(key);
    if (known === undefined || row.last_push_at.getTime() > known.at.getTime()) {
      lastAuthor.set(key, { userId, at: row.last_push_at });
    }
  }

  const passId = detectionPassId('CLOCK_SKEW', passSlotOf(payload, now));
  let published = 0;
  for (const state of skewed) {
    const deviceId = fromBin(state.device_id);
    const device = devices.get(deviceId)!;
    const author = lastAuthor.get(deviceId);
    const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'ClockSkewDetected',
      producerModule: 'sync',
      aggregateType: 'DEVICE',
      aggregateId: deviceId,
      occurredAt: now,
      passId,
      payload: {
        device_id: deviceId,
        device_label: device.label,
        skew_minutes: clockSkewMinutes(state.last_clock_skew_ms!),
        // Le seuil tel que réglé (le réglage admet des minutes fractionnaires) : l'arrondi supérieur est celui de
        // l'écart, non du seuil.
        threshold_minutes: thresholdMs / 60_000,
        last_push_at: state.last_push_at!.toISOString(),
        business_day: today,
        ...(author !== undefined ? { user_id: author.userId } : {}),
        ...(device.designatedSiteId !== null ? { site_id: device.designatedSiteId } : {}),
      },
    });
    if (inserted) published += 1;
  }
  await publishPassCompleted(uow, {
    producerModule: 'sync',
    alertType: 'CLOCK_SKEW',
    passId,
    businessDay: today,
    occurredAt: now,
  });
  return {
    examined: examined.length,
    skewed: skewed.length,
    published,
    thresholdMinutes: clockSkewMinutes(thresholdMs),
  };
}

@Injectable()
export class DeviceClockSkewAlertJob implements OnModuleInit {
  private readonly logger = new Logger(DeviceClockSkewAlertJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DEVICE_CLOCK_SKEW_JOB_TYPE, async (uow, payload) => {
      const outcome = await runDeviceClockSkewCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      this.logger.log(
        `Horloges d'appareils (seuil ${outcome.thresholdMinutes} min) : ${outcome.skewed} décalée(s) sur ` +
          `${outcome.examined} examinée(s), ${outcome.published} signalée(s).`,
      );
    });
  }
}
