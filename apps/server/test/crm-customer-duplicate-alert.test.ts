/**
 * P9-10 : alerte `DUPLICATE_SUSPECTED` du compte client (D13 §7.1, BR-CRM-006, BR-CRM-007, AV-419) —
 * `CustomerDuplicateSuspected` publié par `crm.customer.create` quand un doublon de téléphone est enregistré
 * hors ligne ; `CustomerDuplicateResolved` publié par `crm.customer.merge` quand le compte n'est plus un
 * doublon en attente. Les commandes passent par le vrai pipeline, avec les rôles réels du seed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerCustomerCommands } from '../src/modules/crm/application/commands/customer-commands.js';
import { registerPipelineCommands } from '../src/modules/crm/application/commands/pipeline-commands.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshLocalPhone,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const NOW = '2026-10-06T18:00:00.000Z';
const DAY = '2026-10-06';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('DUPLICATE_SUSPECTED : compte client en doublon, à la création hors ligne (P9-10)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let zoneId: string;
  let siteId: string;
  let cte1: Actor;
  let cte2: Actor;
  let rco: Actor;
  let ven: Actor;
  let dir: Actor;

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function run(
    actor: Actor,
    commandType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly commandId?: string } = {},
  ) {
    return pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'CUSTOMER',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  }

  async function createCustomer(
    actor: Actor,
    overrides: Record<string, unknown> = {},
    options: { readonly occurredAt?: string; readonly offline?: boolean } = {},
  ) {
    const id = freshUuid();
    const phone = await freshLocalPhone();
    const result = await run(
      actor,
      'crm.customer.create',
      id,
      options.occurredAt ?? at('08:00:00'),
      {
        displayName: 'Boutique test',
        zoneId,
        sourceCode: 'PROSPECTION_TERRAIN',
        phonePrimary: phone,
        ...overrides,
      },
      { offline: options.offline ?? false },
    );
    return { id, phone, result };
  }

  async function suspectedEvents(customerId: string) {
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'CustomerDuplicateSuspected')
        .where('aggregate_id', '=', toBin(customerId))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  async function resolvedEvents(customerId: string) {
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'CustomerDuplicateResolved')
        .where('aggregate_id', '=', toBin(customerId))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerCustomerCommands(registry, idGenerator);
    registerPipelineCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      cte: await roleId('COMMERCIAL_TERRAIN'),
      rco: await roleId('RESP_COMMERCIAL'),
      ven: await roleId('VENDEUR_PDV'),
      dir: await roleId('DIRECTION'),
    };
    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, admin, options);
        return { userId, deviceId };
      };
      cte1 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      cte2 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      const rcoUser = await insertTestUser(trx);
      const team = await insertTestTeam(trx, rcoUser, admin);
      await insertTestTeamMembership(trx, team, cte1.userId, admin);
      await insertTestTeamMembership(trx, team, cte2.userId, admin);
      await assignTestRole(trx, rcoUser, roles.rco, admin, {
        scopeType: 'TEAM',
        scopeTeamId: team,
      });
      rco = {
        userId: rcoUser,
        deviceId: await insertTestDevice(trx, rcoUser, { status: 'ACTIVE' }),
      };
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: siteId });
      dir = await actor(roles.dir);
    });
  });

  it('un compte sans doublon, en ligne ou hors ligne, ne publie rien', async () => {
    const online = await createCustomer(cte1);
    expect(online.result.status).toBe('APPLIED');
    const offline = await createCustomer(cte1, {}, { offline: true });
    expect(offline.result.status).toBe('APPLIED');
    expect(await suspectedEvents(online.id)).toEqual([]);
    expect(await suspectedEvents(offline.id)).toEqual([]);
  });

  it('doublon refusé en ligne : le compte n’existe pas et aucun événement ne reste', async () => {
    const original = await createCustomer(cte1);
    const refused = await createCustomer(cte2, { phonePrimary: original.phone });
    expect(refused.result.status).toBe('REJECTED');
    expect(await suspectedEvents(refused.id)).toEqual([]);
  });

  it('doublon créé hors ligne : un événement sur le nouveau compte, sans téléphone ni compte d’origine nommé', async () => {
    const first = await createCustomer(
      cte1,
      { displayName: 'Marché Mokolo - étal 12' },
      { occurredAt: at('08:00:00'), offline: true },
    );
    const second = await createCustomer(
      cte2,
      { phonePrimary: first.phone, displayName: 'Même boutique' },
      { occurredAt: at('09:00:00'), offline: true },
    );
    expect(second.result.status).toBe('APPLIED_WITH_WARNINGS');

    expect(await suspectedEvents(first.id)).toEqual([]);
    const events = await suspectedEvents(second.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.producerModule).toBe('crm');
    expect(event!.aggregateType).toBe('CUSTOMER');
    expect(event!.commandId).not.toBeNull();
    expect(event!.occurredAt.toISOString()).toBe(at('09:00:00'));
    expect(event!.payload).toEqual({
      kind: 'Compte client',
      reference: 'Même boutique',
      reason: 'SAME_PHONE',
      reason_label: 'Même numéro de téléphone principal',
      customer_id: second.id,
      existing_customer_id: first.id,
      zone_id: zoneId,
      site_id: null,
      owner_user_id: cte2.userId,
      acquired_by_user_id: cte2.userId,
      business_day: DAY,
      captured_offline: true,
    });
    // ADR-061 §4, RC-07 : ni le téléphone, ni le nom du compte d'origine dans la charge utile.
    const serialized = JSON.stringify(event!.payload);
    expect(serialized).not.toContain(first.phone);
    expect(serialized).not.toContain('Mokolo');
  });

  it('compte sans titulaire (vendeur de PDV) : rattaché au site, sans propriétaire', async () => {
    const first = await createCustomer(cte1, {}, { offline: true });
    const duplicate = await createCustomer(
      ven,
      { phonePrimary: first.phone },
      { occurredAt: at('09:30:00'), offline: true },
    );
    expect(duplicate.result.status, JSON.stringify(duplicate.result)).toBe('APPLIED_WITH_WARNINGS');
    const [event] = await suspectedEvents(duplicate.id);
    expect(event!.payload).toMatchObject({
      owner_user_id: null,
      site_id: siteId,
      acquired_by_user_id: ven.userId,
    });
  });

  it('rejeu de la création : un seul événement', async () => {
    const first = await createCustomer(cte1, {}, { offline: true });
    const commandId = freshUuid();
    const id = freshUuid();
    const payload = {
      displayName: 'Rejeu',
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: first.phone,
    };
    expect(
      (
        await run(cte2, 'crm.customer.create', id, at('09:00:00'), payload, {
          offline: true,
          commandId,
        })
      ).status,
    ).toBe('APPLIED_WITH_WARNINGS');
    // Même compte sous une autre commande : le gestionnaire reconnaît le compte et sort avant la publication.
    expect(
      (await run(cte2, 'crm.customer.create', id, at('09:00:00'), payload, { offline: true }))
        .status,
    ).toBe('APPLIED');
    expect(await suspectedEvents(id)).toHaveLength(1);
  });

  it('fusion : le compte absorbé qui était le doublon voit son alerte résolue ; le conservé non', async () => {
    const first = await createCustomer(cte1, {}, { occurredAt: at('08:00:00'), offline: true });
    const second = await createCustomer(
      cte2,
      { phonePrimary: first.phone },
      { occurredAt: at('09:00:00'), offline: true },
    );
    expect(second.result.status).toBe('APPLIED_WITH_WARNINGS');
    const merged = await run(rco, 'crm.customer.merge', second.id, at('12:00:00'), {
      intoCustomerId: first.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');

    expect(await resolvedEvents(first.id)).toEqual([]);
    const events = await resolvedEvents(second.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.producerModule).toBe('crm');
    expect(events[0]!.occurredAt.toISOString()).toBe(at('12:00:00'));
    expect(events[0]!.payload).toEqual({
      customer_id: second.id,
      resolution: 'MERGE',
      kept_customer_id: first.id,
      merged_customer_id: second.id,
      decided_by: rco.userId,
    });
  });

  it('fusion (variante AT-012) : le doublon est le compte conservé — son alerte est résolue', async () => {
    const appliedFirst = await createCustomer(
      cte1,
      {},
      { occurredAt: at('10:00:00'), offline: true },
    );
    const acquiredFirst = await createCustomer(
      cte2,
      { phonePrimary: appliedFirst.phone },
      { occurredAt: at('07:00:00'), offline: true },
    );
    expect(acquiredFirst.result.status).toBe('APPLIED_WITH_WARNINGS');
    expect(await suspectedEvents(acquiredFirst.id)).toHaveLength(1);
    const merged = await run(rco, 'crm.customer.merge', appliedFirst.id, at('12:00:00'), {
      intoCustomerId: acquiredFirst.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');
    // Le compte conservé (acquis en premier) n'est plus un doublon en attente ; l'absorbé n'en était pas un.
    expect(await resolvedEvents(appliedFirst.id)).toEqual([]);
    const events = await resolvedEvents(acquiredFirst.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      customer_id: acquiredFirst.id,
      kept_customer_id: acquiredFirst.id,
      merged_customer_id: appliedFirst.id,
    });
  });

  it('fusion de deux comptes sans lien de doublon : aucun événement de résolution', async () => {
    const x = await createCustomer(cte1, {}, { occurredAt: at('07:00:00') });
    const y = await createCustomer(cte1, {}, { occurredAt: at('08:00:00') });
    const merged = await run(dir, 'crm.customer.merge', y.id, at('12:00:00'), {
      intoCustomerId: x.id,
    });
    expect(merged.status).toBe('APPLIED');
    expect(await resolvedEvents(x.id)).toEqual([]);
    expect(await resolvedEvents(y.id)).toEqual([]);
  });

  it('le compte conservé, doublon d’un tiers, garde son alerte quand il absorbe un compte étranger', async () => {
    const third = await createCustomer(cte1, {}, { occurredAt: at('06:00:00'), offline: true });
    const kept = await createCustomer(
      cte2,
      { phonePrimary: third.phone },
      { occurredAt: at('07:00:00'), offline: true },
    );
    expect(kept.result.status).toBe('APPLIED_WITH_WARNINGS');
    const absorbed = await createCustomer(cte1, {}, { occurredAt: at('08:00:00') });
    const merged = await run(dir, 'crm.customer.merge', absorbed.id, at('12:00:00'), {
      intoCustomerId: kept.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');
    // Le compte conservé reste le doublon de `third` : son alerte n'est pas fermée ; l'absorbé n'en avait pas.
    expect(await resolvedEvents(kept.id)).toEqual([]);
    expect(await resolvedEvents(absorbed.id)).toEqual([]);
  });

  it('un autre doublon du compte absorbé, repointé vers le conservé, garde son alerte', async () => {
    const original = await createCustomer(cte1, {}, { occurredAt: at('07:00:00'), offline: true });
    const dupA = await createCustomer(
      cte2,
      { phonePrimary: original.phone },
      { occurredAt: at('08:00:00'), offline: true },
    );
    expect(dupA.result.status).toBe('APPLIED_WITH_WARNINGS');
    const other = await createCustomer(cte1, {}, { occurredAt: at('06:00:00') });
    // L'original est absorbé par un autre compte plus ancien : dupA (qui pointait vers lui) est repointé.
    const merged = await run(dir, 'crm.customer.merge', original.id, at('12:00:00'), {
      intoCustomerId: other.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');
    expect(await resolvedEvents(original.id)).toEqual([]);
    expect(await resolvedEvents(other.id)).toEqual([]);
    expect(await resolvedEvents(dupA.id)).toEqual([]);
  });

  it('bout en bout : l’alerte est levée à la création en doublon puis résolue par la fusion', async () => {
    const first = await createCustomer(cte1, {}, { occurredAt: at('08:00:00'), offline: true });
    const second = await createCustomer(
      cte2,
      { phonePrimary: first.phone, displayName: 'Même boutique' },
      { occurredAt: at('09:00:00'), offline: true },
    );
    const [suspected] = await suspectedEvents(second.id);
    await run(rco, 'crm.customer.merge', second.id, at('12:00:00'), { intoCustomerId: first.id });
    const [resolved] = await resolvedEvents(second.id);
    expect(suspected).toBeDefined();
    expect(resolved).toBeDefined();

    await rolledBack(async (uow: UnitOfWork) => {
      await handleAlertEvent(uow, suspected!, { idGenerator });
      const open = await uow
        .selectFrom('communication_alerts')
        .select(['severity', 'status', 'title', 'message', 'owner_user_id', 'zone_id', 'nature'])
        .where('dedup_key', '=', `DUPLICATE_SUSPECTED:${second.id}`)
        .execute();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        title: 'Doublon suspecté',
        nature: 'EVENT',
      });
      expect(fromBin(open[0]!.owner_user_id as Buffer)).toBe(cte2.userId);
      expect(fromBin(open[0]!.zone_id as Buffer)).toBe(zoneId);
      expect(open[0]!.message).toContain('Objet : Compte client');
      expect(open[0]!.message).toContain('Référence : Même boutique');
      expect(open[0]!.message).toContain('Motif : Même numéro de téléphone principal');

      await handleAlertEvent(uow, resolved!, { idGenerator });
      const closed = await uow
        .selectFrom('communication_alerts')
        .select(['status'])
        .where('dedup_key', '=', `DUPLICATE_SUSPECTED:${second.id}`)
        .execute();
      expect(closed.map((row) => row.status)).toEqual(['RESOLVED']);
    });
  });
});
