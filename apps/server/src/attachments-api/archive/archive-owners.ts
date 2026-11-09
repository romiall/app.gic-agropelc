/**
 * Faits d'archivage des documents propriétaires des pièces (AV-539, ADR-070 §2.4) : numéro, références, catégorie de
 * dossier et « opération fermée ». Chaque module propriétaire dit ce qu'il sait de ses documents (API publique) ;
 * cette composition de transport y ajoute les validations en attente, comme `attachment-access.ts`.
 *
 * Une pièce n'est archivable que si son document est connu, fermé, et sans demande de validation en attente.
 */
import type { Kysely, Transaction } from 'kysely';
import type { ArchiveOwnerFacts } from '@gic/domain';
import type { DB } from '../../platform/kysely/database.js';
import { subjectsWithPendingApproval } from '../../modules/approvals/application/public/index.js';
import { receiptArchiveFacts } from '../../modules/procurement/application/public/index.js';
import { lossArchiveFacts } from '../../modules/inventory/application/public/index.js';
import {
  expenseArchiveFacts,
  supplierInvoiceArchiveFacts,
} from '../../modules/finance/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface OwnerRef {
  readonly ownerType: string;
  readonly ownerId: string;
}

export interface ResolvedOwner {
  readonly facts: ArchiveOwnerFacts;
  /** Vrai si l'opération est fermée et qu'aucune validation n'est en attente sur le document. */
  readonly archivable: boolean;
}

export function ownerKey(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

const FACTS: Readonly<
  Record<
    string,
    (executor: Executor, ids: readonly string[]) => Promise<ReadonlyMap<string, ArchiveOwnerFacts>>
  >
> = {
  GOODS_RECEIPT: receiptArchiveFacts,
  STOCK_LOSS: lossArchiveFacts,
  EXPENSE: expenseArchiveFacts,
  SUPPLIER_INVOICE: supplierInvoiceArchiveFacts,
};

/** Documents interrogés par lot (liste `IN` bornée). */
const BATCH = 500;

/**
 * Les faits des documents désignés, par `type:identifiant`. Un document introuvable (ou d'un type inconnu) n'a pas
 * d'entrée : sa pièce reste sur le serveur.
 */
export async function resolveArchiveOwners(
  executor: Executor,
  owners: readonly OwnerRef[],
): Promise<Map<string, ResolvedOwner>> {
  const idsByType = new Map<string, Set<string>>();
  for (const owner of owners) {
    const ids = idsByType.get(owner.ownerType) ?? new Set<string>();
    ids.add(owner.ownerId);
    idsByType.set(owner.ownerType, ids);
  }

  const resolved = new Map<string, ResolvedOwner>();
  for (const [ownerType, idSet] of idsByType) {
    const lookup = FACTS[ownerType];
    if (!lookup) continue;
    const ids = [...idSet];
    for (let at = 0; at < ids.length; at += BATCH) {
      const chunk = ids.slice(at, at + BATCH);
      const facts = await lookup(executor, chunk);
      const pending = await subjectsWithPendingApproval(
        executor,
        chunk.map((ownerId) => ({ subjectType: ownerType, subjectId: ownerId })),
      );
      for (const [ownerId, fact] of facts) {
        resolved.set(ownerKey(ownerType, ownerId), {
          facts: fact,
          archivable: fact.closed && !pending.has(ownerKey(ownerType, ownerId)),
        });
      }
    }
  }
  return resolved;
}
