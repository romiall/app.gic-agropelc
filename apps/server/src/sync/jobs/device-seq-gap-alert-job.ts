/**
 * `sync.devices.seq_gap_check` (P9-10 ; D13 §7.1 `DEVICE_SEQ_GAP`, BR-SYN-003, AV-473) : toutes les heures,
 * publie un événement `DeviceSequenceGapDetected` par appareil actif dont la suite des `device_seq` reçus
 * (`sync_command_inbox`) présente un **trou non comblé depuis plus de `sync.seq_gap_alert_hours` heures** (24)
 * qu'aucune commande en attente sur l'appareil n'explique. Alerte d'événement à résolution manuelle : aucun
 * marqueur de fin de passe (la perte de commandes ne se « résout » pas d'elle-même).
 *
 * - **Trou** : plage de numéros absente de la boîte entre 1 et le plus grand numéro reçu de l'appareil (la
 *   suite d'un appareil démarre à 1). Il est **ouvert** depuis la réception de la première commande de numéro
 *   supérieur ; une commande tardive qui le comble le fait disparaître. Les commandes retenues ou hors délai
 *   d'un lot ne sont pas enregistrées mais suivent le dernier numéro enregistré : elles ne créent pas de trou.
 * - **Explication par les restes déclarés** : l'appareil déclare à chaque envoi ce qui lui reste à envoyer, par
 *   auteur. Si le total déclaré couvre tous les numéros manquants, ce sont des commandes encore dans l'outbox
 *   (tablette partagée dont un auteur n'a pas ouvert sa session, envoi interrompu), pas des commandes perdues :
 *   rien n'est signalé. Sans déclaration, rien n'est supposé.
 * - **Un événement par plage, une fois** : les plages déjà signalées sont mémorisées dans `known_gaps` (paires
 *   `[début, fin]`, ligne `_device`) pour qu'une alerte résolue ne renaisse pas chaque heure. Une plage
 *   **contenue** dans une plage mémorisée (le trou s'est réduit parce qu'une commande tardive est arrivée, ou
 *   scindé) n'est pas nouvelle ; une plage nouvelle ou plus large l'est. La mémoire garde une plage tant qu'un de
 *   ses numéros manque, **que l'âge ou l'explication par les restes déclarés la rende visible ou non** : si les
 *   restes déclarés de l'appareil oscillent, l'alerte d'une plage déjà traitée ne renaît pas. Elle s'efface quand
 *   tous les numéros sont arrivés.
 * - **Détection en deux temps** : un agrégat sur l'index unique `(device_id, device_seq)` repère les appareils
 *   incomplets (`COUNT(*) < MAX(device_seq)`), puis une fenêtre SQL ne rend que les plages manquantes de
 *   ceux-là : la table n'est jamais chargée en mémoire.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import {
  agedSequenceGaps,
  businessDayOf,
  gapsExplainedByPending,
  missingSequenceCount,
  nextKnownGaps,
  parseKnownGaps,
  sameSequenceGaps,
  syncSeqGapAlertHoursOrDefault,
  unsignaledSequenceGaps,
  type Clock,
  type IdGenerator,
  type SequenceGap,
} from '@gic/domain';
import { CLOCK } from '../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
} from '../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../platform/jobs/job-handler-registry.provider.js';
import { jsonValue } from '../../platform/kysely/json-value.js';
import { fromBin, toBin } from '../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import { DEVICE_DATASET } from '../sync-state-datasets.js';
import { globalSetting, loadAlertDevices, type SyncAlertDeps } from './sync-alert-support.js';

export const DEVICE_SEQ_GAP_JOB_TYPE = 'sync.devices.seq_gap_check';

/** Plages citées dans la charge utile (le total reste exact dans `gaps_count` et `missing_count`). */
const MAX_RANGES_IN_PAYLOAD = 10;

export interface DeviceSeqGapOutcome {
  /** Appareils dont la suite de numéros a un trou. */
  readonly incomplete: number;
  /** Appareils actifs ayant au moins une plage ancienne non expliquée. */
  readonly unexplained: number;
  readonly published: number;
  readonly hours: number;
}

interface GapRow {
  readonly device_id: Buffer;
  readonly from_seq: string | number;
  readonly to_seq: string | number;
  readonly opened_at: Date | string;
}

export async function runDeviceSeqGapCheck(
  uow: UnitOfWork,
  deps: SyncAlertDeps,
  payload: unknown,
): Promise<DeviceSeqGapOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const hours = syncSeqGapAlertHoursOrDefault(
    await globalSetting(uow, 'sync.seq_gap_alert_hours', now),
  );

  // 1. Appareils dont la suite est incomplète : moins de numéros reçus que le plus grand numéro.
  const candidates = await uow
    .selectFrom('sync_command_inbox')
    .select('device_id')
    .where('device_seq', 'is not', null)
    .where('device_id', 'is not', null)
    .groupBy('device_id')
    .having(sql<boolean>`COUNT(*) < MAX(device_seq)`)
    .execute();
  const candidateIds = candidates.map((row) => row.device_id!);

  // La mémoire d'un appareil dont la suite est de nouveau complète est effacée. Les lignes concernées sont
  // d'abord lues sans verrou, puis effacées par clé primaire : un `UPDATE` filtré sur `known_gaps` verrouillerait
  // toute la table que les envois des appareils écrivent en continu.
  const candidateSet = new Set(candidateIds.map((id) => fromBin(id)));
  const remembered = await uow
    .selectFrom('sync_device_sync_state')
    .select('device_id')
    .where('dataset', '=', DEVICE_DATASET)
    .where('known_gaps', 'is not', null)
    .execute();
  const complete = remembered.filter((row) => !candidateSet.has(fromBin(row.device_id)));
  if (complete.length > 0) {
    await uow
      .updateTable('sync_device_sync_state')
      .set({ known_gaps: null })
      .where('dataset', '=', DEVICE_DATASET)
      .where(
        'device_id',
        'in',
        complete.map((row) => row.device_id),
      )
      .execute();
  }
  if (candidateIds.length === 0) return { incomplete: 0, unexplained: 0, published: 0, hours };

  // 2. Plages manquantes de ces appareils seulement, avec la date d'ouverture de chacune.
  const rows = (
    await sql<GapRow>`
      SELECT device_id, from_seq, to_seq, opened_at FROM (
        SELECT device_id,
               LAG(device_seq, 1, 0) OVER w + 1 AS from_seq,
               device_seq - 1 AS to_seq,
               device_seq - LAG(device_seq, 1, 0) OVER w AS step,
               MIN(received_at) OVER (
                 PARTITION BY device_id ORDER BY device_seq
                 ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
               ) AS opened_at
          FROM sync_command_inbox
         WHERE device_seq IS NOT NULL AND device_id IN (${sql.join(candidateIds)})
        WINDOW w AS (PARTITION BY device_id ORDER BY device_seq)
      ) gaps
       WHERE step > 1
       ORDER BY device_id, from_seq
    `.execute(uow)
  ).rows;
  const gapsOf = new Map<string, SequenceGap[]>();
  for (const row of rows) {
    const key = fromBin(row.device_id);
    const list = gapsOf.get(key) ?? [];
    list.push({
      from: Number(row.from_seq),
      to: Number(row.to_seq),
      openedAt: new Date(row.opened_at),
    });
    gapsOf.set(key, list);
  }

  const devices = await loadAlertDevices(uow, [...gapsOf.keys()]);
  const states = await uow
    .selectFrom('sync_device_sync_state')
    .select(['device_id', 'pending_reported', 'known_gaps'])
    .where('dataset', '=', DEVICE_DATASET)
    .where(
      'device_id',
      'in',
      [...gapsOf.keys()].map((id) => toBin(id)),
    )
    .execute();
  const stateOf = new Map(states.map((state) => [fromBin(state.device_id), state]));

  const passId = detectionPassId('DEVICE_SEQ_GAP', passSlotOf(payload, now));
  let unexplained = 0;
  let published = 0;
  for (const deviceId of [...gapsOf.keys()].sort()) {
    const device = devices.get(deviceId);
    // Un appareil bloqué, perdu ou retiré n'enverra plus ses commandes en attente : son signal est ailleurs.
    if (device === undefined || device.status !== 'ACTIVE') continue;
    const gaps = gapsOf.get(deviceId)!;
    const state = stateOf.get(deviceId);
    const explained = gapsExplainedByPending(gaps, state?.pending_reported ?? null);
    const current = explained ? [] : agedSequenceGaps(gaps, now, hours);
    const known = parseKnownGaps(state?.known_gaps ?? null);
    if (current.length > 0) unexplained += 1;

    const fresh = unsignaledSequenceGaps(current, known);
    if (fresh.length > 0) {
      const first = fresh[0]!;
      const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
        eventType: 'DeviceSequenceGapDetected',
        producerModule: 'sync',
        aggregateType: 'DEVICE',
        aggregateId: deviceId,
        occurredAt: now,
        passId,
        payload: {
          device_id: deviceId,
          device_label: device.label,
          missing_from: first.from,
          missing_to: first.to,
          opened_at: first.openedAt.toISOString(),
          gaps_count: current.length,
          missing_count: missingSequenceCount(current),
          new_ranges: fresh.slice(0, MAX_RANGES_IN_PAYLOAD).map((gap) => [gap.from, gap.to]),
          pending_reported: state?.pending_reported ?? null,
          threshold_hours: hours,
          business_day: today,
          ...(device.designatedSiteId !== null ? { site_id: device.designatedSiteId } : {}),
        },
      });
      if (inserted) published += 1;
    }
    // Mémoire : les plages signalées dont un numéro manque encore, plus celles de cette passe. Elle ne dépend
    // ni de l'âge ni de l'explication : l'alerte d'une plage déjà signalée ne renaît pas quand les restes
    // déclarés de l'appareil oscillent.
    const next = nextKnownGaps({ known, present: gaps, signaled: fresh });
    if (!sameSequenceGaps(next, known)) {
      await uow
        .insertInto('sync_device_sync_state')
        .values({
          device_id: toBin(deviceId),
          dataset: DEVICE_DATASET,
          known_gaps: jsonValue(next),
        })
        .onDuplicateKeyUpdate({ known_gaps: jsonValue(next) })
        .execute();
    }
  }
  return { incomplete: gapsOf.size, unexplained, published, hours };
}

@Injectable()
export class DeviceSeqGapAlertJob implements OnModuleInit {
  private readonly logger = new Logger(DeviceSeqGapAlertJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DEVICE_SEQ_GAP_JOB_TYPE, async (uow, payload) => {
      const outcome = await runDeviceSeqGapCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      this.logger.log(
        `Trous de séquence depuis plus de ${outcome.hours} h : ${outcome.incomplete} appareil(s) incomplet(s), ` +
          `${outcome.unexplained} sans explication, ${outcome.published} signalé(s).`,
      );
    });
  }
}
