/**
 * Lecture et écriture de fichiers CSV pour le chargement de données (RP-2, PP-C ; AV-072, AV-317, AV-508).
 *
 * Pure : aucune entrée-sortie. Reconnaît ce qu'Excel produit en « CSV UTF-8 » : marque d'ordre des octets, séparateur
 * point-virgule (réglages régionaux français) ou virgule ou tabulation, champs entre guillemets (`""` pour un
 * guillemet), fins de ligne CRLF, LF ou CR, lignes vides ignorées.
 */

export type CsvSeparator = ';' | ',' | '\t';

export interface ParsedCsv {
  /** En-têtes tels que saisis (espaces rognés). */
  readonly header: readonly string[];
  /** Lignes de données (cellules brutes, espaces rognés) avec leur numéro de ligne dans le fichier (1 = en-tête). */
  readonly rows: readonly { readonly line: number; readonly cells: readonly string[] }[];
  readonly separator: CsvSeparator;
}

/** Plafond de lignes de données lues : au-delà, le fichier est refusé (une erreur claire vaut mieux qu'un blocage). */
export const MAX_CSV_ROWS = 20_000;

export class CsvTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`Fichier trop grand : ${max} lignes de données au plus.`);
    this.name = 'CsvTooLargeError';
  }
}

const SEPARATORS: readonly CsvSeparator[] = [';', ',', '\t'];

/** Séparateur le plus fréquent dans la première ligne, hors guillemets (point-virgule à égalité). */
export function detectSeparator(text: string): CsvSeparator {
  const counts = new Map<CsvSeparator, number>(SEPARATORS.map((separator) => [separator, 0]));
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && (char === ';' || char === ',' || char === '\t')) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  let best: CsvSeparator = ';';
  for (const separator of SEPARATORS) {
    if ((counts.get(separator) ?? 0) > (counts.get(best) ?? 0)) best = separator;
  }
  return best;
}

/** Découpe le texte en enregistrements de cellules brutes, avec le numéro de la ligne où chacun commence. */
function splitRecords(
  text: string,
  separator: CsvSeparator,
  limit: number,
): { readonly line: number; readonly cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let touched = false;

  const endCell = () => {
    cells.push(cell.trim());
    cell = '';
  };
  const endRecord = () => {
    endCell();
    // Une ligne sans aucune cellule remplie (ligne vide, ou séparateurs seuls) est ignorée.
    if (cells.some((value) => value !== '')) records.push({ line: startLine, cells });
    cells = [];
    touched = false;
    // L'en-tête compte pour un enregistrement : `limit` lignes de données au plus.
    if (records.length > limit + 1) throw new CsvTooLargeError(limit);
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (char === separator) {
      touched = true;
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      touched = true;
      cell += char;
    }
  }
  if (cell !== '' || cells.length > 0 || touched) endRecord();
  return records;
}

/**
 * Texte d'un fichier lu en octets : UTF-8 s'il en est, sinon Windows-1252. L'enregistrement « CSV (séparateur :
 * point-virgule) » d'un Excel français n'est pas de l'UTF-8 : lu comme tel, chaque accent deviendrait « � » et le
 * fichier serait chargé abîmé sans que rien ne le signale.
 */
export function decodeCsv(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Lit un fichier CSV : la première ligne non vide est l'en-tête. Lève `CsvTooLargeError` au-delà de `MAX_CSV_ROWS`
 * lignes de données.
 */
export function parseCsv(input: string, limit: number = MAX_CSV_ROWS): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const separator = detectSeparator(text);
  const records = splitRecords(text, separator, limit);
  const [head, ...data] = records;
  if (head === undefined) return { header: [], rows: [], separator };
  return {
    header: head.cells,
    rows: data.map((record) => ({ line: record.line, cells: record.cells })),
    separator,
  };
}

/** Nom de colonne comparable : minuscules, sans accents, tout ce qui n'est pas lettre ou chiffre devient `_`. */
export function normalizeHeaderName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function escapeCell(value: string, separator: CsvSeparator): string {
  return value.includes(separator) || /["\n\r]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Écrit un CSV (point-virgule par défaut, marque d'ordre des octets pour qu'Excel lise l'UTF-8). */
export function toCsv(rows: readonly (readonly string[])[], separator: CsvSeparator = ';'): string {
  const body = rows
    .map((row) => row.map((cell) => escapeCell(cell, separator)).join(separator))
    .join('\r\n');
  return `\uFEFF${body}\r\n`;
}
