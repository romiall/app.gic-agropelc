/**
 * ECR-ADM-06 « Organisation » (RP-1 ; UC-ADM-01 à 05 ; BR-ADM-008, BR-ADM-012 ; AV-492, AV-495, AV-497) :
 * logique pure de l'écran, partagée par ses quatre panneaux (sites, zones, équipes, points de vente).
 *
 * - Lectures : `GET /sites`, `/zones`, `/teams`, `/points-of-sale`, `/locations?site_id=`.
 * - Écritures : les commandes `organization.*` (droit `org.structure.manage`, Admin seul), envoyées par la
 *   file d'envoi, en ligne seulement. Le serveur reste juge : les contrôles d'ici ne servent qu'à éviter un
 *   aller-retour inutile et à dire en français ce qui manque.
 * - Une zone se renomme (`organization.zone.update`) et se déplace (`organization.zone.move`), une équipe se
 *   ferme (`organization.team.close`) (AV-515). Le serveur n'offre toujours pas de changement de code ou de
 *   zone d'un site, ni de retrait de la capacité d'un emplacement ou de la précision GPS d'une zone (une
 *   valeur absente d'une mise à jour est « inchangée ») (AV-497) : ces actions ne sont pas proposées.
 */

import { parseDecimal } from '../admin/parse.js';

export const SITE_TYPES = ['FERME', 'MAGASIN', 'POINT_DE_VENTE', 'BUREAU'] as const;
export type SiteType = (typeof SITE_TYPES)[number];

export const ZONE_LEVELS = ['PAYS', 'REGION', 'VILLE', 'MARCHE', 'QUARTIER', 'SECTEUR'] as const;
export type ZoneLevel = (typeof ZONE_LEVELS)[number];

export const LOCATION_TYPES = [
  'STORE',
  'POS',
  'BUILDING',
  'PEN',
  'INCUBATOR',
  'HATCHER',
  'MOBILE',
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const CUSTODY_MODES = ['SHARED', 'EXCLUSIVE_DEVICE'] as const;
export type CustodyMode = (typeof CUSTODY_MODES)[number];

export const SITES_PATH = '/api/v1/sites';
export const ZONES_PATH = '/api/v1/zones';
export const TEAMS_PATH = '/api/v1/teams';
export const POINTS_OF_SALE_PATH = '/api/v1/points-of-sale';
export const USERS_PATH = '/api/v1/users?status=ACTIVE&limit=200';
export const DEVICES_PATH = '/api/v1/devices?status=ACTIVE&limit=200';
export const locationsPath = (siteId: string) =>
  `/api/v1/locations?site_id=${encodeURIComponent(siteId)}`;

/** Longueurs maximales des champs (schémas des commandes du serveur). */
export const LIMITS = {
  siteCode: 10,
  zoneCode: 40,
  teamCode: 40,
  locationCode: 40,
  name: 200,
  address: 500,
  openingHours: 500,
} as const;

/** Rayon d'un géorepère : contrainte de la base (`ck_organization_zones_radius`). */
export const RADIUS_MIN_M = 50;
export const RADIUS_MAX_M = 5000;

export interface SiteView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly siteType: SiteType;
  readonly zoneId: string;
  readonly address: string | null;
  readonly status: 'ACTIVE' | 'CLOSED';
  readonly openedOn: string | null;
  readonly closedOn: string | null;
}

export interface ZoneView {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly level: ZoneLevel;
  readonly depth: number;
  readonly geofence: {
    readonly lat: number;
    readonly lng: number;
    readonly radiusM: number;
  } | null;
  readonly maxGpsAccuracyM: number | null;
  readonly isActive: boolean;
}

export interface LocationView {
  readonly id: string;
  readonly siteId: string | null;
  readonly parentLocationId: string | null;
  readonly code: string;
  readonly name: string;
  readonly locationType: string;
  readonly isVirtual: boolean;
  readonly custodyMode: string | null;
  readonly custodianUserId: string | null;
  readonly capacity: number | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface TeamMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly since: string;
  readonly fullName: string | null;
}

export interface TeamView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly managerUserId: string;
  readonly managerName: string | null;
  readonly isActive: boolean;
  readonly members: readonly TeamMemberView[];
}

export interface PosView {
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly siteStatus: string;
  readonly salesLocationId: string;
  readonly replenishmentSourceLocationId: string | null;
  readonly custodyMode: CustodyMode;
  readonly designatedDeviceId: string | null;
  readonly openingHours: string | null;
}

/** Personne ou appareil proposé dans une liste de choix. */
export interface Option {
  readonly id: string;
  readonly label: string;
}

/** Commande prête à envoyer (le type d'agrégat sert au journal d'audit). */
export interface OrganizationCommand {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/* --- Saisies ------------------------------------------------------------------------------------------- */

/** Code : lettres, chiffres, tiret et tiret bas ; mis en majuscules à la saisie. */
export function normalizeCode(text: string): string {
  return text.trim().toUpperCase();
}

export function isValidCode(code: string, max: number): boolean {
  return code.length >= 1 && code.length <= max && /^[A-Z0-9][A-Z0-9_-]*$/.test(code);
}

export function isValidName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= LIMITS.name;
}

/** Nombre saisi avec une virgule ou un point décimal ; `null` si vide ou illisible. */
export { parseDecimal };

/** Coordonnée écrite avec six décimales (précision de la base : `DECIMAL(9,6)`). */
export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

export type FormProblem =
  | 'CODE'
  | 'NAME'
  | 'ZONE'
  | 'LEVEL'
  | 'TYPE'
  | 'MANAGER'
  | 'CUSTODIAN'
  | 'CAPACITY'
  | 'ADDRESS'
  | 'LAT'
  | 'LNG'
  | 'RADIUS'
  | 'ACCURACY'
  | 'SALES_LOCATION'
  | 'DEVICE'
  | 'HOURS'
  | 'DATE';

/* --- Sites --------------------------------------------------------------------------------------------- */

export interface SiteForm {
  readonly code: string;
  readonly name: string;
  readonly siteType: SiteType;
  readonly zoneId: string;
  readonly address: string;
  readonly openedOn: string;
}

export const EMPTY_SITE_FORM: SiteForm = {
  code: '',
  name: '',
  siteType: 'MAGASIN',
  zoneId: '',
  address: '',
  openedOn: '',
};

export function siteProblems(form: SiteForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!isValidCode(normalizeCode(form.code), LIMITS.siteCode)) problems.push('CODE');
  if (!isValidName(form.name)) problems.push('NAME');
  if (!form.zoneId) problems.push('ZONE');
  if (form.address.length > LIMITS.address) problems.push('ADDRESS');
  if (form.openedOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(form.openedOn)) problems.push('DATE');
  return problems;
}

export function siteCreateCommand(form: SiteForm, siteId: string): OrganizationCommand {
  return {
    commandType: 'organization.site.create',
    aggregateType: 'SITE',
    aggregateId: siteId,
    payload: {
      code: normalizeCode(form.code),
      name: form.name.trim(),
      siteType: form.siteType,
      zoneId: form.zoneId,
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
      ...(form.openedOn ? { openedOn: form.openedOn } : {}),
    },
  };
}

export function siteUpdateCommand(
  siteId: string,
  form: Pick<SiteForm, 'name' | 'address'>,
  currentAddress: string | null = null,
): OrganizationCommand {
  const address = form.address.trim();
  // Le serveur ne retire pas une adresse : une adresse effacée part vide et remplace l'ancienne.
  const addressChanged = address !== (currentAddress ?? '').trim();
  return {
    commandType: 'organization.site.update',
    aggregateType: 'SITE',
    aggregateId: siteId,
    payload: {
      name: form.name.trim(),
      ...(addressChanged ? { address } : {}),
    },
  };
}

export function siteCloseCommand(siteId: string): OrganizationCommand {
  return {
    commandType: 'organization.site.close',
    aggregateType: 'SITE',
    aggregateId: siteId,
    payload: {},
  };
}

/* --- Emplacements -------------------------------------------------------------------------------------- */

export interface LocationForm {
  readonly code: string;
  readonly name: string;
  readonly locationType: LocationType;
  readonly parentLocationId: string;
  readonly capacity: string;
  readonly custodianUserId: string;
}

export const EMPTY_LOCATION_FORM: LocationForm = {
  code: '',
  name: '',
  locationType: 'STORE',
  parentLocationId: '',
  capacity: '',
  custodianUserId: '',
};

/** Capacité : entier strictement positif, ou vide. */
export function parseCapacity(text: string): number | null | 'INVALID' {
  const cleaned = text.trim();
  if (cleaned === '') return null;
  return /^\d+$/.test(cleaned) && Number(cleaned) > 0 ? Number(cleaned) : 'INVALID';
}

export function locationProblems(form: LocationForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!isValidCode(normalizeCode(form.code), LIMITS.locationCode)) problems.push('CODE');
  if (!isValidName(form.name)) problems.push('NAME');
  if (parseCapacity(form.capacity) === 'INVALID') problems.push('CAPACITY');
  // Un emplacement mobile est confié à une personne (BR-ADM-010, `custodyMode` EXCLUSIVE_USER).
  if (form.locationType === 'MOBILE' && !form.custodianUserId) problems.push('CUSTODIAN');
  return problems;
}

export function locationCreateCommand(
  siteId: string,
  form: LocationForm,
  locationId: string,
): OrganizationCommand {
  const capacity = parseCapacity(form.capacity);
  return {
    commandType: 'organization.location.create',
    aggregateType: 'LOCATION',
    aggregateId: locationId,
    payload: {
      siteId,
      code: normalizeCode(form.code),
      name: form.name.trim(),
      locationType: form.locationType,
      ...(form.parentLocationId ? { parentLocationId: form.parentLocationId } : {}),
      ...(typeof capacity === 'number' ? { capacity } : {}),
      ...(form.locationType === 'MOBILE'
        ? { custodyMode: 'EXCLUSIVE_USER', custodianUserId: form.custodianUserId }
        : {}),
    },
  };
}

export function locationUpdateCommand(
  locationId: string,
  form: Pick<LocationForm, 'name' | 'capacity'>,
): OrganizationCommand {
  const capacity = parseCapacity(form.capacity);
  return {
    commandType: 'organization.location.update',
    aggregateType: 'LOCATION',
    aggregateId: locationId,
    payload: {
      name: form.name.trim(),
      ...(typeof capacity === 'number' ? { capacity } : {}),
    },
  };
}

export function locationDeactivateCommand(locationId: string): OrganizationCommand {
  return {
    commandType: 'organization.location.deactivate',
    aggregateType: 'LOCATION',
    aggregateId: locationId,
    payload: {},
  };
}

/* --- Zones et géorepères ------------------------------------------------------------------------------- */

export interface ZoneForm {
  readonly code: string;
  readonly name: string;
  readonly level: ZoneLevel;
  readonly parentId: string;
  readonly lat: string;
  readonly lng: string;
  readonly radiusM: string;
  readonly maxGpsAccuracyM: string;
}

export const EMPTY_ZONE_FORM: ZoneForm = {
  code: '',
  name: '',
  level: 'VILLE',
  parentId: '',
  lat: '',
  lng: '',
  radiusM: '',
  maxGpsAccuracyM: '',
};

export function zoneFormOf(zone: ZoneView): ZoneForm {
  return {
    code: zone.code,
    name: zone.name,
    level: zone.level,
    parentId: zone.parentId ?? '',
    lat: zone.geofence ? formatCoordinate(zone.geofence.lat) : '',
    lng: zone.geofence ? formatCoordinate(zone.geofence.lng) : '',
    radiusM: zone.geofence ? String(zone.geofence.radiusM) : '',
    maxGpsAccuracyM: zone.maxGpsAccuracyM === null ? '' : String(zone.maxGpsAccuracyM),
  };
}

/** Géorepère saisi : aucun champ (pas de géorepère), ou latitude et longitude ensemble. */
export function hasGeofenceInput(form: Pick<ZoneForm, 'lat' | 'lng' | 'radiusM'>): boolean {
  return form.lat.trim() !== '' || form.lng.trim() !== '' || form.radiusM.trim() !== '';
}

export function zoneProblems(form: ZoneForm, mode: 'CREATE' | 'UPDATE'): FormProblem[] {
  const problems: FormProblem[] = [];
  if (mode === 'CREATE' && !isValidCode(normalizeCode(form.code), LIMITS.zoneCode)) {
    problems.push('CODE');
  }
  if (!isValidName(form.name)) problems.push('NAME');
  if (hasGeofenceInput(form)) {
    const lat = parseDecimal(form.lat);
    const lng = parseDecimal(form.lng);
    if (lat === null || lat < -90 || lat > 90) problems.push('LAT');
    if (lng === null || lng < -180 || lng > 180) problems.push('LNG');
    if (form.radiusM.trim() !== '') {
      const radius = parseDecimal(form.radiusM);
      if (radius === null || radius < RADIUS_MIN_M || radius > RADIUS_MAX_M) {
        problems.push('RADIUS');
      }
    }
  }
  if (form.maxGpsAccuracyM.trim() !== '') {
    const accuracy = parseDecimal(form.maxGpsAccuracyM);
    if (accuracy === null || accuracy <= 0) problems.push('ACCURACY');
  }
  return problems;
}

export function zoneCreateCommand(form: ZoneForm, zoneId: string): OrganizationCommand {
  const geofence = hasGeofenceInput(form);
  const radius = parseDecimal(form.radiusM);
  const accuracy = parseDecimal(form.maxGpsAccuracyM);
  return {
    commandType: 'organization.zone.create',
    aggregateType: 'ZONE',
    aggregateId: zoneId,
    payload: {
      code: normalizeCode(form.code),
      name: form.name.trim(),
      level: form.level,
      ...(form.parentId ? { parentId: form.parentId } : {}),
      ...(geofence ? { lat: parseDecimal(form.lat), lng: parseDecimal(form.lng) } : {}),
      ...(geofence && radius !== null ? { radiusM: radius } : {}),
      ...(accuracy !== null ? { maxGpsAccuracyM: accuracy } : {}),
    },
  };
}

/**
 * Mise à jour d'une zone : nom, précision GPS maximale et géorepère (`null` : le retirer). Seuls les champs
 * modifiés partent ; sans changement, `null` (rien à envoyer).
 */
export function zoneUpdateCommand(zone: ZoneView, form: ZoneForm): OrganizationCommand | null {
  const payload: Record<string, unknown> = {};
  if (form.name.trim() !== zone.name) payload.name = form.name.trim();
  const accuracy = parseDecimal(form.maxGpsAccuracyM);
  if (accuracy !== null && accuracy !== zone.maxGpsAccuracyM) payload.maxGpsAccuracyM = accuracy;
  if (hasGeofenceInput(form)) {
    const lat = parseDecimal(form.lat);
    const lng = parseDecimal(form.lng);
    const radius = parseDecimal(form.radiusM);
    const next = { lat, lng, radiusM: radius ?? zone.geofence?.radiusM ?? null };
    const same =
      zone.geofence !== null &&
      lat === zone.geofence.lat &&
      lng === zone.geofence.lng &&
      (radius === null || radius === zone.geofence.radiusM);
    if (!same) {
      payload.geofence = {
        lat: next.lat,
        lng: next.lng,
        ...(next.radiusM !== null ? { radiusM: next.radiusM } : {}),
      };
    }
  } else if (zone.geofence !== null) {
    payload.geofence = null;
  }
  if (Object.keys(payload).length === 0) return null;
  return {
    commandType: 'organization.zone.update',
    aggregateType: 'ZONE',
    aggregateId: zone.id,
    payload,
  };
}

export function zoneActiveCommand(zone: ZoneView, isActive: boolean): OrganizationCommand {
  return {
    commandType: 'organization.zone.update',
    aggregateType: 'ZONE',
    aggregateId: zone.id,
    payload: { isActive },
  };
}

/**
 * Zones sous lesquelles `zone` peut être déplacée (AV-515) : actives, hors d'elle-même et de ses descendantes
 * (le serveur refuse un cycle) et hors de sa parente actuelle.
 */
export function moveTargetsOf(zone: ZoneView, zones: readonly ZoneView[]): ZoneView[] {
  const excluded = new Set<string>([zone.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const candidate of zones) {
      if (
        candidate.parentId !== null &&
        excluded.has(candidate.parentId) &&
        !excluded.has(candidate.id)
      ) {
        excluded.add(candidate.id);
        grew = true;
      }
    }
  }
  return zones.filter(
    (candidate) =>
      candidate.isActive && !excluded.has(candidate.id) && candidate.id !== zone.parentId,
  );
}

/** Déplacement d'une zone et de ses descendantes ; `''` : à la racine. */
export function zoneMoveCommand(zone: ZoneView, parentId: string): OrganizationCommand {
  return {
    commandType: 'organization.zone.move',
    aggregateType: 'ZONE',
    aggregateId: zone.id,
    payload: { parentId: parentId === '' ? null : parentId },
  };
}

export interface ZoneNode {
  readonly zone: ZoneView;
  readonly children: readonly ZoneNode[];
}

/**
 * Arbre des zones lues. Une zone dont le parent n'est pas dans la liste (lecteur limité à une branche) est
 * une racine ; frères triés par code.
 */
export function zoneTree(zones: readonly ZoneView[]): ZoneNode[] {
  const ids = new Set(zones.map((zone) => zone.id));
  const byParent = new Map<string | null, ZoneView[]>();
  for (const zone of zones) {
    const key = zone.parentId !== null && ids.has(zone.parentId) ? zone.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), zone]);
  }
  const build = (parent: string | null): ZoneNode[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((zone) => ({ zone, children: build(zone.id) }));
  return build(null);
}

/** Zones à plat dans l'ordre de l'arbre, avec leur retrait (profondeur dans l'arbre lu). */
export function flattenZones(
  nodes: readonly ZoneNode[],
  level = 0,
): { readonly zone: ZoneView; readonly level: number }[] {
  return nodes.flatMap((node) => [
    { zone: node.zone, level },
    ...flattenZones(node.children, level + 1),
  ]);
}

/* --- Équipes ------------------------------------------------------------------------------------------- */

export interface TeamForm {
  readonly code: string;
  readonly name: string;
  readonly managerUserId: string;
}

export const EMPTY_TEAM_FORM: TeamForm = { code: '', name: '', managerUserId: '' };

export function teamProblems(form: TeamForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!isValidCode(normalizeCode(form.code), LIMITS.teamCode)) problems.push('CODE');
  if (!isValidName(form.name)) problems.push('NAME');
  if (!form.managerUserId) problems.push('MANAGER');
  return problems;
}

export function teamCreateCommand(form: TeamForm, teamId: string): OrganizationCommand {
  return {
    commandType: 'organization.team.create',
    aggregateType: 'TEAM',
    aggregateId: teamId,
    payload: {
      code: normalizeCode(form.code),
      name: form.name.trim(),
      managerUserId: form.managerUserId,
    },
  };
}

/** Une affectation crée une ligne d'appartenance neuve (`aggregate_id` frais) ; un déplacement ferme l'ancienne. */
export function teamAssignCommand(
  teamId: string,
  userId: string,
  membershipId: string,
): OrganizationCommand {
  return {
    commandType: 'organization.team.assign_member',
    aggregateType: 'TEAM_MEMBERSHIP',
    aggregateId: membershipId,
    payload: { teamId, userId },
  };
}

export function teamRemoveCommand(userId: string, commandAggregateId: string): OrganizationCommand {
  return {
    commandType: 'organization.team.remove_member',
    aggregateType: 'TEAM_MEMBERSHIP',
    aggregateId: commandAggregateId,
    payload: { userId },
  };
}

/** Fermeture d'une équipe (AV-515) : ses membres la quittent, elle n'en reçoit plus ; le motif est facultatif. */
export function teamCloseCommand(team: TeamView, reason: string): OrganizationCommand {
  const text = reason.trim();
  return {
    commandType: 'organization.team.close',
    aggregateType: 'TEAM',
    aggregateId: team.id,
    payload: text === '' ? {} : { reason: text.slice(0, TEAM_CLOSE_REASON_MAX) },
  };
}

/** Longueur maximale du motif de fermeture (schéma de la commande). */
export const TEAM_CLOSE_REASON_MAX = 500;

/** Équipe actuelle d'une personne, d'après les équipes lues. */
export function teamOfUser(teams: readonly TeamView[], userId: string): TeamView | undefined {
  return teams.find((team) => team.members.some((member) => member.userId === userId));
}

/* --- Points de vente ----------------------------------------------------------------------------------- */

export interface PosForm {
  readonly salesLocationId: string;
  readonly replenishmentSourceLocationId: string;
  readonly custodyMode: CustodyMode;
  readonly designatedDeviceId: string;
  readonly openingHours: string;
}

export const EMPTY_POS_FORM: PosForm = {
  salesLocationId: '',
  replenishmentSourceLocationId: '',
  custodyMode: 'SHARED',
  designatedDeviceId: '',
  openingHours: '',
};

export function posFormOf(point: PosView): PosForm {
  return {
    salesLocationId: point.salesLocationId,
    replenishmentSourceLocationId: point.replenishmentSourceLocationId ?? '',
    custodyMode: point.custodyMode,
    designatedDeviceId: point.designatedDeviceId ?? '',
    openingHours: point.openingHours ?? '',
  };
}

export function posProblems(form: PosForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!form.salesLocationId) problems.push('SALES_LOCATION');
  if (form.custodyMode === 'EXCLUSIVE_DEVICE' && !form.designatedDeviceId) problems.push('DEVICE');
  if (form.openingHours.length > LIMITS.openingHours) problems.push('HOURS');
  return problems;
}

/** `aggregate_id` d'une configuration : le site lui-même (clé primaire du point de vente). */
export function posConfigureCommand(siteId: string, form: PosForm): OrganizationCommand {
  return {
    commandType: 'organization.pos.configure',
    aggregateType: 'SITE',
    aggregateId: siteId,
    payload: {
      salesLocationId: form.salesLocationId,
      custodyMode: form.custodyMode,
      ...(form.replenishmentSourceLocationId
        ? { replenishmentSourceLocationId: form.replenishmentSourceLocationId }
        : {}),
      ...(form.custodyMode === 'EXCLUSIVE_DEVICE' && form.designatedDeviceId
        ? { designatedDeviceId: form.designatedDeviceId }
        : {}),
      ...(form.openingHours.trim() ? { openingHours: form.openingHours.trim() } : {}),
    },
  };
}

/** Emplacements de vente proposés : `POS` actifs du site (le serveur n'accepte que ceux-là). */
export function salesLocationChoices(locations: readonly LocationView[]): LocationView[] {
  return locations.filter(
    (location) => location.locationType === 'POS' && location.status === 'ACTIVE',
  );
}

/** Magasins sources proposés : `STORE` actifs d'un autre site que le point de vente. */
export function sourceChoices(
  locationsBySite: ReadonlyMap<string, readonly LocationView[]>,
  posSiteId: string,
): LocationView[] {
  return [...locationsBySite.entries()]
    .filter(([siteId]) => siteId !== posSiteId)
    .flatMap(([, locations]) => locations)
    .filter((location) => location.locationType === 'STORE' && location.status === 'ACTIVE');
}
