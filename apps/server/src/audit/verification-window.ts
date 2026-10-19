/**
 * Début de la fenêtre de vérification de la chaîne d'audit (P9-10, AV-470) : le plus petit numéro de ligne dont
 * l'écriture (`recorded_at`) est postérieure ou égale à une date.
 *
 * `audit_audit_log` n'a aucun index sur `recorded_at` : `MIN(seq) WHERE recorded_at >= ?` parcourrait toute la
 * table, journal de plusieurs années compris, chaque nuit. L'écriture est séquentielle (un verrou de tête de
 * chaîne, `recordAudit`) : les dates croissent avec `seq`. On lit donc la fin de la table, de la plus récente à la
 * plus ancienne, par pages de clé primaire, **jusqu'à la première ligne antérieure** à la date — le coût suit la
 * taille de la fenêtre, non celle du journal. Si une horloge d'application a reculé de quelques minutes, la
 * fenêtre peut commencer quelques lignes plus tard que le minimum exact : ces lignes ont été vérifiées la veille
 * (la fenêtre couvre deux jours métier).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';

/** Lignes lues par page, de la plus récente à la plus ancienne. */
export const WINDOW_PAGE_SIZE = 1_000;

export interface WindowRow {
  readonly seq: number;
  readonly recordedAt: Date;
}

/** Lecteur d'une page décroissante : au plus `limit` lignes de numéro inférieur à `beforeSeq` (sans borne : `null`). */
export type DescendingPageReader = (
  beforeSeq: number | null,
  limit: number,
) => Promise<readonly WindowRow[]>;

/**
 * Plus petit `seq` de la dernière série continue de lignes écrites à `from` ou après, lue depuis la fin ; `null`
 * si la ligne la plus récente est antérieure à `from` (ou si le journal est vide).
 */
export async function firstSeqRecordedAtOrAfterVia(
  readPage: DescendingPageReader,
  from: Date,
  pageSize: number = WINDOW_PAGE_SIZE,
): Promise<number | null> {
  const limit = Math.max(1, Math.floor(pageSize));
  let first: number | null = null;
  let beforeSeq: number | null = null;
  for (;;) {
    const page = await readPage(beforeSeq, limit);
    for (const row of page) {
      if (row.recordedAt.getTime() < from.getTime()) return first;
      first = row.seq;
    }
    // Une page incomplète (ou vide) est la dernière : le journal est épuisé.
    if (page.length < limit) return first;
    beforeSeq = page[page.length - 1]!.seq;
  }
}

/** Lecteur de pages décroissantes de `audit_audit_log` (numéro et date d'écriture seulement). */
export function auditPageReaderDescending(db: Kysely<DB> | Transaction<DB>): DescendingPageReader {
  return async (beforeSeq, limit) => {
    const query = db
      .selectFrom('audit_audit_log')
      .select(['seq', 'recorded_at'])
      .orderBy('seq', 'desc')
      .limit(limit);
    const rows = await (beforeSeq === null ? query : query.where('seq', '<', beforeSeq)).execute();
    return rows.map((row) => ({ seq: Number(row.seq), recordedAt: row.recorded_at }));
  };
}

/** {@link firstSeqRecordedAtOrAfterVia} sur `audit_audit_log`. */
export async function firstSeqRecordedAtOrAfter(
  db: Kysely<DB> | Transaction<DB>,
  from: Date,
  pageSize: number = WINDOW_PAGE_SIZE,
): Promise<number | null> {
  return firstSeqRecordedAtOrAfterVia(auditPageReaderDescending(db), from, pageSize);
}
