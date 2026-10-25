/**
 * Lecture des vues sauvegardées pour un lecteur (P9-19 ; ADR-077 §2, BR-ANA-007) : les vues qu'il voit (les siennes et
 * celles partagées avec l'un de ses rôles) avec leur **exécutabilité**, calculée contre le catalogue et les droits du
 * lecteur **sans lire aucune donnée** — `OK`, `OUTDATED` (un champ a disparu ou la définition n'est plus valide, jamais
 * réécrite en silence) ou `UNAVAILABLE` (jeu ou valeur au coût illisible pour lui).
 */
import type { Kysely, Transaction } from 'kysely';
import { explorationDefinitionSchema } from '@gic/contracts';
import type { DB } from '../../../../platform/kysely/database.js';
import { activeRoleCodesAt } from '../../../identity/application/public/index.js';
import { explorationDefinitionFrom } from '../query/exploration-definition.js';
import { validateExplorationForUser } from '../query/validate-for-user.js';
import { readView, viewVisibleTo, visibleViews, type StoredView } from './view-store.js';

type Executor = Kysely<DB> | Transaction<DB>;

export type ViewExecutability = 'OK' | 'OUTDATED' | 'UNAVAILABLE';

export interface ReadableView {
  readonly view: StoredView;
  readonly executability: ViewExecutability;
}

/** Vues listées au plus (le catalogue de vues d'un utilisateur reste petit ; borne de sûreté). */
export const VIEWS_LIST_LIMIT = 200;

export async function viewExecutability(
  executor: Executor,
  input: { readonly userId: string; readonly view: StoredView; readonly at: Date },
): Promise<ViewExecutability> {
  const parsed = explorationDefinitionSchema.safeParse(input.view.definition);
  if (!parsed.success) return 'OUTDATED';
  const validation = await validateExplorationForUser(executor, {
    userId: input.userId,
    definition: explorationDefinitionFrom(parsed.data),
    at: input.at,
  });
  if (validation.ok) return 'OK';
  return validation.code === 'FORBIDDEN' || validation.code === 'FORBIDDEN_MEASURE'
    ? 'UNAVAILABLE'
    : 'OUTDATED';
}

export async function listReadableViews(
  executor: Executor,
  input: { readonly userId: string; readonly at: Date },
): Promise<readonly ReadableView[]> {
  const roleCodes = await activeRoleCodesAt(executor, input.userId, input.at);
  const views = await visibleViews(executor, {
    userId: input.userId,
    roleCodes,
    limit: VIEWS_LIST_LIMIT,
  });
  const readable: ReadableView[] = [];
  for (const view of views) {
    readable.push({
      view,
      executability: await viewExecutability(executor, {
        userId: input.userId,
        view,
        at: input.at,
      }),
    });
  }
  return readable;
}

/** Une vue visible du lecteur, avec son exécutabilité ; `undefined` si elle n'existe pas ou ne lui est pas visible. */
export async function readReadableView(
  executor: Executor,
  input: { readonly userId: string; readonly viewId: string; readonly at: Date },
): Promise<ReadableView | undefined> {
  const view = await readView(executor, input.viewId);
  if (view === undefined) return undefined;
  const roleCodes = await activeRoleCodesAt(executor, input.userId, input.at);
  if (!viewVisibleTo(view, { userId: input.userId, roleCodes })) return undefined;
  return {
    view,
    executability: await viewExecutability(executor, { userId: input.userId, view, at: input.at }),
  };
}
