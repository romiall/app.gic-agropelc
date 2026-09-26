/** `procurement.supplier.*` (P1-05, fiche seule) à travers le vrai pipeline de commande. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerSupplierCommands } from '../src/modules/procurement/application/commands/supplier-commands.js';
import { listSuppliers } from '../src/modules/procurement/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const OCCURRED_AT = '2026-09-26T09:00:00.000Z';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerSupplierCommands(registry);
  return registry;
}

interface EnvelopeOverrides {
  readonly command_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

function buildEnvelope(
  authorUserId: string,
  overrides: EnvelopeOverrides,
): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    client_created_at: overrides.occurred_at,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

describe('procurement.supplier.* (P1-05)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-26T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'procurement.supplier.manage', admin);
      await assignTestRole(trx, admin, role, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const ctx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });

  it('create puis update puis deactivate/reactivate', async () => {
    const supplierId = freshUuid();
    const createResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.create',
        aggregate_type: 'SUPPLIER',
        aggregate_id: supplierId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `FRN-${supplierId.slice(-8)}`,
          name: 'Provende du Littoral',
          suppliedCategories: ['ALIMENTS'],
          phone: '+237600000002',
        },
      }),
      ctx(),
    );
    expect(createResult.status).toBe('APPLIED');

    const suppliers = await listSuppliers(db, { status: 'ACTIVE' });
    const created = suppliers.find((s) => s.id === supplierId);
    expect(created?.name).toBe('Provende du Littoral');
    expect(created?.suppliedCategories).toEqual(['ALIMENTS']);

    const updateResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.update',
        aggregate_type: 'SUPPLIER',
        aggregate_id: supplierId,
        occurred_at: OCCURRED_AT,
        payload: { paymentTermsDays: 30 },
      }),
      ctx(),
    );
    expect(updateResult.status).toBe('APPLIED');
    let row = await db
      .selectFrom('procurement_suppliers')
      .select(['payment_terms_days', 'version'])
      .where('id', '=', toBin(supplierId))
      .executeTakeFirstOrThrow();
    expect(row.payment_terms_days).toBe(30);
    expect(row.version).toBe(2);

    const deactivateResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.deactivate',
        aggregate_type: 'SUPPLIER',
        aggregate_id: supplierId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(deactivateResult.status).toBe('APPLIED');
    row = await db
      .selectFrom('procurement_suppliers')
      .select(['payment_terms_days', 'version'])
      .where('id', '=', toBin(supplierId))
      .executeTakeFirstOrThrow();
    const afterDeactivate = await db
      .selectFrom('procurement_suppliers')
      .select('status')
      .where('id', '=', toBin(supplierId))
      .executeTakeFirstOrThrow();
    expect(afterDeactivate.status).toBe('INACTIVE');

    const reactivateResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.reactivate',
        aggregate_type: 'SUPPLIER',
        aggregate_id: supplierId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(reactivateResult.status).toBe('APPLIED');
    const afterReactivate = await db
      .selectFrom('procurement_suppliers')
      .select('status')
      .where('id', '=', toBin(supplierId))
      .executeTakeFirstOrThrow();
    expect(afterReactivate.status).toBe('ACTIVE');
  });

  it('update — fournisseur introuvable -> REJECTED NOT_FOUND', async () => {
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.update',
        aggregate_type: 'SUPPLIER',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { name: 'Inexistant' },
      }),
      ctx(),
    );
    expect(result.status).toBe('REJECTED');
    expect(result).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
