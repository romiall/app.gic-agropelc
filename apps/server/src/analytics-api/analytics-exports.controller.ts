/**
 * `GET /api/v1/analytics/exports`, `/exports/{id}` et `/exports/{id}/download` (P9-20 ; UC-ANA-05, BR-ANA-008,
 * ADR-077 §6, AV-434, AT-046). L'état et le fichier d'un export sont **réservés au demandeur** : aucun autre rôle ne
 * télécharge, titulaire de `audit.log.read` compris — l'audit lit la ligne d'export (jeu, filtres, colonnes, lignes),
 * pas le fichier, sans quoi l'ouvrir élargirait le périmètre et les mesures protégées par une voie latérale. L'export
 * d'un autre est introuvable (refus audité). Permission : `analytics.export`, revérifiée à chaque appel.
 *
 * Téléchargement : l'export doit être `DONE` et non échu (`409 EXPORT_NOT_READY` en file ou en cours, `409
 * EXPORT_FAILED` en échec, `410 EXPORT_EXPIRED` après l'échéance ou fichier purgé) ; le fichier est lu par morceaux ;
 * chaque téléchargement écrit une ligne d'audit (`AnalyticsExportDownloaded`, acteur, appareil).
 */
import { Controller, Get, HttpCode, Inject, Param, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { exportJobSchema } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { CHUNK_STORAGE } from '../platform/storage/chunk-storage.provider.js';
import type { ChunkStorage } from '../platform/storage/chunk-storage.js';
import { recordAudit } from '../audit/record-audit.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  exportStorageKey,
  exportsPage,
  readExport,
  type StoredExport,
} from '../modules/analytics/application/public/index.js';
import { ReadAccess, idParamSchema, parseOrThrow } from '../read-api/read-access.js';

export const ANALYTICS_EXPORT = 'analytics.export';
/** Exports listés au plus (les plus récents du demandeur). */
const EXPORTS_LIST_LIMIT = 50;
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

const CONTENT_TYPES = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

const listSchema = z.object({ exports: z.array(exportJobSchema) });

/** Statut vu du demandeur : un export réussi dont l'échéance est passée est expiré, même avant la purge. */
function effectiveStatus(job: StoredExport, now: Date): StoredExport['status'] {
  return job.status === 'DONE' && job.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : job.status;
}

function exportResponse(job: StoredExport, now: Date): z.input<typeof exportJobSchema> {
  return {
    id: job.id,
    dataset: job.dataset,
    format: job.format,
    status: effectiveStatus(job, now),
    rowCount: job.rowCount,
    errorCode: job.errorCode,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt === null ? null : job.finishedAt.toISOString(),
    expiresAt: job.expiresAt.toISOString(),
  };
}

@Controller('api/v1')
export class AnalyticsExportsController {
  private readonly access: ReadAccess;
  private readonly deps: { readonly clock: Clock; readonly idGenerator: IdGenerator };

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
    @Inject(CHUNK_STORAGE) private readonly storage: ChunkStorage,
  ) {
    this.deps = { clock, idGenerator };
    this.access = new ReadAccess(db, this.deps, ANALYTICS_EXPORT);
  }

  @Get('analytics/exports')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPORT)
  async list(@Req() request: AuthenticatedRequest) {
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'ANALYTICS_EXPORT' });
    const jobs = await exportsPage(this.db, {
      userId: request.auth!.sub,
      limit: EXPORTS_LIST_LIMIT,
    });
    return listSchema.parse({ exports: jobs.map((job) => exportResponse(job, now)) });
  }

  @Get('analytics/exports/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPORT)
  async one(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const job = await this.ownExport(request, id, now);
    return exportJobSchema.parse(exportResponse(job, now));
  }

  @Get('analytics/exports/:id/download')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPORT)
  async download(
    @Param() rawParams: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const job = await this.ownExport(request, id, now);
    const status = effectiveStatus(job, now);
    if (status === 'QUEUED' || status === 'RUNNING') {
      throw new ApiError(409, 'EXPORT_NOT_READY', 'L’export n’est pas encore prêt.');
    }
    if (status === 'FAILED') {
      throw new ApiError(409, 'EXPORT_FAILED', 'L’export n’a pas pu être produit.', {
        error_code: job.errorCode,
      });
    }
    if (status === 'EXPIRED') {
      throw new ApiError(410, 'EXPORT_EXPIRED', 'L’export a expiré : refaites-le.');
    }
    const key = exportStorageKey(job.id);
    const size = await this.storage.uploadedBytes(key);
    if (size === 0) {
      throw new ApiError(410, 'EXPORT_EXPIRED', 'Le fichier de l’export n’est plus disponible.');
    }
    await this.db.transaction().execute((trx) =>
      recordAudit(trx, this.deps, {
        occurredAt: now,
        actorUserId: request.auth!.sub,
        actorRoles: [],
        deviceId: request.auth!.device_id,
        action: 'analytics.export.downloaded',
        entityType: 'ANALYTICS_EXPORT',
        entityId: job.id,
        after: {
          event: 'AnalyticsExportDownloaded',
          dataset: job.dataset,
          format: job.format,
          row_count: job.rowCount,
        },
        result: 'SUCCESS',
      }),
    );
    const extension = job.format === 'CSV' ? 'csv' : 'xlsx';
    const filename = `export-${job.dataset}-${businessDayOf(job.createdAt)}.${extension}`;
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(Readable.from(this.storage.readChunks(key, DOWNLOAD_CHUNK_BYTES)), {
      type: CONTENT_TYPES[job.format],
      disposition: `attachment; filename="${filename}"`,
      length: size,
    });
  }

  /** L'export du demandeur ; celui d'un autre, ou inconnu, est introuvable (refus audité). */
  private async ownExport(
    request: AuthenticatedRequest,
    id: string,
    now: Date,
  ): Promise<StoredExport> {
    await this.access.requirePermission(request, now, { type: 'ANALYTICS_EXPORT', id });
    const job = await readExport(this.db, id);
    if (job === undefined || job.requestedBy !== request.auth!.sub) {
      return this.access.deny(request, now, { type: 'ANALYTICS_EXPORT', id }, 'OUT_OF_SCOPE');
    }
    return job;
  }
}
