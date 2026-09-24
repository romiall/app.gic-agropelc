# Passage du cadrage au développement

> Ce document prépare le démarrage du développement **sans le commencer** (PM §51, REQ-215). Il s'adresse à la personne ou à la session d'IA qui prendra la phase P0, puis les suivantes.
> Condition de démarrage : la [checklist](04-checklist-demarrage.md) est cochée pour P0, en particulier la confirmation de la stack (AV-089) et de l'hébergement (AV-073). Tant que ces deux décisions ne sont pas prises, la structure ci-dessous reste une **proposition**.

---

## 1. Méthode

1. **Une phase à la fois**, dans l'ordre du plan ([`01-plan-developpement.md`](01-plan-developpement.md)), en tranches verticales : chaque incrément va de l'écran de l'appareil hors ligne jusqu'à la base de données.
2. **Spécification d'abord** : avant de coder une fonctionnalité, relire sa fiche de phase (plan §4), puis les documents cités dans la matrice de traçabilité ([`02-matrice-tracabilite.md`](02-matrice-tracabilite.md)) pour les exigences de la phase.
3. **Aucune logique métier inventée** : une question non couverte par la documentation devient un point `AV-nnn` dans le registre ([`../A-VALIDER.md`](../A-VALIDER.md)), avec sa classe et une valeur par défaut. La valeur par défaut est implémentée **de façon paramétrable** ; le travail continue.
4. **Documentation et code évoluent ensemble** : un changement de schéma met à jour le dictionnaire ; une décision structurante crée un ADR ; une décision métier met à jour le registre et les règles concernées ; une nouvelle exigence reçoit une ligne dans la matrice. Toujours dans le même commit.

## 2. Structure cible du dépôt (proposée, ADR-021)

```text
/
├── CLAUDE.md                  règles de travail pour les sessions d'IA et les développeurs
├── README.md
├── docs/                      référentiel de cadrage : source de vérité métier et technique
├── apps/
│   ├── pwa/                   React + Vite + Workbox + Dexie
│   │   └── src/
│   │       ├── app/           démarrage, routes par rôle, accueil (UX-01)
│   │       ├── features/      un dossier par module métier (écrans ECR-*)
│   │       ├── sync/          outbox, envoi, réception, chargement initial, états (BR-SYN-*)
│   │       ├── storage/       schéma Dexie versionné, projections locales, chiffrement (PIN)
│   │       ├── ui/            composants partagés, accessibilité (NFR-35)
│   │       └── i18n/          clés de traduction (NFR-36)
│   └── server/                NestJS (adaptateur Fastify) ; une image, deux modes : api et worker
│       └── src/
│           ├── platform/      unité de travail, pipeline de commande, outbox d'événements, file de tâches
│           └── modules/       un dossier par module (19), structure interne api/application/domain/infrastructure
├── packages/
│   ├── domain/                logique métier pure et partagée : argent, quantités, temps, identifiants,
│   │                          moteur de prix, politiques, disponibilité, allocations, conversions d'unités
│   └── contracts/             schémas zod : enveloppe de commande, commandes par type et par version,
│                              jeux synchronisés, codes de résultat et d'erreur
├── db/
│   ├── migrations/            SQL versionné (expand/contract), un préfixe par schéma de module
│   └── seeds/                 rôles, permissions et portées (source unique de la matrice RBAC),
│                              emplacements virtuels, paramètres par défaut, motifs initiaux
├── tools/                     génération des tests RBAC, règles de frontières de modules
└── .github/workflows/         CI : lint, typage, tests, frontières, budget de bundle, check_refs, secrets
```

Règles structurelles (déjà décidées, à respecter dès le premier commit) :

| Règle | Source |
|---|---|
| Les 19 dossiers de `apps/server/src/modules` portent les noms des modules et des schémas PostgreSQL | [`../05-architecture/02-modules.md`](../05-architecture/02-modules.md) |
| Un module n'importe que l'API publique des modules de niveau inférieur ; contrôle en CI | [`../05-architecture/03-graphe-dependances.md`](../05-architecture/03-graphe-dependances.md), NFR-32 |
| Structure interne `api/`, `application/`, `domain/`, `infrastructure/` | [`../05-architecture/01-architecture-logicielle.md`](../05-architecture/01-architecture-logicielle.md) §3 |
| `packages/domain` n'a aucune entrée-sortie (horloge et identifiants injectés) | ADR-021, audit DT-06 |
| Toute écriture passe par une commande ; pas d'endpoint CRUD sur une table transactionnelle | BR-SYN-001, ADR-019 |
| Une table n'est écrite que par son module propriétaire ; un rôle de base par schéma | INV-GLO-05 |
| Tables de registre et journaux partitionnés dès leur création | Audit DT-04 |

## 3. Backlog de P0 (ordonné)

Chaque élément cite ses spécifications. « Fait » = critère vérifiable. Les éléments d'un même bloc peuvent être menés en parallèle.

| ID | Élément | Spécifications | Fait quand |
|---|---|---|---|
| **Bloc A — socle** | | | |
| P0-01 | Monorepo, outillage, CI avec tous les contrôles bloquants | [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md) §2.5 ; [`../05-architecture/04-deploiement.md`](../05-architecture/04-deploiement.md) §3 | CI verte sur le squelette ; une violation de frontière de module fait échouer la CI (AT-055) |
| P0-02 | `packages/domain` socle : UUIDv7, horloge injectée, argent (XAF entiers), quantités (millièmes), jour métier `Africa/Douala`, arrondis | ADR-002, ADR-013, ADR-016 ; [`../03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md) | Tests unitaires et de propriétés verts ; couverture ≥ 90 % (NFR-31) |
| P0-03 | `packages/contracts` : enveloppe de commande, résultats, codes d'erreur, versionnement par type | [`../06-offline-sync/02-synchronisation.md`](../06-offline-sync/02-synchronisation.md) §2, §3.3, §7 ; [`../08-api-events/01-architecture-api.md`](../08-api-events/01-architecture-api.md) | Schémas partagés compilés côté appareil et serveur ; OpenAPI générée |
| **Bloc B — base de données** | | | |
| P0-04 | Migrations des schémas `platform`, `audit`, `identity`, `organization`, `approvals`, `attachments`, `sync` ; extensions ; rôles de base par schéma ; déclencheurs d'immuabilité ; partitionnement | Dictionnaire [`01`](../03-data/dictionnaire/01-identity.md), [`02`](../03-data/dictionnaire/02-organization.md), [`10`](../03-data/dictionnaire/10-approvals-attachments-communication.md), [`11`](../03-data/dictionnaire/11-audit-sync-integrations-platform.md) ; [`../03-data/03-historisation-suppression.md`](../03-data/03-historisation-suppression.md) ; INV-GLO-03 | Migrations rejouables en staging ; tests d'intégration des contraintes et de l'immuabilité verts |
| P0-05 | Seeds : 11 rôles, 117 permissions et portées, emplacements virtuels, paramètres par défaut (valeurs par défaut des AV) | [`../07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md) ; BR-ADM-010 ; dictionnaire `organization.system_settings` | Seed idempotent ; tests RBAC générés depuis le seed |
| **Bloc C — serveur** | | | |
| P0-06 | Pipeline de commande : authentification → appareil → droits à `occurred_at` → validation → gestionnaire → écriture + audit + événement + réponse d'inbox, dans une seule transaction | [`../05-architecture/01-architecture-logicielle.md`](../05-architecture/01-architecture-logicielle.md) §4 ; ADR-011 ; BR-SYN-001 à 008 ; RC-01, RC-02 | Une commande de démonstration traverse le pipeline ; rejet sans effet (INV-SYN-05) |
| P0-07 | Audit chaîné et lecture du journal | BR-AUD-001 à 010 ; [`../07-security-rbac/03-audit.md`](../07-security-rbac/03-audit.md) | INV-AUD-01 et INV-AUD-02 testés ; vérification quotidienne de la chaîne |
| P0-08 | Outbox d'événements, file de tâches, worker, numérotation des documents | ADR-011 ; [`../08-api-events/02-catalogue-evenements.md`](../08-api-events/02-catalogue-evenements.md) §1 ; BR-ADM-021, 022 | Consommateur de test exactement-une-fois par clé ; numéros sans doublon (INV-GLO-07) |
| P0-09 | `identity` : connexion, jetons, rotation, appareils (enrôlement, approbation, blocage, perte), sessions, révocation | [`../07-security-rbac/02-securite.md`](../07-security-rbac/02-securite.md) §2, §3 ; SM-USER, SM-DEVICE ; BR-ADM-001 à 007, 023, 024 | AT-034, AT-035 verts |
| P0-10 | RBAC : évaluation des portées, règles contextuelles, cache invalidé par événement | [`../07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md) §2 à §4 ; RC-01 à RC-10 | Tests RBAC générés verts (plan de tests §5) ; 100 % des endpoints couverts (NFR-24) |
| P0-11 | `organization` : sites, emplacements, zones, équipes, structure des PDV, paramètres historisés | D01 ; BR-ADM-008 à 015 | Commande `organization.setting.set` démontrée ; historique des paramètres lisible |
| P0-12 | `sync` : push idempotent ordonné, pull par périmètre, chargement initial, états, conflits, support N-1 | [`../06-offline-sync/`](../06-offline-sync/) ; ADR-007 ; SM-SYNC-COMMAND, SM-CONFLICT | AT-002, AT-036, AT-050 verts ; harnais : aucune duplication après 100 coupures (NFR-19) |
| P0-13 | `approvals` et `attachments` (socle) : politiques, demandes, gestionnaires enregistrés ; upload par morceaux reprenable | ADR-012, ADR-018 ; SM-APPROVAL, SM-ATTACHMENT ; BR-ADM-016 à 020 | Validation de démonstration appliquée dans la transaction de décision ; upload interrompu puis repris (NFR-08) |
| **Bloc D — appareil** | | | |
| P0-14 | PWA squelette : installation, service worker, base Dexie (outbox, projections, curseurs), enrôlement, connexion, PIN, accueil par rôle, pastille et écran de synchronisation, i18n | ECR-ADM-01 à 03, ECR-SYN-01 ; UX-01 à UX-11 ; [`../06-offline-sync/01-architecture-offline.md`](../06-offline-sync/01-architecture-offline.md) | Fonctionne sans réseau après installation ; NFR-02 et NFR-05 mesurés sur l'appareil de référence |
| P0-15 | Harnais de synchronisation (clients virtuels, coupures, horloges décalées) | [`../09-non-functional/03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md) §3 | Scénarios de base automatisés en CI |
| **Bloc E — exploitation** | | | |
| P0-16 | Observabilité : logs structurés avec `correlation_id`, traces, capture des erreurs, `/health` | [`../09-non-functional/02-observabilite.md`](../09-non-functional/02-observabilite.md) | NFR-28 vérifiée par injection d'erreurs |
| P0-17 | Staging déployé ; procédure de restauration testée | [`../05-architecture/04-deploiement.md`](../05-architecture/04-deploiement.md) §3, §5 | Procès-verbal de restauration (NFR-23) |
| P0-18 | Démonstration de sortie de phase | Plan §4, P0 | AT-002, AT-034, AT-035, AT-036, AT-050, AT-055 verts ; démonstration hors ligne sur l'appareil de référence |

Ordre de dépendance : A → B → C (P0-06 avant P0-07 à P0-13) ; D démarre après P0-03 en parallèle de C ; E en continu. Durée indicative : 5 à 6 semaines pour 2 développeurs (plan §2).

## 4. Règles pour chaque session de développement

Ces règles sont reprises dans [`../../CLAUDE.md`](../../CLAUDE.md).

| # | Règle |
|---|---|
| R1 | Commencer par `CLAUDE.md`, puis l'index [`../README.md`](../README.md), puis la fiche de la phase en cours (plan §4) |
| R2 | Pour une fonctionnalité : lire le domaine (`01-functional/domaines/Dnn`), les tables (dictionnaire), la machine à états (SM-*), le workflow (WF-*), les permissions (RBAC) et les AT rattachés |
| R3 | Ne jamais combler un trou de spécification en silence : créer un `AV-nnn`, implémenter le défaut de façon paramétrable, le signaler |
| R4 | Respecter la classification : une valeur marquée À VALIDER n'est jamais présentée comme une exigence ; une décision tranchée met à jour le registre (journal) et les documents concernés |
| R5 | Toute écriture est une commande idempotente ; aucun fait accompli n'est rejeté pour une raison d'état (BR-SYN-007) |
| R6 | Aucune suppression physique d'une opération sensible ; correction par annulation ou contre-écriture (ADR-006) |
| R7 | Chaque invariant `INV-*` touché par le code a au moins un test ; chaque AT de la phase est automatisé |
| R8 | Dans le même commit que le code : dictionnaire, matrice, registre AV, ADR, index des règles (`python3 docs/_tools/check_refs.py --index`) si concernés |
| R9 | Avant de pousser : CI locale verte, y compris `python3 docs/_tools/check_refs.py` |
| R10 | Aucune donnée réelle hors production ; jeux synthétiques uniquement |
| R11 | Ne pas démarrer une phase dont un AV bloquant est ouvert (AV-024 et AV-025 pour P4) ; le signaler et travailler sur une autre phase ou préparer les éléments indépendants |

## 5. Suivi de l'avancement

| Élément | Où | Quand |
|---|---|---|
| État des phases | Plan §2 (colonne à ajouter : « État ») | À chaque fin de phase |
| Décisions métier | Registre AV §3 (journal) | À chaque décision |
| Décisions techniques | Nouvel ADR (numérotation continue après ADR-022) | À chaque décision structurante |
| Couverture des exigences | Matrice de traçabilité | À chaque fin de phase |
| Risques | Registre des risques (mise à jour de la probabilité et de l'impact) | Mensuellement |

## 6. Ce qui n'est pas encore fait (et pourquoi)

| Élément | Raison | Déclencheur |
|---|---|---|
| Code applicatif, migrations, composants UI, endpoints | Interdit avant la validation du cadrage (PM §51, consigne de démarrage) | Checklist P0 cochée |
| Choix définitif de l'hébergeur | Décision juridique et budgétaire de GIC (AV-073, AV-084) | Décision de la Direction |
| Contrats détaillés de chaque commande | Écrits phase par phase dans `packages/contracts`, à partir des domaines et du catalogue de commandes de l'API | Début de chaque phase |
| Maquettes graphiques des écrans | L'inventaire des écrans et les règles UX sont fixés ; la charte graphique n'est pas une exigence des sources | Début de P0 (écrans ECR-ADM, ECR-SYN), avec les utilisateurs pilotes |
