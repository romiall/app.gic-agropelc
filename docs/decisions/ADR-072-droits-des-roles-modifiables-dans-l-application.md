# ADR-072 — Droits des rôles modifiables dans l'application

- **Statut** : ACCEPTÉ (CONFIRMÉ pour le besoin : décision du porteur du 08/11/2026, questionnaire de clôture Q28, réponse « autre » : « permissions modifiables par l'Admin et les profils de direction dans l'application » ; DÉDUIT pour la mise en œuvre et les gardes, défauts consignés dans AV-556)
- **Date** : 11/11/2026
- **Précise** : [ADR-008](ADR-008-rbac.md) (les douze rôles système restent définis par la graine versionnée ; leurs droits deviennent modifiables dans l'application, et la graine respecte ces changements)
- **Questions liées** : AV-257 (tranché par Q28), AV-092 (permissions sensibles : laissé à son défaut), AV-556 (défauts et limites de ce choix) ; UC-ADM-04 ; INV-ADM-01 (au moins un Admin actif : le rôle `ADMIN` est figé)

## Contexte

Les droits des douze rôles système étaient fixés dans le code (`db/seeds/rbac-data.ts`) et réappliqués à chaque livraison
(`db:seed`, insertion ou mise à jour de la portée et des limites de chaque octroi) ; l'Admin attribuait des rôles mais ne
changeait pas leurs droits (AV-257 (a)). La permission `identity.role.manage` (« Créer et modifier les rôles et leurs
permissions », Admin, portée `ALL`) figurait au catalogue sans aucun usage ; l'architecture de l'API annonçait une commande
`identity.role.set_permissions` jamais enregistrée. Le porteur a demandé le 08/11/2026 que l'Admin et la Direction puissent
modifier ces droits dans l'application.

Trois risques sont à tenir : l'élévation de droits (un compte qui s'accorde, ou accorde à d'autres, plus qu'il n'a), la perte
d'une décision prise dans l'application à la livraison suivante (la graine réécrivait chaque octroi), et la trace (qui a
changé quoi, quand et pourquoi).

## Décision

1. **Commande** `identity.role.permission.set` (agrégat `ROLE`, l'identifiant est celui du rôle) : `{ permissionCode, maxScope,
   reason }` — `maxScope` est la portée voulue (`OWN`, `TEAM`, `SITE`, `ZONE`, `ALL`) ou `null` pour retirer le droit ; le motif
   est obligatoire (500 caractères au plus). Droit requis : `identity.role.manage`, accordé à l'Admin et **désormais à la
   Direction** (portée `ALL` ; 569 octrois).
2. **Gardes** (`judgeRolePermissionChange`, `packages/domain/src/role-permissions.ts`, partagée avec l'écran) :
   - **on ne donne que ce qu'on a** : accorder une permission ou en élargir la portée exige que l'auteur la détienne, par une
     affectation **globale** en vigueur à `occurred_at`, à une portée qui couvre la portée demandée (`ALL` couvre tout ; une
     portée se couvre ; toute portée couvre `OWN` ; `TEAM`, `SITE` et `ZONE` ne se couvrent pas entre elles) ;
   - **on ne retire que ce qu'on aurait pu donner** : retirer ou réduire exige une portée qui couvre la portée actuelle du rôle ;
   - le rôle **`ADMIN` est figé** (rôle technique ; INV-ADM-01) et la permission **`identity.role.manage` ne se modifie jamais**
     dans l'application : personne ne s'en octroie le pouvoir, personne n'en prive l'Admin ;
   - une portée que la permission n'admet pas (`supported_scopes`) est refusée ; un changement sans effet aussi (`NO_CHANGE`).
3. **Journal en ajout seul** `identity_role_permission_changes` (migration `20261208090000`, déclencheurs contre la mise à jour
   et la suppression) : une ligne par commande appliquée — `GRANT`, `SCOPE` ou `REVOKE`, portée avant et après, motif, auteur,
   instant, identifiant de la commande. `identity_role_permissions` garde l'état en vigueur (un retrait supprime la ligne : la
   trace est dans le journal et dans l'audit du pipeline, qui reçoit la portée avant et après).
4. **Graine** : un couple (rôle, permission) qui a au moins une ligne au journal garde la décision prise dans l'application ; la
   graine ne le réinsère plus et n'en réécrit ni la portée ni les limites (`db/seeds/role-permission-plan.ts`). Les autres
   couples sont posés comme avant.
5. **Cache RBAC** : l'événement du pipeline (type de la commande) invalide **tout** le cache de l'API (`rbac-cache-consumer.ts`) —
   tous les titulaires du rôle sont concernés, et ces changements sont rares.
6. **Lectures** : `GET /roles/editable` (rôles actifs, `editable` faux pour `ADMIN`) et `GET /roles/{id}/permissions` (catalogue
   des permissions avec la portée accordée au rôle, les portées que le lecteur peut donner, le retrait possible, et les cent
   derniers changements du journal), au droit `identity.role.manage`.
7. **Écran** ECR-ADM-09 « Droits des rôles » (`/administration/droits-des-roles`, Admin et Direction, en ligne seulement) : choix
   du rôle, droits groupés par module avec recherche, changement d'un droit avec motif, historique du rôle. Il ne propose que ce
   que la commande acceptera.

## Conséquences

- Un changement s'applique au serveur dès la commande traitée (cache invalidé dans la seconde par le consommateur de l'API) ; il
  est audité et inscrit au journal du rôle ; une livraison ne le défait plus.
- **Limites connues** (AV-556) : l'affichage des écrans de l'application suit le **rôle** (registre des écrans), pas les droits :
  un droit ajouté ne fait pas apparaître d'écran, un droit retiré ne cache pas l'écran (le serveur refuse l'opération) ;
  l'évaluation d'un fait daté du passé (RC-01) emploie les droits **actuels** du rôle, comme pour un changement apporté par la
  graine ; un octroi fait dans l'application ne porte aucune limite (`limits` nul) ; seules les affectations globales de l'auteur
  comptent pour « ce qu'on a » ; les rôles eux-mêmes ne se créent pas dans l'application.

## Solutions écartées

- **Une commande qui remplace tout le jeu de droits d'un rôle** (`identity.role.set_permissions`) : deux éditions simultanées
  s'écraseraient, et l'audit d'un changement ne dirait pas lequel des cent trente droits a bougé.
- **Interdire à l'auteur de modifier un rôle qu'il détient** : sans effet contre l'élévation une fois la règle « on ne donne que
  ce qu'on a » posée, et bloquant pour un compte qui cumule des rôles de test pendant le pilote.
- **Une permission nouvelle pour l'éditeur** : `identity.role.manage` existait déjà au catalogue pour cet usage.
