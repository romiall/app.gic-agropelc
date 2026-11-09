/**
 * Archive des photos jointes : préparation du plan, catalogue, téléchargement d'un volume, vérification, vidage et
 * annulation (AV-539, ADR-070). Couche de transport : compose le module `attachments` (tables du plan), les faits des
 * modules propriétaires des documents, les paramètres de `organization` et le stockage des octets.
 *
 * Aucune ligne de `attachments_attachments` n'est modifiée ni supprimée : ce qui part du serveur est le fichier, après
 * un téléchargement complet et une confirmation, et chaque geste est audité (entité `ATTACHMENT_ARCHIVE`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ATTACHMENT_ARCHIVES_PATH,
  ATTACHMENT_OWNER_TYPES,
  type ArchiveCatalog,
  type ArchiveSettings,
  type ArchiveView,
  type ArchiveVolumeView,
  type CreateArchiveRequest,
  type DownloadTicket,
  type PurgeResult,
} from '@gic/contracts';
import {
  ARCHIVE_MAX_FILES_PER_PLAN,
  ARCHIVE_MAX_FILES_PER_VOLUME,
  DomainError,
  archiveCutoff,
  archiveEntryPath,
  archiveMonthOf,
  archiveMonthStart,
  archivePeriodFromStart,
  archivePeriodsOfMonths,
  archivePeriodWindow,
  archiveReferenceTokens,
  archiveVolumeFileName,
  businessDayOf,
  effectiveGranularity,
  effectiveMinAgeDays,
  effectiveRetentionYears,
  effectiveVolumeMaxBytes,
  planArchiveVolumes,
  uniqueEntryPaths,
  type ArchivePeriod,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { DATABASE, type Database } from '../../platform/kysely/database.provider.js';
import { CLOCK } from '../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../platform/id-generator.provider.js';
import { ApiError } from '../../platform/http/api-error.exception.js';
import { CHUNK_STORAGE } from '../../platform/storage/chunk-storage.provider.js';
import type { ChunkStorage } from '../../platform/storage/chunk-storage.js';
import { writeStoredZip } from '../../platform/zip/stored-zip-writer.js';
import { logStructured } from '../../platform/observability/logger.js';
import { recordAudit, type AuditResult } from '../../audit/record-audit.js';
import { recordDenied } from '../../audit/record-denied.js';
import { toBin } from '../../platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../../modules/identity/jwt-keys.provider.js';
import type { JwtKeyPair } from '../../modules/identity/application/public/jwt.js';
import {
  hasPermissionAt,
  sessionAccessAt,
} from '../../modules/identity/application/public/index.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';
import {
  archivedItemOfAttachment,
  cancelArchivePlan,
  completeArchiveIfDone,
  countPurgedItems,
  getArchive,
  getVolume,
  insertArchivePlan,
  listArchives,
  listLivePlans,
  listVolumeItems,
  listVolumes,
  loadArchiveCandidates,
  lockArchive,
  markItemsPurged,
  markItemsReleased,
  purgedMonthAggregates,
  recordVolumeAborted,
  recordVolumeDelivered,
  recordVolumeVerified,
  resolveVolumeIfDone,
  serverMonthAggregates,
  type ArchiveItemRecord,
  type ArchiveRecord,
  type ArchiveReleaseReason,
  type ArchiveVolumeRecord,
  type NewArchiveItem,
  type NewArchiveVolume,
} from '../../modules/attachments/application/public/index.js';
import { ownerKey, resolveArchiveOwners } from './archive-owners.js';
import { buildVolumeZip, type VolumeDocumentsItem } from './archive-documents.js';
import { signArchiveTicket, verifyArchiveTicket } from './archive-ticket.js';

export const ARCHIVE_EXPORT_PERMISSION = 'attachments.archive.export';
export const ARCHIVE_PURGE_PERMISSION = 'attachments.archive.purge';
export const ARCHIVE_AUDIT_ENTITY = 'ATTACHMENT_ARCHIVE';

const MB = 1024 * 1024;
/** Plans listés au plus (les plus récents). */
const LIST_LIMIT = 20;
/** Lecture d'un morceau d'une photo (mémoire du flux). */
const READ_CHUNK_BYTES = 64 * 1024;
/** Contrôles de présence des fichiers en parallèle. */
const STAT_CONCURRENCY = 16;
/** Photos traitées par transaction de vidage. */
const PURGE_BATCH = 500;
/** Durée au-delà de laquelle un vidage cesse de commencer de nouveaux lots et rend la main (durée de requête bornée). */
const PURGE_TIME_BUDGET_MS = 20_000;
/** Un téléchargement jamais terminé ni interrompu (raccordement perdu sans fermeture) libère sa place au bout d'une heure. */
const DOWNLOAD_WATCHDOG_MS = 60 * 60_000;
/** Téléchargements de volume simultanés dans ce processus (mémoire, disque, autres utilisateurs). */
const MAX_CONCURRENT_DOWNLOADS = 1;

export interface ArchiveActor {
  readonly userId: string;
  readonly deviceId: string;
}

export interface DownloadStream {
  readonly stream: Readable;
  readonly length: number;
  readonly fileName: string;
  /** À appeler une fois la réponse terminée ou interrompue : `flushed` est vrai si elle a été écrite en entier. */
  readonly settle: (flushed: boolean) => Promise<void>;
}

class FileIntegrityError extends Error {
  constructor(
    readonly entryPath: string,
    readonly problem: 'SIZE' | 'SHA256',
  ) {
    super(
      `Photo ${entryPath} : ${problem === 'SIZE' ? 'taille' : 'empreinte'} différente du plan.`,
    );
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const errno = (error as { errno?: number } | null)?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

@Injectable()
export class AttachmentArchiveService {
  private activeDownloads = 0;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CHUNK_STORAGE) private readonly storage: ChunkStorage,
    @Inject(JWT_KEYS) private readonly jwtKeys: JwtKeyPair,
  ) {}

  // -----------------------------------------------------------------------------------------------------------
  // Réglages et lectures
  // -----------------------------------------------------------------------------------------------------------

  async readSettings(at: Date): Promise<ArchiveSettings> {
    const read = (key: string) =>
      currentSettingValue(this.db, { key, scopeType: 'GLOBAL', scopeId: null, at });
    const [minAge, volumeMb, granularity, retention] = await Promise.all([
      read('attachments.archive.min_age_days'),
      read('attachments.archive.volume_max_mb'),
      read('attachments.archive.default_granularity'),
      read('attachments.archive.retention_years'),
    ]);
    return {
      minAgeDays: effectiveMinAgeDays(minAge),
      volumeMaxMb: Math.round(effectiveVolumeMaxBytes(volumeMb) / MB),
      defaultGranularity: effectiveGranularity(granularity),
      retentionYears: effectiveRetentionYears(retention),
    };
  }

  /** Catalogue des périodes ; sans `requested`, la période proposée par le réglage. */
  async catalog(requested?: ArchivePeriod['granularity']): Promise<ArchiveCatalog> {
    const now = this.clock.now();
    const settings = await this.readSettings(now);
    const granularity = requested ?? settings.defaultGranularity;
    const cutoff = archiveCutoff(now, settings.minAgeDays);
    const [server, purged, live] = await Promise.all([
      serverMonthAggregates(this.db, { cutoff }),
      purgedMonthAggregates(this.db),
      listLivePlans(this.db),
    ]);
    const months = new Set([...server.map((row) => row.month), ...purged.map((row) => row.month)]);
    const periods = archivePeriodsOfMonths(granularity, months).map((period) => {
      const inPeriod = (month: string) => period.months.includes(month);
      const onServer = server.filter((row) => inPeriod(row.month));
      const archived = purged.filter((row) => inPeriod(row.month));
      const sum = (rows: readonly { files?: number; bytes?: number }[]) => ({
        files: rows.reduce((total, row) => total + (row.files ?? 0), 0),
        bytes: rows.reduce((total, row) => total + (row.bytes ?? 0), 0),
      });
      const all = sum(onServer);
      const old = {
        files: onServer.reduce((total, row) => total + row.oldFiles, 0),
        bytes: onServer.reduce((total, row) => total + row.oldBytes, 0),
      };
      return {
        granularity: period.granularity,
        start: period.start,
        end: period.end,
        label: period.label,
        onServer: all,
        olderThanMinAge: old,
        recent: { files: all.files - old.files, bytes: all.bytes - old.bytes },
        archived: sum(archived),
        planId:
          live.find((plan) => plan.granularity === granularity && plan.periodStart === period.start)
            ?.id ?? null,
      };
    });
    return {
      granularity,
      settings,
      server: {
        files: server.reduce((total, row) => total + row.files, 0),
        bytes: server.reduce((total, row) => total + row.bytes, 0),
      },
      periods,
    };
  }

  async list(): Promise<ArchiveView[]> {
    const records = await listArchives(this.db, LIST_LIMIT);
    const volumes = await listVolumes(
      this.db,
      records.map((record) => record.id),
    );
    return records.map((record) =>
      this.view(
        record,
        volumes.filter((volume) => volume.archiveId === record.id),
      ),
    );
  }

  async get(archiveId: string): Promise<ArchiveView> {
    const record = await getArchive(this.db, archiveId);
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Archive introuvable.');
    return this.view(record, await listVolumes(this.db, [archiveId]));
  }

  private view(record: ArchiveRecord, volumes: readonly ArchiveVolumeRecord[]): ArchiveView {
    const period = archivePeriodFromStart(record.granularity, record.periodStart);
    const open = volumes.filter((volume) => volume.resolvedAt === null);
    return {
      id: record.id,
      granularity: record.granularity,
      period: {
        granularity: record.granularity,
        start: period.start,
        end: period.end,
        label: period.label,
      },
      status: record.status,
      cutoffAt: record.cutoffAt.toISOString(),
      minAgeDays: record.minAgeDays,
      createdAt: record.createdAt.toISOString(),
      completedAt: iso(record.completedAt),
      cancelledAt: iso(record.cancelledAt),
      files: record.fileCount,
      filesBytes: record.filesBytes,
      keptOpen: record.keptOpenCount,
      absent: record.absentCount,
      allDelivered:
        record.status === 'READY' &&
        open.length > 0 &&
        open.every((volume) => volume.deliveries > 0),
      volumes: volumes.map((volume) => this.volumeView(volume)),
    };
  }

  private volumeView(volume: ArchiveVolumeRecord): ArchiveVolumeView {
    return {
      id: volume.id,
      seq: volume.seq,
      fileName: volume.fileName,
      category: volume.category,
      month: volume.month,
      part: volume.part,
      files: volume.fileCount,
      filesBytes: volume.filesBytes,
      zipBytes: volume.zipBytes,
      zipSha256: volume.zipSha256,
      deliveries: volume.deliveries,
      abortedDeliveries: volume.abortedDeliveries,
      firstDeliveredAt: iso(volume.firstDeliveredAt),
      lastDeliveredAt: iso(volume.lastDeliveredAt),
      verifiedAt: iso(volume.verifiedAt),
      resolvedAt: iso(volume.resolvedAt),
      planned: volume.planned,
      purged: volume.purged,
      released: volume.released,
    };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Préparation du plan
  // -----------------------------------------------------------------------------------------------------------

  async create(actor: ArchiveActor, input: CreateArchiveRequest): Promise<ArchiveView> {
    const now = this.clock.now();
    let period: ArchivePeriod;
    try {
      period = archivePeriodFromStart(input.granularity, input.periodStart);
    } catch (error) {
      if (error instanceof DomainError) throw new ApiError(400, 'VALIDATION_ERROR', error.message);
      throw error;
    }
    const settings = await this.readSettings(now);
    const live = (await listLivePlans(this.db)).find(
      (plan) => plan.granularity === period.granularity && plan.periodStart === period.start,
    );
    if (live) throw this.periodInProgress(live.id);

    const cutoff = archiveCutoff(now, settings.minAgeDays);
    const window = archivePeriodWindow(period);
    const candidates = await loadArchiveCandidates(this.db, {
      fromUtc: window.startUtc,
      toUtc: window.endUtc,
      cutoff,
      ownerTypes: ATTACHMENT_OWNER_TYPES,
      limit: ARCHIVE_MAX_FILES_PER_PLAN,
    });
    const owners = await resolveArchiveOwners(
      this.db,
      candidates.map((candidate) => ({
        ownerType: candidate.ownerType,
        ownerId: candidate.ownerId,
      })),
    );

    // Opération fermée, sans validation en attente ; sinon la photo reste (ADR-070 §2.4).
    let keptOpen = 0;
    const closed = candidates.flatMap((candidate) => {
      const owner = owners.get(ownerKey(candidate.ownerType, candidate.ownerId));
      if (!owner?.archivable) {
        keptOpen += 1;
        return [];
      }
      return [{ candidate, facts: owner.facts }];
    });
    // Le fichier doit être sur le disque, à la taille enregistrée.
    const present = await mapLimit(closed, STAT_CONCURRENCY, async ({ candidate }) => {
      return (await this.storage.uploadedBytes(candidate.storageKey)) === candidate.sizeBytes;
    });
    const ready = closed.filter((_, index) => present[index]);
    const absent = closed.length - ready.length;
    if (ready.length === 0) {
      throw new ApiError(
        409,
        'ARCHIVE_NOTHING_TO_ARCHIVE',
        'Rien à archiver pour cette période : aucune photo assez ancienne dont l’opération soit fermée.',
        { kept_open: keptOpen, absent },
      );
    }

    const paths = uniqueEntryPaths(
      ready.map(({ candidate, facts }) =>
        archiveEntryPath({
          category: facts.category,
          reference: facts.reference,
          secondaryReferences: facts.secondaryReferences,
          submittedAt: candidate.submittedAt,
          attachmentId: candidate.attachmentId,
          mimeType: candidate.mimeType,
        }),
      ),
    );
    const planned = ready.map(({ candidate, facts }, index) => {
      const tokens = archiveReferenceTokens(facts.reference, facts.secondaryReferences);
      const item: NewArchiveItem = {
        attachmentId: candidate.attachmentId,
        entryPath: paths[index]!,
        category: facts.category,
        ownerType: candidate.ownerType,
        ownerId: candidate.ownerId,
        reference: tokens.reference,
        secondaryReference: tokens.secondary.length > 0 ? tokens.secondary.join(' ') : null,
        kind: candidate.kind,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.sizeBytes,
        sha256: candidate.sha256,
        capturedAt: candidate.capturedAt,
        submittedAt: candidate.submittedAt,
      };
      return { ...item, month: archiveMonthOf(candidate.submittedAt) };
    });

    const maxBytes = settings.volumeMaxMb * MB;
    const grouped = planArchiveVolumes(planned, {
      maxBytes,
      maxFiles: ARCHIVE_MAX_FILES_PER_VOLUME,
    });
    const archiveId = this.idGenerator.newId();
    const planDay = businessDayOf(now);
    const documentsArchive = {
      id: archiveId,
      granularity: period.granularity,
      periodStart: period.start,
      periodEnd: period.end,
      cutoffAt: cutoff,
      createdAt: now,
      retentionYears: settings.retentionYears,
    };
    const volumes: NewArchiveVolume[] = grouped.map((group, index) => {
      const fileName = archiveVolumeFileName({
        month: group.month,
        category: group.category,
        planDay,
        part: group.part,
        parts: group.parts,
      });
      const items: NewArchiveItem[] = group.items.map(({ month: _month, ...item }) => item);
      const zip = buildVolumeZip(
        documentsArchive,
        { fileName, seq: index + 1, volumeCount: grouped.length },
        items,
        () => (async function* () {})(),
      );
      return {
        id: this.idGenerator.newId(),
        seq: index + 1,
        category: group.category,
        monthStart: archiveMonthStart(group.month),
        part: group.part,
        fileName,
        filesBytes: group.filesBytes,
        zipBytes: zip.length,
        items,
      };
    });

    try {
      await this.db.transaction().execute(async (trx) => {
        await insertArchivePlan(trx, {
          id: archiveId,
          granularity: period.granularity,
          periodStart: period.start,
          periodEnd: period.end,
          cutoffAt: cutoff,
          minAgeDays: settings.minAgeDays,
          volumeMaxBytes: maxBytes,
          retentionYears: settings.retentionYears,
          keptOpenCount: keptOpen,
          absentCount: absent,
          createdBy: actor.userId,
          createdAt: now,
          volumes,
        });
        await this.audit(trx, actor, now, 'attachments.archive.created', archiveId, 'SUCCESS', {
          period: period.label,
          granularity: period.granularity,
          files: ready.length,
          filesBytes: volumes.reduce((total, volume) => total + volume.filesBytes, 0),
          volumes: volumes.length,
          keptOpen,
          absent,
          cutoffAt: cutoff.toISOString(),
          minAgeDays: settings.minAgeDays,
        });
      });
    } catch (error) {
      // Deux préparations de la même période, ou d'un mois et de son trimestre, qui se croisent.
      if (isDuplicateKey(error)) throw this.periodInProgress(null);
      throw error;
    }
    return this.get(archiveId);
  }

  private periodInProgress(archiveId: string | null): ApiError {
    return new ApiError(
      409,
      'ARCHIVE_PERIOD_IN_PROGRESS',
      'Une archive de cette période est déjà préparée : téléchargez-la puis videz l’espace, ou annulez-la.',
      archiveId === null ? undefined : { archive_id: archiveId },
    );
  }

  // -----------------------------------------------------------------------------------------------------------
  // Téléchargement
  // -----------------------------------------------------------------------------------------------------------

  /** Billet de téléchargement d'un volume du plan (le droit d'export est vérifié par l'appelant). */
  async issueTicket(
    actor: ArchiveActor & { readonly sessionId: string },
    archiveId: string,
    volumeId: string,
  ): Promise<DownloadTicket> {
    const { archive, volume } = await this.requireVolume(archiveId, volumeId);
    this.assertDownloadable(archive, volume);
    const { token, expiresAt } = await signArchiveTicket(
      this.jwtKeys.privateKey,
      {
        volumeId,
        userId: actor.userId,
        deviceId: actor.deviceId,
        sessionId: actor.sessionId,
      },
      this.clock.now(),
    );
    return {
      url: `${ATTACHMENT_ARCHIVES_PATH}/download?ticket=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private assertDownloadable(archive: ArchiveRecord, volume: ArchiveVolumeRecord): void {
    if (archive.status !== 'READY') {
      throw new ApiError(409, 'ARCHIVE_NOT_READY', 'Cette archive est terminée ou annulée.');
    }
    if (volume.resolvedAt !== null || volume.purged > 0) {
      throw new ApiError(
        409,
        'ARCHIVE_VOLUME_RESOLVED',
        'Les photos de ce volume sont déjà vidées du serveur : il ne peut plus être téléchargé.',
      );
    }
  }

  private async requireVolume(
    archiveId: string,
    volumeId: string,
  ): Promise<{ archive: ArchiveRecord; volume: ArchiveVolumeRecord }> {
    const archive = await getArchive(this.db, archiveId);
    const volume = archive ? await getVolume(this.db, volumeId) : undefined;
    if (!archive || !volume || volume.archiveId !== archive.id) {
      throw new ApiError(404, 'NOT_FOUND', 'Volume d’archive introuvable.');
    }
    return { archive, volume };
  }

  /**
   * Ouvre le flux d'un volume pour un billet (route publique : authentifiée par le billet). Tout est revérifié :
   * signature, échéance, session, compte, appareil, droit, état du plan, fichiers sur le disque. Rien n'est écrit
   * avant la fin de la réponse (`settle`).
   */
  async openDownload(token: string): Promise<DownloadStream> {
    const now = this.clock.now();
    const verified = await verifyArchiveTicket(this.jwtKeys.publicKey, token, now);
    if (!verified.ok) {
      throw new ApiError(
        401,
        'ARCHIVE_TICKET_INVALID',
        verified.reason === 'EXPIRED'
          ? 'Billet de téléchargement échu : relancez le téléchargement depuis l’application.'
          : 'Billet de téléchargement invalide.',
      );
    }
    const { volumeId, userId, deviceId, sessionId } = verified.claims;
    const access = await sessionAccessAt(this.db, { sessionId, userId, deviceId, at: now });
    if (access !== 'ACTIVE') {
      throw new ApiError(401, 'ARCHIVE_TICKET_INVALID', 'Session close ou appareil hors service.');
    }
    if (!(await hasPermissionAt(this.db, toBin(userId), ARCHIVE_EXPORT_PERMISSION, now))) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: userId,
          actorRoles: [],
          deviceId,
          action: 'access.denied',
          entityType: ARCHIVE_AUDIT_ENTITY,
          entityId: volumeId,
          reason: `Permission manquante : ${ARCHIVE_EXPORT_PERMISSION}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour télécharger l’archive.');
    }

    const volume = await getVolume(this.db, volumeId);
    const archive = volume ? await getArchive(this.db, volume.archiveId) : undefined;
    if (!volume || !archive) throw new ApiError(404, 'NOT_FOUND', 'Volume d’archive introuvable.');
    this.assertDownloadable(archive, volume);

    if (this.activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      throw new ApiError(
        429,
        'ARCHIVE_BUSY',
        'Un autre volume est en cours de téléchargement : attendez sa fin.',
      );
    }
    // La place est prise sur-le-champ, sans lecture asynchrone entre le contrôle et la prise : deux demandes
    // simultanées ne passent donc pas toutes les deux. Elle est rendue si le volume n'est pas fabriqué ; sinon
    // `settle` la rend à la fin de la réponse.
    this.activeDownloads += 1;
    try {
      return await this.openVolumeStream(archive, volume, { userId, deviceId });
    } catch (error) {
      this.activeDownloads -= 1;
      throw error;
    }
  }

  /** Fabrique le flux d'un volume dont la place de téléchargement est déjà prise (voir {@link openDownload}). */
  private async openVolumeStream(
    archive: ArchiveRecord,
    volume: ArchiveVolumeRecord,
    actor: ArchiveActor,
  ): Promise<DownloadStream> {
    const volumeId = volume.id;
    const { userId } = actor;
    const items = await listVolumeItems(this.db, volumeId, { states: ['PLANNED'] });
    if (items.length !== volume.fileCount) {
      throw new ApiError(
        409,
        'ARCHIVE_VOLUME_INCOMPLETE',
        'Certaines photos de ce volume ne sont plus prévues : il ne peut plus être fabriqué.',
      );
    }
    const sizes = await mapLimit(items, STAT_CONCURRENCY, (item) =>
      item.storageKey === null ? Promise.resolve(-1) : this.storage.uploadedBytes(item.storageKey),
    );
    const missing = items.filter((item, index) => sizes[index] !== item.sizeBytes);
    if (missing.length > 0) {
      throw new ApiError(
        409,
        'ARCHIVE_VOLUME_INCOMPLETE',
        `${missing.length} photo(s) de ce volume manquent sur le serveur ou n’ont plus la taille enregistrée : le volume n’est pas fabriqué.`,
        { missing: missing.length },
      );
    }

    const byAttachment = new Map(items.map((item) => [item.attachmentId, item]));
    const volumes = await listVolumes(this.db, [archive.id]);
    const zip = buildVolumeZip(
      archive,
      { fileName: volume.fileName, seq: volume.seq, volumeCount: volumes.length },
      items,
      (item: VolumeDocumentsItem) => this.verifiedPhoto(byAttachment.get(item.attachmentId)!),
    );
    if (zip.length !== volume.zipBytes) {
      throw new ApiError(
        409,
        'ARCHIVE_VOLUME_INCOMPLETE',
        'Le volume ne correspond plus au plan : il ne peut pas être fabriqué.',
      );
    }

    const hash = createHash('sha256');
    let complete = false;
    let failure: string | undefined;
    const clock = this.clock;
    async function* source(): AsyncGenerator<Buffer> {
      try {
        for await (const chunk of writeStoredZip(zip.entries, { comment: zip.comment })) {
          hash.update(chunk);
          yield chunk;
        }
        complete = true;
      } catch (error) {
        failure =
          error instanceof FileIntegrityError
            ? `${error.problem}:${error.entryPath}`
            : error instanceof Error
              ? error.message
              : 'inconnu';
        throw error;
      }
    }
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const settle = async (flushed: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      this.activeDownloads -= 1;
      const at = clock.now();
      const delivered = flushed && complete;
      await this.db.transaction().execute(async (trx) => {
        if (delivered) {
          const sha256 = hash.digest('hex');
          const outcome = await recordVolumeDelivered(trx, { volumeId, sha256, at, by: userId });
          await this.audit(
            trx,
            actor,
            at,
            'attachments.archive.volume_downloaded',
            archive.id,
            'SUCCESS',
            {
              volumeId,
              fileName: volume.fileName,
              files: volume.fileCount,
              bytes: zip.length,
              sha256,
              ...(outcome.hashChanged ? { previousSha256: outcome.previousSha256 } : {}),
            },
          );
        } else {
          await recordVolumeAborted(trx, volumeId);
          await this.audit(
            trx,
            actor,
            at,
            'attachments.archive.volume_download_aborted',
            archive.id,
            'FAILED',
            { volumeId, fileName: volume.fileName, bytes: zip.length },
            failure ?? 'Téléchargement interrompu par le destinataire.',
          );
        }
      });
    };

    const stream = Readable.from(source(), { objectMode: false });
    // Garde-fou : la place d'un téléchargement qui ne se règle jamais (ni fin ni coupure observée) est rendue.
    watchdog = setTimeout(() => {
      stream.destroy();
      void settle(false).catch((error: unknown) => this.logSettlementFailure(error));
    }, DOWNLOAD_WATCHDOG_MS);
    watchdog.unref();
    return { stream, length: zip.length, fileName: volume.fileName, settle };
  }

  /** Les octets d'une photo, par blocs, vérifiés contre la taille et l'empreinte du plan à la fin. */
  private async *verifiedPhoto(item: ArchiveItemRecord): AsyncGenerator<Uint8Array> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of this.storage.readChunks(item.storageKey!, READ_CHUNK_BYTES)) {
      size += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
    if (size !== item.sizeBytes) throw new FileIntegrityError(item.entryPath, 'SIZE');
    if (hash.digest('hex') !== item.sha256) throw new FileIntegrityError(item.entryPath, 'SHA256');
  }

  // -----------------------------------------------------------------------------------------------------------
  // Vérification du fichier rangé
  // -----------------------------------------------------------------------------------------------------------

  async verify(
    actor: ArchiveActor,
    archiveId: string,
    volumeId: string,
    sha256: string,
  ): Promise<ArchiveVolumeView> {
    const { volume } = await this.requireVolume(archiveId, volumeId);
    if (volume.zipSha256 === null) {
      throw new ApiError(
        409,
        'ARCHIVE_NOT_DOWNLOADED',
        'Ce volume n’a pas encore été téléchargé en entier : rien à comparer.',
      );
    }
    const now = this.clock.now();
    if (sha256 !== volume.zipSha256) {
      await this.db
        .transaction()
        .execute((trx) =>
          this.audit(
            trx,
            actor,
            now,
            'attachments.archive.volume_verified',
            archiveId,
            'FAILED',
            { volumeId, fileName: volume.fileName },
            'L’empreinte du fichier rangé diffère de celle du volume.',
          ),
        );
      throw new ApiError(
        409,
        'ARCHIVE_HASH_MISMATCH',
        'L’empreinte de ce fichier n’est pas celle du volume : retéléchargez-le.',
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await recordVolumeVerified(trx, { volumeId, at: now, by: actor.userId });
      await this.audit(
        trx,
        actor,
        now,
        'attachments.archive.volume_verified',
        archiveId,
        'SUCCESS',
        {
          volumeId,
          fileName: volume.fileName,
          sha256,
        },
      );
    });
    return this.volumeView((await getVolume(this.db, volumeId))!);
  }

  // -----------------------------------------------------------------------------------------------------------
  // Annulation
  // -----------------------------------------------------------------------------------------------------------

  async cancel(actor: ArchiveActor, archiveId: string): Promise<ArchiveView> {
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      const archive = await lockArchive(trx, archiveId);
      if (!archive) throw new ApiError(404, 'NOT_FOUND', 'Archive introuvable.');
      if (archive.status !== 'READY') {
        throw new ApiError(409, 'ARCHIVE_NOT_READY', 'Cette archive est déjà terminée ou annulée.');
      }
      if ((await countPurgedItems(trx, archiveId)) > 0) {
        throw new ApiError(
          409,
          'ARCHIVE_NOT_READY',
          'Des photos de cette archive sont déjà vidées du serveur : elle ne peut plus être annulée.',
        );
      }
      const { released } = await cancelArchivePlan(trx, { archiveId, at: now, by: actor.userId });
      await this.audit(trx, actor, now, 'attachments.archive.cancelled', archiveId, 'SUCCESS', {
        period: archive.periodStart,
        released,
      });
    });
    return this.get(archiveId);
  }

  // -----------------------------------------------------------------------------------------------------------
  // Vidage
  // -----------------------------------------------------------------------------------------------------------

  /**
   * Supprime du serveur les photos des volumes visés (tous les volumes du plan par défaut). Refusé tant qu'un volume
   * visé n'est pas livré en entier. Rejouable ; la durée de la requête est bornée : `result.remaining` dit s'il faut
   * rappeler.
   */
  async purge(
    actor: ArchiveActor,
    archiveId: string,
    volumeIds: readonly string[] | undefined,
  ): Promise<{ readonly archive: ArchiveView; readonly result: PurgeResult }> {
    const startedAt = Date.now();
    const archive = await getArchive(this.db, archiveId);
    if (!archive) throw new ApiError(404, 'NOT_FOUND', 'Archive introuvable.');
    if (archive.status !== 'READY') {
      throw new ApiError(409, 'ARCHIVE_NOT_READY', 'Cette archive est déjà terminée ou annulée.');
    }
    const all = await listVolumes(this.db, [archiveId]);
    const wanted =
      volumeIds === undefined ? all : all.filter((volume) => volumeIds.includes(volume.id));
    if (volumeIds !== undefined && wanted.length !== new Set(volumeIds).size) {
      throw new ApiError(404, 'NOT_FOUND', 'Volume d’archive introuvable dans ce plan.');
    }
    const targets = wanted.filter((volume) => volume.resolvedAt === null);
    const notDownloaded = targets.filter((volume) => volume.deliveries === 0);
    if (notDownloaded.length > 0) {
      throw new ApiError(
        409,
        'ARCHIVE_NOT_DOWNLOADED',
        `${notDownloaded.length} volume(s) n’ont pas été téléchargés en entier : le vidage est refusé.`,
        { volumes: notDownloaded.map((volume) => ({ id: volume.id, file_name: volume.fileName })) },
      );
    }

    const totals = {
      purged: 0,
      bytesFreed: 0,
      alreadyAbsent: 0,
      released: { OPEN_OPERATION: 0, CHANGED: 0, TOO_RECENT: 0 },
      volumesResolved: 0,
      volumesVerified: 0,
    };
    for (const volume of targets) {
      let resolved = false;
      while (!resolved && Date.now() - startedAt < PURGE_TIME_BUDGET_MS) {
        const batch = await this.purgeBatch(actor, archive, volume);
        totals.purged += batch.purged;
        totals.bytesFreed += batch.bytesFreed;
        totals.alreadyAbsent += batch.alreadyAbsent;
        totals.released.OPEN_OPERATION += batch.released.OPEN_OPERATION;
        totals.released.CHANGED += batch.released.CHANGED;
        totals.released.TOO_RECENT += batch.released.TOO_RECENT;
        resolved = batch.volumeResolved;
        if (batch.volumeResolved) {
          totals.volumesResolved += 1;
          if (volume.verifiedAt !== null) totals.volumesVerified += 1;
        }
      }
    }
    const now = this.clock.now();
    await this.db
      .transaction()
      .execute((trx) => completeArchiveIfDone(trx, { archiveId, at: now }));

    const after = await listVolumes(this.db, [archiveId]);
    const remaining = after
      .filter((volume) => targets.some((target) => target.id === volume.id))
      .reduce((total, volume) => total + volume.planned, 0);
    return { archive: await this.get(archiveId), result: { ...totals, remaining } };
  }

  /** Un lot de photos d'un volume : relues, jugées, supprimées ou libérées, dans une transaction (volume verrouillé). */
  private async purgeBatch(
    actor: ArchiveActor,
    archive: ArchiveRecord,
    volume: ArchiveVolumeRecord,
  ): Promise<{
    purged: number;
    bytesFreed: number;
    alreadyAbsent: number;
    released: { OPEN_OPERATION: number; CHANGED: number; TOO_RECENT: number };
    volumeResolved: boolean;
  }> {
    const settings = await this.readSettings(this.clock.now());
    return this.db.transaction().execute(async (trx) => {
      const now = this.clock.now();
      const outcome = {
        purged: 0,
        bytesFreed: 0,
        alreadyAbsent: 0,
        released: { OPEN_OPERATION: 0, CHANGED: 0, TOO_RECENT: 0 },
        volumeResolved: false,
      };
      const locked = await getVolume(trx, volume.id, { forUpdate: true });
      if (!locked || locked.resolvedAt !== null) {
        outcome.volumeResolved = true;
        return outcome;
      }
      const items = await listVolumeItems(trx, volume.id, {
        states: ['PLANNED'],
        limit: PURGE_BATCH,
      });
      const owners = await resolveArchiveOwners(
        trx,
        items.map((item) => ({ ownerType: item.ownerType, ownerId: item.ownerId })),
      );
      const recentAfter = archiveCutoff(now, settings.minAgeDays);

      const toPurge: ArchiveItemRecord[] = [];
      const toRelease = new Map<ArchiveReleaseReason, string[]>();
      const release = (reason: ArchiveReleaseReason, item: ArchiveItemRecord) =>
        toRelease.set(reason, [...(toRelease.get(reason) ?? []), item.attachmentId]);
      for (const item of items) {
        if (
          item.storageKey === null ||
          item.currentUploadStatus !== 'AVAILABLE' ||
          item.currentSha256 !== item.sha256 ||
          item.currentSizeBytes !== item.sizeBytes
        ) {
          release('CHANGED', item);
        } else if (item.submittedAt.getTime() >= recentAfter.getTime()) {
          release('TOO_RECENT', item);
        } else if (!owners.get(ownerKey(item.ownerType, item.ownerId))?.archivable) {
          release('OPEN_OPERATION', item);
        } else {
          toPurge.push(item);
        }
      }

      // Le fichier part avant l'écriture de l'état : une coupure entre les deux laisse une photo « prévue » sans
      // fichier, que la reprise du vidage solde (jamais une photo vidée dont le fichier serait encore là).
      for (const item of toPurge) {
        const size = await this.storage.uploadedBytes(item.storageKey!);
        if (size === 0) outcome.alreadyAbsent += 1;
        outcome.bytesFreed += size;
        await this.storage.delete(item.storageKey!);
        outcome.purged += 1;
      }
      await markItemsPurged(trx, {
        volumeId: volume.id,
        attachmentIds: toPurge.map((item) => item.attachmentId),
        at: now,
      });
      for (const [reason, ids] of toRelease) {
        await markItemsReleased(trx, { volumeId: volume.id, attachmentIds: ids, reason, at: now });
        if (reason === 'OPEN_OPERATION' || reason === 'CHANGED' || reason === 'TOO_RECENT') {
          outcome.released[reason] += ids.length;
        }
      }

      outcome.volumeResolved = await resolveVolumeIfDone(trx, {
        volumeId: volume.id,
        at: now,
        by: actor.userId,
      });
      if (outcome.volumeResolved) {
        const resolved = (await getVolume(trx, volume.id))!;
        await this.audit(trx, actor, now, 'attachments.archive.purged', archive.id, 'SUCCESS', {
          volumeId: volume.id,
          fileName: volume.fileName,
          period: archive.periodStart,
          purged: resolved.purged,
          released: resolved.released,
          verified: resolved.verifiedAt !== null,
          bytesFreedThisCall: outcome.bytesFreed,
        });
      }
      return outcome;
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // Lecture d'une pièce vidée
  // -----------------------------------------------------------------------------------------------------------

  /**
   * Où retrouver une pièce vidée du serveur (`410 ATTACHMENT_ARCHIVED`), ou `undefined` si elle n'est couverte par
   * aucun plan. Une pièce « prévue » (plan non vidé) dont le fichier manque est aussi expliquée par son plan.
   */
  async archivedLocation(attachmentId: string): Promise<
    | {
        readonly purged: boolean;
        readonly archivedAt: Date;
        readonly reference: string;
        readonly volumeFileName: string;
        readonly entryPath: string;
      }
    | undefined
  > {
    const item = await archivedItemOfAttachment(this.db, attachmentId);
    if (!item) return undefined;
    return {
      purged: item.state === 'PURGED',
      archivedAt: item.resolvedAt ?? item.archiveCreatedAt,
      reference: item.reference,
      volumeFileName: item.volumeFileName,
      entryPath: item.entryPath,
    };
  }

  // -----------------------------------------------------------------------------------------------------------

  private audit(
    trx: Parameters<typeof recordAudit>[0],
    actor: ArchiveActor,
    at: Date,
    action: string,
    archiveId: string,
    result: AuditResult,
    after: Record<string, unknown>,
    reason?: string,
  ) {
    return recordAudit(
      trx,
      { idGenerator: this.idGenerator, clock: this.clock },
      {
        occurredAt: at,
        actorUserId: actor.userId,
        actorRoles: [],
        deviceId: actor.deviceId,
        action,
        entityType: ARCHIVE_AUDIT_ENTITY,
        entityId: archiveId,
        result,
        after,
        ...(reason !== undefined ? { reason } : {}),
      },
    );
  }

  /** Journal d'une erreur de règlement d'un téléchargement (la réponse est déjà partie). */
  logSettlementFailure(error: unknown): void {
    logStructured(
      'error',
      { module: 'attachments', code: 'ARCHIVE_SETTLE_FAILED' },
      `Archive des photos : enregistrement de la fin d'un téléchargement impossible (${error instanceof Error ? error.message : 'inconnu'}).`,
    );
  }
}
