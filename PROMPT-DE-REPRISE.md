# Prompt de reprise — GIC AGROPELC (phase P4 terminée ; prochaine phase à choisir avec le porteur)

> Destiné à une nouvelle session d'agent de développement (Claude Code ou équivalent) qui reprend le projet **sans l'historique** de la session précédente. État vérifié le 07/10/2026 (fin de P4-14). Les sections 2 à 6 sont à jour ; l'historique détaillé des sessions précédentes est dans les démonstrations de phase (`docs/10-development-plan/07` à `13-demonstration-*.md`) et dans `git log`.

Tu reprends le développement de **GIC AGROPELC**, une application de gestion (ventes, stock, CRM terrain, achats, production avicole et porcine, finance) pour un groupement d'éleveurs au Cameroun. Le cadrage est terminé ; le **code serveur des phases P0, P1, P2, P3, P4, P6 et P7 est terminé** (démonstrations de sortie dans `docs/10-development-plan/`). Ton premier travail : vérifier le point de départ (§5, étape 0), puis demander au porteur quelle phase engager (§5, étape 1).

---

## 0. À lire et à respecter avant tout

1. Lis [`CLAUDE.md`](CLAUDE.md) en entier : règles absolues (classement CONFIRMÉ / DÉDUIT / À VALIDER, aucun trou comblé en silence → point `AV-nnn`, commandes idempotentes, rien ne disparaît, frontières de modules, logique partagée dans `packages/domain`, XAF entiers, seuils = paramètres) et documents à lire avant une phase (§4). La phrase « chaque incrément est commité et poussé » de `CLAUDE.md` §1 (ligne P1) **ne s'applique plus** : le porteur interdit tout push sans sa demande explicite (voir 3).
2. Lis ensuite, dans cet ordre : la démonstration de sortie de P4 ([`docs/10-development-plan/13-demonstration-p4.md`](docs/10-development-plan/13-demonstration-p4.md)) ; [`docs/03-data/01-identifiants-et-conventions.md`](docs/03-data/01-identifiants-et-conventions.md) (blocs `[STD-*]`, types logiques → MySQL, unicités partielles par colonne générée, préfixes de numéros, nommage) ; puis, pour la phase retenue à l'étape 1 (§5), sa fiche et son backlog dans [`docs/10-development-plan/01-plan-developpement.md`](docs/10-development-plan/01-plan-developpement.md) §4 et les documents qu'elle cite (CLAUDE.md §4).
3. **Règles de collaboration avec le porteur du projet** (non négociables) :
   - répondre **en français**, avec des points d'avancement **fréquents et brefs** ; il demande souvent le « taux d'avancement » : répondre par un petit tableau ;
   - toute question métier non couverte : la poser avec un **choix multiple**, option recommandée en premier, en langage simple (reformuler s'il ne comprend pas) ; en attendant, implémenter la valeur par défaut **paramétrable** et tracer un `AV-nnn` (prochain identifiant libre : **AV-153** ; prochain ADR : **ADR-032** — ADR-030 est déjà cité par le code de l'accueil par rôle, `packages/contracts/src/home.ts`, mais son fichier n'existe pas : le rédiger ou le faire trancher par le porteur) ;
   - **ne jamais faire `git push`** ni toucher à un dépôt distant **sans une demande explicite et nouvelle du porteur dans la session**. Le 07/10/2026, le porteur a demandé de pousser son dossier local vers GitHub puis de développer et pousser sur la branche `claude/brave-pasteur-c7q4y7` : cette autorisation valait pour cette session ; ne jamais créer de pull request sans demande ;
   - messages de commit en français, préfixés par la portée (`feat(sales): …`, `docs(p4): …`, `test(…)`, `fix(…)`) ;
   - **ne jamais committer** `quickstart.sh` (seul son mode d'exécution a été perdu sous Windows, contenu inchangé) ni le fichier `historique conversation` à la racine (fichier personnel du porteur) : ajouter les fichiers **nommément**, jamais `git add -A`.

## 1. Environnement local (Windows)

- Dépôt : `C:\xampp\htdocs\app.gic-agropelc` — monorepo **pnpm** : `apps/server` (NestJS + Fastify + Kysely + mysql2 + zod + vitest), `apps/pwa`, `packages/domain` (logique pure partagée appareil/serveur), `packages/contracts`, `db/` (migrations **dbmate**, seeds, tests).
- **Base de données : PAS le MySQL de XAMPP.** Celui de XAMPP (port 3306) est un MariaDB 10.4 incompatible avec le schéma ; `C:\xampp\htdocs` n'est qu'un emplacement de dossier ([`db/README.md`](db/README.md) §0). Le projet utilise un **MySQL Community Server 8.4** installé à part (`C:\Program Files\MySQL\MySQL Server 8.4`), **port 3307**, bases `gic_agropelc_dev` et `gic_agropelc_test`. Chemins propres au poste, hors dépôt : configuration `C:\Users\SMART\mysql84\my.ini`, données `C:\Users\SMART\mysql84\data`. La CI tourne sur `mysql:8.0` : écrire du SQL compatible MySQL 8.0.
- **Le porteur démarre lui-même MySQL** dans une fenêtre PowerShell qu'il laisse ouverte (ne pas lancer `mysqld` toi-même : les tâches de fond de l'agent sont limitées en durée et le serveur s'arrêterait au milieu des tests) :
  `& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe" --defaults-file="C:\Users\SMART\mysql84\my.ini" --console`
- **Accès à la base — `db/.env`** (créé sur le poste le 04/10 ; à recréer dans tout nouvel environnement). Le porteur le crée (hors dépôt : `db/.env` est ignoré par git, `.gitignore:18`) avec deux lignes pointant sur la **base de test**, port 3307 : `DATABASE_URL` (utilisateur admin `root`, pour dbmate, les seeds et les tests `db/`) et `SERVER_DATABASE_URL` (utilisateur applicatif `gic_app`, pour les tests serveur). `apps/server/.env` (déjà présent, ignoré) pointe sur la base de développement. Règles :
  - ne jamais écrire un mot de passe dans un fichier suivi par git ni le répéter dans une commande : charger le fichier (`set -a; . db/.env; set +a` sous Bash) ;
  - dbmate lit `db/.env` tout seul quand il est lancé depuis `db/` ; pour la **base de développement**, garder le même compte admin et changer seulement le nom de base (`DATABASE_URL="${DATABASE_URL%/*}/gic_agropelc_dev"` sous Bash), en vérifiant la cible par `npx dbmate status` avant `up` ;
  - `mysql`, `mysqladmin` et `mysqldump` ne sont pas dans le PATH : les appeler par leur chemin complet (`"/c/Program Files/MySQL/MySQL Server 8.4/bin/…"`), avec `--defaults-extra-file=<fichier d'options client hors dépôt>` en premier argument (sections `[client]` : user, password, host 127.0.0.1, port 3307).
- **Commandes** (depuis la racine sauf indication) :
  - domaine : `cd packages/domain && npx vitest run` ; **reconstruire** (`pnpm run build`) avant le typage du serveur dès qu'un export change ; la CI exige ≥ 90 % de couverture sur `packages/domain` (NFR-31) ;
  - contrats : `cd packages/contracts && npx vitest run` ;
  - base : `cd db && npx vitest run` (avec `DATABASE_URL` admin, base de test) ;
  - serveur : `cd apps/server && npx vitest run [fichier]` (avec `SERVER_DATABASE_URL`, base de **test**) ; suite complète **séquentielle** (base partagée et persistante) : 2 à 6 min, jusqu'à 30 min quand le poste est chargé — la lancer en arrière-plan et ne relancer que les fichiers en échec ;
  - contrôles : `pnpm run typecheck`, `pnpm run lint` (0 erreur, 1 avertissement préexistant dans la PWA), `pnpm run check:boundaries`, `npx prettier --check .`, `python docs/_tools/check_refs.py` (doit afficher « aucune référence orpheline » et « aucun lien relatif cassé ») ; `python docs/_tools/check_refs.py --index` régénère l'index des règles (il réécrit parfois le fichier en CRLF sans vraie différence : ne pas committer ce bruit) ;
  - **migrations** : nommer chaque nouveau fichier **à la main** avec une version **supérieure à la dernière migration du dépôt** (`20261007090000` le 07/10/2026) — pas `dbmate new` si l'horloge du poste est antérieure ; appliquer depuis `db/` avec `npx dbmate --migrations-dir ./migrations --schema-file ./schema.sql --no-dump-schema up`, **d'abord sur la base de test**, puis seulement si tout est vert sur la base de développement ; les migrations sont `transaction:false` : en cas d'échec, défaire à la main les instructions déjà passées avant de relancer ;
  - **`db/schema.sql`** se met à jour **à la main** : `mysqldump --no-data --triggers --skip-add-drop-table` des tables **créées et modifiées**, `DEFINER` remplacé par `` `gic_migrator`@`%` ``, bloc inséré dans l'ordre alphabétique (ou remplaçant le bloc existant d'une table modifiée, déclencheurs compris), version ajoutée en fin de liste `schema_migrations` (`dbmate dump` réécrit tous les `DEFINER` : bruit à ne pas committer) ;
  - **types Kysely** après une migration, depuis Bash dans `apps/server` : `npx kysely-codegen --dialect mysql --url "$DATABASE_URL" --out-file src/platform/kysely/schema.generated.ts` (le script `pnpm run db:codegen` passe par cmd.exe sous Windows, qui ne développe pas `$DATABASE_URL`) ; ils sont à jour au 07/10/2026 ;
  - **seeds** : `cd db && npx tsx seeds/run.ts` sur la base de test **et** de développement après toute modification ; rejouables sans effet destructif (insertion des absents ; rôles, permissions et attributions mis à jour ; une valeur de paramètre déjà semée ne change que par `SYSTEM_SETTING_REVISIONS`) ; `db/tests/seed.test.ts` vérifie **122 permissions et 497 attributions** (les assertions font foi) et **exactement 9 emplacements virtuels**.
- **Pièges connus** :
  - la base de test est **partagée et persistante** : chaque test crée ses propres données ; les paramètres système n'ont pas de fin de validité (la valeur la plus récente ≤ instant l'emporte) → valeurs stables ou datées au plus près ; une politique de contrôle de test doit avoir une fenêtre `validFrom`/`validTo` courte (la plus récente l'emporte) ;
  - tests à date fixe et tests relatifs à l'heure réelle cohabitent : les fenêtres hors ligne (30 jours, 7 jours) sont évaluées par la base à l'heure réelle ;
  - pour les éditions complexes, écrire un script dans un fichier temporaire plutôt qu'un heredoc (les accents graves et `${}` tronquent les heredocs) ;
  - avertissements Git « LF will be replaced by CRLF » : sans conséquence.

## 2. État du projet (vérifié le 07/10/2026)

| Phase | État | Référence |
|---|---|---|
| Cadrage | Terminé (référentiel `docs/`) | [`docs/README.md`](docs/README.md) |
| P0 Socle | Code terminé ; restent `staging` Hostinger (P0-17) et la démonstration sur appareil (P0-18) | `07-demonstration-p0.md` |
| P1 Catalogue, prix, fournisseurs | Code terminé | `08-demonstration-p1.md` |
| P2 Stock | Code terminé | `09-demonstration-p2.md` |
| P3 CRM terrain | Code terminé | `10-demonstration-p3.md` |
| **P4 Ventes** | **Code terminé** (P4-01 à P4-14) | `13-demonstration-p4.md` |
| P6 Approvisionnement | Code terminé ; reprise prévue pour AV-096 (réception hors site après validation) | `11-demonstration-p6.md` |
| P7 Production | Code terminé (CA et marge des lots livrés en P4) | `12-demonstration-p7.md` |
| P5, P8, P9, P10 | Non commencées | plan §4 |

- Tests au 07/10 : domaine **216** (17 fichiers, couverture ≥ 90 %), contrats **165**, base **117** (12 fichiers), PWA **58**, serveur **656** (85 fichiers) ; typage, lint, frontières, formatage et références verts ; **CI GitHub verte** sur la branche.
- Git : `main` sur GitHub contient le travail local poussé le 07/10 (jusqu'à P4-06, commit `417c791`) ; la branche **`claude/brave-pasteur-c7q4y7`** porte en plus les correctifs de CI, P4-06 (revue), P4-07 à P4-14 et AV-150. Sa fusion dans `main` (pull request) est à la main du porteur.
- Écrans PWA : **aucun écran métier** construit ; l'appareil n'applique encore que les jeux hors ligne de P0 (`apps/pwa/src/sync/pull.ts`) ; les API, les jeux hors ligne côté serveur et la logique partagée sont prêts. Aucun déploiement.
- Avancement estimé : code serveur ≈ 72 %, projet complet ≈ 48 % (les écrans PWA, P5, P8, P9, P10 et le déploiement restent).

## 3. Ce qu'a fait la session du 07/10/2026 (environnement distant, MySQL 8.0)

- Dossier local poussé vers GitHub par le porteur ; travail poursuivi sur la branche `claude/brave-pasteur-c7q4y7`.
- **CI rendue verte** : seeds dans la CI, tests du contrat d'accueil, exclusion des tests Playwright de vitest, faux positif gitleaks (gabarit de clés JWT), verrou de lecture partagé pour les frais généraux.
- **P4-06** corrigé après revue adverse ; **P4-07** livraisons (`sales.order.fulfil`) ; **P4-08** encaissements hors vente (doublons, réaffectation, remboursement, annulation, décisions de la Finance ; AV-151) ; **P4-09** créances, CA, coût des ventes, marges, CA des lots, réalisé des objectifs ; **P4-10** lectures HTTP (`sales-api/`, `finance-api/`, fiche client) avec portée par document et pré-filtre `listConfinementAt` (`identity`) ; **P4-11** jeux hors ligne `orders`, `sales_recent`, `cash`, encours dans `customers`, moyens de paiement dans `catalog` (**ADR-031** : clé de synchronisation dérivée d'un code), acompte d'une commande refusée hors ligne gardé en crédit (AV-150) ; **P4-12** revue adverse ; **P4-13** balayage des invariants et tests d'acceptation (dont les parts P4 d'AT-026 et AT-052 laissées par P7) ; **P4-14** clôture. AV-152 ouvert (mort d'animaux hors lot).

## 4. Évaluation et écarts connus

- **Solide** : chaque phase codée a ses invariants balayés sur toute la base, ses tests d'acceptation automatisés, sa démonstration et sa matrice ; les décisions sont tracées (A-VALIDER, ADR).
- **Écarts à traiter** (aucun bloquant) :
  - **ADR-030** cité par le code de l'accueil par rôle (`packages/contracts/src/home.ts`, `apps/server/src/*/home-metrics.ts`) sans fichier de décision dans `docs/decisions/` ;
  - **référentiels du seed** (motifs, sources de prospects, étapes, paramètres, politiques) et **unités / canaux de vente** pas encore publiés dans le flux de synchronisation : un appareil neuf ne les reçoit pas (ADR-031 donne la clé pour les référentiels à code ; les moyens de paiement sont publiés) ;
  - la PWA n'applique pas encore les jeux hors ligne des phases P1 à P7 (liste `KNOWN_DATASETS` de P0).
- **Pièges** : la base de test est partagée et persistante (chaque test crée ses données ; une donnée insérée à la main doit respecter les invariants balayés, ex. un titulaire de client exige sa ligne d'attribution, INV-CRM-02) ; les erreurs SQL non métier sont « transitoires » et rejouées sans fin : prévenir en code toute violation de `CHECK` ou de déclencheur.

## 5. Par où commencer

**Étape 0 — vérifier le point de départ** : base de test migrée et semée, `db/.env` présent ; suites complètes vertes (serveur **656**, base **117**, domaine **216**, contrats **165**, PWA **58**) avant toute modification ; en cas d'échec, le signaler au porteur.

**Étape 1 — choisir la suite avec le porteur** (choix multiple, recommandation en premier) :
1. **P5 Distribution et points de vente** (recommandé : P4 en dépend pour la caisse) — sessions de caisse (ouverture, clôture, écart, validation), quotas d'appareil (`DEVICE_QUOTA`) et blocage de la vente hors ligne au-delà de l'allocation (AV-025), caisse du PDV dans le jeu `cash`, remises de fonds ;
2. **Reprise de P6 pour AV-096** (réception hors site après validation), courte ;
3. **P8 Finance opérationnelle** — dépenses, factures et paiements fournisseurs, rapprochement, dettes ;
4. **Écrans PWA** des phases terminées (ventes ECR-VEN-01 à 06 en premier) et application des jeux hors ligne sur l'appareil.

Pour la phase retenue : lire sa fiche et son backlog dans le plan (§4), les lignes de la matrice, les domaines, tables, machines à états et tests d'acceptation cités (CLAUDE.md §4), puis avancer par petits incréments commités avec leurs tests et documents.

## 6. Points ouverts (défauts paramétrables)

Ventes et trésorerie : AV-033, AV-060, AV-083, AV-085, AV-087, AV-131 à AV-152 (liste et défauts dans `13-demonstration-p4.md` §1) ; production : AV-116 à 119, AV-121 ; approvisionnement : AV-095, AV-096 ; liste complète : [`docs/A-VALIDER.md`](docs/A-VALIDER.md).

**Première réponse attendue de ta part** : un court résumé en français de ce que tu as compris de l'état du projet, les vérifications de l'étape 0, puis la question de l'étape 1 au porteur.
