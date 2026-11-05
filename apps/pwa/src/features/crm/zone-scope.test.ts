import { describe, expect, it } from 'vitest';
import type { RoleAssignmentData, ZoneData } from '../sales/types.js';
import { serviceZones } from '../fieldwork/service.js';
import { prospectZoneOptions } from './prospect.js';
import { allowedZoneIds } from './zone-scope.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ME = 'user-me';

const zone = (id: string, parentId: string | null, name = id): ZoneData =>
  ({
    id,
    parent_id: parentId,
    name,
    depth: parentId ? 2 : 1,
    is_active: true,
    geofence_lat: '4.05',
    geofence_lng: '9.7',
    geofence_radius_m: '500',
    max_gps_accuracy_m: null,
  }) as unknown as ZoneData;

// Douala (racine) › Akwa, Bonabéri ; Yaoundé (racine) › Bastos.
const ZONES = new Map(
  [
    zone('douala', null, 'Douala'),
    zone('akwa', 'douala', 'Akwa'),
    zone('bonaberi', 'douala', 'Bonabéri'),
    zone('yaounde', null, 'Yaoundé'),
    zone('bastos', 'yaounde', 'Bastos'),
  ].map((z) => [z.id, z]),
);

const assignment = (patch: Partial<RoleAssignmentData>): RoleAssignmentData => ({
  id: `a-${Math.random()}`,
  user_id: ME,
  scope_type: 'ZONE',
  scope_site_id: null,
  scope_zone_id: null,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_to: null,
  revoked_at: null,
  ...patch,
});

const scope = (assignments: readonly RoleAssignmentData[]) =>
  allowedZoneIds({ assignments, userId: ME, zones: ZONES, now: NOW });

describe('Zones du périmètre de l’utilisateur (S-19, AV-520)', () => {
  it('une affectation de zone ouvre la zone et ses sous-zones, pas les autres', () => {
    expect([...scope([assignment({ scope_zone_id: 'douala' })])!].sort()).toEqual([
      'akwa',
      'bonaberi',
      'douala',
    ]);
    expect([...scope([assignment({ scope_zone_id: 'bastos' })])!]).toEqual(['bastos']);
  });

  it('plusieurs affectations de zone s’additionnent', () => {
    expect(
      [
        ...scope([
          assignment({ scope_zone_id: 'akwa' }),
          assignment({ scope_zone_id: 'yaounde' }),
        ])!,
      ].sort(),
    ).toEqual(['akwa', 'bastos', 'yaounde']);
  });

  it('affectation globale ou d’équipe, ou aucune affectation de zone : aucun filtrage', () => {
    expect(scope([assignment({ scope_type: 'GLOBAL' })])).toBeNull();
    expect(
      scope([assignment({ scope_type: 'TEAM' }), assignment({ scope_zone_id: 'akwa' })]),
    ).toBeNull();
    expect(scope([])).toBeNull();
    expect(scope([assignment({ scope_type: 'SITE', scope_site_id: 's1' })])).toBeNull();
  });

  it('les affectations révoquées, échues, futures ou d’un autre utilisateur ne comptent pas', () => {
    expect(
      scope([
        assignment({ scope_zone_id: 'akwa' }),
        assignment({ scope_zone_id: 'bastos', revoked_at: '2026-10-01T00:00:00.000Z' }),
        assignment({ scope_zone_id: 'bonaberi', valid_to: '2026-11-01T00:00:00.000Z' }),
        assignment({ scope_zone_id: 'yaounde', valid_from: '2026-12-01T00:00:00.000Z' }),
        assignment({ scope_zone_id: 'douala', user_id: 'someone-else' }),
      ]),
    ).toEqual(new Set(['akwa']));
    // Une affectation globale révoquée n'ouvre rien : le périmètre se lit sur les affectations de zone en vigueur.
    expect(
      scope([
        assignment({ scope_type: 'GLOBAL', revoked_at: '2026-10-01T00:00:00.000Z' }),
        assignment({ scope_zone_id: 'akwa' }),
      ]),
    ).toEqual(new Set(['akwa']));
  });

  it('une zone inconnue de l’appareil n’ouvre rien (ensemble vide, pas « tout »)', () => {
    expect(scope([assignment({ scope_zone_id: 'inconnue' })])).toEqual(new Set());
  });

  it('un cycle de zones ne boucle pas', () => {
    const loop = new Map([
      ['a', zone('a', 'b')],
      ['b', zone('b', 'a')],
    ]);
    expect(
      allowedZoneIds({
        assignments: [assignment({ scope_zone_id: 'a' })],
        userId: ME,
        zones: loop,
        now: NOW,
      }),
    ).toEqual(new Set(['a', 'b']));
  });

  it('les zones proposées à un prospect et à une prise de service suivent le périmètre', () => {
    const allowed = scope([assignment({ scope_zone_id: 'douala' })]);
    expect(prospectZoneOptions(ZONES, allowed).map((option) => option.label)).toEqual([
      'Douala',
      'Douala › Akwa',
      'Douala › Bonabéri',
    ]);
    expect(prospectZoneOptions(ZONES, null)).toHaveLength(5);
    expect(prospectZoneOptions(ZONES)).toHaveLength(5);
    expect(
      serviceZones(ZONES, 150, allowed)
        .map((service) => service.zone.id)
        .sort(),
    ).toEqual(['akwa', 'bonaberi', 'douala']);
    expect(serviceZones(ZONES, 150)).toHaveLength(5);
  });
});
