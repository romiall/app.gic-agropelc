# Recommandation de stack technique

> Section 38 du format final (PM §48). Conformément au PM §46, la stack est proposée **en fin de cadrage** : chaque choix découle d'une exigence déjà établie (NFR, ADR, invariant) et non l'inverse.
> **Statut** : la base de données est **MySQL 8**, ACCEPTÉE ([ADR-023](../decisions/ADR-023-mysql.md), qui remplace [ADR-020](../decisions/ADR-020-postgresql.md) — recadrage lié à la contrainte d'hébergement Hostinger sans VPS, [ADR-024](../decisions/ADR-024-hebergement-hostinger.md)). Le reste de la stack est PROPOSÉ ([ADR-021](../decisions/ADR-021-stack-technique.md)) et doit être confirmé avant P0 (AV-089) ; il n'est **pas remis en cause** par le changement de base, à l'exception des points explicitement marqués « *(MySQL)* » ci-dessous. Les bibliothèques marquées *(interchangeable)* peuvent être remplacées pendant P0 sans nouvel ADR, tant que le remplaçant respecte les mêmes contraintes.
> **Développement local d'abord** : aucun composant de ce chapitre n'exige d'accès à Hostinger pour développer ou tester P0 à P3 — voir [ADR-024](../decisions/ADR-024-hebergement-hostinger.md) §5.

---

## 1. Contraintes qui déterminent le choix

| # | Contrainte | Source | Conséquence sur la stack |
|---|---|---|---|
| K1 | La même logique métier s'exécute **hors ligne sur l'appareil** et **sur le serveur** : validation des commandes, moteur de prix, politiques de validation, calcul de disponibilité, arrondis | ADR-001, INV-PRX-04, BR-SYN-* | Un **seul langage** pour le client et le serveur, et une bibliothèque métier partagée sans entrée-sortie |
| K2 | Appareils Android modestes, réseau 2G/3G | NFR-01, NFR-02, NFR-05, NFR-07, NFR-34 | PWA légère : bundle initial ≤ 300 Ko gzip, découpage par rôle, pas de framework UI lourd |
| K3 | Stockage local structuré, transactionnel, interrogeable (≥ 5 000 commandes, 2 000 clients) | NFR-03, NFR-04, NFR-06 | IndexedDB avec index secondaires et transactions |
| K4 | Invariants forts : registres immuables, unicités partielles, périodes non chevauchantes, transactions multi-tables | INV-GLO-03, INV-STK-*, ADR-003 | Base relationnelle riche en contraintes ; accès SQL explicite plutôt qu'un ORM qui masque le schéma |
| K5 | Traitements asynchrones fiables : outbox d'événements, consommateurs, tâches planifiées, Kommo | ADR-011, NFR-15 | File de tâches **dans la base relationnelle** (pas de composant d'infrastructure supplémentaire) |
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
| Accès SQL (K4) *(MySQL)* | **Kysely** (constructeur de requêtes SQL typé) + pilote **mysql2** ; types générés depuis le schéma (`kysely-codegen`) | SQL explicite, contrôle total sur les verrous (`SELECT … FOR UPDATE [SKIP LOCKED]`) et les colonnes générées ; aucun comportement caché | Prisma (migrations et requêtes générées : mal adapté aux déclencheurs et aux verrous explicites) ; Drizzle (proche, plus jeune) ; TypeORM (instabilité historique) |
| Migrations (K4) | **Fichiers SQL versionnés** dans `db/migrations`, appliqués par **dbmate** *(interchangeable)* — compatible MySQL nativement, aucun changement d'outillage | Le DDL est relu tel qu'il sera exécuté ; migrations expand/contract (`04-deploiement.md` §4) ; DDL atomique par instruction depuis MySQL 8.0 | Kysely Migrator (migrations en TypeScript, moins lisibles pour le DDL) ; Flyway (JVM requise) |
| File de tâches, planification, consommateurs d'événements (K5) *(MySQL)* | Table de tâches **maison** dans `platform`, `SELECT … FOR UPDATE SKIP LOCKED` (MySQL ≥ 8.0.1), tâches planifiées par verrou de ligne dédié ; consommateurs de `platform.domain_events` exécutés dans le worker | Aucun composant d'infrastructure supplémentaire ; la tâche et la donnée partagent la même transaction si nécessaire ; **pg-boss abandonné** (bibliothèque propre à PostgreSQL, dépend de LISTEN/NOTIFY) — le mécanisme SQL sous-jacent est conservé à l'identique, seule la bibliothèque disparaît (quelques dizaines de lignes dans `platform`, ADR-023) | BullMQ + Redis (un service de plus à opérer et à sauvegarder) |
| Hachage des mots de passe (K8) | **argon2** (liaison native, variante argon2id) | Recommandation OWASP ; NFR-26 | bcrypt (moins résistant aux GPU) |
| Jetons (K8) | **jose** (JWT EdDSA ou ES256) ; jetons de rafraîchissement opaques gérés dans `identity` | Bibliothèque standard, sans dépendance native ; conforme à `02-securite.md` §3 | Fournisseur d'identité externe (Keycloak, Auth0) : complexité et dépendance réseau inutiles pour ~150 utilisateurs, et gestion du PIN hors ligne à faire de toute façon |
| Validation des entrées | **zod** (mêmes schémas que l'appareil) | Contrats identiques (K1) | class-validator (duplication des schémas) |
| Stockage objet (K6) | Stockage **S3-compatible** du fournisseur retenu (AV-091 — Hostinger sans VPS n'en propose pas), client **AWS SDK v3** ; endpoints d'upload maison (`upload-session`, `PUT` avec `Content-Range`, `HEAD` pour l'offset) | Upload reprenable par morceaux de 256 Ko déjà spécifié (`08-api-events/01-architecture-api.md` §4.10) ; URL signées courtes | Protocole tus (standard, mais les endpoints spécifiés suffisent) ; stockage des fichiers dans la base (sauvegardes gonflées) |
| Traitement d'image serveur | **sharp** | Réencodage, suppression des métadonnées EXIF (`02-securite.md`), miniatures | ImageMagick (plus lent, surface d'attaque plus large) |
| Notifications push | **web-push** (VAPID) | Standard Web Push, sans service tiers | Firebase Cloud Messaging (dépendance à un compte Google) |
| Intégration Kommo | Client HTTP mince (`fetch` d'undici) sur l'API REST v4 et les webhooks, dans le module `integrations` | Kommo n'offre pas de SDK Node.js officiel ; périmètre réduit (ADR-009) ; retentatives gérées par la file de tâches maison (§2.3) | Plateforme d'intégration (Make, Zapier) : perte de l'idempotence et de l'anti-boucle (RISK-14) |
| Exports (AV-067) | CSV en flux natif ; XLSX via **ExcelJS** en mode flux | 100 000 lignes en moins de 2 min sans saturer la mémoire (NFR-13) | SheetJS (licence et mode flux moins pratiques) |

### 2.4 Données

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Base transactionnelle (K4) | **MySQL 8.0 ≥ 8.0.19**, moteur **InnoDB**, service managé chez Hostinger (ADR-024) avec sauvegardes régulières | Voir l'analyse complète du §3 et [ADR-023](../decisions/ADR-023-mysql.md) ; remplace PostgreSQL suite à la contrainte d'hébergement (AV-073 tranché) | PostgreSQL managé hors Hostinger (repli si une garantie du §3 s'avérait irréparable — ce n'est pas le cas) |
| Extension plein texte | Analyseur **`ngram`** (bigramme, natif MySQL ≥ 5.7.6) sur les colonnes recherchées de façon approchée (nom, téléphone de client) | Remplace `pg_trgm`, sans extension à activer séparément (§3) | Recherche applicative (normalisation + distance), acceptable au volume H-06 |
| Analytique (paliers P1 à P3, ADR-011) | Vues et tables d'agrégats **dans MySQL**, puis réplique en lecture si NFR-12/13 ne sont plus tenues | Aucun entrepôt séparé tant que la volumétrie reste proche de H-06 (AV-086) ; le palier P1 utilisait déjà des vues SQL simples et des tables peuplées par le worker, pas des vues matérialisées PostgreSQL — aucun changement de mécanisme | Entrepôt colonnaire (ClickHouse, BigQuery) : prématuré à cette volumétrie |

### 2.5 Qualité, tests et livraison

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Tests unitaires et de propriétés | **Vitest** + **fast-check** | Même outil pour `packages/domain`, la PWA et le serveur ; tests de propriétés pour les invariants (NFR-31) | Jest (plus lent avec les modules ES) |
| Tests d'intégration | **Testcontainers** (MySQL 8 réel en conteneur, ex. image `mysql:8.0`) | Les contraintes, déclencheurs, colonnes générées et verrous doivent être testés sur la vraie base (`09-non-functional/03-plan-de-tests.md`) ; entièrement local, aucun accès à Hostinger (ADR-024 §5) | Base partagée de test (tests non isolés) |
| Base locale en test | `fake-indexeddb` pour les tests unitaires de la couche Dexie | Tests rapides sans navigateur | Tests uniquement en E2E (trop lents) |
| Tests de bout en bout | **Playwright** (Chromium, émulation hors ligne et réseau dégradé, profil d'appareil modeste) | Seul outil couvrant proprement l'offline et le service worker | Cypress (support du service worker et du hors ligne plus limité) |
| Tests de charge | **k6** | Scénarios de synchronisation par lots (NFR-10, NFR-14, NFR-33) | Gatling, Artillery |
| Lint et formatage | **ESLint** (typescript-eslint) + **Prettier** | Standard du langage | Biome (plus rapide, plus jeune) |
| Frontières de modules (NFR-32) | **dependency-cruiser** : règles générées depuis `03-graphe-dependances.md` | Échec de la CI à toute dépendance interdite | Règles `import/no-restricted-paths` d'ESLint (moins expressives) |
| Budget de bundle (NFR-05) | **size-limit** + Lighthouse CI | Échec de la CI si le budget est dépassé | Contrôle manuel (dérive assurée) |
| Sécurité de la chaîne (NFR-25) | `pnpm audit` / **osv-scanner**, **gitleaks** (secrets), Dependabot ou Renovate | Vulnérabilités connues détectées à chaque build | — |
| Intégration continue | **GitHub Actions** | Le dépôt est hébergé sur GitHub | GitLab CI (changement d'hébergement du code) |
| Conteneurisation | **Docker** *(si retenu par AV-090)* : une seule image serveur, deux modes de démarrage (`api`, `worker`) ; sinon artefact Node.js selon l'offre Hostinger | Déploiement identique en staging et en production, quelle que soit la modalité (`04-deploiement.md` §3) | Buildpacks |

### 2.6 Exploitation

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|
| Hébergement (calcul + base) | **Hostinger, sans VPS** (ADR-024) : hébergement du serveur Node.js (API + worker) et de la base MySQL managée. Modalité précise d'exécution du processus Node.js encore ouverte (AV-090) | Contrainte ferme du porteur de projet ; exploitable sans équipe d'exploitation dédiée (K7) ; ne bloque pas P0 à P3, entièrement développés en local (ADR-024 §5) | **VPS explicitement écarté** par le porteur de projet, y compris chez Hostinger — non une option, pas seulement une préférence |
| Stockage objet | Fournisseur **S3-compatible séparé** (Cloudflare R2, Backblaze B2, ou équivalent) — Hostinger sans VPS n'expose pas ce produit ; choix précis en AV-091 | Upload par morceaux déjà spécifié indépendamment du fournisseur (ADR-012) | — |
| Domaine et TLS | `app.gic-agropelc.com` (sous-domaine de `gic-agropelc.com`) comme cible de production ; TLS automatique fourni par la plateforme retenue ; sinon **Caddy** | URL toujours configurée par variable d'environnement, jamais codée en dur (ADR-024 §2) | nginx (configuration TLS manuelle) |
| Secrets | Gestionnaire de secrets du fournisseur | Aucun secret dans le dépôt ni dans l'image | Variables d'environnement en clair (refusé) |
| Traces et métriques (K9) | **OpenTelemetry** (SDK Node.js) exporté en OTLP vers un service managé compatible | Standard ouvert : changement de fournisseur de supervision sans modifier le code | Agent propriétaire d'un fournisseur (verrouillage) |
| Logs | **pino** (JSON structuré, `correlation_id`, masquage des données personnelles) | Rapide, compatible avec la collecte de la plateforme | winston (plus lent) |
| Capture des erreurs client et serveur (NFR-28) | **Sentry** (SaaS) ou **GlitchTip** (auto-hébergé, compatible avec le SDK Sentry) | Regroupement des erreurs, versions de release, contexte `device_id` et `correlation_id` | Remontée maison via l'API (moins riche) |
| Sonde de disponibilité (NFR-17) | Service de sonde externe | Mesure indépendante de l'hébergeur | — |

---

## 3. Analyse de la base de données (PM §47) — MySQL, recadré pour l'hébergement Hostinger sans VPS

> **Historique** : cette section retenait initialement PostgreSQL, sur une analyse fonctionnelle pure (voir [ADR-020](../decisions/ADR-020-postgresql.md), conservé, statut REMPLACÉ). Le porteur du projet a ensuite confirmé une contrainte ferme : hébergement de production chez **Hostinger, sans VPS** (AV-073 tranché) ; les offres Hostinger sans VPS proposent une base **MySQL** managée, pas de PostgreSQL managé hors VPS. La question est devenue : **MySQL peut-il porter les mêmes garanties, sans dégrader un invariant métier ?** Ce qui suit est l'audit complet, mené dépendance par dépendance. Décision formelle : [ADR-023](../decisions/ADR-023-mysql.md).

### 3.1 Méthode

Chaque fonctionnalité PostgreSQL utilisée ailleurs dans le cadrage a été recensée (recherche exhaustive dans `docs/`), puis, pour chacune : (1) est-elle réellement indispensable à un invariant ou une règle métier ? (2) MySQL 8 offre-t-il une garantie équivalente, nativement ou par un mécanisme de substitution déclaratif (contrainte, déclencheur, verrou de ligne) ? (3) à défaut, la garantie peut-elle être déplacée proprement vers la couche domaine, le serveur, ou une transaction applicative, sans devenir une simple convention non vérifiée ? Aucune réduction de garantie n'est acceptée silencieusement : chaque écart est nommé dans la dernière colonne.

**Version minimale retenue : MySQL 8.0, à partir de la révision 8.0.19** (contraintes `CHECK` réellement appliquées depuis 8.0.16 ; DDL atomique depuis 8.0 ; `SELECT … FOR UPDATE SKIP LOCKED` depuis 8.0.1 ; colonnes générées stockées depuis 8.0.13 ; analyseur plein texte `ngram` depuis 5.7.6). Moteur de stockage : **InnoDB** partout (transactionnel, verrous au niveau ligne).

### 3.2 Tableau de compatibilité

| Besoin | Implémentation PostgreSQL actuelle | Limitation MySQL 8 | Alternative proposée | Garantie obtenue |
|---|---|---|---|---|
| **Unicité conditionnelle** (une session de caisse `OPEN` par compte, INV-FIN-06 ; une session de travail non close par utilisateur, INV-TER-01 ; un emplacement `MOBILE` par utilisateur, INV-ADM-05 ; un BL non dupliqué par fournisseur, BR-APP-012 ; un téléphone principal par compte non `MERGED`, INV-CRM-03 ; un encaissement par référence externe, INV-FIN-03 ; une alerte ouverte par objet, INV-NOT-01 ; un inventaire `IN_PROGRESS` par emplacement) | Index unique **partiel** (`CREATE UNIQUE INDEX … WHERE status = 'OPEN'`) | Pas d'index partiel natif | **Colonne générée stockée**, `NULL` sauf si la condition de filtre est vraie, avec `UNIQUE` sur cette colonne (ex. `open_account_id GENERATED ALWAYS AS (IF(status='OPEN', cash_account_id, NULL)) STORED`, `UNIQUE KEY`). MySQL traite plusieurs `NULL` comme distincts : la contrainte ne porte que sur les lignes qui remplissent la condition | **Identique** : contrainte déclarative au niveau base, aucune vérification applicative supplémentaire nécessaire |
| **Périodes non chevauchantes** (titulaire d'un client, INV-CRM-02 ; appartenance à une équipe, BR-ADM-014 ; objectif actif, BR-CRM-018) | Contrainte d'**exclusion** `EXCLUDE USING gist (clé WITH =, tstzrange(valid_from, valid_to) WITH &&)` | Pas de contrainte d'exclusion native ; pas de type intervalle indexable par recouvrement | **Verrouillage applicatif** : le gestionnaire de commande verrouille (`SELECT … FOR UPDATE`) les lignes existantes de la même clé avant d'insérer, dans la transaction de la commande ; **déclencheur** `BEFORE INSERT/UPDATE` qui revérifie l'absence de chevauchement et lève une erreur si le verrou a été contourné (défense en profondeur) | **Équivalente en pratique** : aucune fenêtre de course (la transaction complète, y compris le verrou, est atomique), mais devient une garantie combinée verrou + déclencheur plutôt qu'une contrainte déclarative unique — discipline de code requise, testée systématiquement (plan de tests §4) |
| **Hiérarchie de zones**, recherche d'ancêtres (BR-ADM-012) | Colonne `path uuid[]` + index **GIN** | Pas de type tableau, pas de GIN | **Table de fermeture transitive** `organization.zone_ancestors(zone_id, ancestor_id, depth)`, peuplée à la création ou au déplacement d'une zone | **Équivalente, plus portable** : la « closure table » est le motif relationnel standard pour les hiérarchies profondeur variable, indépendant du moteur |
| **Recherche approchée** de clients (doublons, nom et téléphone, BR-CRM) | Extension **`pg_trgm`**, index trigramme | Pas de `pg_trgm` | Index **plein texte MySQL avec l'analyseur `ngram`** (bigramme, `ngram_token_size = 2`), natif depuis 5.7.6 ; à défaut, comparaison applicative (normalisation + distance) sur un volume ≤ 20 000 clients (AV-086) | **Équivalente** au volume attendu : détection de doublons conservée, mécanisme au niveau base, performance à revalider en charge |
| **Verrous consultatifs transactionnels** (chaînage d'audit, `07-security-rbac/03-audit.md` §5 ; ordonnancement des commandes d'un appareil, INV-SYN-04 ; conflit de règle tarifaire, INV-PRX-02) | `pg_advisory_xact_lock(clé)`, relâché automatiquement au commit ou au rollback | `GET_LOCK()` existe mais est **lié à la session**, pas à la transaction (pas de relâchement automatique au rollback) | **`SELECT … FOR UPDATE`** sur une ligne dédiée déjà existante de la même transaction : la dernière entrée d'audit pour le chaînage, la ligne `sync.device_sync_state` de l'appareil pour l'ordonnancement, la ligne `catalog.products` concernée pour les prix | **Identique** : verrou transactionnel, relâché au commit ou au rollback, sans dépendance de session |
| **File de tâches** `SKIP LOCKED` (ADR-011, worker) | `SELECT … FOR UPDATE SKIP LOCKED`, bibliothèque **pg-boss** | Même syntaxe SQL disponible depuis MySQL 8.0.1, mais **pg-boss est propre à PostgreSQL** (dépend de `LISTEN`/`NOTIFY`) | **Table de tâches maison** dans `platform`, même requête `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`, avec reprise et attente progressive gérées en code (quelques dizaines de lignes) | **Identique** au niveau du mécanisme SQL ; bibliothèque en moins, code un peu plus grand mais entièrement maîtrisé |
| **Type d'identifiant** (UUIDv7, ADR-002) | Type `uuid` natif, 16 octets | Pas de type UUID natif | Colonne `BINARY(16)`, conversion par `UUID_TO_BIN()` / `BIN_TO_UUID()` (MySQL ≥ 8.0) dans un point unique de `packages/domain` | **Identique** en stockage et en localité d'index : UUIDv7 place déjà l'horodatage en tête (48 bits), donc un stockage `BINARY(16)` sans réordonnancement (`swap_flag`) donne une bonne localité B-tree, sans même le besoin du correctif prévu pour UUIDv1 |
| **Horodatage avec fuseau** (`occurred_at`, `received_at`…, ADR-016) | Type `timestamptz`, stocké en UTC, converti à la session | `DATETIME` n'a aucune notion de fuseau ; `TIMESTAMP` est borné à 2038 et sujet à une conversion fuseau serveur fragile | **`DATETIME(6)`** partout, toujours écrit et lu en UTC par un **convertisseur unique** dans `packages/domain` (jamais de conversion implicite) ; le fuseau `Africa/Douala` s'applique uniquement à l'affichage | **Identique en pratique** ; la discipline UTC devient un contrat applicatif pur au lieu d'être aussi imposée par le type de colonne — couverte par un test dédié qui interdit toute écriture hors du convertisseur partagé |
| **Charges techniques structurées** (`jsonb`, commandes, événements, audit avant/après) | Type `jsonb`, indexable GIN | Type `JSON` natif (stockage binaire), index uniquement via colonnes générées sur un chemin (MySQL ≥ 8.0.13) | Type **`JSON`**, sans indexation avancée nécessaire (le besoin documenté exclut déjà toute donnée métier interrogée ou contrainte en JSON) | **Identique** pour l'usage prévu |
| **`CHECK` déclaratifs** (quantités, montants, cohérences — INV-GLO-06, INV-STK-02, INV-OEU-01, INV-APP-01, INV-CRM-04…) | Natif de longue date | Réellement **appliqué depuis 8.0.16** (accepté en syntaxe mais ignoré avant) | Aucune : disponible nativement, sous réserve de la version minimale (§3.1) | **Identique**, sous condition de version |
| **Suppression physique interdite** (INV-GLO-03 et dérivés) | Privilège `DELETE` non accordé au rôle applicatif + déclencheur `BEFORE DELETE` | Aucune | Identique : `REVOKE DELETE`, déclencheur `BEFORE DELETE` avec `SIGNAL SQLSTATE` au lieu de `RAISE EXCEPTION` | **Identique** |
| **Immuabilité par liste blanche de colonnes** (INV-GLO-01, INV-VEN-02, INV-PRX-01…) | Déclencheur `BEFORE UPDATE` | Aucune | Identique : déclencheur `BEFORE UPDATE`, `SIGNAL SQLSTATE` | **Identique** |
| **DDL transactionnel / migrations sûres** | DDL transactionnel de bout en bout (plusieurs instructions groupables dans une transaction) | **DDL atomique par instruction** depuis MySQL 8.0 (« Atomic DDL » : chaque `CREATE`/`ALTER`/`DROP TABLE` est intégralement appliqué ou intégralement annulé, y compris l'entrée de journal) ; plusieurs instructions DDL ne se groupent **pas** dans une seule transaction multi-instructions | Discipline déjà prévue : migrations en étapes courtes, chacune sûre isolément (expand/contract, `04-deploiement.md` §4), testées sur une copie avant la production (plan de tests §1 « Migration ») | **Proche-équivalente** : sûreté par instruction conservée ; la sûreté « toute la migration ou rien » devient une discipline d'écriture des migrations plutôt qu'une garantie automatique |
| **Un rôle de base par schéma de module** (INV-GLO-05) | Un schéma PostgreSQL par module, `GRANT` au niveau du schéma | Pas de schéma indépendant d'une base ; un « schéma » MySQL **est** une base | **Une seule base MySQL** ; tables préfixées par module (`identity_users`, `inventory_stock_moves`…) ; `GRANT` **par table** au lieu de par schéma | **Identique au niveau requis par l'invariant** (« une table n'est écrite que par son module propriétaire ») : la granularité par table est aussi précise qu'une granularité par schéma ; supprime en outre toute dépendance à un nombre de bases limité par le plan d'hébergement |
| **Partitionnement dès la création** des registres et journaux (`audit.audit_log`, `inventory.stock_moves`, `sync.command_inbox`, `sync.change_feed`, `platform.domain_events`) | Partitionnement déclaratif, détachement de partitions pour l'archivage | Le partitionnement MySQL impose que toute clé unique/primaire inclue la colonne de partitionnement, et qu'une table partitionnée ne soit **pas référencée par une clé étrangère entrante** — or ce sont précisément les tables les plus référencées du modèle | **Report** : ces tables ne sont pas partitionnées au P0/P2 ; la volumétrie H-06 (~20 000 lignes d'audit/jour, ~7,3 millions/an) laisse plusieurs années de marge avec des index appropriés (entité, acteur, action, date) ; un **archivage applicatif** (export périodique des lignes anciennes vers un stockage froid, sans partitionnement natif) prend le relais avant la limite | **Réduite, mais sans impact sur une garantie de correction** : aucun invariant ne dépend du partitionnement lui-même, seulement de la croissance maîtrisée dans le temps. Suivi : RISK-27 |
| **Vues matérialisées** (paliers analytiques) | Citée comme capacité PostgreSQL disponible | Pas de vue matérialisée native | Sans objet : le palier P1 utilisait déjà des **vues SQL simples** sur les tables transactionnelles, et le palier P2 des **tables d'agrégats peuplées par le worker** (`01-architecture-logicielle.md` §6) — ni l'un ni l'autre n'était une vue matérialisée PostgreSQL | **Identique** — fausse alerte identifiée pendant l'audit, aucun changement requis |
| **Sécurité au niveau des lignes pour l'analytique** (RLS, défense en profondeur, ADR-008 ; `07-security-rbac/02-securite.md` §4) | RLS PostgreSQL sur les vues `analytics.f_*`, **en plus** du filtrage applicatif (`scopeFilter`, RC-01/RC-02, qui reste le mécanisme **principal**) | **Aucun équivalent** en MySQL | Le filtrage applicatif reste l'unique ligne d'exécution ; compensé par (a) une fonction de filtrage **unique et partagée**, appelée par 100 % des lectures analytiques, (b) un test de propriété par (rôle × jeu de faits) qui vérifie qu'aucune ligne hors portée n'est jamais renvoyée, exécuté à chaque commit, (c) aucun accès direct à la base n'est jamais exposé à un utilisateur final (seul le rôle applicatif se connecte ; pas d'outil de BI branché directement sur la base au MVP) | **Réduite, de façon assumée** : une couche d'exécution indépendante en moins, compensée par une discipline de test renforcée plutôt que par un second mécanisme déclaratif. **Seule ligne de ce tableau qui n'obtient pas une garantie strictement équivalente.** Suivi : RISK-28 |
| **Sauvegarde et restauration** (NFR-20 à NFR-23, RPO ≤ 15 min) | Réplication continue (WAL) | Mécanisme différent (journal binaire `binlog`) mais fonctionnellement équivalent pour un RPO ≤ 15 min | Dépend du service managé retenu chez Hostinger ; à vérifier précisément au moment du déploiement (AV-090) | **Équivalente en théorie** ; vérification pratique différée à la phase de déploiement, sans impact sur P0 à P3 |

### 3.3 Conclusion

**MySQL 8.0 (≥ 8.0.19, InnoDB) est adopté** comme base relationnelle cible (ADR-023). Sur 16 dépendances PostgreSQL recensées, 14 obtiennent une garantie **strictement équivalente** au niveau base de données (dont deux qui s'avèrent en fait plus portables que l'original : la table de fermeture transitive et la levée de la limite du nombre de schémas). Une (le partitionnement) est **reportée** sans affaiblir de garantie de correction, seulement un palier de dimensionnement encore loin d'être atteint. Une seule (la défense en profondeur RLS de l'analytique) est **réellement réduite**, de façon transparente, disclosée et compensée par une discipline de test renforcée plutôt que par un second mécanisme déclaratif — elle ne porte sur aucun invariant `INV-*` de premier rang, seulement sur une protection secondaire déjà documentée comme telle avant ce recadrage.

Conformément à l'instruction reçue, cette conclusion **n'a nécessité aucun repli vers un VPS** : chaque garantie fonctionnelle a trouvé une alternative compatible avec Hostinger sans VPS, l'offline-first, la petite équipe et le faible coût d'exploitation.

**Pourquoi pas une base NoSQL** (PM §47, inchangé par ce recadrage) : le domaine est un graphe de références fortes (produit, emplacement, lot, client, vente, encaissement, écriture) avec des transactions multi-entités. Une base documentaire déplacerait les jointures, l'unicité et la cohérence dans le code, et rendrait le rapprochement comptable fragile — ce raisonnement ne dépend pas du moteur relationnel retenu.

**Pourquoi pas une base « synchronisée » prête à l'emploi** (CouchDB/PouchDB, Firebase/Firestore) : ces outils synchronisent **des états** et résolvent les conflits par révision ou « dernier écrit gagnant ». Le cadrage exige de synchroniser **des faits** (commandes idempotentes) sous autorité du serveur, avec des décisions métier sur les conflits (ADR-001, ADR-007, `06-offline-sync/03-matrice-conflits.md`). Un stock vendu deux fois ne se résout pas par une révision gagnante. Le chemin de lecture (flux de changements par périmètre, `sync.change_feed`) reste suffisamment simple pour être construit sur MySQL, comme il l'était sur PostgreSQL.

---

## 4. Ce que la stack ne contient volontairement pas

| Élément écarté | Raison |
|---|---|
| **VPS, y compris chez Hostinger** | Contrainte ferme du porteur de projet (ADR-024) — non une préférence technique à arbitrer, une exclusion confirmée |
| Redis ou autre cache distribué | Volumétrie H-06 ; file et verrous dans MySQL ; cache des droits en mémoire de processus avec invalidation par événement |
| Courtier de messages (Kafka, RabbitMQ) | Outbox + table de tâches maison (`SELECT … FOR UPDATE SKIP LOCKED`) suffisent à ~2 commandes/s en pointe (NFR-14) |
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
| Dette technique des reports MySQL (colonnes générées, table de fermeture, verrous de ligne, file de tâches maison) (RISK-27) | Chaque mécanisme documenté §3.2, testé en intégration (Testcontainers MySQL), revu comme le reste du schéma |
| Perte de la défense en profondeur RLS pour l'analytique (RISK-28) | Fonction de filtrage de portée unique et partagée ; test de propriété par (rôle × jeu de faits) à chaque commit ; aucun accès direct à la base pour un utilisateur final |
| Modalité d'exécution du serveur Node.js chez Hostinger sans VPS encore incertaine (AV-090) | Sans impact sur P0 à P3 (développement entièrement local, ADR-024 §5) ; à résoudre avant le déploiement de staging |

---

## 6. Points ouverts

| ID | Sujet | Effet sur la stack |
|---|---|---|
| AV-089 | Confirmation de la stack proposée (ADR-021), y compris le remplacement de la base par MySQL (ADR-023) | Prérequis de P0 |
| AV-073 | Hébergeur | **Tranché** : Hostinger, sans VPS (ADR-024) |
| AV-090 | Modalité d'exécution du serveur Node.js (API + worker) chez Hostinger sans VPS | Choix du mode de build (image Docker ou artefact Node.js) ; sans impact sur P0 à P3 |
| AV-091 | Fournisseur de stockage objet S3-compatible (Hostinger sans VPS n'en propose pas) | Choix du fournisseur pour les pièces jointes (ADR-012) ; sans impact sur P0 à P3 (émulateur local) |
| AV-084 | Compétences et taille de l'équipe | Une équipe sans expérience TypeScript/React remettrait en cause le choix du framework, pas l'architecture |
| AV-079 | Langues de l'interface | Aucun impact sur la stack (i18n prévue dès P0) |
