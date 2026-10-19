/**
 * Vérification de bout en bout du chaînage (INV-AUD-01 ; 07-security-rbac/03-audit.md §5 :
 * « tâche quotidienne qui recalcule la chaîne des entrées du jour, plus une vérification
 * hebdomadaire complète du mois courant. Toute rupture → AUDIT_CHAIN_BROKEN (critique) »).
 *
 * `verifyChain` est une fonction pure (comme `computeAuditRowHash`, hash-chain.ts) : elle ne
 * lit rien, elle ne fait que rejouer une séquence déjà chargée — testable avec des lignes
 * délibérément corrompues, ce qu'une vraie base ne permet pas ici (`audit_audit_log` a un
 * déclencheur qui interdit tout UPDATE, y compris pour un rôle admin, INV-AUD-01). Le
 * chaînage se vérifie dans les deux sens à chaque ligne : `prev_hash` doit être le
 * `row_hash` de la ligne précédente (liaison), et `row_hash` doit être recalculable à
 * l'identique à partir des champs stockés (contenu) — `before`/`after` étant déjà masqués
 * au moment de l'écriture (INV-AUD-02, record-audit.ts), les revérifier ne fait que
 * confirmer ce qui a réellement été stocké, pas les valeurs d'origine.
 */
import type { Kysely, Selectable, Transaction } from 'kysely';
import { computeAuditRowHash, GENESIS_PREV_HASH, type AuditCanonFields } from './hash-chain.js';
import type { DB } from '../platform/kysely/database.js';
import type { AuditAuditLog } from '../platform/kysely/schema.generated.js';
import { fromBin, fromBinOrNull } from '../platform/kysely/uuid-columns.js';

export interface VerifiableAuditRow extends AuditCanonFields {
  readonly prevHash: string;
  readonly rowHash: string;
}

export type ChainBreakReason = 'LINKAGE_MISMATCH' | 'HASH_MISMATCH';

export interface ChainVerificationResult {
  readonly checked: number;
  readonly ok: boolean;
  readonly brokenAtSeq: number | null;
  readonly reason: ChainBreakReason | null;
}

/** Rejoue une séquence déjà ordonnée par `seq` croissant ; ne suppose rien sur son étendue. */
export function verifyChain(
  rows: readonly VerifiableAuditRow[],
  expectedFirstPrevHash: string,
): ChainVerificationResult {
  let expectedPrevHash = expectedFirstPrevHash;
  let checked = 0;
  for (const row of rows) {
    checked++;
    if (row.prevHash !== expectedPrevHash) {
      return { checked, ok: false, brokenAtSeq: row.seq, reason: 'LINKAGE_MISMATCH' };
    }
    const { rowHash } = computeAuditRowHash(row.prevHash, row);
    if (rowHash !== row.rowHash) {
      return { checked, ok: false, brokenAtSeq: row.seq, reason: 'HASH_MISMATCH' };
    }
    expectedPrevHash = row.rowHash;
  }
  return { checked, ok: true, brokenAtSeq: null, reason: null };
}

export function toVerifiableAuditRow(row: Selectable<AuditAuditLog>): VerifiableAuditRow {
  return {
    seq: Number(row.seq),
    id: fromBin(row.id),
    occurred_at: row.occurred_at.toISOString(),
    recorded_at: row.recorded_at.toISOString(),
    actor_user_id: fromBin(row.actor_user_id),
    actor_roles: row.actor_roles as readonly string[],
    device_id: fromBinOrNull(row.device_id),
    action: row.action,
    entity_type: row.entity_type,
    entity_id: fromBinOrNull(row.entity_id),
    before: row.before,
    after: row.after,
    reason: row.reason,
    result: row.result,
    command_id: fromBinOrNull(row.command_id),
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  };
}

/** Lignes lues par page (P9-10) : la plage vérifiée n'est jamais chargée en entier en mémoire. */
export const VERIFY_CHAIN_PAGE_SIZE = 2_000;

/** Lecteur d'une page : au plus `limit` lignes de numéro supérieur à `afterSeq`, par `seq` croissant. */
export type AuditPageReader = (
  afterSeq: number,
  limit: number,
) => Promise<readonly VerifiableAuditRow[]>;

/**
 * Rejoue une plage page après page : la dernière empreinte de chaque page est l'empreinte attendue avant la
 * première ligne de la suivante, si bien qu'une rupture à cheval sur deux pages est détectée comme dans une
 * lecture d'un seul tenant. `expectedFirstPrevHash` précède la première ligne lue ; `checked` cumule les
 * lignes rejouées jusqu'à la rupture comprise. Le lecteur ne rend rien de plus que la page demandée.
 */
export async function verifyChainPages(
  readPage: AuditPageReader,
  range: { readonly afterSeq: number; readonly toSeq: number },
  options: {
    readonly pageSize?: number;
    /** Empreinte attendue avant la première ligne ; appelée une fois, après la lecture de la première page. */
    readonly expectedFirstPrevHash: () => Promise<string>;
  },
): Promise<ChainVerificationResult> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? VERIFY_CHAIN_PAGE_SIZE));
  let afterSeq = range.afterSeq;
  let expectedPrevHash: string | null = null;
  let checked = 0;
  while (afterSeq < range.toSeq) {
    const page = (await readPage(afterSeq, pageSize)).filter((row) => row.seq <= range.toSeq);
    if (page.length === 0) break;
    expectedPrevHash ??= await options.expectedFirstPrevHash();
    const result = verifyChain(page, expectedPrevHash);
    checked += result.checked;
    if (!result.ok) {
      return { checked, ok: false, brokenAtSeq: result.brokenAtSeq, reason: result.reason };
    }
    expectedPrevHash = page[page.length - 1]!.rowHash;
    afterSeq = page[page.length - 1]!.seq;
    if (page.length < pageSize) break;
  }
  return { checked, ok: true, brokenAtSeq: null, reason: null };
}

export interface VerifyChainRangeOptions {
  readonly fromSeq: number;
  readonly toSeq: number;
  /** Lignes lues par page ; {@link VERIFY_CHAIN_PAGE_SIZE} par défaut. */
  readonly pageSize?: number;
}

/** Enveloppe base de données de {@link verifyChainPages} : lit la plage par pages de clé `seq`, puis rejoue. */
export async function verifyChainRange(
  db: Kysely<DB> | Transaction<DB>,
  range: VerifyChainRangeOptions,
): Promise<ChainVerificationResult> {
  return verifyChainPages(
    async (afterSeq, limit) =>
      (
        await db
          .selectFrom('audit_audit_log')
          .selectAll()
          .where('seq', '>', afterSeq)
          .where('seq', '<=', range.toSeq)
          .orderBy('seq', 'asc')
          .limit(limit)
          .execute()
      ).map(toVerifiableAuditRow),
    { afterSeq: range.fromSeq - 1, toSeq: range.toSeq },
    {
      ...(range.pageSize !== undefined ? { pageSize: range.pageSize } : {}),
      expectedFirstPrevHash: async () => {
        if (range.fromSeq <= 1) return GENESIS_PREV_HASH;
        const before = await db
          .selectFrom('audit_audit_log')
          .select('row_hash')
          .where('seq', '=', range.fromSeq - 1)
          .executeTakeFirst();
        return before ? before.row_hash : GENESIS_PREV_HASH;
      },
    },
  );
}
