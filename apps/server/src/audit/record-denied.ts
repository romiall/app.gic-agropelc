/**
 * `audit.recordDenied(entry)` (05-architecture/02-modules.md §2 « audit ») : même
 * chaînage que {@link recordAudit}, mais dans **sa propre transaction** — un refus
 * d'autorisation (action `access.denied`, 07-security-rbac/03-audit.md §3) reste audité
 * même quand la commande refusée n'a, par construction, jamais ouvert sa transaction
 * métier (algorithme §3.2, étape 4, avant BEGIN).
 */
import type { Clock, IdGenerator } from '@gic/domain';
import type { Database } from '../platform/kysely/database.js';
import { recordAudit, type AuditEntryInput, type RecordedAudit } from './record-audit.js';

export async function recordDenied(
  db: Database,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  entry: Omit<AuditEntryInput, 'result'>,
): Promise<RecordedAudit> {
  return db.transaction().execute((trx) => recordAudit(trx, deps, { ...entry, result: 'DENIED' }));
}
