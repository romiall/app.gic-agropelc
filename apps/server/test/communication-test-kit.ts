/**
 * Outils des tests de `communication` (P9-04, P9-05) : transactions de test qui ne laissent **aucun trou**
 * dans `platform_domain_events`.
 *
 * Le numéro d'un événement (`seq`) est attribué à l'insertion ; une transaction annulée (le `ROLLBACK` de
 * `withTestUow`, la victime d'un interblocage) laisse un numéro absent. Or les consommateurs ne dépassent
 * jamais un trou plus récent que `settleSeconds` (120 s par défaut, `settled-sequence.ts`, AV-198) :
 * un trou laissé par un test retarde, pendant deux minutes, tout autre test de la suite qui attend un
 * consommateur (cache RBAC, runner, curseur du pull). Ici, chaque numéro consommé par une transaction
 * annulée est repris par une ligne `test.tombstone` ignorée par tous les consommateurs : le numéro
 * appartenait exclusivement à la transaction annulée, aucune autre écriture n'est en jeu.
 */
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid, withTestUow } from './helpers.js';

const TOMBSTONE_TYPE = 'test.tombstone';

/** Plugin qui relève le `seq` de chaque insertion dans `platform_domain_events`. */
function sequenceRecorder(seqs: number[]): KyselyPlugin {
  const pending = new Set<string>();
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node;
      if (
        node.kind === 'InsertQueryNode' &&
        node.into?.table.identifier.name === 'platform_domain_events'
      ) {
        pending.add(args.queryId.queryId);
      }
      return node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      if (pending.delete(args.queryId.queryId) && args.result.insertId !== undefined) {
        seqs.push(Number(args.result.insertId));
      }
      return args.result;
    },
  };
}

/** Remplace chaque numéro consommé par une transaction annulée par une ligne neutre. */
async function tombstone(seqs: readonly number[]): Promise<void> {
  for (const seq of seqs) {
    await db
      .insertInto('platform_domain_events')
      .values({
        seq,
        event_id: toBin(freshUuid()),
        event_type: TOMBSTONE_TYPE,
        producer_module: 'test',
        aggregate_type: 'TEST',
        aggregate_id: toBin(freshUuid()),
        occurred_at: new Date(),
        payload: jsonValue({}),
      })
      .ignore()
      .execute();
  }
}

/**
 * Comme `withTestUow` (transaction toujours annulée) mais sans trou : les numéros d'événements consommés
 * sont repris. Renvoie aussi ces numéros (pour le contrôler).
 */
export async function rolledBackWithSequences<T>(
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<{ readonly result: T; readonly seqs: readonly number[] }> {
  const seqs: number[] = [];
  try {
    const result = await withTestUow((uow) => fn(uow.withPlugin(sequenceRecorder(seqs))));
    return { result, seqs };
  } finally {
    await tombstone(seqs);
  }
}

export async function rolledBack<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
  return (await rolledBackWithSequences(fn)).result;
}

/**
 * Transaction **validée** (ou annulée si elle lève : victime d'un interblocage, erreur) ; les numéros
 * d'une transaction annulée sont repris comme ci-dessus.
 */
export async function committed<T>(
  fn: (uow: UnitOfWork) => Promise<T>,
  options: { readonly isolation?: 'read committed' } = {},
): Promise<T> {
  const seqs: number[] = [];
  try {
    const builder = db.transaction();
    const configured =
      options.isolation !== undefined ? builder.setIsolationLevel(options.isolation) : builder;
    return await configured.execute((uow) => fn(uow.withPlugin(sequenceRecorder(seqs))));
  } catch (error) {
    await tombstone(seqs);
    throw error;
  }
}
