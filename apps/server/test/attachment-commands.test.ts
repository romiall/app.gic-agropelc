/**
 * `attachments.attachment.register` (P0-13 ; SM-ATTACHMENT `[*] --> PENDING_UPLOAD`).
 * Niveau service (comme `organization-commands.test.ts`) : pipeline réel, base MySQL réelle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerAttachmentCommands } from '../src/modules/attachments/application/commands/attachment-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestPermission,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const OCCURRED_AT = '2026-09-25T09:00:00.000Z';
const ATTACHMENT_PERMISSION = 'attachments.attachment.manage';
const SHA256_SAMPLE = 'a'.repeat(64);

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerAttachmentCommands(registry);
  return registry;
}

function buildRegisterCommand(overrides: {
  readonly commandId: string;
  readonly authorUserId: string;
  readonly aggregateId: string;
  readonly ownerId: string;
  readonly occurredAt?: string;
}): Record<string, unknown> {
  return {
    command_id: overrides.commandId,
    device_seq: 1,
    command_type: 'attachments.attachment.register',
    command_version: 1,
    author_user_id: overrides.authorUserId,
    aggregate_type: 'ATTACHMENT',
    aggregate_id: overrides.aggregateId,
    base_version: null,
    depends_on: [],
    occurred_at: overrides.occurredAt ?? OCCURRED_AT,
    client_created_at: overrides.occurredAt ?? OCCURRED_AT,
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      ownerType: 'TEST_SUBJECT',
      ownerId: overrides.ownerId,
      kind: 'PHOTO',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      sha256: SHA256_SAMPLE,
      capturedAt: overrides.occurredAt ?? OCCURRED_AT,
      capturedLat: 4.05,
      capturedLng: 9.7,
    },
  };
}

describe('attachments.attachment.register (P0-13)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let author: string;
  let device: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-25T09:00:05.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    author = await db.transaction().execute((trx) => insertTestUser(trx));
    device = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, author, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, ATTACHMENT_PERMISSION);
      const role = await insertTestRole(trx, author);
      await grantTestPermission(trx, role, ATTACHMENT_PERMISSION, author);
      await assignTestRole(trx, author, role, author);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('chemin heureux : PENDING_UPLOAD, storage_key déterministe, [STD-ORIGIN] peuplé depuis sync_command_inbox', async () => {
    const commandId = freshUuid();
    const aggregateId = freshUuid();
    const ownerId = freshUuid();
    const result = await pipeline.handle(
      buildRegisterCommand({ commandId, authorUserId: author, aggregateId, ownerId }),
      { authenticatedUserId: author, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('attachments_attachments')
      .selectAll()
      .where('id', '=', toBin(aggregateId))
      .executeTakeFirstOrThrow();
    expect(row.owner_type).toBe('TEST_SUBJECT');
    expect(row.upload_status).toBe('PENDING_UPLOAD');
    expect(row.uploaded_bytes).toBe(0);
    expect(row.storage_key).toBe(`attachments/${aggregateId}`);
    expect(row.sha256).toBe(SHA256_SAMPLE);
    expect(row.captured_lat).toBe('4.050000');
    expect(row.captured_lng).toBe('9.700000');

    // [STD-ORIGIN] : device_id et received_at ne sont pas sur CommandEnvelope (ONLINE_API,
    // pas de lot) — lus depuis sync_command_inbox (déjà écrite avant le gestionnaire).
    expect(row.created_device_id?.toString('hex')).toBe(toBin(device).toString('hex'));
    expect(row.received_at).toBeInstanceOf(Date);
    expect(row.clock_suspect).toBe(0); // ONLINE_API : pas d'écart de lot fourni au pipeline
    expect(row.command_id?.toString('hex')).toBe(toBin(commandId).toString('hex'));
  });

  it('rejeu idempotent (même command_id) : un seul effet', async () => {
    const commandId = freshUuid();
    const aggregateId = freshUuid();
    const ownerId = freshUuid();
    const raw = buildRegisterCommand({ commandId, authorUserId: author, aggregateId, ownerId });

    const first = await pipeline.handle(raw, {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
      transport: 'ONLINE_API',
    });
    const second = await pipeline.handle(raw, {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
      transport: 'ONLINE_API',
    });
    expect(first.status).toBe('APPLIED');
    expect(second).toEqual(first);

    const rows = await db
      .selectFrom('attachments_attachments')
      .select('id')
      .where('id', '=', toBin(aggregateId))
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('type MIME hors catalogue → REJECTED VALIDATION_ERROR (D01 §8, ATTACHMENT_TYPE)', async () => {
    const commandId = freshUuid();
    const aggregateId = freshUuid();
    const raw = buildRegisterCommand({
      commandId,
      authorUserId: author,
      aggregateId,
      ownerId: freshUuid(),
    });
    (raw.payload as Record<string, unknown>).mimeType = 'application/zip';
    const result = await pipeline.handle(raw, {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
      transport: 'ONLINE_API',
    });
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toMatch(/^VALIDATION_ERROR/);
  });

  it('sans la permission attachments.attachment.manage → REJECTED FORBIDDEN (AV-093)', async () => {
    const strangerId = await db.transaction().execute((trx) => insertTestUser(trx));
    const strangerDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, strangerId, { status: 'ACTIVE' }));
    const commandId = freshUuid();
    const raw = buildRegisterCommand({
      commandId,
      authorUserId: strangerId,
      aggregateId: freshUuid(),
      ownerId: freshUuid(),
    });
    const result = await pipeline.handle(raw, {
      authenticatedUserId: strangerId,
      authenticatedDeviceId: strangerDevice,
      transport: 'ONLINE_API',
    });
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toBe('FORBIDDEN');
  });
});
