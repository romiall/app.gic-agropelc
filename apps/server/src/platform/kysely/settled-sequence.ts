/**
 * Borne sûre d'un curseur sur une table en ajout seul numérotée par `AUTO_INCREMENT` (P5-23, AV-198) :
 * `sync_change_feed` (pull des appareils) et `platform_domain_events` (consommateurs d'événements).
 *
 * Le numéro est attribué à l'**insertion**, pas à la validation : une ligne d'une transaction encore
 * ouverte reste invisible pendant qu'une ligne de numéro supérieur, déjà validée, est lue. Un curseur
 * posé sur cette dernière sauterait définitivement la première. Un numéro absent (« trou ») est soit une
 * transaction annulée (trou définitif), soit une transaction en cours. Le lecteur ne dépasse donc jamais
 * un trou **récent** : un trou suivi d'une ligne écrite il y a moins de `settleSeconds` peut encore se
 * remplir. Au-delà, il est tenu pour définitif (une transaction de commande dure quelques secondes ; le
 * risque résiduel est une transaction plus longue que la fenêtre).
 *
 * Coût : seules les lignes récentes de la fin de l'intervalle sont lues, par la clé primaire, en ordre
 * décroissant ; l'âge est jugé par l'horloge de la base (`recorded_at`, écrit par la base), jamais par
 * celle de l'application.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from './database.js';

type SequencedTable = 'sync_change_feed' | 'platform_domain_events';

const TAIL_PAGE = 500;

/**
 * Plus grand numéro `N` de `[from, upTo]` tel qu'aucun trou récent n'existe dans `(from, N]` : le lecteur
 * peut avancer sa position jusqu'à `N` sans rien sauter. `upTo` est le dernier numéro qu'il a lu.
 */
export async function settledSequenceBound(
  executor: Kysely<DB> | Transaction<DB>,
  table: SequencedTable,
  range: { readonly from: number; readonly upTo: number },
  settleSeconds: number,
): Promise<number> {
  const { from, upTo } = range;
  if (upTo <= from || settleSeconds <= 0) return upTo;

  // Fin de l'intervalle, de la plus récente à la plus ancienne, jusqu'à la première ligne ancienne.
  const recent: number[] = [];
  let oldest: number | null = null;
  let below = upTo + 1;
  for (;;) {
    const rows = await executor
      .selectFrom(table)
      .select([
        'seq',
        sql<number>`recorded_at > NOW(6) - INTERVAL ${settleSeconds} SECOND`.as('is_recent'),
      ])
      .where('seq', '>', from)
      .where('seq', '<', below)
      .orderBy('seq', 'desc')
      .limit(TAIL_PAGE)
      .execute();
    for (const row of rows) {
      const seq = Number(row.seq);
      if (Number(row.is_recent) === 1) {
        recent.push(seq);
      } else {
        oldest = seq;
        break;
      }
    }
    if (oldest !== null || rows.length < TAIL_PAGE) break;
    below = Number(rows[rows.length - 1]!.seq);
  }

  // Premier trou au-dessus de la dernière ligne ancienne (ou de la position de départ).
  let expected = (oldest ?? from) + 1;
  for (const seq of recent.reverse()) {
    if (seq !== expected) return expected - 1;
    expected = seq + 1;
  }
  return upTo;
}
