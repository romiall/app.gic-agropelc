/**
 * `sync.errors.alert_check` (P9-10 ; D13 §7.1 `SYNC_ERROR`, AV-392, AV-421) : toutes les heures, publie un
 * événement `SyncErrorDetected` par couple (appareil, code d'erreur) ayant reçu des commandes rejetées ou en
 * conflit dans les `sync.error_alert_window_hours` dernières heures (24), puis le marqueur de fin de passe :
 * l'alerte d'un couple qui n'est plus vu (fenêtre écoulée, conflit refermé) se ferme seule (« Auto — conflit
 * résolu », D13).
 *
 * - **Périmètre** : les commandes reçues par `/sync/push` (les rejets de `/commands` sont rendus à l'écran qui
 *   les a émis), dont l'état est `REJECTED` ou `CONFLICT`. Un rejet est un état terminal sans événement ni
 *   conflit : une alerte par commande inonderait pour un appareil défaillant, d'où la maille appareil × code.
 * - **Fenêtre** : un rejet est jugé à l'instant où il a été **prononcé**, non à celui de la première réception :
 *   `received_at` est immuable alors qu'une commande retenue (`FAILED_RETRYABLE`) peut être reprise et rejetée
 *   des jours plus tard ; la dernière prise en charge (`claimed_at`, réinitialisée à chaque reprise) en est la
 *   mesure, repli `received_at`. Seul le pipeline l'écrit : un rejet prononcé par l'Admin (`COMMAND_DISCARDED`,
 *   exclu par défaut) garde la date de la dernière prise en charge de la commande. Un conflit de gestionnaire est un **état** : il reste signalé tant qu'il est
 *   ouvert, quel que soit son âge (le critère d'ouverture le borne).
 * - **Code d'erreur** : le code de l'inbox, ramené à sa famille (`VALIDATION_ERROR:<raison>` devient
 *   `VALIDATION_ERROR`) ; un conflit de gestionnaire n'a pas de code propre, il prend le type de son conflit
 *   **encore ouvert** (un conflit refermé ne compte plus). Les codes de `sync.error_alert_excluded_codes` ne
 *   sont pas signalés (décision de l'Admin, conséquence d'un autre rejet).
 * - **Propriétaire** : l'auteur de la commande la plus récente du couple (un seul `user_id` est lu par l'alerte).
 * - **Données** : ni le message d'erreur ni la charge utile de la commande n'entrent dans l'événement
 *   (données métier ou personnelles possibles, ADR-061 §4).
 * - Une erreur technique fait lever la tâche (le point de sauvegarde du `JobRunner` annule tout) : jamais de
 *   marqueur partiel.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import {
  businessDayOf,
  isSyncErrorAlertable,
  syncErrorAlertWindowHoursOrDefault,
  syncErrorCodeOf,
  syncErrorExcludedCodesOrDefault,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
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
import { globalSetting, loadAlertDevices, type SyncAlertDeps } from './sync-alert-support.js';

export const SYNC_ERROR_ALERT_JOB_TYPE = 'sync.errors.alert_check';

interface ErrorGroup {
  readonly deviceId: string;
  readonly code: string;
  occurrences: number;
  firstAt: Date;
  lastAt: Date;
  lastUserId: string;
}

export interface SyncErrorCheckOutcome {
  readonly groups: number;
  readonly published: number;
  readonly windowHours: number;
}

export async function runSyncErrorCheck(
  uow: UnitOfWork,
  deps: SyncAlertDeps,
  payload: unknown,
): Promise<SyncErrorCheckOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const windowHours = syncErrorAlertWindowHoursOrDefault(
    await globalSetting(uow, 'sync.error_alert_window_hours', now),
  );
  const excluded = syncErrorExcludedCodesOrDefault(
    await globalSetting(uow, 'sync.error_alert_excluded_codes', now),
  );
  const from = new Date(now.getTime() - windowHours * 3_600_000);

  // Commandes rejetées ou refusées avec un code propre (rejet, appareil révoqué, utilisateur désactivé),
  // jugées à l'instant de leur dernière prise en charge (voir l'en-tête).
  const settledAt = sql<Date>`COALESCE(claimed_at, received_at)`;
  const coded = await uow
    .selectFrom('sync_command_inbox')
    .select(['command_id', 'device_id', 'user_id', 'error_code', settledAt.as('settled_at')])
    .where('transport', '=', 'SYNC_PUSH')
    .where('status', 'in', ['REJECTED', 'CONFLICT'])
    .where('error_code', 'is not', null)
    .where('device_id', 'is not', null)
    .where(settledAt, '>', from)
    .where(settledAt, '<=', now)
    .execute();
  // Conflits de gestionnaire (sans code propre) : le type de leur conflit encore ouvert, sans borne basse.
  const openSettledAt = sql<Date>`COALESCE(i.claimed_at, i.received_at)`;
  const conflicts = await uow
    .selectFrom('sync_command_inbox as i')
    .innerJoin('sync_sync_conflicts as c', 'c.command_id', 'i.command_id')
    .select([
      'i.command_id',
      'i.device_id',
      'i.user_id',
      'c.conflict_type',
      openSettledAt.as('settled_at'),
    ])
    .where('i.transport', '=', 'SYNC_PUSH')
    .where('i.status', '=', 'CONFLICT')
    .where('i.error_code', 'is', null)
    .where('i.device_id', 'is not', null)
    .where('c.status', '=', 'OPEN')
    .where(openSettledAt, '<=', now)
    .execute();

  const groups = new Map<string, ErrorGroup>();
  const seen = new Set<string>();
  const add = (
    commandId: Buffer,
    deviceId: Buffer | null,
    userId: Buffer,
    errorCode: string | null,
    openConflictType: string | null,
    settledAt: Date,
  ) => {
    if (deviceId === null) return;
    const code = syncErrorCodeOf({ errorCode, openConflictType });
    if (code === null || !isSyncErrorAlertable(code, excluded)) return;
    const device = fromBin(deviceId);
    // Une commande compte une fois par code, même avec plusieurs conflits de même type.
    const once = `${fromBin(commandId)}|${code}`;
    if (seen.has(once)) return;
    seen.add(once);
    const key = `${device}|${code}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        deviceId: device,
        code,
        occurrences: 1,
        firstAt: settledAt,
        lastAt: settledAt,
        lastUserId: fromBin(userId),
      });
      return;
    }
    group.occurrences += 1;
    if (settledAt.getTime() < group.firstAt.getTime()) group.firstAt = settledAt;
    if (settledAt.getTime() >= group.lastAt.getTime()) {
      group.lastAt = settledAt;
      group.lastUserId = fromBin(userId);
    }
  };
  for (const row of coded) {
    add(row.command_id, row.device_id, row.user_id, row.error_code, null, row.settled_at);
  }
  for (const row of conflicts) {
    add(row.command_id, row.device_id, row.user_id, null, row.conflict_type, row.settled_at);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => a.deviceId.localeCompare(b.deviceId) || a.code.localeCompare(b.code),
  );
  const devices = await loadAlertDevices(uow, [...new Set(ordered.map((group) => group.deviceId))]);
  const passId = detectionPassId('SYNC_ERROR', passSlotOf(payload, now));
  let published = 0;
  for (const group of ordered) {
    const device = devices.get(group.deviceId);
    const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'SyncErrorDetected',
      producerModule: 'sync',
      aggregateType: 'DEVICE_ERROR',
      aggregateId: compositeSubjectId('SYNC_ERROR', {
        device_id: group.deviceId,
        error_code: group.code,
      }),
      occurredAt: now,
      passId,
      payload: {
        device_id: group.deviceId,
        error_code: group.code,
        device_label: device?.label ?? null,
        occurrences: group.occurrences,
        user_id: group.lastUserId,
        first_at: group.firstAt.toISOString(),
        last_at: group.lastAt.toISOString(),
        window_hours: windowHours,
        business_day: today,
        ...(device?.designatedSiteId != null ? { site_id: device.designatedSiteId } : {}),
      },
    });
    if (inserted) published += 1;
  }
  await publishPassCompleted(uow, {
    producerModule: 'sync',
    alertType: 'SYNC_ERROR',
    passId,
    businessDay: today,
    occurredAt: now,
  });
  return { groups: ordered.length, published, windowHours };
}

@Injectable()
export class SyncErrorAlertJob implements OnModuleInit {
  private readonly logger = new Logger(SyncErrorAlertJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(SYNC_ERROR_ALERT_JOB_TYPE, async (uow, payload) => {
      const outcome = await runSyncErrorCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      this.logger.log(
        `Erreurs de synchronisation sur ${outcome.windowHours} h : ${outcome.groups} couple(s) appareil × code, ` +
          `${outcome.published} signalé(s).`,
      );
    });
  }
}
