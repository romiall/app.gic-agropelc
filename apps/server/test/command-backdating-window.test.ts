/**
 * Fenêtre de saisie rétroactive (AV-078, BR-SYN-012) à travers le vrai pipeline de commande : l'écart
 * `client_created_at − occurred_at` au-delà de 24 h exige un motif, au-delà de 72 h la saisie est refusée sauf à qui a le
 * droit `sync.backdate.exceed` (chargement de l'historique) ; le motif est conservé dans l'audit. Une opération saisie
 * hors ligne puis synchronisée tard n'est pas rétroactive (les deux dates sont celles de l'appareil).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestPermission,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const HOUR = 60 * 60 * 1000;
/** Instant de saisie sur l'appareil (`client_created_at`) ; l'horloge du serveur est après. */
const CREATED = new Date('2026-10-02T14:00:00.000Z');
const NOW = new Date('2026-10-02T15:00:00.000Z');
const REASON = 'Carnet rapporté de tournée le lendemain';

describe('fenêtre de saisie rétroactive (AV-078, BR-SYN-012)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let author: string;
  let authorDevice: string;
  let loader: string;
  let loaderDevice: string;
  let siteId: string;

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerCountCommands(
      registry,
      new ApprovalDecisionHandlerRegistry(),
      idGenerator,
      new DocumentSequenceService(),
    );
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    author = await db.transaction().execute((trx) => insertTestUser(trx));
    authorDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, author, { status: 'ACTIVE' }));
    loader = await db.transaction().execute((trx) => insertTestUser(trx));
    loaderDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, loader, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, author);
      siteId = await insertTestSite(trx, author, zoneId);
      await insertTestPermission(trx, 'sync.backdate.exceed');
      const role = await insertTestRole(trx, author);
      await grantTestPermission(trx, role, 'inventory.count.perform', author);
      await assignTestRole(trx, author, role, author);
      // Celui qui charge l'historique : mêmes droits d'inventaire, plus le droit de dépasser la fenêtre.
      const loaderRole = await insertTestRole(trx, loader);
      await grantTestPermission(trx, loaderRole, 'inventory.count.perform', loader);
      await grantTestPermission(trx, loaderRole, 'sync.backdate.exceed', loader);
      await assignTestRole(trx, loader, loaderRole, loader);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function openCount(options: {
    readonly gapHours: number;
    readonly reason?: string | null;
    readonly as?: 'author' | 'loader';
  }) {
    const userId = options.as === 'loader' ? loader : author;
    const deviceId = options.as === 'loader' ? loaderDevice : authorDevice;
    const locationId = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, author, siteId, { locationType: 'STORE' }));
    const commandId = freshUuid();
    const result = await pipeline.handle(
      {
        command_id: commandId,
        device_seq: 1,
        command_type: 'inventory.count.open',
        command_version: 1,
        author_user_id: userId,
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: freshUuid(),
        base_version: null,
        depends_on: [],
        occurred_at: new Date(CREATED.getTime() - options.gapHours * HOUR).toISOString(),
        client_created_at: CREATED.toISOString(),
        captured_offline: false,
        backdated_reason: options.reason ?? null,
        attachment_ids: [],
        payload: { locationId, countType: 'FULL' },
      },
      { authenticatedUserId: userId, authenticatedDeviceId: deviceId, transport: 'ONLINE_API' },
    );
    return { result, commandId };
  }

  const code = (result: Awaited<ReturnType<typeof openCount>>['result']): string | undefined =>
    result.status === 'REJECTED' ? result.error.code : undefined;

  it('une saisie du jour ou de quelques heures passe sans motif', async () => {
    expect((await openCount({ gapHours: 0 })).result.status).toBe('APPLIED');
    expect((await openCount({ gapHours: 5 })).result.status).toBe('APPLIED');
  });

  it('la borne de 24 h est dans la fenêtre : aucun motif exigé', async () => {
    expect((await openCount({ gapHours: 24 })).result.status).toBe('APPLIED');
  });

  it('au-delà de 24 h sans motif : JUSTIFICATION_REQUIRED, rien n’est écrit', async () => {
    const { result, commandId } = await openCount({ gapHours: 30 });
    expect(code(result)).toBe('JUSTIFICATION_REQUIRED');
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select('status')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(inbox.status).toBe('REJECTED');
    const written = await db
      .selectFrom('audit_audit_log')
      .select('seq')
      .where('command_id', '=', toBin(commandId))
      .execute();
    expect(written).toHaveLength(0);
  });

  it('un motif de blancs ne vaut pas un motif', async () => {
    expect(code((await openCount({ gapHours: 30, reason: '   ' })).result)).toBe(
      'JUSTIFICATION_REQUIRED',
    );
  });

  it('au-delà de 24 h avec un motif : appliquée, et le motif est dans l’audit', async () => {
    const { result, commandId } = await openCount({ gapHours: 30, reason: REASON });
    expect(result.status).toBe('APPLIED');
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['reason', 'result'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ reason: REASON, result: 'SUCCESS' });
  });

  it('une saisie sans motif ne laisse aucun motif dans l’audit', async () => {
    const { commandId } = await openCount({ gapHours: 1 });
    const audit = await db
      .selectFrom('audit_audit_log')
      .select('reason')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBeNull();
  });

  it('la borne de 72 h passe avec un motif', async () => {
    expect((await openCount({ gapHours: 72, reason: REASON })).result.status).toBe('APPLIED');
  });

  it('au-delà de 72 h : BACKDATE_EXCEEDED, même avec un motif', async () => {
    expect(code((await openCount({ gapHours: 100, reason: REASON })).result)).toBe(
      'BACKDATE_EXCEEDED',
    );
    expect(code((await openCount({ gapHours: 100 })).result)).toBe('BACKDATE_EXCEEDED');
  });

  it('qui a le droit de charger l’historique dépasse la fenêtre, mais pas sans motif', async () => {
    expect(code((await openCount({ gapHours: 100, as: 'loader' })).result)).toBe(
      'JUSTIFICATION_REQUIRED',
    );
    const { result } = await openCount({ gapHours: 24 * 90, reason: REASON, as: 'loader' });
    expect(result.status).toBe('APPLIED');
  });

  it('une opération saisie hors ligne puis synchronisée tard n’est pas rétroactive', async () => {
    // Datée et saisie douze jours avant l’horloge du serveur : l’écart des deux dates de l’appareil est nul.
    const locationId = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, author, siteId, { locationType: 'STORE' }));
    const old = new Date(NOW.getTime() - 12 * 24 * HOUR).toISOString();
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_type: 'inventory.count.open',
        command_version: 1,
        author_user_id: author,
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: freshUuid(),
        base_version: null,
        depends_on: [],
        occurred_at: old,
        client_created_at: old,
        captured_offline: true,
        backdated_reason: null,
        attachment_ids: [],
        payload: { locationId, countType: 'FULL' },
      },
      { authenticatedUserId: author, authenticatedDeviceId: authorDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');
  });
});
