/**
 * Déclaration explicite du contrôle d'accès de chaque route HTTP (NFR-24 : « 100 % des
 * endpoints authentifiés et soumis au contrôle de portée, sauf /auth/login et webhook
 * authentifié »). Purement des métadonnées (`SetMetadata`) : n'exécute aucun contrôle par
 * elles-mêmes (`AuthGuard` reste le seul point qui authentifie réellement, chaque
 * contrôleur reste responsable de son propre contrôle de droit) — seulement de quoi
 * permettre à `test/endpoint-coverage.test.ts` de vérifier, par introspection des routes,
 * qu'aucune n'a été oubliée (un ajout de route sans l'un de ces décorateurs fait échouer ce
 * test, immédiatement, plutôt que de laisser un endpoint non gouverné passer inaperçu).
 *
 * Quatre cas, chacun un décorateur :
 * - `@Public()` — non authentifiée par construction (login : échange un mot de passe contre
 *   un jeton ; refresh : échange un jeton de rafraîchissement contre un nouveau jeton ;
 *   santé). Exemptée par NFR-24 elle-même ou structurellement équivalente (aucune identité
 *   déjà établie à vérifier).
 * - `@SelfScoped()` — authentifiée (`AuthGuard`), mais sans code de permission séparé : la
 *   route n'agit jamais que sur la ressource de l'appelant lui-même (sa propre session, son
 *   propre mot de passe — `auth.sub`/`auth.session_id`, jamais un identifiant fourni par le
 *   client), donc la portée `OWN` est satisfaite par construction, pas par un octroi RBAC.
 *   Aucune permission de ce type n'existe dans la matrice (01-rbac.md §5) : en inventer une
 *   présenterait une exigence non écrite comme si elle l'était (CLAUDE.md règle #1).
 * - `@RequiresPermission(code)` — authentifiée et gouvernée par un octroi RBAC vérifié dans
 *   le contrôleur (`hasPermissionAt`/`evaluateAccess`, `identity/application/public`).
 * - `@CommandRegistryDelegated()` — `POST /api/v1/commands` : une seule route HTTP qui
 *   distribue vers de nombreux types de commande, chacun avec son propre `permissionCode`
 *   vérifié par `CommandPipelineService` (RC-01) à partir du registre — la couverture de
 *   *cette* route se prouve différemment (chaque commande enregistrée a un `permissionCode`
 *   nécessairement non vide, garanti par le type de `CommandHandlerRegistry.register`), pas
 *   route par route.
 */
import { SetMetadata } from '@nestjs/common';

export const ENDPOINT_AUTHORIZATION_KEY = 'endpointAuthorization';

export type EndpointAuthorization =
  | { readonly kind: 'PUBLIC' }
  | { readonly kind: 'SELF_SCOPED' }
  | { readonly kind: 'PERMISSION'; readonly permissionCode: string }
  | { readonly kind: 'COMMAND_REGISTRY_DELEGATED' };

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENDPOINT_AUTHORIZATION_KEY, { kind: 'PUBLIC' } satisfies EndpointAuthorization);

export const SelfScoped = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENDPOINT_AUTHORIZATION_KEY, { kind: 'SELF_SCOPED' } satisfies EndpointAuthorization);

export const RequiresPermission = (permissionCode: string): MethodDecorator & ClassDecorator =>
  SetMetadata(ENDPOINT_AUTHORIZATION_KEY, {
    kind: 'PERMISSION',
    permissionCode,
  } satisfies EndpointAuthorization);

export const CommandRegistryDelegated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENDPOINT_AUTHORIZATION_KEY, {
    kind: 'COMMAND_REGISTRY_DELEGATED',
  } satisfies EndpointAuthorization);
