# Prompt — fork « Écrans PWA » (GIC AGROPELC)

Tu travailles sur **GIC AGROPELC** en **parallèle d'une session principale** qui termine la phase P5 côté serveur (`apps/server`, `db`, `packages/*`, documents de suivi). Ta mission : construire les **écrans de la PWA** (`apps/pwa`) des phases dont le code serveur est terminé, sans jamais toucher aux fichiers de la session principale. Quand tu auras fini, le porteur demandera à la session principale de fusionner ta branche.

## 0. À lire avant tout

1. `CLAUDE.md`, puis `PROMPT-DE-REPRISE.md` §1 (environnement Windows, MySQL 8.4 sur le port 3307, commandes, pièges) et §2 (état du projet). Respecte leurs règles et celles de ta mémoire : réponses **en français** avec des points d'avancement fréquents ; **jamais de `git push`, de pull request ni d'écriture sur GitHub** ; commits en français préfixés par la portée ; fichiers ajoutés **nommément** (jamais `git add -A`) ; ne touche jamais `fiches-terrain/`, le fichier « historique conversation » ni `quickstart.sh`.
2. `docs/01-functional/03-parcours-et-ecrans.md` (liste des écrans `ECR-*`, rôles, hors ligne, phase), `docs/06-offline-sync/` (architecture hors ligne, synchronisation, jeux de données), `docs/08-api-events/01-architecture-api.md` (API et commandes), `docs/decisions/ADR-030-accueil-par-role.md` (accueil, seul écran métier existant), `docs/10-development-plan/13-demonstration-p4.md` (ventes).
3. Le code PWA existant : `apps/pwa/src` (`app`, `features/auth`, `features/home`, `features/sync`, `sync/pull.ts`, `storage`, `platform`, `i18n/fr.ts`).

## 1. Mise en place (isolation stricte)

- **Ne travaille pas dans la copie principale** `C:\xampp\htdocs\app.gic-agropelc` (branche `claude/brave-pasteur-c7q4y7`) : la session principale y écrit.
- Crée ton worktree et ta branche, puis travaille **uniquement dedans** :
  `git worktree add .claude/worktrees/pwa-ecrans -b claude/pwa-ecrans claude/brave-pasteur-c7q4y7`
- Copie les deux fichiers ignorés par git, `db/.env` et `apps/server/.env`, de la copie principale vers ton worktree. **N'affiche jamais leur contenu.** Puis `pnpm install --frozen-lockfile --prefer-offline` et `pnpm --filter @gic/domain --filter @gic/contracts run build`.
- **Base de données** : MySQL 8.4 (port 3307, jamais le MySQL de XAMPP sur 3306). S'il est arrêté, relance-le en processus détaché (PowerShell `Start-Process` décrit dans le prompt de reprise). Pour faire tourner l'API locale derrière tes écrans, utilise **`gic_agropelc_dev`** (déjà migrée, c'est la cible de `apps/server/.env`). N'utilise **ni** `gic_agropelc_test` **ni** `gic_agropelc_base` (réservées aux suites de la session principale) ; aucun `DROP DATABASE`, aucune migration ni seed destructif.
- **Serveurs de développement** : crée dans ton worktree un `.claude/launch.json` dont les deux configurations (`server:dev` sur le port 3000, `pwa:dev` sur le port 5173) pointent sur **ton** worktree (chemin absolu de ton `apps/server/.env`). Utilise `preview_start` pour les lancer. La connexion se fait avec le compte administrateur local, dont les identifiants sont dans `db/.env` : ne les affiche ni ne les répète jamais.

## 2. Périmètre, dans l'ordre

a) **Socle de l'appareil** : appliquer sur l'appareil les jeux hors ligne que le serveur publie depuis P1. Aujourd'hui, `KNOWN_DATASETS` (`apps/pwa/src/sync/pull.ts`) ne contient que les jeux de P0. Jeux publiés côté serveur : `stock`, `transfers`, `counts`, `customers`, `crm_activity`, `fieldwork`, `procurement`, `production`, `orders`, `sales_recent`, `cash`, `allocations`, `comms`, et les référentiels du catalogue et des prix. Vérifie les noms exacts et les formes dans `apps/server/src/platform/sync/` et `docs/06-offline-sync/`. Il faut aussi les magasins Dexie, les versions, `SCOPE_EXIT`, et la file d'envoi des commandes (enveloppe `command_id`, `device_seq`, `occurred_at`, hors ligne), à compléter si elle est absente ou partielle.

b) **Navigation par rôle** depuis l'accueil (ECR-ADM-03) : menu et accès aux écrans selon les permissions de l'utilisateur.

c) **Ventes (P4)**, en premier :

| Écran | Rôle |
|---|---|
| ECR-VEN-01 | Nouvelle vente, encaissement intégré |
| ECR-VEN-02 | Nouvelle commande |
| ECR-VEN-03 | Liste des commandes |
| ECR-VEN-04 | Livrer une commande |
| ECR-VEN-05 | Détail d'une vente, reçu, annulation |
| ECR-VEN-06 | Encaisser une créance |

Les écrans marqués « hors ligne : Oui » fonctionnent sans réseau. Ils utilisent la logique partagée de `packages/domain` : prix, disponibilité, et blocage local d'une vente hors ligne au-delà du quota d'appareil (`decideLocalConsumption`, AV-025).

d) **Si le temps le permet**, dans cet ordre :
1. stock (ECR-STK, P2) ;
2. CRM terrain (ECR-CRM, P3) ;
3. approvisionnement (ECR-APP, P6) ;
4. production (ECR-PRD, P7) ;
5. administration du catalogue et des prix (ECR-PRX-01 à 03, P1).

**Hors périmètre** :
- les écrans de P5 (ECR-DIS-01 à 04, ECR-FIN-05, ECR-STK-06), dont le serveur est en cours ;
- tout écran de P8, P9 et P10.

## 3. Règles de non-collision avec la session principale

- **Tu peux modifier** :
  - `apps/pwa/**` ;
  - dans `docs/`, seulement `docs/01-functional/03-parcours-et-ecrans.md` (statut des écrans) et un **nouveau** fichier de suivi `docs/10-development-plan/15-ecrans-pwa.md` ;
  - un éventuel ADR dans la plage réservée.
- **Tu ne modifies pas** :
  - `apps/server`, `db`, `packages/domain`, `packages/contracts` (lecture seule) ;
  - `CLAUDE.md`, `PROMPT-DE-REPRISE.md` ;
  - `docs/10-development-plan/01-plan-developpement.md`, `02-matrice-tracabilite.md`, `docs/A-VALIDER.md`.
- **Une API, un contrat ou une logique partagée manque ou ne convient pas** : ne touche pas au serveur. Consigne le besoin précis (route, champs, exemple) dans la section « Besoins côté serveur et contrats » du fichier de suivi, et adapte l'écran (fonction désactivée, message clair). La session principale fera le serveur.
- **Une question métier n'est pas couverte** : crée un point AV dans la **plage réservée AV-300 à AV-349**, rédigé dans la section « AV proposés » du fichier de suivi (question, pourquoi, choix, recommandation, impact, classe). Implémente la valeur par défaut recommandée de façon paramétrable.
- **Une décision est structurante** : **ADR-050 à ADR-059**, dans `docs/decisions/`.
- **Git** : commits locaux sur `claude/pwa-ecrans` uniquement, un incrément par commit (`feat(pwa): …`), terminés par la ligne `Co-Authored-By` demandée par l'environnement.

## 4. Qualité

- **Chaque écran** :
  - textes dans `apps/pwa/src/i18n/fr.ts` ;
  - appels réseau par `authorizedRequest`, jamais `fetch` direct (piège connu : un seul renouvellement de jeton à la fois) ;
  - tests vitest et Testing Library ;
  - mobile d'abord (375 px), accessibilité de base ;
  - vérification réelle dans le navigateur intégré, avec une capture d'écran à l'appui.
- **Contrôles avant chaque commit** :
  - `cd apps/pwa && npx vitest run` ;
  - typage de la PWA ;
  - `npx eslint` sur les fichiers modifiés ;
  - Prettier sur les fichiers modifiés (copie en CRLF : confirmer par `npx prettier <f> | diff --strip-trailing-cr <f> -`).
- **Hors ligne** : teste au moins une saisie sans réseau, puis sa synchronisation.

## 5. Méthode

- Travaille **en séquentiel** par défaut. Réserve les sous-agents aux lectures et aux revues, avec un modèle choisi selon la tâche (Sonnet quand il suffit) : cette session et la session principale consomment le **même quota**.
- Garde le fichier de suivi à jour à chaque commit : écrans livrés, tests, besoins serveur, AV proposés.

## 6. Fin du fork

Quand le porteur le demande, ou quand les points a) à c) sont terminés :
1. mets le fichier de suivi à jour ;
2. fais un dernier commit ;
3. donne au porteur un résumé à transmettre à la session principale :
   - branche et premier/dernier commit ;
   - écrans livrés ;
   - fichiers touchés hors de `apps/pwa` ;
   - besoins côté serveur ;
   - AV et ADR proposés.

La session principale fusionnera alors `claude/pwa-ecrans`.
