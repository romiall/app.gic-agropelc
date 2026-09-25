# D07 — Production (PRD) : tronc commun, volaille (VOL), œufs (OEU), incubation (INC), porcs (POR)

> Module de code : `production`. Les effets physiques passent par l'API d'`inventory` (D06) ; les coûts par le registre de coûts, module `inventory` (sous-domaine valorisation ; règles en D09 §7.5).
> Principe (CM §14, PM §10) : **un modèle de lot commun, des règles propres à chaque filière**, sans confondre les réalités.

---

## 1. Objectif

Suivre les productions par lot pour savoir :

- combien d'animaux existent et combien sont morts ;
- combien d'œufs ont été produits, combien sont commercialisables et combien partent en incubation ;
- ce que l'incubation a donné ;
- combien d'animaux sont prêts à la vente ;
- ce qu'a coûté un lot et quelle marge il produit (CM §2/Production, §33, §58).

Sources : CM §14–§19, §33, §34.5, §49 ; PM §10.

## 2. Acteurs

`RESP_PRODUCTION` (tous sites de production), `RESP_FERME` (son site), `OPERATEUR_FERME` (proposé, AV-004), `MAGASINIER` (stock d'intrants de la ferme), `FINANCE` (coûts), `DIRECTION`, `system`.

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Lot de production | `production.production_lots` | Chair, pondeuse, porc : effectif initial, dates, bâtiment principal, fournisseur, souche, statut |
| Entrée de lot | `production.lot_entries` | Mise en place, naissance, transfert entrant |
| Pesée | `production.lot_weighings` | Poids moyen d'un échantillon |
| Collecte d'œufs | `production.egg_collections` | Relevé quotidien d'un lot de pondeuses |
| Lot d'incubation | `production.incubation_batches` | Œufs mis en incubation et résultat |
| Étape d'incubation | `production.incubation_events` | Mise en incubateur, mirage, transfert, éclosion |
| Observation de lot | `production.lot_observations` | Note datée (état sanitaire, incident) |
| Mortalité | `inventory.loss_declarations` (catégorie `MORTALITE`) | Propriété de D06 (tension C-09) |
| Consommation d'intrants | `inventory.consumptions` (objet de coût = lot) | Propriété de D06 |
| Coûts de lot | `inventory.cost_entries` | Propriété du module `inventory` (règles en D09 §7.5) |
| Lot de traçabilité | `inventory.stock_lots` (origine `PRODUCTION_LOT` ou `INCUBATION_BATCH`) | Lien avec le registre |

Produits minimaux (référentiel, D) : `Poussin d'un jour (chair)`, `Poulet de chair vif`, `Poulette / pondeuse`, `Œuf de consommation`, `Œuf à couver`, `Porcelet`, `Porc vif`, aliments et intrants.

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-PRD-01 | Créer un lot (planifié) | `production.lot.create` | RESP_PRODUCTION | **Oui** |
| UC-PRD-02 | Mise en place, ou entrée d'animaux dans un lot | `production.lot.record_entry` | RESP_PRODUCTION, RESP_FERME | **Oui** |
| UC-PRD-03 | SAISIE DU JOUR : mortalité | `production.mortality.record` | RESP_FERME, (OPERATEUR_FERME) | **Oui** |
| UC-PRD-04 | SAISIE DU JOUR : consommation d'aliment ou d'intrant | `production.input.record` | RESP_FERME, (OPERATEUR_FERME) | **Oui** |
| UC-PRD-05 | SAISIE DU JOUR : pesée | `production.weighing.record` | RESP_FERME | **Oui** |
| UC-PRD-06 | SAISIE DU JOUR : observation | `production.observation.record` | RESP_FERME | **Oui** |
| UC-PRD-07 | Collecte d'œufs | `production.egg_collection.record` | RESP_FERME | **Oui** |
| UC-PRD-08 | Démarrer un lot d'incubation | `production.incubation.start` | RESP_FERME | **Oui** |
| UC-PRD-09 | Enregistrer un mirage | `production.incubation.record_candling` | RESP_FERME | **Oui** |
| UC-PRD-10 | Transférer vers l'éclosoir | `production.incubation.transfer_to_hatcher` | RESP_FERME | **Oui** |
| UC-PRD-11 | Enregistrer l'éclosion | `production.incubation.record_hatch` | RESP_FERME | **Oui** |
| UC-PRD-12 | Déplacer des animaux entre bâtiments ou cases | `inventory.transfer.move_internal` | RESP_FERME | **Oui** |
| UC-PRD-13 | Déclarer un lot prêt à la vente ; SORTIE VERS COMMERCIALISATION | `production.lot.set_status` ; `inventory.transfer.dispatch` | RESP_PRODUCTION ; RESP_FERME | **Oui** |
| UC-PRD-14 | Clôturer un lot | `production.lot.close` | RESP_PRODUCTION | Non |
| UC-PRD-15 | Valider une mortalité au-dessus du seuil | `approvals.request.approve` / `reject` | RESP_PRODUCTION | Non |
| UC-PRD-16 | Consulter la fiche d'un lot : effectif, mortalité, consommations, coûts, ventes, marge | requête | RESP_PRODUCTION, DIRECTION, FINANCE | Partiel |

## 5. Entrées

Animaux ou œufs d'origine (achat ou production interne), comptages quotidiens, quantités d'intrants consommées, pesées, collectes, résultats de mirage et d'éclosion, décisions de sortie et de clôture.

## 6. Sorties

Effectifs, stock biologique et disponibilité à la vente, œufs commercialisables et à couver en stock, poussins, coûts de lot et coût par tête, indicateurs (mortalité, taux d'éclosion, œufs commercialisables / collectés), alertes `HIGH_MORTALITY`.

## 7. Règles métier

### 7.1 Tronc commun (PRD)

| ID | Règle | Statut |
|---|---|---|
| BR-PRD-001 | Un lot a un type (`POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`, options activables `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`), un produit biologique, un site, un emplacement principal, une date de démarrage, un effectif initial, un fournisseur et une souche optionnels. | C (CM §15, §19) / AV-044 |
| BR-PRD-002 | La création d'un lot crée son **lot de traçabilité** (`inventory.stock_lots`, origine `PRODUCTION_LOT`). Tous les mouvements des animaux du lot portent ce lot. | D (CM §58) |
| BR-PRD-003 | L'**effectif** d'un lot n'est jamais saisi : c'est la somme des soldes de son lot de traçabilité. On distingue l'**effectif en élevage** (emplacements `BUILDING` et `PEN`) de l'**effectif non vendu** (tous emplacements physiques et transit). | C (CM §15 ; REQ-029) |
| BR-PRD-004 | Une entrée de lot est une mise en place (`PLACEMENT`), une naissance (`BIRTH`) ou un transfert entrant (`TRANSFER_IN`). Mise en place à partir de poussins en stock (éclosion interne ou achat réceptionné) : **reclassement** en une seule opération, `PRODUCTION_INPUT` du produit d'origine puis `PRODUCTION_OUTPUT` du produit du lot vers le bâtiment. Mise en place directe depuis un fournisseur : réception et reclassement dans la même transaction. | C (CM §15) / D |
| BR-PRD-005 | La **mortalité** est une déclaration de perte de catégorie `MORTALITE` rattachée au lot et à l'emplacement (D06, BR-STK-030). Elle est saisie depuis la saisie du jour ; motif (cause) facultatif ; photo et validation selon la politique (seuil relatif à l'effectif). | C (CM §16) / AV-048 |
| BR-PRD-006 | Le seuil relatif de mortalité se calcule sur l'effectif en élevage du lot à `occurred_at`, par l'appareil (approximation locale) puis par le serveur (valeur de référence). Si le serveur exige une validation que l'appareil n'avait pas exigée, la perte passe `PENDING_APPROVAL` et la photo est demandée a posteriori. | D (PM §37) |
| BR-PRD-007 | Une consommation d'intrant pour un lot est une consommation (D06, BR-STK-036) dont l'objet de coût est le lot. Sa valeur (quantité × coût unitaire de l'intrant) est ajoutée au coût du lot. | C (CM §4, §15, §33) |
| BR-PRD-008 | La **saisie du jour** d'un lot est un écran unique qui émet des commandes distinctes (mortalité, consommation, pesée, collecte, observation). Chaque commande est indépendante : un échec de l'une n'annule pas les autres. | C (CM §49) / D |
| BR-PRD-009 | Les statuts d'un lot sont `PLANNED` → `ACTIVE` (première entrée) → `SELLING` (animaux déclarés prêts ou disponibles à la vente) → `CLOSED`. `PLANNED` → `CANCELLED` est possible sans entrée. | D (SM-PRODUCTION-LOT) |
| BR-PRD-010 | Seuls les animaux d'un lot `SELLING` peuvent être vendus directement depuis un emplacement d'élevage. Les transferts vers un emplacement commercial sont possibles à partir de `ACTIVE` (sortie vers commercialisation). | C (CM §15, §2 « prêts à la vente ») / D |
| BR-PRD-011 | Un lot ne peut être clôturé qu'avec un effectif non vendu nul. La clôture fige les indicateurs finaux (mortalité cumulée, coût total, CA attribué, marge). | D |
| BR-PRD-012 | Le **coût du lot** = Σ `inventory.cost_entries` de l'objet lot : animaux d'origine, intrants consommés, dépenses directement imputées. Coût par tête à un instant = coût cumulé ÷ effectif non vendu. Ce coût par tête valorise les sorties du lot (transferts, ventes, pertes). | C (CM §15, §33) / AV-042, AV-043 |
| BR-PRD-013 | La mortalité ne réduit pas le coût du lot : elle le répartit sur un effectif plus faible (hausse du coût par tête). Sa « valeur économique » (quantité × coût par tête au moment de la perte) est un indicateur de perte, pas une charge supplémentaire. | C (CM §16) |
| BR-PRD-014 | Marge d'un lot = CA des ventes portant le lot − coût du lot imputable aux têtes vendues. Pour un lot clôturé : CA total − coût total. | C (CM §33) / D |
| BR-PRD-015 | Une pesée enregistre la taille d'échantillon, le poids moyen (g) et, optionnellement, le poids total ; elle n'a aucun effet de stock. | C (CM §15, §19) |

### 7.2 Volaille de chair (VOL)

| ID | Règle | Statut |
|---|---|---|
| BR-VOL-001 | Un lot `POULET_CHAIR` a pour produit « Poulet de chair vif », compté à la tête. Sa mise en place provient de « Poussin d'un jour (chair) » (BR-PRD-004). | C (CM §15) / D |
| BR-VOL-002 | La sortie vers commercialisation est un transfert du bâtiment vers un magasin, un PDV ou un stock mobile, qui porte le lot et le coût par tête du moment. | C (CM §15) |
| BR-VOL-003 | Au MVP, le poulet est vendu **vif** ; l'abattage et la transformation ne sont pas modélisés. | AV-032 |

### 7.3 Pondeuses et œufs (OEU)

| ID | Règle | Statut |
|---|---|---|
| BR-OEU-001 | Une collecte d'œufs d'un lot `PONDEUSE` pour une date donne : collectés, cassés, non conformes, commercialisables, à couver. Invariant : collectés = cassés + non conformes + commercialisables + à couver (INV-OEU-01). | C (CM §17) |
| BR-OEU-002 | Effets stock d'une collecte : `PRODUCTION_OUTPUT` de « Œuf de consommation » (quantité commercialisable) et de « Œuf à couver » (quantité à couver) vers l'emplacement de stockage des œufs de la ferme, avec le lot de la pondeuse. Les œufs cassés et non conformes à la collecte **n'entrent pas en stock** : ce sont des indicateurs de production. | C (CM §17 « le stock d'œufs commercialisables doit résulter de ces événements ») / AV-046 |
| BR-OEU-003 | Un œuf cassé **après** son entrée en stock (manutention, transport, PDV) est une perte de catégorie `CASSE` (D06). | C (CM §24) |
| BR-OEU-004 | Une seule collecte par lot et par date (collecte journalière consolidée). Une correction passe par l'annulation de la collecte (mouvements inverses) puis une nouvelle saisie. | D |
| BR-OEU-005 | Unité de base : l'œuf. Le plateau (30 œufs) est une unité de conditionnement pour la vente et le comptage. | AV-046, AV-080 |
| BR-OEU-006 | Des catégories supplémentaires (calibres, œufs déclassés vendables) s'ajoutent comme nouveaux produits et nouveaux champs de collecte, sans modifier le modèle de mouvement. | C (CM §17 « d'autres classifications ») |
| BR-OEU-007 | Coût des œufs produits : coût standard par produit au MVP. Le coût réel se lit au niveau du lot de pondeuses (coût du lot ÷ œufs produits). | AV-042 |

### 7.4 Incubation (INC)

| ID | Règle | Statut |
|---|---|---|
| BR-INC-001 | Un lot d'incubation est constitué d'œufs à couver issus du stock (production interne ou achat réceptionné) ; il crée son lot de traçabilité (origine `INCUBATION_BATCH`). | C (CM §18) / AV-047 |
| BR-INC-002 | Démarrage : déplacement interne des œufs à couver du stockage vers l'emplacement `INCUBATOR` ; `eggs_set_qty` est figé. | C (CM §18) |
| BR-INC-003 | Mirage : les infertiles et la mortalité embryonnaire sortent de l'incubateur vers `V_PRODUCTION` (`PRODUCTION_INPUT`, motifs `INFERTILE`, `MORTALITE_EMBRYONNAIRE`). Ce sont des rendements du procédé et non des pertes accidentelles. Les pertes accidentelles (casse, panne) sont des déclarations de perte à l'emplacement incubateur. | C (CM §18) / D |
| BR-INC-004 | Transfert vers l'éclosoir : déplacement interne incubateur → `HATCHER` des œufs restants. | C (CM §18) |
| BR-INC-005 | Éclosion : les œufs restants sortent vers `V_PRODUCTION` (`PRODUCTION_INPUT`) ; les poussins viables entrent en stock (`PRODUCTION_OUTPUT` « Poussin d'un jour ») avec le lot d'incubation ; les poussins non viables et les œufs non éclos sont comptés. | C (CM §18) |
| BR-INC-006 | Invariant de bilan : œufs incubés = infertiles + mortalité embryonnaire + pertes accidentelles + non éclos + poussins éclos (viables + non viables) (INV-INC-01). | C (CM §18 « relier la quantité d'œufs engagés au résultat ») |
| BR-INC-007 | Taux d'éclosion = poussins éclos viables ÷ œufs incubés. Indicateur secondaire : ÷ œufs fertiles (incubés − infertiles). | C (CM §18) / D |
| BR-INC-008 | Les durées (jour de mirage, jour de transfert, jour d'éclosion attendu) sont des paramètres par espèce ; ils alimentent l'échéancier et les alertes de retard, sans rien bloquer. | AV-047 |
| BR-INC-009 | Coût des poussins produits = coût des œufs engagés + intrants imputés au lot d'incubation, divisé par le nombre de poussins viables (valeur de sortie du lot d'incubation). | D / AV-043 |

### 7.5 Porcs (POR)

| ID | Règle | Statut |
|---|---|---|
| BR-POR-001 | Suivi **par groupe** (lot `PORC_ENGRAISSEMENT`) réparti sur une ou plusieurs cases (`PEN`). L'effectif par case est le solde par emplacement. | C (CM §19) |
| BR-POR-002 | Entrées : achat (réception + reclassement), transfert entrant, naissance (`BIRTH`, si le naissage est activé). | C (CM §19 « entrée ») / AV-045 |
| BR-POR-003 | Déplacement entre cases : déplacement interne (BR-STK-022). | C (CM §19 « transfert ») |
| BR-POR-004 | Vente : à la tête avec poids optionnel, ou au kilo vif selon le mode de tarification du produit (D04, BR-VEN-013). | AV-031 |
| BR-POR-005 | L'identification individuelle n'est pas au MVP ; l'extension `production.animals` est décrite dans le modèle de données mais non créée. | C (CM §19 ; PM §10) |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Lot `ACTIVE` ou `SELLING` pour toute saisie quotidienne | `LOT_NOT_ACTIVE` |
| Mortalité ≤ effectif en élevage à l'emplacement (en ligne) | `INSUFFICIENT_STOCK` (hors ligne : BR-STK-018) |
| Collecte : égalité BR-OEU-001 ; quantités ≥ 0 ; pas de seconde collecte pour le même lot et la même date | `EGG_BALANCE_INVALID`, `EGG_COLLECTION_EXISTS` |
| Incubation : quantités de mirage ≤ œufs en incubateur ; bilan BR-INC-006 à l'éclosion | `INCUBATION_BALANCE_INVALID` |
| Clôture : effectif non vendu nul | `LOT_NOT_EMPTY` |
| Pesée : échantillon > 0 ; poids > 0 | `WEIGHING_INVALID` |

## 9. Dépendances

ADM (sites, bâtiments et cases comme emplacements, validations), CAT (produits biologiques, intrants), STK (mouvements, pertes, consommations, lots de traçabilité), APP (achats d'animaux et d'intrants), STK/valorisation (registre de coûts), FIN (dépenses imputées), VEN (ventes portant le lot), ANA.

## 10. Événements produits

`ProductionLotCreated`, `LotEntryRecorded`, `MortalityRecorded`, `LotInputConsumed`, `LotWeighingRecorded`, `LotObservationRecorded`, `EggCollectionRecorded`, `EggCollectionCancelled`, `IncubationBatchStarted`, `CandlingRecorded`, `HatcherTransferRecorded`, `HatchRecorded`, `ProductionRecorded` (générique : toute sortie de `V_PRODUCTION` vers le stock), `LotStatusChanged`, `ProductionLotClosed`, `HighMortalityDetected`.

> `MortalityRecorded` (production) et `StockLossDeclared` catégorie `MORTALITE` (stock) décrivent **le même fait** sous deux angles. Un consommateur s'abonne à l'un **ou** à l'autre, jamais aux deux pour compter (voir le catalogue d'événements).

## 11. Événements consommés

`StockLossApproved` / `StockLossRejected` (mortalité validée ou rejetée : mise à jour des indicateurs du lot), `SaleConfirmed` / `SaleCancelled` portant un lot (CA du lot), `ExpenseApproved` imputée à un lot (coût), `GoodsReceived` pour des animaux ou des œufs (mise en place directe).

## 12. Fonctionnement hors ligne

- Données locales : lots actifs du site, bâtiments et cases, soldes par lot et emplacement, intrants de la ferme et leurs soldes, lots d'incubation en cours, politiques de contrôle, effectif de référence de chaque lot.
- Toutes les saisies quotidiennes fonctionnent hors ligne. La ferme est une zone de connectivité faible (CM §37).
- Les coûts ne sont pas calculés sur l'appareil.
- Clôture et validations : en ligne.

## 13. Permissions

`production.lot.read`, `production.lot.manage` (création, statut, annulation, clôture), `production.daily.record` (entrées de lot, mortalité, consommations, pesées, observations, collectes), `production.mortality.approve`, `production.incubation.record`, plus les permissions de stock utilisées (`inventory.transfer.*`, `inventory.consumption.record`) et `inventory.valuation.read` pour les coûts et marges.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Mortalité massive (épidémie) | Validation requise (seuil) ; alerte `HIGH_MORTALITY` immédiate à la Direction et au Resp. production dès réception, sans attendre la validation. |
| Saisie du jour oubliée | Alerte `DAILY_ENTRY_MISSING` le lendemain à 10:00 pour chaque lot actif sans saisie la veille. Saisie rétroactive possible dans la fenêtre AV-078. |
| Écart entre effectif théorique et comptage physique | Inventaire du bâtiment (D06) ; écart ajusté avec motif, visible sur la fiche lot. |
| Poussins issus de l'éclosion et vendus directement | Vente depuis l'emplacement d'éclosion (lot `INCUBATION_BATCH`), sans mise en place. |
| Lot réparti sur plusieurs bâtiments | Autorisé : l'effectif et les indicateurs sont agrégés sur le lot de traçabilité. |
