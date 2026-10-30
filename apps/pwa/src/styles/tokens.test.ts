/**
 * Jetons de design (ADR-049) : le bloc sombre est écrit deux fois (`data-theme="dark"` et `auto` sous
 * `prefers-color-scheme`), chaque jeton clair a son pendant sombre, les contrastes de texte et de
 * contrôle tiennent le niveau AA dans les deux thèmes, et aucune feuille de style de composants
 * n'écrit de couleur en dur.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_COLORS } from '../components/ui/theme.js';

// Chemins explicites : `new URL('./x.css', import.meta.url)` serait pris par Vite pour un actif à servir.
const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string =>
  readFileSync(join(here, relative), 'utf8').replace(/\r\n/g, '\n');

const tokens = read('tokens.css');

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim().replace(/\s+/g, ' '));
  }
  return map;
}

function blockOf(pattern: RegExp): Map<string, string> {
  const found = pattern.exec(tokens);
  if (!found) throw new Error(`Bloc introuvable : ${String(pattern)}`);
  return declarations(found[1]!);
}

const light = blockOf(/^:root\s*\{([^}]*)\}/m);
const dark = blockOf(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
const auto = blockOf(
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\[data-theme='auto'\]\s*\{([^}]*)\}/,
);

/** Jetons qui ne changent pas avec le thème (typographie, espacement, formes, gestes, mouvement). */
const FIXED =
  /^(font-|text-|leading|space-|radius-|control-|field-|gutter|content-|nav-w|bar-h|tabbar-h|ease|dur)/;

describe('tokens.css', () => {
  it('écrit le bloc sombre « automatique » comme le bloc sombre', () => {
    expect([...auto.entries()]).toEqual([...dark.entries()]);
  });

  it('donne un pendant sombre à chaque jeton de couleur ou d’ombre', () => {
    const themed = [...light.keys()].filter((name) => !FIXED.test(name));
    expect(themed.length).toBeGreaterThan(30);
    expect(themed.filter((name) => !dark.has(name))).toEqual([]);
    expect([...dark.keys()].filter((name) => !light.has(name))).toEqual([]);
  });

  it('garde la barre d’état du téléphone égale au fond des barres (--surface) de chaque thème', () => {
    expect(THEME_COLORS.light).toBe(light.get('surface'));
    expect(THEME_COLORS.dark).toBe(dark.get('surface'));
  });

  it('n’écrit aucune couleur en dur dans les feuilles de composants', () => {
    for (const file of ['base.css', 'components.css', 'shell.css', 'home.css', 'screens.css']) {
      expect(read(file).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], file).toEqual([]);
    }
    const legacy = read('../app/app.css');
    expect(legacy.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], 'app.css').toEqual([]);
  });
});

// --- Contrastes WCAG (texte >= 4,5 ; bordure de contrôle >= 3) ------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink', 'surface-2'],
  ['ink', 'brand-tint'],
  ['ink-2', 'bg'],
  ['ink-2', 'surface'],
  ['ink-2', 'surface-2'],
  ['ink-3', 'bg'],
  ['ink-3', 'surface'],
  ['ink-3', 'surface-2'],
  ['brand-ink', 'brand'],
  ['brand-strong', 'brand-tint'],
  ['brand-strong', 'surface'],
  ['brand-strong', 'bg'],
  ['ok', 'ok-tint'],
  ['ok', 'surface'],
  ['warn', 'warn-tint'],
  ['warn', 'surface'],
  ['bad', 'bad-tint'],
  ['bad', 'surface'],
  ['bad-ink', 'bad'],
  ['info', 'info-tint'],
  ['info', 'surface'],
  ['nav-ink', 'nav'],
  ['nav-ink-2', 'nav'],
  ['nav-ink', 'nav-active'],
  ['gold-ink', 'gold'],
  ['bg', 'ink'],
];
const CONTROL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['line-strong', 'surface'],
  ['line-strong', 'bg'],
  ['brand', 'surface'],
  ['brand', 'bg'],
  ['focus', 'bg'],
];

describe.each([
  ['clair', light],
  ['sombre', dark],
])('contrastes du thème %s', (_name, theme) => {
  const color = (token: string): string => {
    const value = (theme.get(token) ?? light.get(token))!;
    expect(value, `--${token}`).toMatch(/^#[0-9a-f]{6}$/i);
    return value;
  };

  it.each(TEXT_PAIRS)('texte --%s sur --%s : au moins 4,5', (foreground, background) => {
    expect(ratio(color(foreground), color(background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CONTROL_PAIRS)('contrôle --%s sur --%s : au moins 3', (foreground, background) => {
    expect(ratio(color(foreground), color(background))).toBeGreaterThanOrEqual(3);
  });
});
