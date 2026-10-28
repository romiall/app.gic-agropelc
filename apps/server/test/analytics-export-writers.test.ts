/**
 * P9-20 — écrivains d'export (ADR-067 §4) : CSV (BOM, séparateur `;`, point décimal, guillemets, injection de
 * formule), ZIP (CRC-32, relecture) et XLSX (archive relue : entrées attendues, cellules numériques, dates en numéro de
 * série, chaînes en ligne protégées contre l'injection de formule). Sans base de données.
 */
import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import type { CompiledColumn } from '../src/modules/analytics/application/query/compile-exploration.js';
import {
  CSV_BOM,
  csvCell,
  csvHeader,
  csvRows,
  guardFormula,
} from '../src/modules/analytics/application/exports/csv-writer.js';
import {
  buildXlsx,
  columnLetters,
  excelSerialOfDay,
  sheetXml,
} from '../src/modules/analytics/application/exports/xlsx-writer.js';
import {
  crc32,
  crc32Async,
  zipArchive,
} from '../src/modules/analytics/application/exports/zip-writer.js';

const COLUMNS: readonly CompiledColumn[] = [
  { name: 'business_day', label: 'Jour', kind: 'dimension', alias: 'd0', dimensionType: 'date' },
  { name: 'customer', label: 'Client; nom', kind: 'dimension', alias: 'd1', dimensionType: 'text' },
  { name: 'revenue', label: "Chiffre d'affaires", kind: 'measure', alias: 'm0', unit: 'xaf' },
];

/** Lecteur de référence (test seulement) : relit les entrées d'une archive par son répertoire central. */
function readZip(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressed = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const dataStart =
      local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('CSV d’export', () => {
  it('l’entête commence par le BOM UTF-8 et porte les libellés, séparés par « ; », entre guillemets si besoin', () => {
    const header = csvHeader(COLUMNS);
    expect(header.startsWith(CSV_BOM)).toBe(true);
    expect(header).toBe(`${CSV_BOM}Jour;"Client; nom";Chiffre d'affaires\r\n`);
  });

  it('les lignes : point décimal, vide pour une valeur absente, Oui / Non pour un booléen, guillemets doublés', () => {
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(-3000)).toBe('-3000');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('Oui');
    expect(csvCell(false)).toBe('Non');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(
      csvRows(COLUMNS, [
        { business_day: '2026-10-22', customer: 'Dupont', revenue: 15000 },
        { business_day: '2026-10-23', customer: null, revenue: null },
      ]),
    ).toBe('2026-10-22;Dupont;15000\r\n2026-10-23;;\r\n');
  });

  it('injection de formule : une cellule texte qui commence par = + - @ tabulation ou retour est préfixée d’une apostrophe, un nombre ne l’est jamais', () => {
    for (const text of ['=SUM(A1:A9)', '+33', '-1', '@cmd', '\tx', '\rx']) {
      expect(guardFormula(text)).toBe(`'${text}`);
    }
    expect(guardFormula('Dupont')).toBe('Dupont');
    expect(guardFormula('')).toBe('');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell(-42)).toBe('-42');
    // Le texte protégé reste une seule cellule quand il contient le séparateur.
    expect(csvCell('=A;B')).toBe(`"'=A;B"`);
  });
});

describe('archive ZIP', () => {
  it('CRC-32 de référence (« 123456789 » vaut 0xCBF43926)', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('une archive relue rend les entrées, compressées ou stockées, avec leur CRC', async () => {
    const big = Buffer.from('abcdefghij'.repeat(500), 'utf8');
    const small = Buffer.from('ok', 'utf8');
    const entries = readZip(
      await zipArchive([
        { name: 'dossier/grand.txt', data: big },
        { name: 'petit.txt', data: small },
        { name: 'é.txt', data: Buffer.from('accent', 'utf8') },
      ]),
    );
    expect([...entries.keys()]).toEqual(['dossier/grand.txt', 'petit.txt', 'é.txt']);
    expect(entries.get('dossier/grand.txt')!.equals(big)).toBe(true);
    expect(entries.get('petit.txt')!.toString('utf8')).toBe('ok');
    expect(entries.get('é.txt')!.toString('utf8')).toBe('accent');
  });
});

describe('classeur XLSX', () => {
  it('numéro de série Excel : 1970-01-01 vaut 25569, 1900-03-01 vaut 61, une date impossible est refusée', () => {
    expect(excelSerialOfDay('1970-01-01')).toBe(25569);
    expect(excelSerialOfDay('1900-03-01')).toBe(61);
    expect(excelSerialOfDay('pas une date')).toBeNull();
  });

  it('lettres de colonne : 0 → A, 25 → Z, 26 → AA, 701 → ZZ, 702 → AAA', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLetters)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'ZZ',
      'AAA',
    ]);
  });

  it('la feuille : entête en gras, nombres numériques, date en série stylée, texte en ligne protégé, valeur absente omise', () => {
    const xml = sheetXml(COLUMNS, [
      { business_day: '2026-10-22', customer: '=cmd|calc', revenue: 15000 },
      { business_day: '2026-10-23', customer: 'A & <B>', revenue: null },
    ]);
    expect(xml).toContain(
      '<c r="A1" t="inlineStr" s="2"><is><t xml:space="preserve">Jour</t></is></c>',
    );
    expect(xml).toContain(`<c r="A2" s="1"><v>${excelSerialOfDay('2026-10-22')}</v></c>`);
    // Aucune formule : la chaîne reste en ligne, avec son apostrophe.
    expect(xml).toContain('<t xml:space="preserve">\'=cmd|calc</t>');
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('<c r="C2"><v>15000</v></c>');
    expect(xml).toContain('A &amp; &lt;B&gt;');
    expect(xml).not.toContain('r="C3"');
  });

  it('le classeur est une archive complète : types de contenu, relations, classeur, styles, feuille', async () => {
    const entries = readZip(
      await buildXlsx(
        COLUMNS,
        [{ business_day: '2026-10-22', customer: 'Dupont', revenue: 1 }],
        'Export f_sales_line',
      ),
    );
    expect([...entries.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain(
      'name="Export f_sales_line"',
    );
    expect(entries.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('Dupont');
    // Nom de feuille : caractères interdits remplacés, 31 caractères au plus.
    const long = readZip(await buildXlsx(COLUMNS, [], 'a/b:c*d?e[f]g'.padEnd(60, 'x')));
    const name = /name="([^"]*)"/.exec(long.get('xl/workbook.xml')!.toString('utf8'))![1]!;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });
});

describe('XLSX volumineux (P9-25, EX-4)', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      business_day: '2026-10-22',
      customer: `Client ${index}`,
      revenue: index,
    }));

  it('la feuille est écrite par lots : numérotation continue au-delà d’un lot, fin de feuille présente', () => {
    const xml = sheetXml(COLUMNS, rows(4_500));
    expect(xml).toContain('<row r="2">');
    // Un lot compte 2 000 lignes (2 à 2001) : les frontières ne perdent ni ne doublent aucune ligne.
    expect(xml).toContain('<row r="2001">');
    expect(xml).toContain('<row r="2002">');
    expect(xml).toContain('<row r="4501">');
    expect(xml).not.toContain('<row r="4502">');
    expect(xml.endsWith('</sheetData></worksheet>')).toBe(true);
    expect(xml.match(/<row /g)).toHaveLength(4_501);
  });

  it('le CRC par tranches égale le CRC d’un coup, au-delà d’une tranche d’un Mio', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 123);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 31 + 7) & 0xff;
    expect(await crc32Async(data)).toBe(crc32(data));
    expect(await crc32Async(Buffer.alloc(0))).toBe(0);
  });

  it('la construction rend la main à la boucle d’événements entre les lots (aucun gel du worker)', async () => {
    let ticks = 0;
    let running = true;
    const ticker = (async () => {
      while (running) {
        await new Promise((resolve) => setImmediate(resolve));
        ticks += 1;
      }
    })();
    const archive = await buildXlsx(COLUMNS, rows(12_000), 'Gros export');
    running = false;
    await ticker;
    // Douze lots de 2 000 lignes au moins : la boucle reprend la main à chacun (une construction d'un seul tenant
    // n'en laisse aucune).
    expect(ticks).toBeGreaterThanOrEqual(6);
    const entries = readZip(archive);
    expect(entries.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('Client 11999');
  });
});
