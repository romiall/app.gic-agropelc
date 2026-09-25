/**
 * Chaînage et intégrité du journal d'audit (07-security-rbac/03-audit.md §5) :
 *
 *   canon(e) = JSON canonique (clés triées, sans espaces) de
 *     {seq, id, occurred_at, recorded_at, actor_user_id, actor_roles, device_id, action,
 *      entity_type, entity_id, before_hash, after_hash, reason_hash, result, command_id}
 *     où *_hash = SHA-256 du contenu
 *   row_hash(e) = SHA-256(prev_hash ‖ canon(e))
 *   prev_hash(e) = row_hash(e précédente) ; première entrée : 64 zéros
 *
 * Fonctions pures, testables sans base (record-audit.ts porte le verrou et l'insertion). La
 * vérification de bout en bout (tâche quotidienne, INV-AUD-01) est P0-07 : ce fichier ne
 * fournit que ce dont l'écriture (ce module, P0-06) a besoin.
 */
import { canonicalJsonStringify } from '../platform/canonical-json.js';
import { sha256Hex } from '../platform/hash.js';

export { canonicalJsonStringify, sha256Hex };

export const GENESIS_PREV_HASH = '0'.repeat(64);

/** Champs canoniques d'une entrée d'audit (avant hachage des trois champs à empreinte). */
export interface AuditCanonFields {
  readonly seq: number;
  readonly id: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly actor_user_id: string;
  readonly actor_roles: readonly string[];
  readonly device_id: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly result: string;
  readonly command_id: string | null;
}

export interface AuditRowHash {
  readonly rowHash: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly reasonHash: string;
}

/**
 * `*_hash` = SHA-256 du contenu (avant/après/motif), calculés séparément : « permet la
 * pseudonymisation sans casser la chaîne » (§5, §7) puisque seul le contenu source change.
 */
export function computeAuditRowHash(prevHash: string, fields: AuditCanonFields): AuditRowHash {
  const beforeHash = sha256Hex(canonicalJsonStringify(fields.before ?? null));
  const afterHash = sha256Hex(canonicalJsonStringify(fields.after ?? null));
  const reasonHash = sha256Hex(fields.reason ?? '');
  const canon = canonicalJsonStringify({
    seq: fields.seq,
    id: fields.id,
    occurred_at: fields.occurred_at,
    recorded_at: fields.recorded_at,
    actor_user_id: fields.actor_user_id,
    actor_roles: fields.actor_roles,
    device_id: fields.device_id,
    action: fields.action,
    entity_type: fields.entity_type,
    entity_id: fields.entity_id,
    before_hash: beforeHash,
    after_hash: afterHash,
    reason_hash: reasonHash,
    result: fields.result,
    command_id: fields.command_id,
  });
  return { rowHash: sha256Hex(prevHash + canon), beforeHash, afterHash, reasonHash };
}
