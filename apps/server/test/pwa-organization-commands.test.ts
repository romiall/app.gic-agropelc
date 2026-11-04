/**
 * Écrans d'administration de la configuration (RP-1 ; ECR-ADM-06 et ECR-ADM-07, AV-492 à AV-497) : chaque commande
 * que ces écrans envoient est acceptée par le serveur **et écrit ce que l'écran a saisi**. L'essai rejoue la vraie
 * logique de la PWA (`organization.ts`, `settings.ts`, importées telles quelles) à travers le vrai service de
 * synchronisation et les vrais gestionnaires, puis relit la base.
 *
 * Pourquoi la relecture de la base : un schéma Zod ignore en silence un champ qu'il ne connaît pas. Une charge
 * dont un nom de champ diffère de celui du serveur serait « appliquée » sans rien écrire ; seul un contrôle de ce
 * qui est en base le montre (les essais d'écran, eux, figent le type et la charge écrits dans le code de la PWA, et
 * restent verts : constaté le 04/11/2026 sur l'écran de report des pièces papier, puis sur les identifiants
 * d'agrégat de RP-4).
 *
 * Base : jetable (`_rp`, `_test`). Les politiques créées sont retirées en fin d'essai.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { rawCommandEnvelopeSchema, type CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerZoneCommands } from '../src/modules/organization/application/commands/zone-commands.js';
import { registerSiteCommands } from '../src/modules/organization/application/commands/site-commands.js';
import { registerLocationCommands } from '../src/modules/organization/application/commands/location-commands.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import { registerTeamCommands } from '../src/modules/organization/application/commands/team-commands.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { OPERATION_TYPES } from '../src/modules/approvals/application/commands/operation-types.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  EMPTY_LOCATION_FORM,
  EMPTY_POS_FORM,
  EMPTY_SITE_FORM,
  EMPTY_TEAM_FORM,
  EMPTY_ZONE_FORM,
  locationCreateCommand,
  locationDeactivateCommand,
  locationUpdateCommand,
  posConfigureCommand,
  siteCloseCommand,
  siteCreateCommand,
  siteUpdateCommand,
  teamAssignCommand,
  teamCreateCommand,
  teamRemoveCommand,
  zoneActiveCommand,
  zoneCreateCommand,
  zoneFormOf,
  zoneUpdateCommand,
  type OrganizationCommand,
  type ZoneView,
} from '../../pwa/src/features/organization/organization.js';
import {
  policyCommand,
  settingCommand,
  type PolicyForm,
  type PolicyView,
} from '../../pwa/src/features/settings/settings.js';
import { OfflineDevice } from './device-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  recentBusinessDay,
} from './helpers.js';

const DAY = recentBusinessDay(3);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

/**
 * Un instant par commande, une minute après la précédente : dans l'usage réel deux actions de l'administrateur ne
 * tombent jamais à la même seconde, et le serveur refuse de fermer une appartenance à l'instant de son ouverture.
 */
let minutes = 9 * 60;
const nextInstant = (): string => {
  minutes += 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return at(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
};

/** Droits qu'exigent les commandes des deux écrans (portée globale : l'essai ne porte pas sur le RBAC). */
const PERMISSIONS = ['org.structure.manage', 'org.settings.manage', 'approvals.policy.manage'];

describe('écrans d’administration de la configuration (RP-1) : le serveur écrit ce que la PWA envoie', () => {
  const suffix = freshUuid().slice(-8).toUpperCase();
  let clock: Clock;
  let idGenerator: IdGenerator;
  let device: OfflineDevice;
  let admin: string;
  let manager: string;
  let member: string;
  let posDeviceId: string;
  // Identifiants produits comme l'écran les produit : `idGenerator.newId()`.
  const ids = {
    zoneRoot: '',
    zoneCity: '',
    siteStore: '',
    sitePos: '',
    siteOffice: '',
    locStore: '',
    locPos: '',
    locMobile: '',
    team: '',
  };
  const policyCodes: string[] = [];

  beforeAll(async () => {
    clock = new FixedClock(new Date(`${DAY}T13:00:00.000Z`));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerZoneCommands(registry);
    registerSiteCommands(registry);
    registerPosCommands(registry);
    registerLocationCommands(registry);
    registerTeamCommands(registry);
    registerSettingCommands(registry);
    registerPolicyCommands(registry);
    const pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    const services = {
      push: new SyncPushService(pipeline, db, clock),
      pull: new SyncPullService(db),
    };

    let adminDeviceId = '';
    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      manager = await insertTestUser(trx);
      member = await insertTestUser(trx);
      adminDeviceId = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      posDeviceId = await insertTestDevice(trx, manager, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, admin);
      for (const code of PERMISSIONS) await grantTestPermission(trx, role, code, admin);
      await assignTestRole(trx, admin, role, admin);
    });
    device = new OfflineDevice(services, adminDeviceId, clock);
  });

  afterAll(async () => {
    // Les politiques de l'essai ne doivent rien contrôler une fois l'essai fini.
    for (const code of policyCodes) {
      await db
        .updateTable('approvals_control_policies')
        .set({ status: 'RETIRED' })
        .where('code', '=', code)
        .execute();
    }
    await closeTestDb();
  });

  /** Commande de l'écran → file de l'appareil → `/sync/push` → réponse du serveur, appliquée. */
  async function send(command: OrganizationCommand | ReturnType<typeof settingCommand>) {
    const envelope = device.enqueue(admin, {
      type: command.commandType,
      aggregateType: command.aggregateType,
      aggregateId: command.aggregateId,
      occurredAt: nextInstant(),
      payload: command.payload,
      capturedOffline: false, // écrans en ligne seulement
    });
    expect(rawCommandEnvelopeSchema.safeParse(envelope).success, command.commandType).toBe(true);
    try {
      await device.syncUntilSettled(admin);
    } catch (error) {
      // Une commande que le serveur remet à plus tard (RETRY_LATER) : sa réponse dit pourquoi.
      const waiting = device
        .outbox()
        .filter((queued) => !queued.settled)
        .map((queued) => ({ type: queued.envelope.command_type, result: queued.result }));
      throw new Error(`${command.commandType} non réglée : ${JSON.stringify(waiting)}`, {
        cause: error,
      });
    }
    const result: CommandResult | undefined = device.resultOf(envelope.command_id);
    expect(result, `aucune réponse pour ${command.commandType}`).toBeDefined();
    expect(result!.status, `${command.commandType} : ${JSON.stringify(result)}`).toBe('APPLIED');
    return result!;
  }

  const zoneRow = (id: string) =>
    db
      .selectFrom('organization_zones')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const siteRow = (id: string) =>
    db
      .selectFrom('organization_sites')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const locationRow = (id: string) =>
    db
      .selectFrom('organization_locations')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();

  it('zones : racine, zone fille avec géorepère, puis réglage du géorepère et désactivation', async () => {
    ids.zoneRoot = idGenerator.newId();
    await send(
      zoneCreateCommand(
        { ...EMPTY_ZONE_FORM, code: `ZR${suffix}`, name: 'Cameroun (essai RP-1)', level: 'PAYS' },
        ids.zoneRoot,
      ),
    );
    expect(await zoneRow(ids.zoneRoot)).toMatchObject({
      code: `ZR${suffix}`,
      name: 'Cameroun (essai RP-1)',
      level: 'PAYS',
      parent_id: null,
    });

    ids.zoneCity = idGenerator.newId();
    await send(
      zoneCreateCommand(
        {
          ...EMPTY_ZONE_FORM,
          code: `ZV${suffix}`,
          name: 'Douala (essai RP-1)',
          level: 'VILLE',
          parentId: ids.zoneRoot,
          lat: '4.0511',
          lng: '9.7679',
          radiusM: '1500',
          maxGpsAccuracyM: '50',
        },
        ids.zoneCity,
      ),
    );
    const city = await zoneRow(ids.zoneCity);
    expect(city).toMatchObject({ code: `ZV${suffix}`, level: 'VILLE', is_active: 1 });
    expect(city.parent_id).toEqual(toBin(ids.zoneRoot));
    expect(Number(city.geofence_lat)).toBeCloseTo(4.0511, 4);
    expect(Number(city.geofence_lng)).toBeCloseTo(9.7679, 4);
    expect(Number(city.geofence_radius_m)).toBe(1500);
    expect(Number(city.max_gps_accuracy_m)).toBe(50);

    // Réglage du géorepère et de la précision, comme l'écran : seuls les champs modifiés partent.
    const view: ZoneView = {
      id: ids.zoneCity,
      parentId: ids.zoneRoot,
      code: `ZV${suffix}`,
      name: 'Douala (essai RP-1)',
      level: 'VILLE',
      depth: 1,
      geofence: { lat: 4.0511, lng: 9.7679, radiusM: 1500 },
      maxGpsAccuracyM: 50,
      isActive: true,
    };
    const update = zoneUpdateCommand(view, {
      ...zoneFormOf(view),
      radiusM: '2000',
      maxGpsAccuracyM: '80',
    });
    expect(update).not.toBeNull();
    await send(update!);
    const updated = await zoneRow(ids.zoneCity);
    expect(Number(updated.geofence_radius_m)).toBe(2000);
    expect(Number(updated.max_gps_accuracy_m)).toBe(80);

    // Désactivation puis réactivation (le serveur n'a pas de suppression : rien ne disparaît).
    await send(zoneActiveCommand({ ...view, geofence: null }, false));
    expect((await zoneRow(ids.zoneCity)).is_active).toBe(0);
    await send(zoneActiveCommand({ ...view, geofence: null }, true));
    expect((await zoneRow(ids.zoneCity)).is_active).toBe(1);
  });

  it('sites : un magasin, un point de vente et un bureau, mise à jour et fermeture', async () => {
    ids.siteStore = idGenerator.newId();
    await send(
      siteCreateCommand(
        {
          ...EMPTY_SITE_FORM,
          code: `M${suffix}`,
          name: 'Magasin central (essai RP-1)',
          siteType: 'MAGASIN',
          zoneId: ids.zoneCity,
          address: 'Rue des Palmiers, Bonabéri',
          openedOn: '2026-10-01',
        },
        ids.siteStore,
      ),
    );
    const store = await siteRow(ids.siteStore);
    expect(store).toMatchObject({
      code: `M${suffix}`,
      name: 'Magasin central (essai RP-1)',
      site_type: 'MAGASIN',
      address: 'Rue des Palmiers, Bonabéri',
      status: 'ACTIVE',
    });
    expect(store.zone_id).toEqual(toBin(ids.zoneCity));
    expect(store.opened_on?.toISOString().slice(0, 10)).toBe('2026-10-01');

    ids.sitePos = idGenerator.newId();
    await send(
      siteCreateCommand(
        {
          ...EMPTY_SITE_FORM,
          code: `P${suffix}`,
          name: 'Point de vente (essai RP-1)',
          siteType: 'POINT_DE_VENTE',
          zoneId: ids.zoneCity,
        },
        ids.sitePos,
      ),
    );
    expect(await siteRow(ids.sitePos)).toMatchObject({
      site_type: 'POINT_DE_VENTE',
      address: null,
    });

    ids.siteOffice = idGenerator.newId();
    await send(
      siteCreateCommand(
        {
          ...EMPTY_SITE_FORM,
          code: `B${suffix}`,
          name: 'Bureau (essai RP-1)',
          siteType: 'BUREAU',
          zoneId: ids.zoneCity,
          address: 'Avenue 1',
        },
        ids.siteOffice,
      ),
    );

    await send(
      siteUpdateCommand(
        ids.siteOffice,
        { name: 'Bureau (renommé, essai RP-1)', address: 'Avenue 2' },
        'Avenue 1',
      ),
    );
    expect(await siteRow(ids.siteOffice)).toMatchObject({
      name: 'Bureau (renommé, essai RP-1)',
      address: 'Avenue 2',
    });

    await send(siteCloseCommand(ids.siteOffice));
    const closed = await siteRow(ids.siteOffice);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closed_on).not.toBeNull();
  });

  it('emplacements : magasin, point de vente, emplacement mobile confié, puis mise à jour et désactivation', async () => {
    ids.locStore = idGenerator.newId();
    await send(
      locationCreateCommand(
        ids.siteStore,
        {
          ...EMPTY_LOCATION_FORM,
          code: `E1${suffix}`,
          name: 'Magasin (essai RP-1)',
          locationType: 'STORE',
          capacity: '5000',
        },
        ids.locStore,
      ),
    );
    const store = await locationRow(ids.locStore);
    expect(store).toMatchObject({
      code: `E1${suffix}`,
      name: 'Magasin (essai RP-1)',
      location_type: 'STORE',
      capacity: 5000,
      status: 'ACTIVE',
    });
    expect(store.site_id).toEqual(toBin(ids.siteStore));

    ids.locPos = idGenerator.newId();
    await send(
      locationCreateCommand(
        ids.sitePos,
        {
          ...EMPTY_LOCATION_FORM,
          code: `E2${suffix}`,
          name: 'Comptoir (essai RP-1)',
          locationType: 'POS',
        },
        ids.locPos,
      ),
    );
    expect(await locationRow(ids.locPos)).toMatchObject({ location_type: 'POS', capacity: null });

    ids.locMobile = idGenerator.newId();
    await send(
      locationCreateCommand(
        ids.sitePos,
        {
          ...EMPTY_LOCATION_FORM,
          code: `E3${suffix}`,
          name: 'Sacoche (essai RP-1)',
          locationType: 'MOBILE',
          custodianUserId: member,
        },
        ids.locMobile,
      ),
    );
    const mobile = await locationRow(ids.locMobile);
    expect(mobile).toMatchObject({ location_type: 'MOBILE', custody_mode: 'EXCLUSIVE_USER' });
    expect(mobile.custodian_user_id).toEqual(toBin(member));

    await send(
      locationUpdateCommand(ids.locStore, { name: 'Magasin (renommé)', capacity: '6000' }),
    );
    expect(await locationRow(ids.locStore)).toMatchObject({
      name: 'Magasin (renommé)',
      capacity: 6000,
    });

    await send(locationDeactivateCommand(ids.locMobile));
    expect((await locationRow(ids.locMobile)).status).toBe('INACTIVE');
  });

  it('point de vente : configuration partagée, puis appareil désigné', async () => {
    await send(
      posConfigureCommand(ids.sitePos, {
        ...EMPTY_POS_FORM,
        salesLocationId: ids.locPos,
        replenishmentSourceLocationId: ids.locStore,
        custodyMode: 'SHARED',
        openingHours: 'Lun-Sam 07:00-19:00',
      }),
    );
    const read = () =>
      db
        .selectFrom('organization_points_of_sale')
        .selectAll()
        .where('site_id', '=', toBin(ids.sitePos))
        .executeTakeFirstOrThrow();
    const shared = await read();
    expect(shared).toMatchObject({ custody_mode: 'SHARED', opening_hours: 'Lun-Sam 07:00-19:00' });
    expect(shared.sales_location_id).toEqual(toBin(ids.locPos));
    expect(shared.replenishment_source_location_id).toEqual(toBin(ids.locStore));

    await send(
      posConfigureCommand(ids.sitePos, {
        salesLocationId: ids.locPos,
        replenishmentSourceLocationId: ids.locStore,
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: posDeviceId,
        openingHours: '',
      }),
    );
    const exclusive = await read();
    expect(exclusive.custody_mode).toBe('EXCLUSIVE_DEVICE');
    expect(exclusive.designated_device_id).toEqual(toBin(posDeviceId));
  });

  it('équipes : création, affectation d’un membre, retrait', async () => {
    ids.team = idGenerator.newId();
    await send(
      teamCreateCommand(
        {
          ...EMPTY_TEAM_FORM,
          code: `T${suffix}`,
          name: 'Équipe (essai RP-1)',
          managerUserId: manager,
        },
        ids.team,
      ),
    );
    const team = await db
      .selectFrom('organization_teams')
      .selectAll()
      .where('id', '=', toBin(ids.team))
      .executeTakeFirstOrThrow();
    expect(team).toMatchObject({ code: `T${suffix}`, name: 'Équipe (essai RP-1)', is_active: 1 });
    expect(team.manager_user_id).toEqual(toBin(manager));

    // Une affectation crée une ligne d'appartenance neuve (`aggregate_id` frais), comme l'écran.
    await send(teamAssignCommand(ids.team, member, idGenerator.newId()));
    const openMemberships = () =>
      db
        .selectFrom('organization_team_memberships')
        .selectAll()
        .where('team_id', '=', toBin(ids.team))
        .where('user_id', '=', toBin(member))
        .where('valid_to', 'is', null)
        .execute();
    expect(await openMemberships()).toHaveLength(1);

    await send(teamRemoveCommand(member, idGenerator.newId()));
    expect(await openMemberships()).toHaveLength(0);
    // L'appartenance est fermée, jamais supprimée.
    const history = await db
      .selectFrom('organization_team_memberships')
      .select('valid_to')
      .where('team_id', '=', toBin(ids.team))
      .where('user_id', '=', toBin(member))
      .execute();
    expect(history).toHaveLength(1);
    expect(history[0]!.valid_to).not.toBeNull();
  });

  it('paramètres : une valeur globale et une valeur propre à un site, avec leur motif', async () => {
    const key = `rp1.essai.${suffix.toLowerCase()}`;
    await send(
      settingCommand(
        { key, value: 42, siteId: null, reason: 'Essai RP-1', isClientVisible: true },
        idGenerator.newId(),
      ),
    );
    await send(
      settingCommand(
        { key, value: 7, siteId: ids.sitePos, reason: '', isClientVisible: false },
        idGenerator.newId(),
      ),
    );
    const rows = await db
      .selectFrom('organization_system_settings')
      .selectAll()
      .where('key', '=', key)
      .orderBy('scope_type')
      .execute();
    expect(rows).toHaveLength(2);
    const global = rows.find((row) => row.scope_type === 'GLOBAL')!;
    const site = rows.find((row) => row.scope_type === 'SITE')!;
    expect(global).toMatchObject({ is_client_visible: 1, reason: 'Essai RP-1' });
    expect(JSON.parse(String(global.value))).toBe(42);
    expect(site.scope_id).toEqual(toBin(ids.sitePos));
    expect(site).toMatchObject({ is_client_visible: 0, reason: null });
    expect(JSON.parse(String(site.value))).toBe(7);
  });

  it('politiques de contrôle : une nouvelle version avec validation, comme l’écran', async () => {
    const code = `RP1-${suffix}`;
    policyCodes.push(code);
    const view: PolicyView = {
      id: idGenerator.newId(),
      code,
      version: 1,
      operationType: OPERATION_TYPES[0]!,
      condition: {},
      requiresPhoto: false,
      requiresComment: false,
      requiresApproval: false,
      approverPermission: null,
      approverScope: null,
      status: 'ACTIVE',
      validFrom: at('00:00'),
      validTo: null,
      createdAt: at('00:00'),
      createdByName: null,
    };
    const form: PolicyForm = {
      requiresPhoto: true,
      requiresComment: true,
      requiresApproval: true,
      approverPermission: 'org.structure.manage',
      approverScope: 'ALL',
    };
    await send(policyCommand(view, form, idGenerator.newId()));
    const row = await db
      .selectFrom('approvals_control_policies')
      .selectAll()
      .where('code', '=', code)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      operation_type: OPERATION_TYPES[0],
      requires_photo: 1,
      requires_comment: 1,
      requires_approval: 1,
      approver_permission: 'org.structure.manage',
      approver_scope: 'ALL',
      version: 1,
    });

    // Une révision sans validation n'envoie aucun approbateur et retire l'ancienne version.
    await send(
      policyCommand(
        { ...view, version: 1 },
        { ...form, requiresApproval: false, approverPermission: '', approverScope: 'ALL' },
        idGenerator.newId(),
      ),
    );
    const versions = await db
      .selectFrom('approvals_control_policies')
      .select(['version', 'status', 'requires_approval', 'approver_permission'])
      .where('code', '=', code)
      .orderBy('version')
      .execute();
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'RETIRED'],
      [2, 'ACTIVE'],
    ]);
    expect(versions[1]).toMatchObject({ requires_approval: 0, approver_permission: null });
  });
});
