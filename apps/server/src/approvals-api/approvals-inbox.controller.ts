/**
 * File de validation (MP-07, ECR-ADM-08 ; UC-ADM-15 ; 08-api-events/01-architecture-api.md §4.10) :
 * `GET /approvals/inbox`, les demandes `PENDING` que le lecteur peut décider, de la plus ancienne à la
 * plus récente. Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit d'accès : `approvals.request.read` (RC-01, même garde que les commandes `approvals.request.*`).
 * Ce droit ne donne pas celui de décider : chaque demande n'est rendue qu'au détenteur de la permission
 * d'approbation de sa politique, dans sa portée (`approvalInboxPage`, la règle de la décision). La
 * Direction voit aussi ses propres demandes, qu'elle seule peut valider explicitement (INV-ADM-02).
 *
 * Filtres : `types` (liste de types d'opération séparés par des virgules, liste blanche
 * `OPERATION_TYPES`), `cursor` (identifiant de la dernière demande d'une page), `limit` (50 par défaut,
 * 200 au plus). Une page peut être plus courte que `limit` : suivre `next_cursor` jusqu'à `null`.
 *
 * Chaque demande dit si l'approbation attend encore une pièce (`attachmentsPending`, BR-ADM-020 : pièce
 * requise non reçue, ou photo d'une mortalité, AV-107) ; les règles de décision par type sont dans
 * `@gic/domain` (`approvalDecisionSpec`), partagées avec l'écran. `unavailableOptions` : choix du type
 * que le gestionnaire refuserait pour cette demande (MP-11 : imputation `CARRIER` d'un écart de remise
 * sans porteur connu, AV-174).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { isTransferCarrierKnown, type Clock, type IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { userFullNames } from '../modules/identity/application/public/index.js';
import {
  OPERATION_TYPES,
  approvalInboxPage,
  canSelfApproveAt,
  type ApprovalInboxItem,
} from '../modules/approvals/application/public/index.js';
import {
  attachmentsOfOwners,
  requiredAttachmentsSatisfied,
} from '../modules/attachments/application/public/index.js';
import { lossesAwaitingPhoto } from '../modules/inventory/application/public/index.js';
import { findCashTransfer } from '../modules/finance/application/public/index.js';
import { parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const REQUEST_READ = 'approvals.request.read';
const INBOX_DEFAULT_LIMIT = 50;
const INBOX_MAX_LIMIT = 200;

const inboxQuerySchema = z.object({
  types: z.string().trim().min(1).max(1000).optional(),
  cursor: uuidParam.optional(),
  limit: z.coerce.number().int().positive().max(INBOX_MAX_LIMIT).optional(),
});
/** `types` : liste blanche des types d'opération, sans doublon. */
const typesSchema = z.array(z.enum(OPERATION_TYPES)).min(1);

@Controller('api/v1')
export class ApprovalsInboxController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, REQUEST_READ);
  }

  @Get('approvals/inbox')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(REQUEST_READ)
  async inbox(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(inboxQuerySchema, rawQuery);
    const types =
      query.types === undefined
        ? undefined
        : parseOrThrow(typesSchema, [
            ...new Set(query.types.split(',').map((type) => type.trim())),
          ]);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'APPROVAL_REQUEST' });
    const userId = request.auth!.sub;
    const page = await approvalInboxPage(this.db, {
      userId,
      at: now,
      ...(types !== undefined ? { operationTypes: types } : {}),
      ...(query.cursor !== undefined ? { afterId: query.cursor } : {}),
      limit: query.limit ?? INBOX_DEFAULT_LIMIT,
      includeOwnRequests: await canSelfApproveAt(this.db, userId, now),
    });
    return { requests: await this.present(page.items), next_cursor: page.nextCursor };
  }

  /** Nom du demandeur et pièce attendue. */
  private async present(items: readonly ApprovalInboxItem[]) {
    const names = await userFullNames(this.db, [...new Set(items.map((item) => item.requestedBy))]);
    const photoWaiting = await lossesAwaitingPhoto(
      this.db,
      items
        .filter((item) => item.operationType === 'MORTALITY' && item.subjectType === 'STOCK_LOSS')
        .map((item) => item.subjectId),
    );
    // Pièces du document décidé (MP-10, AV-286) : le valideur les voit par `GET /attachments/{id}/content`.
    const owned = await attachmentsOfOwners(
      this.db,
      items.map((item) => ({ ownerType: item.subjectType, ownerId: item.subjectId })),
    );
    const presented = [];
    for (const item of items) {
      const unavailableOptions: string[] = [];
      if (
        item.operationType === 'CASH_TRANSFER_DISCREPANCY' &&
        item.subjectType === 'CASH_TRANSFER'
      ) {
        const transfer = await findCashTransfer(this.db, item.subjectId);
        if (transfer && !isTransferCarrierKnown(transfer)) unavailableOptions.push('CARRIER');
      }
      const attachmentsPending =
        !(await requiredAttachmentsSatisfied(this.db, {
          requiredIds: item.requiredAttachmentIds,
          ownerType: item.subjectType,
          ownerId: item.subjectId,
        })) ||
        (item.operationType === 'MORTALITY' && photoWaiting.has(item.subjectId));
      presented.push({
        id: item.id,
        operationType: item.operationType,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        subjectSummary: item.subjectSummary,
        amountXaf: item.amountXaf,
        amountMasked: item.amountMasked,
        siteId: item.siteId,
        zoneId: item.zoneId,
        requestedBy: item.requestedBy,
        requestedByName: names.get(item.requestedBy) ?? null,
        requestedAt: item.requestedAt.toISOString(),
        attachmentsPending,
        attachments: (owned.get(`${item.subjectType}:${item.subjectId}`) ?? []).map(
          (attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            uploadStatus: attachment.uploadStatus,
          }),
        ),
        selfRequest: item.selfRequest,
        unavailableOptions,
      });
    }
    return presented;
  }
}
