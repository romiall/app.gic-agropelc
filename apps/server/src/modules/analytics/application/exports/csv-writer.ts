/**
 * CSV d'export (P9-20 ; ADR-077 §4) : UTF-8 avec BOM (Excel), séparateur `;`, point décimal, dates ISO, entêtes en
 * libellés français, fins de ligne `\r\n`. **Injection de formule** : toute cellule texte commençant par `=`, `+`,
 * `-`, `@` (ou une tabulation / un retour chariot) est préfixée d'une apostrophe ; un nombre n'est jamais préfixé
 * (un montant négatif reste un nombre).
 */
import type { CompiledColumn, ExplorationValue } from '../query/compile-exploration.js';

export const CSV_BOM = '﻿';
const SEPARATOR = ';';
const LINE_END = '\r\n';

const FORMULA_STARTS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Texte d'une cellule, protégé contre l'injection de formule. */
export function guardFormula(text: string): string {
  return text.length > 0 && FORMULA_STARTS.has(text[0] as string) ? `'${text}` : text;
}

/** Une cellule CSV : guillemets si elle contient le séparateur, un guillemet ou un saut de ligne. */
export function csvCell(value: ExplorationValue): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  const text = guardFormula(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** La ligne d'entête (BOM comprise) : les libellés des colonnes. */
export function csvHeader(columns: readonly CompiledColumn[]): string {
  return CSV_BOM + columns.map((column) => csvCell(column.label)).join(SEPARATOR) + LINE_END;
}

/** Les lignes de données, une chaîne par appel (écriture par morceaux). */
export function csvRows(
  columns: readonly CompiledColumn[],
  rows: readonly Record<string, ExplorationValue>[],
): string {
  let out = '';
  for (const row of rows) {
    out += columns.map((column) => csvCell(row[column.name] ?? null)).join(SEPARATOR) + LINE_END;
  }
  return out;
}
