import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  initTheme,
  readThemePreference,
  resolveTheme,
  setThemePreference,
} from './theme.js';

describe('thème de l’interface', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('est clair par défaut, avec ou sans valeur mémorisée invalide', () => {
    expect(readThemePreference()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'violet');
    expect(readThemePreference()).toBe('light');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('mémorise le choix et le pose sur <html>', () => {
    setThemePreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    document.documentElement.dataset.theme = 'light';
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('retombe sur le thème clair quand le stockage est bloqué', () => {
    const proto = Object.getPrototypeOf(window.localStorage) as Storage;
    vi.spyOn(proto, 'getItem').mockImplementation(() => {
      throw new Error('stockage bloqué');
    });
    vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new Error('stockage bloqué');
    });
    expect(readThemePreference()).toBe('light');
    expect(() => setThemePreference('auto')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('auto');
  });

  it('résout « automatique » avec le réglage du téléphone', () => {
    const query = (matches: boolean) =>
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as MediaQueryList);
    query(true);
    expect(resolveTheme('auto')).toBe('dark');
    query(false);
    expect(resolveTheme('auto')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });
});
