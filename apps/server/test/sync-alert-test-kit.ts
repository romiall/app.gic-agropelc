/**
 * Outils des tests des alertes de synchronisation (P9-10) : appareils, lignes de la boîte des commandes,
 * états de synchronisation et lecture des événements publiés. Tout s'écrit dans la transaction annulée du test
 * (`rolledBack`) ; les passes s'exécutent avec une horloge dans le passé lointain (2019) pour ne voir que les
 * lignes du test : celles des autres suites sont postérieures à l'horloge, donc hors fenêtre.
 */
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordConflict, resolveOpenConflicts } from '../src/platform/sync/conflicts.js';
import { authorDataset, DEVICE_DATASET } from '../src/sync/sync-state-datasets.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import {
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

/** 11:00 à Douala le mardi 12 mars 2019. */
export const NOW = new Date('2019-03-12T10:00:00.000Z');
export const TODAY = '2019-03-12';
export const SLOT = NOW.toISOString();
export const HOUR_MS = 3_600_000;
export const clock = new FixedClock(NOW);
export const idGenerator = new Uuidv7Generator(clock);
export const deps = { clock, idGenerator };

/** Instant à `hours` heures avant `from` (par défaut l'horloge du test). */
export const hoursBefore = (hours: number, from: Date = NOW): Date =>
  new Date(from.getTime() - hours * HOUR_MS);

export interface TestWorld {
  readonly admin: string;
  readonly siteId: string;
}

export async function world(uow: UnitOfWork): Promise<TestWorld> {
  const admin = await insertTestUser(uow);
  const zone = await insertTestZone(uow, admin);
  const siteId = await insertTestSite(uow, admin, zone);
  return { admin, siteId };
}

export interface TestDevice {
  readonly id: string;
  readonly ownerId: string;
  readonly shortCode: string;
}

/** Appareil enrôlé par `ownerId`, activé à `activatedAt` (par défaut très ancien : sans effet sur le délai). */
export async function device(
  uow: UnitOfWork,
  ownerId: string,
  options: {
    readonly status?: 'ACTIVE' | 'BLOCKED' | 'LOST' | 'RETIRED' | 'PENDING';
    readonly activatedAt?: Date;
    readonly lastSeenAt?: Date | null;
    readonly label?: string | null;
    readonly siteId?: string | null;
    readonly shared?: boolean;
  } = {},
): Promise<TestDevice> {
  const id = await insertTestDevice(uow, ownerId, {
    status: options.status ?? 'ACTIVE',
    statusChangedAt: options.activatedAt ?? new Date('2018-01-01T00:00:00.000Z'),
  });
  await uow
    .updateTable('identity_devices')
    .set({
      last_seen_at: options.lastSeenAt ?? null,
      label: options.label ?? null,
      designated_site_id:
        options.siteId === undefined || options.siteId === null ? null : toBin(options.siteId),
      is_shared: options.shared === true ? 1 : 0,
    })
    .where('id', '=', toBin(id))
    .execute();
  const row = await uow
    .selectFrom('identity_devices')
    .select('short_code')
    .where('id', '=', toBin(id))
    .executeTakeFirstOrThrow();
  return { id, ownerId, shortCode: row.short_code };
}

export interface InboxInput {
  readonly deviceId: string;
  readonly userId: string;
  readonly receivedAt: Date;
  readonly status?: 'APPLIED' | 'REJECTED' | 'CONFLICT' | 'FAILED_RETRYABLE' | 'RECEIVED';
  readonly errorCode?: string | null;
  readonly seq?: number | null;
  readonly transport?: 'SYNC_PUSH' | 'ONLINE_API' | 'SYSTEM';
}

/** Ligne de la boîte des commandes ; renvoie l'identifiant de la commande. */
export async function inboxRow(uow: UnitOfWork, input: InboxInput): Promise<string> {
  const commandId = freshUuid();
  await uow
    .insertInto('sync_command_inbox')
    .values({
      command_id: toBin(commandId),
      device_id: toBin(input.deviceId),
      user_id: toBin(input.userId),
      device_seq: input.seq ?? null,
      transport: input.transport ?? 'SYNC_PUSH',
      command_type: 'test.sync_alert',
      depends_on: jsonValue([]),
      payload: jsonValue({}),
      payload_hash: '0'.repeat(64),
      occurred_at: input.receivedAt,
      received_at: input.receivedAt,
      status: input.status ?? 'APPLIED',
      error_code: input.errorCode ?? null,
    })
    .execute();
  return commandId;
}

/** Conflit de synchronisation d'une commande ; refermé si `closed`. */
export async function conflictOf(
  uow: UnitOfWork,
  commandId: string,
  conflictType: string,
  options: { readonly closed?: boolean; readonly resolvedBy?: string } = {},
): Promise<void> {
  const entityId = freshUuid();
  await recordConflict(uow, {
    id: freshUuid(),
    commandId,
    conflictType,
    entityType: 'TEST',
    entityId,
    ownerRole: 'ADMIN',
    applied: true,
    details: {},
  });
  if (options.closed === true) {
    await resolveOpenConflicts(uow, {
      conflictType,
      entityType: 'TEST',
      entityIds: [entityId],
      resolution: 'KEEP_SERVER',
      resolvedBy: options.resolvedBy!,
      resolvedAt: NOW,
    });
  }
}

/** État de synchronisation de l'appareil (ligne `_device`) ou d'un auteur (`authorId`). */
export async function syncState(
  uow: UnitOfWork,
  deviceId: string,
  fields: {
    readonly authorId?: string;
    readonly lastPushAt?: Date | null;
    readonly lastPullAt?: Date | null;
    readonly lastClockSkewMs?: number | null;
    readonly pendingReported?: number | null;
    readonly knownGaps?: unknown;
  },
): Promise<void> {
  await uow
    .insertInto('sync_device_sync_state')
    .values({
      device_id: toBin(deviceId),
      dataset: fields.authorId === undefined ? DEVICE_DATASET : authorDataset(fields.authorId),
      last_push_at: fields.lastPushAt ?? null,
      last_pull_at: fields.lastPullAt ?? null,
      last_clock_skew_ms: fields.lastClockSkewMs ?? null,
      pending_reported: fields.pendingReported ?? null,
      known_gaps: fields.knownGaps === undefined ? null : jsonValue(fields.knownGaps),
    })
    .execute();
}

/** Événements d'un type publiés pour un sujet, dans l'ordre de publication. */
export async function eventsOf(uow: UnitOfWork, eventType: string, aggregateId: string) {
  return (
    await uow
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('event_type', '=', eventType)
      .where('aggregate_id', '=', toBin(aggregateId))
      .orderBy('seq')
      .execute()
  ).map((row) => toDomainEvent(row));
}

/** Marqueurs de fin de passe d'un type d'alerte de ce créneau. */
export async function markersOf(uow: UnitOfWork, alertType: string, slot: string = SLOT) {
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', 'AlertDetectionPassCompleted')
    .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.alert_type')) = ${alertType}`)
    .where(sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.pass_id')) LIKE ${`%${slot}%`}`)
    .orderBy('seq')
    .execute();
  return rows.map((row) => toDomainEvent(row));
}
