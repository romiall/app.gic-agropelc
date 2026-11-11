/**
 * Pointage désactivé pour le pilote (AV-537 ; décision du porteur du 08/11/2026, questionnaire Q44) : le réglage
 * `fieldwork.checkin_enabled` de l'appareil. Même règle que le serveur : valeur absente ou mal formée = vrai.
 */
import { describe, expect, it } from 'vitest';
import type { SettingData } from '../sales/types.js';
import { checkinEnabled, presentedFlags } from './checkin-setting.js';

const NOW = new Date('2026-11-10T08:00:00.000Z');

const setting = (
  value: unknown,
  validFrom = '2026-01-01T00:00:00.000Z',
  scope: { type: string; id: string | null } = { type: 'GLOBAL', id: null },
): SettingData => ({
  id: `s-${validFrom}-${String(value)}`,
  key: 'fieldwork.checkin_enabled',
  value,
  scope_type: scope.type,
  scope_id: scope.id,
  valid_from: validFrom,
});

describe('checkinEnabled (AV-537)', () => {
  it('sans réglage connu, le pointage est en service (comportement d’avant la décision)', () => {
    expect(checkinEnabled([], NOW)).toBe(true);
  });

  it('réglage global faux : désactivé ; vrai : en service', () => {
    expect(checkinEnabled([setting(false)], NOW)).toBe(false);
    expect(checkinEnabled([setting(true)], NOW)).toBe(true);
  });

  it('la version la plus récente en vigueur décide, une version future n’a pas encore d’effet', () => {
    const settings = [
      setting(false, '2026-01-01T00:00:00.000Z'),
      setting(true, '2026-11-01T00:00:00.000Z'),
      setting(false, '2026-12-01T00:00:00.000Z'),
    ];
    expect(checkinEnabled(settings, NOW)).toBe(true);
    expect(checkinEnabled(settings, new Date('2026-12-15T00:00:00.000Z'))).toBe(false);
  });

  it('une valeur qui n’est pas un booléen est ignorée (vrai)', () => {
    expect(checkinEnabled([setting('non')], NOW)).toBe(true);
    expect(checkinEnabled([setting(0)], NOW)).toBe(true);
    expect(checkinEnabled([setting(null)], NOW)).toBe(true);
  });

  it('un réglage propre à un site n’est pas lu : le pointage est un réglage global', () => {
    expect(checkinEnabled([setting(false, undefined, { type: 'SITE', id: 'site-1' })], NOW)).toBe(
      true,
    );
  });
});

describe('presentedFlags (AV-537)', () => {
  const flags = ['STOCK_NEGATIVE', 'OUT_OF_SESSION', 'PRICE_MISMATCH'];

  it('pointage en service, tous les indicateurs sont présentés', () => {
    expect(presentedFlags(flags, true)).toEqual(flags);
  });

  it('pointage désactivé, « hors prise de service » n’est plus présenté, les autres restent', () => {
    expect(presentedFlags(flags, false)).toEqual(['STOCK_NEGATIVE', 'PRICE_MISMATCH']);
    expect(presentedFlags(['OUT_OF_SESSION'], false)).toEqual([]);
  });
});
