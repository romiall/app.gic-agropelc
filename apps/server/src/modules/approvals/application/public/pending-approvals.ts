/**
 * Validations qui attendent la décision d'un utilisateur (accueil par rôle, ADR-030 ; ECR-ADM-08).
 * Une demande `PENDING` attend la personne qui peut la décider, à l'instant de la lecture : la
 * permission d'approbation de la politique figée sur la demande, **dans sa portée** — la même
 * évaluation que la décision (`decideApprovalRequest` : `evaluateAccess` sur le demandeur, le site et
 * la zone de la demande, BR-ADM-018, RC-04) ; nul ne valide sa propre demande (AV-010). Sans cela,
 * l'accueil annoncerait des validations hors périmètre que la décision refuserait
 * (`APPROVER_NOT_ALLOWED`), et en montrerait le résumé.
 *
 * Lecture par permission d'approbation : pré-filtre sûr de la portée en SQL (`listConfinementAt` :
 * sites ou demandeurs), puis évaluation exacte demande par demande, de la plus ancienne à la plus
 * récente, jusqu'à `limit` demandes. Lecture seule : la décision passe par
 * `approvals.request.approve` / `.reject`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PendingApproval {
  readonly id: string;
  readonly operationType: string;
  readonly subjectSummary: string;
  readonly amountXaf: number | null;
  readonly requestedAt: Date;
}

/** Taille d'une page de demandes candidates d'une permission. */
const PAGE = 200;

export async function pendingApprovalsFor(
  executor: Executor,
  userId: string,
  at: Date,
  limit = 50,
): Promise<readonly PendingApproval[]> {
  const permissionRows = await executor
    .selectFrom('approvals_approval_requests as r')
    .innerJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
    .select('p.approver_permission as approver_permission')
    .distinct()
    .where('r.status', '=', 'PENDING')
    .where('r.requested_by', '<>', toBin(userId))
    .execute();

  const mine: (PendingApproval & { readonly order: string })[] = [];
  for (const { approver_permission: permission } of permissionRows) {
    if (permission === null) continue;
    if (!(await hasPermissionAt(executor, toBin(userId), permission, at))) continue;
    const confinement = await listConfinementAt(executor, userId, permission, at);
    if (
      confinement !== null &&
      confinement.siteIds.length === 0 &&
      confinement.ownerUserIds.length === 0
    ) {
      continue;
    }
    let kept = 0;
    let after: { readonly requestedAt: Date; readonly id: Buffer } | undefined;
    while (kept < limit) {
      const rows = await executor
        .selectFrom('approvals_approval_requests as r')
        .innerJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
        .select([
          'r.id as id',
          'r.operation_type as operation_type',
          'r.subject_summary as subject_summary',
          'r.amount_xaf as amount_xaf',
          'r.requested_at as requested_at',
          'r.requested_by as requested_by',
          'r.site_id as site_id',
          'r.zone_id as zone_id',
        ])
        .where('r.status', '=', 'PENDING')
        .where('r.requested_by', '<>', toBin(userId))
        .where('p.approver_permission', '=', permission)
        .$if(confinement !== null, (qb) =>
          qb.where((eb) =>
            eb.or([
              ...(confinement!.siteIds.length > 0
                ? [
                    eb(
                      'r.site_id',
                      'in',
                      confinement!.siteIds.map((id) => toBin(id)),
                    ),
                  ]
                : []),
              ...(confinement!.ownerUserIds.length > 0
                ? [
                    eb(
                      'r.requested_by',
                      'in',
                      confinement!.ownerUserIds.map((id) => toBin(id)),
                    ),
                  ]
                : []),
            ]),
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
      for (const row of rows) {
        const siteId = fromBinOrNull(row.site_id);
        const zoneId = fromBinOrNull(row.zone_id);
        const resource: ResourceLocator = {
          ownerUserId: fromBin(row.requested_by),
          ...(siteId !== null ? { siteId } : {}),
          ...(zoneId !== null ? { zoneId } : {}),
        };
        const access = await evaluateAccess(executor, {
          userId,
          permissionCode: permission,
          occurredAt: at,
          resource,
        });
        if (!access.allowed) continue;
        mine.push({
          id: fromBin(row.id),
          operationType: row.operation_type,
          subjectSummary: row.subject_summary,
          amountXaf: row.amount_xaf === null ? null : Number(row.amount_xaf),
          requestedAt: row.requested_at,
          order: `${row.requested_at.toISOString()}|${fromBin(row.id)}`,
        });
        kept += 1;
        if (kept >= limit) break;
      }
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1]!;
      after = { requestedAt: last.requested_at, id: last.id };
    }
  }
  return mine
    .sort((a, b) => a.order.localeCompare(b.order))
    .slice(0, limit)
    .map(({ order: _order, ...approval }) => approval);
}
