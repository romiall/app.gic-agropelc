# Suivi de la phase P9 — Analytics et direction (serveur, menée en parallèle)

> Ouvert le 14/10/2026. Décision du porteur (14/10/2026) : la session parallèle qui a mené P8 corrige d'abord le constat A7 de la revue de P8, puis entame le **serveur** de P9 ; les écrans de P8 viendront après. La session principale poursuit en même temps le lot de mise en pilote (MP-08 à MP-11) dans `apps/pwa`, `identity`, `attachments` et l'accueil. Elle intègre ce travail : fusion de `claude/p9-analytics`, renumérotation des AV et des ADR, mise à jour de `CLAUDE.md` et de `PROMPT-DE-REPRISE.md`. Cadrage : [`PROMPT-LANCEMENT-P9.md`](../../PROMPT-LANCEMENT-P9.md). Fiche : [plan §4, P9](01-plan-developpement.md).

## 0. Correctif A7 — verrou de la masse mensuelle des frais généraux

**Constat** (revue de P8, [`17-suivi-p8.md`](17-suivi-p8.md) §6, A7). L'annulation d'une dépense de frais généraux et `production.overhead.allocate` ne partageaient aucun verrou. Le même trou existait entre `inventory.overhead.cancel` (P7) et la répartition, et touchait aussi la clôture d'un lot (part estimée, AV-105). La répartition lisait la masse du mois, les annulations lisaient « mois déjà réparti ? » : toutes par des lectures simples, sous l'instantané de leur transaction. Deux transactions concurrentes passaient donc chacune. Conséquence : les lots portaient la part d'un frais annulé et la masse du site devenait négative.

**Correction** (DÉDUIT ; [ADR-038](../decisions/ADR-038-ordre-de-verrouillage-global.md), rang N2b et révision de P9) :

| Élément | Changement |
|---|---|
| Verrou | table `inventory_overhead_pool_locks` (site, espèce, mois métier), propriété d'`inventory`, migration `20261201090000` ; upsert sans effet, tenu jusqu'à la fin de la transaction |
| Écrivains sous le verrou | `production.overhead.allocate`, `production.lot.close` (une masse par mois de la vie du lot, ordre croissant), `inventory.overhead.record` et `.cancel`, `finance.expense.cancel`, et toute écriture `SITE` `FRAIS_GENERAUX` par `recordCostEntry` (saisie et approbation d'une dépense) |
| Lectures | la masse (`costObjectBalance`, option `current`) et la garde « mois déjà réparti » (`siteOverheadMonthAllocated`, `monthAllocated`) passent en lecture verrouillante `FOR SHARE` : elles rendent les écritures validées, non l'instantané |
| Ordre | espèce puis mois croissants ; les lignes d'une saisie sont écrites par espèce croissante ; aucun cycle (ADR-038, révision) |

**Tests** (aucun test de concurrence ne tournait pour cette paire) :
- `production-overhead-allocation.test.ts`, trois cas :
  - annulation arrivée pendant la répartition : refusée, masse du site nulle ;
  - annulation validée avant la répartition qui attendait : masse relue à jour, rien n'est réparti d'un frais annulé ;
  - chaque commande attend le verrou, mois de Douala à la frontière UTC.
- `finance-expense-commands.test.ts` : saisie et annulation d'une dépense attendent le verrou ; répartition validée pendant l'attente, garde relue à jour.

**Mutations** (base jetable `gic_agropelc_p9m`) : sept sur huit détectées.
- Détectées :
  - répartition sans verrou ;
  - masse lue sur l'instantané ;
  - annulation de saisie sans verrou, ou sans garde à jour ;
  - écriture de la masse sans verrou ;
  - annulation de dépense sans verrou ;
  - mois calculé en UTC.
- Une équivalente : la garde de l'annulation d'une dépense lue sans `FOR SHARE`. Le droit de l'acteur est déjà en cache (chargé par le contrôle de permission du pipeline, hors transaction) et le gestionnaire ne lit rien avant le verrou : l'instantané de la transaction naît à la garde, après lui. La lecture courante est conservée : elle ne doit pas dépendre de cette absence de lecture simple.
- Constat de méthode : une assertion « la commande attend encore » fondée sur un délai (700 ms) ne distingue pas une commande bloquée d'une commande lente quand la machine est chargée. Une mutation a donc survécu une fois, détectée en la rejouant seule ; l'assertion ne produit jamais de faux échec.

## 1. Espace réservé

| Élément | Valeur |
|---|---|
| Branche | `claude/p9-analytics`, partie de la tête intégrée de `claude/brave-pasteur-c7q4y7` (`befdb76`, qui contient la fusion de P8 `21a0a82`) |
| Worktree | `.claude/worktrees/p9-analytics` |
| Bases | `gic_agropelc_p9` (développement et tests), `gic_agropelc_p9m` (base jetable : mutations, scénarios destructifs) |
| Migrations | versions `20261201xxxxxx` |
| AV | numéros 400 à 449 (provisoires) ; utilisés : aucun à ce jour |
| ADR | numéros 070 à 079 (provisoires) ; utilisés : aucun à ce jour |
| Démonstration de sortie | `20-demonstration-p9.md` (à la clôture) |
| Matrice | §17.11 « Phase P9 » |

## 2. Avancement

| Incr. | Objet | Commit | État |
|---|---|---|---|
| A7 | Verrou de la masse mensuelle des frais généraux, lectures courantes, tests de concurrence | ce commit | Fait : 4 tests de concurrence, 7 mutations détectées sur 8 (1 équivalente) ; paquet `db` 201 tests verts |
| P9-01 | Conception : cartographie, ADR 070 à 079, AV 400 à 449, backlog du plan §4 | — | À faire |
| P9-02 et suivants | Voir le backlog du plan | — | À faire |

## 3. Code existant touché (hors des fichiers nouveaux de P9)

Ces modifications sont signalées à la session principale à chaque fin de lot.

| Incr. | Module ou fichier | Changement | Raison |
|---|---|---|---|
| A7 | `inventory` : `public/cost-entries.ts`, `public/index.ts` | `lockOverheadPool`, `lockOverheadPools`, `overheadPeriodOf` ; option `current` de `costObjectBalance` ; `siteOverheadMonthAllocated` en lecture verrouillante ; `recordCostEntry` prend le verrou d'une écriture `SITE` `FRAIS_GENERAUX` | A7, ADR-038 rang N2b |
| A7 | `inventory` : `commands/overhead-commands.ts` | l'annulation d'une saisie verrouille la masse de chaque espèce avant la garde (lue en `FOR SHARE`) ; les lignes d'une saisie sont écrites par espèce croissante | A7 |
| A7 | `production` : `overhead-allocation.ts` | la répartition (et la part estimée à la clôture d'un lot) verrouille la masse avant de la lire, en lecture courante | A7 |
| A7 | `finance` : `commands/expense-commands.ts` | l'annulation d'une dépense de frais généraux verrouille la masse avant la garde | A7 |
| A7 | `db` : migration `20261201090000`, `schema.sql`, `schema.generated.ts` | table `inventory_overhead_pool_locks` (sans clé étrangère vers le site) | A7 |
| A7 | tests de P7-10 et P8-05 | trois cas de concurrence ajoutés à `production-overhead-allocation.test.ts`, un à `finance-expense-commands.test.ts` | A7 |
| A7 | documentation | ADR-038 (rang N2b, révision), dictionnaire `06-inventory.md`, D06 (API publique) | A7 |

## 4. Écarts de documentation relevés (pour la session principale)

- Le prompt de lancement de P9 (§1) réserve `gic_agropelc_mp8i` à la session principale : `gic_agropelc_p9` a été créée neuve, sans la toucher.
- `PROMPT-DE-REPRISE.md` §1 dit de ne pas lancer MySQL soi-même ; la consigne du porteur du 04/10/2026 (lancement détaché du serveur 8.4, port 3307) le permet. Le serveur était arrêté à l'ouverture de cette session (poste redémarré) : il a été relancé par `Start-Process` détaché, comme prévu.
- Les écrans de P8 restent à mener (ECR-FIN-02 à 06, ECR-APP-05) : lot séparé, après P9, sur feu vert de la session principale.

## 5. Bases de données

Aucune donnée de test incohérente connue à l'ouverture : `gic_agropelc_p9` et `gic_agropelc_p9m` ont été créées neuves le 14/10/2026 par la procédure du lancement (création, `dbmate up`, `seeds/run.ts`). Les mutations tournent sur `gic_agropelc_p9m` seulement.
