/**
 * Endpoints de fichiers (08-api-events/01-architecture-api.md §4.10 ; ADR-012 point 3, ADR-046) :
 * transfert d'octets bruts par morceaux, **hors** du pipeline de commande — une session
 * d'upload n'est pas un `command_type` JSON. Couche transport (comme `sync/`, `organization-
 * api/`) : compose `identity` (garde), `attachments`/`platform`, et les API publiques des modules
 * propriétaires des documents (portée de lecture, régularisation).
 *
 * MP-10 :
 * - fin de l'envoi : empreinte **et** signature du fichier (premiers octets conformes au type
 *   déclaré, 02-securite §6) ; sinon `QUARANTINED` ; la photo du bon de livraison d'une réception
 *   clôt sa « photo manquante » (`regularizeReceiptPhoto`, AV-287) ;
 * - `GET /attachments/{id}/content` : lecture authentifiée de la pièce (AV-296), sans URL signée
 *   (le stockage objet reste à choisir, AV-091) — par son auteur, par qui lit le document
 *   propriétaire dans sa portée, ou par qui peut décider une validation en attente sur lui.
 */
import {
  Body,
  Controller,
  Get,
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
import { ATTACHMENT_CHUNK_SIZE_BYTES } from '@gic/contracts';
import { regularizeReceiptPhoto } from '../modules/procurement/application/public/index.js';
import { canViewAttachment } from './attachment-access.js';
import { recordDenied } from '../audit/record-denied.js';

/** Premiers octets attendus de chaque type accepté (02-securite §6 : type vérifié sur le contenu). */
export function matchesSignature(content: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return (
        content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      );
    case 'image/webp':
      return (
        content.length >= 12 &&
        content.subarray(0, 4).toString('latin1') === 'RIFF' &&
        content.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    case 'application/pdf':
      return content.length >= 5 && content.subarray(0, 5).toString('latin1') === '%PDF-';
    default:
      return false;
  }
}

interface AttachmentRow {
  readonly storage_key: string | null;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly uploaded_bytes: number;
  readonly upload_status: string;
  readonly created_by: Buffer;
  readonly mime_type: string;
  readonly owner_type: string;
  readonly owner_id: Buffer;
  readonly kind: string;
}

/** ADR-012 point 3 : « morceaux de 256 Ko ». Communiqué au client, pas imposé côté serveur
 * (seul l'ordre strictement séquentiel est vérifié — un client peut envoyer plus petit). */
const RECOMMENDED_CHUNK_SIZE_BYTES = ATTACHMENT_CHUNK_SIZE_BYTES;

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
  // Un morceau au-delà de la taille annoncée corromprait le fichier assemblé (MP-10).
  if (end < start || end >= total) return undefined;
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

    // Dernier morceau : empreinte et signature vérifiées sur le fichier assemblé (SM-ATTACHMENT).
    const full = await this.storage.readAll(row.storage_key!);
    const finalStatus =
      sha256HexOfBuffer(full) === row.sha256 && matchesSignature(full, row.mime_type)
        ? 'AVAILABLE'
        : 'QUARANTINED';
    await this.recordUploadCompletion(id, newTotal, finalStatus, request.auth!.sub, row);
    return { uploaded_bytes: newTotal, upload_status: finalStatus };
  }

  /**
   * Contenu d'une pièce reçue (MP-10, AV-296) : son auteur, qui lit le document propriétaire dans sa
   * portée (réception : `procurement.order.read` sur le site ; perte : `inventory.loss.read` sur le
   * site ou la zone, ou sa propre déclaration, AV-094), ou qui peut décider une validation en attente
   * sur ce document. Refus audité ; jamais mis en cache.
   */
  @Get(':id/content')
  @UseGuards(AuthGuard)
  @SelfScoped()
  async getContent(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const userId = request.auth!.sub;
    const now = this.clock.now();
    const row = await this.loadAttachment(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Pièce jointe introuvable.');
    if (
      !(await canViewAttachment(
        this.db,
        {
          createdBy: fromBin(row.created_by),
          ownerType: row.owner_type,
          ownerId: fromBin(row.owner_id),
        },
        userId,
        now,
      ))
    ) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: userId,
          actorRoles: [],
          deviceId: request.auth!.device_id,
          action: 'access.denied',
          entityType: 'ATTACHMENT',
          entityId: id,
          reason: `Hors portée du document ${row.owner_type}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Cette pièce jointe n’est pas dans votre périmètre.');
    }
    if (row.upload_status !== 'AVAILABLE') {
      throw new ApiError(
        409,
        'ATTACHMENT_NOT_AVAILABLE',
        'Pièce jointe pas encore reçue ou refusée.',
        { upload_status: row.upload_status },
      );
    }
    const content = await this.storage.readAll(row.storage_key!);
    reply
      .header('Content-Type', row.mime_type)
      .header('Content-Length', String(content.length))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline');
    return content;
  }

  private async loadAttachment(id: string): Promise<AttachmentRow | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return this.db
      .selectFrom('attachments_attachments')
      .select([
        'storage_key',
        'size_bytes',
        'sha256',
        'uploaded_bytes',
        'upload_status',
        'created_by',
        'mime_type',
        'owner_type',
        'owner_id',
        'kind',
      ])
      .where('id', '=', toBin(id))
      .executeTakeFirst();
  }

  private async loadUploadableAttachment(
    id: string,
    authenticatedUserId: string,
  ): Promise<AttachmentRow> {
    const row = await this.loadAttachment(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Pièce jointe introuvable.');
    if (fromBin(row.created_by) !== authenticatedUserId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        "Seul l'auteur peut téléverser le contenu de cette pièce.",
      );
    }
    if (row.upload_status !== 'PENDING_UPLOAD' && row.upload_status !== 'MISSING') {
      // Statut rendu à l'appareil (MP-10) : déjà reçue (`AVAILABLE`) ou à reprendre (`QUARANTINED`).
      throw new ApiError(
        409,
        'CONFLICT',
        `Cette pièce jointe n'accepte plus de téléversement (statut ${row.upload_status}).`,
        { upload_status: row.upload_status },
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
    attachment: Pick<AttachmentRow, 'owner_type' | 'owner_id' | 'kind'>,
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('attachments_attachments')
        .set({ uploaded_bytes: uploadedBytes, upload_status: status })
        .where('id', '=', toBin(attachmentId))
        .execute();

      // Photo du bon de livraison reçue : la « photo manquante » de la réception est régularisée
      // (AV-287 ; conflits au rang N11, avant la tête d'audit N14, ADR-038).
      const regularized =
        status === 'AVAILABLE' &&
        attachment.owner_type === 'GOODS_RECEIPT' &&
        attachment.kind === 'DELIVERY_NOTE'
          ? await regularizeReceiptPhoto(trx, {
              receiptId: fromBin(attachment.owner_id),
              attachmentId,
              resolvedBy: actorUserId,
              at: now,
            })
          : 0;

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
          ...(regularized > 0 ? { after: { regularizedConflicts: regularized } } : {}),
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
