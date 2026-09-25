/**
 * Endpoints de fichiers (08-api-events/01-architecture-api.md §4.10 ; ADR-012 point 3) :
 * transfert d'octets bruts par morceaux, **hors** du pipeline de commande — une session
 * d'upload n'est pas un `command_type` JSON. Couche transport (comme `sync/`, `organization-
 * api/`) : compose `identity` (garde) et `attachments`/`platform` directement, sans passer
 * par un module métier propriétaire.
 *
 * `GET /attachments/{id}/url` (URL signée) : différé — aucun consommateur en P0 (personne
 * n'affiche encore une pièce jointe), et sa forme dépend du fournisseur de stockage réel
 * (AV-091, encore ouvert). `POST .../upload-session`, `PUT .../content`, `HEAD .../content`
 * suffisent à démontrer NFR-08 (reprise après coupure).
 */
import {
  Body,
  Controller,
  Head,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Headers as HttpHeaders,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { SelfScoped } from '../platform/http/authorization.decorators.js';
import { toBin, fromBin } from '../platform/kysely/uuid-columns.js';
import { sha256HexOfBuffer } from '../platform/hash.js';
import { recordAudit } from '../audit/record-audit.js';
import { jsonValue } from '../platform/kysely/json-value.js';
import { CHUNK_STORAGE } from '../platform/storage/chunk-storage.provider.js';
import { ChunkOffsetMismatchError, type ChunkStorage } from '../platform/storage/chunk-storage.js';

/** ADR-012 point 3 : « morceaux de 256 Ko ». Communiqué au client, pas imposé côté serveur
 * (seul l'ordre strictement séquentiel est vérifié — un client peut envoyer plus petit). */
const RECOMMENDED_CHUNK_SIZE_BYTES = 256 * 1024;

interface ParsedContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

function parseContentRange(header: string | undefined): ParsedContentRange | undefined {
  if (!header) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startStr, endStr, totalStr] = match;
  const start = Number(startStr);
  const end = Number(endStr);
  const total = Number(totalStr);
  if (end < start) return undefined;
  return { start, end, total };
}

@Controller('api/v1/attachments')
export class AttachmentUploadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CHUNK_STORAGE) private readonly storage: ChunkStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Post(':id/upload-session')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async openSession(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ uploaded_bytes: number; chunk_size: number }> {
    const row = await this.loadUploadableAttachment(id, request.auth!.sub);
    return { uploaded_bytes: row.uploaded_bytes, chunk_size: RECOMMENDED_CHUNK_SIZE_BYTES };
  }

  @Head(':id/content')
  @UseGuards(AuthGuard)
  @SelfScoped()
  async headContent(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    const row = await this.loadUploadableAttachment(id, request.auth!.sub);
    reply.header('X-Uploaded-Bytes', String(row.uploaded_bytes)).status(200).send();
  }

  @Put(':id/content')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async putContent(
    @Param('id') id: string,
    @HttpHeaders('content-range') contentRangeHeader: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ uploaded_bytes: number; upload_status: string }> {
    const row = await this.loadUploadableAttachment(id, request.auth!.sub);
    const range = parseContentRange(contentRangeHeader);
    if (!range) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'En-tête Content-Range invalide ou absent (attendu : bytes {début}-{fin}/{total}).',
      );
    }
    if (range.total !== row.size_bytes) {
      throw new ApiError(
        400,
        'ATTACHMENT_SIZE',
        'Taille totale du Content-Range incohérente avec la taille déclarée à l’enregistrement.',
      );
    }
    if (!Buffer.isBuffer(body) || body.length !== range.end - range.start + 1) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Taille du morceau reçu incohérente avec Content-Range.',
      );
    }

    let newTotal: number;
    try {
      newTotal = await this.storage.appendChunk(row.storage_key!, range.start, body);
    } catch (error) {
      if (error instanceof ChunkOffsetMismatchError) {
        throw new ApiError(
          409,
          'UPLOAD_OFFSET_MISMATCH',
          `Décalage attendu : ${error.expectedOffset} octet(s) déjà reçus.`,
          { uploaded_bytes: error.expectedOffset },
        );
      }
      throw error;
    }

    if (newTotal < row.size_bytes) {
      await this.db
        .updateTable('attachments_attachments')
        .set({ uploaded_bytes: newTotal })
        .where('id', '=', toBin(id))
        .execute();
      return { uploaded_bytes: newTotal, upload_status: 'PENDING_UPLOAD' };
    }

    // Dernier morceau : empreinte vérifiée sur le fichier assemblé (SM-ATTACHMENT).
    const full = await this.storage.readAll(row.storage_key!);
    const finalStatus = sha256HexOfBuffer(full) === row.sha256 ? 'AVAILABLE' : 'QUARANTINED';
    await this.recordUploadCompletion(id, newTotal, finalStatus, request.auth!.sub);
    return { uploaded_bytes: newTotal, upload_status: finalStatus };
  }

  private async loadUploadableAttachment(
    id: string,
    authenticatedUserId: string,
  ): Promise<{
    readonly storage_key: string | null;
    readonly size_bytes: number;
    readonly sha256: string;
    readonly uploaded_bytes: number;
  }> {
    const row = await this.db
      .selectFrom('attachments_attachments')
      .select([
        'storage_key',
        'size_bytes',
        'sha256',
        'uploaded_bytes',
        'upload_status',
        'created_by',
      ])
      .where('id', '=', toBin(id))
      .executeTakeFirst();
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Pièce jointe introuvable.');
    if (fromBin(row.created_by) !== authenticatedUserId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        "Seul l'auteur peut téléverser le contenu de cette pièce.",
      );
    }
    if (row.upload_status !== 'PENDING_UPLOAD' && row.upload_status !== 'MISSING') {
      throw new ApiError(
        409,
        'CONFLICT',
        `Cette pièce jointe n'accepte plus de téléversement (statut ${row.upload_status}).`,
      );
    }
    return row;
  }

  /** `AttachmentUploaded`/`AttachmentUploadFailed` (D01 §10) : audit + événement + flux de
   * changements, dans une seule transaction — même triplet que le pipeline de commande. */
  private async recordUploadCompletion(
    attachmentId: string,
    uploadedBytes: number,
    status: 'AVAILABLE' | 'QUARANTINED',
    actorUserId: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('attachments_attachments')
        .set({ uploaded_bytes: uploadedBytes, upload_status: status })
        .where('id', '=', toBin(attachmentId))
        .execute();

      await recordAudit(
        trx,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId,
          actorRoles: [],
          action:
            status === 'AVAILABLE'
              ? 'attachments.attachment.upload_completed'
              : 'attachments.attachment.upload_quarantined',
          entityType: 'ATTACHMENT',
          entityId: attachmentId,
          result: status === 'AVAILABLE' ? 'SUCCESS' : 'QUARANTINED',
        },
      );

      await trx
        .insertInto('platform_domain_events')
        .values({
          event_id: toBin(this.idGenerator.newId()),
          event_type: status === 'AVAILABLE' ? 'AttachmentUploaded' : 'AttachmentUploadFailed',
          producer_module: 'attachments',
          aggregate_type: 'ATTACHMENT',
          aggregate_id: toBin(attachmentId),
          occurred_at: now,
          payload: jsonValue({ upload_status: status }),
          command_id: null,
        })
        .execute();

      await trx
        .insertInto('sync_change_feed')
        .values({
          dataset: 'attachment',
          entity_type: 'ATTACHMENT',
          entity_id: toBin(attachmentId),
          change_type: 'UPSERT',
          scope_type: 'GLOBAL',
          scope_id: null,
          row_version: 1,
        })
        .execute();
    });
  }
}
