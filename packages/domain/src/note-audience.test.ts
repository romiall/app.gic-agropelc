import { describe, expect, it } from 'vitest';
import {
  NOTE_AUDIENCE_ALL_REF,
  expandNoteAudience,
  normalizeNoteAudience,
  noteAudienceEntryOfRow,
  noteAudienceRow,
  userInAudience,
  type AudienceAssignment,
  type AudienceGeography,
  type NoteAudienceEntry,
} from './note-audience.js';

/**
 * Géographie de test :
 *   RACINE ─ REGION ─┬─ SECTEUR_A ─ SECTEUR_A1
 *                    └─ SECTEUR_B
 *   AUTRE ─ AUTRE_ENFANT
 * Sites : SITE_A1 et SITE_A2 (SECTEUR_A), SITE_A11 (SECTEUR_A1), SITE_B1 (SECTEUR_B), SITE_R (REGION),
 * SITE_X (AUTRE_ENFANT).
 */
const PARENT: Readonly<Record<string, string | null>> = {
  racine: null,
  region: 'racine',
  secteur_a: 'region',
  secteur_a1: 'secteur_a',
  secteur_b: 'region',
  autre: null,
  autre_enfant: 'autre',
};
const SITE_ZONE: Readonly<Record<string, string>> = {
  site_a1: 'secteur_a',
  site_a2: 'secteur_a',
  site_a11: 'secteur_a1',
  site_b1: 'secteur_b',
  site_r: 'region',
  site_x: 'autre_enfant',
};

function lineage(zone: string): string[] {
  const result: string[] = [];
  let current: string | null | undefined = zone;
  while (current !== null && current !== undefined) {
    result.push(current);
    current = PARENT[current];
  }
  return result;
}

const geography: AudienceGeography = {
  zoneOfSite: (site) => SITE_ZONE[site] ?? null,
  lineageOf: (zone) => lineage(zone),
  descendantsOrSelfOf: (zone) => Object.keys(PARENT).filter((z) => lineage(z).includes(zone)),
  sitesInZones: (zones) =>
    Object.entries(SITE_ZONE)
      .filter(([, zone]) => zones.has(zone))
      .map(([site]) => site),
};

const assign = (
  scope: AudienceAssignment['scope'],
  where: { site?: string; zone?: string } = {},
  roleCode = 'ROLE_X',
): AudienceAssignment => ({
  roleCode,
  scope,
  siteId: where.site ?? null,
  zoneId: where.zone ?? null,
});

const USER = '0198c3a0-1111-7aaa-8bbb-000000000001';
const audienceOf = (...entries: NoteAudienceEntry[]) => expandNoteAudience(entries, geography);
const touches = (assignments: AudienceAssignment[], ...entries: NoteAudienceEntry[]) =>
  userInAudience(USER, assignments, audienceOf(...entries));

describe('normalizeNoteAudience', () => {
  it('sans doublon, identifiants en minuscules, codes de rôle intacts, ordre stable', () => {
    const entries = normalizeNoteAudience([
      { type: 'USER', ref: USER.toUpperCase() },
      { type: 'ROLE', ref: ' DIRECTION ' },
      { type: 'ALL' },
      { type: 'ALL' },
      { type: 'SITE', ref: 'AAA' },
      { type: 'SITE', ref: 'aaa' },
      { type: 'ZONE', ref: 'Zzz' },
      { type: 'ROLE', ref: 'DIRECTION' },
    ]);
    expect(entries).toEqual([
      { type: 'ALL' },
      { type: 'ROLE', ref: 'DIRECTION' },
      { type: 'SITE', ref: 'aaa' },
      { type: 'ZONE', ref: 'zzz' },
      { type: 'USER', ref: USER },
    ]);
  });
});

describe('lignes de communication_note_audiences', () => {
  it('ALL porte la référence « * » ; les autres leur référence ; aller-retour', () => {
    expect(noteAudienceRow({ type: 'ALL' })).toEqual({
      audienceType: 'ALL',
      audienceRef: NOTE_AUDIENCE_ALL_REF,
    });
    expect(noteAudienceRow({ type: 'ROLE', ref: 'DIRECTION' })).toEqual({
      audienceType: 'ROLE',
      audienceRef: 'DIRECTION',
    });
    expect(noteAudienceEntryOfRow('ALL', '*')).toEqual({ type: 'ALL' });
    for (const type of ['ROLE', 'SITE', 'ZONE', 'USER'] as const) {
      expect(noteAudienceEntryOfRow(type, 'ref')).toEqual({ type, ref: 'ref' });
    }
    expect(() => noteAudienceEntryOfRow('TEAM', 'x')).toThrow(/inconnu/);
  });
});

describe('expandNoteAudience', () => {
  it('SITE : le site, et la zone du site avec ses ancêtres (une zone couvre ses sites)', () => {
    const expanded = audienceOf({ type: 'SITE', ref: 'site_a1' });
    expect([...expanded.siteIds]).toEqual(['site_a1']);
    expect([...expanded.zoneIds].sort()).toEqual(['racine', 'region', 'secteur_a']);
    expect(expanded.all).toBe(false);
  });

  it('ZONE : ses ancêtres, elle-même, ses descendantes, et les sites de la zone et de ses descendantes', () => {
    const expanded = audienceOf({ type: 'ZONE', ref: 'secteur_a' });
    expect([...expanded.zoneIds].sort()).toEqual(['racine', 'region', 'secteur_a', 'secteur_a1']);
    expect([...expanded.siteIds].sort()).toEqual(['site_a1', 'site_a11', 'site_a2']);
  });

  it('ROLE, USER et ALL', () => {
    const expanded = audienceOf(
      { type: 'ROLE', ref: 'DIRECTION' },
      { type: 'USER', ref: USER.toUpperCase() },
      { type: 'ALL' },
    );
    expect(expanded.all).toBe(true);
    expect([...expanded.roleCodes]).toEqual(['DIRECTION']);
    expect([...expanded.userIds]).toEqual([USER]);
  });

  it('un site inconnu ne couvre que ses propres affectations de site', () => {
    const expanded = audienceOf({ type: 'SITE', ref: 'site_inconnu' });
    expect([...expanded.siteIds]).toEqual(['site_inconnu']);
    expect(expanded.zoneIds.size).toBe(0);
  });
});

describe('userInAudience — SITE', () => {
  const site = { type: 'SITE', ref: 'site_a1' } as const;

  it('affectation de ce site : touché ; d’un autre site de la même zone : non', () => {
    expect(touches([assign('SITE', { site: 'site_a1' })], site)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_a2' })], site)).toBe(false);
  });

  it('affectation de zone sur la zone du site ou sur un ancêtre : touché ; autre zone ou descendante : non', () => {
    expect(touches([assign('ZONE', { zone: 'secteur_a' })], site)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'region' })], site)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'racine' })], site)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'secteur_b' })], site)).toBe(false);
    expect(touches([assign('ZONE', { zone: 'secteur_a1' })], site)).toBe(false);
    expect(touches([assign('ZONE', { zone: 'autre' })], site)).toBe(false);
  });

  it('affectation GLOBAL ou TEAM : non (la note d’un site ne réveille pas toute la Direction)', () => {
    expect(touches([assign('GLOBAL')], site)).toBe(false);
    expect(touches([assign('TEAM')], site)).toBe(false);
  });
});

describe('userInAudience — ZONE', () => {
  const zone = { type: 'ZONE', ref: 'secteur_a' } as const;

  it('affectation de zone : cette zone, un ancêtre qui la couvre, une descendante', () => {
    expect(touches([assign('ZONE', { zone: 'secteur_a' })], zone)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'region' })], zone)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'secteur_a1' })], zone)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'secteur_b' })], zone)).toBe(false);
    expect(touches([assign('ZONE', { zone: 'autre_enfant' })], zone)).toBe(false);
  });

  it('affectation de site : un site de la zone ou d’une descendante ; pas un site d’une autre zone ni de l’ancêtre', () => {
    expect(touches([assign('SITE', { site: 'site_a1' })], zone)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_a11' })], zone)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_b1' })], zone)).toBe(false);
    expect(touches([assign('SITE', { site: 'site_r' })], zone)).toBe(false);
    expect(touches([assign('SITE', { site: 'site_x' })], zone)).toBe(false);
  });

  it('une région touche ses secteurs et leurs sites', () => {
    const region = { type: 'ZONE', ref: 'region' } as const;
    expect(touches([assign('SITE', { site: 'site_a11' })], region)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_r' })], region)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_x' })], region)).toBe(false);
    expect(touches([assign('ZONE', { zone: 'secteur_b' })], region)).toBe(true);
    expect(touches([assign('GLOBAL')], region)).toBe(false);
  });
});

describe('userInAudience — ROLE, USER, ALL, plusieurs lignes', () => {
  it('ROLE : le rôle suffit, quelle que soit la portée de l’affectation', () => {
    const role = { type: 'ROLE', ref: 'DIRECTION' } as const;
    for (const scope of ['GLOBAL', 'SITE', 'ZONE', 'TEAM'] as const) {
      expect(touches([assign(scope, {}, 'DIRECTION')], role)).toBe(true);
      expect(touches([assign(scope, {}, 'MAGASINIER')], role)).toBe(false);
    }
  });

  it('USER : cet utilisateur, s’il a une affectation active ; la casse de l’identifiant ne compte pas', () => {
    const user = { type: 'USER', ref: USER.toUpperCase() } as const;
    expect(touches([assign('GLOBAL')], user)).toBe(true);
    // L'identifiant de l'utilisateur est lui aussi comparé sans égard à la casse.
    expect(userInAudience(USER.toUpperCase(), [assign('GLOBAL')], audienceOf(user))).toBe(true);
    expect(
      userInAudience('0198c3a0-9999-7aaa-8bbb-000000000009', [assign('GLOBAL')], audienceOf(user)),
    ).toBe(false);
  });

  it('ALL : tout utilisateur affecté', () => {
    expect(touches([assign('TEAM')], { type: 'ALL' })).toBe(true);
  });

  it('un utilisateur sans affectation active n’est jamais touché, même désigné', () => {
    expect(touches([], { type: 'ALL' })).toBe(false);
    expect(touches([], { type: 'USER', ref: USER })).toBe(false);
    expect(touches([], { type: 'ROLE', ref: 'DIRECTION' })).toBe(false);
  });

  it('plusieurs lignes : l’union (une seule suffit)', () => {
    const entries: NoteAudienceEntry[] = [
      { type: 'SITE', ref: 'site_b1' },
      { type: 'ZONE', ref: 'autre' },
      { type: 'ROLE', ref: 'DIRECTION' },
    ];
    expect(touches([assign('SITE', { site: 'site_b1' })], ...entries)).toBe(true);
    expect(touches([assign('ZONE', { zone: 'autre_enfant' })], ...entries)).toBe(true);
    expect(touches([assign('GLOBAL', {}, 'DIRECTION')], ...entries)).toBe(true);
    expect(touches([assign('SITE', { site: 'site_a1' })], ...entries)).toBe(false);
  });

  it('plusieurs affectations : une seule qui correspond suffit', () => {
    expect(
      touches([assign('SITE', { site: 'site_a2' }), assign('ZONE', { zone: 'secteur_b' })], {
        type: 'SITE',
        ref: 'site_b1',
      }),
    ).toBe(true);
  });
});
