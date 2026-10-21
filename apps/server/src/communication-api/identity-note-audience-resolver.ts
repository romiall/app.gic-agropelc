/**
 * Adaptateur du port `NoteAudienceResolver` (P9-11 ; ADR-073 §3, §4 ; AV-476) : charge la géographie (zones,
 * ancêtres, sites) et les affectations actives, puis laisse la **règle pure du domaine** (`note-audience.ts`)
 * décider qui est touché. Comme `identity-recipient-resolver.ts`, il isole en un seul fichier les lectures des
 * tables `identity_*` et `organization_*` que ni `identity` ni `organization` n'exposent encore (besoin B1).
 *
 * Les requêtes sont ciblées sur l'audience demandée : la géographie n'est lue que pour les sites et zones
 * nommés ; les affectations ne sont lues que si elles peuvent correspondre (rôle, utilisateur, site ou zone
 * développés), sauf pour `ALL` (tout le monde). La règle du domaine juge ensuite chaque utilisateur retenu :
 * le préfiltre ne peut pas désigner un autre public qu'elle.
 */
import { Injectable } from '@nestjs/common';
import {
  expandNoteAudience,
  normalizeNoteAudience,
  userInAudience,
  type AudienceAssignment,
  type AudienceGeography,
  type NoteAudienceEntry,
} from '@gic/domain';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';
import type { NoteAudienceResolver } from '../modules/communication/application/public/index.js';

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function refsOf(entries: readonly NoteAudienceEntry[], type: 'ROLE' | 'SITE' | 'ZONE' | 'USER') {
  return entries.flatMap((entry) => (entry.type === type ? [entry.ref] : []));
}

/** Géographie des seules lignes `SITE` et `ZONE` de l'audience (quatre lectures au plus). */
async function loadGeography(
  uow: UnitOfWork,
  entries: readonly NoteAudienceEntry[],
): Promise<AudienceGeography> {
  const siteRefs = refsOf(entries, 'SITE');
  const zoneRefs = refsOf(entries, 'ZONE');

  const zoneOfSite = new Map<string, string>();
  if (siteRefs.length > 0) {
    const rows = await uow
      .selectFrom('organization_sites')
      .select(['id', 'zone_id'])
      .where('id', 'in', siteRefs.map(toBin))
      .execute();
    for (const row of rows) zoneOfSite.set(fromBin(row.id), fromBin(row.zone_id));
  }

  // Ancêtres (ligne propre comprise) des zones des sites et des zones nommées.
  const ancestors = new Map<string, string[]>();
  const lineageZones = unique([...zoneOfSite.values(), ...zoneRefs]);
  if (lineageZones.length > 0) {
    const rows = await uow
      .selectFrom('organization_zone_ancestors')
      .select(['zone_id', 'ancestor_id'])
      .where('zone_id', 'in', lineageZones.map(toBin))
      .execute();
    for (const row of rows) {
      const zone = fromBin(row.zone_id);
      ancestors.set(zone, [...(ancestors.get(zone) ?? []), fromBin(row.ancestor_id)]);
    }
  }

  // Descendantes (ligne propre comprise) des zones nommées, et les sites qui s'y rattachent.
  const descendants = new Map<string, string[]>();
  const sitesByZone = new Map<string, string[]>();
  if (zoneRefs.length > 0) {
    const rows = await uow
      .selectFrom('organization_zone_ancestors')
      .select(['zone_id', 'ancestor_id'])
      .where('ancestor_id', 'in', zoneRefs.map(toBin))
      .execute();
    for (const row of rows) {
      const ancestor = fromBin(row.ancestor_id);
      descendants.set(ancestor, [...(descendants.get(ancestor) ?? []), fromBin(row.zone_id)]);
    }
    const within = unique([...zoneRefs, ...[...descendants.values()].flat()]);
    const sites = await uow
      .selectFrom('organization_sites')
      .select(['id', 'zone_id'])
      .where('zone_id', 'in', within.map(toBin))
      .execute();
    for (const row of sites) {
      const zone = fromBin(row.zone_id);
      sitesByZone.set(zone, [...(sitesByZone.get(zone) ?? []), fromBin(row.id)]);
    }
  }

  return {
    zoneOfSite: (site) => zoneOfSite.get(site) ?? null,
    lineageOf: (zone) => unique([zone, ...(ancestors.get(zone) ?? [])]),
    descendantsOrSelfOf: (zone) => unique([zone, ...(descendants.get(zone) ?? [])]),
    sitesInZones: (zones) => [...zones].flatMap((zone) => sitesByZone.get(zone) ?? []),
  };
}

/** Affectations actives à `at` : rôle actif, utilisateur actif, validité et révocation jugées à `at`. */
function activeAssignments(uow: UnitOfWork, at: Date) {
  return uow
    .selectFrom('identity_user_role_assignments as a')
    .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
    .innerJoin('identity_users as u', 'u.id', 'a.user_id')
    .select([
      'a.user_id',
      'r.code as role_code',
      'a.scope_type',
      'a.scope_site_id',
      'a.scope_zone_id',
    ])
    .where('r.is_active', '=', 1)
    .where('u.status', '=', 'ACTIVE')
    .where('a.valid_from', '<=', at)
    .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', at)]))
    .where((eb) => eb.or([eb('a.revoked_at', 'is', null), eb('a.revoked_at', '>', at)]));
}

function toAssignment(row: {
  readonly role_code: string;
  readonly scope_type: string;
  readonly scope_site_id: Buffer | null;
  readonly scope_zone_id: Buffer | null;
}): AudienceAssignment {
  return {
    roleCode: row.role_code,
    scope: row.scope_type as AudienceAssignment['scope'],
    siteId: fromBinOrNull(row.scope_site_id),
    zoneId: fromBinOrNull(row.scope_zone_id),
  };
}

@Injectable()
export class IdentityNoteAudienceResolver implements NoteAudienceResolver {
  async unknownReferences(
    uow: UnitOfWork,
    entries: readonly NoteAudienceEntry[],
  ): Promise<readonly NoteAudienceEntry[]> {
    const normalized = normalizeNoteAudience(entries);
    const unknown: NoteAudienceEntry[] = [];

    const roles = refsOf(normalized, 'ROLE');
    if (roles.length > 0) {
      const found = await uow
        .selectFrom('identity_roles')
        .select('code')
        .where('code', 'in', roles)
        .where('is_active', '=', 1)
        .execute();
      const known = new Set(found.map((row) => row.code));
      for (const ref of roles) if (!known.has(ref)) unknown.push({ type: 'ROLE', ref });
    }
    const existing = async (
      table: 'organization_sites' | 'organization_zones' | 'identity_users',
      refs: readonly string[],
    ): Promise<Set<string>> => {
      if (refs.length === 0) return new Set();
      const rows = await uow
        .selectFrom(table)
        .select('id')
        .where('id', 'in', refs.map(toBin))
        .execute();
      return new Set(rows.map((row) => fromBin(row.id)));
    };
    for (const [type, table] of [
      ['SITE', 'organization_sites'],
      ['ZONE', 'organization_zones'],
      ['USER', 'identity_users'],
    ] as const) {
      const refs = refsOf(normalized, type);
      const known = await existing(table, refs);
      for (const ref of refs) if (!known.has(ref)) unknown.push({ type, ref });
    }
    return unknown;
  }

  async usersInAudienceAt(
    uow: UnitOfWork,
    entries: readonly NoteAudienceEntry[],
    at: Date,
  ): Promise<readonly string[]> {
    const normalized = normalizeNoteAudience(entries);
    const audience = expandNoteAudience(normalized, await loadGeography(uow, normalized));
    let query = activeAssignments(uow, at);
    if (!audience.all) {
      // Préfiltre : les affectations qui peuvent correspondre ; la règle du domaine juge ensuite chaque utilisateur.
      const roleCodes = [...audience.roleCodes];
      const userIds = [...audience.userIds];
      const siteIds = [...audience.siteIds];
      const zoneIds = [...audience.zoneIds];
      if (roleCodes.length + userIds.length + siteIds.length + zoneIds.length === 0) return [];
      query = query.where((eb) =>
        eb.or([
          ...(roleCodes.length > 0 ? [eb('r.code', 'in', roleCodes)] : []),
          ...(userIds.length > 0 ? [eb('a.user_id', 'in', userIds.map(toBin))] : []),
          ...(siteIds.length > 0 ? [eb('a.scope_site_id', 'in', siteIds.map(toBin))] : []),
          ...(zoneIds.length > 0 ? [eb('a.scope_zone_id', 'in', zoneIds.map(toBin))] : []),
        ]),
      );
    }
    const rows = await query.execute();
    const byUser = new Map<string, AudienceAssignment[]>();
    for (const row of rows) {
      const userId = fromBin(row.user_id);
      byUser.set(userId, [...(byUser.get(userId) ?? []), toAssignment(row)]);
    }
    return [...byUser.entries()]
      .filter(([userId, assignments]) => userInAudience(userId, assignments, audience))
      .map(([userId]) => userId)
      .sort();
  }

  async includesUserAt(
    uow: UnitOfWork,
    userId: string,
    entries: readonly NoteAudienceEntry[],
    at: Date,
  ): Promise<boolean> {
    const normalized = normalizeNoteAudience(entries);
    const audience = expandNoteAudience(normalized, await loadGeography(uow, normalized));
    const rows = await activeAssignments(uow, at).where('a.user_id', '=', toBin(userId)).execute();
    return userInAudience(userId, rows.map(toAssignment), audience);
  }
}
