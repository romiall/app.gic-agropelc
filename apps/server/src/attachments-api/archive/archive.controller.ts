/**
 * `/api/v1/attachment-archives` (AV-539, ADR-070) : catalogue des périodes, plan d'archive, billet et téléchargement
 * d'un volume, vérification du fichier rangé, vidage, annulation. **Réservé à l'administrateur** : droits
 * `attachments.archive.export` (tout sauf le vidage) et `attachments.archive.purge` (vider), revérifiés à chaque appel,
 * refus audités. Actions d'exploitation en ligne, hors du journal des commandes de synchronisation (ADR-070).
 *
 * `GET /download?ticket={billet}` est authentifiée par le **billet** (ADR-070 §6), non par l'en-tête `Authorization` : un lien
 * de téléchargement n'en porte pas. Le billet, de nature distincte d'un jeton d'accès, ne vaut que quelques minutes et
 * le serveur revérifie la session, le compte, l'appareil et le droit à chaque appel.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  archiveCatalogSchema,
  archiveListSchema,
  archiveSchema,
  archiveVolumeSchema,
  createArchiveRequestSchema,
  downloadTicketSchema,
  purgeArchiveRequestSchema,
  purgeArchiveResponseSchema,
  verifyVolumeRequestSchema,
} from '@gic/contracts';
import { ARCHIVE_GRANULARITIES, type Clock, type IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../../platform/kysely/database.provider.js';
import { CLOCK } from '../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../platform/id-generator.provider.js';
import { Public, RequiresPermission } from '../../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../../modules/identity/api/auth.guard.js';
import { ReadAccess, idParamSchema, parseOrThrow, uuidParam } from '../../read-api/read-access.js';
import {
  ARCHIVE_AUDIT_ENTITY,
  ARCHIVE_EXPORT_PERMISSION,
  ARCHIVE_PURGE_PERMISSION,
  AttachmentArchiveService,
  type ArchiveActor,
} from './archive-service.js';

const volumeParamSchema = z.object({ id: uuidParam, volumeId: uuidParam });
/** Un billet est un JWT de plusieurs centaines de caractères : en paramètre de requête, non de chemin (le routeur borne un paramètre de chemin à 100 caractères). */
const ticketQuerySchema = z.object({ ticket: z.string().min(20).max(2000) });
/** Sans `granularity`, la période proposée par le réglage `attachments.archive.default_granularity`. */
const catalogQuerySchema = z.object({ granularity: z.enum(ARCHIVE_GRANULARITIES).optional() });

@Controller('api/v1/attachment-archives')
export class AttachmentArchiveController {
  private readonly exportAccess: ReadAccess;
  private readonly purgeAccess: ReadAccess;

  constructor(
    @Inject(DATABASE) db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
    @Inject(AttachmentArchiveService) private readonly service: AttachmentArchiveService,
  ) {
    const deps = { clock, idGenerator };
    this.exportAccess = new ReadAccess(db, deps, ARCHIVE_EXPORT_PERMISSION);
    this.purgeAccess = new ReadAccess(db, deps, ARCHIVE_PURGE_PERMISSION);
  }

  private actor(request: AuthenticatedRequest): ArchiveActor {
    return { userId: request.auth!.sub, deviceId: request.auth!.device_id };
  }

  private async requireExport(request: AuthenticatedRequest, id?: string): Promise<Date> {
    const now = this.clock.now();
    await this.exportAccess.requirePermission(request, now, {
      type: ARCHIVE_AUDIT_ENTITY,
      ...(id !== undefined ? { id } : {}),
    });
    return now;
  }

  @Get('catalog')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async catalog(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    await this.requireExport(request);
    const { granularity } = parseOrThrow(catalogQuerySchema, rawQuery);
    return archiveCatalogSchema.parse(await this.service.catalog(granularity));
  }

  @Get()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async list(@Req() request: AuthenticatedRequest) {
    await this.requireExport(request);
    return archiveListSchema.parse({ archives: await this.service.list() });
  }

  @Post()
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async create(@Body() rawBody: unknown, @Req() request: AuthenticatedRequest) {
    await this.requireExport(request);
    const body = parseOrThrow(createArchiveRequestSchema, rawBody);
    return { archive: archiveSchema.parse(await this.service.create(this.actor(request), body)) };
  }

  @Get(':id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async one(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    await this.requireExport(request, id);
    return { archive: archiveSchema.parse(await this.service.get(id)) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async cancel(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    await this.requireExport(request, id);
    return { archive: archiveSchema.parse(await this.service.cancel(this.actor(request), id)) };
  }

  @Post(':id/volumes/:volumeId/ticket')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async ticket(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id, volumeId } = parseOrThrow(volumeParamSchema, rawParams);
    await this.requireExport(request, id);
    return downloadTicketSchema.parse(
      await this.service.issueTicket(
        { ...this.actor(request), sessionId: request.auth!.session_id },
        id,
        volumeId,
      ),
    );
  }

  @Post(':id/volumes/:volumeId/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_EXPORT_PERMISSION)
  async verify(
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { id, volumeId } = parseOrThrow(volumeParamSchema, rawParams);
    await this.requireExport(request, id);
    const { sha256 } = parseOrThrow(verifyVolumeRequestSchema, rawBody);
    return {
      volume: archiveVolumeSchema.parse(
        await this.service.verify(this.actor(request), id, volumeId, sha256),
      ),
    };
  }

  @Post(':id/purge')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ARCHIVE_PURGE_PERMISSION)
  async purge(
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    await this.purgeAccess.requirePermission(request, now, { type: ARCHIVE_AUDIT_ENTITY, id });
    const body = parseOrThrow(purgeArchiveRequestSchema, rawBody);
    return purgeArchiveResponseSchema.parse(
      await this.service.purge(this.actor(request), id, body.volumeIds),
    );
  }

  /**
   * Téléchargement d'un volume par billet (ADR-070 §6). `@Public` au sens de NFR-24 : pas d'en-tête `Authorization`,
   * mais un billet signé, court, qui désigne l'utilisateur, l'appareil et la session, revérifiés à chaque appel.
   */
  @Get('download')
  @HttpCode(200)
  @Public()
  async download(
    @Query() rawQuery: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const { ticket } = parseOrThrow(ticketQuerySchema, rawQuery);
    const download = await this.service.openDownload(ticket);
    const raw = reply.raw;
    // `finish` : la réponse entière a été remise au système ; `close` sans `finish` : interruption du destinataire ou
    // du flux. Un seul règlement dans les deux cas (`writableFinished` n'est pas fiable hors d'un vrai connecteur).
    let flushed = false;
    let settled = false;
    const settleOnce = () => {
      if (settled) return;
      settled = true;
      void download.settle(flushed).catch((error: unknown) => {
        this.service.logSettlementFailure(error);
      });
    };
    raw.once('finish', () => {
      flushed = true;
      settleOnce();
    });
    raw.once('close', settleOnce);
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Accept-Ranges', 'none');
    return new StreamableFile(download.stream, {
      type: 'application/zip',
      length: download.length,
      disposition: `attachment; filename="${download.fileName}"`,
    });
  }
}
