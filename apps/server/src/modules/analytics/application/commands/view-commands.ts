/**
 * Commandes des vues sauvegardées (P9-19 ; ADR-077 §1, BR-ANA-007, UC-ANA-04, AV-432, AV-435, AV-496) :
 * `analytics.view.save` et `analytics.view.delete` (permission `analytics.explore`), `analytics.view.share` et
 * `analytics.view.set_default` (permission `analytics.view.share`). **Toutes en ligne** : hors ligne, la commande est
 * refusée `ONLINE_REQUIRED`.
 *
 * - **Propriétaire seul** : une vue ne se modifie, ne se partage, ne se retire que par celui qui l'a créée ; pour
 *   tout autre, elle est introuvable (existence opaque, RC-07). Un identifiant déjà pris par la vue d'un autre est
 *   donc aussi `NOT_FOUND` à la sauvegarde.
 * - **Sauvegarde** : la définition est validée contre le catalogue, les limites et les droits de **l'auteur** (jeu
 *   lisible, mesure au coût réservée à `inventory.valuation.read`) à la version courante du catalogue ; un nom est
 *   unique par propriétaire. Une vue enregistrée n'est jamais réécrite en silence plus tard (`OUTDATED`).
 * - **Partage** : par rôles actifs, sans droit supplémentaire (le lecteur l'exécute avec ses propres droits) ;
 *   publie `SavedViewShared`. Retirer un rôle retire aussi la vue par défaut de ce rôle.
 * - **Vue par défaut d'un rôle** : la vue doit être partagée avec ce rôle ; elle remplace la précédente du rôle
 *   (une seule par rôle) ; `null` retire la vue par défaut.
 * - **Suppression** : physique et auditée (objet de confort, dictionnaire).
 */
import { ANALYTICS_CATALOG_VERSION, type Clock, type IdGenerator } from '@gic/domain';
import {
  analyticsViewDeletePayloadSchema,
  analyticsViewSavePayloadSchema,
  analyticsViewSetDefaultPayloadSchema,
  analyticsViewSharePayloadSchema,
  ANALYTICS_COMMAND_TYPES,
  type AnalyticsViewDeletePayload,
  type AnalyticsViewSavePayload,
  type AnalyticsViewSetDefaultPayload,
  type AnalyticsViewSharePayload,
} from '@gic/contracts';
import type { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { unknownRoleCodes } from '../../../identity/application/public/index.js';
import { explorationDefinitionFrom } from '../query/exploration-definition.js';
import { validateExplorationForUser } from '../query/validate-for-user.js';
import {
  defaultViewOfRole,
  deleteView,
  insertView,
  lockView,
  ownerHasViewNamed,
  setViewDefault,
  updateViewContent,
  updateViewShare,
  type StoredView,
} from '../views/view-store.js';

export const EXPLORE_PERMISSION = 'analytics.explore';
export const SHARE_PERMISSION = 'analytics.view.share';

export interface ViewCommandDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

const rejected = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
  status: 'REJECTED',
  errorCode,
  messageFr,
});

const NOT_FOUND = rejected('NOT_FOUND', 'Vue introuvable.');
const ONLINE_REQUIRED = rejected(
  'ONLINE_REQUIRED',
  'Les vues sauvegardées se créent, se partagent et se suppriment en ligne.',
);

/** État d'une vue pour l'audit (avant / après). */
const snapshot = (view: StoredView | null): Record<string, unknown> | null =>
  view === null
    ? null
    : {
        name: view.name,
        dataset: view.dataset,
        version: view.version,
        shared_with_roles: view.sharedWithRoles,
        is_default_for_role: view.isDefaultForRole,
      };

/** La vue de l'auteur, verrouillée ; `undefined` si elle n'existe pas ou appartient à un autre. */
async function ownViewOf(
  uow: UnitOfWork,
  viewId: string,
  authorId: string,
): Promise<StoredView | undefined> {
  const view = await lockView(uow, viewId);
  return view !== undefined && view.ownerUserId === authorId ? view : undefined;
}

function save(deps: ViewCommandDeps): CommandHandler<AnalyticsViewSavePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const viewId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const payload = envelope.payload;
    const existing = await lockView(uow, viewId);
    if (existing !== undefined && existing.ownerUserId !== author) return NOT_FOUND;

    if (payload.catalogVersion !== ANALYTICS_CATALOG_VERSION) {
      return rejected(
        'CATALOG_OUTDATED',
        `Le catalogue est passé à la version ${ANALYTICS_CATALOG_VERSION} : relisez-le avant de sauvegarder.`,
      );
    }
    const definition = explorationDefinitionFrom(payload.definition);
    const validation = await validateExplorationForUser(uow, {
      userId: author,
      definition,
      at: deps.clock.now(),
    });
    if (!validation.ok) return rejected(validation.code, validation.messageFr);

    const name = payload.name;
    if (await ownerHasViewNamed(uow, { ownerUserId: author, name, exceptViewId: viewId })) {
      return rejected('VIEW_NAME_TAKEN', 'Vous avez déjà une vue de ce nom.');
    }
    const content = {
      name,
      dataset: definition.dataset,
      definition: payload.definition,
      catalogVersion: payload.catalogVersion,
    };
    if (existing === undefined) {
      await insertView(uow, { id: viewId, ownerUserId: author, ...content });
    } else {
      await updateViewContent(uow, { id: viewId, updatedBy: author, ...content });
    }
    return {
      status: 'APPLIED',
      serverRefs: { viewId },
      audit: {
        before: snapshot(existing ?? null),
        after: {
          name,
          dataset: definition.dataset,
          catalog_version: payload.catalogVersion,
          definition: payload.definition,
        },
      },
    };
  };
}

/** Écrit `SavedViewShared` (ADR-077 §9) : l'audit et la synchronisation le lisent, aucun module n'agit dessus. */
async function publishShared(
  uow: UnitOfWork,
  deps: ViewCommandDeps,
  input: {
    readonly viewId: string;
    readonly roles: readonly string[];
    readonly previousRoles: readonly string[];
    readonly occurredAt: Date;
    readonly commandId: string;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deps.idGenerator.newId()),
      event_type: 'SavedViewShared',
      producer_module: 'analytics',
      aggregate_type: 'SAVED_VIEW',
      aggregate_id: toBin(input.viewId),
      occurred_at: input.occurredAt,
      payload: jsonValue({
        view_id: input.viewId,
        roles: input.roles,
        previous_roles: input.previousRoles,
      }),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
}

function share(deps: ViewCommandDeps): CommandHandler<AnalyticsViewSharePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const author = envelope.author_user_id;
    const view = await ownViewOf(uow, envelope.aggregate_id, author);
    if (view === undefined) return NOT_FOUND;

    const roles = [...new Set(envelope.payload.roles)].sort();
    const unknown = await unknownRoleCodes(uow, roles);
    if (unknown.length > 0) {
      return rejected('ROLE_UNKNOWN', `Rôle inconnu ou inactif : ${unknown.join(', ')}.`);
    }
    const keepDefault =
      view.isDefaultForRole !== null && roles.includes(view.isDefaultForRole)
        ? view.isDefaultForRole
        : null;
    await updateViewShare(uow, { id: view.id, roles, updatedBy: author, keepDefault });
    await publishShared(uow, deps, {
      viewId: view.id,
      roles,
      previousRoles: view.sharedWithRoles,
      occurredAt: new Date(envelope.occurred_at),
      commandId: envelope.command_id,
    });
    return {
      status: 'APPLIED',
      serverRefs: { viewId: view.id },
      audit: {
        before: snapshot(view),
        after: { ...snapshot(view), shared_with_roles: roles, is_default_for_role: keepDefault },
      },
    };
  };
}

function setDefault(): CommandHandler<AnalyticsViewSetDefaultPayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const author = envelope.author_user_id;
    const view = await ownViewOf(uow, envelope.aggregate_id, author);
    if (view === undefined) return NOT_FOUND;

    const roleCode = envelope.payload.roleCode;
    let replaced: StoredView | undefined;
    if (roleCode !== null) {
      if (!view.sharedWithRoles.includes(roleCode)) {
        return rejected(
          'VIEW_NOT_SHARED_WITH_ROLE',
          'La vue doit être partagée avec ce rôle avant d’en être la vue par défaut.',
        );
      }
      // Une seule vue par défaut par rôle : l'ancienne est libérée avant de poser la nouvelle.
      replaced = await defaultViewOfRole(uow, roleCode, view.id);
      if (replaced !== undefined) {
        await setViewDefault(uow, { id: replaced.id, roleCode: null, updatedBy: author });
      }
    }
    await setViewDefault(uow, { id: view.id, roleCode, updatedBy: author });
    return {
      status: 'APPLIED',
      serverRefs: { viewId: view.id },
      audit: {
        before: {
          ...snapshot(view),
          ...(replaced !== undefined ? { replaced_view_id: replaced.id } : {}),
        },
        after: { ...snapshot(view), is_default_for_role: roleCode },
      },
    };
  };
}

function remove(): CommandHandler<AnalyticsViewDeletePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const view = await ownViewOf(uow, envelope.aggregate_id, envelope.author_user_id);
    if (view === undefined) return NOT_FOUND;
    await deleteView(uow, view.id);
    return {
      status: 'APPLIED',
      serverRefs: { viewId: view.id },
      audit: { before: snapshot(view), after: null },
    };
  };
}

export function registerViewCommands(
  registry: CommandHandlerRegistry,
  deps: ViewCommandDeps,
): void {
  registry.register<AnalyticsViewSavePayload>({
    commandType: ANALYTICS_COMMAND_TYPES.viewSave,
    version: 1,
    // `dimensions`, `filters` et `sort` ont une valeur par défaut : le type en sortie est celui du gestionnaire.
    payloadSchema: analyticsViewSavePayloadSchema as unknown as z.ZodType<AnalyticsViewSavePayload>,
    permissionCode: EXPLORE_PERMISSION,
    handler: save(deps),
    isolationLevel: 'read committed',
  });
  registry.register<AnalyticsViewSharePayload>({
    commandType: ANALYTICS_COMMAND_TYPES.viewShare,
    version: 1,
    payloadSchema: analyticsViewSharePayloadSchema,
    permissionCode: SHARE_PERMISSION,
    handler: share(deps),
    isolationLevel: 'read committed',
  });
  registry.register<AnalyticsViewSetDefaultPayload>({
    commandType: ANALYTICS_COMMAND_TYPES.viewSetDefault,
    version: 1,
    payloadSchema: analyticsViewSetDefaultPayloadSchema,
    permissionCode: SHARE_PERMISSION,
    handler: setDefault(),
    isolationLevel: 'read committed',
  });
  registry.register<AnalyticsViewDeletePayload>({
    commandType: ANALYTICS_COMMAND_TYPES.viewDelete,
    version: 1,
    payloadSchema: analyticsViewDeletePayloadSchema,
    permissionCode: EXPLORE_PERMISSION,
    handler: remove(),
    isolationLevel: 'read committed',
  });
}
