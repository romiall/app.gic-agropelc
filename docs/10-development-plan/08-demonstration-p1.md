# Démonstration de sortie de phase P1

> Plan §4 (P1 — Référentiels métier). Critère : « Catalogue et grille tarifaire administrables ; moteur de prix identique sur l'appareil et le serveur ». État arrêté le 26/09/2026, à la fin des éléments de code de P1 (P1-01 à P1-06).

---

## 1. Aucun AV bloquant

Confirmé en début de phase (checklist §2) : P1 n'a aucun AV **bloquant**. Les AV importants/secondaires listés (AV-003 zones, AV-017 catégories de client, AV-018 canaux, AV-031 poids/unité, AV-061 dimensions tarifaires, AV-062 activation, AV-080 conditionnements) restent `OUVERT` au registre — leurs valeurs par défaut documentées y ont été implémentées de façon **paramétrable** (référentiels en base, jamais codés en dur) :

- AV-017 : `catalog.customer_categories` — table vide au démarrage, alimentée par `catalog.customer_category.create` (aucune des 5 valeurs suggérées n'est pré-semée : à la différence du RBAC, aucune décision GIC ne fixe encore la liste réelle).
- AV-018 : `catalog.sales_channels` — même principe.
- AV-031 : `catalog_products.pricing_mode` (`PER_UNIT` par défaut, `PER_WEIGHT` supporté).
- AV-061 : le moteur (`resolvePrice`) supporte toutes les dimensions du PM §9 (zone, site, catégorie client, canal, quantité, campagne) sans qu'aucune ne soit privilégiée en dur — seule la formule de spécificité (BR-PRX-005) est fixée.
- AV-062 : `pricing.rule.draft` et `pricing.rule.activate` restent deux permissions distinctes (`pricing.rule.draft`, `pricing.rule.activate`), déjà séparées dans la matrice RBAC seedée en P0-05.
- AV-080 : `catalog.product_units.factor_to_base` configurable par produit et unité.

## 2. Tests d'acceptation et invariants

| AT / INV | Scénario | Où | État |
|---|---|---|---|
| AT-006 | Règle à date d'effet future, appliquée automatiquement à l'échéance | `pricing-commands.test.ts` (« draft à date d'effet future ») | Vert |
| AT-007 | Changement de prix : la vente/résolution passée reste inchangée | `pricing-commands.test.ts` (« supersede… AT-007 ») | Vert |
| INV-CAT-01 | Unité de base immuable dès la création (P1, avant `inventory` : immuable tout court) | `catalog-commands.test.ts` (produit créé avec une unité, jamais modifiable via `catalog.product.update`) | Vert par construction (le gestionnaire n'accepte pas `baseUnitCode` en mise à jour) |
| INV-PRX-01/03 | Règle `ACTIVE`/`RETIRED` immuable sauf réduction de `valid_to` ; jamais de suppression | Déclencheur `trg_pricing_price_rules_update_guard` + `trg_pricing_price_rules_no_delete` (migration) | Vert (exercé indirectement par `pricing-commands.test.ts`) |
| INV-PRX-02 | Aucun conflit entre deux règles actives | `pricing-commands.test.ts` (« conflit avec une règle active existante ») | Vert |
| INV-PRX-04 | Même contexte, même jeu de règles ⇒ même résultat sur l'appareil et le serveur | Garanti par construction : `packages/domain::resolvePrice` est la **seule** implémentation, importée telle quelle par `pricing-query.ts` (serveur) ; aucune appareil PWA ne consomme encore ce moteur en P1 (voir §4) | Vrai par construction ; démonstration croisée appareil/serveur différée à P4 (première UI de vente) |

Suite complète (26/09/2026) : `packages/domain` 103 tests, `apps/server` 208 tests (exécution séquentielle, `vitest run --no-file-parallelism`, 2 exécutions consécutives), `db` 47 tests. `check:boundaries` (197 modules, 708 dépendances), `typecheck`, `format:check`, `lint`, `python3 docs/_tools/check_refs.py` tous verts.

Note d'exécution (même limite qu'en P0, non liée à cette session) : sous parallélisme de fichiers par défaut (`vitest run`, sans `--no-file-parallelism`), une contention occasionnelle sur les ressources MySQL partagées peut renvoyer `RETRY_LATER` à un test qui ne boucle pas lui-même dessus — déjà documenté dans [`07-demonstration-p0.md`](07-demonstration-p0.md) §1 pour `record-audit.test.ts` ; le même phénomène est apparu une fois sur `catalog-commands.test.ts` pendant la préparation de cette démonstration (jamais en exécution séquentielle). Comportement correct du serveur, pas un défaut de P1.

## 3. Ce qui est livré

- **`packages/domain`** : moteur de tarification (`resolvePrice`, `specificityOf`, `findConflicts`) partagé appareil/serveur par construction (ADR-021).
- **`db`** : migrations `catalog.*` (8 tables), `pricing.*` (2 tables), `procurement.suppliers` — toutes avec déclencheurs d'immuabilité, aucune suppression physique.
- **`apps/server`** : modules `catalog`, `pricing`, `procurement` (fiche fournisseur) — commandes complètes du plan §4, API de lecture `GET /products`, `/units`, `/reason-codes`, `/price-rules`, `/campaigns`, `/prices/resolve`, `/suppliers`. Projections `/sync/pull` pour que les référentiels vendables et les règles actives soient téléchargeables sur un appareil (D16-CAT §12, D10-PRX §12).
- **RBAC** : aucun changement — les 117 permissions `catalog.*`, `pricing.*`, `procurement.supplier.*` et leurs octrois par rôle existaient déjà depuis le seed P0-05 (matrice complète pré-semée pour toutes les phases).

## 4. Ce qui n'est pas livré (signalé, pas silencieux)

| Élément | Raison | Déclencheur |
|---|---|---|
| Écrans PWA (ECR-PRX-01 à 03 : gestion des règles, simulateur, grille) | P0-14 n'a livré que le squelette (connexion, PIN, accueil vide) ; aucune session P0 n'a construit d'écran d'administration métier — même précédent que `organization` en P0-11, dont les écrans ECR-ADM-06 restent aussi non construits. Le moteur et les API sont prêts ; l'UI reste à faire | Première session dédiée aux écrans d'administration, ou report à la construction de l'UI de vente (P4) qui consommera `resolvePrice` sur l'appareil |
| Import CSV du catalogue et de la grille de prix (AV-072, données GIC) | Nécessite les modèles CSV et les données réelles transmises par GIC (checklist §6, « avant chaque release ») — aucune donnée fournie à ce jour dans cet environnement de développement | Réception des fichiers GIC (produits, unités, prix) |
| Projection `/sync/pull` de `catalog.units` et `catalog.sales_channels` | Leur clé primaire réelle est `code` (dictionnaire), alors que `sync_change_feed.entity_id` ne porte qu'un UUID (`aggregate_id`) sans rapport avec `code` — aucune valeur de repli ne serait correcte (voir commentaire, `entity-projections.ts`) | Décision technique : `id` UUID au lieu de `code` comme clé primaire (migration), ou mécanisme de projection par clé alternative dans `sync-pull.service.ts` |
| BR-CAT-008 (produit vendable ⇒ règle tarifaire globale active avant activation à la vente) | `catalog` ne dépend pas de `pricing` (sens inverse dans le graphe de dépendances) ; la vérification croisée n'a pas de point d'ancrage avant qu'un module consommateur (`sales`, P4) n'en ait besoin | P4 (première vente), ou un contrôle applicatif transverse si un besoin plus tôt apparaît |
| Bascule formelle `status = RETIRED` d'une règle remplacée | Aucune tâche planifiée différée (`platform/jobs`) pour cela en P1 — la fenêtre `valid_from`/`valid_to` suffit déjà à exclure la règle remplacée des candidates après échéance (voir commentaire, `pricing-commands.ts`) ; conséquence purement cosmétique (le prix résolu est déjà correct) | Ajout d'un type de tâche planifiée dédié, si `analytics` (P9) ou un audit a besoin de distinguer "activement en vigueur" de "expirée mais encore marquée ACTIVE" |
| `apps/pwa` : conflit pré-existant entre `vitest run` et `e2e/offline-shell.spec.ts` (Playwright) | `apps/pwa/vitest.config.ts` n'exclut pas `e2e/**` de son motif d'inclusion par défaut ; observé en exécutant `pnpm run test` (agrégat racine) plutôt que les commandes CI dédiées (`pnpm --filter @gic/pwa run test` vs `run e2e`, jobs CI séparés). Pré-existant depuis P0-14, aucun fichier `apps/pwa` touché par cette session | Ajout d'un `test.exclude: ['e2e/**']` dans `apps/pwa/vitest.config.ts`, hors périmètre P1 |

## 5. Prochaine étape

Phase **P2** (Stock et mouvements), qui dépend de P0 et P1 — tous deux code-terminés à cette date.
