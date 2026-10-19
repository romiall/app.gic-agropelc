/**
 * Début de la fenêtre de vérification de la chaîne d'audit (P9-10, AV-470) : lecture de la fin du journal, de la
 * plus récente à la plus ancienne, jusqu'à la première ligne antérieure à la date — logique pure, testée sur un
 * lecteur en mémoire (le journal en base est immuable et partagé).
 */
import { describe, expect, it } from 'vitest';
import { firstSeqRecordedAtOrAfterVia, type WindowRow } from './verification-window.js';

const BASE = new Date('2026-10-01T00:00:00.000Z').getTime();
const HOUR_MS = 3_600_000;
const hours = (h: number): Date => new Date(BASE + h * HOUR_MS);

/** Lignes 1..count, écrites une par heure. */
const hourly = (count: number): WindowRow[] =>
  Array.from({ length: count }, (_, i) => ({ seq: i + 1, recordedAt: hours(i + 1) }));

function reader(rows: readonly WindowRow[]) {
  const reads: { beforeSeq: number | null; limit: number }[] = [];
  const readPage = async (beforeSeq: number | null, limit: number) => {
    reads.push({ beforeSeq, limit });
    return rows
      .filter((row) => beforeSeq === null || row.seq < beforeSeq)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit);
  };
  return { readPage, reads };
}

describe('firstSeqRecordedAtOrAfterVia', () => {
  it('rend la première ligne de la série récente, en s’arrêtant à la première ligne antérieure', async () => {
    const { readPage, reads } = reader(hourly(10));
    // Les lignes 6 à 10 sont écrites à 6 h ou après.
    expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(6), 3)).toBe(6);
    // Pages 10-8, 7-5 : la ligne 5 est antérieure, la lecture s'arrête là (rien de plus ancien n'est lu).
    expect(reads).toEqual([
      { beforeSeq: null, limit: 3 },
      { beforeSeq: 8, limit: 3 },
    ]);
  });

  it('une date égale à l’écriture de la ligne compte (borne comprise)', async () => {
    const { readPage } = reader(hourly(10));
    expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(6), 4)).toBe(6);
    expect(await firstSeqRecordedAtOrAfterVia(readPage, new Date(hours(6).getTime() + 1), 4)).toBe(
      7,
    );
    expect(await firstSeqRecordedAtOrAfterVia(readPage, new Date(hours(6).getTime() - 1), 4)).toBe(
      6,
    );
  });

  it('toutes les lignes sont assez récentes : la première du journal', async () => {
    const { readPage, reads } = reader(hourly(7));
    expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(-100), 3)).toBe(1);
    // 3 + 3 + 1 lignes : la dernière page est incomplète, aucune lecture vide n'est nécessaire.
    expect(reads).toHaveLength(3);
  });

  it('un journal dont la taille est un multiple de la page se termine sur une lecture vide', async () => {
    const { readPage, reads } = reader(hourly(6));
    expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(-100), 3)).toBe(1);
    expect(reads).toHaveLength(3);
    expect(reads[1]).toEqual({ beforeSeq: 4, limit: 3 });
    expect(reads[2]).toEqual({ beforeSeq: 1, limit: 3 });
  });

  it('la ligne la plus récente est antérieure à la date : aucune fenêtre', async () => {
    const { readPage, reads } = reader(hourly(10));
    expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(11), 3)).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it('journal vide : aucune fenêtre', async () => {
    expect(await firstSeqRecordedAtOrAfterVia(reader([]).readPage, hours(0), 3)).toBeNull();
  });

  it('une ligne antérieure au milieu du journal arrête la lecture (série continue depuis la fin)', async () => {
    // Écritures non croissantes (horloge reculée d'une application) : 1 h, 2 h, 0,5 h, 4 h, 5 h.
    const rows: WindowRow[] = [
      { seq: 1, recordedAt: hours(1) },
      { seq: 2, recordedAt: hours(2) },
      { seq: 3, recordedAt: hours(0.5) },
      { seq: 4, recordedAt: hours(4) },
      { seq: 5, recordedAt: hours(5) },
    ];
    // Depuis la fin : 5 h et 4 h sont postérieures à 3 h, 0,5 h non : la fenêtre commence à la ligne 4.
    expect(await firstSeqRecordedAtOrAfterVia(reader(rows).readPage, hours(3), 2)).toBe(4);
  });

  it('la taille de page est assainie (entier au moins égal à 1)', async () => {
    for (const [given, expected] of [
      [0, 1],
      [-3, 1],
      [2.8, 2],
    ] as const) {
      const { readPage, reads } = reader(hourly(3));
      expect(await firstSeqRecordedAtOrAfterVia(readPage, hours(0), given)).toBe(1);
      expect(reads[0]!.limit).toBe(expected);
    }
  });
});
