import { describe, expect, it } from 'vitest';
import type { ArchiveView, ArchiveVolumeView, PurgeResult } from '@gic/contracts';
import {
  EMPTY_PURGE_RESULT,
  addPurgeResults,
  canCancel,
  canPurge,
  formatBytes,
  periodTitle,
  purgePreview,
  releasedReasons,
  volumeState,
  volumeWithHash,
  volumesToDownload,
} from './archive.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function volume(over: Partial<ArchiveVolumeView> = {}): ArchiveVolumeView {
  return {
    id: '01900000-0000-7000-8000-000000000001',
    seq: 1,
    fileName: 'GIC-photos_2026-07_RECEPTION_20261108.zip',
    category: 'RECEPTION',
    month: '2026-07',
    part: 1,
    files: 10,
    filesBytes: 1_000_000,
    zipBytes: 1_001_500,
    zipSha256: null,
    deliveries: 0,
    abortedDeliveries: 0,
    firstDeliveredAt: null,
    lastDeliveredAt: null,
    verifiedAt: null,
    resolvedAt: null,
    planned: 10,
    purged: 0,
    released: 0,
    ...over,
  };
}

function archive(volumes: ArchiveVolumeView[], over: Partial<ArchiveView> = {}): ArchiveView {
  return {
    id: '01900000-0000-7000-8000-0000000000aa',
    granularity: 'QUARTER',
    period: { granularity: 'QUARTER', start: '2026-07-01', end: '2026-10-01', label: '2026-T3' },
    status: 'READY',
    cutoffAt: '2026-10-09T12:00:00.000Z',
    minAgeDays: 30,
    createdAt: '2026-11-08T10:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    files: volumes.reduce((total, v) => total + v.files, 0),
    filesBytes: volumes.reduce((total, v) => total + v.filesBytes, 0),
    keptOpen: 0,
    absent: 0,
    allDelivered: volumes.length > 0 && volumes.every((v) => v.deliveries > 0),
    volumes,
    ...over,
  };
}

describe('tailles lisibles', () => {
  it('virgule décimale française, unité adaptée', () => {
    expect(formatBytes(0)).toBe('0 o');
    expect(formatBytes(-5)).toBe('0 o');
    expect(formatBytes(Number.NaN)).toBe('0 o');
    expect(formatBytes(812)).toBe('812 o');
    expect(formatBytes(1024)).toBe('1 Ko');
    expect(formatBytes(1536)).toBe('1,5 Ko');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3,4 Mo');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 Mo');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1,25 Go');
    expect(formatBytes(12.34 * 1024 ** 3)).toBe('12,3 Go');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 To');
  });
});

describe('titre d’une période', () => {
  const labels = {
    first: '1er',
    quarter: (rank: string, year: string) => `${rank} trimestre ${year}`,
  };
  it('un mois en lettres, un trimestre numéroté', () => {
    expect(periodTitle({ granularity: 'MONTH', label: '2026-07' }, labels)).toBe('juillet 2026');
    expect(periodTitle({ granularity: 'MONTH', label: '2026-12' }, labels)).toBe('décembre 2026');
    expect(periodTitle({ granularity: 'QUARTER', label: '2026-T1' }, labels)).toBe(
      '1er trimestre 2026',
    );
    expect(periodTitle({ granularity: 'QUARTER', label: '2026-T3' }, labels)).toBe(
      '3e trimestre 2026',
    );
  });
});

describe('état des fichiers et du plan', () => {
  it('à télécharger, téléchargé, vérifié, vidé', () => {
    expect(volumeState(volume())).toBe('PENDING');
    expect(volumeState(volume({ deliveries: 1 }))).toBe('DELIVERED');
    expect(volumeState(volume({ deliveries: 2, verifiedAt: '2026-11-08T11:00:00.000Z' }))).toBe(
      'VERIFIED',
    );
    expect(
      volumeState(
        volume({
          deliveries: 1,
          verifiedAt: '2026-11-08T11:00:00.000Z',
          resolvedAt: '2026-11-08T12:00:00.000Z',
        }),
      ),
    ).toBe('RESOLVED');
  });

  it('les fichiers à télécharger sont ceux jamais livrés et non soldés', () => {
    const a = volume({ id: 'a' });
    const b = volume({ id: 'b', deliveries: 1 });
    const c = volume({ id: 'c', resolvedAt: '2026-11-08T12:00:00.000Z' });
    expect(volumesToDownload(archive([a, b, c])).map((v) => v.id)).toEqual(['a']);
  });

  it('le vidage n’est permis que lorsque tous les fichiers sont livrés ; l’annulation tant que rien n’est vidé', () => {
    const pending = archive([volume({ deliveries: 1 }), volume({ id: 'b' })]);
    expect(canPurge(pending)).toBe(false);
    const delivered = archive([volume({ deliveries: 1 }), volume({ id: 'b', deliveries: 2 })]);
    expect(canPurge(delivered)).toBe(true);
    expect(canPurge({ ...delivered, status: 'COMPLETED' })).toBe(false);
    expect(canCancel(delivered)).toBe(true);
    expect(canCancel(archive([volume({ purged: 3 })]))).toBe(false);
    expect(canCancel({ ...delivered, status: 'CANCELLED' })).toBe(false);
  });

  it('l’aperçu du vidage compte les photos encore prévues des fichiers non soldés', () => {
    const view = archive([
      volume({ id: 'a', files: 10, filesBytes: 1000, planned: 10, deliveries: 1 }),
      volume({
        id: 'b',
        files: 4,
        filesBytes: 400,
        planned: 2,
        deliveries: 1,
        verifiedAt: '2026-11-08T11:00:00.000Z',
      }),
      volume({
        id: 'c',
        files: 5,
        filesBytes: 500,
        planned: 0,
        resolvedAt: '2026-11-08T12:00:00.000Z',
      }),
    ]);
    expect(purgePreview(view)).toEqual({ files: 12, bytes: 1200, volumes: 2, unverified: 1 });
  });

  it('retrouve le fichier de l’archive par l’empreinte d’un fichier du poste', () => {
    const view = archive([
      volume({ id: 'a', zipSha256: HASH_A }),
      volume({ id: 'b', zipSha256: HASH_B }),
    ]);
    expect(volumeWithHash(view, HASH_B)?.id).toBe('b');
    expect(volumeWithHash(view, HASH_B.toUpperCase())?.id).toBe('b');
    expect(volumeWithHash(view, 'c'.repeat(64))).toBeUndefined();
  });
});

describe('résultat d’un vidage en plusieurs appels', () => {
  const call = (over: Partial<PurgeResult>): PurgeResult => ({ ...EMPTY_PURGE_RESULT, ...over });

  it('additionne les appels et garde le reste du dernier', () => {
    const total = addPurgeResults(
      call({
        purged: 500,
        bytesFreed: 1000,
        remaining: 120,
        released: { OPEN_OPERATION: 1, CHANGED: 0, TOO_RECENT: 0 },
      }),
      call({
        purged: 120,
        bytesFreed: 300,
        remaining: 0,
        volumesResolved: 2,
        volumesVerified: 1,
        released: { OPEN_OPERATION: 0, CHANGED: 2, TOO_RECENT: 0 },
      }),
    );
    expect(total).toMatchObject({
      purged: 620,
      bytesFreed: 1300,
      remaining: 0,
      volumesResolved: 2,
      volumesVerified: 1,
      released: { OPEN_OPERATION: 1, CHANGED: 2, TOO_RECENT: 0 },
    });
  });

  it('ne liste que les raisons qui comptent', () => {
    expect(releasedReasons({ OPEN_OPERATION: 2, CHANGED: 0, TOO_RECENT: 1 })).toEqual([
      { reason: 'OPEN_OPERATION', count: 2 },
      { reason: 'TOO_RECENT', count: 1 },
    ]);
    expect(releasedReasons({ OPEN_OPERATION: 0, CHANGED: 0, TOO_RECENT: 0 })).toEqual([]);
  });
});
