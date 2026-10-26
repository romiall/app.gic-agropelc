/**
 * Classeur XLSX minimal (P9-20 ; ADR-067 §4) : OOXML à une feuille, sans dépendance. Chaînes en `inlineStr`
 * (aucune table de chaînes partagées), nombres numériques, dates `AAAA-MM-JJ` en numéro de série avec le format
 * `yyyy-mm-dd`, booléens `Oui` / `Non`. Une cellule texte commençant par `=`, `+`, `-` ou `@` est préfixée d'une
 * apostrophe (injection de formule) ; elle reste une chaîne en ligne, jamais une formule.
 */
import type { CompiledColumn, ExplorationValue } from '../query/compile-exploration.js';
import { guardFormula } from './csv-writer.js';
import { zipArchive } from './zip-writer.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** Style `s="1"` : date au format `yyyy-mm-dd` (numFmt 164) ; `s="2"` : entête en gras. */
const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Jours depuis le 1900-01-00 d'Excel (le 1900-03-01 vaut 61 : le faux 29/02/1900 est compté). */
export function excelSerialOfDay(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const epoch = Date.UTC(1899, 11, 30);
  const serial = Math.round((time - epoch) / 86_400_000);
  return Number.isFinite(serial) ? serial : null;
}

/** Caractères de contrôle interdits en XML 1.0 (hors tabulation, saut de ligne, retour chariot). */
const isXmlControl = (code: number): boolean =>
  code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;

const xmlText = (text: string): string => {
  let clean = '';
  for (const character of text) {
    if (!isXmlControl(character.charCodeAt(0))) clean += character;
  }
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

/** Nom de colonne de feuille : 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function stringCell(ref: string, text: string, style = 0): string {
  const s = style === 0 ? '' : ` s="${style}"`;
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function dataCell(ref: string, column: CompiledColumn, value: ExplorationValue): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  }
  if (typeof value === 'boolean') return stringCell(ref, value ? 'Oui' : 'Non');
  if (column.dimensionType === 'date') {
    const serial = excelSerialOfDay(value);
    if (serial !== null) return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
  }
  return stringCell(ref, guardFormula(value));
}

/** Le contenu XML de la feuille : l'entête puis les lignes. */
export function sheetXml(
  columns: readonly CompiledColumn[],
  rows: readonly Record<string, ExplorationValue>[],
): string {
  const header = columns
    .map((column, index) => stringCell(`${columnLetters(index)}1`, column.label, 2))
    .join('');
  const body = rows
    .map((row, rowIndex) => {
      const number = rowIndex + 2;
      const cells = columns
        .map((column, index) =>
          dataCell(`${columnLetters(index)}${number}`, column, row[column.name] ?? null),
        )
        .join('');
      return `<row r="${number}">${cells}</row>`;
    })
    .join('');
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
}

/** Le classeur complet (une feuille nommée `sheetName`, 31 caractères au plus, sans `[]:*?/\`). */
export function buildXlsx(
  columns: readonly CompiledColumn[],
  rows: readonly Record<string, ExplorationValue>[],
  sheetName: string,
): Buffer {
  const name = xmlText(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31)) || 'Export';
  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `${XML_HEAD}<Types xmlns="${CONTENT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
        'utf8',
      ),
    },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(columns, rows), 'utf8') },
  ];
  return zipArchive(entries);
}
