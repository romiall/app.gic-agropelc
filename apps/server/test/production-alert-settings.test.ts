/**
 * P9-09, P9-25 (AL-1) : lecture d'un réglage par `siteThenGlobalSetting` (AV-121, AV-411), fonction commune
 * d'`organization` — une valeur de site inexploitable (chaîne, `null`, négative) ne masque pas un
 * réglage global valide ; le réglage du site prime quand il est valide ; le prédicat est celui du réglage. Les réglages sont simulés (les réglages globaux de la base partagée
 * sont immuables et ne se posent pas dans un test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/setting-query.js', () => ({
  currentSettingValue: vi.fn(),
}));

import { isValidBlindReceiptMatchMode, isValidHighMortalityThreshold } from '@gic/domain';
import { currentSettingValue } from '../src/modules/organization/application/public/setting-query.js';
import { siteThenGlobalSetting } from '../src/modules/organization/application/public/site-setting.js';

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

describe('siteThenGlobalSetting (P9-09, AL-1)', () => {
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

  it('sans site, le global est lu en une seule requête (portée GLOBAL)', async () => {
    settings({ site: 30, global: 40 });
    expect(await siteThenGlobalSetting(uow, KEY, null, AT, isValidHighMortalityThreshold)).toBe(40);
    expect(vi.mocked(currentSettingValue)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(currentSettingValue).mock.calls[0]![1]).toMatchObject({ scopeType: 'GLOBAL' });
  });

  it('prédicat propre au réglage : EXACT du site retenu, `exact` cède au global', async () => {
    const mode = 'inventory.blind_receipt_match_mode';
    settings({ site: 'EXACT', global: 'SUBSET' });
    expect(await siteThenGlobalSetting(uow, mode, SITE, AT, isValidBlindReceiptMatchMode)).toBe(
      'EXACT',
    );
    settings({ site: 'exact', global: 'SUBSET' });
    expect(await siteThenGlobalSetting(uow, mode, SITE, AT, isValidBlindReceiptMatchMode)).toBe(
      'SUBSET',
    );
  });

  it('global lui aussi inexploitable : rendu tel quel (l’OrDefault du domaine est le dernier filet)', async () => {
    settings({ site: 'abc', global: 'zzz' });
    expect(await siteThenGlobalSetting(uow, KEY, SITE, AT, isValidHighMortalityThreshold)).toBe(
      'zzz',
    );
  });
});
