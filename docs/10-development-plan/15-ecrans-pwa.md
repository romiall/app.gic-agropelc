# Écrans PWA des phases au code serveur terminé (fork « Écrans PWA »)

> Suivi du fork ouvert le 10/10/2026, en parallèle de la fin de P5 côté serveur. Branche locale `claude/pwa-ecrans` (worktree `.claude/worktrees/pwa-ecrans`), partie de `a1fa2c6` (P5-13). Périmètre : les écrans de la PWA (`apps/pwa`) des phases dont le code serveur est terminé, dans l'ordre socle de l'appareil, navigation par rôle, ventes (P4), puis stock, CRM, achats, production et administration des prix si le temps le permet. Hors périmètre : écrans de P5 (ECR-DIS-01 à 04, ECR-FIN-05, ECR-STK-06), P8, P9, P10.
>
> Règles du fork : aucune modification de `apps/server`, `db`, `packages/domain`, `packages/contracts` ; un besoin côté serveur est consigné au § 4 et l'écran s'adapte ; une question métier non couverte devient un AV numéroté de 300 à 349 (§ 5), avec un défaut paramétrable ; une décision structurante devient un ADR numéroté de 050 à 059 (§ 6). Ce fichier est mis à jour à chaque commit du fork.

---

## 1. Incréments livrés

| # | Incrément | Commit | Contenu |
|---|---|---|---|
| F-01 | Socle de l'appareil : jeux publiés depuis P1 | `215aedb` | `KNOWN_DATASETS` étendu aux 22 jeux publiés depuis P1 (34 en tout) (catalogue, prix, stock, quotas, CRM, achats, production, commandes, ventes récentes, caisses, communications) ; `SCOPE_EXIT` retiré par périmètre (une entité tenue par plusieurs périmètres reste tant qu'il en reste un) ; lecture typée des projections (`storage/projections.ts`, crochet `useProjected`) |
| F-02 | Navigation par rôle ([ADR-050](../decisions/ADR-050-navigation-par-role-sur-l-appareil.md)) | `9fd96f7` | Registre des écrans livrés (`app/screens.ts`) ; route d'une action de l'accueil complétée par l'appareil quand le serveur renvoie `route: null` ; navigation mémorisée par utilisateur (store `navigation`, version 2 de la base locale) ; menu par rôle `/menu`, utilisable hors ligne, lien depuis l'en-tête et depuis l'accueil en erreur ; déconnexion déplacée dans le menu |
| F-03 | ECR-VEN-01 « + Nouvelle vente » | _à venir_ | Couche de données des ventes (`features/sales/`) : référentiels lus sur l'appareil, prix par `resolvePrice` avec le canal déduit comme le serveur (BR-VEN-021), disponible local (solde moins opérations en attente), blocage hors ligne par `decideLocalConsumption` (AV-025), envoi par l'outbox et suivi du résultat (UX-05). Écran : emplacement prérempli, client de passage ou identifié, articles (conditionnements, poids, dérogation de prix avec motif), encaissement prérempli au total, référence exigée selon le moyen. Correctif du socle : clé locale d'un solde de stock = emplacement × produit |

## 2. Écrans

Statut des écrans touchés par le fork (le statut de référence reste dans [`03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md)).

| Écran | Route PWA | Statut | Hors ligne | Notes |
|---|---|---|---|---|
| ECR-ADM-03 | `/` et `/menu` | Enrichi (F-02) | Menu : oui ; accueil : non | Actions routées par le registre de l'appareil (ADR-050) |
| ECR-VEN-01 | `/ventes/nouvelle` | Livré (F-03) | Oui, dans la limite du stock exclusif ; emplacement partagé bloqué hors ligne tant que les quotas ne sont pas servis (S-05) | Action `NEW_SALE` |

## 3. Vérifications

| Incrément | Tests PWA (vitest) | Typecheck | ESLint | Prettier | Navigateur |
|---|---|---|---|---|---|
| F-01 | 96 verts (15 fichiers) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-02 | 105 verts (17 fichiers) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-03 | 17 verts sur les ventes (logique et écran, dont une vente hors ligne) | OK | OK | OK | Différé : connexion requise (voir § 7) |

## 4. Besoins côté serveur et contrats

Constats faits en construisant les écrans, sans modification du serveur ni des contrats dans le fork. À reprendre par la session principale.

| # | Besoin | Pourquoi | Adaptation côté PWA en attendant |
|---|---|---|---|
| S-01 | Jeux `catalog` et `pricing` de l'architecture cible (01-architecture-offline.md §3.1) : le serveur publie les produits, unités, catégories, motifs, règles de prix, campagnes et fournisseurs par le repli générique du pipeline, un jeu par type d'agrégat (`product`, `price_rule`…), portée `GLOBAL` | Le nom du jeu dépend de l'`aggregate_type` choisi par l'appareil émetteur ; le filtre « produits vendables × zones × sites du périmètre » de `pricing` n'existe pas | La PWA tire chaque jeu par type d'agrégat (`pull.ts`) |
| S-02 | Projection `PRODUCT_STANDARD_COST` servie à tout appareil qui tire le jeu `product_standard_cost` | RC-05 : aucun coût sur l'appareil | La PWA ne tire pas ce jeu |
| S-03 | Tirage de plusieurs jeux par appel (`GET /sync/pull?datasets=…`) | 34 jeux = 34 appels par cycle de synchronisation (toutes les 30 s) | Appels successifs, un par jeu |
| S-04 | Renseigner dans `apps/server/src/home-api/role-catalog.ts` la route des actions dont l'écran est livré par le fork (ADR-030 §8) : voir le registre `apps/pwa/src/app/screens.ts` (`actionCodes`) | Sans route du serveur, l'appareil complète seul ; une route du serveur l'emporte | Registre des écrans de l'appareil (ADR-050) |
| S-05 | Lecteur de projection `STOCK_ALLOCATION` (jeu `allocations`, prévu en P5-18) : les lignes sont émises mais aucun lecteur ne les sert | Sans quota sur l'appareil, `decideLocalConsumption` bloque toute vente hors ligne sur un emplacement partagé (AV-025) | Quota tenu pour absent ; vente hors ligne possible sur un stock à garde exclusive, ou si le site autorise le dépassement (`sales.offline_over_allocation_allowed`) |
| S-06 | Profondeur de zone (`zone_depth`) absente de la projection `PRICE_RULE` | `resolvePrice` en a besoin pour la spécificité | Lue dans la projection `ZONE` de la règle (à défaut 1) |
| S-07 | Unités (`catalog_units`) et canaux de vente non synchronisés (aucun lecteur) ; données semées absentes du flux, sauf les moyens de paiement | Libellés d'unités et canaux inconnus de l'appareil ; un appareil neuf ne reçoit ni produits ni paramètres semés | Codes d'unité affichés tels quels ; canal déduit et envoyé explicitement ; paramètres absents = valeurs par défaut |
| S-08 | Une règle de prix retirée ou annulée n'est jamais retirée de l'appareil (pas de `DELETE` ni de `SCOPE_EXIT`) | Prix catalogue périmé hors ligne jusqu'à la fin de validité de la règle | Le serveur signale `PRICE_MISMATCH` ; en ligne, `PRICE_OUTDATED` est expliqué à l'écran |

## 5. AV proposés

Plage réservée au fork : AV numérotés de 300 à 349. Chaque point est à reporter dans [`A-VALIDER.md`](../A-VALIDER.md) par la session principale lors de la fusion ; le défaut est implémenté de façon paramétrable.

Tant qu'ils ne sont pas reportés dans le registre, `check_refs.py` signale ces AV comme références orphelines : c'est attendu, la fusion les définit.

| AV | Question | Défaut implémenté | Classe |
|---|---|---|---|

## 6. ADR proposés

Plage réservée au fork : ADR numérotés de 050 à 059.

| ADR | Décision |
|---|---|
| [ADR-050](../decisions/ADR-050-navigation-par-role-sur-l-appareil.md) | Navigation par rôle sur l'appareil : registre des écrans de la PWA, route complétée par l'appareil, navigation mémorisée hors ligne (store `navigation`), menu `/menu`. Ligne d'index à ajouter dans `docs/decisions/README.md` à la fusion |

## 7. Environnement du fork

- Serveurs de développement lancés depuis le worktree par deux entrées ajoutées au `.claude/launch.json` du dépôt principal (fichier local non versionné) : `fork-pwa:server` (port 3000, base `gic_agropelc_dev`) et `fork-pwa:pwa` (port 5173). L'outil d'aperçu lit la configuration du dépôt principal, pas celle du worktree ; les entrées `server:dev` et `pwa:dev` existantes sont inchangées.
- Vérification dans le navigateur : la connexion avec le compte administrateur local exige de saisir ses identifiants, que le fork ne lit ni ne recopie ; le porteur se connecte lui-même dans le panneau du navigateur, puis le fork poursuit.
