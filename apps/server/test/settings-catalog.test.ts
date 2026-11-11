/**
 * Catalogue des paramètres (RP-1, ECR-ADM-07, AV-490) : chaque clé semée figure au catalogue partagé
 * (`@gic/contracts`), et chaque valeur par défaut respecte la forme, l'unité et les bornes que l'écran impose
 * à la saisie. Sans cela, l'écran proposerait une valeur que le semis lui-même refuserait. Sans base de données.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_IDENTITY_SETTINGS,
  COMPANY_VAT_MENTION_SETTING,
  COMPANY_VAT_REGIME_SETTING,
  DISCOUNT_SETTING_PREFIX,
  SETTING_CATALOG,
  settingDefOf,
  validateSettingValue,
} from '@gic/contracts';
import { ROLE_DISCOUNT_SETTINGS } from '../../../db/seeds/rbac-data.js';
import { SYSTEM_SETTING_REVISIONS, SYSTEM_SETTINGS } from '../../../db/seeds/system-settings.js';
import { DEFAULT_FINANCE_AUDIT_ENTITY_TYPES } from '../src/audit-api/audit-scope.js';

const seeded = [
  ...SYSTEM_SETTINGS.map((setting) => ({ key: setting.key, value: setting.value })),
  ...ROLE_DISCOUNT_SETTINGS.map((setting) => ({ key: setting.key, value: setting.value })),
];

describe('catalogue des paramètres système (ECR-ADM-07)', () => {
  it('chaque clé semée a une définition au catalogue', () => {
    const missing = seeded.filter((setting) => settingDefOf(setting.key) === undefined);
    expect(missing.map((setting) => setting.key)).toEqual([]);
  });

  it('chaque valeur par défaut respecte la forme et les bornes de sa définition', () => {
    const invalid = seeded
      .map((setting) => ({
        key: setting.key,
        problem: validateSettingValue(settingDefOf(setting.key)!, setting.value),
      }))
      .filter((entry) => entry.problem !== null);
    expect(invalid).toEqual([]);
  });

  it('le catalogue ne décrit aucune clé qui ne soit pas semée (pas de clé fantôme)', () => {
    const keys = new Set(seeded.map((setting) => setting.key));
    const ghosts = Object.keys(SETTING_CATALOG).filter((key) => !keys.has(key));
    expect(ghosts).toEqual([]);
  });

  it('les remises par rôle suivent le préfixe du catalogue', () => {
    for (const setting of ROLE_DISCOUNT_SETTINGS) {
      expect(setting.key.startsWith(DISCOUNT_SETTING_PREFIX)).toBe(true);
      expect(settingDefOf(setting.key)).toMatchObject({ kind: 'number', unit: 'pct' });
    }
    expect(settingDefOf(DISCOUNT_SETTING_PREFIX)).toBeUndefined();
  });

  it('l’identité de la société semée est celle de pieces-papier/charte/identite.json, visible des appareils (AV-324, AV-451)', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../pieces-papier/charte/identite.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const seededSetting = (key: string) => SYSTEM_SETTINGS.find((setting) => setting.key === key);
    for (const [field, key] of Object.entries(COMPANY_IDENTITY_SETTINGS)) {
      expect(seededSetting(key)?.value, `${field} → ${key}`).toBe(json[field]);
      expect(seededSetting(key)?.isClientVisible, key).toBe(true);
    }
    // Régime de TVA non précisé et mention vide : les cases de la facture restent à cocher à la main (AV-451 (a)).
    expect(seededSetting(COMPANY_VAT_REGIME_SETTING)).toMatchObject({
      value: 'NOT_SET',
      isClientVisible: true,
    });
    expect(seededSetting(COMPANY_VAT_MENTION_SETTING)).toMatchObject({
      value: '',
      isClientVisible: true,
    });
  });

  it('chaque révision de valeur par défaut vise une clé semée et finit sur la valeur du semis : une base ancienne rejoint une base neuve (BR-ADM-015)', () => {
    const lastByKey = new Map(
      SYSTEM_SETTING_REVISIONS.map((revision) => [revision.key, revision] as const),
    );
    for (const [key, revision] of lastByKey) {
      const seededSetting = SYSTEM_SETTINGS.find((setting) => setting.key === key);
      expect(seededSetting, key).toBeDefined();
      expect(revision.value, key).toEqual(seededSetting!.value);
      expect(revision.isClientVisible, key).toBe(seededSetting!.isClientVisible);
      expect(validateSettingValue(settingDefOf(key)!, revision.value), key).toBeNull();
    }
  });

  it('la révision AV-555 pose l’adresse du siège d’identite.json sur une base semée avec l’ancien défaut vide', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../pieces-papier/charte/identite.json', import.meta.url), 'utf8'),
    ) as { siege: string };
    const revision = SYSTEM_SETTING_REVISIONS.find(
      (entry) => entry.key === COMPANY_IDENTITY_SETTINGS.siege,
    );
    expect(revision).toEqual({
      revision: 'AV-555 (11/11/2026)',
      key: 'company.head_office',
      value: json.siege,
      isClientVisible: true,
    });
    expect(json.siege).toBe('Douala Bonabéri, en face Stade Dikolo');
  });

  it('la révision AV-324 pose les deux numéros d’identite.json sur une base semée avec l’ancien numéro unique', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../pieces-papier/charte/identite.json', import.meta.url), 'utf8'),
    ) as { telephones: string };
    const revision = SYSTEM_SETTING_REVISIONS.find(
      (entry) => entry.key === COMPANY_IDENTITY_SETTINGS.telephones,
    );
    expect(revision).toEqual({
      revision: 'AV-324 (11/11/2026)',
      key: 'company.phones',
      value: json.telephones,
      isClientVisible: true,
    });
    expect(json.telephones.split(' / ')).toEqual(['+237 6 81 12 16 44', '+237 6 94 41 82 47']);
  });

  it('le défaut du serveur pour la Finance égale la liste semée (AV-493)', () => {
    const seededList = SYSTEM_SETTINGS.find(
      (setting) => setting.key === 'audit.finance_entity_types',
    )?.value;
    expect(seededList).toEqual([...DEFAULT_FINANCE_AUDIT_ENTITY_TYPES]);
  });
});
