# Recommandation de stack technique

> Section 38 du format final (PM §48). Conformément au PM §46, la stack est proposée **en fin de cadrage** : chaque choix découle d'une exigence déjà établie (NFR, ADR, invariant) et non l'inverse.
> **Statut** : la base de données est ACCEPTÉE ([ADR-020](../decisions/ADR-020-postgresql.md)). Le reste de la stack est PROPOSÉ ([ADR-021](../decisions/ADR-021-stack-technique.md)) et doit être confirmé avant P0 (AV-089). Les bibliothèques marquées *(interchangeable)* peuvent être remplacées pendant P0 sans nouvel ADR, tant que le remplaçant respecte les mêmes contraintes.

---

## 1. Contraintes qui déterminent le choix

| # | Contrainte | Source | Conséquence sur la stack |
|---|---|---|---|
| K1 | La même logique métier s'exécute **hors ligne sur l'appareil** et **sur le serveur** : validation des commandes, moteur de prix, politiques de validation, calcul de disponibilité, arrondis | ADR-001, INV-PRX-04, BR-SYN-* | Un **seul langage** pour le client et le serveur, et une bibliothèque métier partagée sans entrée-sortie |
| K2 | Appareils Android modestes, réseau 2G/3G | NFR-01, NFR-02, NFR-05, NFR-07, NFR-34 | PWA légère : bundle initial ≤ 300 Ko gzip, découpage par rôle, pas de framework UI lourd |
| K3 | Stockage local structuré, transactionnel, interrogeable (≥ 5 000 commandes, 2 000 clients) | NFR-03, NFR-04, NFR-06 | IndexedDB avec index secondaires et transactions |
| K4 | Invariants forts : registres immuables, unicités partielles, périodes non chevauchantes, transactions multi-tables | INV-GLO-03, INV-STK-*, ADR-003 | Base relationnelle riche en contraintes ; accès SQL explicite plutôt qu'un ORM qui masque le schéma |
| K5 | Traitements asynchrones fiables : outbox d'événements, consommateurs, tâches planifiées, Kommo | ADR-011, NFR-15 | File de tâches **dans PostgreSQL** (pas de composant d'infrastructure supplémentaire) |
| K6 | Photos : compression locale, upload reprenable, stockage privé | ADR-012, NFR-08 | Stockage objet S3-compatible ; traitement d'image serveur |
| K7 | Petite équipe (1 à 3 développeurs), coût d'exploitation raisonnable | AV-084, RISK-21, `04-deploiement.md` §6 | Technologies matures et documentées, services managés, une seule image serveur (API + worker) |
| K8 | Sécurité : argon2id, JWT court signé, jetons de rafraîchissement rotatifs, chiffrement local par clé dérivée du PIN | `07-security-rbac/02-securite.md` | Bibliothèques standard auditées ; Web Crypto côté appareil |
| K9 | Observabilité de bout en bout avec `correlation_id` | NFR-28, NFR-29, `09-non-functional/02-observabilite.md` | Standard OpenTelemetry ; logs JSON structurés ; capture des erreurs client |
| K10 | Contrôle automatique des frontières de modules et des budgets | NFR-05, NFR-31, NFR-32 | Outils de CI dédiés (graphe de dépendances, budget de bundle, couverture) |

---

## 2. Recommandation par composant (PM §46)

### 2.1 Socle commun

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Langage unique client et serveur (K1) | **TypeScript** (mode `strict`) | Partage réel du code métier entre la PWA et le serveur ; typage des contrats de commandes ; écosystème le plus large pour le web | Kotlin Multiplatform (partage possible, mais PWA via Kotlin/JS peu mature) ; Dart/Flutter (abandon de la PWA) |
| Organisation du code | **Monorepo** avec **pnpm workspaces** : `apps/pwa`, `apps/server`, `packages/domain`, `packages/contracts`, `db/migrations` | Une seule version de la bibliothèque métier ; changements atomiques client, serveur et contrats dans un même commit | Dépôts séparés avec paquet publié (versions désynchronisées : risque direct sur INV-PRX-04) ; Nx (plus lourd à maîtriser) |
| Bibliothèque métier partagée (K1) | **`packages/domain`** : TypeScript pur, sans accès réseau, base ni horloge implicite (l'horloge et les identifiants sont injectés) | Testable à ≥ 90 % (NFR-31) ; exécutable à l'identique dans le navigateur et dans Node.js | Dupliquer la logique côté client (divergence garantie) ; tout calculer côté serveur (incompatible avec l'offline) |
| Contrats de commandes et de jeux synchronisés | **zod** dans `packages/contracts` ; génération d'OpenAPI depuis ces schémas | Une seule définition sert à la validation côté appareil, à la validation serveur et à la documentation (`08-api-events/01-architecture-api.md` §documentation) | TypeBox ou JSON Schema + ajv (plus rapide à l'exécution, moins ergonomique) |
| Argent et quantités | Entiers `bigint`/`number` pour les XAF ; décimal à 3 chiffres porté en **millièmes entiers** dans `packages/domain` | Aucun flottant dans un calcul métier (ADR-013) | decimal.js (dépendance inutile si les millièmes entiers suffisent) |
| Identifiants | UUIDv7 générés sur l'appareil (bibliothèque `uuid` ≥ v10) | Tri temporel, création hors ligne (ADR-002) | ULID (équivalent, moins standard) |

### 2.2 Application PWA (appareil)

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Framework d'interface | **React** + **Vite** | Maturité, recrutement, écosystème ; Vite produit des bundles découpés facilement par rôle (NFR-05) | **Preact** via `preact/compat` en repli si le budget de bundle n'est pas tenu (RISK-23) ; Svelte (plus léger, vivier de développeurs plus restreint) ; Vue |
| Service worker, cache, installation | **vite-plugin-pwa** (Workbox) | Précache versionné des fichiers statiques, stratégie de mise à jour contrôlée (activation après vidage de l'outbox, `04-deploiement.md` §4) | Service worker écrit à la main (plus de code à maintenir) |
| Base locale (K3) | **IndexedDB** via **Dexie** | Transactions, index composés, migrations de schéma versionnées, requêtes réactives (`liveQuery`) ; fonctionne sur Android WebView ≥ 100 | `idb` (bas niveau, plus de code) ; SQLite WASM + OPFS (plus puissant, mais poids du WASM et support OPFS inégal sur les WebView visées) ; RxDB (payant pour certaines fonctions, modèle de réplication propre) |
| Lecture des données à l'écran | **Dexie `liveQuery`** pour tous les écrans utilisables hors ligne ; **TanStack Query** pour les écrans en ligne seulement (explorateur, audit, administration) | Règle d'architecture : un écran hors ligne lit **la base locale**, jamais le réseau (`06-offline-sync/01-architecture-offline.md`) | Redux Toolkit (état global redondant avec la base locale) |
| Navigation | **React Router** | Découpage du code par route et par rôle | TanStack Router |
| Formulaires | **react-hook-form** + résolveur zod | Réutilise les schémas de `packages/contracts` ; peu de rendus inutiles sur appareil modeste | Formik (plus lent, moins maintenu) |
| Composants d'interface | Primitives accessibles **Radix UI** + **Tailwind CSS** *(interchangeable)* | Accessibilité (NFR-35) sans le poids d'une bibliothèque complète | MUI ou Ant Design (poids incompatible avec NFR-05 sur l'écran de vente) |
| Traduction (NFR-36, AV-079) | **i18next** / react-i18next *(interchangeable)* | Clés de traduction, pluriels, format des nombres XAF et des dates `Africa/Douala` | Lingui (compilation, plus léger) |
| Graphiques des tableaux de bord | **Apache ECharts**, chargé à la demande sur les écrans de tableau de bord uniquement | Couvre la tour de contrôle et l'explorateur (CM §35) sans alourdir l'écran de vente | Chart.js (plus léger, moins de types de graphiques) |
| Tableaux de l'explorateur | **TanStack Table** (sans style imposé) | Regroupements, colonnes choisies, pagination côté serveur | AG Grid Community (lourd) |
| Chiffrement local (K8) | **Web Crypto API** : PBKDF2-SHA256 (≥ 310 000 itérations) et AES-GCM | Natif, sans dépendance ; conforme à `02-securite.md` §2 | libsodium.js (dépendance WASM supplémentaire) |
| Compression des photos (ADR-012) | Canvas / `OffscreenCanvas` natif (1 280 px, qualité 0,7) ; empreinte SHA-256 par Web Crypto | Aucune dépendance ; ≤ 400 Ko (NFR-08) | `browser-image-compression` *(interchangeable)* |
| Géolocalisation du pointage | API Geolocation du navigateur, **aux événements seulement** (NFR-09) | Aucun suivi permanent (CM §13) | — |
| Carte | **Aucun fond de carte au MVP** : géorepère saisi en centre + rayon (AV-003) | Évite une dépendance et du volume réseau | MapLibre GL + tuiles OpenStreetMap si la Direction demande une carte (extension) |

### 2.3 Serveur (API et worker)

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Environnement d'exécution | **Node.js LTS** (version LTS active au démarrage de P0) | Exécute `packages/domain` à l'identique (K1) | Deno ou Bun (compatibilité de l'écosystème moins éprouvée en production) |
| Framework HTTP et structure modulaire | **NestJS** avec l'adaptateur **Fastify** | Modules, injection de dépendances, gardes et intercepteurs : correspondance directe avec les 19 modules (`02-modules.md`) et le pipeline de commande (authentification → droits → validation → gestionnaire → écriture) | **Fastify seul** (plus léger, mais structure modulaire à construire soi-même) ; Express (moins performant, moins typé) |
| Accès SQL (K4) | **Kysely** (constructeur de requêtes SQL typé) + pilote **node-postgres** ; types générés depuis le schéma (`kysely-codegen`) | SQL explicite, contrôle total sur les verrous (`SELECT … FOR UPDATE`), les CTE et les index partiels ; aucun comportement caché | Prisma (migrations et requêtes générées : mal adapté aux contraintes d'exclusion, aux déclencheurs et aux verrous explicites) ; Drizzle (proche, plus jeune) ; TypeORM (instabilité historique) |
| Migrations (K4) | **Fichiers SQL versionnés** dans `db/migrations`, appliqués par **dbmate** *(interchangeable)* | Le DDL est relu tel qu'il sera exécuté ; migrations expand/contract (`04-deploiement.md` §4) ; DDL transactionnel de PostgreSQL | Kysely Migrator (migrations en TypeScript, moins lisibles pour le DDL) ; Flyway (JVM requise) |
| File de tâches, planification, consommateurs d'événements (K5) | **pg-boss** (tâches sur PostgreSQL avec `SKIP LOCKED`, tâches planifiées cron) ; consommateurs de `platform.domain_events` exécutés dans le worker | Aucun composant d'infrastructure supplémentaire ; la tâche et la donnée partagent la même transaction si nécessaire | BullMQ + Redis (un service de plus à opérer et à sauvegarder) ; Graphile Worker (équivalent, écosystème plus petit) |
| Hachage des mots de passe (K8) | **argon2** (liaison native, variante argon2id) | Recommandation OWASP ; NFR-26 | bcrypt (moins résistant aux GPU) |
| Jetons (K8) | **jose** (JWT EdDSA ou ES256) ; jetons de rafraîchissement opaques gérés dans `identity` | Bibliothèque standard, sans dépendance native ; conforme à `02-securite.md` §3 | Fournisseur d'identité externe (Keycloak, Auth0) : complexité et dépendance réseau inutiles pour ~150 utilisateurs, et gestion du PIN hors ligne à faire de toute façon |
| Validation des entrées | **zod** (mêmes schémas que l'appareil) | Contrats identiques (K1) | class-validator (duplication des schémas) |
| Stockage objet (K6) | Stockage **S3-compatible** du fournisseur retenu (AV-073), client **AWS SDK v3** ; endpoints d'upload maison (`upload-session`, `PUT` avec `Content-Range`, `HEAD` pour l'offset) | Upload reprenable par morceaux de 256 Ko déjà spécifié (`08-api-events/01-architecture-api.md` §4.10) ; URL signées courtes | Protocole tus (standard, mais les endpoints spécifiés suffisent) ; stockage des fichiers dans PostgreSQL (sauvegardes gonflées) |
| Traitement d'image serveur | **sharp** | Réencodage, suppression des métadonnées EXIF (`02-securite.md`), miniatures | ImageMagick (plus lent, surface d'attaque plus large) |
| Notifications push | **web-push** (VAPID) | Standard Web Push, sans service tiers | Firebase Cloud Messaging (dépendance à un compte Google) |
| Intégration Kommo | Client HTTP mince (`fetch` d'undici) sur l'API REST v4 et les webhooks, dans le module `integrations` | Kommo n'offre pas de SDK Node.js officiel ; périmètre réduit (ADR-009) ; retentatives gérées par pg-boss | Plateforme d'intégration (Make, Zapier) : perte de l'idempotence et de l'anti-boucle (RISK-14) |
| Exports (AV-067) | CSV en flux natif ; XLSX via **ExcelJS** en mode flux | 100 000 lignes en moins de 2 min sans saturer la mémoire (NFR-13) | SheetJS (licence et mode flux moins pratiques) |

### 2.4 Données

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Base transactionnelle (K4) | **PostgreSQL ≥ 16** (18 recommandé : `uuidv7()` natif), service managé avec PITR | Voir l'analyse du §3 et [ADR-020](../decisions/ADR-020-postgresql.md) | MySQL 8 (§3) |
| Extensions | `btree_gist` (contraintes d'exclusion sur périodes), `pg_trgm` (recherche approchée de clients et de doublons), `pgcrypto` | Toutes disponibles chez les grands fournisseurs managés | — |
| Analytique (paliers P1 à P3, ADR-011) | Vues et tables d'agrégats **dans PostgreSQL**, puis réplique en lecture si NFR-12/13 ne sont plus tenues | Aucun entrepôt séparé tant que la volumétrie reste proche de H-06 (AV-086) | Entrepôt colonnaire (ClickHouse, BigQuery) : prématuré à cette volumétrie |

### 2.5 Qualité, tests et livraison

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Tests unitaires et de propriétés | **Vitest** + **fast-check** | Même outil pour `packages/domain`, la PWA et le serveur ; tests de propriétés pour les invariants (NFR-31) | Jest (plus lent avec les modules ES) |
| Tests d'intégration | **Testcontainers** (PostgreSQL réel en conteneur) | Les contraintes, déclencheurs et verrous doivent être testés sur la vraie base (`09-non-functional/03-plan-de-tests.md`) | Base partagée de test (tests non isolés) |
| Base locale en test | `fake-indexeddb` pour les tests unitaires de la couche Dexie | Tests rapides sans navigateur | Tests uniquement en E2E (trop lents) |
| Tests de bout en bout | **Playwright** (Chromium, émulation hors ligne et réseau dégradé, profil d'appareil modeste) | Seul outil couvrant proprement l'offline et le service worker | Cypress (support du service worker et du hors ligne plus limité) |
| Tests de charge | **k6** | Scénarios de synchronisation par lots (NFR-10, NFR-14, NFR-33) | Gatling, Artillery |
| Lint et formatage | **ESLint** (typescript-eslint) + **Prettier** | Standard du langage | Biome (plus rapide, plus jeune) |
| Frontières de modules (NFR-32) | **dependency-cruiser** : règles générées depuis `03-graphe-dependances.md` | Échec de la CI à toute dépendance interdite | Règles `import/no-restricted-paths` d'ESLint (moins expressives) |
| Budget de bundle (NFR-05) | **size-limit** + Lighthouse CI | Échec de la CI si le budget est dépassé | Contrôle manuel (dérive assurée) |
| Sécurité de la chaîne (NFR-25) | `pnpm audit` / **osv-scanner**, **gitleaks** (secrets), Dependabot ou Renovate | Vulnérabilités connues détectées à chaque build | — |
| Intégration continue | **GitHub Actions** | Le dépôt est hébergé sur GitHub | GitLab CI (changement d'hébergement du code) |
| Conteneurisation | **Docker** : une seule image serveur, deux modes de démarrage (`api`, `worker`) | Déploiement identique en staging et en production (`04-deploiement.md` §3) | Buildpacks |

### 2.6 Exploitation

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Hébergement | Plateforme de conteneurs managée + PostgreSQL managé + stockage S3 + CDN, chez un fournisseur unique (région à fixer par AV-073) | Exploitable sans équipe d'exploitation dédiée (K7) | VPS + Docker Compose (moins cher, mais sauvegardes, TLS et mises à jour à la charge de l'équipe) ; Kubernetes (surdimensionné) |
| TLS, proxy, limitation de débit | Fournis par la plateforme et le CDN ; sinon **Caddy** | TLS automatique | nginx (configuration TLS manuelle) |
| Secrets | Gestionnaire de secrets du fournisseur | Aucun secret dans le dépôt ni dans l'image | Variables d'environnement en clair (refusé) |
| Traces et métriques (K9) | **OpenTelemetry** (SDK Node.js) exporté en OTLP vers un service managé compatible | Standard ouvert : changement de fournisseur de supervision sans modifier le code | Agent propriétaire d'un fournisseur (verrouillage) |
| Logs | **pino** (JSON structuré, `correlation_id`, masquage des données personnelles) | Rapide, compatible avec la collecte de la plateforme | winston (plus lent) |
| Capture des erreurs client et serveur (NFR-28) | **Sentry** (SaaS) ou **GlitchTip** (auto-hébergé, compatible avec le SDK Sentry) | Regroupement des erreurs, versions de release, contexte `device_id` et `correlation_id` | Remontée maison via l'API (moins riche) |
| Sonde de disponibilité (NFR-17) | Service de sonde externe | Mesure indépendante de l'hébergeur | — |

---

## 3. Analyse de la base de données (PM §47)

Le PM demande une justification précise. Les deux candidats sérieux pour un domaine relationnel sont PostgreSQL et MySQL 8. L'analyse porte sur l'usage réel qu'en fait **ce** projet.

| Critère | Besoin du projet | PostgreSQL | MySQL 8 | Verdict |
|---|---|---|---|---|
| **Contraintes** | Unicités **partielles** (une seule session de caisse ouverte par compte de caisse, INV-FIN-06 ; un seul emplacement mobile actif par utilisateur, INV-ADM-05) ; périodes non chevauchantes (titulaire d'un client, INV-CRM-02 ; appartenance à une équipe, BR-ADM-014 ; objectifs, BR-CRM-018) ; `CHECK` sur les quantités et les états | Index uniques partiels (`WHERE status = 'OPEN'`) ; contraintes d'exclusion `EXCLUDE USING gist (… WITH =, tstzrange(…) WITH &&)` ; `CHECK` complets ; clés étrangères `DEFERRABLE` | `CHECK` depuis 8.0.16 ; **pas d'index partiel** (contournement par colonne générée à `NULL`) ; **pas de contrainte d'exclusion** (vérification applicative, sujette aux courses) | PostgreSQL : les invariants INV-STK, INV-FIN, INV-ADM sont garantis par la base, pas seulement par le code |
| **Transactions** | Commande = transaction unique qui écrit le registre, la projection, l'audit, l'événement et la réponse d'inbox (ADR-007, ADR-011) | ACID, MVCC, `SERIALIZABLE` réel (SSI), **DDL transactionnel** | ACID (InnoDB) ; DDL non transactionnel (une migration interrompue laisse un schéma partiel) | PostgreSQL, surtout pour la sûreté des migrations |
| **JSON éventuel** | Charges techniques seulement : charge utile des commandes dans `sync.command_inbox`, événements `platform.domain_events`, détail d'audit, paramètres. **Jamais** de données métier en JSON | `jsonb` indexable (GIN), opérateurs riches | Type `JSON`, index via colonnes générées | PostgreSQL, sans que ce soit décisif |
| **Index** | Recherche de clients par nom ou téléphone approximatif (doublons, BR-CRM) ; index composés sur `(location_id, product_id, occurred_at)` ; index partiels sur les éléments ouverts | B-tree, GIN, GiST, BRIN (registres ordonnés dans le temps), **trigramme** `pg_trgm`, index partiels et d'expression | B-tree, plein texte ; pas de trigramme natif ; pas d'index partiel | PostgreSQL |
| **Reporting** | Soldes à une date, marges de lot, séries temporelles, cumuls par période (CM §35) | Fonctions de fenêtre, CTE récursives, `GROUPING SETS`/`ROLLUP`, vues matérialisées rafraîchissables | Fonctions de fenêtre et CTE depuis 8.0 ; pas de vue matérialisée native ; `ROLLUP` limité | PostgreSQL (vues matérialisées = palier analytique P2 sans nouvel outil) |
| **Concurrence** | Verrous courts sur les soldes lors d'une vente ; file de tâches ; séquences de documents par site sans trou toléré ; sessions de caisse | `SELECT … FOR UPDATE SKIP LOCKED`, verrous consultatifs (`pg_advisory_xact_lock`), SSI | `FOR UPDATE SKIP LOCKED` depuis 8.0 ; verrous nommés (`GET_LOCK`) moins pratiques en transaction | Les deux conviennent ; PostgreSQL offre les verrous consultatifs transactionnels utiles au chaînage d'audit (RISK-25) |
| **Migrations** | Évolutions fréquentes par phase ; expand/contract ; aucune indisponibilité longue | DDL transactionnel ; `CREATE INDEX CONCURRENTLY` ; ajout de colonne avec valeur par défaut instantané | DDL en ligne (INSTANT/INPLACE) mais non transactionnel | PostgreSQL |
| **Sécurité** | Défense en profondeur sur les périmètres (`02-securite.md` §4) ; un rôle de base par module | RLS, rôles et privilèges par schéma | Pas de RLS ; « schéma » = base séparée | PostgreSQL |
| **Partitionnement** | Registres et journaux en croissance (RISK-12) : partitions mensuelles | Partitionnement déclaratif, détachement de partitions pour l'archivage | Partitionnement plus contraint (pas de clé étrangère vers une table partitionnée) | PostgreSQL |
| **Exploitation** | Service managé avec PITR chez un fournisseur courant | Offert par tous les grands fournisseurs | Idem | Égalité |

Exemples courts (illustratifs, pas des migrations) des contraintes impossibles ou fragiles hors PostgreSQL :

```sql
-- Au plus une session de caisse OPEN par compte de caisse (INV-FIN-06)
CREATE UNIQUE INDEX ux_cash_sessions_open ON finance.cash_sessions (cash_account_id)
  WHERE status = 'OPEN';

-- Un client a au plus un titulaire à un instant donné (INV-CRM-02)
ALTER TABLE crm.customer_assignments ADD CONSTRAINT ex_customer_assignments_overlap
  EXCLUDE USING gist (customer_id WITH =, tstzrange(valid_from, valid_to) WITH &&);
```

**Conclusion** : PostgreSQL est retenu (ADR-020). MySQL resterait viable techniquement, mais plusieurs invariants deviendraient **applicatifs** au lieu d'être garantis par la base, ce qui affaiblirait les invariants marqués « DB » dans [`01-invariants.md`](../02-domain-model/01-invariants.md) et le principe P11 (le client n'est jamais une autorité : la dernière ligne de défense est la base).

**Pourquoi pas une base NoSQL** (PM §47) : le domaine est un graphe de références fortes (produit, emplacement, lot, client, vente, encaissement, écriture) avec des transactions multi-entités. Une base documentaire déplacerait les jointures, l'unicité et la cohérence dans le code, et rendrait le rapprochement comptable fragile.

**Pourquoi pas une base « synchronisée » prête à l'emploi** (CouchDB/PouchDB, Firebase/Firestore, moteurs de synchronisation de lignes PostgreSQL) : ces outils synchronisent **des états** et résolvent les conflits par révision ou « dernier écrit gagnant ». Le cadrage exige de synchroniser **des faits** (commandes idempotentes) sous autorité du serveur, avec des décisions métier sur les conflits (ADR-001, ADR-007, `06-offline-sync/03-matrice-conflits.md`). Un stock vendu deux fois ne se résout pas par une révision gagnante. Ces outils sont donc écartés pour le chemin d'écriture. Le chemin de lecture (flux de changements par périmètre) reste suffisamment simple pour être construit sur PostgreSQL (`sync.change_feed`).

---

## 4. Ce que la stack ne contient volontairement pas

| Élément écarté | Raison |
|---|---|
| Redis ou autre cache distribué | Volumétrie H-06 ; file et verrous dans PostgreSQL ; cache des droits en mémoire de processus avec invalidation par événement |
| Courtier de messages (Kafka, RabbitMQ) | Outbox + pg-boss suffisent à ~2 commandes/s en pointe (NFR-14) |
| Microservices | Monolithe modulaire (ADR-011) : une équipe, un déploiement, des transactions locales |
| GraphQL | API orientée commandes + lectures paginées (ADR-019) |
| Application native | PWA d'abord ; enveloppe native seulement si les limites des PWA l'imposent (RISK-16, extension F-18) |
| ORM à migrations générées | Le schéma est une spécification (`03-data/`) ; il est écrit et relu en SQL |

---

## 5. Risques propres à la stack et mesures

| Risque | Mesure |
|---|---|
| Poids de React sur l'écran de vente (RISK-23, NFR-05) | Budget de bundle bloquant en CI dès P0 ; découpage par rôle ; repli `preact/compat` sans réécriture |
| Complexité de NestJS pour une petite équipe (RISK-21) | Usage limité aux modules, contrôleurs, gardes et intercepteurs ; logique métier dans `packages/domain`, jamais dans les décorateurs |
| Dérive entre la logique de l'appareil et celle du serveur | Un seul paquet `packages/domain` ; test de propriété croisé INV-PRX-04 ; version des contrats vérifiée à chaque push (BR-SYN-016) |
| Éviction ou corruption d'IndexedDB (RISK-01) | `navigator.storage.persist()` ; migrations Dexie testées ; somme de contrôle de l'outbox |
| Versions majeures des bibliothèques pendant le projet | Versions épinglées (fichier de verrouillage) ; montée de version groupée, une fois par phase, avec la CI complète |

---

## 6. Points ouverts

| ID | Sujet | Effet sur la stack |
|---|---|---|
| AV-089 | Confirmation de la stack proposée (ADR-021) | Prérequis de P0 |
| AV-073 | Hébergeur et région | Choix du fournisseur managé (conteneurs, PostgreSQL 16 ou 18, S3, CDN) |
| AV-084 | Compétences et taille de l'équipe | Une équipe sans expérience TypeScript/React remettrait en cause le choix du framework, pas l'architecture |
| AV-079 | Langues de l'interface | Aucun impact sur la stack (i18n prévue dès P0) |
