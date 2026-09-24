# D06 — Stocks (STK)

> Couvre : registre des mouvements, soldes, lots de traçabilité, transferts (y compris affectation physique à un utilisateur), allocations hors ligne et réservations, pertes, consommations, inventaires, seuils, valorisation.
> Module de code : `inventory`. Stratégie détaillée : [`../../02-domain-model/03-strategie-stock.md`](../../02-domain-model/03-strategie-stock.md). Décisions : ADR-003, ADR-004, ADR-015.

---

## 1. Objectif

Connaître **avec fiabilité**, pour chaque produit :

- ce qui existe, où, depuis quand ;
- de quel lot ou de quelle opération il provient ;
- ce qui est disponible, affecté ou réservé ;
- pourquoi chaque quantité a varié.

Le stock n'est **jamais** une quantité saisie : il résulte de mouvements traçables (CM §20–§25, §39 ; PM §6).

## 2. Acteurs

`MAGASINIER`, `VENDEUR_PDV`, `COMMERCIAL_TERRAIN` (stock mobile), `RESP_FERME`, `RESP_PRODUCTION`, `DIRECTION`, `FINANCE` (valorisation), `system` (réservations, rapprochements, alertes). Les modules `sales`, `procurement` et `production` créent des mouvements **via l'API interne** d'`inventory`, jamais directement.

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Mouvement de stock | `inventory.stock_moves` | Registre en ajout seul, en partie double (source → destination) |
| Solde de stock | `inventory.stock_balances` | Projection par emplacement × produit × lot |
| Lot de traçabilité | `inventory.stock_lots` | Dimension lot (production, fournisseur, collecte) |
| Transfert et ses lignes | `inventory.stock_transfers`, `inventory.stock_transfer_lines` | Déplacement en deux temps entre emplacements |
| Allocation / réservation | `inventory.stock_allocations`, `inventory.stock_allocation_entries` | Quota hors ligne d'un appareil ; réservation d'une commande |
| Déclaration de perte | `inventory.loss_declarations` | Perte documentée (y compris mortalité) |
| Consommation | `inventory.consumptions` | Sortie d'intrant imputée à un objet de coût |
| Inventaire et ses lignes | `inventory.inventory_counts`, `inventory.inventory_count_lines` | Comptage, écarts, ajustements |
| Seuil de réapprovisionnement | `inventory.stock_thresholds` | Minimum et cible par emplacement × produit |
| Valorisation produit | `inventory.product_valuations` | CMUP courant, coût standard |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-STK-01 | Consulter le stock d'un emplacement (solde, disponible, alloué, réservé, par lot) | requête | Détenteurs, responsables | **Oui** (périmètre) |
| UC-STK-02 | Demander un réapprovisionnement | `inventory.transfer.request` | VENDEUR_PDV, RESP_FERME | **Oui** |
| UC-STK-03 | TRANSFÉRER : expédier (y compris affecter du stock à un commercial) | `inventory.transfer.dispatch` | MAGASINIER, RESP_FERME, détenteur d'un stock mobile (retour) | **Oui** |
| UC-STK-04 | Déplacement interne immédiat (même site, même responsable) | `inventory.transfer.move_internal` | MAGASINIER, RESP_FERME | **Oui** |
| UC-STK-05 | RECEVOIR un transfert (avec le document ou sans document) | `inventory.transfer.receive` | Destinataire | **Oui** |
| UC-STK-06 | Traiter un écart de transfert | `approvals.request.approve` / `reject` | Responsable du site expéditeur, DIRECTION | Non |
| UC-STK-07 | Annuler un transfert non expédié | `inventory.transfer.cancel` | Auteur, MAGASINIER | **Oui** |
| UC-STK-08 | DÉCLARER UNE PERTE | `inventory.loss.declare` | Tout détenteur de stock | **Oui** |
| UC-STK-09 | Approuver ou rejeter une perte | `approvals.request.approve` / `reject` | Responsables selon politique | Non |
| UC-STK-10 | Enregistrer une consommation d'intrant hors lot | `inventory.consumption.record` | MAGASINIER, RESP_FERME, VENDEUR_PDV (emballages) | **Oui** |
| UC-STK-11 | INVENTORIER : ouvrir, compter, soumettre | `inventory.count.open`, `inventory.count.record_lines`, `inventory.count.submit` | MAGASINIER, VENDEUR_PDV, RESP_FERME | **Oui** (comptage) |
| UC-STK-12 | Valider un inventaire (écarts au-dessus du seuil) | `approvals.request.approve` / `reject` | Responsable du site, DIRECTION, FINANCE | Non |
| UC-STK-13 | Accorder, augmenter, libérer ou révoquer une allocation | `inventory.allocation.grant`, `inventory.allocation.release`, `inventory.allocation.revoke` | MAGASINIER, responsable du PDV ; l'appareil détenteur pour la libération | Non (octroi, révocation) / **Oui** (libération) |
| UC-STK-14 | Charger le stock d'ouverture | `inventory.count.open` (type `OPENING`) | ADMIN, MAGASINIER | Non |
| UC-STK-15 | Paramétrer les seuils de réapprovisionnement | `inventory.threshold.set` | Responsables, DIRECTION | Non |
| UC-STK-16 | Expliquer un écart : parcourir le registre d'un emplacement × produit | requête | Responsables, DIRECTION | Non |

## 5. Entrées

- Demandes de mouvement des autres modules : réception (APP), vente et annulation (VEN), production et consommation de lot (PRD).
- Saisies directes : transferts, pertes, consommations, comptages.
- Décisions de validation.
- Coûts d'achat (APP) et coûts de lot (PRD/FIN) pour la valorisation.

## 6. Sorties

- Soldes et disponibilités par emplacement, lot et zone.
- Quantités en transit, allouées, réservées, en attente de perte.
- Historique explicable.
- Valeur du stock, des pertes et des sorties (coût des ventes).
- Alertes : stock faible, rupture, stock négatif, écart d'inventaire, écart de transfert, réapprovisionnement.

## 7. Règles métier

### 7.1 Registre

| ID | Règle | Statut |
|---|---|---|
| BR-STK-001 | Toute variation de stock est un **mouvement** : produit, quantité strictement positive en unité de base, emplacement source, emplacement destination, lot éventuel, type de mouvement (cause), document source, heure métier, auteur, appareil, coût unitaire. Aucune autre écriture ne modifie un stock. | C (CM §21 ; PM §6) |
| BR-STK-002 | Un mouvement est **immuable**. Pour le corriger, on crée un mouvement inverse (`is_reversal = true`, `reverses_move_id`), toujours issu d'un document (annulation, rejet, régularisation). | C (CM §41 ; PM §8) |
| BR-STK-003 | Les origines et destinations externes sont des **emplacements virtuels** : `V_SUPPLIER`, `V_CUSTOMER`, `V_PRODUCTION`, `V_CONSUMPTION`, `V_LOSS`, `V_PENDING_LOSS`, `V_ADJUSTMENT`, `V_TRANSIT`, `V_OPENING`. Ainsi, la somme des quantités d'un produit sur tous les emplacements est constante (conservation). | D (ADR-003) |
| BR-STK-004 | Le solde d'un emplacement × produit × lot = Σ quantités entrantes − Σ quantités sortantes. `stock_balances` est une projection mise à jour **dans la même transaction** que le mouvement, et reconstructible à tout moment depuis le registre. | C (PM §6) |
| BR-STK-005 | Le solde peut être calculé **à une date métier** (Σ des mouvements de `occurred_at` ≤ date). C'est la base des inventaires et des analyses historiques. | D (CM §38) |
| BR-STK-006 | Types de mouvement autorisés, avec leur couple (source → destination) : voir la table §7.7. Tout autre couple est refusé. | D |

### 7.2 Disponibilité, allocations et réservations

| ID | Règle | Statut |
|---|---|---|
| BR-STK-010 | Chaque emplacement physique a un **mode de garde** : `EXCLUSIVE_USER` (stock mobile, utilisable hors ligne par son détenteur sur son appareil principal) ; `EXCLUSIVE_DEVICE` (ex. PDV mono-tablette, utilisable hors ligne par l'appareil désigné, quel que soit l'utilisateur autorisé connecté) ; `SHARED` (consommation hors ligne seulement via allocation). | D (CM §39 ; ADR-004) |
| BR-STK-011 | Disponible pour un consommateur C sur un emplacement `SHARED` = solde − réservations actives − allocations actives restantes des **autres** détenteurs. Pour le détenteur d'une allocation, il faut ajouter son propre reste d'allocation. | D |
| BR-STK-012 | Une allocation (`DEVICE_QUOTA`) est accordée en ligne à un couple (utilisateur, appareil) sur un emplacement `SHARED`, pour un produit et éventuellement un lot. À l'octroi, Σ allocations restantes + réservations ≤ solde. | C (CM §39) / AV-035 |
| BR-STK-013 | Toute opération qui réduit le stock (vente, perte, transfert sortant, consommation) faite par le détenteur d'une allocation sur l'emplacement alloué **consomme d'abord son allocation**. Hors ligne, l'appareil refuse toute consommation au-delà de son allocation ou du solde de son emplacement exclusif. | AV-025 |
| BR-STK-014 | Une allocation est libérée par l'appareil détenteur (libération confirmée à la synchronisation) ou révoquée par un responsable. Une révocation forcée est auditée ; toute consommation hors ligne ultérieure imputée à cette allocation est appliquée et ouvre le conflit `ALLOCATION_REVOKED_CONSUMED`. | AV-035 |
| BR-STK-015 | Une réservation (`ORDER_RESERVATION`) est créée par la confirmation d'une commande. Elle est consommée par la livraison et libérée par l'annulation ou la clôture du reliquat. Elle est transférée si un transfert préparé pour la commande est expédié (BR-VEN-010). | C (PM §6) / D |
| BR-STK-016 | Le stock d'un emplacement `EXCLUSIVE_USER` n'est utilisable hors ligne que sur l'**appareil principal** du détenteur. Le changement d'appareil principal se fait en ligne, après synchronisation complète de l'ancien appareil ou révocation explicite. | D (ADR-004) |
| BR-STK-017 | **En ligne**, aucune opération ne peut rendre négatif le disponible d'un emplacement physique (`INSUFFICIENT_STOCK`). | C (PM §6) |
| BR-STK-018 | Une opération **hors ligne** constatant un fait physique (vente, perte, consommation, transfert sortant) est appliquée même si le solde serveur devient négatif. Le conflit `STOCK_NEGATIVE` est alors ouvert, avec une alerte au responsable. Le solde négatif est une **anomalie à résoudre**, jamais un état normal. | D (C-08) |

### 7.3 Transferts

| ID | Règle | Statut |
|---|---|---|
| BR-STK-020 | Un transfert entre deux emplacements physiques distincts suit deux temps. **Expédition** : source → `V_TRANSIT`, par l'expéditeur, à l'heure réelle. **Réception** : `V_TRANSIT` → destination, pour la quantité réellement reçue, par le destinataire. | C (CM §22) |
| BR-STK-021 | Écart = quantité expédiée − quantité reçue. Un écart positif est déplacé de `V_TRANSIT` vers `V_PENDING_LOSS` avec la catégorie `ECART_TRANSFERT`, à justifier et valider. Une réception supérieure à l'expédition est refusée en ligne ; hors ligne, elle est appliquée et produit le conflit `TRANSFER_OVER_RECEIVED`. | C (CM §22 « différences ») / AV-082 |
| BR-STK-022 | Un déplacement interne immédiat (même site, même responsable, ex. case → case, bâtiment → magasin de ferme) est un transfert de type `INTERNAL`, sans passage par `V_TRANSIT`. | D |
| BR-STK-023 | L'**affectation de stock** à un commercial ou vendeur (CM §23) est un transfert vers son emplacement `MOBILE`. Il en est responsable jusqu'à vente, retour (transfert inverse), perte ou régularisation par inventaire. | C (CM §23) |
| BR-STK-024 | Une **réception sans document** (le transfert n'est pas encore téléchargé sur l'appareil destinataire) n'est permise que sur un emplacement exclusif. Elle déclare l'emplacement source et les quantités. Le serveur la rapproche du transfert expédié correspondant. Tant qu'aucun rapprochement n'a eu lieu, la quantité est imputée sur le transit non rapproché de la paire (source, destination) ; après 48 h, le conflit `TRANSFER_UNMATCHED` est ouvert. | D (CM §37, §39) |
| BR-STK-025 | Un transfert ne peut être annulé qu'avant expédition. Après expédition, seul un transfert retour le neutralise. | C (CM §41) |
| BR-STK-026 | Une demande de réapprovisionnement (`REQUESTED`) est satisfaite par l'expédition de l'emplacement fournisseur, qui peut expédier une quantité différente de la quantité demandée. | AV-081 |

### 7.4 Pertes et consommations

| ID | Règle | Statut |
|---|---|---|
| BR-STK-030 | Une déclaration de perte porte : catégorie (`MORTALITE`, `CASSE`, `DETERIORATION`, `IMPROPRE`, `DESTRUCTION`, `INEXPLIQUEE`, `VOL_SUSPECTE`, `ECART_TRANSFERT`), produit, lot, quantité, emplacement, `occurred_at`, déclarant, code motif, commentaire, pièces éventuelles. Une déclaration concerne **un seul produit**. | C (CM §24) / D (un produit) |
| BR-STK-031 | La politique de contrôle en vigueur (catégorie, quantité, valeur) détermine si une photo, un commentaire ou une validation sont requis. | C (CM §24, §42) / AV-037, AV-048 |
| BR-STK-032 | Perte **sans validation requise** : mouvement emplacement → `V_LOSS`, statut `RECORDED`. Perte **avec validation requise** : mouvement emplacement → `V_PENDING_LOSS` (la quantité n'est plus disponible), statut `PENDING_APPROVAL`. | D (ADR-003) |
| BR-STK-033 | Approbation : `V_PENDING_LOSS` → `V_LOSS`, statut `APPROVED`. Rejet, selon la décision : `ERREUR_DECLARATION` → retour `V_PENDING_LOSS` → emplacement (`REJECTED_RETURNED`) ; `PERTE_NON_JUSTIFIEE` → `V_PENDING_LOSS` → `V_LOSS`, catégorie reclassée `INEXPLIQUEE` et responsabilité imputée (`REJECTED_UNJUSTIFIED`). | AV-038 |
| BR-STK-034 | Une perte `RECORDED` ne peut être annulée que par une annulation soumise à validation (`inventory.loss.approve`), qui crée le mouvement inverse. | C (CM §41) |
| BR-STK-035 | La valeur d'une perte = quantité × coût unitaire figé sur le mouvement. Pour un produit biologique de lot, c'est une **valeur économique indicative** : le coût du lot n'est pas réduit, il est réparti sur les survivants (voir stratégie finance). | C (CM §16, §32) / AV-042 |
| BR-STK-036 | Une consommation déplace un intrant de son emplacement vers `V_CONSUMPTION` et l'impute à un objet de coût : lot de production, lot d'incubation, site ou PDV. La valeur est enregistrée au registre de coûts (D09). | C (CM §4 « coût d'un lot », §21) |

### 7.5 Inventaires

| ID | Règle | Statut |
|---|---|---|
| BR-STK-040 | Un inventaire porte sur **un emplacement**, pour tous les produits ou une sélection. Chaque ligne donne le produit (et le lot pour les produits à suivi obligatoire en élevage) et la quantité comptée. L'instant de référence est `counted_at`. | C (CM §25) |
| BR-STK-041 | L'activité **n'est pas bloquée** pendant un inventaire : la vérité physique est fixée à `counted_at`. | D (UX, offline) |
| BR-STK-042 | À la soumission, le serveur calcule le théorique à `counted_at` (BR-STK-005) et l'écart = compté − théorique. Un écart est toujours conservé et justifié par un code motif ; il n'est jamais masqué. | C (CM §25, §60) |
| BR-STK-043 | Si la valeur absolue totale des écarts est sous le seuil, l'inventaire est comptabilisé automatiquement ; sinon il passe `PENDING_APPROVAL`. La comptabilisation crée des mouvements d'ajustement (`V_ADJUSTMENT` ↔ emplacement) datés de `counted_at`. | C (CM §25) / AV-039 |
| BR-STK-044 | **Rapprochement tardif** : si un mouvement de `occurred_at` ≤ `counted_at` est appliqué **après** la comptabilisation, le serveur crée un ajustement compensatoire rattaché à l'inventaire (motif `RAPPROCHEMENT_INVENTAIRE`), afin que le solde à `counted_at` reste égal au compté, et met à jour l'écart net de l'inventaire. | D (offline ; INV-STK-09) |
| BR-STK-045 | Pour un produit à lot au point de vente, l'écart d'un produit compté sans lot est réparti sur les lots en FIFO inverse (les plus récents d'abord pour les gains, les plus anciens d'abord pour les pertes). | D |
| BR-STK-046 | Un inventaire d'ouverture (`OPENING`) a un théorique nul ; ses mouvements partent de `V_OPENING`, avec un coût unitaire déclaré. Un emplacement ne peut avoir qu'un inventaire d'ouverture comptabilisé. | D (AV-072) |

### 7.6 Lots, seuils, valorisation

| ID | Règle | Statut |
|---|---|---|
| BR-STK-050 | Pour un produit à suivi par lot `REQUIRED`, tout mouvement porte un lot. Pour `OPTIONAL`, le lot est porté s'il est connu. Pour `NONE`, jamais. Le lot est choisi automatiquement en FIFO (lot le plus ancien en solde positif) lors d'une sortie sans lot indiqué. | AV-036 |
| BR-STK-051 | Un seuil (minimum, cible) par emplacement × produit déclenche `STOCK_LOW` si disponible < minimum, et `STOCK_OUT` si disponible ≤ 0. La quantité suggérée de réapprovisionnement = cible − disponible − transit entrant. | C (CM §12, §54) / AV-040 |
| BR-STK-052 | Tout mouvement porte le coût unitaire en vigueur **au moment de son application** : CMUP courant du produit ; ou coût du lot par tête pour un produit biologique de lot ; ou coût standard pour une production interne sans lot ; ou coût d'achat pour une réception. Un mouvement inverse reprend le coût du mouvement d'origine. | AV-042 |
| BR-STK-053 | Le CMUP d'un produit est recalculé à chaque entrée valorisée (réception, ouverture, gain d'inventaire valorisé), selon l'**ordre d'application serveur**. | AV-042 |
| BR-STK-054 | La valeur d'un stock = Σ (solde × coût unitaire courant), par produit ou par produit × lot. Elle n'est visible qu'avec `inventory.stock_value.read`. | C (CM §48 « magasinier sans finance ») |

### 7.7 Table des types de mouvement

| Type (`move_type`) | Source → Destination | Document source | Statut |
|---|---|---|---|
| `OPENING_BALANCE` | `V_OPENING` → emplacement | Inventaire `OPENING` | D |
| `PURCHASE_RECEIPT` | `V_SUPPLIER` → emplacement | Réception (APP) | C (CM §28) |
| `SUPPLIER_RETURN` | emplacement → `V_SUPPLIER` | Retour fournisseur (extension) | D |
| `TRANSFER_DISPATCH` | emplacement → `V_TRANSIT` | Transfert | C (CM §22) |
| `TRANSFER_RECEIPT` | `V_TRANSIT` → emplacement | Transfert | C (CM §22) |
| `TRANSFER_DISCREPANCY` | `V_TRANSIT` → `V_PENDING_LOSS` | Transfert | C (CM §22) |
| `INTERNAL_MOVE` | emplacement → emplacement (même site) | Transfert `INTERNAL` | D |
| `SALE` | emplacement → `V_CUSTOMER` | Vente | C (CM §13) |
| `CUSTOMER_RETURN` | `V_CUSTOMER` → emplacement | Retour client (extension, AV-029) | D |
| `LOSS` | emplacement → `V_LOSS` | Perte `RECORDED` | C (CM §24) |
| `LOSS_PENDING` | emplacement → `V_PENDING_LOSS` | Perte `PENDING_APPROVAL` | D |
| `LOSS_CONFIRMATION` | `V_PENDING_LOSS` → `V_LOSS` | Perte approuvée ou rejet `PERTE_NON_JUSTIFIEE` | D |
| `LOSS_RELEASE` | `V_PENDING_LOSS` → emplacement | Rejet `ERREUR_DECLARATION` | D |
| `CONSUMPTION` | emplacement → `V_CONSUMPTION` | Consommation | C (CM §21) |
| `PRODUCTION_OUTPUT` | `V_PRODUCTION` → emplacement | Collecte d'œufs, éclosion, entrée de lot par naissance ou reclassement | C (CM §17, §18) |
| `PRODUCTION_INPUT` | emplacement → `V_PRODUCTION` | Œufs consommés à l'éclosion, reclassement de mise en place, transformation (extension) | D |
| `INVENTORY_GAIN` | `V_ADJUSTMENT` → emplacement | Inventaire | C (CM §25) |
| `INVENTORY_LOSS` | emplacement → `V_ADJUSTMENT` | Inventaire | C (CM §25) |

Tout mouvement peut avoir un inverse (`is_reversal = true`), qui porte le même type et échange source et destination.

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Quantité > 0 ; unité convertible vers l'unité de base ; entier pour les produits comptés | `QUANTITY_INVALID` |
| Couple source → destination autorisé pour le type (§7.7) | `MOVE_TYPE_INVALID` |
| Emplacements actifs ; source ≠ destination | `LOCATION_INVALID` |
| Lot requis présent et cohérent avec le produit | `LOT_REQUIRED`, `LOT_MISMATCH` |
| Disponibilité (BR-STK-017, en ligne) ; allocation (BR-STK-013, hors ligne) | `INSUFFICIENT_STOCK`, `ALLOCATION_EXCEEDED` |
| Réception ≤ expédié (BR-STK-021, en ligne) | `TRANSFER_OVER_RECEIVED` |
| Octroi d'allocation ≤ disponible | `ALLOCATION_EXCEEDS_AVAILABLE` |
| Photo requise présente (référence de pièce) | `ATTACHMENT_REQUIRED` |
| Commentaire requis pour `INEXPLIQUEE` et `VOL_SUSPECTE` | `COMMENT_REQUIRED` |
| Un seul inventaire ouvert à la fois par emplacement | `COUNT_ALREADY_OPEN` |

## 9. Dépendances

- **Dépend de** : ADM (emplacements, RBAC, validations, pièces), CAT (produits, unités, suivi par lot), FIN (enregistrement des coûts au registre de coûts).
- **Utilisé par** : VEN, APP, PRD, DIS, FIN (valorisation, coût des ventes), ANA, NOT.
- **Règle de frontière** : seul `inventory` écrit dans ses tables. Les autres modules appellent son API interne (`recordMoves`, `reserve`, `consumeAllocation`…), dans la **même transaction** que leur propre document (ADR-011).

## 10. Événements produits

`StockTransferRequested`, `StockTransferDispatched`, `StockTransferReceived`, `StockTransferDiscrepancyDetected`, `StockTransferDiscrepancyResolved`, `StockTransferCancelled`, `StockTransferUnmatched`, `StockAllocated`, `StockAllocationReleased`, `StockAllocationRevoked`, `StockReservationChanged`, `StockLossDeclared`, `StockLossApproved`, `StockLossRejected`, `ConsumptionRecorded`, `InventoryCountOpened`, `InventoryCountSubmitted`, `InventoryAdjusted`, `InventoryCountReconciled`, `StockThresholdBreached`, `StockNegativeDetected`, `ProductValuationChanged`.

Les mouvements eux-mêmes ne sont pas publiés un par un comme événements métier : le registre **est** la source. Les projections se mettent à jour dans la transaction.

## 11. Événements consommés

| Événement | Producteur | Réaction |
|---|---|---|
| `ApprovalGranted` / `ApprovalRejected` (types `LOSS_DECLARATION`, `MORTALITY`, `INVENTORY_ADJUSTMENT`, `TRANSFER_DISCREPANCY`, `LOSS_CANCELLATION`) | ADM | Mouvements de confirmation, de libération ou d'ajustement |
| `OrderConfirmed`, `OrderUpdated`, `OrderCancelled`, `OrderClosed` | VEN | Appels synchrones à l'API de réservation dans la transaction de VEN ; aucune réaction asynchrone |
| `UserDeactivated` | ADM | Alerte : stock mobile et allocations de l'utilisateur à régulariser (pas de mouvement automatique) |
| `DeviceBlocked`, `DeviceDeclaredLost` | ADM | Allocations de l'appareil marquées `REVOCATION_PENDING` ; décision du responsable |

## 12. Fonctionnement hors ligne

| Élément | Comportement |
|---|---|
| Données locales | Soldes et lots des emplacements du périmètre ; allocations et réservations propres ; transferts entrants et sortants ouverts ; inventaires ouverts ; seuils ; motifs ; politiques de contrôle. |
| Consommation locale | L'appareil tient un **solde local** = solde téléchargé + opérations locales en attente. Il refuse de dépasser l'allocation ou le solde exclusif (BR-STK-013). |
| Expédition, réception, perte, consommation, comptage | Possibles hors ligne ; commandes idempotentes. |
| Octroi et révocation d'allocation, validation | En ligne uniquement. |
| Lot | Le lot FIFO proposé localement est **indicatif** ; le serveur recalcule sur son état. Si le lot local n'a plus de solde, le serveur applique le FIFO serveur et conserve le lot local dans `client_lot_hint`. |
| Coût | Toujours déterminé par le serveur (jamais transmis par le client). |

## 13. Permissions

`inventory.stock.read`, `inventory.stock_value.read`, `inventory.ledger.read`, `inventory.transfer.request`, `inventory.transfer.dispatch`, `inventory.transfer.receive`, `inventory.transfer.cancel`, `inventory.transfer_discrepancy.approve`, `inventory.allocation.manage`, `inventory.loss.declare`, `inventory.loss.approve`, `inventory.count.perform`, `inventory.count.approve`, `inventory.consumption.record`, `inventory.threshold.manage`, `inventory.opening.post`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Deux ventes hors ligne dépassent le stock partagé (allocations contournées ou absentes) | BR-STK-018 : conflit `STOCK_NEGATIVE`, résolution par inventaire ou rapprochement. |
| Transfert expédié hors ligne et reçu avant la synchronisation de l'expédition | BR-STK-024 : transit non rapproché, rapprochement automatique quand l'expédition arrive. |
| Appareil perdu détenant des allocations | Révocation par le responsable ; les quantités restent physiquement là où elles sont ; inventaire recommandé. |
| Perte déclarée sur un lot clôturé | Refusée (`LOT_CLOSED`) : un lot clôturé a un effectif nul. |
| Inventaire comptabilisé puis ventes tardives antérieures | BR-STK-044 (rapprochement tardif). |
| Emplacement désactivé avec des mouvements hors ligne en attente | Mouvements appliqués (fait physique), conflit `LOCATION_INACTIVE` pour revue. |
