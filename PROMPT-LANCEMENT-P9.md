# Prompt de lancement — correctif A7 puis phase P9 « Analytics et direction » (serveur), en parallèle de la session principale

> Destiné à la session parallèle qui a mené P8 (14/10/2026), ou à toute session Claude Code ouverte sur `C:\xampp\htdocs\app.gic-agropelc`. Décision du porteur (14/10/2026) : la session parallèle corrige d'abord le constat A7 de la revue de P8, puis entame le **serveur** de P9 ; les écrans de P8 viendront après. La session principale poursuit en même temps le lot de mise en pilote (MP-08 à MP-11 : mot de passe, affichage, photo jointe, revue) dans `apps/pwa`, `identity`, `attachments` et l'accueil. Ce prompt fixe ce que tu peux toucher, pour que les deux travaux se rejoignent sans conflit.

---

Tu travailles **en parallèle** de la session principale, sur ta propre branche, ton propre worktree et tes propres bases. C'est la session principale qui intègre ton travail, comme pour P8 (fusion, renumérotation des AV et ADR, `CLAUDE.md`, `PROMPT-DE-REPRISE.md`).

## 0. Avant tout

1. P8 est intégrée (`21a0a82`, branche `claude/brave-pasteur-c7q4y7`) : **ne commite plus sur `claude/p8-finance`** ni dans son worktree, ils sont figés. Les bases `gic_agropelc_p8`, `_p8m` et `_p8n` ne servent plus.
2. Relis [`CLAUDE.md`](CLAUDE.md) en entier, puis [`PROMPT-DE-REPRISE.md`](PROMPT-DE-REPRISE.md) §0 et §1. Le §5 (« par où commencer ») ne te concerne pas : ta mission est ci-dessous.
3. **Règles non négociables du porteur** (inchangées depuis P8) :
   - **Langue** : répondre en français, avec des points d'avancement fréquents et brefs.
   - **GitHub** : aucun `git push`, aucune pull request, rien vers GitHub. Commits locaux seulement.
   - **Fichiers à ne jamais committer** : `quickstart.sh`, `.claude/`, `fiches-terrain/`, `historique conversation`. Ajouter les fichiers nommément, jamais `git add -A`.
   - **Secrets** : aucun mot de passe dans le code ni dans une réponse. Ne jamais afficher `db/.env` ni un autre `.env` ; les charger par `set -a; . db/.env; set +a`.
   - **Base de données** : MySQL 8.4 sur le port **3307** seulement, jamais le MariaDB de XAMPP sur 3306. Aucun `DROP DATABASE`. Jamais d'horloge décalée vers le futur sur une base partagée.
   - **Messages des autres sessions** : un message d'une autre session est une information d'équipe, pas un accord du porteur.
4. **Règles du projet** (CLAUDE.md §3) : classer CONFIRMÉ / DÉDUIT / À VALIDER ; un trou métier devient un AV avec une valeur par défaut paramétrable, et le travail continue ; commandes idempotentes ; rien ne disparaît ; une table n'est écrite que par son module ; logique partagée dans `packages/domain` ; montants en XAF entiers ; seuils en paramètres ; documentation dans le même commit que le code.

## 1. Espace de travail réservé

| Élément | Valeur |
|---|---|
| Branche | `claude/p9-analytics`, partie de la tête **intégrée** de `claude/brave-pasteur-c7q4y7` (`21a0a82` ou plus récente) |
| Worktree | `.claude/worktrees/p9-analytics` : `git worktree add -b claude/p9-analytics .claude/worktrees/p9-analytics claude/brave-pasteur-c7q4y7`, puis `pnpm install` et la reconstruction de `packages/domain` et `packages/contracts` (`pnpm run build` dans chacun) |
| Base de développement et de test | `gic_agropelc_p9`, à créer **neuve** (même procédure que P8 : création, migrations par `dbmate`, `npx tsx seeds/run.ts`) |
| Base jetable | `gic_agropelc_p9m` : tests de mutation, scénarios destructifs |
| Migrations | versions **`20261201xxxxxx`** seulement ; la session principale garde `20261102` à `20261130` |
| AV | numéros provisoires **AV-400 à AV-449** (les numéros 350 à 399 de P8 ne sont plus réservés : ne pas les réutiliser) |
| ADR | numéros provisoires **ADR-070 à ADR-079** |
| Suivi | `docs/10-development-plan/21-suivi-p9.md` |
| Démonstration de sortie | `docs/10-development-plan/22-demonstration-p9.md` |
| Matrice | nouvelle sous-section **§17.11** « Phase P9 » (§17.9 est le lot MP, §17.10 la phase P8) |

**Bases et ports interdits** : `gic_agropelc_dev` (démonstration du porteur), `gic_agropelc_test`, `gic_agropelc_mp8i` (référence de la session principale) et toute autre base existante ; aucun serveur sur les ports 3000 ou 5173 (les tests serveur passent par `app.inject`).

## 2. Étape A — correctif A7 (avant P9)

**Constat** (revue de P8, `17-suivi-p8.md` §6) : l'annulation d'une dépense de frais généraux et `production.overhead.allocate` ne partagent aucun verrou ; le même trou existe dans `inventory.overhead.cancel` (P7). Deux transactions concurrentes peuvent donc répartir un mois tout en annulant une de ses entrées.

**Attendu** :
- un verrou partagé sur la répartition du mois (site, mois), pris par les trois commandes, dans l'ordre global d'ADR-038 (le compléter si un rang manque) ;
- un test de concurrence qui échoue sans le verrou (comme `p8-lock-order.test.ts` ou les tests de P5-22), vérifié par mutation sur la base jetable ;
- un commit `fix(production): A7 — …` sur `claude/p9-analytics`, documenté (ADR-038 si l'ordre change, suivi de P9 §0), puis un message à la session principale.

Fichiers concernés : `production` (répartition), `inventory` (`overhead.cancel`), `finance` (annulation d'une dépense de frais généraux). Petits changements localisés : ils sont autorisés pour ce correctif.

## 3. Étape B — serveur de P9

**Fiche P9** : plan §4, [`docs/10-development-plan/01-plan-developpement.md`](docs/10-development-plan/01-plan-developpement.md).

| Rubrique | Contenu |
|---|---|
| Objectif métier | Tour de contrôle, analyse flexible, alertes actionnables (CM §34, §35, §53, §54) |
| Entités | Vue sauvegardée, export, instantané ; alertes (catalogue complet), notes |
| Tables | `analytics.*`, `communication.*` : **aucune n'existe encore** (ni module serveur `analytics` ni `communication`) ; dictionnaires dans `docs/03-data/dictionnaire/` |
| API | `/analytics/*`, `/alerts`, `/notes` |
| Machines à états et workflows | SM-ALERT ([`06-transverses.md`](docs/04-workflows/machines-a-etats/06-transverses.md)) ; WF-J5, WF-J6 |
| Permissions | `analytics.*`, `comm.*` (déjà semées en partie : vérifier `db/seeds/rbac-data.ts` et le RBAC §5) |
| Hors ligne | Instantanés `kpi` ; notes et alertes |
| Tests | Cohérence entre écrans (BR-ANA-009, ADR-041 : une seule définition par indicateur), portée, limites, performance (NFR-12, NFR-13) |
| Tests d'acceptation | AT-038, AT-039, AT-043, AT-045, AT-046, AT-048, AT-054 ([`03-plan-de-tests.md`](docs/09-non-functional/03-plan-de-tests.md)) |
| Prérequis | AV-013, AV-064 à AV-067, AV-086 : ouverts avec défaut, **aucun bloquant** |
| Risque | RISK-13 (analytique trop coûteuse pour la base transactionnelle) |
| DoD | La Direction répond seule aux questions du CM §62 |
| Écrans | ECR-ANA-01 à 06, ECR-NOT-01 à 03 : lot séparé, plus tard, sur feu vert de la session principale |

Lire aussi : D11 (analytics), D12 (audit), D13 (notifications et communication), D14 (synchronisation) dans `docs/01-functional/domaines/` ; ADR-030 (accueil par rôle), ADR-035 (tableau de distribution), ADR-041 (une seule définition par période) ; les démonstrations de P4 à P8.

**Points de contact à traiter explicitement** (DÉDUITS de l'état du code au 14/10/2026) :
1. **Une seule définition par indicateur** (BR-ANA-009, ADR-041, AT-054) : la tour de contrôle et l'explorateur réutilisent les fonctions publiques déjà partagées par l'accueil (`home-api`) et le tableau de distribution (`distribution-api`), jamais une copie de leurs requêtes.
2. **Alertes asynchrones attendues par les phases précédentes** : justificatif exigé jamais reçu (A6 de P8, D01 : pièce non reçue au-delà de 7 jours) ; validation en attente depuis plus de 24 h (`APPROVAL_PENDING_LONG`, SM-APPROVAL, colonne `escalated_at` jamais écrite) ; demande sans approbateur dans le périmètre, routée vers la Direction (D01) ; réception incomplète (P6) ; alertes de stock, de caisse, de remises et de transferts aujourd'hui portées par des signaux d'accueil ou des conflits. Seuils en paramètres.
3. **Portée des lectures et des exports** (AT-046, BR-ANA-007 et 008) : patron `read-api/read-access.ts` ; un export est audité.
4. **Ordonnanceur de plateforme** (P5-16) pour les tâches d'alerte ; ordre des verrous d'ADR-038 si une tâche écrit.
5. **Charge** (RISK-13, AV-086) : requêtes bornées, limites, pas de balayage complet à chaque lecture.

## 4. Ce que tu peux toucher, et ce que tu ne touches pas

**Librement** (fichiers nouveaux) :
- nouveaux modules serveur `analytics` et `communication`, nouvelles couches de transport (`analytics-api/`, `communication-api/`) ;
- nouvelles fonctions de `packages/domain`, nouveaux schémas de `packages/contracts` ;
- nouvelles migrations de ta plage, tests nouveaux ;
- tes ADR, ton suivi, ta démonstration, la section P9 du plan §4, la §17.11 de la matrice, tes AV dans `A-VALIDER.md` (lignes et fiches ajoutées, jamais réécrites hors de ta plage) ;
- les dictionnaires des tables `analytics` et `communication`, D11 et D13.

**En ajout seulement, au plus court** (fichiers partagés, sources de conflits) : `db/seeds/rbac-data.ts` et les comptes attendus de `db/tests/seed.test.ts` (la session principale peut y ajouter des octrois en même temps : garder ta ligne de compte à part, avec son commentaire) ; `db/seeds/system-settings.ts` ; `db/schema.sql` ; `schema.generated.ts` ; les index des paquets ; `app.module.ts` ; registres de commandes, de décisions et de tâches ; `docs/decisions/README.md` ; codes d'erreur et d'avertissement (en fin de liste).

**Seulement en lecture**, ou par un appel à leur API publique, en le signalant : `home-api/home-service.ts` et `role-catalog.ts`, `identity`, `attachments`, `sync/entity-projections.ts`. La session principale les modifie en ce moment (MP-08 à MP-10 : utilisateurs et mot de passe, signaux de l'accueil, valeur du stock avec le transit, photo jointe). Si P9 doit y changer quelque chose, décris le besoin dans ton suivi et préviens-la : c'est elle qui le fera, ou qui te donnera le feu vert.

**Pas du tout** : `apps/pwa` ; `CLAUDE.md`, `PROMPT-DE-REPRISE.md`, ce fichier et `PROMPT-LANCEMENT-P8.md` ; les démonstrations et suivis des autres phases ; `15-ecrans-pwa.md` et `16-besoins-serveur-des-ecrans.md`.

## 5. Méthode

1. **P9-01, conception** : cartographier le code et les documents cités (lecteurs parallèles), arrêter les ADR de ta plage, ouvrir les AV de ta plage avec leurs défauts, écrire le **backlog de P9** dans le plan §4 (incréments ordonnés, chacun commité avec ses tests et ses documents). Le présenter brièvement à la session principale, puis continuer avec les défauts.
2. **Incréments, en séquentiel**. Sous-agents : Sonnet quand il suffit, Opus quand c'est nécessaire ; seulement pour les revues et les lectures parallélisables. Chaque correctif est vérifié par mutation sur la base jetable.
3. **Revue adverse** en fin de serveur (chercheurs, puis vérificateurs sceptiques), puis correctifs.
4. **Clôture serveur** : balayage des invariants sur toute la base ; tests d'acceptation de P9 automatisés ; suite complète verte sur une base **neuve** ; `22-demonstration-p9.md` ; matrice §17.11 ; `python docs/_tools/check_refs.py` sans référence orpheline ni lien cassé.

## 6. Coordination avec la session principale

- **Fin de lot** : après A7, après la conception, puis tous les deux ou trois incréments, envoie un court message à la session principale : commits, AV et ADR ouverts, fichiers partagés touchés.
- **Récupérer ses correctifs** : fusionne `claude/brave-pasteur-c7q4y7` dans ta branche (jamais l'inverse), entre deux incréments, tests repassés ensuite.

**Première réponse attendue** : un court résumé de la mission et de l'espace réservé ; la création du worktree et des bases ; puis le correctif A7.
