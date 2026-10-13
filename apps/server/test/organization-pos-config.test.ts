/**
 * P5-05 — configuration d'un point de vente et gardes de désactivation, à travers le **vrai**
 * pipeline de commande : mode de garde obligatoire avec défaut par type (AV-163, BR-STK-010),
 * `organization.pos.configure` renforcée (`POS_CONFIG_INVALID`, source unique du mode de garde
 * INV-DIS-01, BR-DIS-014), registre de gardes de désactivation d'un emplacement ou d'un site
 * (INV-STK-07, BR-ADM-011 : solde, quota actif, transfert ouvert), API publique de lecture du PDV.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerSiteCommands } from '../src/modules/organization/application/commands/site-commands.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import { registerLocationCommands } from '../src/modules/organization/application/commands/location-commands.js';
import {
  custodyAt,
  findPosConfigBySalesLocation,
  findPosConfigBySite,
  LocationDeactivationGuardRegistry,
  PosConfigurationGuardRegistry,
} from '../src/modules/organization/application/public/index.js';
import { inventoryLocationDeactivationGuard } from '../src/modules/inventory/application/location-deactivation-guard.js';
import { inventoryPosConfigurationGuard } from '../src/modules/inventory/application/pos-configuration-guard.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestProduct,
  insertTestRole,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-08T09:00:00.000Z';

describe('organization — configuration du PDV et gardes de désactivation (P5-05)', () => {
  let pipeline: CommandPipelineService;
  let guards: LocationDeactivationGuardRegistry;
  let idGenerator: IdGenerator;
  let clock: Clock;
  let admin: string;
  let adminDevice: string;
  let zoneId: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-10-08T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    guards = new LocationDeactivationGuardRegistry();
    guards.register('inventory', inventoryLocationDeactivationGuard);
    const registry = new CommandHandlerRegistry();
    registerSiteCommands(registry, guards);
    const posGuards = new PosConfigurationGuardRegistry();
    posGuards.register('inventory', inventoryPosConfigurationGuard);
    registerPosCommands(registry, posGuards);
    registerLocationCommands(registry, guards);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'org.structure.manage', admin);
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

  async function createSite(siteType: string): Promise<string> {
    const siteId = freshUuid();
    const result = await send('organization.site.create', 'SITE', siteId, {
      code: siteId.slice(-8).toUpperCase(),
      name: 'Site P5-05',
      siteType,
      zoneId,
    });
    expect(result.status).toBe('APPLIED');
    return siteId;
  }

  async function createLocation(
    siteId: string,
    locationType: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const locationId = freshUuid();
    const result = await send('organization.location.create', 'LOCATION', locationId, {
      siteId,
      code: locationId.slice(-8).toUpperCase(),
      name: 'Emplacement P5-05',
      locationType,
      ...extra,
    });
    expect(result.status).toBe('APPLIED');
    return locationId;
  }

  async function newDevice(status = 'ACTIVE'): Promise<string> {
    return db.transaction().execute((trx) => insertTestDevice(trx, admin, { status }));
  }

  /** Un PDV prêt à configurer : site `POINT_DE_VENTE` et son emplacement de vente `POS`. */
  async function newPos(): Promise<{ siteId: string; salesLocationId: string }> {
    const siteId = await createSite('POINT_DE_VENTE');
    const salesLocationId = await createLocation(siteId, 'POS');
    return { siteId, salesLocationId };
  }

  async function configure(siteId: string, payload: Record<string, unknown>) {
    return send('organization.pos.configure', 'SITE', siteId, payload);
  }

  async function locationRow(locationId: string) {
    return db
      .selectFrom('organization_locations')
      .select(['custody_mode', 'designated_device_id', 'status'])
      .where('id', '=', toBin(locationId))
      .executeTakeFirstOrThrow();
  }

  async function reportPending(deviceId: string, pending: number): Promise<void> {
    await db
      .insertInto('sync_device_sync_state')
      .values({
        device_id: toBin(deviceId),
        dataset: '_device',
        last_push_at: new Date('2026-10-08T08:00:00.000Z'),
        pending_reported: pending,
      })
      .execute();
  }

  async function putStock(locationId: string, quantity: number): Promise<void> {
    const productId = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: fromBin(opening.id),
          toLocationId: locationId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 100,
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
  }

  describe('mode de garde obligatoire (AV-163, BR-STK-010)', () => {
    it('location.create écrit le défaut de son type quand le mode est omis', async () => {
      const siteId = await createSite('MAGASIN');
      const custodian = await db.transaction().execute((trx) => insertTestUser(trx));
      const store = await createLocation(siteId, 'STORE');
      const building = await createLocation(siteId, 'BUILDING');
      const pos = await createLocation(siteId, 'POS');
      const mobile = await createLocation(siteId, 'MOBILE', {
        custodyMode: 'EXCLUSIVE_USER',
        custodianUserId: custodian,
      });
      expect((await locationRow(store)).custody_mode).toBe('SHARED');
      expect((await locationRow(building)).custody_mode).toBe('SHARED');
      expect((await locationRow(pos)).custody_mode).toBe('SHARED');
      expect((await locationRow(mobile)).custody_mode).toBe('EXCLUSIVE_USER');
    });

    it('un mode explicite est respecté', async () => {
      const siteId = await createSite('MAGASIN');
      const device = await newDevice();
      const exclusive = await createLocation(siteId, 'STORE', {
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
      });
      const row = await locationRow(exclusive);
      expect(row.custody_mode).toBe('EXCLUSIVE_DEVICE');
      expect(fromBin(row.designated_device_id as Buffer)).toBe(device);
    });

    it('la base remplit le défaut d’un emplacement physique inséré sans mode (déclencheur)', async () => {
      const siteId = await createSite('MAGASIN');
      const id = freshUuid();
      await db
        .insertInto('organization_locations')
        .values({
          id: toBin(id),
          site_id: toBin(siteId),
          code: id.slice(-8).toUpperCase(),
          name: 'Sans mode',
          location_type: 'BUILDING',
          created_by: toBin(admin),
        })
        .execute();
      expect((await locationRow(id)).custody_mode).toBe('SHARED');
    });
  });

  describe('organization.pos.configure (UC-DIS-01, BR-DIS-002)', () => {
    it('reporte le mode et l’appareil désigné sur l’emplacement de vente (INV-DIS-01)', async () => {
      const { siteId, salesLocationId } = await newPos();
      const device = await newDevice();
      const result = await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
        openingHours: 'Lun–Sam 7h–18h',
      });
      expect(result.status).toBe('APPLIED');

      const location = await locationRow(salesLocationId);
      expect(location.custody_mode).toBe('EXCLUSIVE_DEVICE');
      expect(fromBin(location.designated_device_id as Buffer)).toBe(device);

      const config = await findPosConfigBySite(db, siteId);
      expect(config).toMatchObject({
        siteId,
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
        replenishmentSourceLocationId: null,
      });
      expect(await findPosConfigBySalesLocation(db, salesLocationId)).toEqual(config);
      expect(await findPosConfigBySalesLocation(db, freshUuid())).toBeNull();
    });

    it('SHARED ne désigne aucun appareil, même si l’un est fourni', async () => {
      const { siteId, salesLocationId } = await newPos();
      const device = await newDevice();
      const result = await configure(siteId, {
        salesLocationId,
        custodyMode: 'SHARED',
        designatedDeviceId: device,
      });
      expect(result.status).toBe('APPLIED');
      const location = await locationRow(salesLocationId);
      expect(location.custody_mode).toBe('SHARED');
      expect(location.designated_device_id).toBeNull();
      expect((await findPosConfigBySite(db, siteId))?.designatedDeviceId).toBeNull();
    });

    it('rejouer la même configuration est sans effet de bord (idempotence)', async () => {
      const { siteId, salesLocationId } = await newPos();
      const device = await newDevice();
      const payload = {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
      };
      expect((await configure(siteId, payload)).status).toBe('APPLIED');
      expect((await configure(siteId, payload)).status).toBe('APPLIED');
      expect((await findPosConfigBySite(db, siteId))?.designatedDeviceId).toBe(device);
    });

    it('refuse un site qui n’est pas un point de vente (NOT_A_POS)', async () => {
      const siteId = await createSite('MAGASIN');
      const salesLocationId = await createLocation(siteId, 'POS');
      const result = await configure(siteId, { salesLocationId, custodyMode: 'SHARED' });
      expect(result.status).toBe('REJECTED');
      expect(result).toMatchObject({ error: { code: 'NOT_A_POS' } });
    });

    it('refuse un emplacement de vente qui n’est pas un POS actif de ce site (POS_CONFIG_INVALID)', async () => {
      const { siteId } = await newPos();
      const otherSite = await createSite('POINT_DE_VENTE');
      const notPos = await createLocation(siteId, 'STORE');
      const foreign = await createLocation(otherSite, 'POS');

      for (const salesLocationId of [notPos, foreign]) {
        const result = await configure(siteId, { salesLocationId, custodyMode: 'SHARED' });
        expect(result.status).toBe('REJECTED');
        expect(result).toMatchObject({ error: { code: 'POS_CONFIG_INVALID' } });
      }

      const inactive = await createLocation(siteId, 'POS');
      const off = await send('organization.location.deactivate', 'LOCATION', inactive, {});
      expect(off.status).toBe('APPLIED');
      const result = await configure(siteId, { salesLocationId: inactive, custodyMode: 'SHARED' });
      expect(result).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });

      const missing = await configure(siteId, {
        salesLocationId: freshUuid(),
        custodyMode: 'SHARED',
      });
      expect(missing).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
    });

    it('refuse l’emplacement de vente déjà pris par un autre PDV (POS_CONFIG_INVALID)', async () => {
      const first = await newPos();
      const second = await newPos();
      expect(
        (
          await configure(first.siteId, {
            salesLocationId: first.salesLocationId,
            custodyMode: 'SHARED',
          })
        ).status,
      ).toBe('APPLIED');
      // Le site 2 est un autre site : son emplacement POS à lui est seul acceptable.
      const stolen = await configure(second.siteId, {
        salesLocationId: first.salesLocationId,
        custodyMode: 'SHARED',
      });
      expect(stolen).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });
    });

    it('le magasin source est un magasin actif d’un autre site', async () => {
      const { siteId, salesLocationId } = await newPos();
      const warehouseSite = await createSite('MAGASIN');
      const warehouse = await createLocation(warehouseSite, 'STORE');
      const sameSiteStore = await createLocation(siteId, 'STORE');
      const notStore = await createLocation(warehouseSite, 'BUILDING');

      for (const replenishmentSourceLocationId of [sameSiteStore, notStore]) {
        const result = await configure(siteId, {
          salesLocationId,
          replenishmentSourceLocationId,
          custodyMode: 'SHARED',
        });
        expect(result).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });
      }
      const ok = await configure(siteId, {
        salesLocationId,
        replenishmentSourceLocationId: warehouse,
        custodyMode: 'SHARED',
      });
      expect(ok.status).toBe('APPLIED');
      expect((await findPosConfigBySite(db, siteId))?.replenishmentSourceLocationId).toBe(
        warehouse,
      );
    });

    it('l’appareil désigné est actif et unique à un PDV (POS_CONFIG_INVALID)', async () => {
      const first = await newPos();
      const second = await newPos();
      const device = await newDevice();
      const pending = await newDevice('PENDING');
      const blocked = await newDevice('BLOCKED');

      for (const designatedDeviceId of [pending, blocked]) {
        const result = await configure(first.siteId, {
          salesLocationId: first.salesLocationId,
          custodyMode: 'EXCLUSIVE_DEVICE',
          designatedDeviceId,
        });
        expect(result).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });
      }

      expect(
        (
          await configure(first.siteId, {
            salesLocationId: first.salesLocationId,
            custodyMode: 'EXCLUSIVE_DEVICE',
            designatedDeviceId: device,
          })
        ).status,
      ).toBe('APPLIED');
      const twice = await configure(second.siteId, {
        salesLocationId: second.salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
      });
      expect(twice).toMatchObject({ status: 'REJECTED', error: { code: 'POS_CONFIG_INVALID' } });
    });

    it('EXCLUSIVE_DEVICE sans appareil est refusé dès la validation de la charge utile', async () => {
      const { siteId, salesLocationId } = await newPos();
      const result = await configure(siteId, { salesLocationId, custodyMode: 'EXCLUSIVE_DEVICE' });
      expect(result.status).toBe('REJECTED');
    });
  });

  describe('changement d’appareil désigné (BR-DIS-014)', () => {
    it('refusé tant que l’ancien appareil déclare des opérations en attente', async () => {
      const { siteId, salesLocationId } = await newPos();
      const oldDevice = await newDevice();
      const newerDevice = await newDevice();
      await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: oldDevice,
      });
      await reportPending(oldDevice, 3);

      const blocked = await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: newerDevice,
      });
      expect(blocked).toMatchObject({
        status: 'REJECTED',
        error: { code: 'POS_DEVICE_CHANGE_BLOCKED' },
      });
      // Passer en SHARED retire aussi l'appareil : même règle.
      const toShared = await configure(siteId, { salesLocationId, custodyMode: 'SHARED' });
      expect(toShared).toMatchObject({
        status: 'REJECTED',
        error: { code: 'POS_DEVICE_CHANGE_BLOCKED' },
      });
      expect((await findPosConfigBySite(db, siteId))?.designatedDeviceId).toBe(oldDevice);

      // Même appareil : changer les horaires n'est pas un changement d'appareil.
      const sameDevice = await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: oldDevice,
        openingHours: 'Tous les jours 8h–17h',
      });
      expect(sameDevice.status).toBe('APPLIED');
    });

    it('autorisé quand l’ancien appareil a tout synchronisé', async () => {
      const { siteId, salesLocationId } = await newPos();
      const oldDevice = await newDevice();
      const newerDevice = await newDevice();
      await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: oldDevice,
      });
      await reportPending(oldDevice, 0);

      const changed = await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: newerDevice,
      });
      expect(changed.status).toBe('APPLIED');
      const location = await locationRow(salesLocationId);
      expect(fromBin(location.designated_device_id as Buffer)).toBe(newerDevice);
    });

    it('autorisé quand l’ancien appareil est bloqué ou perdu, même avec des opérations en attente', async () => {
      const { siteId, salesLocationId } = await newPos();
      const oldDevice = await newDevice();
      const newerDevice = await newDevice();
      await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: oldDevice,
      });
      await reportPending(oldDevice, 7);
      await db
        .updateTable('identity_devices')
        .set({ status: 'LOST', status_changed_at: new Date() })
        .where('id', '=', toBin(oldDevice))
        .execute();

      const changed = await configure(siteId, {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: newerDevice,
      });
      expect(changed.status).toBe('APPLIED');
    });
  });

  describe('gardes de désactivation (INV-STK-07, BR-ADM-011, BR-DIS-001)', () => {
    it('désactive un emplacement vide, et rejouer la commande est sans effet', async () => {
      const siteId = await createSite('MAGASIN');
      const store = await createLocation(siteId, 'STORE');
      const first = await send('organization.location.deactivate', 'LOCATION', store, {});
      expect(first.status).toBe('APPLIED');
      expect((await locationRow(store)).status).toBe('INACTIVE');
      const again = await send('organization.location.deactivate', 'LOCATION', store, {});
      expect(again.status).toBe('APPLIED');
    });

    it('refuse l’emplacement de vente d’un PDV configuré (LOCATION_IS_POS_SALES_LOCATION)', async () => {
      const { siteId, salesLocationId } = await newPos();
      await configure(siteId, { salesLocationId, custodyMode: 'SHARED' });
      const result = await send(
        'organization.location.deactivate',
        'LOCATION',
        salesLocationId,
        {},
      );
      expect(result).toMatchObject({
        status: 'REJECTED',
        error: { code: 'LOCATION_IS_POS_SALES_LOCATION' },
      });
      expect((await locationRow(salesLocationId)).status).toBe('ACTIVE');
    });

    it('refuse un emplacement qui porte du stock (LOCATION_NOT_EMPTY)', async () => {
      const siteId = await createSite('MAGASIN');
      const store = await createLocation(siteId, 'STORE');
      await putStock(store, 12);
      const result = await send('organization.location.deactivate', 'LOCATION', store, {});
      expect(result).toMatchObject({ status: 'REJECTED', error: { code: 'LOCATION_NOT_EMPTY' } });
      expect((await locationRow(store)).status).toBe('ACTIVE');
    });

    it('refuse un emplacement qui porte un quota d’appareil actif (LOCATION_HAS_ALLOCATIONS)', async () => {
      const siteId = await createSite('MAGASIN');
      const store = await createLocation(siteId, 'STORE');
      const device = await newDevice();
      const holder = await db.transaction().execute((trx) => insertTestUser(trx));
      const productId = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
      const quotaId = freshUuid();
      await db
        .insertInto('inventory_stock_allocations')
        .values({
          id: toBin(quotaId),
          allocation_type: 'DEVICE_QUOTA',
          location_id: toBin(store),
          product_id: toBin(productId),
          holder_user_id: toBin(holder),
          holder_device_id: toBin(device),
          quantity_granted: '10',
          quantity_remaining: '10',
          granted_by: toBin(admin),
          created_by: toBin(admin),
        })
        .execute();
      // Registre du quota tenu comme par les commandes (INV-STK-20 : accordé = Σ octrois, reste = Σ
      // entrées), pour que le balayage de toute la base (p5-invariants.test.ts) ne le voie pas.
      const entry = (entryType: 'GRANT' | 'REVOKE', quantity: string) =>
        db
          .insertInto('inventory_stock_allocation_entries')
          .values({
            id: toBin(freshUuid()),
            allocation_id: toBin(quotaId),
            entry_type: entryType,
            quantity,
            occurred_at: new Date(OCCURRED_AT),
            created_by: toBin(admin),
          })
          .execute();
      await entry('GRANT', '10');
      try {
        const result = await send('organization.location.deactivate', 'LOCATION', store, {});
        expect(result).toMatchObject({
          status: 'REJECTED',
          error: { code: 'LOCATION_HAS_ALLOCATIONS' },
        });
      } finally {
        // Le quota de ce montage n'a pas de stock : il est révoqué, même si l'assertion échoue, pour que
        // la réconciliation de toute la base (INV-STK-19, INV-STK-20) ne le voie pas comme une anomalie.
        await entry('REVOKE', '-10');
        await db
          .updateTable('inventory_stock_allocations')
          .set({
            status: 'REVOKED',
            quantity_remaining: '0',
            revoked_at: new Date(OCCURRED_AT),
            revoked_by: toBin(admin),
            revoke_reason: 'Montage de test',
          })
          .where('id', '=', toBin(quotaId))
          .execute();
      }
    });

    it('refuse un emplacement partie à un transfert ouvert (LOCATION_HAS_OPEN_TRANSFER)', async () => {
      const siteId = await createSite('MAGASIN');
      const from = await createLocation(siteId, 'STORE');
      const to = await createLocation(siteId, 'STORE');
      await db
        .insertInto('inventory_stock_transfers')
        .values({
          id: toBin(freshUuid()),
          doc_number: `TR-P505-${freshUuid().slice(-8)}`,
          site_id: toBin(siteId),
          from_location_id: toBin(from),
          to_location_id: toBin(to),
          status: 'DISPATCHED',
          occurred_at: new Date(OCCURRED_AT),
          created_by: toBin(admin),
        })
        .execute();
      for (const location of [from, to]) {
        const result = await send('organization.location.deactivate', 'LOCATION', location, {});
        expect(result).toMatchObject({
          status: 'REJECTED',
          error: { code: 'LOCATION_HAS_OPEN_TRANSFER' },
        });
      }
    });

    it('un transfert terminé ne retient plus l’emplacement', async () => {
      const siteId = await createSite('MAGASIN');
      const from = await createLocation(siteId, 'STORE');
      const to = await createLocation(siteId, 'STORE');
      await db
        .insertInto('inventory_stock_transfers')
        .values({
          id: toBin(freshUuid()),
          doc_number: `TR-P505-${freshUuid().slice(-8)}`,
          site_id: toBin(siteId),
          from_location_id: toBin(from),
          to_location_id: toBin(to),
          status: 'CLOSED',
          occurred_at: new Date(OCCURRED_AT),
          created_by: toBin(admin),
        })
        .execute();
      const result = await send('organization.location.deactivate', 'LOCATION', from, {});
      expect(result.status).toBe('APPLIED');
    });

    it('la fermeture d’un site consulte les gardes de tous ses emplacements', async () => {
      const siteId = await createSite('MAGASIN');
      const empty = await createLocation(siteId, 'BUILDING');
      const stocked = await createLocation(siteId, 'STORE');
      await putStock(stocked, 5);

      const refused = await send('organization.site.close', 'SITE', siteId, {});
      expect(refused).toMatchObject({ status: 'REJECTED', error: { code: 'LOCATION_NOT_EMPTY' } });
      const site = await db
        .selectFrom('organization_sites')
        .select('status')
        .where('id', '=', toBin(siteId))
        .executeTakeFirstOrThrow();
      expect(site.status).toBe('ACTIVE');

      // Une fois vidé (sortie vers un emplacement virtuel de perte), le site se ferme.
      const loss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();
      const balance = await db
        .selectFrom('inventory_stock_balances')
        .select(['product_id', 'qty_on_hand'])
        .where('location_id', '=', toBin(stocked))
        .executeTakeFirstOrThrow();
      await db.transaction().execute((trx) =>
        recordStockMove(
          trx,
          { idGenerator },
          {
            productId: fromBin(balance.product_id),
            quantityBase: Number(balance.qty_on_hand),
            fromLocationId: stocked,
            toLocationId: fromBin(loss.id),
            moveType: 'LOSS',
            occurredAt: new Date(OCCURRED_AT),
            sourceDocType: 'LOSS',
            sourceDocId: freshUuid(),
            createdBy: admin,
            allowNegative: false,
          },
        ),
      );
      const closed = await send('organization.site.close', 'SITE', siteId, {});
      expect(closed.status).toBe('APPLIED');
      expect(empty).toBeTruthy();
    });
  });

  describe('passage en garde exclusive avec quotas actifs (P5-23, AV-195 (1), AV-230)', () => {
    /** Quota inséré comme par les commandes (registre tenu, INV-STK-20). */
    async function activeQuota(locationId: string, granted: number) {
      const device = await newDevice();
      const holder = await db.transaction().execute((trx) => insertTestUser(trx));
      const productId = await db.transaction().execute((trx) => insertTestProduct(trx, admin));
      const quotaId = freshUuid();
      await db
        .insertInto('inventory_stock_allocations')
        .values({
          id: toBin(quotaId),
          allocation_type: 'DEVICE_QUOTA',
          location_id: toBin(locationId),
          product_id: toBin(productId),
          holder_user_id: toBin(holder),
          holder_device_id: toBin(device),
          quantity_granted: String(granted),
          quantity_remaining: String(granted),
          granted_by: toBin(admin),
          created_by: toBin(admin),
        })
        .execute();
      const entry = (entryType: 'GRANT' | 'REVOKE', quantity: number) =>
        db
          .insertInto('inventory_stock_allocation_entries')
          .values({
            id: toBin(freshUuid()),
            allocation_id: toBin(quotaId),
            entry_type: entryType,
            quantity: String(quantity),
            occurred_at: new Date(OCCURRED_AT),
            created_by: toBin(admin),
          })
          .execute();
      await entry('GRANT', granted);
      /** Révocation, comme `inventory.allocation.revoke` : le reste sort du registre (une seule fois). */
      let revoked = false;
      const revoke = async () => {
        if (revoked) return;
        revoked = true;
        await entry('REVOKE', -granted);
        await db
          .updateTable('inventory_stock_allocations')
          .set({
            status: 'REVOKED',
            quantity_remaining: '0',
            revoked_at: new Date(OCCURRED_AT),
            revoked_by: toBin(admin),
            revoke_reason: 'Montage de test',
          })
          .where('id', '=', toBin(quotaId))
          .execute();
      };
      return { quotaId, revoke };
    }
    const posRow = (siteId: string) =>
      db
        .selectFrom('organization_points_of_sale')
        .select(['custody_mode', 'designated_device_id', 'version'])
        .where('site_id', '=', toBin(siteId))
        .executeTakeFirstOrThrow();

    it('quota actif : refus POS_ALLOCATIONS_ACTIVE, rien n’est écrit, la garde partagée reste configurable ; après la révocation, appliqué', async () => {
      const { siteId, salesLocationId } = await newPos();
      expect((await configure(siteId, { salesLocationId, custodyMode: 'SHARED' })).status).toBe(
        'APPLIED',
      );
      const before = await posRow(siteId);
      const device = await newDevice();
      const exclusive = {
        salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
      };
      let live: Awaited<ReturnType<typeof activeQuota>> | undefined;
      try {
        live = await activeQuota(salesLocationId, 10);
        const refused = await configure(siteId, exclusive);
        expect(refused).toMatchObject({
          status: 'REJECTED',
          error: { code: 'POS_ALLOCATIONS_ACTIVE' },
        });
        expect(refused.status === 'REJECTED' && refused.error.message_fr).toContain('1 quota(s)');
        expect(await posRow(siteId)).toEqual(before);
        expect(await locationRow(salesLocationId)).toMatchObject({
          custody_mode: 'SHARED',
          designated_device_id: null,
        });
        // Le PDV reste configurable en garde partagée (horaires) malgré son quota.
        const hours = await configure(siteId, {
          salesLocationId,
          custodyMode: 'SHARED',
          openingHours: '7 h – 19 h',
        });
        expect(hours.status).toBe('APPLIED');
      } finally {
        await live?.revoke();
      }
      const applied = await configure(siteId, exclusive);
      expect(applied.status, JSON.stringify(applied)).toBe('APPLIED');
      expect(await locationRow(salesLocationId)).toMatchObject({
        custody_mode: 'EXCLUSIVE_DEVICE',
      });
    });
  });

  describe('historique des gardes (P5-23, AV-195 (2), ADR-040)', () => {
    const periods = (locationId: string) =>
      db
        .selectFrom('organization_location_custody_periods')
        .select(['custody_mode', 'designated_device_id', 'valid_from', 'valid_to'])
        .where('location_id', '=', toBin(locationId))
        .orderBy('valid_from')
        .orderBy('created_at')
        .execute();

    it('custodyAt : période couvrante [début, fin) ; avant toute période, la plus ancienne qui a une durée — jamais une période vide', async () => {
      const siteId = await createSite('MAGASIN');
      const device = await newDevice();
      // Emplacement inséré sans commande (aucune période), puis un historique cohérent (INV-DIS-03) : une
      // période vide fermée, puis la période ouverte égale à la garde courante.
      const location = await db.transaction().execute(async (trx) => {
        const id = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
        await trx
          .updateTable('organization_locations')
          .set({ custody_mode: 'EXCLUSIVE_DEVICE', designated_device_id: toBin(device) })
          .where('id', '=', toBin(id))
          .execute();
        return id;
      });
      const T = new Date('2026-08-01T10:00:00.000Z');
      // Identifiants choisis (préfixe 00 puis ff, suffixe propre à l'emplacement) : la période vide passe la
      // première dans l'index, à même début.
      const prefix = location.replace(/-/g, '').slice(0, 30);
      await db
        .insertInto('organization_location_custody_periods')
        .values({
          id: Buffer.from(`00${prefix}`, 'hex'),
          location_id: toBin(location),
          custody_mode: 'SHARED',
          designated_device_id: null,
          valid_from: T,
          valid_to: T,
          command_id: null,
          created_by: toBin(admin),
        })
        .execute();
      await db
        .insertInto('organization_location_custody_periods')
        .values({
          id: Buffer.from(`ff${prefix}`, 'hex'),
          location_id: toBin(location),
          custody_mode: 'EXCLUSIVE_DEVICE',
          designated_device_id: toBin(device),
          valid_from: T,
          valid_to: null,
          command_id: null,
          created_by: toBin(admin),
        })
        .execute();
      const before = await custodyAt(db, location, new Date('2026-08-01T09:00:00.000Z'));
      expect(before).toMatchObject({ custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId: device });
      const after = await custodyAt(db, location, new Date('2026-08-01T11:00:00.000Z'));
      expect(after).toMatchObject({ custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId: device });
      expect(await custodyAt(db, await createLocation(siteId, 'STORE'), T)).toMatchObject({
        custodyMode: 'SHARED',
      }); // période initiale écrite par location.create, couvrante à sa date
    });

    it('location.create ouvre la période initiale ; pos.configure ferme la période et en ouvre une à chaque changement, rien au rejeu', async () => {
      const { siteId, salesLocationId } = await newPos();
      expect(await periods(salesLocationId)).toMatchObject([
        { custody_mode: 'SHARED', designated_device_id: null, valid_to: null },
      ]);
      const deviceA = await newDevice();
      const deviceB = await newDevice();
      const toA = { salesLocationId, custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId: deviceA };
      expect((await configure(siteId, toA)).status).toBe('APPLIED');
      expect((await configure(siteId, toA)).status).toBe('APPLIED'); // rejeu : aucune période de plus
      const afterA = await periods(salesLocationId);
      expect(afterA).toHaveLength(2);
      expect(afterA[0]).toMatchObject({ custody_mode: 'SHARED' });
      expect(afterA[0]!.valid_to?.toISOString()).toBe(OCCURRED_AT);
      expect(afterA[1]).toMatchObject({ custody_mode: 'EXCLUSIVE_DEVICE', valid_to: null });
      expect(fromBin(afterA[1]!.designated_device_id!)).toBe(deviceA);
      expect(afterA[1]!.valid_from.toISOString()).toBe(OCCURRED_AT);

      expect((await configure(siteId, { ...toA, designatedDeviceId: deviceB })).status).toBe(
        'APPLIED',
      );
      const afterB = await periods(salesLocationId);
      expect(afterB).toHaveLength(3);
      // Même date de commande : la période de A est vide, elle n'a jamais été en vigueur.
      expect(afterB[1]!.valid_to?.toISOString()).toBe(OCCURRED_AT);
      expect(fromBin(afterB[2]!.designated_device_id!)).toBe(deviceB);
      expect(afterB[2]!.valid_to).toBeNull();
      expect(await locationRow(salesLocationId)).toMatchObject({
        custody_mode: 'EXCLUSIVE_DEVICE',
      });
    });
  });

  describe('INV-DIS-01 — une seule source du mode de garde', () => {
    it('chaque PDV configuré a un emplacement de vente au mode et à l’appareil identiques', async () => {
      const a = await newPos();
      const b = await newPos();
      const device = await newDevice();
      await configure(a.siteId, {
        salesLocationId: a.salesLocationId,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: device,
      });
      await configure(b.siteId, { salesLocationId: b.salesLocationId, custodyMode: 'SHARED' });

      const divergent = await db
        .selectFrom('organization_points_of_sale as p')
        .innerJoin('organization_locations as l', 'l.id', 'p.sales_location_id')
        .select(['p.site_id'])
        .where((eb) =>
          eb.or([
            eb('l.custody_mode', 'is', null),
            eb('l.custody_mode', '<>', eb.ref('p.custody_mode')),
            eb.and([
              eb('p.designated_device_id', 'is', null),
              eb('l.designated_device_id', 'is not', null),
            ]),
            eb.and([
              eb('p.designated_device_id', 'is not', null),
              eb('l.designated_device_id', 'is', null),
            ]),
            eb.and([
              eb('p.designated_device_id', 'is not', null),
              eb('l.designated_device_id', '<>', eb.ref('p.designated_device_id')),
            ]),
          ]),
        )
        .execute();
      expect(divergent).toEqual([]);
    });

    it('aucun emplacement physique n’est sans mode de garde (base de test entière)', async () => {
      const rows = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('is_virtual', '=', 0)
        .where('custody_mode', 'is', null)
        .execute();
      expect(rows).toEqual([]);
    });
  });
});
