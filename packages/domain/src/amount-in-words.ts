/**
 * Montant en lettres, en français, pour les pièces imprimées (lot PP, REQ-301 : « arrêté le présent
 * reçu à la somme de … »). Fonction pure, identique sur l'appareil et le serveur (règle 6).
 *
 * Orthographe traditionnelle (celle des pièces de caisse) : traits d'union sous cent, « et » pour
 * 21, 31… 71, « quatre-vingts » et « deux cents » prennent un s quand rien ne les suit, « mille » est
 * invariable et ne prend pas « un » devant lui, « million » et « milliard » s'accordent.
 */
import { assertSafeInteger, DomainError } from './errors.js';

const UNITS = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
] as const;
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'] as const;

/** 0 à 99 ; `final` : rien ne suit dans le nombre (accord de « quatre-vingts »). */
function belowHundred(n: number, final: boolean): string {
  if (n < 20) return UNITS[n]!;
  const ten = Math.floor(n / 10);
  const unit = n % 10;
  if (ten === 7 || ten === 9) {
    // soixante-dix, soixante et onze… quatre-vingt-dix, quatre-vingt-onze…
    const base = ten === 7 ? 'soixante' : 'quatre-vingt';
    const rest = 10 + unit;
    return ten === 7 && unit === 1 ? `${base} et ${UNITS[rest]}` : `${base}-${UNITS[rest]}`;
  }
  if (ten === 8)
    return unit === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${UNITS[unit]}`;
  if (unit === 0) return TENS[ten]!;
  if (unit === 1) return `${TENS[ten]} et un`;
  return `${TENS[ten]}-${UNITS[unit]}`;
}

/** 0 à 999 ; `final` : rien ne suit (accord de « cents » et « quatre-vingts »). */
function belowThousand(n: number, final: boolean): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const words: string[] = [];
  if (hundred === 1) words.push('cent');
  else if (hundred > 1) words.push(`${UNITS[hundred]} ${rest === 0 && final ? 'cents' : 'cent'}`);
  if (rest > 0 || hundred === 0) words.push(belowHundred(rest, final));
  return words.join(' ');
}

const SCALES = [
  { value: 1_000_000_000_000, one: 'billion', many: 'billions' },
  { value: 1_000_000_000, one: 'milliard', many: 'milliards' },
  { value: 1_000_000, one: 'million', many: 'millions' },
] as const;

/** Nombre entier ≥ 0 en toutes lettres (« deux cent quatre-vingt-un mille cinq cents »). */
export function integerInFrenchWords(value: number): string {
  assertSafeInteger(value, 'integerInFrenchWords');
  if (value < 0) {
    throw new DomainError(
      `Un montant en lettres ne peut être négatif (reçu ${value}).`,
      'NEGATIVE_XAF',
    );
  }
  if (value === 0) return UNITS[0];
  const words: string[] = [];
  let rest = value;
  for (const scale of SCALES) {
    const count = Math.floor(rest / scale.value);
    rest %= scale.value;
    if (count > 0)
      words.push(`${integerInFrenchWords(count)} ${count > 1 ? scale.many : scale.one}`);
  }
  const thousands = Math.floor(rest / 1000);
  rest %= 1000;
  // « mille » est invariable ; « quatre-vingt mille », « deux cent mille » sans s.
  if (thousands === 1) words.push('mille');
  else if (thousands > 1) words.push(`${belowThousand(thousands, false)} mille`);
  if (rest > 0) words.push(belowThousand(rest, true));
  return words.join(' ');
}

/** Montant XAF en lettres pour une pièce : « Cinquante mille francs CFA ». */
export function amountXafInFrenchWords(value: number): string {
  const words = integerInFrenchWords(value);
  // « un million de francs », « deux millions de francs » : « de » après un multiple exact.
  const of = /(?:million|milliard|billion)s?$/.test(words) ? ' de' : '';
  // « zéro franc », « un franc » : singulier en dessous de deux.
  const franc = Math.abs(value) < 2 ? 'franc' : 'francs';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${of} ${franc} CFA`;
}
