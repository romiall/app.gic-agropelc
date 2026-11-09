/**
 * Archive des photos jointes (AV-539, ADR-070) : formes des requêtes et des réponses de
 * `/api/v1/attachment-archives`, partagées par le serveur (qui les produit et les valide) et l'écran des
 * paramètres (qui les affiche). Les règles pures (périodes, noms, seuil de 30 jours) sont dans `@gic/domain`.
 */
import { z } from 'zod';
import { ARCHIVE_CATEGORIES, ARCHIVE_GRANULARITIES } from '@gic/domain';

export const ATTACHMENT_ARCHIVES_PATH = '/api/v1/attachment-archives';

export const ARCHIVE_STATUSES = ['READY', 'COMPLETED', 'CANCELLED'] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

export const ARCHIVE_ITEM_STATES = ['PLANNED', 'PURGED', 'RELEASED'] as const;
export type ArchiveItemState = (typeof ARCHIVE_ITEM_STATES)[number];

/** Pourquoi une photo du plan reste sur le serveur au moment du vidage ou de l'annulation. */
export const ARCHIVE_RELEASE_REASONS = [
  'OPEN_OPERATION',
  'CHANGED',
  'TOO_RECENT',
  'ARCHIVE_CANCELLED',
] as const;
export type ArchiveReleaseReason = (typeof ARCHIVE_RELEASE_REASONS)[number];

/** Codes d'erreur propres à l'archive (en plus de `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`). */
export const ARCHIVE_ERROR_CODES = [
  /** Rien à archiver pour cette période (rien d'assez ancien, ou toutes les opérations encore ouvertes). */
  'ARCHIVE_NOTHING_TO_ARCHIVE',
  /** Un plan vivant existe déjà pour cette période. */
  'ARCHIVE_PERIOD_IN_PROGRESS',
  /** Le vidage vise des volumes pas encore livrés en entier. */
  'ARCHIVE_NOT_DOWNLOADED',
  /** L'empreinte du fichier rangé n'est pas celle du volume. */
  'ARCHIVE_HASH_MISMATCH',
  /** Un autre téléchargement de volume est en cours dans le processus. */
  'ARCHIVE_BUSY',
  /** Le plan n'est plus vivant (terminé ou annulé). */
  'ARCHIVE_NOT_READY',
  /** Les photos du volume sont déjà vidées : il ne peut plus être fabriqué. */
  'ARCHIVE_VOLUME_RESOLVED',
  /** Un fichier du volume manque ou n'a plus la taille enregistrée : le volume n'est pas fabriqué. */
  'ARCHIVE_VOLUME_INCOMPLETE',
  /** Billet de téléchargement absent, invalide ou échu. */
  'ARCHIVE_TICKET_INVALID',
  /** Lecture d'une pièce vidée du serveur (HTTP 410). */
  'ATTACHMENT_ARCHIVED',
] as const;

const wholeNumber = z.number().int().nonnegative();
const isoInstant = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const archiveCountSchema = z.object({ files: wholeNumber, bytes: wholeNumber });
export type ArchiveCount = z.infer<typeof archiveCountSchema>;

export const archiveCategorySchema = z.enum(ARCHIVE_CATEGORIES);
export const archiveGranularitySchema = z.enum(ARCHIVE_GRANULARITIES);

export const archiveSettingsSchema = z.object({
  minAgeDays: wholeNumber,
  volumeMaxMb: wholeNumber,
  defaultGranularity: archiveGranularitySchema,
  retentionYears: wholeNumber,
});
export type ArchiveSettings = z.infer<typeof archiveSettingsSchema>;

export const archivePeriodViewSchema = z.object({
  granularity: archiveGranularitySchema,
  start: day,
  end: day,
  label: z.string(),
});
export type ArchivePeriodView = z.infer<typeof archivePeriodViewSchema>;

export const archiveVolumeSchema = z.object({
  id: uuid,
  seq: wholeNumber,
  fileName: z.string(),
  category: archiveCategorySchema,
  /** Mois local `AAAA-MM`. */
  month: z.string(),
  part: wholeNumber,
  files: wholeNumber,
  filesBytes: wholeNumber,
  /** Taille exacte du fichier ZIP à télécharger. */
  zipBytes: wholeNumber,
  /** Empreinte SHA-256 du fichier, connue après la première livraison complète. */
  zipSha256: sha256.nullable(),
  deliveries: wholeNumber,
  abortedDeliveries: wholeNumber,
  firstDeliveredAt: isoInstant.nullable(),
  lastDeliveredAt: isoInstant.nullable(),
  verifiedAt: isoInstant.nullable(),
  resolvedAt: isoInstant.nullable(),
  /** Photos du volume : encore sur le serveur (prévues), vidées, libérées (restées sur le serveur). */
  planned: wholeNumber,
  purged: wholeNumber,
  released: wholeNumber,
});
export type ArchiveVolumeView = z.infer<typeof archiveVolumeSchema>;

export const archiveSchema = z.object({
  id: uuid,
  granularity: archiveGranularitySchema,
  period: archivePeriodViewSchema,
  status: z.enum(ARCHIVE_STATUSES),
  cutoffAt: isoInstant,
  minAgeDays: wholeNumber,
  createdAt: isoInstant,
  completedAt: isoInstant.nullable(),
  cancelledAt: isoInstant.nullable(),
  /** Photos du plan, et leur taille. */
  files: wholeNumber,
  filesBytes: wholeNumber,
  /** Photos de la période écartées au calcul : opération encore ouverte, fichier absent du disque. */
  keptOpen: wholeNumber,
  absent: wholeNumber,
  /** Tous les volumes sont livrés en entier : le vidage est permis. */
  allDelivered: z.boolean(),
  volumes: z.array(archiveVolumeSchema),
});
export type ArchiveView = z.infer<typeof archiveSchema>;

export const archiveListSchema = z.object({ archives: z.array(archiveSchema) });

export const archiveCatalogPeriodSchema = archivePeriodViewSchema.extend({
  /** Photos reçues dans la période et encore sur le serveur. */
  onServer: archiveCountSchema,
  /** Dont reçues avant la limite d'ancienneté (archivables si leur opération est fermée). */
  olderThanMinAge: archiveCountSchema,
  /** Dont gardées parce que reçues depuis moins de `minAgeDays` jours. */
  recent: archiveCountSchema,
  /** Déjà vidées du serveur (copie dans l'archive de l'entreprise). */
  archived: archiveCountSchema,
  /** Plan vivant de la période, s'il y en a un. */
  planId: uuid.nullable(),
});
export type ArchiveCatalogPeriod = z.infer<typeof archiveCatalogPeriodSchema>;

export const archiveCatalogSchema = z.object({
  granularity: archiveGranularitySchema,
  settings: archiveSettingsSchema,
  /** Tout ce qui est sur le serveur, toutes périodes confondues. */
  server: archiveCountSchema,
  periods: z.array(archiveCatalogPeriodSchema),
});
export type ArchiveCatalog = z.infer<typeof archiveCatalogSchema>;

export const createArchiveRequestSchema = z.object({
  granularity: archiveGranularitySchema,
  /** Premier jour de la période (`AAAA-MM-01`, ou le 1er janvier, avril, juillet ou octobre). */
  periodStart: day,
});
export type CreateArchiveRequest = z.infer<typeof createArchiveRequestSchema>;

export const createArchiveResponseSchema = z.object({ archive: archiveSchema });

export const downloadTicketSchema = z.object({
  /** Chemin à ouvrir (même origine) ; le billet est son paramètre `ticket`. */
  url: z.string(),
  expiresAt: isoInstant,
});
export type DownloadTicket = z.infer<typeof downloadTicketSchema>;

export const verifyVolumeRequestSchema = z.object({ sha256 });
export const verifyVolumeResponseSchema = z.object({ volume: archiveVolumeSchema });

export const purgeArchiveRequestSchema = z.object({
  /** Confirmation explicite : le vidage supprime des fichiers du serveur. */
  confirm: z.literal(true),
  /** Volumes à vider ; absent : tous les volumes du plan. */
  volumeIds: z.array(uuid).min(1).max(500).optional(),
});
export type PurgeArchiveRequest = z.infer<typeof purgeArchiveRequestSchema>;

export const purgeResultSchema = z.object({
  /** Fichiers supprimés du serveur. */
  purged: wholeNumber,
  /** Octets rendus au disque du serveur. */
  bytesFreed: wholeNumber,
  /** Photos restées sur le serveur, avec le motif. */
  released: z.object({
    OPEN_OPERATION: wholeNumber,
    CHANGED: wholeNumber,
    TOO_RECENT: wholeNumber,
  }),
  /** Dont le fichier manquait déjà au moment du vidage (rien à supprimer). */
  alreadyAbsent: wholeNumber,
  /** Photos encore prévues dans les volumes visés : le vidage reprend tant qu'il en reste (durée de requête bornée). */
  remaining: wholeNumber,
  /** Volumes dont toutes les photos sont maintenant résolues. */
  volumesResolved: wholeNumber,
  /** Volumes vidés qui avaient été vérifiés par empreinte. */
  volumesVerified: wholeNumber,
});
export type PurgeResult = z.infer<typeof purgeResultSchema>;

export const purgeArchiveResponseSchema = z.object({
  archive: archiveSchema,
  result: purgeResultSchema,
});

export const cancelArchiveResponseSchema = z.object({ archive: archiveSchema });

/** Détails de `410 ATTACHMENT_ARCHIVED` : où retrouver la photo dans l'archive de l'entreprise. */
export const attachmentArchivedDetailsSchema = z.object({
  archived_at: isoInstant,
  reference: z.string(),
  volume_file_name: z.string(),
  entry_path: z.string(),
});
export type AttachmentArchivedDetails = z.infer<typeof attachmentArchivedDetailsSchema>;
