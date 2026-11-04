/** Lecture et écriture de CSV (RP-2, PP-C ; AV-508) : ce que produit Excel, sans dépendance. */
import { describe, expect, it } from 'vitest';
import {
  CsvTooLargeError,
  decodeCsv,
  detectSeparator,
  normalizeHeaderName,
  parseCsv,
  toCsv,
} from './csv.js';

describe('decodeCsv', () => {
  it('lit de l’UTF-8, avec ou sans marque d’ordre des octets', () => {
    const utf8 = new TextEncoder().encode('nom;ville\nŒufs;Yaoundé');
    expect(decodeCsv(utf8)).toBe('nom;ville\nŒufs;Yaoundé');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    expect(decodeCsv(withBom)).toBe('nom;ville\nŒufs;Yaoundé');
  });

  it('un fichier enregistré par un Excel français en Windows-1252 garde ses accents', () => {
    // « Yaoundé » et « é » en Windows-1252 : l'octet 0xE9 seul n'est pas de l'UTF-8 valide.
    const ansi = new Uint8Array([
      ...new TextEncoder().encode('ville\nYaound'),
      0xe9,
      ...new TextEncoder().encode(';cr'),
      0xe8,
      ...new TextEncoder().encode('me'),
    ]);
    expect(decodeCsv(ansi)).toBe('ville\nYaoundé;crème');
  });
});

describe('detectSeparator', () => {
  it('prend le séparateur le plus fréquent de la première ligne, hors guillemets', () => {
    expect(detectSeparator('code;nom;unité\nA;B;C')).toBe(';');
    expect(detectSeparator('code,nom,unité\nA,B,C')).toBe(',');
    expect(detectSeparator('code\tnom\tunité\nA\tB\tC')).toBe('\t');
    // Les virgules d'un champ entre guillemets ne comptent pas.
    expect(detectSeparator('"a,b,c";d;e\n1;2;3')).toBe(';');
  });

  it('point-virgule à égalité ou sans séparateur', () => {
    expect(detectSeparator('code\nA')).toBe(';');
    expect(detectSeparator('')).toBe(';');
  });
});

describe('parseCsv', () => {
  it('lit un fichier Excel français : BOM, point-virgule, CRLF', () => {
    const parsed = parseCsv('\uFEFFcode;nom\r\nP1;Poulet\r\nP2;Œufs\r\n');
    expect(parsed.separator).toBe(';');
    expect(parsed.header).toEqual(['code', 'nom']);
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['P1', 'Poulet'] },
      { line: 3, cells: ['P2', 'Œufs'] },
    ]);
  });

  it('champs entre guillemets : séparateur, guillemet doublé et saut de ligne dans la cellule', () => {
    const parsed = parseCsv('a;b\n"x;y";"il dit ""oui"""\n"deux\nlignes";z\nsuite;fin');
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['x;y', 'il dit "oui"'] },
      { line: 3, cells: ['deux\nlignes', 'z'] },
      // La ligne 3 tient sur deux lignes du fichier : la suivante est la 5.
      { line: 5, cells: ['suite', 'fin'] },
    ]);
  });

  it('ignore les lignes vides et celles qui ne portent que des séparateurs ; rogne les espaces', () => {
    const parsed = parseCsv('code ; nom\n\n  P1 ; Poulet  \n;;\n\nP2;Œufs');
    expect(parsed.header).toEqual(['code', 'nom']);
    expect(parsed.rows.map((row) => row.cells)).toEqual([
      ['P1', 'Poulet'],
      ['P2', 'Œufs'],
    ]);
    expect(parsed.rows.map((row) => row.line)).toEqual([3, 6]);
  });

  it('accepte LF seul, CR seul et une dernière ligne sans fin de ligne', () => {
    expect(parseCsv('a;b\nc;d').rows).toEqual([{ line: 2, cells: ['c', 'd'] }]);
    expect(parseCsv('a;b\rc;d\r').rows).toEqual([{ line: 2, cells: ['c', 'd'] }]);
  });

  it('un fichier vide n’a ni en-tête ni ligne', () => {
    expect(parseCsv('')).toMatchObject({ header: [], rows: [] });
    expect(parseCsv('\uFEFF\r\n\r\n')).toMatchObject({ header: [], rows: [] });
  });

  it('refuse un fichier de plus de la limite de lignes de données', () => {
    const rows = Array.from({ length: 6 }, (_, index) => `L${index}`).join('\n');
    expect(() => parseCsv(`code\n${rows}`, 5)).toThrow(CsvTooLargeError);
    expect(parseCsv(`code\n${rows}`, 6).rows).toHaveLength(6);
  });

  it('une cellule vide au milieu ou à la fin est conservée', () => {
    expect(parseCsv('a;b;c\n1;;3\n4;5;').rows.map((row) => row.cells)).toEqual([
      ['1', '', '3'],
      ['4', '5', ''],
    ]);
  });
});

describe('normalizeHeaderName', () => {
  it('minuscules, sans accents, tout le reste en tiret bas', () => {
    expect(normalizeHeaderName('Catégorie (code)')).toBe('categorie_code');
    expect(normalizeHeaderName('  Unité de BASE ')).toBe('unite_de_base');
    expect(normalizeHeaderName('Téléphone principal')).toBe('telephone_principal');
    expect(normalizeHeaderName('N°')).toBe('n');
  });
});

describe('toCsv', () => {
  it('écrit avec BOM et CRLF, entoure de guillemets ce qui contient séparateur, guillemet ou saut de ligne', () => {
    const text = toCsv([
      ['code', 'nom'],
      ['P1', 'Poulet; de chair'],
      ['P2', 'Il dit "oui"'],
      ['P3', 'deux\nlignes'],
    ]);
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('P1;"Poulet; de chair"\r\n');
    expect(text).toContain('P2;"Il dit ""oui"""\r\n');
  });

  it('ce qu’il écrit se relit à l’identique', () => {
    const rows = [
      ['code', 'nom', 'note'],
      ['P1', 'Poulet; de chair', 'a "b" c'],
      ['P2', 'Œufs', 'ligne 1\nligne 2'],
    ];
    const parsed = parseCsv(toCsv(rows));
    expect([parsed.header, ...parsed.rows.map((row) => row.cells)]).toEqual(rows);
  });
});
