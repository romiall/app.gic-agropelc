/**
 * Lecture des politiques de contrôle actives (BR-ADM-016 : « en vigueur à `occurred_at` »).
 * Plusieurs politiques peuvent être actives simultanément pour un même `operation_type`
 * (différenciées par `condition` — catégorie, seuils, site/zone, D01 dictionnaire) :
 * l'appelant choisit celle qui s'applique à son opération précise, ce module ne le fait pas
 * (`condition` n'est jamais interrogée comme donnée métier ici).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { OperationType } from '../commands/operation-types.js';

export interface ActiveControlPolicy {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly operationType: string;
  readonly condition: unknown;
  readonly requiresPhoto: boolean;
  readonly requiresComment: boolean;
  readonly requiresApproval: boolean;
  readonly approverPermission: string | null;
  readonly approverScope: string | null;
}

/** Une politique dont une demande peut être décidée : elle exige une validation et nomme son approbateur. */
export function isDecidablePolicy(policy: ActiveControlPolicy): boolean {
  return policy.requiresApproval && policy.approverPermission !== null;
}

export async function currentPolicies(
  executor: Kysely<DB> | Transaction<DB>,
  operationType: OperationType,
  at: Date,
): Promise<readonly ActiveControlPolicy[]> {
  const rows = await executor
    .selectFrom('approvals_control_policies')
    .selectAll()
    .where('operation_type', '=', operationType)
    .where('status', '=', 'ACTIVE')
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    // Ordre déterministe (P7-02) : la politique entrée en vigueur le plus récemment d'abord —
    // les appelants qui retiennent la première politique applicable prennent la plus récente.
    .orderBy('valid_from', 'desc')
    .orderBy('version', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    version: row.version,
    operationType: row.operation_type,
    condition: row.condition,
    requiresPhoto: Boolean(row.requires_photo),
    requiresComment: Boolean(row.requires_comment),
    requiresApproval: Boolean(row.requires_approval),
    approverPermission: row.approver_permission,
    approverScope: row.approver_scope,
  }));
}

/**
 * Politique qui s'applique à un fait constaté à `at` : la plus récente **qui peut se décider**
 * (`isDecidablePolicy` ; une version révisée sans approbateur n'est pas retenue). Hors ligne,
 * `offlineFallbackAt` (la réception du fait) sert de repli quand aucune politique n'était en vigueur à
 * `at` : une révision de la politique entre la réalité et l'envoi ne rend pas un fait accompli inacceptable
 * (BR-SYN-007 ; `approvals.policy.set` retire l'ancienne version à la date de la révision).
 */
export async function decidablePolicyFor(
  executor: Kysely<DB> | Transaction<DB>,
  operationType: OperationType,
  at: Date,
  offlineFallbackAt?: Date,
): Promise<ActiveControlPolicy | undefined> {
  const atFact = (await currentPolicies(executor, operationType, at)).find(isDecidablePolicy);
  if (atFact !== undefined || offlineFallbackAt === undefined) return atFact;
  return (await currentPolicies(executor, operationType, offlineFallbackAt)).find(
    isDecidablePolicy,
  );
}
