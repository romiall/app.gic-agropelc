/**
 * `audit.record(uow, entry)` (05-architecture/02-modules.md §2 « audit ») : écrit une
 * entrée dans la transaction métier en cours. Ordre et chaînage garantis par un verrou
 * consultatif global — substitution MySQL documentée en 05-stack.md §3.2 (« verrous
 * consultatifs transactionnels ») : `SELECT … FOR UPDATE` sur la dernière ligne (ou, table
 * vide, le verrou de plage InnoDB pris par la même requête), tenu jusqu'au commit/rollback
 * de la transaction appelante.
 *
 * `seq` ne peut pas être laissé à l'auto-incrément MySQL : {@link computeAuditRowHash}
 * doit le connaître *avant* l'insertion (il fait partie de `canon(e)`, et la ligne est
 * immuable dès l'insertion — aucune mise à jour ultérieure possible). Il est donc calculé
 * ici sous le verrou et fourni explicitement à l'INSERT (AUTO_INCREMENT accepte une valeur
 * explicite et avance son compteur en conséquence).
 */
import type { Clock, IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { jsonValue } from '../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../platform/kysely/uuid-columns.js';
import { toDbBool } from '../platform/kysely/bool-column.js';
import { computeAuditRowHash, GENESIS_PREV_HASH, type AuditCanonFields } from './hash-chain.js';
import { redactSecrets } from './redact.js';

export type AuditResult = 'SUCCESS' | 'DENIED' | 'FAILED' | 'QUARANTINED';

export interface AuditEntryInput {
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorRoles: readonly string[];
  readonly deviceId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly capturedOffline?: boolean;
  readonly syncDelayMs?: number | null;
  readonly clockSkewMs?: number | null;
  readonly commandId?: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly siteId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly approvalRequestId?: string | null;
  readonly result: AuditResult;
  readonly errorCode?: string | null;
  readonly correlationId?: string | null;
}

export interface RecordedAudit {
  readonly seq: number;
  readonly id: string;
  readonly rowHash: string;
}

export async function recordAudit(
  trx: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  entry: AuditEntryInput,
): Promise<RecordedAudit> {
  // Verrou sur la ligne unique de tête de chaîne (clé primaire exacte, aucun verrou
  // d'intervalle) : sérialise les écritures concurrentes sans verrou mortel — voir la migration
  // 20260929090000_create_audit_chain_head.sql. Tête absente : base non migrée, erreur franche.
  const head = await trx
    .selectFrom('audit_chain_head')
    .select(['last_seq', 'last_row_hash'])
    .where('id', '=', 1)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const nextSeq = Number(head.last_seq) + 1;
  const prevHash = Number(head.last_seq) === 0 ? GENESIS_PREV_HASH : head.last_row_hash;
  const id = deps.idGenerator.newId();
  const recordedAt = deps.clock.now();

  // Masqué avant hachage ET stockage (INV-AUD-02) : la chaîne ne certifie et ne conserve
  // jamais que la version déjà masquée — vérifiable à partir de ce qui est réellement stocké.
  const before = entry.before === undefined ? null : redactSecrets(entry.before);
  const after = entry.after === undefined ? null : redactSecrets(entry.after);

  const canonFields: AuditCanonFields = {
    seq: nextSeq,
    id,
    occurred_at: entry.occurredAt.toISOString(),
    recorded_at: recordedAt.toISOString(),
    actor_user_id: entry.actorUserId,
    actor_roles: entry.actorRoles,
    device_id: entry.deviceId ?? null,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    before,
    after,
    reason: entry.reason ?? null,
    result: entry.result,
    command_id: entry.commandId ?? null,
  };
  const { rowHash } = computeAuditRowHash(prevHash, canonFields);

  await trx
    .insertInto('audit_audit_log')
    .values({
      seq: nextSeq,
      id: toBin(id),
      occurred_at: entry.occurredAt,
      recorded_at: recordedAt,
      actor_user_id: toBin(entry.actorUserId),
      actor_roles: jsonValue(entry.actorRoles),
      device_id: toBinOrNull(entry.deviceId),
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ?? null,
      captured_offline: toDbBool(entry.capturedOffline),
      sync_delay_ms: entry.syncDelayMs ?? null,
      clock_skew_ms: entry.clockSkewMs ?? null,
      command_id: toBinOrNull(entry.commandId),
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: toBinOrNull(entry.entityId),
      site_id: toBinOrNull(entry.siteId),
      before: before === null ? null : jsonValue(before),
      after: after === null ? null : jsonValue(after),
      reason: entry.reason ?? null,
      approval_request_id: toBinOrNull(entry.approvalRequestId),
      result: entry.result,
      error_code: entry.errorCode ?? null,
      correlation_id: toBinOrNull(entry.correlationId),
      prev_hash: prevHash,
      row_hash: rowHash,
    })
    .execute();
  await trx
    .updateTable('audit_chain_head')
    .set({ last_seq: nextSeq, last_row_hash: rowHash })
    .where('id', '=', 1)
    .execute();

  return { seq: nextSeq, id, rowHash };
}
