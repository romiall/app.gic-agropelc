/**
 * Audience d'une note de direction (P9-11 ; ADR-063 §2 à §4 ; BR-NOT-006 ; AV-426) : qui une note touche, jugé par
 * **une seule règle pure**, partagée par la lecture en ligne (un lecteur), l'accusé (un utilisateur) et la
 * résolution à la publication (tous les utilisateurs touchés, pour les notifications et le flux hors ligne). Sans
 * entrée-sortie : l'adaptateur de `communication-api/` charge la géographie et les affectations, cette règle
 * décide.
 *
 * Une ligne d'audience désigne :
 * - `ALL` : tout utilisateur actif et affecté ;
 * - `ROLE` : une affectation active de ce rôle, quelle que soit sa portée ;
 * - `USER` : cet utilisateur ;
 * - `SITE` : un site — les affectations de portée `SITE` sur ce site, et celles de portée `ZONE` sur la zone du
 *   site ou l'un de ses ancêtres (une zone couvre ses sites) ;
 * - `ZONE` : une zone — les affectations de portée `ZONE` sur cette zone, sur l'un de ses ancêtres (elle la
 *   couvre) ou sur l'une de ses descendantes, et celles de portée `SITE` sur un site de la zone ou de ses
 *   descendantes.
 * Une affectation `GLOBAL` ou `TEAM` ne correspond pas à une ligne `SITE` ou `ZONE` (pour atteindre tout le monde,
 * `ALL` ou `ROLE`) : la note d'un site ne réveille pas toute la Direction.
 *
 * Le calcul se fait en deux temps, sans jamais parcourir deux fois la géographie : {@link expandNoteAudience}
 * ramène l'audience à des **ensembles** (rôles, utilisateurs, sites, zones), puis {@link userInAudience} compare
 * ces ensembles aux affectations d'un utilisateur. Les requêtes de l'adaptateur (préfiltre des affectations)
 * emploient les mêmes ensembles : elles ne peuvent pas désigner un autre public que cette règle.
 */

export type NoteAudienceEntry =
  | { readonly type: 'ALL' }
  | { readonly type: 'ROLE' | 'SITE' | 'ZONE' | 'USER'; readonly ref: string };

export type NoteAudienceType = NoteAudienceEntry['type'];

/** Valeur de `audience_ref` des lignes `ALL` (une clé primaire n'admet pas de colonne nulle). */
export const NOTE_AUDIENCE_ALL_REF = '*';

const TYPE_ORDER: Readonly<Record<NoteAudienceType, number>> = {
  ALL: 0,
  ROLE: 1,
  SITE: 2,
  ZONE: 3,
  USER: 4,
};

/**
 * Lignes d'audience sans doublon, dans un ordre stable. Les identifiants sont en minuscules (UUID), les codes
 * de rôle gardent leur casse (majuscules par convention) ; `ALL` n'a pas de référence.
 */
export function normalizeNoteAudience(
  entries: readonly NoteAudienceEntry[],
): readonly NoteAudienceEntry[] {
  const unique = new Map<string, NoteAudienceEntry>();
  for (const entry of entries) {
    if (entry.type === 'ALL') {
      unique.set('ALL', { type: 'ALL' });
      continue;
    }
    const ref = entry.type === 'ROLE' ? entry.ref.trim() : entry.ref.trim().toLowerCase();
    unique.set(`${entry.type}:${ref}`, { type: entry.type, ref });
  }
  return [...unique.values()].sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      ('ref' in a ? a.ref : '').localeCompare('ref' in b ? b.ref : ''),
  );
}

/** Ligne de `communication_note_audiences` d'une ligne d'audience. */
export function noteAudienceRow(entry: NoteAudienceEntry): {
  readonly audienceType: NoteAudienceType;
  readonly audienceRef: string;
} {
  return {
    audienceType: entry.type,
    audienceRef: entry.type === 'ALL' ? NOTE_AUDIENCE_ALL_REF : entry.ref,
  };
}

/** Ligne d'audience d'une ligne de `communication_note_audiences`. */
export function noteAudienceEntryOfRow(
  audienceType: string,
  audienceRef: string,
): NoteAudienceEntry {
  if (audienceType === 'ALL') return { type: 'ALL' };
  if (
    audienceType === 'ROLE' ||
    audienceType === 'SITE' ||
    audienceType === 'ZONE' ||
    audienceType === 'USER'
  ) {
    return { type: audienceType, ref: audienceRef };
  }
  throw new Error(`Type d'audience inconnu : ${audienceType}`);
}

/** Géographie nécessaire pour développer les lignes `SITE` et `ZONE` (fournie par l'adaptateur). */
export interface AudienceGeography {
  /** Zone d'un site, `null` si le site est inconnu. */
  zoneOfSite(siteId: string): string | null;
  /** La zone et ses ancêtres (la zone seule si elle n'a pas d'ancêtre ou n'est pas connue). */
  lineageOf(zoneId: string): readonly string[];
  /** La zone et ses descendantes. */
  descendantsOrSelfOf(zoneId: string): readonly string[];
  /** Sites rattachés directement à l'une de ces zones. */
  sitesInZones(zoneIds: ReadonlySet<string>): readonly string[];
}

/** Audience ramenée à des ensembles : comparés aux affectations d'un utilisateur par {@link userInAudience}. */
export interface ExpandedNoteAudience {
  readonly all: boolean;
  readonly roleCodes: ReadonlySet<string>;
  readonly userIds: ReadonlySet<string>;
  /** Sites dont une affectation de portée `SITE` correspond. */
  readonly siteIds: ReadonlySet<string>;
  /** Zones dont une affectation de portée `ZONE` correspond. */
  readonly zoneIds: ReadonlySet<string>;
}

export function expandNoteAudience(
  entries: readonly NoteAudienceEntry[],
  geography: AudienceGeography,
): ExpandedNoteAudience {
  let all = false;
  const roleCodes = new Set<string>();
  const userIds = new Set<string>();
  const siteIds = new Set<string>();
  const zoneIds = new Set<string>();
  for (const entry of normalizeNoteAudience(entries)) {
    switch (entry.type) {
      case 'ALL':
        all = true;
        break;
      case 'ROLE':
        roleCodes.add(entry.ref);
        break;
      case 'USER':
        userIds.add(entry.ref);
        break;
      case 'SITE': {
        siteIds.add(entry.ref);
        const zone = geography.zoneOfSite(entry.ref);
        // Une affectation de zone sur la zone du site ou sur l'un de ses ancêtres couvre ce site.
        if (zone !== null) for (const covering of geography.lineageOf(zone)) zoneIds.add(covering);
        break;
      }
      case 'ZONE': {
        // La zone est couverte par ses ancêtres et par elle-même, et elle couvre ses descendantes.
        for (const covering of geography.lineageOf(entry.ref)) zoneIds.add(covering);
        const within = new Set(geography.descendantsOrSelfOf(entry.ref));
        for (const zone of within) zoneIds.add(zone);
        for (const site of geography.sitesInZones(within)) siteIds.add(site);
        break;
      }
    }
  }
  return { all, roleCodes, userIds, siteIds, zoneIds };
}

/** Affectation active d'un utilisateur, telle que l'adaptateur la lit. */
export interface AudienceAssignment {
  readonly roleCode: string;
  readonly scope: 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';
  readonly siteId: string | null;
  readonly zoneId: string | null;
}

/** Une affectation suffit-elle à toucher son titulaire (hors `ALL` et `USER`, qui ne dépendent pas d'elle) ? */
export function assignmentInAudience(
  assignment: AudienceAssignment,
  audience: ExpandedNoteAudience,
): boolean {
  if (audience.roleCodes.has(assignment.roleCode)) return true;
  if (assignment.scope === 'SITE') {
    return assignment.siteId !== null && audience.siteIds.has(assignment.siteId);
  }
  if (assignment.scope === 'ZONE') {
    return assignment.zoneId !== null && audience.zoneIds.has(assignment.zoneId);
  }
  return false;
}

/**
 * L'utilisateur est-il touché ? `assignments` : ses affectations **actives** à l'instant jugé. Un utilisateur
 * sans affectation active n'est jamais touché (il n'a rien à y faire : comme les destinataires d'alerte).
 */
export function userInAudience(
  userId: string,
  assignments: readonly AudienceAssignment[],
  audience: ExpandedNoteAudience,
): boolean {
  if (assignments.length === 0) return false;
  if (audience.all || audience.userIds.has(userId.toLowerCase())) return true;
  return assignments.some((assignment) => assignmentInAudience(assignment, audience));
}
