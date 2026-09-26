/**
 * Ligne de flux de changements d'une demande de validation (P2, AV-094). Dictionnaire
 * `approvals.approval_requests` : « Offline DL (celles de l'utilisateur, en lecture seule) » ;
 * catalogue des jeux (01-architecture-offline.md §3.1) : jeu `comms`, portée `USER` — « demandes
 * de validation de l'utilisateur ». Émise pour le **seul demandeur** : une demande porte le
 * résumé d'une opération parfois confidentielle (déclaration de perte, écart d'inventaire) et
 * ne doit jamais parvenir aux appareils d'autres utilisateurs (la file des approbateurs est
 * servie en ligne, `/approvals/inbox`, ECR-ADM-08).
 */
import type { Kysely } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';

export async function recordRequesterChange(
  uow: UnitOfWork | Kysely<DB>,
  requestId: string,
  requestedBy: string,
): Promise<void> {
  await recordChanges(uow, [
    {
      dataset: 'comms',
      entityType: 'APPROVAL_REQUEST',
      entityId: requestId,
      scopeType: 'USER',
      scopeId: requestedBy,
    },
  ]);
}
