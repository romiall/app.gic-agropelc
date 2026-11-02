/**
 * Catalogue des paramètres (RP-1, ECR-ADM-07, AV-490) : chaque clé semée figure au catalogue partagé
 * (`@gic/contracts`), et chaque valeur par défaut respecte la forme, l'unité et les bornes que l'écran impose
 * à la saisie. Sans cela, l'écran proposerait une valeur que le semis lui-même refuserait. Sans base de données.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCOUNT_SETTING_PREFIX,
  SETTING_CATALOG,
  settingDefOf,
  validateSettingValue,
} from '@gic/contracts';
import { ROLE_DISCOUNT_SETTINGS } from '../../../db/seeds/rbac-data.js';
import { SYSTEM_SETTINGS } from '../../../db/seeds/system-settings.js';
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

  it('le défaut du serveur pour la Finance égale la liste semée (AV-493)', () => {
    const seededList = SYSTEM_SETTINGS.find(
      (setting) => setting.key === 'audit.finance_entity_types',
    )?.value;
    expect(seededList).toEqual([...DEFAULT_FINANCE_AUDIT_ENTITY_TYPES]);
  });
});
