/**
 * Thème de l'interface (ADR-049) : clair par défaut ; sombre, ou automatique (suit le téléphone), au
 * choix dans le menu du compte. Le choix se pose sur `<html data-theme>` et se mémorise dans
 * `localStorage`, jamais envoyé au serveur. Lecture et écriture sont protégées : sans stockage
 * (navigation privée, données bloquées), le thème clair s'applique.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'auto';

export const THEME_STORAGE_KEY = 'gic.theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'auto'];

const listeners = new Set<() => void>();
let current: ThemePreference = 'light';

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto';
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Couleur de la barre d'état du téléphone (`<meta name="theme-color">`) : le fond des barres de
 * l'interface (`--surface`) de chaque thème. `styles/tokens.test.ts` vérifie qu'elles restent égales.
 */
export const THEME_COLORS = { light: '#ffffff', dark: '#17241e' } as const;

function syncThemeColor(preference: ThemePreference): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', THEME_COLORS[resolveTheme(preference)]);
}

function apply(preference: ThemePreference): void {
  current = preference;
  document.documentElement.dataset.theme = preference;
  syncThemeColor(preference);
  for (const listener of listeners) listener();
}

/** À appeler avant le premier rendu : applique le choix mémorisé. */
export function initTheme(): void {
  apply(readThemePreference());
  // En mode « automatique », la barre d'état suit le téléphone s'il change de thème en cours de route.
  if (typeof window.matchMedia === 'function') {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener?.('change', () => syncThemeColor(current));
  }
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Pas de stockage : le choix vaut pour cette session seulement.
  }
  apply(preference);
}

/** Thème réellement affiché (« auto » est résolu avec le réglage du téléphone). */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'auto') return preference;
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): readonly [ThemePreference, (value: ThemePreference) => void] {
  const preference = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'light' as const,
  );
  return [preference, setThemePreference] as const;
}
