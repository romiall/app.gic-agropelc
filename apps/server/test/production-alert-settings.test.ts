/**
 * P9-09 : lecture des seuils de mortalité par `siteThenGlobalSetting` (AV-121, AV-411) — une valeur de
 * site inexploitable (chaîne, `null`, négative) ne masque pas un réglage global valide ; le réglage
 * du site prime quand il est valide. Les réglages sont simulés (les réglages globaux de la base partagée
 * sont immuables et ne se posent pas dans un test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', () => ({
  currentSettingValue: vi.fn(),
}));

import { isValidHighMortalityThreshold } from '@gic/domain';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { siteThenGlobalSetting } from '../src/modules/production/application/production-alert-events.js';

const KEY = 'production.high_mortality_alert_heads';
const SITE = '0192a000-0000-7000-8000-0000000000b1';
const AT = new Date('2026-10-26T08:00:00.000Z');
const uow = {} as never;

function settings(values: { readonly site?: unknown; readonly global?: unknown }) {
  vi.mocked(currentSettingValue).mockImplementation(async (_executor, input) => {
    const { scopeType } = input as { scopeType: string };
    return scopeType === 'SITE' ? values.site : values.global;
  });
}

describe('siteThenGlobalSetting (P9-09)', () => {
  beforeEach(() => {
    vi.mocked(currentSettingValue).mockReset();
  });

  it('une valeur de site valide prime sur le global', async () => {
    settings({ site: 30, global: 40 });
    expect(await siteThenGlobalSetting(uow, KEY, SITE, AT, isValidHighMortalityThreshold)).toBe(30);
  });

  it('une valeur de site inexploitable ne masque pas un global valide', async () => {
    for (const site of ['30', null, -1, Number.NaN, {}]) {
      settings({ site, global: 40 });
      expect(await siteThenGlobalSetting(uow, KEY, SITE, AT, isValidHighMortalityThreshold)).toBe(
        40,
      );
    }
  });

  it('sans réglage de site, ou sans site, le global est lu ; 0 est une valeur valide', async () => {
    settings({ site: undefined, global: 40 });
    expect(await siteThenGlobalSetting(uow, KEY, SITE, AT, isValidHighMortalityThreshold)).toBe(40);
    expect(await siteThenGlobalSetting(uow, KEY, null, AT, isValidHighMortalityThreshold)).toBe(40);
    settings({ site: 0, global: 40 });
    expect(await siteThenGlobalSetting(uow, KEY, SITE, AT, isValidHighMortalityThreshold)).toBe(0);
  });

  it('sans prédicat, la valeur du site est rendue telle quelle (lecture générique)', async () => {
    settings({ site: '30', global: 40 });
    expect(await siteThenGlobalSetting(uow, KEY, SITE, AT)).toBe('30');
  });
});
