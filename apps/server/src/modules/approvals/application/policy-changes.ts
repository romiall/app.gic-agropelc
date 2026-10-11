/**
 * Lignes de flux des politiques de contrôle (P5-18, AV-196 ; 01-architecture-offline.md §3.1 : jeu
 * `policies`, « politiques de contrôle actives », ligne `GLOBAL`). Une politique est versionnée par
 * code (`approvals.policy.set`) : la nouvelle version active est publiée et la version retirée sort
 * du jeu (`DELETE`) — sans quoi l'appareil garderait l'ancienne sous un autre identifiant. Les
 * politiques semées sont publiées par le seed. Le type d'entité est une clé de
 * `sync/entity-projections.ts` (qui ne sert qu'une politique `ACTIVE`).
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';

export const POLICIES_DATASET = 'policies';

export async function emitPolicyChanges(
  uow: UnitOfWork,
  activePolicyId: string,
  retiredPolicyIds: readonly string[],
): Promise<void> {
  await recordChanges(uow, [
    ...retiredPolicyIds.map((id) => ({
      dataset: POLICIES_DATASET,
      entityType: 'CONTROL_POLICY',
      entityId: id,
      scopeType: 'GLOBAL' as const,
      scopeId: null,
      changeType: 'DELETE' as const,
    })),
    {
      dataset: POLICIES_DATASET,
      entityType: 'CONTROL_POLICY',
      entityId: activePolicyId,
      scopeType: 'GLOBAL',
      scopeId: null,
    },
  ]);
}
