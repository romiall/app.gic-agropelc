# ADR-071 — Jeu `role_assignment` restreint à l'utilisateur de l'affectation

- **Statut** : ACCEPTÉ (CONFIRMÉ pour la restriction : décision du porteur du 08/11/2026, questionnaire de clôture Q24, réponse A ; DÉDUIT pour la mise en œuvre ; AV-550 à AV-552 posent les points que cette décision ne tranche pas)
- **Date** : 08/11/2026
- **Précise** : [ADR-045](ADR-045-mots-de-passe-hors-journal-et-charge-sans-secret.md) (ce que l'appareil reçoit des comptes), `06-offline-sync/02-synchronisation.md` § 5.2 (périmètre de téléchargement) et § 5.3 (`SCOPE_EXIT`), dictionnaire `identity.user_role_assignments` (« Offline DL (ses propres affectations) »)
- **Questions liées** : AV-533 (point S-41 (a)), AV-520 (S-19), AV-195 (3), AV-196, AV-521, AV-550 à AV-552 ; BR-SYN-007 (aucun fait accompli rejeté : le protocole d'envoi des commandes ne change pas)

## Contexte

Le jeu `role_assignment` était publié en portée `GLOBAL` : par le repli générique du pipeline (une ligne par commande appliquée,
`command-pipeline.service.ts`, jeu = type d'agrégat en minuscules), par la création d'un compte avec son premier rôle
(`POST /users`) et par deux scripts d'exploitation du kit. La projection `ROLE_ASSIGNMENT` servait toute ligne, et le périmètre
d'un appareil contient toujours `GLOBAL` (`sync-pull.service.ts`). Chaque téléphone recevait donc **toutes les affectations de
rôle de l'entreprise** : qui détient un rôle, sur quel site, quelle zone ou quelle équipe, depuis quand et jusqu'à quand. Le
code du rôle n'y figurait pas (le point S-41 (a) d'AV-533 a été retiré à la revue du 07/11/2026 pour cette raison : il aurait
désigné les comptes Admin, Direction et Finance), mais l'identifiant du rôle, lui, y était.

L'appareil n'en emploie que celles de son utilisateur : `allowedZoneIds` (nouveau prospect, prise de service) et `expenseSites`
(dépense, réception libre) filtrent sur `user_id`. Le dictionnaire de données disait déjà « Offline DL (ses propres
affectations) » : le code allait au-delà du dictionnaire. Un téléphone perdu exposait l'organisation des droits sans que rien
de cette liste serve à son porteur.

Le porteur a choisi, à la question Q24 du questionnaire de clôture, de **restreindre le jeu aux affectations de l'utilisateur**
(solution A) plutôt que de le laisser tel quel (B) ou de le supprimer en faisant lire les rôles dans le profil de connexion (C).

## Décision

1. **Une affectation est publiée à son utilisateur seul.** `identity`, propriétaire de la table, émet une ligne `UPSERT` de
   portée `USER` dont `scope_id` est le titulaire de l'affectation (`emitRoleAssignmentChange`,
   `identity/application/sync-changes.ts`), à la `version` de l'affectation. Elle est appelée :
   - par l'écrivain partagé `insertRoleAssignment` : donc par `identity.role_assignment.grant`, par `POST /users` (premier rôle)
     et par les scripts d'exploitation du kit (`grant-test-access.mjs`, `import-reporting-commercial.mjs`,
     `init-bonaberi-stock.mjs`), qui n'écrivent plus rien eux-mêmes dans le flux ;
   - par `identity.role_assignment.revoke`, qui republie l'affectation avec son `revoked_at` (l'appareil la garde, elle n'est
     plus en vigueur) ;
   - par `db/seeds/create-local-admin.ts` (SQL brut) et `apps/server/scripts/demo-data.ts` (développement local).

   Aucune ligne n'est écrite à l'échéance d'une affectation (`valid_to`) : l'appareil juge la validité à son heure
   (`inForce`), comme le serveur (`isActiveAt`). Une affectation n'a pas d'état « suspendu » (colonnes `valid_from`, `valid_to`,
   `revoked_at`) ; la suspension d'un compte ne touche pas ses affectations.
2. **La projection ne sert que cette ligne.** `ROLE_ASSIGNMENT` répond `undefined` pour toute portée autre que `USER` et pour
   une ligne `USER` dont la portée n'est pas le titulaire (la requête est bornée par `user_id`) : une ligne mal émise ne sert
   personne. La ligne `GLOBAL` du repli du pipeline reste insérée à chaque octroi et à chaque révocation (le pipeline n'offre pas
   d'exception par type d'agrégat, comme pour `DEVICE`, AV-195 (3)) mais n'est servie à personne : le tirage la saute. Le
   périmètre de l'appareil contient toujours `USER:<utilisateur>` (`device-scope.ts`) : rien ne change dans la lecture.
3. **Retrait de l'existant dans le flux : migration `20261207090000`.** Elle n'écrit que dans `sync_change_feed` :
   - une ligne `SCOPE_EXIT` de portée `GLOBAL` par affectation déjà publiée en `GLOBAL` ;
   - une ligne `UPSERT` de portée `USER` par affectation, à sa version courante (en vigueur ou non, révoquée ou échue comprises :
     voir AV-550). C'est ce rattrapage qui permet à un appareil neuf, et à un appareil déjà alimenté, de recevoir les siennes
     alors que les lignes `GLOBAL` ne sont plus servies ; il rattrape aussi les affectations posées par des scripts qui ne
     publiaient rien (le rôle du responsable commercial de Bonabéri, 08/11/2026).

   `SCOPE_EXIT` plutôt que `DELETE` : la PWA l'applique en retirant le périmètre `GLOBAL` de la projection de l'appareil et la
   projection elle-même s'il ne lui en reste aucun (`applyChange`, 02-synchronisation § 5.3), **quel que soit l'ordre
   d'application** avec la ligne `USER` ; un `DELETE` supprimerait l'affectation propre de l'appareil si la ligne `USER` le
   précédait. Le flux est en ajout seul : les anciennes lignes `UPSERT` `GLOBAL` ne sont pas supprimées. La compaction
   (BR-SYN-015) les purge comme les autres quand elles sont remplacées depuis plus de 60 jours et ne supprime jamais la dernière
   ligne d'une clé : le `SCOPE_EXIT` reste, donc un appareil absent plus de 60 jours reçoit son retrait à son retour.
4. **Retrait sur les appareils déjà alimentés : aucun code de PWA.** À son premier tirage du jeu après la mise en ligne du
   serveur, un appareil reçoit les `SCOPE_EXIT` `GLOBAL` : les affectations des autres comptes, qu'il avait reçues par
   l'ancienne ligne `GLOBAL`, quittent ses projections ; la sienne, que la ligne `USER` du rattrapage lui rend, reste avec le
   seul périmètre `USER`. Les autres jeux, les curseurs et la file d'envoi ne sont pas touchés. La logique est celle de P2 :
   un appareil non mis à jour la fait déjà ; il n'a pas à attendre la nouvelle version de la PWA. Prouvé sur la vraie
   `applyChange` et `runPullCycle` par `apps/pwa/src/sync/role-assignment-transition.test.ts`.
5. **Appareil neuf** : il ne reçoit que les lignes `USER` de son utilisateur ; les anciennes lignes `UPSERT` `GLOBAL` sont sautées
   par la projection, les `SCOPE_EXIT` n'ont rien à retirer.
6. **Tablette partagée** : inchangée. L'appareil ne détient les jeux que d'un utilisateur à la fois (`ensureDataOwner`, ADR-037) :
   au changement d'utilisateur, projections et curseurs sont effacés et l'utilisateur suivant repart de zéro dans son propre
   périmètre, donc avec ses seules affectations.
7. **Ce qui ne change pas.** Le serveur reste juge (`FORBIDDEN_SCOPE`, `ZONE_NOT_ALLOWED`) ; `allowedZoneIds` et `expenseSites`
   continuent de borner les zones et les sites d'après les affectations de l'utilisateur ; l'écran des comptes (ECR-ADM-04) lit
   `GET /users` en ligne, pas ce jeu ; le protocole d'envoi, les enveloppes et l'idempotence des commandes ; la fiche `USER`
   (nom et statut, ADR-045), les sites, zones, équipes et appartenances restent servis comme avant. Le code du rôle n'est
   toujours pas servi (AV-552).

## Conséquences

- Un téléphone perdu n'expose plus qui détient quel rôle sur quel périmètre : il ne porte que les affectations de l'utilisateur
  dont il détient les données. Restent exposés, hors de ce lot : les noms et statuts des comptes (ADR-045), les sites, zones,
  équipes et appartenances aux équipes.
- Coût : le tirage de chaque appareil lit une ligne `GLOBAL` inerte de plus par octroi ou révocation (AV-551) ; le flux garde une
  ligne `SCOPE_EXIT` par affectation publiée avant la livraison et une ligne `USER` par affectation ; sur la base d'essai
  chargée (`gic_agropelc_rp`) : 231 retraits et 11 563 republications, appliqués en 5 secondes.
- Limites : un appareil qui n'a pas synchronisé depuis la livraison garde les affectations des autres jusqu'à son premier tirage.
  Pour un appareil perdu avant, le recours reste la mise hors service et l'effacement des données (AV-521). Pendant la
  livraison, le serveur en marche garde l'ancien code jusqu'au redémarrage (`remote-update.sh` : migrations et semis, puis
  redémarrage) : une affectation accordée dans cet intervalle n'a que sa ligne `GLOBAL` et n'atteint pas les appareils de son
  titulaire (ils proposent alors toutes les zones et tous les sites, le serveur reste juge). Le remède est de rejouer la seconde
  instruction de la migration, qui n'ajoute que des lignes redondantes (une mise à jour de plus, sans effet) pour les
  affectations déjà publiées, ou de révoquer puis rétablir l'affectation.
- Retour arrière : le `down` de la migration supprime les lignes qu'elle a ajoutées et les lignes `USER` du jeu ; les appareils
  qui avaient déjà appliqué le retrait ne retrouvent pas les affectations des autres comptes (que personne n'a à regretter).
- Tests : `apps/server/test/sync-role-assignment-scope.test.ts` (octroi, appareil du titulaire, second appareil, appareil d'un
  autre compte, de l'administrateur et tablette partagée, révocation, lignes `GLOBAL` héritées et lignes mal émises, rattrapage),
  `apps/server/test/identity-users-admin.test.ts` (création d'un compte), `db/tests/role-assignment-feed-migration.test.ts`
  (le SQL de la migration), `apps/pwa/src/sync/role-assignment-transition.test.ts` (le retrait sur l'appareil).
