import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ARCHIVE_CATEGORIES,
  ARCHIVE_MIN_AGE_FLOOR_DAYS,
  archiveCutoff,
  archiveEntryPath,
  archiveFileTimestamp,
  archiveMonthOf,
  archiveReferenceTokens,
  archivePeriodFromStart,
  archivePeriodOf,
  archivePeriodsOfMonths,
  archivePeriodWindow,
  archiveRetentionUntil,
  archiveShortId,
  archiveVolumeFileName,
  buildArchiveManifest,
  buildArchiveReadme,
  csvCell,
  effectiveGranularity,
  effectiveMinAgeDays,
  effectiveRetentionYears,
  effectiveVolumeMaxBytes,
  isSafeArchivePath,
  planArchiveVolumes,
  sanitizeFileToken,
  uniqueEntryPaths,
  type ArchiveVolumeCandidate,
} from './attachment-archive.js';

const ID_A = '0192f7a0-0000-7000-8000-00000000a1b2';
const ID_B = '0192f7a0-0000-7000-8000-00000000c3d4';

describe('seuil d’ancienneté : plancher de 30 jours', () => {
  it('le réglage ne descend jamais sous 30 jours et ne fait qu’augmenter', () => {
    expect(ARCHIVE_MIN_AGE_FLOOR_DAYS).toBe(30);
    expect(effectiveMinAgeDays(30)).toBe(30);
    expect(effectiveMinAgeDays(45)).toBe(45);
    expect(effectiveMinAgeDays(29)).toBe(30);
    expect(effectiveMinAgeDays(0)).toBe(30);
    expect(effectiveMinAgeDays(-10)).toBe(30);
    expect(effectiveMinAgeDays(90.9)).toBe(90);
  });

  it('une valeur absente ou inexploitable revient au défaut de 30 jours', () => {
    for (const value of [undefined, null, '60', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(effectiveMinAgeDays(value)).toBe(30);
    }
  });

  it('une durée absurde est plafonnée à dix ans', () => {
    expect(effectiveMinAgeDays(1_000_000)).toBe(3650);
  });

  it('le seuil est strict : une pièce reçue il y a exactement 30 jours n’est pas encore archivable', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const cutoff = archiveCutoff(now, 30);
    expect(cutoff.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    const exactly = new Date('2026-10-09T12:00:00.000Z');
    const justBefore = new Date('2026-10-09T11:59:59.999Z');
    expect(exactly.getTime() < cutoff.getTime()).toBe(false);
    expect(justBefore.getTime() < cutoff.getTime()).toBe(true);
  });
});

describe('réglages de volume, de période et de conservation', () => {
  it('la taille d’un volume est bornée entre 16 et 2 048 Mo, 512 par défaut', () => {
    expect(effectiveVolumeMaxBytes(undefined)).toBe(512 * 1024 * 1024);
    expect(effectiveVolumeMaxBytes(1)).toBe(16 * 1024 * 1024);
    expect(effectiveVolumeMaxBytes(100)).toBe(100 * 1024 * 1024);
    expect(effectiveVolumeMaxBytes(99_999)).toBe(2048 * 1024 * 1024);
  });

  it('la période proposée est le trimestre sauf réglage valide', () => {
    expect(effectiveGranularity(undefined)).toBe('QUARTER');
    expect(effectiveGranularity('MONTH')).toBe('MONTH');
    expect(effectiveGranularity('WEEK')).toBe('QUARTER');
  });

  it('la conservation est de 5 ans par défaut, entière et positive', () => {
    expect(effectiveRetentionYears(undefined)).toBe(5);
    expect(effectiveRetentionYears(0)).toBe(5);
    expect(effectiveRetentionYears(7)).toBe(7);
    expect(effectiveRetentionYears(2.5)).toBe(5);
  });

  it('la date de fin de conservation tombe le même jour, 5 ans après (29 février compris)', () => {
    expect(archiveRetentionUntil('2026-11-08', 5)).toBe('2031-11-08');
    expect(archiveRetentionUntil('2028-02-29', 5)).toBe('2033-02-28');
  });
});

describe('périodes : mois ou trimestre du calendrier, en jours de Douala', () => {
  it('un mois', () => {
    const period = archivePeriodOf('MONTH', '2026-07-15');
    expect(period).toEqual({
      granularity: 'MONTH',
      start: '2026-07-01',
      end: '2026-08-01',
      label: '2026-07',
      months: ['2026-07'],
    });
  });

  it('un trimestre, y compris le dernier de l’année', () => {
    expect(archivePeriodOf('QUARTER', '2026-08-31')).toMatchObject({
      start: '2026-07-01',
      end: '2026-10-01',
      label: '2026-T3',
      months: ['2026-07', '2026-08', '2026-09'],
    });
    expect(archivePeriodOf('QUARTER', '2026-12-31')).toMatchObject({
      start: '2026-10-01',
      end: '2027-01-01',
      label: '2026-T4',
      months: ['2026-10', '2026-11', '2026-12'],
    });
    expect(archivePeriodOf('QUARTER', '2026-01-01').label).toBe('2026-T1');
  });

  it('décembre fermé, février bissextile', () => {
    expect(archivePeriodOf('MONTH', '2026-12-10').end).toBe('2027-01-01');
    expect(archivePeriodOf('MONTH', '2028-02-29')).toMatchObject({
      start: '2028-02-01',
      end: '2028-03-01',
    });
  });

  it('une période se désigne par son premier jour ; tout autre jour est refusé', () => {
    expect(archivePeriodFromStart('MONTH', '2026-07-01').label).toBe('2026-07');
    expect(archivePeriodFromStart('QUARTER', '2026-10-01').label).toBe('2026-T4');
    expect(() => archivePeriodFromStart('MONTH', '2026-07-02')).toThrow(/1er/);
    expect(() => archivePeriodFromStart('QUARTER', '2026-08-01')).toThrow(/trimestre/);
    expect(() => archivePeriodFromStart('MONTH', '2026-02-30')).toThrow();
    expect(() => archivePeriodFromStart('MONTH', 'juillet')).toThrow();
  });

  it('la fenêtre UTC commence à minuit de Douala, soit 23 h UTC la veille', () => {
    const window = archivePeriodWindow(archivePeriodOf('MONTH', '2026-07-10'));
    expect(window.startUtc.toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(window.endUtc.toISOString()).toBe('2026-07-31T23:00:00.000Z');
  });

  it('le mois d’un instant est celui de Douala', () => {
    expect(archiveMonthOf(new Date('2026-06-30T22:59:59.000Z'))).toBe('2026-06');
    expect(archiveMonthOf(new Date('2026-06-30T23:00:00.000Z'))).toBe('2026-07');
  });

  it('les périodes qui couvrent des mois sont triées et sans doublon', () => {
    const quarters = archivePeriodsOfMonths('QUARTER', [
      '2026-09',
      '2026-07',
      '2026-10',
      '2026-08',
    ]);
    expect(quarters.map((period) => period.label)).toEqual(['2026-T3', '2026-T4']);
  });
});

describe('noms de fichiers', () => {
  it('réduit un élément à des caractères sûrs', () => {
    expect(sanitizeFileToken('BL 4521/A')).toBe('BL-4521-A');
    expect(sanitizeFileToken('Réception n° 12 – été')).toBe('Reception-n-12-ete');
    expect(sanitizeFileToken('..\\..\\Windows\\system32')).toBe('Windows-system32');
    expect(sanitizeFileToken('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFileToken('=CMD|calc!A0')).toBe('CMD-calc-A0');
    expect(sanitizeFileToken('-1+1')).toBe('1-1');
    expect(sanitizeFileToken('.hidden')).toBe('hidden');
    expect(sanitizeFileToken('a..b')).toBe('a.b');
    expect(sanitizeFileToken('CON:')).toBe('CON');
    expect(sanitizeFileToken('a<b>c:"d"|e?f*g')).toBe('a-b-c-d-e-f-g');
  });

  it('rend une chaîne vide quand il ne reste rien, et coupe à 40 caractères', () => {
    expect(sanitizeFileToken('///')).toBe('');
    expect(sanitizeFileToken('   ')).toBe('');
    expect(sanitizeFileToken(null)).toBe('');
    expect(sanitizeFileToken(undefined)).toBe('');
    expect(sanitizeFileToken('x'.repeat(100))).toHaveLength(40);
    expect(sanitizeFileToken(`${'a'.repeat(39)}-bcd`)).toBe('a'.repeat(39));
  });

  it('les huit derniers caractères de l’identifiant, en minuscules', () => {
    expect(archiveShortId('0192F7A0-0000-7000-8000-00000000A1B2')).toBe('0000a1b2');
  });

  it('date et heure de soumission en heure de Douala', () => {
    expect(archiveFileTimestamp(new Date('2026-10-15T09:15:30.999Z'))).toBe('20261015-101530');
    expect(archiveFileTimestamp(new Date('2026-12-31T23:30:00Z'))).toBe('20270101-003000');
  });

  it('chemin d’une photo : catégorie, mois, référence, date et heure, identifiant', () => {
    const path = archiveEntryPath({
      category: 'RECEPTION',
      reference: 'RC-2026-000123',
      secondaryReferences: ['BL 9981', 'br/4417', 'troisième'],
      submittedAt: new Date('2026-10-15T09:15:30Z'),
      attachmentId: ID_A,
      mimeType: 'image/jpeg',
    });
    // au plus deux références secondaires
    expect(path).toBe(
      'RECEPTION/2026-10/RC-2026-000123_BL-9981_br-4417_20261015-101530_0000a1b2.jpg',
    );
    expect(isSafeArchivePath(path)).toBe(true);
  });

  it('sans référence secondaire, ou identique au numéro, le nom ne la répète pas', () => {
    const base = {
      category: 'DEPENSE' as const,
      reference: 'DEP-2026-000045',
      submittedAt: new Date('2026-10-15T09:15:30Z'),
      attachmentId: ID_B,
      mimeType: 'image/webp',
    };
    expect(archiveEntryPath({ ...base, secondaryReferences: [null, undefined, ' '] })).toBe(
      'DEPENSE/2026-10/DEP-2026-000045_20261015-101530_0000c3d4.webp',
    );
    expect(
      archiveEntryPath({ ...base, secondaryReferences: ['dep-2026-000045', 'DEP-2026-000045'] }),
    ).toBe('DEPENSE/2026-10/DEP-2026-000045_20261015-101530_0000c3d4.webp');
  });

  it('références réduites : numéro, puis deux références secondaires distinctes au plus', () => {
    expect(archiveReferenceTokens('RC-1', ['bl 9', 'BL-9', 'rc-1', null, 'BR 2', 'autre'])).toEqual(
      {
        reference: 'RC-1',
        secondary: ['bl-9', 'BR-2'],
      },
    );
    expect(archiveReferenceTokens('???', [])).toEqual({ reference: 'SANS-REF', secondary: [] });
  });

  it('une référence inexploitable devient SANS-REF et un type inconnu .bin', () => {
    const path = archiveEntryPath({
      category: 'PERTE',
      reference: '///',
      secondaryReferences: ['..'],
      submittedAt: new Date('2026-10-15T09:15:30Z'),
      attachmentId: ID_A,
      mimeType: 'application/zip',
    });
    expect(path).toBe('PERTE/2026-10/SANS-REF_20261015-101530_0000a1b2.bin');
  });

  it('le mois du dossier est celui de Douala, comme la date du fichier', () => {
    const path = archiveEntryPath({
      category: 'MORTALITE',
      reference: 'PT-1',
      secondaryReferences: [],
      submittedAt: new Date('2026-06-30T23:30:00Z'),
      attachmentId: ID_A,
      mimeType: 'application/pdf',
    });
    expect(path).toBe('MORTALITE/2026-07/PT-1_20260701-003000_0000a1b2.pdf');
  });

  it('rend les chemins distincts, majuscules et minuscules confondues', () => {
    // 'A/X.jpg' prend 'A/X-2.jpg' ; le second 'A/x.jpg' passe donc à -3 ; un 'A/x-2.jpg' d'origine, désormais pris
    // (à la casse près), est renommé à son tour.
    expect(
      uniqueEntryPaths(['A/x.jpg', 'A/X.jpg', 'A/y.jpg', 'A/x.jpg', 'A/x-2.jpg', 'B/noext']),
    ).toEqual(['A/x.jpg', 'A/X-2.jpg', 'A/y.jpg', 'A/x-3.jpg', 'A/x-2-2.jpg', 'B/noext']);
    expect(uniqueEntryPaths(['d.v1/f', 'd.v1/f'])).toEqual(['d.v1/f', 'd.v1/f-2']);
  });

  it('reconnaît un chemin d’entrée sûr', () => {
    expect(isSafeArchivePath('RECEPTION/2026-10/RC-1_x.jpg')).toBe(true);
    for (const bad of [
      '',
      '/etc/passwd',
      '../x.jpg',
      'a/../b.jpg',
      'a/./b.jpg',
      'a//b.jpg',
      'a\\b.jpg',
      'C:/x.jpg',
      'a/b.jpg ',
      'a/b.',
      'a/b?.jpg',
      'a/b*.jpg',
      'a/b\u0000.jpg',
      'a/b\n.jpg',
      'x'.repeat(301),
    ]) {
      expect(isSafeArchivePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('nom d’un volume : mois, catégorie, date du plan et partie', () => {
    const base = { month: '2026-07', category: 'RECEPTION' as const, planDay: '2026-11-08' };
    expect(archiveVolumeFileName({ ...base, part: 1, parts: 1 })).toBe(
      'GIC-photos_2026-07_RECEPTION_20261108.zip',
    );
    expect(archiveVolumeFileName({ ...base, part: 2, parts: 3 })).toBe(
      'GIC-photos_2026-07_RECEPTION_20261108_p02.zip',
    );
  });

  it('quelle que soit la référence saisie, le chemin produit est sûr (propriété)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.array(fc.option(fc.string({ maxLength: 120 }), { nil: null }), { maxLength: 4 }),
        fc.constantFrom(...ARCHIVE_CATEGORIES),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2040-01-01'), noInvalidDate: true }),
        (reference, secondaryReferences, category, submittedAt) => {
          const path = archiveEntryPath({
            category,
            reference,
            secondaryReferences,
            submittedAt,
            attachmentId: ID_A,
            mimeType: 'image/jpeg',
          });
          expect(isSafeArchivePath(path)).toBe(true);
          expect(path.startsWith(`${category}/`)).toBe(true);
          expect(path.split('/')).toHaveLength(3);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('un élément de nom ne contient que des caractères sûrs et ne commence ni ne finit par un séparateur (propriété)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const token = sanitizeFileToken(raw);
        expect(token === '' || /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(token)).toBe(true);
        expect(token).not.toContain('..');
        expect(token.length).toBeLessThanOrEqual(40);
      }),
      { numRuns: 500 },
    );
  });
});

describe('découpage en volumes', () => {
  const MB = 1024 * 1024;
  function candidate(
    n: number,
    over: Partial<ArchiveVolumeCandidate> = {},
  ): ArchiveVolumeCandidate & { n: number } {
    return {
      n,
      attachmentId: `0192f7a0-0000-7000-8000-${String(n).padStart(12, '0')}`,
      category: 'RECEPTION',
      month: '2026-07',
      submittedAt: new Date(Date.UTC(2026, 6, 1, 8, n)),
      sizeBytes: 100_000,
      ...over,
    };
  }

  it('un volume par mois et par catégorie, dans l’ordre des mois puis des catégories', () => {
    const items = [
      candidate(1, { month: '2026-08', category: 'DEPENSE' }),
      candidate(2, { month: '2026-07', category: 'DEPENSE' }),
      candidate(3, { month: '2026-07', category: 'RECEPTION' }),
      candidate(4, { month: '2026-08', category: 'RECEPTION' }),
      candidate(5, { month: '2026-07', category: 'MORTALITE' }),
    ];
    const volumes = planArchiveVolumes(items, { maxBytes: 512 * MB, maxFiles: 10_000 });
    expect(volumes.map((v) => `${v.month}/${v.category}`)).toEqual([
      '2026-07/RECEPTION',
      '2026-07/MORTALITE',
      '2026-07/DEPENSE',
      '2026-08/RECEPTION',
      '2026-08/DEPENSE',
    ]);
    expect(volumes.every((v) => v.part === 1 && v.parts === 1)).toBe(true);
  });

  it('coupe un groupe trop gros en parties, par taille', () => {
    const items = Array.from({ length: 10 }, (_, i) => candidate(i + 1, { sizeBytes: 3 * MB }));
    const volumes = planArchiveVolumes(items, { maxBytes: 10 * MB, maxFiles: 10_000 });
    expect(volumes.map((v) => v.items.length)).toEqual([3, 3, 3, 1]);
    expect(volumes.map((v) => [v.part, v.parts])).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(volumes.every((v) => v.filesBytes <= 10 * MB)).toBe(true);
  });

  it('coupe aussi par nombre de photos', () => {
    const items = Array.from({ length: 7 }, (_, i) => candidate(i + 1, { sizeBytes: 10 }));
    const volumes = planArchiveVolumes(items, { maxBytes: 512 * MB, maxFiles: 3 });
    expect(volumes.map((v) => v.items.length)).toEqual([3, 3, 1]);
  });

  it('une photo plus grosse que la borne forme seule son volume, sans boucle', () => {
    const items = [candidate(1, { sizeBytes: 50 * MB }), candidate(2, { sizeBytes: 1 })];
    const volumes = planArchiveVolumes(items, { maxBytes: 10 * MB, maxFiles: 10_000 });
    expect(volumes.map((v) => v.items.length)).toEqual([1, 1]);
  });

  it('range les photos par soumission puis identifiant, et donne le même plan à chaque fois', () => {
    const items = [candidate(3), candidate(1), candidate(2)];
    const first = planArchiveVolumes(items, { maxBytes: 512 * MB, maxFiles: 10_000 });
    const second = planArchiveVolumes([...items].reverse(), {
      maxBytes: 512 * MB,
      maxFiles: 10_000,
    });
    expect(first[0]!.items.map((i) => i.attachmentId)).toEqual(
      second[0]!.items.map((i) => i.attachmentId),
    );
    expect(first[0]!.items.map((i) => (i as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it('aucune photo, aucun volume', () => {
    expect(planArchiveVolumes([], { maxBytes: 1, maxFiles: 1 })).toEqual([]);
  });

  it('toute photo se retrouve dans exactement un volume (propriété)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            month: fc.constantFrom('2026-07', '2026-08', '2026-09'),
            category: fc.constantFrom(...ARCHIVE_CATEGORIES),
            sizeBytes: fc.integer({ min: 1, max: 5 * MB }),
          }),
          { maxLength: 60 },
        ),
        fc.integer({ min: 1, max: 12 }),
        (rows, maxFiles) => {
          const items = rows.map((row, i) => candidate(i + 1, row));
          const volumes = planArchiveVolumes(items, { maxBytes: 8 * MB, maxFiles });
          const planned = volumes.flatMap((v) => v.items.map((i) => i.attachmentId));
          expect(planned.sort()).toEqual(items.map((i) => i.attachmentId).sort());
          for (const volume of volumes) {
            expect(volume.items.length).toBeLessThanOrEqual(maxFiles);
            if (volume.items.length > 1) expect(volume.filesBytes).toBeLessThanOrEqual(8 * MB);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('manifeste et texte d’accompagnement', () => {
  const row = {
    path: 'RECEPTION/2026-10/RC-1_20261015-101530_0000a1b2.jpg',
    category: 'RECEPTION' as const,
    reference: 'RC-1',
    secondaryReference: 'BL-9',
    submittedAt: new Date('2026-10-15T09:15:30Z'),
    capturedAt: new Date('2026-10-15T08:00:00Z'),
    kind: 'DELIVERY_NOTE',
    mimeType: 'image/jpeg',
    sizeBytes: 123_456,
    sha256: 'a'.repeat(64),
    attachmentId: ID_A,
    ownerId: ID_B,
  };

  it('une cellule est protégée des guillemets, des séparateurs et des formules', () => {
    expect(csvCell('simple')).toBe('simple');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('ligne\nsuivante')).toBe('"ligne\nsuivante"');
    expect(csvCell('=SOMME(A1)')).toBe("'=SOMME(A1)");
    expect(csvCell('+33')).toBe("'+33");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('le manifeste a un BOM, des fins de ligne Windows, l’en-tête puis une ligne par photo', () => {
    const text = buildArchiveManifest([row, { ...row, secondaryReference: null, sizeBytes: 5 }]);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    expect(lines[0]).toBe(
      'chemin;categorie;reference;reference_secondaire;date_soumission;date_prise_de_vue;nature;type;taille_octets;sha256;id_piece;id_document',
    );
    expect(lines[1]!.split(';')).toEqual([
      row.path,
      'RECEPTION',
      'RC-1',
      'BL-9',
      '2026-10-15 10:15:30',
      '2026-10-15 09:00:00',
      'DELIVERY_NOTE',
      'image/jpeg',
      '123456',
      'a'.repeat(64),
      ID_A,
      ID_B,
    ]);
    expect(lines[2]!.split(';')[3]).toBe('');
  });

  it('le texte d’accompagnement dit où chercher, combien de temps garder et comment vérifier', () => {
    const readme = buildArchiveReadme({
      archiveId: ID_A,
      volumeFileName: 'GIC-photos_2026-07_RECEPTION_20261108.zip',
      volumeRank: 2,
      volumeCount: 5,
      periodLabel: '2026-T3',
      periodStart: '2026-07-01',
      periodEnd: '2026-10-01',
      cutoffAt: new Date('2026-10-09T12:00:00Z'),
      generatedDay: '2026-11-08',
      retentionYears: 5,
    });
    expect(readme).toContain(`Plan : ${ID_A}`);
    expect(readme).toContain('Volume 2 sur 5 : GIC-photos_2026-07_RECEPTION_20261108.zip');
    expect(readme).toContain("A conserver 5 ans, jusqu'au 2031-11-08 au moins");
    expect(readme).toContain(
      'Get-FileHash .\\GIC-photos_2026-07_RECEPTION_20261108.zip -Algorithm SHA256',
    );
    expect(readme).toContain('2026-10-09 13:00:00');
    expect(readme.split('\r\n').length).toBeGreaterThan(10);
  });
});
