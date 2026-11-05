import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../admin/parse.js';
import {
  EMPTY_LOCATION_FORM,
  EMPTY_POS_FORM,
  EMPTY_SITE_FORM,
  EMPTY_TEAM_FORM,
  EMPTY_ZONE_FORM,
  flattenZones,
  formatCoordinate,
  isValidCode,
  locationCreateCommand,
  locationProblems,
  locationUpdateCommand,
  locationsPath,
  moveTargetsOf,
  normalizeCode,
  parseCapacity,
  posConfigureCommand,
  posFormOf,
  posProblems,
  salesLocationChoices,
  siteCloseCommand,
  siteCreateCommand,
  siteProblems,
  siteUpdateCommand,
  sourceChoices,
  TEAM_CLOSE_REASON_MAX,
  teamAssignCommand,
  teamCloseCommand,
  teamCreateCommand,
  teamOfUser,
  teamProblems,
  teamRemoveCommand,
  zoneActiveCommand,
  zoneCreateCommand,
  zoneFormOf,
  zoneMoveCommand,
  zoneProblems,
  zoneTree,
  zoneUpdateCommand,
  type LocationView,
  type PosView,
  type TeamView,
  type ZoneView,
} from './organization.js';

const zone = (overrides: Partial<ZoneView> = {}): ZoneView => ({
  id: 'z1',
  parentId: null,
  code: 'CMR',
  name: 'Cameroun',
  level: 'PAYS',
  depth: 1,
  geofence: null,
  maxGpsAccuracyM: null,
  isActive: true,
  ...overrides,
});

const location = (overrides: Partial<LocationView> = {}): LocationView => ({
  id: 'l1',
  siteId: 's1',
  parentLocationId: null,
  code: 'MAG',
  name: 'Magasin',
  locationType: 'STORE',
  isVirtual: false,
  custodyMode: 'SHARED',
  custodianUserId: null,
  capacity: null,
  status: 'ACTIVE',
  ...overrides,
});

describe('Organisation : saisies (ECR-ADM-06)', () => {
  it('codes : majuscules, lettres, chiffres, tiret et tiret bas, longueur bornée', () => {
    expect(normalizeCode('  mc-1 ')).toBe('MC-1');
    expect(isValidCode('MC-1', 10)).toBe(true);
    expect(isValidCode('MC 1', 10)).toBe(false);
    expect(isValidCode('-MC', 10)).toBe(false);
    expect(isValidCode('', 10)).toBe(false);
    expect(isValidCode('ABCDEFGHIJK', 10)).toBe(false);
  });

  it('nombres avec virgule ou point, coordonnées à six décimales', () => {
    expect(parseDecimal('4,05')).toBe(4.05);
    expect(parseDecimal(' -9.7 ')).toBe(-9.7);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('4,0,5')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(formatCoordinate(4.0510563)).toBe('4.051056');
    expect(parseCapacity('')).toBeNull();
    expect(parseCapacity('12')).toBe(12);
    expect(parseCapacity('0')).toBe('INVALID');
    expect(parseCapacity('1,5')).toBe('INVALID');
  });
});

describe('Organisation : sites et emplacements', () => {
  it('un site exige code, nom et zone ; la date, si saisie, est un jour', () => {
    expect(siteProblems(EMPTY_SITE_FORM)).toEqual(['CODE', 'NAME', 'ZONE']);
    const form = { ...EMPTY_SITE_FORM, code: 'mc', name: 'Magasin central', zoneId: 'z1' };
    expect(siteProblems(form)).toEqual([]);
    expect(siteProblems({ ...form, openedOn: '5 janvier' })).toEqual(['DATE']);
    expect(siteProblems({ ...form, code: 'TROPLONGUEMENT' })).toEqual(['CODE']);
  });

  it('commandes de site : création normalisée, modification, fermeture sur l’agrégat du site', () => {
    const form = {
      ...EMPTY_SITE_FORM,
      code: ' mc ',
      name: ' Magasin central ',
      siteType: 'MAGASIN' as const,
      zoneId: 'z1',
      address: ' Rue 1 ',
      openedOn: '2026-01-05',
    };
    expect(siteCreateCommand(form, 'id-1')).toEqual({
      commandType: 'organization.site.create',
      aggregateType: 'SITE',
      aggregateId: 'id-1',
      payload: {
        code: 'MC',
        name: 'Magasin central',
        siteType: 'MAGASIN',
        zoneId: 'z1',
        address: 'Rue 1',
        openedOn: '2026-01-05',
      },
    });
    expect(siteCreateCommand({ ...form, address: '', openedOn: '' }, 'id-1').payload).toEqual({
      code: 'MC',
      name: 'Magasin central',
      siteType: 'MAGASIN',
      zoneId: 'z1',
    });
    expect(siteUpdateCommand('s1', { name: ' Nouveau ', address: '' })).toMatchObject({
      commandType: 'organization.site.update',
      aggregateId: 's1',
      payload: { name: 'Nouveau' },
    });
    // L'adresse ne part que si elle change ; effacée, elle part vide (le serveur la remplace).
    expect(siteUpdateCommand('s1', { name: 'A', address: ' Rue 1 ' }, 'Rue 1').payload).toEqual({
      name: 'A',
    });
    expect(siteUpdateCommand('s1', { name: 'A', address: 'Rue 2' }, 'Rue 1').payload).toEqual({
      name: 'A',
      address: 'Rue 2',
    });
    expect(siteUpdateCommand('s1', { name: 'A', address: '  ' }, 'Rue 1').payload).toEqual({
      name: 'A',
      address: '',
    });
    expect(siteUpdateCommand('s1', { name: 'A', address: '' }, null).payload).toEqual({
      name: 'A',
    });
    expect(siteCloseCommand('s1')).toMatchObject({
      commandType: 'organization.site.close',
      aggregateType: 'SITE',
      aggregateId: 's1',
      payload: {},
    });
  });

  it('un emplacement mobile exige un titulaire ; la capacité est un entier positif', () => {
    const form = { ...EMPTY_LOCATION_FORM, code: 'MAG', name: 'Magasin' };
    expect(locationProblems(EMPTY_LOCATION_FORM)).toEqual(['CODE', 'NAME']);
    expect(locationProblems(form)).toEqual([]);
    expect(locationProblems({ ...form, capacity: '-3' })).toEqual(['CAPACITY']);
    expect(locationProblems({ ...form, locationType: 'MOBILE' })).toEqual(['CUSTODIAN']);
    expect(locationProblems({ ...form, locationType: 'MOBILE', custodianUserId: 'u1' })).toEqual(
      [],
    );
  });

  it('commandes d’emplacement : mobile confié à une personne, mise à jour, désactivation', () => {
    const form = { ...EMPTY_LOCATION_FORM, code: 'veh1', name: 'Véhicule', capacity: '40' };
    expect(locationCreateCommand('s1', form, 'l9').payload).toEqual({
      siteId: 's1',
      code: 'VEH1',
      name: 'Véhicule',
      locationType: 'STORE',
      capacity: 40,
    });
    expect(
      locationCreateCommand(
        's1',
        { ...form, locationType: 'MOBILE', custodianUserId: 'u1', parentLocationId: 'l0' },
        'l9',
      ).payload,
    ).toMatchObject({
      locationType: 'MOBILE',
      custodyMode: 'EXCLUSIVE_USER',
      custodianUserId: 'u1',
      parentLocationId: 'l0',
    });
    expect(locationUpdateCommand('l1', { name: ' Renommé ', capacity: '' })).toMatchObject({
      commandType: 'organization.location.update',
      payload: { name: 'Renommé' },
    });
    expect(locationsPath('a b')).toBe('/api/v1/locations?site_id=a%20b');
  });
});

describe('Organisation : zones et géorepères', () => {
  it('le géorepère est facultatif ; saisi, latitude et longitude sont obligatoires et bornées', () => {
    const base = { ...EMPTY_ZONE_FORM, code: 'DLA', name: 'Douala' };
    expect(zoneProblems(EMPTY_ZONE_FORM, 'CREATE')).toEqual(['CODE', 'NAME']);
    expect(zoneProblems(base, 'CREATE')).toEqual([]);
    expect(zoneProblems({ ...base, lat: '4,05' }, 'CREATE')).toEqual(['LNG']);
    expect(zoneProblems({ ...base, lat: '91', lng: '181' }, 'CREATE')).toEqual(['LAT', 'LNG']);
    expect(zoneProblems({ ...base, lat: '4', lng: '9', radiusM: '10' }, 'CREATE')).toEqual([
      'RADIUS',
    ]);
    expect(zoneProblems({ ...base, lat: '4', lng: '9', radiusM: '6000' }, 'CREATE')).toEqual([
      'RADIUS',
    ]);
    expect(zoneProblems({ ...base, lat: '4', lng: '9', radiusM: '500' }, 'CREATE')).toEqual([]);
    expect(zoneProblems({ ...base, maxGpsAccuracyM: '0' }, 'CREATE')).toEqual(['ACCURACY']);
    // La modification ne redemande pas le code.
    expect(zoneProblems({ ...base, code: '' }, 'UPDATE')).toEqual([]);
  });

  it('création : code normalisé, position et rayon en nombres, rayon par défaut laissé au serveur', () => {
    const form = {
      ...EMPTY_ZONE_FORM,
      code: 'dla',
      name: ' Douala ',
      level: 'VILLE' as const,
      parentId: 'z1',
      lat: '4,051056',
      lng: '9.767869',
      radiusM: '',
      maxGpsAccuracyM: '120',
    };
    expect(zoneCreateCommand(form, 'z2')).toEqual({
      commandType: 'organization.zone.create',
      aggregateType: 'ZONE',
      aggregateId: 'z2',
      payload: {
        code: 'DLA',
        name: 'Douala',
        level: 'VILLE',
        parentId: 'z1',
        lat: 4.051056,
        lng: 9.767869,
        maxGpsAccuracyM: 120,
      },
    });
    expect(
      zoneCreateCommand({ ...EMPTY_ZONE_FORM, code: 'X', name: 'Sans repère' }, 'z3').payload,
    ).toEqual({ code: 'X', name: 'Sans repère', level: 'VILLE' });
  });

  it('modification : seuls les champs changés partent ; retirer le géorepère envoie null', () => {
    const current = zone({
      geofence: { lat: 4.051056, lng: 9.767869, radiusM: 500 },
      maxGpsAccuracyM: 150,
    });
    const form = zoneFormOf(current);
    expect(zoneUpdateCommand(current, form)).toBeNull();
    expect(zoneUpdateCommand(current, { ...form, name: 'Douala centre' })?.payload).toEqual({
      name: 'Douala centre',
    });
    expect(zoneUpdateCommand(current, { ...form, radiusM: '300' })?.payload).toEqual({
      geofence: { lat: 4.051056, lng: 9.767869, radiusM: 300 },
    });
    expect(zoneUpdateCommand(current, { ...form, lat: '', lng: '', radiusM: '' })?.payload).toEqual(
      {
        geofence: null,
      },
    );
    expect(zoneUpdateCommand(current, { ...form, maxGpsAccuracyM: '80' })?.payload).toEqual({
      maxGpsAccuracyM: 80,
    });
    // Une zone sans géorepère qui n'en reçoit pas n'envoie rien.
    expect(zoneUpdateCommand(zone(), zoneFormOf(zone()))).toBeNull();
    expect(
      zoneUpdateCommand(zone(), { ...zoneFormOf(zone()), lat: '4', lng: '9' })?.payload,
    ).toEqual({ geofence: { lat: 4, lng: 9 } });
    expect(zoneActiveCommand(zone(), false)).toMatchObject({
      commandType: 'organization.zone.update',
      aggregateId: 'z1',
      payload: { isActive: false },
    });
  });

  it('arbre : racines, enfants triés par code, parent absent de la lecture = racine', () => {
    const zones = [
      zone({ id: 'c', parentId: 'a', code: 'B2', name: 'B2', depth: 2 }),
      zone({ id: 'a', code: 'A', name: 'A' }),
      zone({ id: 'd', parentId: 'a', code: 'B1', name: 'B1', depth: 2 }),
      zone({ id: 'o', parentId: 'inconnu', code: 'O', name: 'Orpheline', depth: 3 }),
    ];
    expect(flattenZones(zoneTree(zones)).map((row) => [row.zone.name, row.level])).toEqual([
      ['A', 0],
      ['B1', 1],
      ['B2', 1],
      ['Orpheline', 0],
    ]);
    expect(zoneTree([])).toEqual([]);
  });

  it('déplacement (AV-515) : ni elle-même, ni ses descendantes, ni sa parente actuelle, ni une zone inactive', () => {
    const zones = [
      zone({ id: 'a', code: 'A', name: 'A' }),
      zone({ id: 'b', parentId: 'a', code: 'B', name: 'B', depth: 2 }),
      zone({ id: 'c', parentId: 'b', code: 'C', name: 'C', depth: 3 }),
      zone({ id: 'd', code: 'D', name: 'D' }),
      zone({ id: 'e', parentId: 'd', code: 'E', name: 'E', depth: 2 }),
      zone({ id: 'f', code: 'F', name: 'F', isActive: false }),
    ];
    const names = (target: ZoneView) => moveTargetsOf(target, zones).map((row) => row.name);
    // B sous D ou E (ou à la racine, qui n'est pas une zone) : pas A (sa parente), ni C (sa fille), ni F (inactive).
    expect(names(zones[1]!)).toEqual(['D', 'E']);
    expect(names(zones[0]!)).toEqual(['D', 'E']);
    // Une zone racine peut aller sous n'importe quelle zone active qui n'est pas dans sa branche.
    expect(names(zones[3]!)).toEqual(['A', 'B', 'C']);
    // Jamais sous une descendante, même lointaine.
    expect(names(zones[1]!)).not.toContain('C');
    expect(zoneMoveCommand(zones[1]!, 'e')).toEqual({
      commandType: 'organization.zone.move',
      aggregateType: 'ZONE',
      aggregateId: 'b',
      payload: { parentId: 'e' },
    });
    // La racine s'écrit `null`.
    expect(zoneMoveCommand(zones[1]!, '').payload).toEqual({ parentId: null });
  });
});

describe('Organisation : équipes et points de vente', () => {
  const team = (overrides: Partial<TeamView> = {}): TeamView => ({
    id: 't1',
    code: 'LIT',
    name: 'Littoral',
    managerUserId: 'u1',
    managerName: 'Awa',
    isActive: true,
    members: [
      { membershipId: 'm1', userId: 'u2', since: '2026-10-01T08:00:00.000Z', fullName: 'Paul' },
    ],
    ...overrides,
  });

  it('une équipe exige code, nom et responsable ; commandes d’équipe', () => {
    expect(teamProblems(EMPTY_TEAM_FORM)).toEqual(['CODE', 'NAME', 'MANAGER']);
    const form = { code: 'lit', name: ' Littoral ', managerUserId: 'u1' };
    expect(teamProblems(form)).toEqual([]);
    expect(teamCreateCommand(form, 't9')).toEqual({
      commandType: 'organization.team.create',
      aggregateType: 'TEAM',
      aggregateId: 't9',
      payload: { code: 'LIT', name: 'Littoral', managerUserId: 'u1' },
    });
    // Une affectation crée une appartenance neuve : l'agrégat est son identifiant, pas l'équipe.
    expect(teamAssignCommand('t1', 'u3', 'm9')).toEqual({
      commandType: 'organization.team.assign_member',
      aggregateType: 'TEAM_MEMBERSHIP',
      aggregateId: 'm9',
      payload: { teamId: 't1', userId: 'u3' },
    });
    expect(teamRemoveCommand('u2', 'm10')).toMatchObject({
      commandType: 'organization.team.remove_member',
      aggregateId: 'm10',
      payload: { userId: 'u2' },
    });
  });

  it('fermeture d’une équipe (AV-515) : motif facultatif, coupé à la longueur du schéma', () => {
    expect(teamCloseCommand(team(), '   ')).toEqual({
      commandType: 'organization.team.close',
      aggregateType: 'TEAM',
      aggregateId: 't1',
      payload: {},
    });
    expect(teamCloseCommand(team(), ' Réorganisation ').payload).toEqual({
      reason: 'Réorganisation',
    });
    const long = teamCloseCommand(team(), 'x'.repeat(TEAM_CLOSE_REASON_MAX + 20));
    expect((long.payload.reason as string).length).toBe(TEAM_CLOSE_REASON_MAX);
  });

  it('équipe actuelle d’une personne', () => {
    const teams = [team(), team({ id: 't2', members: [] })];
    expect(teamOfUser(teams, 'u2')?.id).toBe('t1');
    expect(teamOfUser(teams, 'u1')).toBeUndefined();
  });

  it('point de vente : emplacement de vente exigé, appareil exigé en garde exclusive', () => {
    expect(posProblems(EMPTY_POS_FORM)).toEqual(['SALES_LOCATION']);
    const shared = { ...EMPTY_POS_FORM, salesLocationId: 'l1' };
    expect(posProblems(shared)).toEqual([]);
    expect(posProblems({ ...shared, custodyMode: 'EXCLUSIVE_DEVICE' })).toEqual(['DEVICE']);
    expect(
      posProblems({ ...shared, custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId: 'd1' }),
    ).toEqual([]);
    expect(posProblems({ ...shared, openingHours: 'x'.repeat(501) })).toEqual(['HOURS']);
  });

  it('configuration : l’agrégat est le site ; partagé n’envoie aucun appareil', () => {
    const form = {
      salesLocationId: 'l1',
      replenishmentSourceLocationId: 'l2',
      custodyMode: 'SHARED' as const,
      designatedDeviceId: 'd1',
      openingHours: ' 8h-18h ',
    };
    expect(posConfigureCommand('s2', form)).toEqual({
      commandType: 'organization.pos.configure',
      aggregateType: 'SITE',
      aggregateId: 's2',
      payload: {
        salesLocationId: 'l1',
        custodyMode: 'SHARED',
        replenishmentSourceLocationId: 'l2',
        openingHours: '8h-18h',
      },
    });
    expect(
      posConfigureCommand('s2', { ...form, custodyMode: 'EXCLUSIVE_DEVICE' }).payload,
    ).toMatchObject({ custodyMode: 'EXCLUSIVE_DEVICE', designatedDeviceId: 'd1' });
    const point: PosView = {
      siteId: 's2',
      siteCode: 'PDV1',
      siteName: 'Akwa',
      siteStatus: 'ACTIVE',
      salesLocationId: 'l1',
      replenishmentSourceLocationId: null,
      custodyMode: 'EXCLUSIVE_DEVICE',
      designatedDeviceId: 'd1',
      openingHours: null,
    };
    expect(posFormOf(point)).toEqual({
      salesLocationId: 'l1',
      replenishmentSourceLocationId: '',
      custodyMode: 'EXCLUSIVE_DEVICE',
      designatedDeviceId: 'd1',
      openingHours: '',
    });
  });

  it('emplacements proposés : ventes `POS` actifs du site, magasins sources `STORE` actifs d’un autre site', () => {
    expect(
      salesLocationChoices([
        location({ id: 'a', locationType: 'POS' }),
        location({ id: 'b', locationType: 'POS', status: 'INACTIVE' }),
        location({ id: 'c', locationType: 'STORE' }),
      ]).map((entry) => entry.id),
    ).toEqual(['a']);
    const bySite = new Map<string, readonly LocationView[]>([
      ['pdv', [location({ id: 'own', siteId: 'pdv', locationType: 'STORE' })]],
      [
        'central',
        [
          location({ id: 'x', siteId: 'central', locationType: 'STORE' }),
          location({ id: 'y', siteId: 'central', locationType: 'STORE', status: 'INACTIVE' }),
          location({ id: 'z', siteId: 'central', locationType: 'POS' }),
        ],
      ],
    ]);
    expect(sourceChoices(bySite, 'pdv').map((entry) => entry.id)).toEqual(['x']);
  });
});
