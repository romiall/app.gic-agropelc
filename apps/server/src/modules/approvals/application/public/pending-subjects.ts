/**
 * Documents qui ont une demande de validation en attente (AV-539, ADR-070 §2.4) : une photo qui sert de preuve à
 * une validation en cours ne quitte jamais le serveur, quel que soit l'état du document dans son module.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Clé `${type}:${identifiant}` des sujets de la liste qui ont une demande `PENDING`. */
export async function subjectsWithPendingApproval(
  executor: Kysely<DB> | Transaction<DB>,
  subjects: readonly { readonly subjectType: string; readonly subjectId: string }[],
): Promise<ReadonlySet<string>> {
  const pending = new Set<string>();
  if (subjects.length === 0) return pending;
  const rows = await executor
    .selectFrom('approvals_approval_requests')
    .select(['subject_type', 'subject_id'])
    .where('status', '=', 'PENDING')
    .where('subject_type', 'in', [...new Set(subjects.map((subject) => subject.subjectType))])
    .where(
      'subject_id',
      'in',
      [...new Set(subjects.map((subject) => subject.subjectId))].map(toBin),
    )
    .execute();
  for (const row of rows) pending.add(`${row.subject_type}:${fromBin(row.subject_id)}`);
  return pending;
}
