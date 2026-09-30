# Démonstration de sortie de phase P7

> Plan §4 (P7 — Production). Critère : « Fermes équipées ; indicateurs de lot ». État arrêté le 30/09/2026, à la fin des éléments de code de P7 (P7-01 à P7-13). Développement local (MySQL 8.4 sur le poste, ADR-024 §5) ; commits locaux, rien n'est poussé vers le dépôt distant à cette date.
>
> P7 a suivi P6 (elle en dépend : mise en place par achat direct, intrants reçus). P4 est débloquée depuis le 27/09/2026 (AV-024 et AV-025 tranchés) ; P5 et P8 en dépendent.

---

## 1. Aucun AV bloquant

Les AV prérequis de P7 ont été tranchés par le porteur du projet : AV-004, AV-005, AV-032, AV-043 à AV-050 le 27/09/2026 ; AV-097 à AV-115, AV-120, AV-122 à AV-125 le 28/09/2026 (journal [`A-VALIDER.md`](../A-VALIDER.md) §3 ; [ADR-026](../decisions/ADR-026-cout-de-lot-frais-generaux-coproduits.md) amendé, [ADR-027](../decisions/ADR-027-valorisation-lots-biologiques.md)). Restent `OUVERT` des points **secondaires**, dont la valeur par défaut est implémentée de façon paramétrable ou réversible, sans être présentée comme une décision :

| AV | Défaut implémenté | Où |
|---|---|---|
| AV-116 | Indicateurs : mortalité comptée ÷ effectif initial (qui cumule toutes les entrées) ; GMQ et indice de consommation entre la première et la dernière pesée ; taux de ponte ÷ effectif en élevage au début du jour. Poids standard par produit non paramétré (sans deux pesées, ni GMQ ni IC) | `production-query.ts` ; `packages/domain` |
| AV-117 | Journée sans événement : observation `AUTRE` « RAS » ; l'alerte `DAILY_ENTRY_MISSING` arrive en P9 | `daily-commands.ts` |
| AV-118 | Reclassement d'œufs non construit : correction par annulation de la collecte et nouvelle saisie | — |
| AV-119 | Toute mortalité, quel que soit le point d'entrée, suit la politique `MORTALITY` | `inventory` (`declareLoss`) |
| AV-121 | Seuils propres de l'alerte `HIGH_MORTALITY` paramétrés (`production.high_mortality_alert_pct` 0,5 %, `production.high_mortality_alert_heads` 20) ; alerte en P9 | seed `system-settings.ts` |

Les choix d'implémentation laissés libres par les règles sont **DÉDUITS** et documentés dans [D07 §15](../01-functional/domaines/D07-PRD-production.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-026 à 029, 052, 053)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-026 | Cycle d'un lot de 2 400 poulets conforme à la stratégie finance §6.2 | `production-acceptance.test.ts` : mise en place 2 400 × 450, aliment 280 sacs × 15 000, vétérinaire 180 000, litière 140 000 (la « dépense directe » de l'exemple), 90 morts (3,75 %), coût 5 600 000, coût par tête 2 424 ; sortie des 2 310 têtes par abattage au coût restant exact ; clôture sans coût non emporté | Vert (part P7) ; CA et marge avec les ventes (P4) |
| AT-027 | 30 morts sur un lot de 2 000 : validation requise | `production-acceptance.test.ts` (paramètres AV-048, photo, demande `MORTALITY`, têtes en attente, clôture refusée) ; `production-daily-commands.test.ts` | Vert (part P7) ; alerte `HIGH_MORTALITY` en P9 |
| AT-028 | Collecte 1 850 = 25 + 15 + 1 690 + 120 | `production-egg-collection-commands.test.ts` (seuls 1 690 et 120 entrent en stock, déséquilibre refusé) | Vert |
| AT-029 | Incubation de 600 œufs : bilan juste, éclosion 83 % | `production-incubation-commands.test.ts` (42 infertiles, 18 morts en coquille, 540 transférés, 498 viables, 7 non viables, 35 non éclos) | Vert |
| AT-052 | 40 porcs sur 2 cases, 5 têtes déplacées, pesée | `production-acceptance.test.ts` (effectif par case = solde de l'emplacement, groupe inchangé, aucun identifiant individuel) | Vert (part P7) ; vente de 3 têtes avec P4 |
| AT-053 | Ajout d'un calibre d'œufs par l'administrateur | `production-acceptance.test.ts` (produit et paramètre ajoutés en ligne, calibre refusé avant et accepté après, même modèle de mouvement, collecte antérieure inchangée) | Vert |

Scénario de bout en bout du plan : `production-farm-week.e2e.test.ts` — « saisie du jour d'une semaine hors ligne ». L'appareil du responsable de ferme télécharge les jeux `production` et `stock`, saisit hors ligne sept jours de mortalités, d'aliment, de collectes, de pesées et d'observations, envoie sa file en un lot par `/sync/push`, la renvoie sans doublon ; le Responsable production valide les mortalités en ligne ; l'appareil retélécharge les statuts ; la vue jour par jour et les indicateurs du lot reflètent la semaine.

### 2.2 Invariants

| INV | Où | État |
|---|---|---|
| INV-PRD-01 | `production-invariants.test.ts` (aucune colonne d'effectif ; effectif initial = Σ des entrées comptées) ; `production-lot-commands.test.ts` | Vert |
| INV-PRD-02 | `production-invariants.test.ts` (lot clos vide, lot de traçabilité clos, aucun mouvement postérieur sans conflit `LOT_CLOSED`) ; tests de commande (clôture refusée, conflits hors ligne) | Vert |
| INV-PRD-03 | `production-invariants.test.ts` (aucune autre table de mortalité, mortalité rattachée à un lot) | Vert |
| INV-OEU-01 | `db/tests` (`CHECK`) ; `packages/domain` ; `production-invariants.test.ts` (bilan, calibres, entrées en stock, crédit du lot producteur) | Vert |
| INV-INC-01 | `db/tests` (`CHECK`) ; `packages/domain` ; `production-invariants.test.ts` | Vert |
| Conservation des coûts (ADR-026, ADR-027) | `production-invariants.test.ts` (entrées, éclosion, abattage, frais généraux au franc près) ; `inventory-biological-valuation.test.ts` (Σ des coûts figés des sorties = coût du lot) | Vert |

### 2.3 Suites complètes (30/09/2026)

`packages/domain` 179 tests (16 fichiers) ; `packages/contracts` 156 tests (4 fichiers) ; `apps/server` 440 tests (71 fichiers, exécution séquentielle, 2 min 07 s) ; `db` 74 tests (9 fichiers). `typecheck`, `check:boundaries` (291 modules), `lint` (aucune erreur ; l'avertissement préexistant de la PWA), `format:check`, `python3 docs/_tools/check_refs.py` verts.

## 3. Ce qui est livré

| Élément | Contenu |
|---|---|
| P7-01 `packages/domain` | Bilans d'œufs (calibres) et d'incubation, validation de la mortalité (seuils relatif et absolu), coût par tête, répartitions au franc (têtes × jours, poids), indicateurs, profils des cinq types de lots |
| P7-02 `inventory` | Types de coût et sources (frais généraux, production transférée), API publique (lots de stock, écritures de coût, pertes avec politique `MORTALITY`, consommations, effectif d'un lot, têtes × jours), décision `MORTALITY`, frais généraux de ferme par espèce (`inventory.overhead.record`, `.cancel`), inventaires d'animaux validés (AV-108) |
| P7-03 `inventory` | Valorisation des lots biologiques au coût restant (ADR-027), coût déclaré des entrées de production, contrôle du lot clôturé |
| P7-04 `db` | Tables `production.*`, paramètres, motifs de rendement, politique `MORTALITY` par défaut, RBAC |
| P7-05 lots | `production.lot.create`, `.cancel`, `.set_status`, `.record_entry` (mise en place interne ou par achat direct, naissance, transfert, sevrage), `.cancel_entry`, `.close` (synthèse figée) |
| P7-06 saisie du jour | `production.mortality.record`, `.input.record`, `.weighing.record`, `.weighing.cancel`, `.observation.record` |
| P7-07 collectes | `production.egg_collection.record`, `.cancel` : calibres, plusieurs par jour, lot de stock propre avec péremption, coût standard et crédit du lot producteur |
| P7-08 incubation | `production.incubation.start`, `.record_candling`, `.cancel_candling`, `.transfer_to_hatcher`, `.record_hatch`, `.cancel` ; coût porté par les poussins viables ; quarantaines hors ligne |
| P7-09 abattage | `production.slaughter.record`, `.cancel` : multi-produits, têtes saisies, rendement, valeur répartie au poids, lot de stock propre |
| P7-10 frais généraux | `production.overhead.allocate` : répartition à la demande (têtes × jours), régularisation, part estimée à la clôture |
| P7-11 lectures | `GET /production/lots[/{id}[/daily]]`, `/egg-collections[/{id}]`, `/incubations[/{id}]`, `/slaughters[/{id}]`, `/overhead-allocations` — portée par ferme, refus audités, valeurs masquées sans `inventory.valuation.read`, indicateurs, résultat mensuel |
| P7-12 hors ligne | Jeu `production` : lots ouverts, incubations en cours, saisies des 30 derniers jours (dont pertes et consommations émises par `inventory`) ; portée d'appareil par les fermes qu'atteint `production.lot.read` |
| P7-13 intégrité | Balayage des invariants ; semaine hors ligne ; tests d'acceptation |
| Revues adverses | Deux revues (P7-05 à P7-07, P7-08 et P7-09) : valeur exacte des inverses, dernier mouvement d'un lot biologique à la valeur exacte de son solde, conflits `LOT_CLOSED` sur les lots d'origine, saisies sanitaires, quarantaines d'incubation, numérotation par jour métier |

Décisions DÉDUITES à connaître (détail : D07 §15) :

- **Effectif** jamais copié : lu dans le registre, y compris sur l'appareil (jeu `stock`) ; l'effectif initial cumule les entrées comptées.
- **Hors ligne** : un fait saisi sur un lot clos est appliqué avec un conflit `LOT_CLOSED` ; les étapes d'incubation incohérentes partent en quarantaine.
- **Lectures** : un seul droit, `production.lot.read` ; toute valeur en XAF masquée sans `inventory.valuation.read`.
- **Jeu hors ligne** : aucune valeur ; le magasinier d'une ferme ne reçoit pas le jeu `production`.

## 4. Ce qui n'est pas livré (signalé, pas silencieux)

| Élément | Raison | Déclencheur |
|---|---|---|
| Écrans PWA ECR-PRD-01 à 04, 06, 07 et tableau ECR-ANA-04 simple | Même précédent que P0-11 à P6 : aucun écran métier construit, les API sont prêtes | Session dédiée aux écrans |
| CA attribué au lot, marge du lot, vente directe depuis l'élevage (BR-PRD-010, BR-PRD-014), vente au kilo vif (BR-POR-004) | Module `sales` ; le résultat mensuel expose `revenueXaf` à `null` | P4 |
| Dépenses directes imputées à un lot (frais d'abattage, électricité), coûts de lot complets | Module `finance` ; en attendant, un intrant consommé (litière) les représente | P8 |
| Alertes `HIGH_MORTALITY`, `DAILY_ENTRY_MISSING`, `STANDARD_COST_MISSING`, retards d'incubation | Module `communication` ; paramètres déjà posés | P9 |
| Reclassement d'œufs (AV-118), poids standard par produit (AV-116) | AV ouverts | Décision des AV |
| Limites connues de la revue P7 (consommation sur lot d'incubation clos, perte d'œufs reçue après l'éclosion, ligne de réception sans lot fournisseur prise par le FIFO) | Soldes négatifs possibles, signalés par `STOCK_NEGATIVE` | P9 (alerte) ; lot obligatoire sur les produits biologiques |
| DoD « un lot pilote suivi de la mise en place à la clôture » | Exige les écrans, les ventes (P4) et un déploiement | R3 |

## 5. Prochaine étape

**P4** (Commandes, ventes, encaissements) est débloquée (AV-024 et AV-025 tranchés le 27/09/2026) : elle apportera le CA et la marge des lots. Puis la reprise de P6 pour AV-096 (réception hors du site de livraison après validation du Responsable achats), **P5** (dépend de P4) et **P8** (finance opérationnelle, dépend de P4).
