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
| BR-PRD-001 | Un lot a un type (`POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`, `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE` — les cinq dès P7, AV-044, AV-045), un produit biologique (un lot par produit, lots liés : AV-099), un site, un emplacement principal, une date de démarrage, un effectif initial, un fournisseur et une souche optionnels. | C (CM §15, §19) / AV-044, AV-045, AV-099 |
| BR-PRD-002 | La création d'un lot crée son **lot de traçabilité** (`inventory.stock_lots`, origine `PRODUCTION_LOT`). Tous les mouvements des animaux du lot portent ce lot. | D (CM §58) |
| BR-PRD-003 | L'**effectif** d'un lot n'est jamais saisi : c'est la somme des soldes de son lot de traçabilité. On distingue l'**effectif en élevage** (emplacements `BUILDING` et `PEN`) de l'**effectif non vendu** (tous emplacements physiques et transit). | C (CM §15 ; REQ-029) |
| BR-PRD-004 | Une entrée de lot est une mise en place (`PLACEMENT`), une naissance (`BIRTH`) ou un transfert entrant (`TRANSFER_IN`). Mise en place à partir de poussins en stock (éclosion interne ou achat réceptionné) : **reclassement** en une seule opération, `PRODUCTION_INPUT` du produit d'origine puis `PRODUCTION_OUTPUT` du produit du lot vers le bâtiment. Mise en place directe depuis un fournisseur : réception et reclassement saisis en **une seule opération** à l'écran (AV-112) — la réception puis l'entrée de lot, deux commandes liées par dépendance dans le même lot de commandes (chacune dans sa transaction) ; une entrée refusée laisse la réception en stock à la ferme, à mettre en place ensuite. | C (CM §15) / D / AV-112 |
| BR-PRD-005 | La **mortalité** est une déclaration de perte de catégorie `MORTALITE` rattachée au lot et à l'emplacement (D06, BR-STK-030). Elle est saisie depuis la saisie du jour ; motif (cause) facultatif ; photo et validation selon la politique (seuil relatif à l'effectif). | C (CM §16) / AV-048 |
| BR-PRD-006 | Le seuil relatif de mortalité se calcule sur l'effectif en élevage du lot à `occurred_at`, par l'appareil (approximation locale) puis par le serveur (valeur de référence). Si le serveur exige une validation que l'appareil n'avait pas exigée, la perte passe `PENDING_APPROVAL` et la photo est demandée a posteriori. | D (PM §37) |
| BR-PRD-007 | Une consommation d'intrant pour un lot est une consommation (D06, BR-STK-036) dont l'objet de coût est le lot. Sa valeur (quantité × coût unitaire de l'intrant) est ajoutée au coût du lot. | C (CM §4, §15, §33) |
| BR-PRD-008 | La **saisie du jour** d'un lot est un écran unique qui émet des commandes distinctes (mortalité, consommation, pesée, collecte, observation). Chaque commande est indépendante : un échec de l'une n'annule pas les autres. | C (CM §49) / D |
| BR-PRD-009 | Les statuts d'un lot sont `PLANNED` → `ACTIVE` (première entrée) → `SELLING` (animaux déclarés prêts ou disponibles à la vente) → `CLOSED`. `PLANNED` → `CANCELLED` est possible sans entrée. | D (SM-PRODUCTION-LOT) |
| BR-PRD-010 | Seuls les animaux d'un lot `SELLING` peuvent être vendus directement depuis un emplacement d'élevage. Les transferts vers un emplacement commercial sont possibles à partir de `ACTIVE` (sortie vers commercialisation). | C (CM §15, §2 « prêts à la vente ») / D |
| BR-PRD-011 | Un lot ne peut être clôturé qu'avec un effectif non vendu nul. La clôture fige les indicateurs finaux (mortalité cumulée, coût total, CA attribué, marge). | D |
| BR-PRD-012 | Le **coût du lot** = Σ `inventory.cost_entries` de l'objet lot : animaux d'origine, intrants consommés, dépenses directement imputées, part des frais généraux de la ferme (ADR-026), moins les productions transférées au coût standard (œufs, porcelets : ADR-027). Coût par tête à un instant = **coût restant** ÷ effectif non vendu, où coût restant = coût du lot − valeurs figées des sorties définitives (ventes, abattages, sevrages, transferts vers un autre lot) (ADR-027, AV-097). Ce coût par tête valorise les sorties du lot (transferts, ventes, pertes). | C (CM §15, §33) / AV-042, AV-043, AV-097 |
| BR-PRD-013 | La mortalité ne réduit pas le coût du lot : elle le répartit sur un effectif plus faible (hausse du coût par tête). Sa « valeur économique » (quantité × coût par tête au moment de la perte) est un indicateur de perte, pas une charge supplémentaire. | C (CM §16) |
| BR-PRD-014 | Marge d'un lot = CA des ventes portant le lot − coût du lot imputable aux têtes vendues. Pour un lot clôturé : CA total − coût total. | C (CM §33) / D |
| BR-PRD-015 | Une pesée enregistre la taille d'échantillon, le poids moyen (g) et, optionnellement, le poids total ; elle n'a aucun effet de stock. | C (CM §15, §19) |

### 7.2 Volaille de chair (VOL)

| ID | Règle | Statut |
|---|---|---|
| BR-VOL-001 | Un lot `POULET_CHAIR` a pour produit « Poulet de chair vif », compté à la tête. Sa mise en place provient de « Poussin d'un jour (chair) » (BR-PRD-004). | C (CM §15) / D |
| BR-VOL-002 | La sortie vers commercialisation est un transfert du bâtiment vers un magasin, un PDV ou un stock mobile, qui porte le lot et le coût par tête du moment. | C (CM §15) |
| BR-VOL-003 | Le poulet est vendu **vif ou abattu** : l'abattage est une transformation (consommation des poulets vifs, production de plusieurs produits — poulet entier, découpes, abats), avec rendement et pertes d'abattage ; le coût est réparti entre les produits au prorata du poids. | AV-032 (décision du 27/09/2026) |
| BR-VOL-004 | L'abattage se fait à la ferme, dans un emplacement `SLAUGHTERHOUSE`, saisi par le Responsable ferme ; les produits entrent au stock de la ferme sous le lot de stock propre de l'abattage (origine `TRANSFORMATION`, avec péremption), rattaché au lot de production ; le poulet entier se compte à la pièce (poids enregistré), les découpes et abats au kilo. | AV-100, AV-101, AV-102 |

### 7.3 Pondeuses et œufs (OEU)

| ID | Règle | Statut |
|---|---|---|
| BR-OEU-001 | Une collecte d'œufs d'un lot `PONDEUSE` pour une date donne : collectés, cassés, non conformes, commercialisables, à couver. Invariant : collectés = cassés + non conformes + commercialisables + à couver (INV-OEU-01). | C (CM §17) |
| BR-OEU-002 | Effets stock d'une collecte : `PRODUCTION_OUTPUT` des œufs commercialisables, **par calibre** (un produit par calibre, AV-046), et de « Œuf à couver » (quantité à couver) vers l'emplacement de stockage des œufs de la ferme, avec le **lot de stock propre de la collecte** (AV-100 : le lot de la pondeuse reste celui des animaux). Les œufs cassés et non conformes à la collecte **n'entrent pas en stock** : ce sont des indicateurs de production. | C (CM §17 « le stock d'œufs commercialisables doit résulter de ces événements ») / AV-046 |
| BR-OEU-003 | Un œuf cassé **après** son entrée en stock (manutention, transport, PDV) est une perte de catégorie `CASSE` (D06). | C (CM §24) |
| BR-OEU-004 | Plusieurs collectes par lot et par jour sont admises (AV-110 : une par ramassage). Une correction passe par l'annulation de la collecte (mouvements inverses) puis une nouvelle saisie. | D / AV-110 |
| BR-OEU-005 | Unité de base : l'œuf. Le plateau (30 œufs) est une unité de conditionnement pour la vente et le comptage. | AV-046, AV-080 |
| BR-OEU-006 | Des catégories supplémentaires (calibres, œufs déclassés vendables) s'ajoutent comme nouveaux produits et nouveaux champs de collecte, sans modifier le modèle de mouvement. | C (CM §17 « d'autres classifications ») |
| BR-OEU-007 | Coût des œufs produits : coût standard en vigueur de chaque produit ; le lot de pondeuses est crédité du même montant (`PRODUCTION_TRANSFEREE`) et l'écart entre coût réel et standard reste dans son résultat. | AV-042, AV-098 (ADR-027) |

### 7.4 Incubation (INC)

| ID | Règle | Statut |
|---|---|---|
| BR-INC-001 | Un lot d'incubation est constitué d'œufs à couver issus du stock (production interne ou achat réceptionné) ; il crée son lot de traçabilité (origine `INCUBATION_BATCH`). | C (CM §18) / AV-047 |
| BR-INC-002 | Démarrage : les œufs à couver passent du stockage à l'emplacement `INCUBATOR`, sous le lot de traçabilité du lot d'incubation (reclassement `PRODUCTION_INPUT` puis `PRODUCTION_OUTPUT` à la même valeur, un déplacement interne ne pouvant changer de lot) ; `eggs_set_qty` est figé. | C (CM §18) / D (ADR-027, P7-08) |
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
| BR-POR-006 | Les porcs d'engraissement et les reproducteurs de réforme (naissage) peuvent être abattus comme les volailles : transformation en découpes du catalogue, valeur répartie au prorata du poids (BR-VOL-003), lot de stock propre de l'abattage. | AV-115 |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Lot `ACTIVE` ou `SELLING` pour toute saisie quotidienne | `LOT_NOT_ACTIVE` |
| Mortalité ≤ effectif en élevage à l'emplacement (en ligne) | `INSUFFICIENT_STOCK` (hors ligne : BR-STK-018) |
| Collecte : égalité BR-OEU-001 ; quantités ≥ 0 ; calibres paramétrés (AV-046) ; lot pondeur (AV-044) | `EGG_BALANCE_INVALID`, `EGG_GRADE_INVALID`, `LOT_NOT_LAYING` |
| Incubation : quantités de mirage ≤ œufs en incubateur ; bilan BR-INC-006 à l'éclosion | `INCUBATION_BALANCE_INVALID` |
| Clôture : effectif non vendu nul ; aucune tête en attente de validation d'une perte ou d'une mortalité | `LOT_NOT_EMPTY`, `LOT_HAS_PENDING_LOSS` |
| Pesée : échantillon > 0 ; poids > 0 | `WEIGHING_INVALID` |
| Changement de statut ou clôture sur un lot qui n'est ni actif ni en vente | `LOT_STATUS_INVALID` |
| Passage en vente sans animal en élevage | `LOT_EMPTY` |
| Annulation d'un lot qui n'est plus planifié | `LOT_NOT_CANCELLABLE` |
| Création : lot lié ouvert, même ferme, même espèce ; fin prévue ≥ démarrage prévu | `PARENT_LOT_INVALID`, `DATES_INVALID` |
| Entrée : origine complète (produit, emplacement, réception, lot d'origine) ; lot d'origine ou de truies actif (en ligne) ; animaux d'un lot de production jamais pris en mise en place | `SOURCE_REQUIRED`, `SOURCE_LOT_NOT_ACTIVE`, `LOT_ENTRY_INVALID` |
| Annulation d'une entrée dont le lot d'origine ou de truies est clôturé | `SOURCE_LOT_NOT_ACTIVE` |

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

`production.lot.read`, `production.lot.manage` (création, statut, annulation, annulation d'une entrée, clôture), `production.daily.record` (entrées de lot, mortalité, consommations, pesées, observations, collectes), `production.mortality.approve`, `production.incubation.record`, `production.overhead.allocate` (répartition des frais généraux : Finance et Responsable production, AV-106), plus les permissions de stock utilisées (`inventory.transfer.*`, `inventory.consumption.record`) et `inventory.valuation.read` pour les coûts et marges.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Mortalité massive (épidémie) | Validation requise (seuil) ; alerte `HIGH_MORTALITY` immédiate à la Direction et au Resp. production dès réception, sans attendre la validation. |
| Saisie du jour oubliée | Alerte `DAILY_ENTRY_MISSING` le lendemain à 10:00 pour chaque lot actif sans saisie la veille. Saisie rétroactive possible dans la fenêtre AV-078. |
| Écart entre effectif théorique et comptage physique | Inventaire du bâtiment (D06) ; écart ajusté avec motif, visible sur la fiche lot. |
| Poussins issus de l'éclosion et vendus directement | Vente depuis l'emplacement d'éclosion (lot `INCUBATION_BATCH`), sans mise en place. |
| Lot réparti sur plusieurs bâtiments | Autorisé : l'effectif et les indicateurs sont agrégés sur le lot de traçabilité. |

## 15. Choix d'implémentation (P7)

Précisions retenues par le module `production` et la bibliothèque partagée (`packages/domain/src/production.ts`) là où les règles laissent un choix ; toutes **DÉDUITES**, sans effet sur les règles confirmées ni sur les décisions du porteur du projet du 27/09/2026 (A-VALIDER §3, ADR-025, ADR-026).

| Point | Choix | Justification |
|---|---|---|
| Profil d'un type de lot (AV-044) | Collectes d'œufs pour `PONDEUSE` et `REPRODUCTEUR_VOLAILLE` ; naissances et sevrage pour `PORC_NAISSAGE` ; espèce (volaille, porc) pour les paramètres d'incubation et les frais généraux. Les types abattables ne sont pas un attribut du profil mais le paramètre `production.slaughterable_lot_types` (tous les types, AV-115). | Décisions AV-044, AV-045, AV-115. |
| Bilan de collecte (INV-OEU-01, AV-046) | Collectés = cassés + non conformes + Σ calibres commercialisables + à couver ; quantités entières ≥ 0 ; un calibre au plus une fois par collecte (`EGG_BALANCE_INVALID`). | BR-OEU-001 ; calibres à la collecte (AV-046). |
| Bilan d'incubation (INV-INC-01) | Œufs restants = incubés − infertiles − mortalité embryonnaire − pertes accidentelles ; mirage borné par les œufs restants ; à l'éclosion, non éclos + viables + non viables = œufs restants (`INCUBATION_BALANCE_INVALID`). | BR-INC-003 à 006. |
| Taux | Arrondis à 4 décimales (demi supérieur) ; `null` quand le dénominateur est nul. Taux d'éclosion ÷ œufs incubés, et ÷ œufs fertiles en indicateur secondaire. | Colonne `hatch_rate` DECIMAL(5,4) ; BR-INC-007. |
| Seuil de mortalité (AV-048) | Validation si morts > seuil absolu **ou** morts ÷ effectif en élevage > seuil relatif (dépassement strict) ; seuils paramétrés ; réglés à 0 pour « toute mortalité validée ». Effectif en élevage nul : validation dès la première tête. | BR-PRD-006 ; décision AV-048. |
| Coût par tête | Coût restant ÷ effectif non vendu (ADR-027), arrondi au franc demi supérieur ; aucun coût par tête sur un effectif nul ; la dernière sortie d'un lot emporte le coût restant exact. | BR-PRD-012 ; coût figé d'un mouvement (BR-STK-052). |
| Répartitions (frais généraux, coproduits) | Au prorata de poids entiers, exacte au franc (méthode du plus fort reste, égalité départagée par l'ordre des lots ou produits) ; poids tous nuls : rien n'est réparti. | ADR-026 : la somme des parts égale toujours le montant réparti. |
| Têtes × jours (AV-043) | Somme, sur chaque jour métier de la période, de l'effectif en fin de journée (jamais négatif). | ADR-026. |
| Indicateurs (AV-049) | GMQ = écart de poids moyen entre deux pesées ÷ jours (au dixième de gramme) ; indice de consommation = aliment (kg) ÷ gain de poids vif du lot (kg), `null` si le gain n'est pas positif ; taux de ponte = œufs collectés ÷ pondeuses présentes ; rendement d'abattage = poids des produits ÷ poids vif. | Décision AV-049 ; formules usuelles. |
| Produit et emplacement d'un lot (P7-05) | Produit biologique actif, suivi par lot, de l'espèce du type (reproducteur volaille : souche chair ou ponte ; naissage : truies, verrats ou porcelets) ; emplacement principal = bâtiment ou case actif d'une ferme ; lot lié ouvert, même ferme, même espèce. Numéro `LOT-{site}-{année}-{séquence}`, aussi code du lot de traçabilité. | BR-PRD-001, BR-PRD-002 ; AV-099. |
| Entrées de lot (P7-05) | Toute entrée (mise en place, naissance, transfert) peut être la première et fait passer le lot `PLANNED` → `ACTIVE` ; têtes entières. Date de démarrage = jour de l'entrée **la plus ancienne** (une entrée hors ligne antérieure l'avance). Mise en place : produit d'origine biologique de la même espèce, sur la ferme du lot (`SOURCE_PRODUCT_INVALID`, `SITE_MISMATCH`) ; sortie au CMUP, ou au coût par tête d'un lot d'incubation ; sans lot désigné ni stock : `INSUFFICIENT_STOCK` ; les animaux d'un lot de production (le sien ou un autre, désignés ou retenus par le FIFO) ne se prennent jamais par une mise en place mais par un transfert (`LOT_ENTRY_INVALID`). Hors ligne, un bâtiment ou une case désactivé depuis est accepté. | BR-PRD-004 ; ADR-027 ; revue P7. |
| Mise en place par achat (P7-05) | Réception (`procurement.receipt.record`) puis entrée `PURCHASE` dans le même lot de commandes ; têtes prises ligne par ligne sur les lots fournisseurs de la réception, dans la limite de leur solde réel à l'emplacement de réception (une mise en place précédente a pu en prendre) ; réception comptabilisée (`RECEIPT_NOT_POSTED`), livrée sur la ferme du lot (`RECEIPT_SITE_MISMATCH`), quantité au plus les têtes de la réception encore en stock (`PLACEMENT_EXCEEDS_RECEIPT`) ; hors ligne, le surplus est appliqué en FIFO. | AV-112 ; BR-PRD-004. |
| Naissance, sevrage, transfert (P7-05) | Naissance : lot de naissage lié à un lot de naissage parent (`LOT_ENTRY_INVALID`), au coût standard du produit ; sans coût standard, entrée à 0 XAF (le coût reste au lot de truies) et alerte `STANDARD_COST_MISSING` à l'administrateur en P9 (AV-124). Sevrage : lot de naissage → lot d'engraissement ; transfert : lots distincts de la même espèce ; sortie du lot d'origine au coût restant par tête. | AV-098, AV-111, AV-097. |
| Effectif initial (P7-05) | Σ des têtes des entrées enregistrées (toutes origines), diminuée à l'annulation d'une entrée ; dénominateur du taux de mortalité de clôture (recommandation AV-116 : effectif initial + entrées). | INV-PRD-01 : l'effectif courant reste lu dans le registre de stock. |
| Entrée hors ligne sur un lot clôturé ou annulé (P7-05) | Appliquée (BR-SYN-007), sans changer le statut du lot ; conflit informatif `LOT_CLOSED` au Responsable production. En ligne : `LOT_NOT_ACTIVE`. | Matrice des conflits (perte sur lot clôturé). |
| Annulation d'une entrée (P7-05) | Responsable production seul (AV-123), lot actif ou en vente — ou entrée appliquée hors ligne après la fermeture du lot (conflit `LOT_CLOSED`), pour libérer ses animaux ; refusée si le lot d'origine ou de truies est clôturé (`SOURCE_LOT_NOT_ACTIVE`) : mouvements inverses à la valeur exacte d'origine (produit sorti avant retour des animaux d'origine), écritures de coût contrepassées (dont le crédit du lot de truies) ; animaux déjà sortis : `STOCK_UNAVAILABLE`. | ADR-006 ; AV-123 ; AV-120 ; revue P7. |
| Clôture (P7-05) | Effectif non vendu nul (`LOT_NOT_EMPTY`), aucune tête du lot en attente de validation d'une perte, mortalité ou autre (`LOT_HAS_PENDING_LOSS`) ; `closing_summary` : effectif initial, entrées, mort-nés, mortalité comptée et taux, autres pertes (dont une mortalité rejetée « non justifiée », reclassée), débits, crédits et coût net, coût non emporté par les sorties ; lot de traçabilité clôturé. La part estimée de frais généraux s'ajoute en P7-10 (AV-105). | BR-PRD-011 ; INV-PRD-02 ; revue P7. |
| Saisie du jour : état du lot (P7-06) | Mortalité, intrant, pesée, observation : lot `ACTIVE` ou `SELLING` en ligne (`LOT_NOT_ACTIVE`) ; hors ligne, sur tout autre état, saisie appliquée avec le conflit `LOT_CLOSED` au Responsable production. | D07 §8 ; BR-SYN-007. |
| Mortalité (P7-06) | `production.mortality.record` : déclaration `MORTALITE` sur le produit et le lot de traçabilité du lot, emplacement de la ferme (par défaut l'emplacement principal ; `SITE_MISMATCH`), cause facultative (motif `LOSS`), quantité en têtes entières ; photo et validation par la politique `MORTALITY` comme toute mortalité (même API que `inventory.loss.declare`). | BR-PRD-005, BR-PRD-006 ; AV-048, AV-107. |
| Consommation d'un lot (P7-06) | `production.input.record` : intrant consommable, hors produit biologique (`PRODUCT_NOT_CONSUMABLE`), pris sur un emplacement de la ferme ; nature `ALIMENT`, `VETERINAIRE` ou `AUTRE_INTRANT` ; annulation par `inventory.consumption.cancel`. | BR-PRD-007 ; AV-049. |
| Pesée et observation (P7-06) | Pesée sur un bâtiment ou une case de la ferme (facultatif), annulable par `production.weighing.cancel` (saisie du jour, commentaire obligatoire) ; observation immuable, typée (sanitaire, comportement, environnement, incident, autre), gravité par défaut `INFO` ; « RAS » = observation `AUTRE`. | BR-PRD-015 ; défaut AV-117. |
| Collecte d'œufs (P7-07) | Lot pondeuse ou reproducteur (`LOT_NOT_LAYING`, contrôlé avant l'état du lot) ; emplacement de stockage de la ferme ; date de collecte ≤ jour de la saisie (`COLLECTION_DATE_INVALID`) ; calibres = produits dont le code est dans `production.egg_grade_product_codes` (en ligne ; hors ligne, tout produit non biologique connu, la liste ayant pu changer) ; œufs à couver = produit `production.hatching_egg_product_code` (`HATCHING_PRODUCT_MISSING`). Numéro `COL-…`, aussi code du lot de stock propre (produit porté s'il est unique), péremption = date de collecte + `production.egg_shelf_life_days`. | BR-OEU-001, 002 ; AV-046, AV-100, AV-110, AV-122. |
| Valeur d'une collecte (P7-07) | Chaque produit entre au coût standard en vigueur (entrée valorisée, CMUP recalculé) ; sans coût standard, au CMUP courant, avec l'alerte `STANDARD_COST_MISSING` en P9 (AV-124) ; le lot producteur est crédité de la valeur totale (`PRODUCTION_TRANSFEREE`). | AV-098, AV-124, ADR-027. |
| Annulation d'une collecte (P7-07) | Saisie du jour (`production.daily.record`) : mouvements inverses, crédit contrepassé, lot de stock de la collecte clôturé. Œufs déjà sortis : refus en ligne (`STOCK_UNAVAILABLE`, AV-120), application hors ligne avec `STOCK_NEGATIVE` ; lot producteur clôturé : refus en ligne (`LOT_NOT_ACTIVE`), conflit `LOT_CLOSED` hors ligne. | SM-EGG-COLLECTION ; ADR-006. |
| Démarrage d'une incubation (P7-08) | Incubateur actif d'une ferme (`LOCATION_INVALID`) ; œufs pris sur un emplacement de stockage de la ferme, jamais dans un incubateur, un éclosoir, ni dans le lot d'un autre lot d'incubation ou de production (`EGG_SOURCE_INVALID`, lot désigné ou retenu par le FIFO) ; œuf non biologique, et en ligne le produit `production.hatching_egg_product_code` (`EGG_PRODUCT_INVALID`) ; poussin biologique de volaille suivi par lot (`CHICK_PRODUCT_INVALID`) ; espèce présente dans `production.incubation_durations` en ligne (`SPECIES_UNKNOWN`). Origine interne ou achetée déduite du lot pris (collecte ou lot fournisseur). Numéro `INC-…`, aussi code du lot de stock. Coût `OEUFS` = valeur de sortie des œufs. | BR-INC-001, 002, 008 ; AV-047 ; ADR-027 ; revue P7. |
| Mirage, transfert, éclosion (P7-08) | Mirage : sorties au coût 0 avec les motifs `INFERTILE`, `MORTALITE_EMBRYONNAIRE` ; un mirage saisi en double s'annule (`production.incubation.cancel_candling`, Responsable production, comme une entrée de lot, AV-123 : mouvements inverses, compteurs repris). Transfert : tous les œufs du lot présents à l'incubateur, vers un éclosoir actif de la ferme, une seule fois. Éclosion : œufs restants pris à l'éclosoir puis à l'incubateur ; ils sortent sans coût déclaré, la dernière sortie d'un emplacement emportant la valeur exacte de son solde (aucun reliquat) ; ces sorties internes ne diminuent pas le coût du lot ; les poussins viables entrent au coût restant ; taux d'éclosion figé ; lot clos. | BR-INC-003 à 007, 009 ; revue P7. |
| Pertes accidentelles (P7-08) | Pertes d'inventaire (casse, détérioration) sur le lot de stock ; `accidental_loss_qty` les compte sur les **mouvements** (entrées en perte moins retours), pas sur les déclarations, qui ne retiennent qu'un lot quand le FIFO en touche plusieurs. Éclosion et annulation refusées en ligne tant que des œufs attendent la validation d'une perte (`INCUBATION_HAS_PENDING_LOSS`) : un rejet les rendrait au lot après coup. | BR-INC-003, BR-INC-006 ; revue P7. |
| Incubation hors ligne (P7-08) | Une étape reçue après une autre s'applique là où sont les œufs ; un second transfert vers le même éclosoir est sans effet ; une éclosion avec moins d'issues que d'œufs restants est complétée en non éclos (avertissement `INCUBATION_BALANCE_ADJUSTED`, conflit informatif `INCUBATION_BALANCE`). Sont **mis en quarantaine** (statut `CONFLICT`, sans effet, fait conservé pour l'arbitrage du Responsable production) : plus d'issues que d'œufs restants ou mirage excessif (`INCUBATION_BALANCE`), perte en attente à l'éclosion ou à l'annulation (`INCUBATION_PENDING_LOSS`), second transfert vers un autre éclosoir (`INCUBATION_DUPLICATE_STEP`), étape ou annulation sur un lot clos ou annulé (`INCUBATION_CLOSED`), annulation avec des œufs encore en stock (`INCUBATION_NOT_EMPTY`). En ligne, chaque étape exige son état (`INCUBATION_STATUS_INVALID`). L'agrégat d'une commande d'étape est l'étape elle-même : un identifiant déjà pris par une autre étape est refusé (`AGGREGATE_ID_REUSED`). | BR-SYN-007 ; SM-INCUBATION ; revue P7. |
| Annulation d'une incubation (P7-08) | Perte totale seulement : plus aucun œuf du lot en stock (`INCUBATION_NOT_EMPTY`) ni en attente de validation d'une perte (`INCUBATION_HAS_PENDING_LOSS`) ; lot de stock clos ; le coût du lot d'incubation reste une perte. Pas d'annulation après l'éclosion ; seul le mirage s'annule étape par étape. | SM-INCUBATION ; revue P7. |
| Abattage (P7-09) | `production.slaughter.record` (saisie du jour, hors ligne possible) : type de lot abattable (`production.slaughterable_lot_types`, tous les types, AV-115 ; en ligne `LOT_NOT_SLAUGHTERABLE`, contrôlé avant l'état du lot ; hors ligne, fait appliqué et conflit informatif `LOT_NOT_SLAUGHTERABLE`) ; abattoir de la ferme (`LOCATION_INVALID`) ; animaux pris sur un bâtiment ou une case ; produits non biologiques (`OUTPUT_PRODUCT_INVALID`) stockés sur la ferme ; bilan `checkSlaughter` (têtes, saisies ≤ têtes, poids des produits ≤ poids vif, toutes têtes saisies = une perte à déclarer, `SLAUGHTER_INVALID`) ; produit au kilo : quantité = poids pesé (`SLAUGHTER_INVALID`). Numéro `ABT-…`, aussi code du lot de stock (produit porté s'il est unique), péremption = jour de l'abattage + `production.slaughter_shelf_life_days` (AV-125). | BR-VOL-003, BR-VOL-004, BR-POR-006 ; AV-032, AV-101, AV-102, AV-115 ; revue P7. |
| Valeur d'un abattage (P7-09) | Les têtes saines, puis les têtes saisies (sortie distincte, motif `SAISIE_SANITAIRE`, AV-114 : sans produit, leur coût porté par les produits), sortent du lot au coût par tête (coût restant, le dernier abattage emporte le reste exact) ; cette valeur est répartie entre les produits au prorata du poids, au franc près (plus fort reste) ; chaque produit entre à sa part (entrée valorisée, CMUP recalculé). Rendement = poids des produits ÷ poids vif. Les frais propres de l'abattage sont des dépenses directes du lot (P8) : à saisir avant le dernier abattage, sinon ils restent au lot (coût non emporté, `unrecoveredCostXaf`). | AV-032, AV-049, AV-114, ADR-026, ADR-027. |
| Annulation d'un abattage (P7-09) | Responsable production (par analogie avec l'annulation d'une entrée, AV-123), lot actif ou en vente — ou abattage appliqué hors ligne après la fermeture du lot (conflit `LOT_CLOSED`), pour corriger ses produits : mouvements inverses à la valeur exacte d'origine (produits sortis avant retour des animaux) ; produits déjà sortis : `STOCK_UNAVAILABLE` (AV-120) ; lot de stock de l'abattage clôturé. | ADR-006 ; revue P7. |
| Lot d'origine clos, hors ligne (revue P7) | Une entrée hors ligne dont le lot d'origine (transfert, sevrage) ou le lot de truies (naissance) a été clôturé entre-temps est appliquée ; chaque lot clos touché reçoit un conflit `LOT_CLOSED`. | BR-SYN-007 ; INV-PRD-02. |
| Valeur d'un inverse (revue P7) | Un mouvement inverse reprend la **valeur figée** du mouvement d'origine, pas quantité × coût unitaire arrondi : une sortie à valeur imposée (dernière sortie d'un lot, répartition au franc) se contrepasse sans écart. | BR-STK-052 ; ADR-027. |
| Numéros de document | L'année du numéro (`LOT`, `COL`, `INC`, `ABT`, `PRT`, transferts, inventaires, achats) est celle du jour métier Africa/Douala de l'opération. | ADR-016 ; revue P7. |
| Répartition des frais généraux (P7-10) | `production.overhead.allocate`, en ligne, pour une ferme, une espèce et un mois métier : masse = solde des écritures `FRAIS_GENERAUX` du site pour l'espèce et le mois (saisies − annulations − parts déjà réparties) ; lots candidats = lots actifs ou en vente de l'espèce sans part estimée pour ce mois ; clé = têtes × jours en élevage (bâtiments, cases) sur les jours écoulés du mois ; parts au franc (plus fort reste), débit `FRAIS_GENERAUX` de chaque lot et crédit du site, datés au plus tard de la fin du mois. Première exécution `INITIAL`, suivantes `REGULARIZATION` sur le seul montant nouveau ; refus : `SITE_NOT_FARM`, `PERIOD_INVALID` (mois futur), `NOTHING_TO_ALLOCATE`, `NO_LOT_TO_ALLOCATE` (la masse reste visible, non répartie). | ADR-026 amendé ; AV-104, AV-106. |
| Part estimée à la clôture (P7-10) | À la clôture d'un lot, pour **chaque mois de sa vie** dont une masse reste non répartie (et pas seulement le mois de clôture : un mois antérieur pas encore réparti serait sinon perdu pour ce lot), sa part sur les frais connus, au même calcul (`CLOSING_ESTIMATE`) ; les exécutions suivantes de ces mois l'excluent ; `closing_summary` porte `overheadXaf` et `overheadEstimateXaf`. | AV-105 (DÉDUIT : extension aux mois antérieurs non répartis). |
| Lectures (P7-11) | `GET /production/lots[/{id}[/daily]]`, `/production/egg-collections[/{id}]`, `/production/incubations[/{id}]`, `/production/slaughters[/{id}]`, `/production/overhead-allocations` sous `production.lot.read`, portée par la ferme du document ; pagination par curseur (identifiant décroissant). Effectif lu dans le registre (INV-PRD-01) : non vendu et en élevage ; mortalité comptée (enregistrée, validée ou en attente d'annulation) distincte de la mortalité en attente de validation. Vue jour par jour : effectif en élevage en fin de journée, morts, consommations (quantité, nature, valeur), pesées, observations, œufs, têtes entrées ; 7 jours par défaut, 92 au plus (`VALIDATION_ERROR`). Résultat mensuel d'un lot permanent (AV-109) : coûts par mois métier ; chiffre d'affaires `null` jusqu'à P4. RC-05 : toute valeur en XAF à `null` sans `inventory.valuation.read`. | 08-api-events §4.7 ; RC-04, RC-05 ; AV-109. |
| Jeu hors ligne `production` (P7-12) | Lots ouverts de la ferme (sans coût ; l'effectif courant se lit dans les soldes du lot de traçabilité, jeu `stock`, jamais copié : INV-PRD-01), lots d'incubation en cours, saisies des 30 derniers jours tous statuts (entrées, pesées, observations, collectes, abattages ; pertes et consommations d'un lot émises par `inventory`, propriétaire de leurs tables), renvoyées à chaque annulation ou décision de validation ; aucune valeur (RC-05). Périmètre : fermes qu'atteint `production.lot.read` (Responsable production : toutes ; responsable de ferme : la sienne) ; un magasinier affecté à une ferme n'en reçoit rien. | 01-architecture-offline §3.1 ; 02-synchronisation §5.2 ; RC-05. |
| Indicateurs d'un lot (P7-11) | Défauts de la recommandation AV-116 (ouvert) : taux de mortalité = mortalité comptée ÷ effectif initial (Σ des entrées) ; GMQ = écart de poids moyen entre la première et la dernière pesée enregistrées ÷ jours écoulés ; indice de consommation = aliment (`ALIMENT`, kg) consommé entre ces deux pesées ÷ gain de poids vif du lot (effectif en élevage × poids moyen, à chaque pesée), donc hors morts ; taux de ponte = œufs collectés le dernier jour de collecte ÷ effectif en élevage au début de ce jour. Moins de deux pesées : ni GMQ ni IC (le poids standard par produit n'est pas encore paramétré). | AV-049, AV-116 ; KPI-PRD-03. |
| Valeur d'un lot biologique vidé (revue P7) | Un mouvement d'un lot biologique qui vide le solde d'un emplacement (hors sortie définitive du lot, ou transformation interne d'un lot d'incubation) en emporte la valeur exacte ; les sorties d'œufs du mirage et de l'éclosion (document `INCUBATION_EVENT`) ne sont pas des sorties du coût du lot. | ADR-027 ; BR-INC-009. |
| Limites connues (revue P7) | Une consommation imputée à un lot d'incubation clos, une perte d'œufs saisie hors ligne et reçue après l'éclosion, ou une ligne de réception sans lot fournisseur prise par le FIFO lors d'une mise en place, ne sont pas bloquées : les soldes négatifs qui en résultent relèvent de l'alerte `STOCK_NEGATIVE` (P9) ; les produits biologiques devraient être suivis par lot obligatoire. | Revue P7 ; P9. |
