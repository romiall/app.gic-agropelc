# Écrans PWA des phases au code serveur terminé (fork « Écrans PWA »)

> Suivi du fork ouvert le 10/10/2026, en parallèle de la fin de P5 côté serveur. Branche locale `claude/pwa-ecrans` (worktree `.claude/worktrees/pwa-ecrans`), partie de `a1fa2c6` (P5-13). Périmètre : les écrans de la PWA (`apps/pwa`) des phases dont le code serveur est terminé, dans l'ordre socle de l'appareil, navigation par rôle, ventes (P4), puis stock, CRM, achats, production et administration des prix si le temps le permet. Hors périmètre : écrans de P5 (ECR-DIS-01 à 04, ECR-FIN-05, ECR-STK-06), P8, P9, P10.
>
> Règles du fork : aucune modification de `apps/server`, `db`, `packages/domain`, `packages/contracts` ; un besoin côté serveur est consigné au § 4 et l'écran s'adapte ; une question métier non couverte devient un AV numéroté de 300 à 349 (§ 5), avec un défaut paramétrable ; une décision structurante devient un ADR numéroté de 050 à 059 (§ 6). Ce fichier est mis à jour à chaque commit du fork.

---

## 1. Incréments livrés

| # | Incrément | Commit | Contenu |
|---|---|---|---|
| F-01 | Socle de l'appareil : jeux publiés depuis P1 | _à venir_ | `KNOWN_DATASETS` étendu aux 22 jeux publiés depuis P1 (34 en tout) (catalogue, prix, stock, quotas, CRM, achats, production, commandes, ventes récentes, caisses, communications) ; `SCOPE_EXIT` retiré par périmètre (une entité tenue par plusieurs périmètres reste tant qu'il en reste un) ; lecture typée des projections (`storage/projections.ts`, crochet `useProjected`) |

## 2. Écrans

Statut des écrans touchés par le fork (le statut de référence reste dans [`03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md)).

| Écran | Route PWA | Statut | Hors ligne | Notes |
|---|---|---|---|---|

## 3. Vérifications

| Incrément | Tests PWA (vitest) | Typecheck | ESLint | Prettier | Navigateur |
|---|---|---|---|---|---|
| F-01 | 96 verts (15 fichiers) | OK | OK | OK | Différé : connexion requise (voir § 7) |

## 4. Besoins côté serveur et contrats

Constats faits en construisant les écrans, sans modification du serveur ni des contrats dans le fork. À reprendre par la session principale.

| # | Besoin | Pourquoi | Adaptation côté PWA en attendant |
|---|---|---|---|
| S-01 | Jeux `catalog` et `pricing` de l'architecture cible (01-architecture-offline.md §3.1) : le serveur publie les produits, unités, catégories, motifs, règles de prix, campagnes et fournisseurs par le repli générique du pipeline, un jeu par type d'agrégat (`product`, `price_rule`…), portée `GLOBAL` | Le nom du jeu dépend de l'`aggregate_type` choisi par l'appareil émetteur ; le filtre « produits vendables × zones × sites du périmètre » de `pricing` n'existe pas | La PWA tire chaque jeu par type d'agrégat (`pull.ts`) |
| S-02 | Projection `PRODUCT_STANDARD_COST` servie à tout appareil qui tire le jeu `product_standard_cost` | RC-05 : aucun coût sur l'appareil | La PWA ne tire pas ce jeu |
| S-03 | Tirage de plusieurs jeux par appel (`GET /sync/pull?datasets=…`) | 34 jeux = 34 appels par cycle de synchronisation (toutes les 30 s) | Appels successifs, un par jeu |

## 5. AV proposés

Plage réservée au fork : AV numérotés de 300 à 349. Chaque point est à reporter dans [`A-VALIDER.md`](../A-VALIDER.md) par la session principale lors de la fusion ; le défaut est implémenté de façon paramétrable.

Tant qu'ils ne sont pas reportés dans le registre, `check_refs.py` signale ces AV comme références orphelines : c'est attendu, la fusion les définit.

| AV | Question | Défaut implémenté | Classe |
|---|---|---|---|

## 6. ADR proposés

Plage réservée au fork : ADR numérotés de 050 à 059.

| ADR | Décision |
|---|---|

## 7. Environnement du fork

- Serveurs de développement lancés depuis le worktree par deux entrées ajoutées au `.claude/launch.json` du dépôt principal (fichier local non versionné) : `fork-pwa:server` (port 3000, base `gic_agropelc_dev`) et `fork-pwa:pwa` (port 5173). L'outil d'aperçu lit la configuration du dépôt principal, pas celle du worktree ; les entrées `server:dev` et `pwa:dev` existantes sont inchangées.
- Vérification dans le navigateur : la connexion avec le compte administrateur local exige de saisir ses identifiants, que le fork ne lit ni ne recopie ; le porteur se connecte lui-même dans le panneau du navigateur, puis le fork poursuit.
