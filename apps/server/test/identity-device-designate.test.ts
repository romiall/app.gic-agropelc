/**
 * P5-06 — `identity.device.designate` (BR-DIS-003, AV-007) à travers le **vrai** pipeline de
 * commande : appareil partagé, site de rattachement, cohérence avec la désignation d'un PDV, rejeu
 * sans effet. Les événements `DeviceBlocked`, `DeviceDeclaredLost`, `UserDeactivated` du catalogue
 * sont les événements de domaine que le pipeline écrit pour `identity.device.block`,
 * `.declare_lost` et `identity.user.deactivate` (`event_type` = type de commande) : vérifiés ici
 * pour que leurs consommateurs (quotas d'appareil, P5-08) puissent s'y fier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerDeviceCommands } from '../src/modules/identity/application/commands/device-commands.js';
import { registerUserCommands } from '../src/modules/identity/application/commands/user-commands.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-08T09:00:00.000Z';

describe('identity.device.designate (P5-06, BR-DIS-003, AV-007)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;
  let zoneId: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-10-08T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerDeviceCommands(registry);
    registerUserCommands(registry);
    registerPosCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      for (const code of [
        'identity.device.approve',
        'identity.device.block',
        'identity.user.manage',
        'org.structure.manage',
      ]) {
        await grantTestPermission(trx, role, code, admin);
      }
      await assignTestRole(trx, admin, role, admin);
      zoneId = await insertTestZone(trx, admin);
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

  async function send(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ) {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        occurred_at: OCCURRED_AT,
        payload,
      },
      ctx(),
    );
  }

  const newDevice = (status = 'ACTIVE') =>
    db.transaction().execute((trx) => insertTestDevice(trx, admin, { status }));
  const newSite = (siteType = 'POINT_DE_VENTE') =>
    db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId, { siteType }));

  async function deviceRow(deviceId: string) {
    return db
      .selectFrom('identity_devices')
      .select(['is_shared', 'designated_site_id', 'version'])
      .where('id', '=', toBin(deviceId))
      .executeTakeFirstOrThrow();
  }

  it('rattache un appareil à un site et le déclare partagé ; rejouer est sans effet', async () => {
    const deviceId = await newDevice();
    const siteId = await newSite();

    const first = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: true,
      designatedSiteId: siteId,
    });
    expect(first.status).toBe('APPLIED');
    const after = await deviceRow(deviceId);
    expect(after.is_shared).toBe(1);
    expect(fromBin(after.designated_site_id as Buffer)).toBe(siteId);

    const again = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: true,
      designatedSiteId: siteId,
    });
    expect(again.status).toBe('APPLIED');
    expect((await deviceRow(deviceId)).version).toBe(after.version);
  });

  it('détache l’appareil (site nul) et le rend personnel', async () => {
    const deviceId = await newDevice();
    const siteId = await newSite();
    await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: true,
      designatedSiteId: siteId,
    });
    const result = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: null,
    });
    expect(result.status).toBe('APPLIED');
    const row = await deviceRow(deviceId);
    expect(row.is_shared).toBe(0);
    expect(row.designated_site_id).toBeNull();
  });

  it('refuse un appareil introuvable, perdu ou retiré, et un site inconnu ou fermé', async () => {
    const siteId = await newSite();
    const missing = await send('identity.device.designate', 'DEVICE', freshUuid(), {
      isShared: false,
      designatedSiteId: siteId,
    });
    expect(missing).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });

    for (const status of ['LOST', 'RETIRED']) {
      const deviceId = await newDevice(status);
      const result = await send('identity.device.designate', 'DEVICE', deviceId, {
        isShared: false,
        designatedSiteId: siteId,
      });
      expect(result).toMatchObject({
        status: 'REJECTED',
        error: { code: 'DEVICE_DESIGNATION_INVALID' },
      });
    }

    const deviceId = await newDevice();
    const unknownSite = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: freshUuid(),
    });
    expect(unknownSite).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });

    const closedSite = await newSite();
    await db
      .updateTable('organization_sites')
      .set({ status: 'CLOSED', closed_on: new Date('2026-10-01T00:00:00.000Z') })
      .where('id', '=', toBin(closedSite))
      .execute();
    const onClosed = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: closedSite,
    });
    expect(onClosed).toMatchObject({
      status: 'REJECTED',
      error: { code: 'DEVICE_DESIGNATION_INVALID' },
    });
  });

  it('l’appareil désigné d’un PDV ne se rattache pas à un autre site (BR-DIS-003)', async () => {
    const posSite = await newSite();
    const otherSite = await newSite();
    const salesLocationId = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, posSite, { locationType: 'POS' }));
    const deviceId = await newDevice();
    const configured = await send('organization.pos.configure', 'SITE', posSite, {
      salesLocationId,
      custodyMode: 'EXCLUSIVE_DEVICE',
      designatedDeviceId: deviceId,
    });
    expect(configured.status).toBe('APPLIED');

    const elsewhere = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: otherSite,
    });
    expect(elsewhere).toMatchObject({
      status: 'REJECTED',
      error: { code: 'DEVICE_DESIGNATION_INVALID' },
    });
    const detached = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: null,
    });
    expect(detached).toMatchObject({
      status: 'REJECTED',
      error: { code: 'DEVICE_DESIGNATION_INVALID' },
    });
    // Son propre site, tablette partagée : permis (AV-163 : tablette unique partagée du PDV).
    const own = await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: true,
      designatedSiteId: posSite,
    });
    expect(own.status).toBe('APPLIED');
  });

  it('pos.configure refuse un appareil rattaché à un autre site (BR-DIS-003)', async () => {
    const posSite = await newSite();
    const otherSite = await newSite();
    const salesLocationId = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, posSite, { locationType: 'POS' }));
    const deviceId = await newDevice();
    await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: otherSite,
    });
    const refused = await send('organization.pos.configure', 'SITE', posSite, {
      salesLocationId,
      custodyMode: 'EXCLUSIVE_DEVICE',
      designatedDeviceId: deviceId,
    });
    expect(refused).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });

    // Rattaché au bon site : accepté.
    await send('identity.device.designate', 'DEVICE', deviceId, {
      isShared: false,
      designatedSiteId: posSite,
    });
    const accepted = await send('organization.pos.configure', 'SITE', posSite, {
      salesLocationId,
      custodyMode: 'EXCLUSIVE_DEVICE',
      designatedDeviceId: deviceId,
    });
    expect(accepted.status).toBe('APPLIED');
  });

  describe('événements de domaine consommés par les quotas d’appareil (P5-08)', () => {
    async function eventsOf(aggregateId: string, eventType: string) {
      return db
        .selectFrom('platform_domain_events')
        .select(['event_type', 'producer_module', 'aggregate_id', 'occurred_at'])
        .where('aggregate_id', '=', toBin(aggregateId))
        .where('event_type', '=', eventType)
        .execute();
    }

    it('identity.device.block et .declare_lost écrivent un événement par transition effective', async () => {
      const blocked = await newDevice();
      const lost = await newDevice();
      expect(
        (await send('identity.device.block', 'DEVICE', blocked, { reason: 'Test P5-06' })).status,
      ).toBe('APPLIED');
      expect((await send('identity.device.declare_lost', 'DEVICE', lost, {})).status).toBe(
        'APPLIED',
      );
      const blockEvents = await eventsOf(blocked, 'identity.device.block');
      expect(blockEvents).toHaveLength(1);
      expect(blockEvents[0]?.producer_module).toBe('identity');
      expect(await eventsOf(lost, 'identity.device.declare_lost')).toHaveLength(1);
    });

    it('identity.user.deactivate écrit l’événement de désactivation de l’utilisateur', async () => {
      const userId = await db.transaction().execute((trx) => insertTestUser(trx));
      const result = await send('identity.user.deactivate', 'USER', userId, {
        reason: 'Départ (test P5-06)',
      });
      expect(result.status).toBe('APPLIED');
      expect(await eventsOf(userId, 'identity.user.deactivate')).toHaveLength(1);
    });
  });
});
