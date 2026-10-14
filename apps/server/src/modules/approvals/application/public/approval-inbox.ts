/**
 * File de validation (MP-07, ECR-ADM-08 ; UC-ADM-15, ADR-018) : demandes `PENDING` qu'un utilisateur
 * peut décider à l'instant de la lecture, de la plus ancienne à la plus récente. Lecture seule : la
 * décision passe par `approvals.request.approve` / `.reject` (ou par la façade du module propriétaire).
 *
 * Une demande attend la personne qui détient la permission d'approbation de la politique figée sur la
 * demande, **dans sa portée** : même évaluation que la décision (`decideApprovalRequest` :
 * `evaluateAccess` sur le demandeur, le site et la zone de la demande, BR-ADM-018, RC-04). Pré-filtre
 * sûr en SQL par permission (`listConfinementAt` : sites ou demandeurs), puis évaluation exacte demande
 * par demande, jusqu'à `limit` demandes ou `MAX_SCANS` lectures ; `nextCursor` reprend après la dernière
 * demande lue ou retenue (une page peut être plus courte que `limit`).
 *
 * Nul ne décide sa propre demande, sauf la Direction avec l'auto-validation explicite (INV-ADM-02,
 * BR-ADM-017, AV-010) : ses propres demandes ne sont lues que si `includeOwnRequests`.
 *
 * Montant et résumé : un montant au coût (valeur de stock, `amountIsCost`) n'est rendu qu'avec
 * `inventory.valuation.read` (RC-05) ; le résumé d'un écart d'inventaire, qui le porte, est alors
 * remplacé par un résumé neutre.
 */
import type { Kysely, Transaction } from 'kysely';
import { approvalDecisionSpec, canSelfApprove } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  activeRoleCodesAt,
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

const VALUATION_READ = 'inventory.valuation.read';
/** Taille d'une lecture de demandes candidates. */
const PAGE = 200;
/** Lectures successives au plus pour remplir une page filtrée par la portée. */
const MAX_SCANS = 10;
/** Résumé neutre d'un écart d'inventaire dont la valeur est masquée (RC-05). */
const COUNT_SUMMARY_MASKED = 'Écart d’inventaire (valeur masquée)';

export interface ApprovalInboxItem {
  readonly id: string;
  readonly operationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectSummary: string;
  /** `null` : sans montant, ou montant au coût masqué (`amountMasked`). */
  readonly amountXaf: number | null;
  readonly amountMasked: boolean;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly requiredAttachmentIds: readonly string[];
  /** Demande de l'utilisateur lui-même (Direction seulement, auto-validation explicite). */
  readonly selfRequest: boolean;
}

export interface ApprovalInboxPage {
  readonly items: readonly ApprovalInboxItem[];
  readonly nextCursor: string | null;
}

/** La Direction valide sa propre demande, avec le marqueur explicite (INV-ADM-02). */
export async function canSelfApproveAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<boolean> {
  return canSelfApprove(await activeRoleCodesAt(executor, userId, at));
}

interface PermissionFilter {
  readonly permission: string;
  /** `null` : toute l'entreprise. */
  readonly siteIds: readonly string[] | null;
  readonly ownerUserIds: readonly string[] | null;
}

export async function approvalInboxPage(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly at: Date;
    /** Types d'opération retenus ; absent : tous. */
    readonly operationTypes?: readonly string[];
    /** Reprise après cette demande (curseur d'une page précédente). */
    readonly afterId?: string;
    readonly limit: number;
    readonly includeOwnRequests: boolean;
  },
): Promise<ApprovalInboxPage> {
  const user = toBin(input.userId);
  const types = input.operationTypes;
  if (types !== undefined && types.length === 0) return { items: [], nextCursor: null };

  const permissionRows = await executor
    .selectFrom('approvals_approval_requests as r')
    .innerJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
    .select('p.approver_permission as approver_permission')
    .distinct()
    .where('r.status', '=', 'PENDING')
    .$if(!input.includeOwnRequests, (qb) => qb.where('r.requested_by', '<>', user))
    .$if(types !== undefined, (qb) => qb.where('r.operation_type', 'in', [...types!]))
    .execute();
  const filters: PermissionFilter[] = [];
  for (const { approver_permission: permission } of permissionRows) {
    if (permission === null) continue;
    if (!(await hasPermissionAt(executor, user, permission, input.at))) continue;
    const confinement = await listConfinementAt(executor, input.userId, permission, input.at);
    if (confinement === null) {
      filters.push({ permission, siteIds: null, ownerUserIds: null });
    } else if (confinement.siteIds.length > 0 || confinement.ownerUserIds.length > 0) {
      filters.push({
        permission,
        siteIds: confinement.siteIds,
        ownerUserIds: confinement.ownerUserIds,
      });
    }
  }
  if (filters.length === 0) return { items: [], nextCursor: null };

  let after: { readonly requestedAt: Date; readonly id: Buffer } | undefined;
  if (input.afterId !== undefined) {
    const anchor = await executor
      .selectFrom('approvals_approval_requests')
      .select(['id', 'requested_at'])
      .where('id', '=', toBin(input.afterId))
      .executeTakeFirst();
    // Curseur inconnu : rien après lui (jamais une relecture du début).
    if (!anchor) return { items: [], nextCursor: null };
    after = { requestedAt: anchor.requested_at, id: anchor.id };
  }

  const canReadValuation = await hasPermissionAt(executor, user, VALUATION_READ, input.at);
  const items: ApprovalInboxItem[] = [];
  let nextCursor: string | null = null;
  for (let scan = 0; scan < MAX_SCANS; scan++) {
    const rows = await executor
      .selectFrom('approvals_approval_requests as r')
      .innerJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
      .select([
        'r.id as id',
        'r.operation_type as operation_type',
        'r.subject_type as subject_type',
        'r.subject_id as subject_id',
        'r.subject_summary as subject_summary',
        'r.amount_xaf as amount_xaf',
        'r.site_id as site_id',
        'r.zone_id as zone_id',
        'r.requested_by as requested_by',
        'r.requested_at as requested_at',
        'r.required_attachment_ids as required_attachment_ids',
        'p.approver_permission as approver_permission',
      ])
      .where('r.status', '=', 'PENDING')
      .$if(!input.includeOwnRequests, (qb) => qb.where('r.requested_by', '<>', user))
      .$if(types !== undefined, (qb) => qb.where('r.operation_type', 'in', [...types!]))
      .where((eb) =>
        eb.or(
          filters.map((filter) =>
            filter.siteIds === null
              ? eb('p.approver_permission', '=', filter.permission)
              : eb.and([
                  eb('p.approver_permission', '=', filter.permission),
                  eb.or([
                    ...(filter.siteIds.length > 0
                      ? [
                          eb(
                            'r.site_id',
                            'in',
                            filter.siteIds.map((id) => toBin(id)),
                          ),
                        ]
                      : []),
                    ...(filter.ownerUserIds!.length > 0
                      ? [
                          eb(
                            'r.requested_by',
                            'in',
                            filter.ownerUserIds!.map((id) => toBin(id)),
                          ),
                        ]
                      : []),
                  ]),
                ]),
          ),
        ),
      )
      .$if(after !== undefined, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('r.requested_at', '>', after!.requestedAt),
            eb.and([eb('r.requested_at', '=', after!.requestedAt), eb('r.id', '>', after!.id)]),
          ]),
        ),
      )
      .orderBy('r.requested_at', 'asc')
      .orderBy('r.id', 'asc')
      .limit(PAGE)
      .execute();

    let full = false;
    for (const [index, row] of rows.entries()) {
      const siteId = fromBinOrNull(row.site_id);
      const zoneId = fromBinOrNull(row.zone_id);
      const resource: ResourceLocator = {
        ownerUserId: fromBin(row.requested_by),
        ...(siteId !== null ? { siteId } : {}),
        ...(zoneId !== null ? { zoneId } : {}),
      };
      const access = await evaluateAccess(executor, {
        userId: input.userId,
        permissionCode: row.approver_permission!,
        occurredAt: input.at,
        resource,
      });
      if (!access.allowed) continue;
      const masked =
        approvalDecisionSpec(row.operation_type).amountIsCost === true && !canReadValuation;
      const amount = row.amount_xaf === null ? null : Number(row.amount_xaf);
      items.push({
        id: fromBin(row.id),
        operationType: row.operation_type,
        subjectType: row.subject_type,
        subjectId: fromBin(row.subject_id),
        subjectSummary:
          masked &&
          (row.operation_type === 'INVENTORY_ADJUSTMENT' ||
            row.operation_type === 'ANIMAL_COUNT_ADJUSTMENT')
            ? COUNT_SUMMARY_MASKED
            : row.subject_summary,
        amountXaf: masked ? null : amount,
        amountMasked: masked && amount !== null,
        siteId,
        zoneId,
        requestedBy: fromBin(row.requested_by),
        requestedAt: row.requested_at,
        requiredAttachmentIds: Array.isArray(row.required_attachment_ids)
          ? row.required_attachment_ids.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
        selfRequest: fromBin(row.requested_by) === input.userId,
      });
      if (items.length === input.limit) {
        full = true;
        const hasMoreInPage = index < rows.length - 1 || rows.length === PAGE;
        nextCursor = hasMoreInPage ? items.at(-1)!.id : null;
        break;
      }
    }
    if (full) break;
    if (rows.length < PAGE) {
      nextCursor = null;
      break;
    }
    const last = rows[rows.length - 1]!;
    after = { requestedAt: last.requested_at, id: last.id };
    // Lectures épuisées sans remplir la page : la suite reprend après la dernière demande lue.
    nextCursor = fromBin(last.id);
  }
  return { items, nextCursor };
}

/**
 * L'utilisateur peut-il décider une demande en attente portant sur ce document (même portée que la
 * file de validation : permission de décision sur le demandeur, le site et la zone, BR-ADM-018) ?
 * Sert à montrer au valideur la pièce jointe du document qu'il décide (MP-10, AV-296), même sans
 * droit de lecture sur le document lui-même.
 */
export async function canDecidePendingApprovalOf(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly at: Date;
  },
): Promise<boolean> {
  const rows = await executor
    .selectFrom('approvals_approval_requests as r')
    .innerJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
    .select([
      'r.site_id as site_id',
      'r.zone_id as zone_id',
      'r.requested_by as requested_by',
      'p.approver_permission as approver_permission',
    ])
    .where('r.status', '=', 'PENDING')
    .where('r.subject_type', '=', input.subjectType)
    .where('r.subject_id', '=', toBin(input.subjectId))
    .execute();
  for (const row of rows) {
    if (!row.approver_permission) continue;
    const siteId = fromBinOrNull(row.site_id);
    const zoneId = fromBinOrNull(row.zone_id);
    const access = await evaluateAccess(executor, {
      userId: input.userId,
      permissionCode: row.approver_permission,
      occurredAt: input.at,
      resource: {
        ownerUserId: fromBin(row.requested_by),
        ...(siteId !== null ? { siteId } : {}),
        ...(zoneId !== null ? { zoneId } : {}),
      },
    });
    if (access.allowed) return true;
  }
  return false;
}
