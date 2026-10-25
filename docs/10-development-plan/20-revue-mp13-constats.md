# Revue adverse de MP-13 — constats non vérifiés (26/10/2026)

Ce fichier consigne ce que la revue adverse de MP-13 (écran des comptes, ECR-ADM-04) a produit avant de s’interrompre : la limite d’usage de la session a fait échouer 192 des 212 appels d’agents. **Les constats ci-dessous ont été rédigés par un premier relecteur ; 32 des 39 n’ont pas pu être revérifiés** (au moins un des deux vérificateurs a échoué : la ligne « Vérification » de chaque constat donne les verdicts obtenus, « ÉCHEC » quand l’agent n’a rien rendu). Il faut les rejouer un à un contre le code avant de les corriger : un constat non vérifié n’est pas un défaut établi.

L’angle « documentation et cohérence » n’a produit aucun constat (échec complet) : à refaire.

Angles couverts : ecran-pwa, lectures-et-actions, qualite-des-tests, refactor-grant, secret-et-autorisation.

## ecran-pwa-create-offline-faux-message — MEDIUM

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:346`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Tout échec autre que HTTP_ERROR (OFFLINE après délai de 30 s ou 502/503/504, SESSION_INVALID, SESSION_CHANGED) est présenté comme « Pas de réseau : le compte n'a pas été créé », sans relire la liste, alors que POST /users n'est pas idempotent.
- Scénario : L'Admin crée Paul. Le serveur insère le compte puis la passerelle répond 504 (ou le délai de 30 s expire). authorizedRequest renvoie OFFLINE, l'écran affirme que le compte n'a pas été créé, vide le mot de passe et ne relit pas la liste. L'Admin retape le mot de passe et renvoie, et obtient « Création refusée : Ce numéro est déjà utilisé par un compte actif » pour un compte qu'il ne voit pas. Un SESSION_INVALID (renouvellement refusé) affiche aussi « Pas de réseau ».
- Correction suggérée : Sur un échec non HTTP, relire la liste (setReload) et reformuler (« Réponse non reçue : vérifiez la liste avant de recommencer ») ; distinguer SESSION_INVALID et SESSION_CHANGED (reconnexion). Même distinction pour la réinitialisation. Ajouter un test de ce cas.

## lectures-et-actions-reactivate-numero-pris — MEDIUM

- Emplacement : `apps/server/src/identity-api/users-read.controller.ts:196`
- Vérification : CONFIRMED, CONFIRMED
- Constat : actions.reactivate est vrai pour un compte DÉSACTIVÉ même quand son numéro est désormais porté par un compte actif ; le serveur échouera sur la contrainte d'unicité.
- Scénario : Le compte A (+237...) est désactivé. L'Admin crée le compte B avec le même numéro par POST /users (permis : uq_identity_users_active_phone ne couvre que les comptes non désactivés). La liste rend reactivate=true pour A. Clic sur Réactiver : identity.user.reactivate (user-commands.ts:88-113) fait UPDATE status='ACTIVE' sans contrôle du numéro, MySQL lève ER_DUP_ENTRY ; le pipeline (command-pipeline.service.ts:588-602) traite toute erreur de gestionnaire comme transitoire : RETRY_LATER/SERVER_BUSY, commande FAILED_RETRYABLE puis COMMAND_STALLED, au lieu d'un rejet définitif. MP-13 rend le cas atteignable (création de comptes et réactivation depuis l'écran).
- Correction suggérée : Dans le gestionnaire reactivate, rejeter avec PHONE_ALREADY_USED si un autre compte non désactivé porte le numéro (même contrôle que create). Dans la lecture, mettre reactivate=false (avec motif) pour un DEACTIVATED dont le numéro est pris (requête groupée sur la page). Ajouter un test.

## qualite-des-tests-audit-sans-acteur-ni-createur — MEDIUM

- Emplacement : `apps/server/test/identity-users-admin.test.ts:216`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le test du chemin nominal ne vérifie de l'audit que [action, result] et l'absence de secret ; ni l'auteur, ni l'appareil, ni le contenu `after`, ni users.created_by ne sont affirmés.
- Scénario : Dans user-create.controller.ts:204 remplacer `actorUserId: auth.sub` par `actorUserId: userId` (ou `deviceId: auth.device_id` par un autre identifiant), ou, à la ligne 183, `created_by: toBin(auth.sub)` par `toBin(userId)`. Le journal attribue alors la création du compte au compte lui-même au lieu de l'Admin. Le test reste vert : il lit l'audit par entity_id et compare uniquement action et result, et le toMatchObject de la ligne 201 ignore created_by.
- Correction suggérée : Ajouter à la lecture de l'audit actor_user_id = admin.userId, device_id = admin.deviceId et `after` égal à {status:'ACTIVE', must_change_password:true, role_assignment_id}. Ajouter created_by = admin.userId sur la ligne identity_users.

## qualite-des-tests-droit-affecter-non-teste — MEDIUM

- Emplacement : `apps/server/test/identity-users-admin.test.ts:276`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le titre promet « droit d'affecter » mais aucun cas ne l'exerce : Direction n'a ni identity.user.manage ni identity.role_assignment.manage et est testée sans rôle.
- Scénario : Dans user-create.controller.ts:132-135, retirer la clause `(body.data.role === undefined || await hasPermissionAt(..., ROLE_ASSIGNMENT_MANAGE, now))`. Un acteur qui peut créer des comptes mais pas affecter pourrait alors poser un rôle (par exemple ADMIN GLOBAL) via POST /users, ce qui est une élévation de privilège. Aucun test n'échoue : le seul acteur autorisé est l'Admin, qui a les deux droits, et le seul refus utilisé est la Direction, rejetée dès le premier droit.
- Correction suggérée : Ajouter un acteur qui a identity.user.manage sans identity.role_assignment.manage (rôle de test via insertTestRole + grantTestPermission). Vérifier qu'un POST avec `role` renvoie 403 FORBIDDEN avec un audit DENIED et aucun compte créé, et qu'un POST sans `role` réussit. Sinon, renommer le test.

## qualite-des-tests-evenements-non-verifies — MEDIUM

- Emplacement : `apps/server/test/identity-users-admin.test.ts:215`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le commentaire affirme « aucune ligne dans la boîte de réception, aucun événement » (ADR-045), mais seule la boîte de réception est lue, filtrée sur l'Admin et le type identity.user.create. platform_domain_events n'est jamais interrogée.
- Scénario : Faire publier par le contrôleur un événement (identity.user.created) dont la charge contient le mot de passe provisoire, ou journaliser la charge sous un autre command_type. Le test passe : la requête de la ligne 226 ne voit que (user_id=admin, command_type='identity.user.create'), et aucun événement n'est cherché. Le contrat « le mot de passe ne figure jamais dans les événements » n'est donc pas prouvé pour la nouvelle route.
- Correction suggérée : Lire platform_domain_events (aggregate_id = id du compte, ou toutes les lignes créées pendant le test) et affirmer qu'elles sont vides ou ne contiennent pas PROVISIONAL. Pour la boîte de réception, ne pas filtrer par type : affirmer qu'aucune charge de l'Admin ne contient PROVISIONAL.

## qualite-des-tests-pwa-creation-hors-ligne-non-testee — MEDIUM

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:522`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le titre « création refusée (numéro déjà utilisé) ou sans réseau » promet deux cas, mais seul le refus 409 est testé ; la branche OFFLINE de la création (message users.create_offline) n'est jamais exercée, contrairement à la réinitialisation qui a son cas OFFLINE.
- Scénario : Dans UsersScreen.tsx:346 la branche `else onDone({ kind: 'OFFLINE' }, name)`, ou aux lignes 600-601 le choix de `users.create_offline`, peut être supprimé ou inversé (par exemple afficher « Création refusée : UNKNOWN » sans réseau). Tous les tests passent : le seul mock de `created` est la réponse 409 HTTP_ERROR.
- Correction suggérée : Ajouter, comme pour la réinitialisation (lignes 416-429), un second rendu avec `created: {ok:false, reason:'OFFLINE'}` et affirmer l'alerte « Pas de réseau », le formulaire conservé et le mot de passe vidé. Ou retirer « ou sans réseau » du titre.

## qualite-des-tests-pwa-resultat-de-commande-non-asserte — MEDIUM

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:579`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Les tests de suspension, réactivation, ajout et retrait de rôle ne contrôlent que la ligne de l'outbox. Le suivi par CommandResult (envoi, refus), le blocage des autres actions pendant l'attente et la relecture de la liste ne sont jamais vérifiés, bien que le titre du test de suspension dise « liste relue ».
- Scénario : Supprimer UsersScreen.tsx:611 (`<CommandResult messages="users.result" />`), ou corriger mal la clé de messages : aucun test ne change. Un refus serveur (LAST_ADMIN en désactivant ou retirant le dernier ADMIN, SCOPE_TYPE_NOT_ALLOWED, ROLE_INACTIVE) ne serait pas affiché à l'Admin, et le chemin de refus n'est pas testé. De même pour le verrou `blocked` : après envoi, `waiting` doit griser les confirmations (lignes 549-551).
- Correction suggérée : Après l'envoi, affirmer le message « Opération en cours d'envoi… ». Ajouter un cas où la commande de l'outbox passe REJECTED (last_error LAST_ADMIN) et affirmer l'alerte « Opération refusée : … » ; affirmer qu'une seconde confirmation est désactivée pendant l'attente. Retirer « liste relue » du titre ou l'affirmer réellement.

## qualite-des-tests-pwa-sans-droit-affecter-fixture-inoperante — MEDIUM

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:468`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le test « sans droit d'affecter (rôles refusés) : ni ... ajout ou retrait de rôle » utilise account() dont manageRoles est false. Les boutons « Ajouter un rôle » et « Retirer » sont donc absents quelle que soit la lecture des rôles, et le test ne prouve rien pour eux.
- Scénario : Supprimer `&& roles` à UsersScreen.tsx:835 : le test passe quand même. Le bouton « Retirer » (ligne 720) ne dépend que de user.actions.manageRoles, jamais de `roles`. Seul « Nouveau compte » (ligne 618) est réellement protégé. Avec manageRoles:true et la lecture des rôles en 403, le comportement attendu n'est ni défini ni vérifié.
- Correction suggérée : Reprendre le test avec `actions: {...NO_ACTIONS, manageRoles: true}` et roles non servi, puis affirmer la présence ou l'absence voulue de « Ajouter un rôle » et de « Retirer ». Renommer le test si seule l'absence de « Nouveau compte » est visée.

## qualite-des-tests-refactor-grant-validto-zone-team — MEDIUM

- Emplacement : `apps/server/test/identity-users-admin.test.ts:478`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le test « mêmes contrôles qu'avant » ne couvre pas ce que le refactor a déplacé dans insertRoleAssignment : validTo, validFrom = occurred_at, existence de la zone et de l'équipe. Aucun test ne le fait ailleurs, et le chemin ZONE/TEAM de POST /users n'est pas testé non plus.
- Scénario : Dans role-assignment-writer.ts:99 remplacer `valid_to: input.validTo ?? null` par `null`, ou dans role-assignment-commands.ts:106 omettre le spread de validTo. Une affectation temporaire accordée par la commande devient permanente. Autre cas : inverser scopeZoneId et scopeTeamId aux lignes 96-97 ou 192-194 du contrôleur. Aucun test de grant n'envoie validTo (les `validTo` de test/*.ts viennent de assignTestRole, pas de la commande) et aucun n'envoie scopeZoneId/scopeTeamId. Seul scopeSiteId est vérifié.
- Correction suggérée : Ajouter à ce test un grant avec validTo futur (lire valid_to et valid_from = occurred_at en base), un grant ZONE avec zone inconnue puis valide (rôle ayant ZONE, par exemple COMMERCIAL_TERRAIN), un grant TEAM, et le même POST /users avec role ZONE.

## qualite-des-tests-role-inactif-jamais-exerce — MEDIUM

- Emplacement : `apps/server/test/identity-users-admin.test.ts:350`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Aucun test n'utilise un rôle désactivé : ROLE_INACTIVE (POST /users et grant), le filtre is_active de GET /roles et celui de la liste des affectations restent sans preuve.
- Scénario : Supprimer `.where('is_active','=',1)` dans roles-read.controller.ts:43, ou la ligne `if (!role.is_active) return {code:'ROLE_INACTIVE'...}` dans role-assignment-writer.ts:54, ou `if (!row.is_active) continue` dans assignment-listing.ts:61. Un rôle désactivé devient proposé, affectable à un nouveau compte, ou reste affiché comme actif. Tous les tests passent. Le mapping REFUSAL_STATUS.ROLE_INACTIVE (user-create.controller.ts:92) n'est pas exercé non plus.
- Correction suggérée : Insérer un rôle de test (insertTestRole) puis le passer à is_active=0 par UPDATE. Affirmer : absent de GET /roles ; POST /users avec ce rôle renvoie 400 ROLE_INACTIVE et aucun compte ; la commande grant renvoie REJECTED ROLE_INACTIVE ; une affectation existante à un rôle devenu inactif disparaît de assignments.

## refactor-grant-no-change-feed — MEDIUM

- Emplacement : `apps/server/src/modules/identity/api/user-create.controller.ts:172`
- Vérification : CONFIRMED, CONFIRMED
- Constat : POST /users écrit le compte et l'affectation directement. Le chemin par la commande (pipeline) écrit en plus un événement de domaine et des lignes du flux de changements (USER, ROLE_ASSIGNMENT, portée GLOBAL), que ce contrôleur n'écrit pas.
- Scénario : L'Admin crée « Marie » par POST /users avec un rôle VENDEUR_PDV sur le site S1. La transaction n'écrit que l'utilisateur, l'affectation et l'audit : aucune ligne dans sync_change_feed et aucune dans platform_domain_events. Les jeux 'user' et 'role_assignment' (tirés par la PWA, apps/pwa/src/sync/pull.ts:42-44, projection USER servie à tous les appareils pour nommer les auteurs et titulaires, ADR-045 MP-08) ne publient donc jamais Marie. Sur un téléphone hors ligne, ses ventes ou visites s'affichent sans nom. Elle n'apparaît qu'après une commande qui touche son compte (suspension, par exemple). Avec identity.role_assignment.grant ou identity.user.create émise par commande, la ligne de repli GLOBAL serait émise (command-pipeline.service.ts:540-566).
- Correction suggérée : Dans la transaction de POST /users, appeler recordChanges (platform/sync/change-feed) pour {dataset:'user', entityType:'USER', entityId:userId, scopeType:'GLOBAL', scopeId:null} et, si une affectation est posée, pour {dataset:'role_assignment', entityType:'ROLE_ASSIGNMENT', entityId:assignmentId, scopeType:'GLOBAL'}. Écrire aussi les platform_domain_events correspondants si un consommateur doit les voir. Ajouter au test de création une assertion sur sync_change_feed (ou documenter explicitement dans AV-325/ADR-045 que le flux est volontairement omis).

## secret-et-autorisation-feed-user-manquant — MEDIUM

- Emplacement : `apps/server/src/modules/identity/api/user-create.controller.ts:172`
- Vérification : ÉCHEC, ÉCHEC
- Constat : POST /users n'écrit aucune ligne dans sync_change_feed (jeu 'user', entité USER, portée GLOBAL), alors que la commande identity.user.create la produisait via le repli du pipeline.
- Scénario : L'Admin crée « Paul Essomba » via POST /users. Le pipeline n'est pas traversé, donc il n'y a pas de ligne (dataset 'user', USER, GLOBAL). Les appareils tirent le jeu 'user' (apps/pwa/src/sync/pull.ts:42), jamais ce compte. Les écrans qui nomment des auteurs ou des titulaires à partir de refs.users (suivi des dépenses, factures et paiements fournisseurs, sélecteur de cible USER de ECR-CRM) affichent un identifiant court. Paul reste introuvable comme cible tant qu'une commande suspend, réactive ou désactive son compte. Le contrôle ne vient qu'avec le MP-13, la création ne touchant à la commande qu'à partir de ce point.
- Correction suggérée : Dans la transaction de create(), après l'insertion du compte, appeler recordChanges(trx, [{ dataset: 'user', entityType: 'USER', entityId: userId, scopeType: 'GLOBAL', scopeId: null, rowVersion: 1 }]) (platform/sync/change-feed.ts). La projection USER ne rend que id, nom et statut, donc aucun secret. Ajouter un test qui lit sync_change_feed pour le nouvel userId.

## ecran-pwa-annuler-pendant-envoi — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:761`
- Vérification : ÉCHEC, ÉCHEC
- Constat : « Annuler » reste actif pendant l'envoi (boutons lignes 218 et 413) alors que la requête continue ; onDone de la réinitialisation appelle setOpen(null) sans condition (ligne 763) et ferme un autre formulaire ouvert entre-temps.
- Scénario : Sur la fiche d'Awa, l'Admin envoie la réinitialisation puis clique « Annuler » (le formulaire disparaît mais la requête part quand même). Il ouvre ensuite la réinitialisation de Paul et commence à saisir. La réponse d'Awa arrive, onDone fait setOpen(null) : le formulaire de Paul est fermé, sa saisie perdue, et le message affiche la réinitialisation d'Awa. Pour la création, « Annuler » pendant l'envoi laisse croire à l'annulation alors que le compte est créé.
- Correction suggérée : Désactiver « Annuler » (et les autres ouvertures de formulaire) tant que sending est vrai, ou ne fermer le formulaire dans onDone que s'il est toujours celui de l'utilisateur concerné.

## ecran-pwa-auto-affectation-de-roles — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:720`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Les boutons « Retirer » (ligne 720) et « Ajouter un rôle » (ligne 835) ne tiennent pas compte de user.id === userId : l'écran propose à l'Admin de modifier ses propres rôles, alors que le serveur exclut le propre compte pour suspendre, désactiver et réinitialiser (users-read.controller.ts, AV-281).
- Scénario : Dans un parc à deux Admin, l'Admin retire sa propre affectation ADMIN (INV-ADM-01 reste respecté car un autre ADMIN existe). Ses droits tombent au prochain rafraîchissement et il perd l'accès à l'écran en pleine session. À l'inverse il peut s'ajouter lui-même un rôle sans validation d'un tiers. Aucune règle ni aucun test ne tranche ce point.
- Correction suggérée : Soit masquer ces actions sur son propre compte (et faire renvoyer manageRoles=false par le serveur pour soi), soit consigner la décision dans un AV et la tester.

## ecran-pwa-defaut-saisie-prematuré — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:401`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Dès le premier caractère du nom, newUserProblem renvoie PHONE (téléphone vide) et le message « Numéro de téléphone invalide : 9 chiffres… » s'affiche avant toute saisie du numéro ; pour un rôle qui ne permet ni GLOBAL ni SITE, SCOPE s'ajoute à scope_unavailable (role=alert) et dit deux fois la même chose.
- Scénario : L'Admin tape « P » dans « Nom complet » : un avertissement d'erreur sur le téléphone, qu'il n'a pas encore rempli, apparaît aussitôt (le garde `form.fullName &&` ne vérifie pas que le téléphone a été commencé, contrairement à MISMATCH qui attend la confirmation).
- Correction suggérée : N'afficher PHONE que si form.phone est non vide (comme pour la confirmation) et ne pas répéter SCOPE quand scope_unavailable est déjà affiché.

## ecran-pwa-focus-perdu — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:618`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le bouton qui ouvre un formulaire est retiré du DOM au moment du clic (« Nouveau compte » si !creating ligne 618 ; boutons d'action de la fiche si !mine ligne 819) et aucun focus n'est déplacé ni restitué : le focus clavier retombe sur le body.
- Scénario : Un utilisateur au clavier ou avec lecteur d'écran active « Réinitialiser le mot de passe de Awa » : le bouton disparaît, le focus est perdu, le premier champ du formulaire n'est pas annoncé ; il doit retraverser la page. De même à « Annuler » : le bouton d'origine réapparaît sans focus.
- Correction suggérée : Focaliser le premier champ à l'ouverture (autoFocus ou ref) et rendre le focus au bouton déclencheur (ou au titre de la fiche) à la fermeture.

## ecran-pwa-indicatif-code-en-dur — LOW

- Emplacement : `apps/pwa/src/features/users/users.ts:228`
- Vérification : ÉCHEC, ÉCHEC
- Constat : L'indicatif 237 est codé en dur : UsersScreen.tsx appelle newUserProblem(form, roles) (ligne 328) et createBody(form) (ligne 338) sans indicatif, alors que le paramètre crm.phone_default_country_code existe et est lu par NewProspectScreen (settingValue(refs.settings, ...) avec 237 en repli).
- Scénario : Le paramètre est modifié (autre pays d'exploitation) : la création d'un compte continue de préfixer +237 un numéro local, ce qui produit un numéro E.164 faux et un compte inatteignable à la connexion, sans que l'Admin soit prévenu. Viole la règle 8 de CLAUDE.md (seuils = paramètres) et diverge de l'écran de saisie d'un prospect.
- Correction suggérée : Lire le paramètre via refs.settings comme NewProspectScreen (repli 237) et le passer à newUserProblem et createBody.

## ecran-pwa-lecture-roles-muette — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:515`
- Vérification : ÉCHEC, ÉCHEC
- Constat : La lecture de GET /roles sert de test de droit, mais un échec réseau ou 5xx est traité comme un refus : aucun message, aucun bouton Réessayer, et rolesRead.retry n'est jamais appelé ni lié à useRefreshOnVisible.
- Scénario : À l'ouverture de l'écran, GET /roles échoue de façon passagère (503, coupure brève) alors que GET /users réussit. roles reste undefined : « Nouveau compte », « Ajouter un rôle » et les actions dépendantes disparaissent sans explication, indiscernables d'un manque de droit. Seul un rechargement de la page (ou un cycle hors ligne/en ligne) les ramène.
- Correction suggérée : Distinguer rolesRead.denied (aucune action) de rolesRead.failed (message et bouton de relecture), et brancher rolesRead.retry sur useRefreshOnVisible.

## ecran-pwa-prefixe-identity-trop-large — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:82`
- Vérification : ÉCHEC, ÉCHEC
- Constat : PREFIX = 'identity.' englobe les commandes d'appareils (identity.device.*, préfixe propre de DevicesScreen) : l'écran des comptes les adopte comme « dernière opération » et se bloque dessus.
- Scénario : L'Admin approuve ou bloque un appareil sur ECR-ADM-05 et la commande identity.device.approve reste WAITING (réponse lente, retenue derrière l'approbation de l'appareil). Il ouvre l'écran des comptes : lastWaitingCommand l'adopte (ligne 552), CommandResult l'affiche avec les messages users.result.* (« Opération en cours d'envoi… » sans dire laquelle) et pendingOps la rend bloquante. Suspendre, ajouter un rôle ou retirer un rôle restent désactivés tant que cette commande d'appareil n'a pas reçu de réponse.
- Correction suggérée : Suivre seulement identity.user. et identity.role_assignment. (deux appels de waitingCommands/waitingIds/lastWaitingCommand), ou filtrer sur ces deux préfixes.

## ecran-pwa-retrait-cible-ambigue — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:785`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le formulaire de retrait d'un rôle (« Retrait d'un rôle de X », « Confirmer le retrait du rôle ») ne nomme pas l'affectation visée, et le ReasonForm est réutilisé tel quel (même position, sans key) quand on clique « Retirer » sur une autre affectation du même compte : le motif saisi est conservé.
- Scénario : Awa a trois affectations. L'Admin clique « Retirer » sur la première, tape un motif, puis sur la troisième : la zone de motif garde le texte, le titre et le bouton n'indiquent aucun rôle ni site. Il confirme et révoque une affectation dont il ne voit plus l'identité sur le formulaire, avec un motif écrit pour une autre.
- Correction suggérée : Mettre key={mine.assignmentId} sur ReasonForm et inclure le rôle et le périmètre dans le titre et le libellé de confirmation (revoke_title et revoke_confirm avec {{role}}).

## ecran-pwa-send-sans-finally — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.tsx:331`
- Vérification : ÉCHEC, ÉCHEC
- Constat : send() de CreateForm (331-347) et de ResetForm (179-194) n'ont ni try ni finally : si authorizedRequest lève (ensureAccessToken/Dexie en échec), le mot de passe n'est pas vidé et sending reste vrai.
- Scénario : La base locale lève pendant le renouvellement du jeton. La promesse de void send() est rejetée sans catch, setSending(false) n'est jamais appelé : le bouton reste figé sur « Création… » et le mot de passe reste dans l'état React, lisible si la case « Afficher » est cochée. L'invariant « vidé après envoi, succès ET échec » est rompu. Les autres lectures de l'application (useOnlineRead) traitent déjà ce cas.
- Correction suggérée : Entourer l'appel d'un try/catch/finally : vider le mot de passe et la confirmation, setSending(false), et traiter l'exception comme un résultat OFFLINE ou une erreur inattendue.

## ecran-pwa-tests-n-assertent-pas-leurs-titres — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:477`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Plusieurs tests promettent plus que leurs assertions : « mot de passe jamais gardé » (477-520, 522-558) ne vérifie que outbox.count() === 0, sans fouiller les autres tables Dexie, localStorage ni sessionStorage ; « liste relue » du test de suspension (579-605) ne contient aucune assertion de relecture (getSyncEngine est neutralisé, la commande reste WAITING) ; aucun test ne couvre l'échec hors ligne de la création, l'exception de authorizedRequest, le blocage par une commande identity.device.*, ni le retrait de plusieurs affectations.
- Scénario : Une régression qui écrit le mot de passe dans une autre table locale (par exemple projections) ou dans localStorage ferait passer le test « jamais gardé » ; une régression qui supprime la relecture après une commande ferait passer le test de suspension. Les constats 1, 2, 4 et 5 ne seraient attrapés par aucun test.
- Correction suggérée : Parcourir toutes les tables Dexie et les stockages web à la recherche de la chaîne du mot de passe ; asserter la relecture (deuxième GET /users) après passage de la commande à SYNCED ; ajouter les cas manquants listés.

## lectures-et-actions-affectations-hors-portee — LOW

- Emplacement : `apps/server/src/identity-api/users-read.controller.ts:160`
- Vérification : CONFIRMED, CONFIRMED
- Constat : La portée du lecteur est jugée sur le compte, pas sur ses affectations : toutes les affectations actives d'un compte visible sont rendues (autres sites, zones, équipes, nom de rôle, validité).
- Scénario : Un Resp. ferme (identity.user.read SITE) du site S1 liste les comptes. U a une affectation SITE sur S1 et une autre sur S2 ou une affectation ZONE. U est visible via enrollerLocators ; la réponse donne à ce lecteur scopeSiteId=S2, scopeZoneId, roleName, validFrom/validTo hors de sa portée. Avant MP-13 seuls les codes de rôle sortaient (RC-04).
- Correction suggérée : Pour un lecteur sans portée ALL, ne rendre que les affectations dont le site ou la zone est dans sa portée (evaluateAccess avec {siteId}), ou ne rendre assignments qu'aux gestionnaires et laisser le seul roles[] aux autres. Ajouter un test de lecteur SITE avec un compte à deux sites.

## lectures-et-actions-appareil-non-actif — LOW

- Emplacement : `apps/server/src/identity-api/users-read.controller.ts:194`
- Vérification : CONFIRMED, REFUTED
- Constat : resetPassword est vrai sans tenir compte de l'appareil du lecteur, alors que POST /users/:id/reset-password (user-password.controller.ts:104-122) refuse tout appareil non ACTIVE par 403 DEVICE_PENDING ; même contrôle sur POST /users.
- Scénario : Un Admin se connecte depuis un appareil enrôlé en attente d'approbation. GET /users rend resetPassword=true ; le clic aboutit à un 403 audité (access.denied) au lieu d'un bouton masqué ou d'un motif clair.
- Correction suggérée : Évaluer checkDeviceActive pour request.auth.device_id dans la lecture et mettre resetPassword à faux (ou ajouter un champ deviceReady) ; idem pour la création côté écran.

## lectures-et-actions-manageroles-desactive — LOW

- Emplacement : `apps/server/src/identity-api/users-read.controller.ts:199`
- Vérification : CONFIRMED, PLAUSIBLE
- Constat : manageRoles est faux pour un compte désactivé alors que le serveur accepte la révocation (role-assignment-commands.ts:117-150 ne contrôle pas l'état de l'utilisateur) et que la liste affiche toujours ses affectations actives : l'Admin ne peut pas retirer ses rôles sans le réactiver.
- Scénario : L'Admin désactive un ancien employé qui garde une affectation ADMIN ou FINANCE. La liste montre l'affectation sans bouton de révocation. Pour la retirer il doit réactiver le compte, qui peut alors se reconnecter avec son ancien mot de passe avec tous ses droits tant que les rôles ne sont pas retirés.
- Correction suggérée : Séparer le droit de révoquer (vrai aussi pour un compte désactivé) du droit d'octroyer (faux), ou tracer la restriction en AV si elle est voulue.

## lectures-et-actions-soi-meme-non-impose — LOW

- Emplacement : `apps/server/src/identity-api/users-read.controller.ts:195`
- Vérification : CONFIRMED, CONFIRMED
- Constat : Les drapeaux suspend et deactivate (et le commentaire d'en-tête lignes 12-15) affirment « jamais sur son propre compte », mais ni les gestionnaires ni le pipeline ne l'imposent ; seul reset-password a RESET_OWN_PASSWORD. Le test identity-users-admin.test.ts:446 n'établit que le drapeau.
- Scénario : Deux Admins A et B actifs. A envoie (API directe ou commande restée dans la file) identity.user.deactivate sur son propre identifiant. Le pipeline ne contrôle que hasPermissionAt (command-pipeline.service.ts:457) ; hasOtherActiveAdmin trouve B ; le compte de A est désactivé et ses sessions révoquées. Le drapeau false ne reflète pas ce que le serveur autorise.
- Correction suggérée : Imposer la règle dans suspend et deactivate (rejet si aggregate_id === author_user_id) avec test, ou retirer l'affirmation du commentaire et du test et la tracer en AV.

## lectures-et-actions-tests-lacunaires — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:408`
- Vérification : ÉCHEC, PLAUSIBLE
- Constat : Le test des lectures ne prouve ni la fenêtre temporelle des affectations, ni la portée du lecteur sur les affectations, ni l'accord drapeau/serveur pour les cas limites.
- Scénario : Aucun test ne couvre les affectations expirées (valid_to passé), futures (valid_from > now), à rôle inactif ou révoquées, ni un lecteur SITE voyant un compte aux affectations multiples, ni la réactivation d'un compte désactivé dont le numéro est repris. Le commentaire de la ligne 446 ne prouve que le drapeau, pas la règle serveur. Une régression sur ces points passerait.
- Correction suggérée : Ajouter des cas aux dates limites et à rôle inactif ; un lecteur SITE avec un compte à deux sites ; la réactivation avec numéro repris ; pour « soi-même », un test serveur du refus ou retirer l'affirmation.

## qualite-des-tests-auto-gestion-roles-non-affirmee — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:446`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le commentaire dit « les rôles restent gérables » pour soi-même, mais l'assertion de `self.actions` ne porte que sur resetPassword, suspend et deactivate ; manageRoles et reactivate ne sont pas affirmés.
- Scénario : Dans users-read.controller.ts:199 transformer `manageRoles: user.status !== 'DEACTIVATED' && canAssign` en `!self && ...`. L'Admin ne voit plus d'actions de rôle sur sa propre ligne (ou l'inverse après un autre changement), sans qu'aucun test ne signale la rupture de la règle décrite.
- Correction suggérée : Ajouter `manageRoles: true, reactivate: false` à l'assertion de self.actions.

## qualite-des-tests-fenetre-validite-affectations — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:463`
- Vérification : ÉCHEC, ÉCHEC
- Constat : La liste des affectations n'est testée que pour le cas révoqué ; les filtres de période (valid_from futur, valid_to échu) de listActiveAssignmentsOfUsers ne le sont pas, alors que le titre parle d'« affectation retirée ».
- Scénario : Dans assignment-listing.ts supprimer `if (row.valid_to !== null && row.valid_to <= at) continue` (ligne 62) ou `.where('a.valid_from','<=',at)` (ligne 56). Une affectation expirée ou pas encore commencée s'affiche comme active, et l'écran propose de la retirer ou refuse de la rajouter (doublon). Seule la révocation est vérifiée (lignes 464-475).
- Correction suggérée : Insérer avec assignTestRole une affectation à validTo passé et une à validFrom futur pour un compte du test, et affirmer qu'elles sont absentes de assignments et de roles.

## qualite-des-tests-pwa-ordre-des-defauts-et-role-sans-perimetre — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:250`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le titre annonce « défauts de saisie dans l'ordre », mais chaque cas modifie un seul champ d'une base valide : l'ordre NAME, PHONE, EMAIL, rôle, mot de passe n'est pas prouvé. Les rôles sans périmètre proposable ne sont pas testés dans l'écran.
- Scénario : Intervertir les contrôles aux lignes 275-277 de users.ts, ou faire passer le mot de passe avant le rôle : les tests restent verts. Pour les rôles dont allowedScopeTypes ne contient ni GLOBAL ni SITE (RESP_COMMERCIAL ['TEAM','ZONE'], COMMERCIAL_TERRAIN ['ZONE'] dans le seed, 2 rôles sur 11), l'alerte scope_unavailable (UsersScreen.tsx:285-289) et le blocage de « Créer le compte » ne sont pas testés. Seul scopeTypesFor([]) l'est, en unitaire.
- Correction suggérée : Ajouter des cas à défauts multiples (nom vide et téléphone invalide donnent NAME, etc.) et un test d'écran sélectionnant un rôle ZONE/TEAM : alerte visible et bouton désactivé.

## qualite-des-tests-pwa-secret-garde-assertion-limitee — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:477`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le titre « mot de passe jamais gardé » n'est prouvé que par outbox.count() == 0 et le démontage du formulaire ; les autres stockages locaux ne sont pas inspectés, et le démontage à la réussite vide l'état de toute façon.
- Scénario : Si CreateForm copiait le mot de passe dans une table Dexie autre que l'outbox (projections, journal local), dans sessionStorage ou dans un state remonté, aucun test n'échouerait : seule l'outbox est comptée (lignes 511 et 557).
- Correction suggérée : Après la création, parcourir toutes les tables Dexie (db.tables.toArray) et localStorage/sessionStorage, et affirmer que 'provisoire-1' n'apparaît nulle part. Idem après la réinitialisation.

## qualite-des-tests-pwa-tomatchobject-trop-permissif — LOW

- Emplacement : `apps/pwa/src/features/users/UsersScreen.test.tsx:627`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Les charges des commandes sont comparées par toMatchObject : `payload: {}` accepte n'importe quel objet, et le grant GLOBAL n'exclut pas un scopeSiteId résiduel. `aggregate_id).not.toBe(AWA_ASSIGNMENT)` n'établit pas non plus un identifiant frais valide.
- Scénario : La réactivation envoie `{reason:'x'}`, ou le grant ADMIN GLOBAL envoie en plus `scopeSiteId` (la saisie garde siteId depuis l'essai précédent sur le site, lignes 642-649) : le toMatchObject des lignes 623-628 et 656-660 passe, alors que le serveur rejetterait la charge GLOBAL avec un site (superRefine de role-assignment-commands). Seul le test unitaire de grantPayload protège, pas le câblage de l'écran.
- Correction suggérée : Utiliser toEqual sur command.payload (payload `{}` pour la réactivation ; `{userId, roleId, scopeType:'GLOBAL'}` sans scopeSiteId), et affirmer que aggregate_id est un UUID.

## qualite-des-tests-roles-non-fuite-assertion-faible — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:402`
- Vérification : ÉCHEC, ÉCHEC
- Constat : `expect(JSON.stringify(roles)).not.toContain('permission')` ne prouve pas l'absence de permissions dans GET /roles : une fuite sous une autre clé passe, et une description de rôle contenant ce mot ferait échouer le test.
- Scénario : Ajouter au contrôleur `grants: [...]` ou `perms` : le test reste vert. À l'inverse, une description du seed contenant « permissions » (le mot figure déjà dans des descriptions de permissions du seed) casserait le test sans fuite.
- Correction suggérée : Comparer les clés exactes : `expect(Object.keys(role).sort()).toEqual(['allowedScopeTypes','code','description','id','isSystem','name'])` pour chaque rôle.

## qualite-des-tests-telephone-course-et-suspendu — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:333`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le contrôle préalable de doublon (controller:153-165) et le rattrapage ER_DUP_ENTRY (controller:221-228) aboutissent tous deux à 409 PHONE_ALREADY_USED en séquentiel : aucun des deux n'est prouvé isolément, et le cas d'un compte SUSPENDED n'est pas testé.
- Scénario : Supprimer le bloc catch/isDuplicateEntry : une vraie course (deux POST simultanés du même numéro) renvoie 500 au lieu de 409, test vert. Supprimer le contrôle préalable seul : le test reste vert car l'index uq_identity_users_active_phone lève ER_DUP_ENTRY, que le catch convertit en 409. Un `!= 'DEACTIVATED'` changé en `= 'ACTIVE'` est de même masqué, puisque l'index couvre aussi les comptes suspendus.
- Correction suggérée : Ajouter un test lançant deux create concurrents avec le même numéro (Promise.all) : un 201 et un 409. Ajouter un doublon contre un compte SUSPENDED (insertTestUser status SUSPENDED) attendu en 409.

## refactor-grant-tests-gaps — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:478`
- Vérification : CONFIRMED, CONFIRMED
- Constat : Le test « octroi par commande après le refactor : mêmes contrôles qu'avant » ne couvre pas tout le périmètre du writer, alors qu'il prétend le faire.
- Scénario : Aucun test (ni ici ni dans role-assignment-commands.test.ts) ne couvre ROLE_INACTIVE : ni sa conversion en REJECTED par la commande, ni son statut 400 dans REFUSAL_STATUS de POST /users. La branche validTo (spread conditionnel de role-assignment-commands.ts:106 et valid_to ?? null du writer) n'est pas testée. Zone introuvable et équipe introuvable ne le sont pas non plus. Les colonnes valid_from et created_by écrites par le writer ne sont vérifiées pour aucun appelant. Une régression sur ces branches (par exemple valid_to ignoré, ou ROLE_INACTIVE mal converti en erreur transitoire) passerait toutes les suites.
- Correction suggérée : Ajouter des cas : rôle désactivé (is_active=0) via la commande (REJECTED/ROLE_INACTIVE) et via POST /users (400, compte non créé) ; commande avec validTo futur puis lecture de valid_to ; scope_zone_id et scope_team_id inexistants (NOT_FOUND) ; assertion de valid_from et created_by sur l'affectation créée par chaque chemin.

## secret-et-autorisation-audit-sans-role-ni-portee — LOW

- Emplacement : `apps/server/src/modules/identity/api/user-create.controller.ts:211`
- Vérification : ÉCHEC, ÉCHEC
- Constat : L'audit de la création n'enregistre pas le rôle ni le périmètre de l'affectation initiale (seulement role_assignment_id), contrairement à la commande identity.role_assignment.grant dont l'audit contient la charge complète (roleId, scopeType, site).
- Scénario : L'Admin crée un compte avec le rôle ADMIN en GLOBAL. La ligne d'audit identity.user.create porte after = { status, must_change_password, role_assignment_id }. Une revue d'audit « qui a reçu quel rôle, quand » ne le voit pas dans le journal. Il faut relire identity_user_role_assignments, qui admet la révocation, et aucun événement identity.role_assignment.grant n'existe non plus pour un consommateur ou une alerte futurs.
- Correction suggérée : Ajouter à after le role_id, le scope_type et les identifiants de site, zone ou équipe de l'affectation (ni mot de passe ni téléphone). Ou écrire un second recordAudit « identity.role_assignment.grant » avec la même forme que la commande.

## secret-et-autorisation-json-invalide-journalise — LOW

- Emplacement : `apps/server/src/platform/http/api-error.filter.ts:56`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Une erreur d'analyse JSON du corps (SyntaxError de Fastify, statusCode 400, qui n'est pas une HttpException) tombe dans la branche 500 du filtre, qui journalise exception.message à 'error'. Ce message, sous Node 20 et plus, inclut un extrait du texte du corps ; POST /users, comme reset-password, y met un mot de passe en clair.
- Scénario : Un client script envoie un corps JSON mal formé du type {"phone":"+237...","password":"Provis0ire!" ,} : le journal applicatif reçoit « Unexpected token '}', ..."Provis0ire!" ,}... is not valid JSON », soit un fragment du mot de passe provisoire dans les logs, contraire à l'esprit d'ADR-045. La réponse client est un 500 INTERNAL_ERROR au lieu d'un 400 (vérifier : le message exact dépend de Node 24.15 et de Fastify 5.12.5).
- Correction suggérée : Dans le filtre, traiter les erreurs portant un statusCode 4xx (Fastify) comme des 400 VALIDATION_ERROR avec un message générique, sans journaliser exception.message. Pour les routes à secret, ne jamais journaliser le message brut d'une erreur d'analyse du corps.

## secret-et-autorisation-test-aucun-evenement-non-verifie — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:215`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le commentaire affirme « aucune ligne dans la boîte de réception, aucun événement », mais seul sync_command_inbox est interrogé ; platform_domain_events ne l'est pas.
- Scénario : Un développeur ajoute un événement de domaine dans la route de création avec le téléphone ou un champ sensible. Le test passe, alors que la garantie d'ADR-045 (« ni par un événement ») est rompue.
- Correction suggérée : Interroger platform_domain_events (aggregate_id = nouvel userId, ou event_type LIKE 'identity.user.%') et vérifier 0 ligne, et que le JSON de toute ligne trouvée ne contient ni le mot de passe ni le téléphone.

## secret-et-autorisation-test-droit-d-affecter-non-prouve — LOW

- Emplacement : `apps/server/test/identity-users-admin.test.ts:276`
- Vérification : ÉCHEC, ÉCHEC
- Constat : Le test annonce « droit d'affecter » mais n'exerce jamais le cas identity.user.manage sans identity.role_assignment.manage : seul DIRECTION (qui n'a aucun des deux droits) est refusé.
- Scénario : Une régression retire la seconde condition du contrôle (lignes 132-135 du contrôleur : le test body.data.role === undefined || hasPermissionAt(ROLE_ASSIGNMENT_MANAGE)). Tout appelant avec identity.user.manage pourrait alors donner n'importe quel rôle à la création, y compris ADMIN. Le test reste vert car le refus de DIRECTION vient déjà de USER_MANAGE.
- Correction suggérée : Ajouter un acteur muni de user.manage mais sans role_assignment.manage (rôle de test dédié, ou retrait d'un octroi sur la base jetable). Vérifier que POST avec rôle donne 403 audité et qu'aucun compte n'est créé, et que le même POST sans rôle réussit.
