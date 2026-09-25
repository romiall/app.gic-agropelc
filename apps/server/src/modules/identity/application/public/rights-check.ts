/**
 * RC-01 (07-security-rbac/01-rbac.md §4) : droits évalués **à `occurred_at`** — affectation
 * active à cet instant (`valid_from` ≤ occurred_at < coalesce(revoked_at, valid_to, ∞)) dont
 * le rôle accorde la permission.
 *
 * `hasPermissionAt` — existence seule, sans intersection de portée (RC-01 minimal, tel que
 * P0-06 l'a introduit et documenté comme signature stable) : le pipeline de commande
 * (RC-01, avant même de connaître la ressource visée) et `GET /audit` s'en contentent.
 *
 * `evaluateAccess` (P0-10) — évaluation complète des portées (RC-01 à RC-04, RC-10) :
 * intersection « portée maximale ∩ périmètre de l'affectation » (`scope-evaluation.ts`),
 * pour un gestionnaire qui connaît déjà la ressource précise visée par la commande (RC-04 :
 * la portée de l'**opération**, jamais celle du demandeur — c'est `resource` que l'appelant
 * fournit, jamais dérivé ici). RC-02 (appareil actif), RC-03 (séparation des tâches),
 * RC-08 (application toujours côté serveur) et RC-10 (un appareil partagé n'étend aucun
 * droit — l'évaluation ne porte que sur `userId`, jamais sur l'appareil) restent
 * structurels : rien à construire ici, déjà vrai par construction du pipeline (P0-06) et de
 * cette signature. RC-05 (mesures financières = permission de lecture + `inventory.
 * valuation.read`), RC-06 (limites, exposées ici via `limits`), RC-07 (existence opaque en
 * cas de doublon) et RC-09 (export/audit eux-mêmes audités) sont des conventions
 * d'appelant — aucun module métier n'existe encore en P0 pour les exercer.
 *
 * Les deux fonctions partagent le même cache mémoire par utilisateur (`rbac-cache.ts`),
 * invalidé par événement (`identity.role_assignment.grant`/`.revoke`, P0-10).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { getUserGrants, isGrantActiveAt } from '../rbac/rbac-cache.js';
import { resourceInGrantScope, type ResourceLocator } from '../rbac/scope-evaluation.js';

export type { ResourceLocator } from '../rbac/scope-evaluation.js';

export async function hasPermissionAt(
  executor: Kysely<DB> | Transaction<DB>,
  userId: Buffer,
  permissionCode: string,
  occurredAt: Date,
): Promise<boolean> {
  const grants = await getUserGrants(executor, fromBin(userId));
  return grants.some(
    (grant) => grant.permissionCode === permissionCode && isGrantActiveAt(grant, occurredAt),
  );
}

export type AccessResult =
  | { readonly allowed: true; readonly limits: Record<string, unknown> | null }
  | { readonly allowed: false; readonly reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE' };

export interface EvaluateAccessInput {
  readonly userId: string;
  readonly permissionCode: string;
  readonly occurredAt: Date;
  readonly resource: ResourceLocator;
}

export async function evaluateAccess(
  executor: Kysely<DB> | Transaction<DB>,
  input: EvaluateAccessInput,
): Promise<AccessResult> {
  const grants = await getUserGrants(executor, input.userId);
  const activeGrants = grants.filter(
    (grant) =>
      grant.permissionCode === input.permissionCode && isGrantActiveAt(grant, input.occurredAt),
  );
  if (activeGrants.length === 0) {
    return { allowed: false, reason: 'NO_PERMISSION' };
  }
  for (const grant of activeGrants) {
    if (
      await resourceInGrantScope(executor, grant, input.resource, input.userId, input.occurredAt)
    ) {
      return { allowed: true, limits: grant.limits };
    }
  }
  return { allowed: false, reason: 'OUT_OF_SCOPE' };
}
