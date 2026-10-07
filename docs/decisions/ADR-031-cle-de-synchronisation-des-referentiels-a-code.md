# ADR-031 — Clé de synchronisation des référentiels dont la clé primaire est un code

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; sans effet sur une règle métier)
- **Date** : 07/10/2026

## Contexte

Le flux de changements (`sync_change_feed`, 06-offline-sync/02-synchronisation.md §5.1) identifie une entité par `entity_id`, un UUID (`binary(16)`). Quelques référentiels ont pour clé primaire un **code** : les moyens de paiement (`finance_payment_methods.code`, AV-056), les unités (`catalog_units.code`) et les canaux de vente (`catalog_sales_channels.code`). P1-06 avait laissé les unités et les canaux sans projection, faute de clé : l'identifiant d'agrégat d'une commande de création est sans rapport avec le code, et aucun repli n'aurait été correct (commentaire de `sync/entity-projections.ts`). P4-11 doit pourtant servir les moyens de paiement hors ligne (01-architecture-offline.md §3.1, jeu `catalog`) : un encaissement hors ligne choisit un moyen, sa référence obligatoire et son compte par défaut. Les moyens de paiement n'ont de plus aucune commande d'administration : ils viennent du seed.

## Décision

1. **Clé dérivée.** L'`entity_id` d'une entité à clé `code` est un **UUID version 5** (RFC 9562, SHA-1) du nom `<TYPE>:<code>` (ex. `PAYMENT_METHOD:ESPECES`) dans un espace de noms fixe, `6f1d3c2a-8b4e-5d7f-9a10-2c3e4f5a6b7c`, qui ne change jamais. La clé est stable, reproductible par toute écriture du flux et ne demande aucune colonne nouvelle.
2. **Projection.** Le lecteur de `sync/entity-projections.ts` retrouve l'entité en recalculant la clé de chaque ligne de la table (quelques lignes) ; la donnée servie porte le code, que l'appareil utilise dans ses commandes.
3. **Publication par le seed.** Un référentiel sans commande d'administration est publié par le seed : une ligne `UPSERT`, portée `GLOBAL`, par entité et par `version`, ajoutée seulement si elle n'existe pas (rejouable). Une future commande d'administration publiera de même, avec la clé dérivée.
4. **Deux implémentations, une valeur.** Le calcul vit dans `apps/server/src/platform/sync/code-entity-id.ts` et, le paquet `db` n'important pas le serveur, dans `db/seeds/code-entity-id.ts` ; les deux tests épinglent la même valeur (`PAYMENT_METHOD:ESPECES` → `a54b88b0-36c9-59e3-8d51-3464ef06b112`).

## Mise en œuvre (P4-11, 07/10/2026)

Moyens de paiement : jeu `catalog`, type d'entité `PAYMENT_METHOD` (code, libellé, référence obligatoire, type de compte par défaut, actif, version). Les unités et les canaux de vente peuvent suivre la même règle ; leurs commandes de création (P1) publient encore le seul repli générique et restent servies en ligne (`GET /units`, `GET /sales-channels`).

## Alternatives

- **Colonne `id` UUID ajoutée aux tables à code** : migration et double clé (le code reste la clé des références), pour un besoin propre à la synchronisation. Écartée.
- **Élargir `sync_change_feed.entity_id` à une chaîne** : touche le noyau `sync-core`, ses index et le contrat partagé avec l'appareil, pour trois petites tables. Écartée.
- **Glisser les moyens de paiement dans un autre jeu** (par exemple dans chaque compte du jeu `cash`) : duplication et sémantique trompeuse. Écartée.

## Conséquences

- Le flux du jeu `catalog` porte des lignes `GLOBAL` de type `PAYMENT_METHOD` ; tout appareil les reçoit.
- Un changement de libellé ou de statut d'un moyen de paiement doit incrémenter sa `version` pour être republié par le seed.
- Les référentiels du seed autres que les moyens de paiement (motifs, sources de prospects, étapes, paramètres) ne sont pas encore publiés dans le flux ; c'est un écart distinct, signalé hors de cet ADR.
