# ADR-030 — Accueil par rôle : une page de référence calculée à la demande, composée dans la couche de transport

- **Statut** : ACCEPTÉ (la forme — indicateurs, urgences, signaux, actions du jour propres à chaque utilisateur — est une demande du porteur du projet, CONFIRMÉE ; le reste est DÉDUIT, technique ; le contenu précis de chaque rôle reste DÉDUIT de `04-acteurs-et-roles.md` §2)
- **Date** : 08/10/2026 (rédigé après coup : la décision a été appliquée par le code livré avec P4-04 et P4-05 ; le code la cite depuis lors)

## Contexte

ECR-ADM-03 (« Accueil par rôle », `03-parcours-et-ecrans.md`) et UX-01 demandent un écran d'accueil propre au rôle : de gros boutons d'action, puis quelques indicateurs personnels ; un utilisateur à plusieurs rôles voit l'union de leurs actions. Le plan l'avait prévu « vide » en P0 et « enrichi à chaque phase ». Le porteur a précisé le besoin au début d'octobre 2026 : non pas une liste d'actions, mais une **page de référence taillée sur mesure pour chaque utilisateur**, avec ses indicateurs, ses urgences, ses signaux et ses actions à exécuter.

Le module `analytics` (D11 : tableaux de bord, instantanés `kpi_snapshots`, explorateur) n'existe pas avant la phase P9. Or les chiffres de l'accueil existent dès maintenant dans les modules propriétaires (ventes, stock, trésorerie, portefeuille clients, achats, production, validations, conflits de synchronisation). Aucune source du dépôt ne dit où composer ces chiffres en attendant.

## Décision

1. **Une seule lecture**, `GET /api/v1/home`, à portée propre (`@SelfScoped`) : elle ne lit que ce que les rôles actifs de l'appelant, à l'instant présent, lui donnent ; aucun identifiant fourni par le client n'élargit la lecture. La réponse est définie une fois, dans `packages/contracts/src/home.ts` (schéma `homeResponseSchema`), et le serveur la valide avant de la renvoyer : un écart avec le contrat est une erreur du serveur, jamais de la PWA.
2. **Structure de la réponse** : des **signaux** (urgences et points d'attention, toutes fonctions confondues, triés par gravité `CRITICAL`, `WARNING`, `INFO`), puis **une section par rôle actif** de l'utilisateur (actions du jour, indicateurs, activité récente). L'union des sections réalise UX-01. Une section dont les chiffres sont à zéro reste affichée : un indicateur à zéro est une information.
3. **Tout est calculé à la demande** à partir des opérations (BR-ANA-001) : rien n'est stocké, saisi ni mis en cache côté serveur. La réponse porte l'instant du calcul (`generatedAt`) et le jour métier (`Africa/Douala`) pour afficher la fraîcheur (BR-ANA-005).
4. **Où cela vit** : `apps/server/src/home-api/` (`home-service.ts`, `role-catalog.ts`, `home-format.ts`, contrôleur, module), **couche de transport** comme `sales-api/` et `finance-api/`, pas un module métier : elle n'écrit aucune table, n'en possède aucune et n'importe que l'**API publique** des modules propriétaires. Chaque module expose ses chiffres dans un fichier `application/public/home-metrics.ts` (ou équivalent) et les traduit en SQL sur **ses propres tables** : le service d'accueil ne lit jamais une table d'un autre module.
5. **Périmètre d'un rôle** (`ROLE_CATALOG`, `scopeKind`), DÉDUIT de la matrice acteurs × domaines (D04-acteurs §4) : `ALL` (Direction, Administrateur, Finance, Achats, Production), `TEAM` (Resp. commercial : son équipe et lui-même), `OWN` (commerciaux : eux-mêmes), `SITES` (vendeur de PDV, Resp. ferme, magasinier : les sites de leur affectation, un site ou ceux d'une zone). Le périmètre voyage sous la forme de `ReadScope` (`platform/read-scope.ts`) : **un périmètre vide ne lit rien, jamais tout** — une affectation absente ne doit pas élargir la lecture.
6. **Droits sur les mesures** (BR-ANA-004) : les montants de valeur (stock) exigent `inventory.valuation.read` ; sans ce droit, l'indicateur de valeur n'est ni calculé ni renvoyé. Le contrat admet `value: null` pour une mesure non disponible (aucune donnée, droit manquant), que les prochains indicateurs de mesure financière pourront utiliser quand l'écran doit dire « non disponible » plutôt que se taire.
7. **Codes des indicateurs** : le code du dictionnaire D11 §7.1 quand l'indicateur y figure (`KPI-COM-08`, `KPI-FIN-01`…), un code local sinon (suffixe, ex. `KPI-COM-08-S` pour la semaine). Deux écrans ne doivent pas afficher deux valeurs pour un même indicateur, une même période et un même périmètre (BR-ANA-009) : une valeur de l'accueil se calcule par la fonction du module propriétaire que les tableaux de bord de P9 appelleront.
8. **Actions** : une action n'a de `route` que si l'écran existe dans la PWA ; sinon elle s'affiche « bientôt » et ne mène nulle part. On n'affiche jamais un bouton qui ne fait rien en prétendant le contraire. Chaque phase qui livre un écran renseigne la route de son action dans `role-catalog.ts`.

## Alternatives

Créer dès maintenant le module `analytics` : prématuré (D11 suppose les instantanés, l'explorateur et l'ordonnanceur de P9) et dupliquerait les requêtes des modules. Composer côté PWA, par plusieurs lectures (`/sales`, `/stock`, `/cash-accounts`…) : plusieurs allers-retours sur un réseau lent, périmètre à reproduire sur l'appareil, droits de mesure répétés à chaque lecture. Instantanés stockés (`analytics.kpi_snapshots`) : périmés dès qu'une vente est enregistrée, alors que l'accueil sert à décider maintenant ; ils restent pertinents pour les séries longues de P9.

## Justification

La forme vient du porteur. Le reste applique les règles du dépôt : calcul à partir des opérations (BR-ANA-001), frontières de modules (aucune lecture croisée de tables), portée par rôle (BR-ANA-004, ADR-008), contrat unique partagé (ADR-021, règle 6 de `CLAUDE.md`). La couche de transport est déjà le lieu des lectures composées (`sales-api/`, `finance-api/`) ; l'accueil en est la plus transverse.

## Conséquences

- Chaque phase qui ajoute une fonction enrichit le `home-metrics.ts` de son module et le catalogue des rôles, sans toucher au contrat tant qu'un nouveau type de bloc n'est pas nécessaire.
- Quand `analytics` existera (P9), l'accueil continue d'appeler les fonctions des modules, ou celles d'`analytics` si elles les enveloppent, **sans changer `HomeResponse`** : la PWA n'est pas touchée.
- La lecture est en ligne. Hors ligne, la PWA affichera sa dernière réponse avec sa fraîcheur (`generatedAt`) ; le comportement exact se précise avec les écrans (aucun écran métier n'existe encore).
- Le contenu de chaque rôle (quels indicateurs, quelles actions, dans quel ordre) est DÉDUIT de `04-acteurs-et-roles.md` §2 ; il se relit avec le porteur à la première démonstration d'écran.

## Risques

Une erreur de périmètre expose les chiffres d'une autre équipe ou d'un autre site : l'accueil doit être testé avec un périmètre étroit et avec le périmètre vide (qui ne lit rien). Au moment de cette rédaction, le contrat est testé (`packages/contracts/src/home.test.ts`) mais la lecture `GET /api/v1/home` n'a pas encore de test serveur : c'est un écart connu, à combler avant d'étendre l'accueil. Coût d'un appel (plusieurs requêtes par rôle, lancées en parallèle) : à mesurer avant tout cache. Dérive entre l'accueil et les tableaux de P9 : traitée par la règle 7 (une seule fonction par indicateur).
