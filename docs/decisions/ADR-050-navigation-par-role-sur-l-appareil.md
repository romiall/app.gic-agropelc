# ADR-050 — Navigation par rôle sur l'appareil : registre des écrans de la PWA et navigation mémorisée hors ligne

- **Statut** : PROPOSÉ (fork « Écrans PWA », à accepter à la fusion ; DÉDUIT, technique)
- **Date** : 10/10/2026

## Contexte

ECR-ADM-03 et UX-01 font de l'accueil la porte d'entrée de chaque rôle : de gros boutons d'action, puis les indicateurs. [ADR-030](ADR-030-accueil-par-role.md) le fait calculer par le serveur (`GET /api/v1/home`) et décide (§8) qu'une action n'a de `route` que si son écran existe dans la PWA, chaque phase renseignant la route dans `apps/server/src/home-api/role-catalog.ts`.

Deux faits rendent ce seul mécanisme insuffisant au moment où les écrans métier arrivent :

1. Les écrans sont livrés par un fork qui ne modifie pas le serveur ; tant que la session principale n'a pas renseigné les routes, toutes les actions restent « Bientôt », même celles dont l'écran existe.
2. L'accueil est une lecture en ligne, rien n'en est conservé sur l'appareil (ADR-030, Conséquences). Un vendeur qui ouvre l'application sans réseau ne voit aucune action, alors que la vente hors ligne est le cœur de sa journée (WF-J2, AV-025).

## Décision

1. **Registre des écrans dans la PWA** (`apps/pwa/src/app/screens.ts`) : pour chaque écran livré, son chemin, son groupe (ventes, stock…), les rôles à qui il est proposé (colonne « rôles » de `03-parcours-et-ecrans.md` §3) et les codes d'actions de l'accueil qui y mènent. Le registre ne contient que des écrans livrés.
2. **Route d'une action** : celle du serveur si elle est renseignée ; à défaut, celle de l'écran du registre qui porte ce code ; à défaut, l'action reste « Bientôt » (ADR-030 §8 inchangé : jamais de bouton qui ne mène nulle part).
3. **Navigation mémorisée** : à chaque réponse de l'accueil, l'appareil conserve, par utilisateur, ses rôles et les actions du jour de chaque rôle (store Dexie `navigation`, version 2 de la base locale), sans indicateur, montant ni activité. Elle est effacée à la déconnexion.
4. **Menu par rôle** (`/menu`) : les actions du jour qui mènent à un écran, puis les écrans proposés aux rôles de l'utilisateur, regroupés par domaine. Il se construit à partir de la navigation mémorisée et fonctionne hors ligne. L'accueil en erreur sans donnée y renvoie. La déconnexion quitte l'en-tête pour le menu (largeur de 375 px).
5. Les rôles du registre composent le menu ; ils n'autorisent rien. Le serveur revérifie chaque permission (07-security-rbac/01-rbac.md).

## Alternatives

- **Attendre que le serveur renseigne les routes** : bloque la livraison des écrans du fork et laisse sans action le vendeur hors ligne.
- **Conserver toute la dernière réponse de l'accueil** : afficherait hors ligne des indicateurs et montants dont la fraîcheur se dégrade ; ADR-030 réserve ce choix aux écrans qui le motivent. La navigation suffit au besoin.
- **Lire les rôles dans les affectations synchronisées** (jeu `role_assignment`) : la projection porte l'identifiant du rôle, pas son code, et aucun jeu ne publie les rôles.

## Conséquences

- La session principale renseigne, à la fusion ou plus tard, les routes des écrans livrés dans `role-catalog.ts` (besoin S-04 de `10-development-plan/15-ecrans-pwa.md`) ; le registre reste la source des écrans du menu, et une route du serveur l'emporte toujours.
- Chaque nouvel écran ajoute une entrée au registre, avec ses codes d'actions.
- L'index des décisions (`docs/decisions/README.md`) reçoit la ligne de cet ADR à la fusion.

## Risques

Divergence entre les rôles du registre et les permissions réelles : un écran proposé à un rôle qui n'a pas la permission renvoie un refus du serveur, expliqué à l'écran. Le test `screens.test.ts` vérifie l'unicité des codes et des chemins.
