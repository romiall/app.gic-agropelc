/**
 * Archive des photos jointes (AV-539, ADR-070) : logique pure de l'écran de l'onglet « Archive des photos » des
 * paramètres — tailles lisibles, titre d'une période, état d'un fichier, ce que le vidage supprimera. Le serveur fait
 * foi (plan, livraison, vérification) ; ces fonctions ne font que présenter ce qu'il a rendu.
 */
import type {
  ArchivePeriodView,
  ArchiveView,
  ArchiveVolumeView,
  PurgeResult,
} from '@gic/contracts';

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'] as const;

/** Taille lisible, virgule décimale française : `812 o`, `3,4 Mo`, `1,25 Go`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 o';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} o`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const fixed = value.toFixed(digits);
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${text.replace('.', ',')} ${UNITS[unit]}`;
}

export type VolumeState = 'PENDING' | 'DELIVERED' | 'VERIFIED' | 'RESOLVED';

/** État d'un fichier : à télécharger, téléchargé en entier, vérifié par son empreinte, ou vidé du serveur. */
export function volumeState(volume: ArchiveVolumeView): VolumeState {
  if (volume.resolvedAt !== null) return 'RESOLVED';
  if (volume.verifiedAt !== null) return 'VERIFIED';
  if (volume.deliveries > 0) return 'DELIVERED';
  return 'PENDING';
}

/** Fichiers à télécharger : non soldés et jamais livrés en entier. */
export function volumesToDownload(archive: ArchiveView): ArchiveVolumeView[] {
  return archive.volumes.filter((volume) => volume.resolvedAt === null && volume.deliveries === 0);
}

/** Le vidage est permis : plan vivant et tous ses fichiers non soldés livrés en entier (le serveur le contrôle aussi). */
export function canPurge(archive: ArchiveView): boolean {
  return archive.status === 'READY' && archive.allDelivered;
}

/** Une archive dont rien n'a été vidé peut être annulée. */
export function canCancel(archive: ArchiveView): boolean {
  return archive.status === 'READY' && archive.volumes.every((volume) => volume.purged === 0);
}

export interface PurgePreview {
  readonly files: number;
  readonly bytes: number;
  readonly volumes: number;
  readonly unverified: number;
}

/** Ce que le vidage supprimera : les photos encore prévues des fichiers non soldés. */
export function purgePreview(archive: ArchiveView): PurgePreview {
  const open = archive.volumes.filter((volume) => volume.resolvedAt === null);
  return {
    files: open.reduce((total, volume) => total + volume.planned, 0),
    bytes: open.reduce(
      (total, volume) =>
        total +
        (volume.files === 0 ? 0 : Math.round((volume.filesBytes * volume.planned) / volume.files)),
      0,
    ),
    volumes: open.length,
    unverified: open.filter((volume) => volume.verifiedAt === null).length,
  };
}

/** Le fichier de l'archive dont l'empreinte est celle d'un fichier du poste, s'il y en a un. */
export function volumeWithHash(
  archive: ArchiveView,
  sha256: string,
): ArchiveVolumeView | undefined {
  const wanted = sha256.toLowerCase();
  return archive.volumes.find((volume) => volume.zipSha256 === wanted);
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Titre d'une période : « juillet 2026 » ou « 3e trimestre 2026 ». */
export function periodTitle(
  period: Pick<ArchivePeriodView, 'granularity' | 'label'>,
  labels: { readonly quarter: (rank: string, year: string) => string; readonly first: string },
): string {
  if (period.granularity === 'MONTH') {
    const [year, month] = period.label.split('-');
    return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
  }
  const [year, quarter] = period.label.split('-T');
  const rank = quarter === '1' ? labels.first : `${quarter}e`;
  return labels.quarter(rank, year ?? '');
}

/** Libellé d'une raison de non-vidage, pour le résumé du vidage. */
export function releasedReasons(
  released: PurgeResult['released'],
): { reason: string; count: number }[] {
  return (Object.entries(released) as [keyof PurgeResult['released'], number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));
}

/** Additionne les résultats des appels successifs d'un même vidage (la requête rend la main toutes les ~20 s). */
export function addPurgeResults(total: PurgeResult, next: PurgeResult): PurgeResult {
  return {
    purged: total.purged + next.purged,
    bytesFreed: total.bytesFreed + next.bytesFreed,
    alreadyAbsent: total.alreadyAbsent + next.alreadyAbsent,
    released: {
      OPEN_OPERATION: total.released.OPEN_OPERATION + next.released.OPEN_OPERATION,
      CHANGED: total.released.CHANGED + next.released.CHANGED,
      TOO_RECENT: total.released.TOO_RECENT + next.released.TOO_RECENT,
    },
    remaining: next.remaining,
    volumesResolved: total.volumesResolved + next.volumesResolved,
    volumesVerified: total.volumesVerified + next.volumesVerified,
  };
}

export const EMPTY_PURGE_RESULT: PurgeResult = {
  purged: 0,
  bytesFreed: 0,
  alreadyAbsent: 0,
  released: { OPEN_OPERATION: 0, CHANGED: 0, TOO_RECENT: 0 },
  remaining: 0,
  volumesResolved: 0,
  volumesVerified: 0,
};

/** Appels successifs de vidage au plus (garde contre une boucle sans fin). */
export const MAX_PURGE_CALLS = 200;
/** Attente entre deux relectures d'un téléchargement en cours, et nombre de relectures au plus (~20 min). */
export const DOWNLOAD_POLL_MS = 2_000;
export const DOWNLOAD_POLL_MAX = 600;
