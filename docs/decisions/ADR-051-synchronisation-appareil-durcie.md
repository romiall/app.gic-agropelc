# ADR-051 — Synchronisation de l'appareil : joignabilité réelle du serveur, décompte jusqu'au tirage, reprise des envois, un seul titulaire des données, enveloppe immuable

- **Statut** : PROPOSÉ (fork « Écrans PWA », à accepter à la fusion ; DÉDUIT, technique)
- **Date** : 10/10/2026 (révisé le même jour après la seconde revue adverse du fork : §2 retiré et remplacé, §7 à §10 ajoutés)

## Contexte

Les premiers écrans de vente hors ligne (ECR-VEN-01 à 05) s'appuient sur le moteur de synchronisation de P0-14 (`apps/pwa/src/sync/`). Une revue adverse du fork (quatre dimensions, chaque constat vérifié par un sceptique) a confirmé cinq défauts de ce socle, que les écrans rendent visibles :

1. **Réseau supposé** : `captured_offline` et le blocage local de la vente (AV-025) dépendaient de `navigator.onLine`, qui reste vrai sur un Wi-Fi sans accès Internet. Une vente faite sans serveur joignable partait marquée « en ligne », sans blocage local ; le serveur la jugeait ensuite comme une vente en ligne et pouvait la refuser pour une raison d'état (stock, crédit), contre BR-SYN-007.
2. **Décompte retiré trop tôt** : une vente acceptée (`SYNCED`) cessait d'être retirée du disponible local avant que le solde téléchargé l'inclue. Un envoi réussi suivi d'un tirage interrompu faisait réapparaître la marchandise vendue (01-architecture-offline.md §4 demande l'inverse).
3. **Envoi interrompu** : une commande restée `SYNCING` (onglet fermé pendant l'envoi) n'était jamais renvoyée.
4. **Données de plusieurs utilisateurs** : projections et curseurs n'étaient pas cloisonnés. L'utilisateur suivant d'un même appareil voyait les clients et les ventes du précédent, et ne recevait pas les lignes de son propre périmètre plus anciennes que les curseurs.
5. **Jeu non servi** : le jeu `allocations` était tiré alors que le serveur n'a pas encore de lecteur `STOCK_ALLOCATION` (P5-18). Le curseur dépassait des lignes jamais servies, qui auraient été perdues pour l'appareil.

## Décision

1. **Joignabilité** (`platform/connectivity.ts`) : l'appareil est hors ligne si l'interface réseau est coupée **ou** si le dernier cycle de synchronisation n'a pas pu joindre le serveur, jusqu'au cycle suivant qui y parvient. Cet état décide du bandeau, du blocage local et de `captured_offline` à la saisie.
2. **Enveloppe immuable** : une commande enregistrée dans l'outbox n'est plus jamais modifiée, `captured_offline` compris. L'empreinte d'idempotence du serveur (`payload_hash`, calculée sur toute l'enveloppe, `command-pipeline.service.ts`) doit rester identique au renvoi : un envoi coupé après réception par le serveur, puis renvoyé avec une enveloppe différente, serait refusé (`COMMAND_ID_REUSED`) alors qu'il est appliqué. La première version de cet ADR passait `captured_offline` à vrai au premier envoi échoué ; ce choix est retiré. `captured_offline` vaut l'état de joignabilité du §1 au moment de la saisie ; une saisie faite juste après la perte du réseau, avant le premier cycle en échec, part marquée « en ligne » (besoin S-13 côté serveur).
3. **Décompte jusqu'au tirage** : une commande acceptée garde son heure d'acceptation (`synced_at`). Chaque jeu garde l'heure de départ de la dernière requête d'un tirage complet (`pulled_at`). Une vente ou une commande acceptée reste retirée du disponible tant que le jeu `stock` n'a pas été tiré entièrement après son acceptation. Les jeux d'exploitation (`stock`, `orders`, `sales_recent`, `cash`, `customers`) sont tirés en premier.
4. **Reprise** : au démarrage du moteur, les commandes `SYNCING` repassent `PENDING_SYNC`. Le serveur est idempotent (`command_id`).
5. **Un seul titulaire des données** : l'appareil note l'utilisateur dont il détient les jeux (`data_user_id`). À la première synchronisation d'un autre utilisateur, projections et curseurs sont effacés et retéléchargés dans son périmètre. L'outbox n'est jamais touchée.
6. **Jeu `allocations` non tiré** tant que le serveur ne le sert pas (besoin S-05). Il sera ajouté avec le lecteur de P5-18.
7. **Erreur du serveur ≠ réseau perdu** : une réponse HTTP d'erreur prouve que le serveur est joignable (`SERVER_ERROR`) ; seuls un échec de connexion, une requête sans réponse dans le délai (30 s, 60 s pour un lot de commandes) ou une passerelle sans serveur (502, 503, 504) rendent l'appareil hors ligne. Une erreur sur un jeu n'interrompt pas le tirage des autres ; la synchronisation n'est alors pas complète (`last_sync_at` inchangé).
8. **Commandes de l'auteur seulement** : un lot ne contient que les commandes de l'utilisateur de la session. Le serveur refuse définitivement une commande dont l'auteur n'est pas l'utilisateur authentifié ; celles d'un autre utilisateur de l'appareil attendent sa reconnexion.
9. **Session gardée sur une erreur passagère** : un renouvellement de jeton refusé par 400, 401 ou 403 invalide la session ; une autre réponse (429, 5xx) la garde et le renouvellement est retenté.
10. **Relance immédiate** : un déclenchement reçu pendant un cycle (une saisie, le retour du réseau) provoque un cycle de plus dès la fin du cycle en cours, au lieu d'attendre le déclenchement périodique. Le décompte « en vol » du §3 s'applique aussi aux livraisons et commandes (jeu `orders`) et à l'encours des clients (jeu `customers`). Le propriétaire des données d'un appareil antérieur à ce champ est adopté sans effacement.

La base Dexie n'est pas renumérotée : les nouveaux champs ne sont pas indexés.

## Alternatives

- **Sonder le serveur avant chaque saisie** : ajoute une requête et une attente à chaque vente, et ne protège pas mieux qu'un cycle récent. Rejeté.
- **Comparer les versions de ligne (`row_version`) des soldes** : la projection `STOCK_BALANCE` a toujours `row_version` = 1 et le solde agrège tous les lots. Le critère d'heure est le seul disponible.
- **Cloisonner chaque jeu par utilisateur** (jeux personnels et jeux du PDV partagés, 01-architecture-offline.md §6) : c'est la cible de la tablette partagée (AV-007). Elle suppose de savoir, jeu par jeu, ce qui est personnel ; l'effacement au changement d'utilisateur est sûr dès maintenant, au prix d'un retéléchargement.

## Conséquences

- Sur une tablette partagée, chaque changement d'utilisateur retélécharge les jeux. Acceptable tant que les volumes restent ceux du §3.1. Le cloisonnement fin viendra avec les écrans de P5.
- Le disponible local peut être sous-estimé entre une acceptation et le tirage suivant ; il n'est jamais surestimé (AV-025 : prévenir plutôt que réconcilier).
- Une saisie faite dans les secondes qui suivent la perte du réseau, avant qu'un cycle l'ait constatée, part marquée « en ligne » : le serveur peut la refuser pour une raison d'état. Le serveur pourrait exclure `captured_offline` de l'empreinte, ou juger « hors ligne » une commande reçue longtemps après `occurred_at` (S-13).
- La session principale ajoute `allocations` à `KNOWN_DATASETS` en même temps que le lecteur `STOCK_ALLOCATION` (P5-18).
- L'index des décisions (`docs/decisions/README.md`) reçoit la ligne de cet ADR à la fusion.

## Risques

L'horloge de l'appareil sert aux deux heures comparées (`synced_at`, `pulled_at`). Elles sont prises sur le même appareil, donc un décalage avec le serveur ne fausse pas la comparaison. Un recul de l'horloge entre l'envoi et le tirage maintiendrait le décompte jusqu'au tirage suivant, ce qui est sans danger. Tests : `apps/pwa/src/sync/sync-hardening.test.ts`, `apps/pwa/src/features/sales/sale-logic.test.ts`.
