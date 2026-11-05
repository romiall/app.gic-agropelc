import { describe, expect, it } from 'vitest';
import {
  COMPANY_IDENTITY_SETTINGS,
  COMPANY_VAT_MENTION_SETTING,
  COMPANY_VAT_REGIMES,
  COMPANY_VAT_REGIME_SETTING,
} from './company-identity.js';
import {
  DISCOUNT_SETTING_PREFIX,
  SETTING_CATALOG,
  SETTING_GROUPS,
  WEEKDAY_VALUES,
  settingDefOf,
  validateSettingValue,
  type SettingDef,
} from './settings-catalog.js';

const def = (overrides: Partial<SettingDef> & Pick<SettingDef, 'kind'>): SettingDef => ({
  group: 'control',
  ...overrides,
});

describe('Catalogue des paramètres système (RP-1, ECR-ADM-07)', () => {
  it('chaque clé du catalogue a un domaine connu, des bornes cohérentes et ses options si c’est un choix', () => {
    const entries = Object.entries(SETTING_CATALOG);
    expect(entries.length).toBeGreaterThan(100);
    for (const [key, setting] of entries) {
      expect(SETTING_GROUPS, key).toContain(setting.group);
      if (setting.min !== undefined && setting.max !== undefined) {
        expect(setting.min, key).toBeLessThanOrEqual(setting.max);
      }
      if (setting.kind === 'choice') {
        expect(setting.options?.length, key).toBeGreaterThan(0);
      } else {
        expect(setting.options, key).toBeUndefined();
      }
      if (setting.kind !== 'int' && setting.kind !== 'number') {
        expect(setting.min, key).toBeUndefined();
        expect(setting.max, key).toBeUndefined();
      }
    }
  });

  it('l’identité de la société et le régime de TVA sont des textes libres du groupe « société » (AV-324, AV-451)', () => {
    const keys = Object.values(COMPANY_IDENTITY_SETTINGS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [...keys, COMPANY_VAT_MENTION_SETTING]) {
      expect(settingDefOf(key), key).toEqual({ kind: 'text', group: 'company' });
      // Une rubrique vidée est permise : elle s'imprime en pointillés.
      expect(validateSettingValue(settingDefOf(key)!, ''), key).toBeNull();
    }
    const regime = settingDefOf(COMPANY_VAT_REGIME_SETTING)!;
    expect(regime).toMatchObject({ kind: 'choice', group: 'company' });
    expect(regime.options).toEqual([...COMPANY_VAT_REGIMES]);
    expect(validateSettingValue(regime, 'VAT_EXEMPT')).toBeNull();
    expect(validateSettingValue(regime, 'EXONERE')).toBe('OPTION');
    expect(SETTING_GROUPS).toContain('company');
  });

  it('un réglage lu par site est repéré ; un réglage global ne l’est pas', () => {
    expect(settingDefOf('inventory.high_loss_alert_xaf')?.site).toBe(true);
    expect(settingDefOf('finance.cash_variance_tolerance_xaf')?.site).toBe(true);
    expect(settingDefOf('finance.expense_approval_threshold_xaf')?.site).toBeUndefined();
  });

  it('plafond de remise : un pourcentage par rôle, sous le préfixe, jamais le préfixe seul', () => {
    for (const key of [`${DISCOUNT_SETTING_PREFIX}VENDEUR_PDV`, `${DISCOUNT_SETTING_PREFIX}X`]) {
      expect(settingDefOf(key)).toMatchObject({ kind: 'number', unit: 'pct', min: 0, max: 100 });
    }
    expect(settingDefOf(DISCOUNT_SETTING_PREFIX)).toBeUndefined();
  });

  it('une clé hors catalogue n’a pas de définition (l’écran la traite comme un objet JSON)', () => {
    expect(settingDefOf('une.cle.inconnue')).toBeUndefined();
    expect(settingDefOf('')).toBeUndefined();
  });

  it('jours de la semaine : numéros ISO du lundi au dimanche', () => {
    expect([...WEEKDAY_VALUES]).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
});

describe('validateSettingValue', () => {
  it('entier : type, partie décimale et bornes', () => {
    const bounded = def({ kind: 'int', min: 1, max: 10 });
    expect(validateSettingValue(bounded, 5)).toBeNull();
    expect(validateSettingValue(bounded, 1)).toBeNull();
    expect(validateSettingValue(bounded, 10)).toBeNull();
    expect(validateSettingValue(bounded, '5')).toBe('TYPE');
    expect(validateSettingValue(bounded, Number.NaN)).toBe('TYPE');
    expect(validateSettingValue(bounded, Number.POSITIVE_INFINITY)).toBe('TYPE');
    expect(validateSettingValue(bounded, null)).toBe('TYPE');
    expect(validateSettingValue(bounded, 2.5)).toBe('NOT_INTEGER');
    expect(validateSettingValue(bounded, 0)).toBe('MIN');
    expect(validateSettingValue(bounded, 11)).toBe('MAX');
    expect(validateSettingValue(def({ kind: 'int' }), -1_000_000)).toBeNull();
  });

  it('nombre : décimales admises, bornes en pourcentage', () => {
    const percent = def({ kind: 'number', unit: 'pct', min: 0, max: 100 });
    expect(validateSettingValue(percent, 12.5)).toBeNull();
    expect(validateSettingValue(percent, -0.1)).toBe('MIN');
    expect(validateSettingValue(percent, 100.1)).toBe('MAX');
    expect(validateSettingValue(percent, '12')).toBe('TYPE');
  });

  it('oui/non et texte : le seul type compte', () => {
    expect(validateSettingValue(def({ kind: 'bool' }), false)).toBeNull();
    expect(validateSettingValue(def({ kind: 'bool' }), 'true')).toBe('TYPE');
    expect(validateSettingValue(def({ kind: 'text' }), '')).toBeNull();
    expect(validateSettingValue(def({ kind: 'text' }), 12)).toBe('TYPE');
  });

  it('choix : une des options, sinon OPTION ; sans option, rien n’est admis', () => {
    const choose = def({ kind: 'choice', options: ['ALWAYS', 'NEVER'] });
    expect(validateSettingValue(choose, 'ALWAYS')).toBeNull();
    expect(validateSettingValue(choose, 'SOMETIMES')).toBe('OPTION');
    expect(validateSettingValue(choose, 1)).toBe('OPTION');
    expect(validateSettingValue(def({ kind: 'choice' }), 'ALWAYS')).toBe('OPTION');
  });

  it('liste de textes : textes seulement, aucun vide', () => {
    const items = def({ kind: 'list' });
    expect(validateSettingValue(items, [])).toBeNull();
    expect(validateSettingValue(items, ['ADMIN', 'DIRECTION'])).toBeNull();
    expect(validateSettingValue(items, 'ADMIN')).toBe('TYPE');
    expect(validateSettingValue(items, ['ADMIN', 3])).toBe('TYPE');
    expect(validateSettingValue(items, ['ADMIN', '  '])).toBe('EMPTY_ITEM');
  });

  it('jours de la semaine : numéros de 1 à 7 en texte', () => {
    const week = def({ kind: 'weekdays' });
    expect(validateSettingValue(week, ['1', '2', '3', '4', '5', '6'])).toBeNull();
    expect(validateSettingValue(week, [])).toBeNull();
    expect(validateSettingValue(week, ['0'])).toBe('WEEKDAY');
    expect(validateSettingValue(week, ['8'])).toBe('WEEKDAY');
    expect(validateSettingValue(week, [1, 2])).toBe('TYPE');
    expect(validateSettingValue(week, '1')).toBe('TYPE');
  });

  it('objet JSON : un objet, ni liste, ni nul, ni texte', () => {
    const object = def({ kind: 'json' });
    expect(validateSettingValue(object, {})).toBeNull();
    expect(validateSettingValue(object, { A: ['B'] })).toBeNull();
    expect(validateSettingValue(object, [])).toBe('JSON_OBJECT');
    expect(validateSettingValue(object, null)).toBe('JSON_OBJECT');
    expect(validateSettingValue(object, 'x')).toBe('JSON_OBJECT');
  });
});
