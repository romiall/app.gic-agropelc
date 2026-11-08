/**
 * Contenu d'un volume d'archive (AV-539, ADR-070 §4) : `LISEZMOI.txt`, `MANIFESTE.csv`, puis les photos. Tout se
 * déduit des seules données enregistrées au plan (plan, volume, photos) : le volume est **déterministe** — la longueur
 * annoncée au plan et les octets envoyés au téléchargement, ou à un second téléchargement, sont les mêmes.
 */
import {
  archivePeriodFromStart,
  buildArchiveManifest,
  buildArchiveReadme,
  businessDayOf,
  type ArchiveCategory,
  type ArchiveGranularity,
} from '@gic/domain';
import {
  memoryEntry,
  storedZipLength,
  type ZipEntry,
} from '../../platform/zip/stored-zip-writer.js';

export const README_PATH = 'LISEZMOI.txt';
export const MANIFEST_PATH = 'MANIFESTE.csv';

export interface VolumeDocumentsArchive {
  readonly id: string;
  readonly granularity: ArchiveGranularity;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly cutoffAt: Date;
  readonly createdAt: Date;
  readonly retentionYears: number;
}

export interface VolumeDocumentsVolume {
  readonly fileName: string;
  /** Rang du volume dans le plan (à partir de 1) et nombre de volumes du plan. */
  readonly seq: number;
  readonly volumeCount: number;
}

/** Les champs d'une photo dont les documents ont besoin (enregistrés au plan). */
export interface VolumeDocumentsItem {
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly entryPath: string;
  readonly category: ArchiveCategory;
  readonly reference: string;
  readonly secondaryReference: string | null;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly capturedAt: Date;
  readonly submittedAt: Date;
}

export interface VolumeZip {
  readonly entries: readonly ZipEntry[];
  readonly comment: string;
  /** Longueur exacte du ZIP (en-tête `Content-Length`). */
  readonly length: number;
}

export function volumeZipComment(archiveId: string, volume: VolumeDocumentsVolume): string {
  return `GIC AGROPELC - plan ${archiveId} - volume ${volume.seq}/${volume.volumeCount}`;
}

/**
 * Les entrées du ZIP d'un volume et sa longueur exacte. `openPhoto` lit les octets d'une photo (au plan, un lecteur
 * vide suffit : seules les tailles comptent).
 */
export function buildVolumeZip(
  archive: VolumeDocumentsArchive,
  volume: VolumeDocumentsVolume,
  items: readonly VolumeDocumentsItem[],
  openPhoto: (item: VolumeDocumentsItem) => AsyncIterable<Uint8Array>,
): VolumeZip {
  const period = archivePeriodFromStart(archive.granularity, archive.periodStart);
  const readme = buildArchiveReadme({
    archiveId: archive.id,
    volumeFileName: volume.fileName,
    volumeRank: volume.seq,
    volumeCount: volume.volumeCount,
    periodLabel: period.label,
    periodStart: archive.periodStart,
    periodEnd: archive.periodEnd,
    cutoffAt: archive.cutoffAt,
    generatedDay: businessDayOf(archive.createdAt),
    retentionYears: archive.retentionYears,
  });
  const manifest = buildArchiveManifest(
    items.map((item) => ({
      path: item.entryPath,
      category: item.category,
      reference: item.reference,
      secondaryReference: item.secondaryReference,
      submittedAt: item.submittedAt,
      capturedAt: item.capturedAt,
      kind: item.kind,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      attachmentId: item.attachmentId,
      ownerId: item.ownerId,
    })),
  );
  const entries: ZipEntry[] = [
    memoryEntry(README_PATH, Buffer.from(readme, 'utf8'), archive.createdAt),
    memoryEntry(MANIFEST_PATH, Buffer.from(manifest, 'utf8'), archive.createdAt),
    ...items.map((item): ZipEntry => ({
      path: item.entryPath,
      size: item.sizeBytes,
      modifiedAt: item.submittedAt,
      read: () => openPhoto(item),
    })),
  ];
  const comment = volumeZipComment(archive.id, volume);
  return { entries, comment, length: storedZipLength(entries, comment) };
}
