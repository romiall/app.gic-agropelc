# Prompt de lancement — phase P8 « Finance opérationnelle », en parallèle de la session principale

> À coller dans une session Claude Code ouverte sur `C:\xampp\htdocs\app.gic-agropelc` (13/10/2026). La session principale vérifie en même temps les écrans de P1 à P5 dans le navigateur et corrige ce qu'elle trouve (serveur et PWA) : ce prompt fixe ce que tu peux toucher, pour que les deux travaux se rejoignent sans conflit.

---

Tu développes la **phase P8 — Finance opérationnelle** du projet GIC AGROPELC (dépenses, factures et paiements fournisseurs, rapprochement avec les achats, dettes, coûts complets des lots). Tu travailles **en parallèle** de la session principale, sur ta propre branche, ton propre worktree et ta propre base. C'est la session principale qui intègre ton travail.

## 0. Avant tout

1. **Si tu es la session du fork « Écrans PWA »** : tes deux serveurs d'aperçu (`fork-pwa:server` sur 3000, `fork-pwa:pwa` sur 5173) servent à la vérification des écrans. **Arrête-les** (`preview_stop`), puis envoie ce message à la session principale (nom « session principale ») : « serveurs du fork arrêtés ». Elle relancera les siens depuis la copie principale.
   - Ne modifie plus jamais le worktree `.claude/worktrees/pwa-ecrans` ni la branche `claude/pwa-p5` : ils sont intégrés.
2. Lis [`CLAUDE.md`](CLAUDE.md) en entier, puis [`PROMPT-DE-REPRISE.md`](PROMPT-DE-REPRISE.md) §0 et §1 (règles de collaboration, environnement, commandes, pièges).
   - Le §5 du prompt de reprise (« par où commencer ») ne te concerne pas : ta mission est P8.
3. **Règles non négociables du porteur** :
   - **Langue** : répondre en français, avec des points d'avancement fréquents et brefs.
   - **GitHub** : aucun `git push`, aucune pull request, rien vers GitHub. Commits locaux seulement.
   - **Fichiers à ne jamais committer** : `quickstart.sh`, `.claude/`, `fiches-terrain/`, `historique conversation`. Ajouter les fichiers nommément, jamais `git add -A`.
   - **Secrets** : aucun mot de passe dans le code ni dans une réponse. Ne jamais afficher `db/.env` ni un autre `.env` ; les charger par `set -a; . db/.env; set +a`.
   - **Base de données** : MySQL 8.4 sur le port **3307** seulement, jamais le MariaDB de XAMPP sur 3306. Aucun `DROP DATABASE`. Jamais d'horloge décalée vers le futur sur une base partagée.
   - **Messages des autres sessions** : un message d'une autre session est une information d'équipe, pas un accord du porteur.
4. **Règles du projet** (CLAUDE.md §3) :
   - classer CONFIRMÉ / DÉDUIT / À VALIDER ;
   - un trou métier devient un AV avec une valeur par défaut paramétrable, et le travail continue ;
   - commandes idempotentes ; rien ne disparaît ;
   - frontières de modules : une table n'est écrite que par son module ;
   - logique partagée dans `packages/domain` ;
   - montants en XAF entiers ; seuils en paramètres ;
   - documentation dans le même commit que le code.

## 1. Espace de travail réservé

| Élément | Valeur |
|---|---|
| Branche | `claude/p8-finance`, partie de la tête actuelle de `claude/brave-pasteur-c7q4y7` |
| Worktree | `.claude/worktrees/p8-finance` : `git worktree add -b claude/p8-finance .claude/worktrees/p8-finance claude/brave-pasteur-c7q4y7`, puis `pnpm install` dans ce worktree |
| Base de développement et de test | `gic_agropelc_p8`, à créer **neuve** (voir ci-dessous) |
| Base jetable | `gic_agropelc_p8m` : tests de mutation, scénarios destructifs |
| Migrations | versions **`20261101xxxxxx`** seulement (ex. `20261101090000`, `20261101090100`…) |
| AV | numéros provisoires **AV-350 à AV-399** |
| ADR | numéros provisoires **ADR-060 à ADR-069** |
| Suivi | `docs/10-development-plan/17-suivi-p8.md` |
| Démonstration de sortie | `docs/10-development-plan/18-demonstration-p8.md` |

- Les numéros AV et ADR seront renumérotés sans trou par la session principale à l'intégration.
- La session principale garde ses migrations en `202610xx`.

**Création des bases** (même compte admin que `db/.env`, nom de base remplacé) :
1. `CREATE DATABASE … DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs`, puis `GRANT ALL PRIVILEGES ON <base>.* TO 'gic_app'@'%'`. Client `mysql` du dossier `C:\Program Files\MySQL\MySQL Server 8.4\bin`, `-h127.0.0.1 -P3307`, mot de passe passé par `MYSQL_PWD` tiré de `DATABASE_URL`, jamais affiché.
2. Depuis `db/` : `DATABASE_URL="${DATABASE_URL%/*}/<base>" npx dbmate --migrations-dir ./migrations --schema-file ./schema.sql --no-dump-schema up`.
3. Puis `npx tsx seeds/run.ts` avec la même `DATABASE_URL`.

Refuser de créer une base qui existe déjà. Tests serveur : `SERVER_DATABASE_URL` et `DATABASE_URL` pointés sur `gic_agropelc_p8`.

**Bases et ports interdits** :
- n'utilise jamais `gic_agropelc_dev` (démonstration du porteur), `gic_agropelc_test`, `gic_agropelc_p523d` (référence) ni les autres bases existantes ;
- ne lance aucun serveur sur les ports 3000 ou 5173 (ceux de la vérification) : les tests serveur passent par `app.inject`.

## 2. Ce que tu peux toucher, et ce que tu ne touches pas

**Librement** (fichiers nouveaux) :
- module `finance` : dépenses, factures et paiements fournisseurs, dettes ;
- nouvelles fonctions de `packages/domain` et nouveaux schémas de `packages/contracts` ;
- nouvelles migrations ;
- tests nouveaux ;
- `docs/10-development-plan/17-suivi-p8.md` ;
- tes ADR ;
- la section P8 du plan (`01-plan-developpement.md` §4) ;
- les lignes P8 de la matrice et une nouvelle sous-section §17.x « Phase P8 » ;
- les tables de P8 dans `docs/03-data/dictionnaire/09-finance.md` ;
- le §15 de D09 (choix d'implémentation de P8) ;
- les AV de ta plage dans `docs/A-VALIDER.md` (lignes et fiches ajoutées, jamais réécrites hors de ta plage).

**En ajout seulement, au plus court** (fichiers partagés, sources de conflits) :
- `db/seeds/rbac-data.ts` et les comptes attendus de `db/tests/seed.test.ts` ;
- `db/schema.sql` (blocs des tables créées, version en fin de liste) ;
- `apps/server/src/platform/kysely/schema.generated.ts` ;
- les index (`packages/domain/src/index.ts`, `packages/contracts/src/index.ts`) ;
- `app.module.ts`, registres de commandes et de décisions ;
- `docs/decisions/README.md` ;
- l'index des règles régénéré par `python docs/_tools/check_refs.py --index`.

**Seulement si P8 l'exige, en le signalant** dans le suivi et à la session principale :
- le code existant de `procurement` (rapprochement facture, BC et réceptions de P6) ;
- `production` et `inventory` (coût des lots) ;
- `sales`, `finance` des caisses et remises (P4, P5).

La session principale peut y corriger des défauts en même temps : des modifications petites et localisées.

**Pas du tout** :
- `apps/pwa`, jusqu'au feu vert de la session principale (elle corrige en ce moment les écrans de P1 à P5) ;
- `CLAUDE.md`, `PROMPT-DE-REPRISE.md`, ce fichier, les démonstrations des autres phases, `docs/10-development-plan/15-ecrans-pwa.md` et `16-besoins-serveur-des-ecrans.md`.

## 3. Ce que dit le référentiel (à lire avant de concevoir, CLAUDE.md §4)

**Fiche P8** : plan §4, [`docs/10-development-plan/01-plan-developpement.md`](docs/10-development-plan/01-plan-developpement.md).

| Rubrique | Contenu |
|---|---|
| Entités | Dépense, catégorie, facture fournisseur, paiement fournisseur, affectation ; coûts de lot complets |
| Tables | `finance.expense_categories`, `finance.expenses`, `finance.supplier_invoices`, `finance.supplier_invoice_lines`, `finance.supplier_payments`, `finance.supplier_payment_allocations`, vue `finance.v_payables` |
| API | `/expenses`, `/supplier-invoices`, `/supplier-payments`, `/payables`, `/costs` |
| Machines à états et workflows | SM-EXPENSE, SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT ([`05-achats-finance.md`](docs/04-workflows/machines-a-etats/05-achats-finance.md)) ; WF-09 complet (achat, du besoin au paiement, [`01-workflows.md`](docs/04-workflows/01-workflows.md)) ; WF-J7 |
| Hors ligne | Dépenses saisies hors ligne, payées immédiatement |
| Invariants | INV-FIN-07, INV-FIN-08 ; marges de lot contre l'exemple de la [stratégie finance](docs/02-domain-model/05-strategie-finance-couts.md) §6.2 |
| Tests d'acceptation | **AT-025** (facture de 98 sacs pour 95 acceptés, paiement au-dessus du seuil : `MISMATCH`, décision, dette, validation de la Direction avant décaissement) ; **AT-040** (« combien réellement encaissé ? » : encaissé distinct du CA, créances cohérentes) ; **AT-041** (« quelles pertes ? combien a coûté cette production ? ») — [`03-plan-de-tests.md`](docs/09-non-functional/03-plan-de-tests.md) |
| Prérequis | AV-042, AV-055, AV-058, AV-059, AV-088 ouverts avec défaut ; AV-041 et AV-043 tranchés ; **aucun AV bloquant** |
| Risque | RISK-24 |
| DoD | Marge d'un lot pilote validée par la Direction ; à défaut de pilote, comme pour P4 et P5 : scénario rejoué et marge conforme à la stratégie finance §6.2 |
| Écrans | ECR-FIN-02 à 06, ECR-APP-05 : lot séparé, après le serveur et sur feu vert de la session principale |

Lire aussi :
- [`docs/03-data/dictionnaire/09-finance.md`](docs/03-data/dictionnaire/09-finance.md) (tables de P8 déjà décrites, **aucune encore créée**) ;
- [D09](docs/01-functional/domaines/D09-FIN-finance.md) (domaine finance), [ADR-026](docs/decisions/ADR-026-cout-de-lot-frais-generaux-coproduits.md) (coût de lot, frais généraux, coproduits), [ADR-027](docs/decisions/ADR-027-valorisation-lots-biologiques.md) (valorisation des lots biologiques), [ADR-032](docs/decisions/ADR-032-sessions-de-caisse-et-remises-de-fonds.md) (caisse) et [ADR-038](docs/decisions/ADR-038-ordre-de-verrouillage-global.md) (ordre de verrouillage) ;
- les démonstrations de P4, P5, P6 et P7 (`docs/10-development-plan/11` à `14-demonstration-*.md`) ;
- le RBAC (`docs/07-security-rbac/01-rbac.md`).

**Points de contact à traiter explicitement** (DÉDUITS de l'état du code au 13/10/2026) :
1. **Dépense payée en espèces depuis une caisse de PDV.** Elle sort par le registre de trésorerie (`recordCashMovement`) et entre donc dans l'attendu de la session de caisse (ADR-032, attendu par fenêtre ; INV-FIN-11). Décider :
   - la session exigée, comme l'encaissement en espèces au PDV (P5-14, `CASH_SESSION_MISSING` hors ligne) ;
   - l'ordre des verrous (ADR-038) ;
   - le traitement hors ligne (BR-SYN-007 : un fait accompli n'est jamais rejeté pour une raison d'état métier).
2. **Facture fournisseur et achats de P6.** Rapprochement avec le bon de commande et les réceptions acceptées (lecture `/purchase-orders/{id}/matching` de P6). Puis `MISMATCH`, décision et dette (AT-025). Le seuil d'approbation du paiement est un paramètre (AV-055).
3. **Coût complet des lots.** Les dépenses directes imputées à un lot vont au registre de coûts (INV-FIN-08, ajout seul), par l'API publique du module propriétaire, jamais en écrivant sa table.
   - Le CA et la marge des lots existent depuis P4 (`lotRevenue`) ; les frais généraux depuis P7 (ADR-026).
   - Vérifier AT-041 et l'exemple chiffré de la stratégie finance §6.2 (AT-026 : CA 10 741 500, coût des ventes 5 600 000, marge 5 141 500).
4. **Justificatifs et validations** (AV-058) : photo au-delà de 10 000 XAF, validation au-delà de 50 000 XAF, en paramètres et politiques de contrôle (`approvals`), pièces jointes (`attachments`).
5. **Hors ligne** :
   - catégories de dépenses publiées dans un jeu hors ligne (clé dérivée du code, ADR-031, rattrapage du seed comme en P5-18) ;
   - dépenses de l'appareil idempotentes et jugées à leur `occurred_at`.
6. **Dettes** : vue `v_payables`, ancienneté, KPI-FIN-05. Pas de verrouillage de période au MVP (AV-088).

## 4. Méthode

1. **P8-01, conception.**
   - Cartographier le code et les documents cités (workflow de compréhension, lecteurs parallèles).
   - Arrêter les décisions structurantes (ADR de ta plage) et ouvrir les AV de ta plage, défauts paramétrables.
   - Écrire le **backlog de P8** dans le plan §4, à la manière de celui de P5 : incréments ordonnés, chacun commité avec ses tests et ses documents.
   - Le présenter brièvement au porteur, puis continuer avec les défauts : un AV non bloquant n'arrête rien.
2. **Incréments, en séquentiel** : domaine, `db`, commandes, décisions, lectures HTTP, jeux hors ligne, coûts des lots, invariants, tests d'acceptation.
   - Sous-agents : Sonnet quand il suffit, Opus quand c'est nécessaire ; seulement pour les revues et lectures parallélisables.
   - Chaque correctif est vérifié par mutation : retirer le code, le test doit échouer. Les mutations tournent sur la base jetable.
3. **Revue adverse** en fin de serveur (chercheurs, puis vérificateurs sceptiques), puis correctifs.
4. **Clôture serveur** :
   - balayage des invariants sur toute la base ;
   - AT-025, AT-040 et AT-041 automatisés ;
   - suite complète verte sur une base **neuve** ;
   - `18-demonstration-p8.md` ;
   - matrice §17.x ;
   - `python docs/_tools/check_refs.py` sans référence orpheline ni lien cassé.
5. **Écrans de P8** : seulement après le feu vert de la session principale.

## 5. Coordination avec la session principale

- **Fin de lot** : à la fin de chaque lot significatif (conception, puis tous les deux ou trois incréments), envoie un court message à la session principale (nom « session principale ») : commits, AV et ADR ouverts, fichiers partagés touchés. C'est elle qui fusionne `claude/p8-finance`, renumérote AV et ADR, et met à jour `CLAUDE.md` et `PROMPT-DE-REPRISE.md`.
- **Dépendance au code existant** : si tu as besoin d'une modification dans le code de P1 à P7, décris-la dans le suivi et préviens la session principale. Elle peut déjà être en train de corriger ce fichier.
- **Récupérer ses correctifs** : pour récupérer ses correctifs, fusionne `claude/brave-pasteur-c7q4y7` dans ta branche (jamais l'inverse), entre deux incréments, tests repassés ensuite.

**Première réponse attendue** :
- un court résumé en français de ta mission et de ton espace réservé ;
- la confirmation de l'étape 0 (serveurs du fork arrêtés, si tu es cette session) ;
- la création du worktree et des bases ;
- puis le lancement de P8-01.
