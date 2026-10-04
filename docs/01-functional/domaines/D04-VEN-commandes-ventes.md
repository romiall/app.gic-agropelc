# D04 — Commandes et ventes (VEN)

> Couvre : commandes clients, réservations, livraison (vente sur commande), ventes directes, prix appliqués, attribution commerciale, encaissement intégré à la vente, annulation.
> Module de code : `sales`. Le module `sales` possède aussi les encaissements clients, leurs affectations et les créances (règles fonctionnelles en D09 §7.1). Il appelle `finance` pour le mouvement de trésorerie correspondant. Les mouvements de stock sont **créés** par le module `inventory` (D06) à la demande de `sales`.

> **Décisions du 27/09/2026 à reporter au démarrage de P4** : AV-024 est tranchée par [ADR-025](../../decisions/ADR-025-vente-a-la-confirmation.md) — la vente et le CA naissent à la **confirmation** de la commande, la marchandise passe dans un emplacement « vendu, à livrer » puis sort vers le client à la livraison. Les règles ci-dessous écrites sur la base d'ADR-014 (vente à la remise, notamment BR-VEN-006) seront réécrites dans le même commit que leur implémentation. AV-025 est tranchée : vente hors ligne bloquée au-delà de l'allocation (BR-VEN-018 inchangée).

---

## 1. Objectif

Enregistrer chaque vente une seule fois, là où elle a lieu, même sans réseau, et lui donner automatiquement tous ses effets (CM §13, §32) :

- sortie de stock du bon emplacement (et du bon lot) ;
- chiffre d'affaires daté de l'heure réelle ;
- encaissement ou créance ;
- attribution au vendeur et au commercial ;
- conversion du prospect ;
- mise à jour des tableaux de bord.

Suivre les commandes clients de la prise de commande à la livraison.

Sources : CM §4, §7, §11, §13, §30, §32, §38, §39, §41 ; PM §9, §24.

## 2. Acteurs

`VENDEUR_PDV`, `COMMERCIAL_TERRAIN`, `COMMERCIAL_SEDENTAIRE`, `RESP_COMMERCIAL`, `RESP_FERME` (vente à la ferme), `MAGASINIER` (préparation et livraison), `FINANCE` (lecture, créances), `DIRECTION`, `system`.

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Commande client | `sales.sales_orders` | Engagement du client |
| Ligne de commande | `sales.sales_order_lines` | Produit, quantité, prix convenu, quantité livrée |
| Réservation | `inventory.stock_allocations` (type `ORDER_RESERVATION`) | Stock bloqué pour la commande (propriété de D06) |
| Vente | `sales.sales` | Remise de produits contre un prix (directe ou sur commande) |
| Ligne de vente | `sales.sale_lines` | Produit, lot, quantité, prix figé, règle, coût figé |
| Encaissement, affectation | `sales.customer_payments`, `sales.payment_allocations` | Module `sales` ; règles fonctionnelles D09 §7.1 |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-VEN-01 | + NOUVELLE VENTE (vente directe, encaissement intégré) | `sales.sale.record` | VENDEUR_PDV, commerciaux, RESP_FERME | **Oui** |
| UC-VEN-02 | + NOUVELLE COMMANDE | `sales.order.place` | Commerciaux | **Oui** |
| UC-VEN-03 | Enregistrer une commande en brouillon (préparation au bureau) | `sales.order.save_draft` | COMMERCIAL_SEDENTAIRE | Non |
| UC-VEN-04 | Modifier une commande non livrée | `sales.order.update` | Auteur, RESP_COMMERCIAL | **Oui** (conflit possible) |
| UC-VEN-05 | Annuler une commande ou son reliquat | `sales.order.cancel`, `sales.order.close_remaining` | Auteur, RESP_COMMERCIAL | **Oui** |
| UC-VEN-06 | LIVRER une commande (totalement ou partiellement), ce qui crée la vente | `sales.order.fulfil` | Commerciaux, MAGASINIER | **Oui** (si stock détenu) |
| UC-VEN-07 | Demander l'annulation d'une vente ; annuler directement dans le délai | `sales.sale.request_cancellation`, `sales.sale.cancel` | Vendeur, responsables | **Oui** (demande) |
| UC-VEN-08 | Approuver ou rejeter une annulation | `approvals.request.approve` / `reject` | Responsable PDV, RESP_COMMERCIAL | Non |
| UC-VEN-09 | Appliquer une dérogation de prix | inclus dans `sales.sale.record` (ligne `price_source = MANUAL_OVERRIDE`) | Titulaires de `sales.price.override` | **Oui** (dans le plafond) |
| UC-VEN-10 | Consulter ventes, commandes, reçu | requête | Selon portée | Partiel |

## 5. Entrées

- Contexte (préremplis) : utilisateur, appareil, site ou emplacement source, session de travail ou de caisse, heure, position.
- Saisie : client (optionnel pour une vente comptant, AV-027), produits, quantités, poids éventuel (AV-031), paiements (moyen, montant, référence).
- Règles tarifaires en vigueur (D10), allocations et soldes (D06), titulaire du client (D02).

## 6. Sorties

- Documents `sales_orders` et `sales` numérotés.
- Mouvements de stock vers `V_CUSTOMER` (D06).
- Encaissements et affectations (D09).
- CA, créances, attribution commerciale.
- Événements pour CRM (conversion), NOT (alertes), ANA, KOM.

## 7. Règles métier

### 7.1 Commandes

| ID | Règle | Statut |
|---|---|---|
| BR-VEN-001 | Une commande client exige un client identifié (pas de commande anonyme). | D (CM §7 « commandes » liées au prospect ou client) |
| BR-VEN-002 | Une commande passe à `CONFIRMED` par `sales.order.place` (engagement du client). L'état `DRAFT` n'existe côté serveur que pour une préparation au bureau. Sur l'appareil, un brouillon reste `LOCAL_ONLY`. | D |
| BR-VEN-003 | Chaque ligne de commande fige un prix convenu (`quoted_unit_price_xaf`) résolu par le moteur de tarification au moment de la confirmation, avec la règle et sa version. | C (CM §30) / D |
| BR-VEN-004 | À la confirmation, le serveur tente de **réserver** la quantité sur l'emplacement de préparation (`fulfilment_location_id`). Si le disponible est insuffisant, la commande reste `CONFIRMED` avec un statut de réservation `PARTIAL` ou `NONE` et une alerte au magasinier. La commande n'est jamais refusée pour manque de stock : elle représente un engagement du client. | C (PM §6) / D |
| BR-VEN-005 | Une commande n'est modifiable (quantités, produits, date, lieu) que tant qu'aucune livraison n'a eu lieu. Toute modification contrôle la version (concurrence optimiste) et recalcule la réservation. | D (PM §30 « commande modifiée ») |
| BR-VEN-006 | Livrer une commande crée une **vente de type `ORDER_FULFILMENT`** portant la référence de la commande, le livreur, l'heure réelle de remise et les quantités remises. Une livraison partielle crée une vente partielle et fait passer la commande à `PARTIALLY_FULFILLED`. | AV-024, AV-034 |
| BR-VEN-007 | À la livraison, le prix appliqué est le **prix convenu** de la ligne de commande (`price_source = ORDER_QUOTE`). | AV-087 |
| BR-VEN-008 | La quantité livrée cumulée d'une ligne ne peut pas dépasser la quantité commandée. Une remise supplémentaire est une vente directe distincte. | D (INV-VEN-04) |
| BR-VEN-009 | L'annulation d'une commande (avant toute livraison) ou la clôture de son reliquat libère les réservations correspondantes. Les acomptes deviennent un crédit client non affecté, ou sont remboursés sur décision. | D / AV-033 |
| BR-VEN-010 | Un transfert préparé pour une commande (ex. vers le stock mobile du livreur) référence la commande ; son expédition **transfère** la réservation de l'emplacement source vers l'emplacement de destination. | D (ADR-004) |

### 7.2 Ventes

| ID | Règle | Statut |
|---|---|---|
| BR-VEN-011 | Une vente naît à l'état `CONFIRMED` : elle représente un fait accompli (produits remis). Aucune vente « brouillon » n'est synchronisée ; un panier en cours reste local. | D (C-05) |
| BR-VEN-012 | Une vente confirmée est **immuable**. Toute correction passe par une annulation (contre-écriture), suivie si besoin d'une nouvelle vente. | C (CM §41 ; PM §8) |
| BR-VEN-013 | Chaque ligne de vente fige : produit (et son libellé), lot, quantité en unité de saisie et en unité de base, quantité de tarification (poids éventuel), prix catalogue résolu, prix appliqué, règle tarifaire et version, source du prix (`RULE`, `ORDER_QUOTE`, `MANUAL_OVERRIDE`), remise, montant de ligne, coût unitaire (renseigné par le serveur à l'application). | C (CM §30 ; PM §9) |
| BR-VEN-014 | Le montant de ligne est l'arrondi au franc (demi supérieur) de quantité de tarification × prix appliqué − remise. Le total de la vente est la somme des lignes. | AV-060 |
| BR-VEN-015 | Une dérogation de prix exige la permission `sales.price.override`. Elle doit rester dans le plafond de remise du rôle et porter un code motif (`PRICE_OVERRIDE`). Au-delà du plafond, la ligne est enregistrée et une validation a posteriori est demandée ; l'anomalie reste ouverte jusqu'à la décision. | AV-026 |
| BR-VEN-016 | Les **effets stock** d'une vente sont des mouvements de l'emplacement source vers `V_CUSTOMER`, un par ligne et par lot. Le lot est choisi **automatiquement** en FIFO parmi les lots en solde positif dans l'emplacement. | C (CM §13) / AV-036 |
| BR-VEN-017 | Emplacement source d'une vente directe : l'emplacement de vente du PDV pour un vendeur ; le stock mobile pour un commercial ; l'emplacement d'élevage pour une vente à la ferme, autorisée seulement si le lot est à l'état `SELLING`. | C (CM §23) / D |
| BR-VEN-018 | **En ligne**, une vente n'est acceptée que si la quantité est disponible pour le vendeur : solde − réservations − allocations d'autres détenteurs + sa propre allocation. **Hors ligne**, l'appareil bloque au-delà de son allocation ou du solde de son emplacement exclusif. | C (CM §39) / AV-025 |
| BR-VEN-019 | Une vente hors ligne réellement effectuée est **toujours appliquée** à la synchronisation, même si le solde serveur est insuffisant. Dans ce cas, le conflit `STOCK_NEGATIVE` est ouvert pour régularisation. Elle n'est jamais rejetée pour motif de stock. | D (C-08 ; INV-STK-05) |
| BR-VEN-020 | **Attribution** figée sur chaque vente. `seller_user_id` = l'utilisateur qui enregistre. `commercial_user_id` = pour une vente sur commande, le commercial de la commande ; pour une vente directe, le titulaire du client à `occurred_at`, à défaut le vendeur s'il a un rôle commercial, à défaut vide (vente de PDV). | C (CM §8, §13) / D |
| BR-VEN-021 | Le canal (`channel_code`) est déduit du contexte : vente de PDV → `POINT_DE_VENTE` ; commercial terrain en session → `TERRAIN` ; commercial sédentaire → `SEDENTAIRE` ; commande d'origine Kommo → `KOMMO`. Le vendeur peut le corriger parmi les canaux autorisés. | C (CM §11) / D |
| BR-VEN-022 | La zone de la vente (`zone_id`) est figée : zone du site pour une vente en PDV, zone du client sinon, à défaut zone de la session de travail. | C (PM §7) / D |
| BR-VEN-023 | Les paiements saisis avec la vente créent des encaissements affectés à la vente, dans la même transaction. Le reste dû constitue une créance, avec échéance = `occurred_at` + délai de paiement du client. | C (CM §13) / AV-028 |
| BR-VEN-024 | Une vente anonyme (sans client) doit être intégralement payée à l'enregistrement. | AV-027 |
| BR-VEN-025 | Une vente à crédit exige un client autorisé au crédit, avec un encours après vente ≤ plafond. Hors ligne, le contrôle porte sur l'encours connu localement. Un dépassement exige `sales.credit_limit_exceed.approve` : en ligne, la vente est bloquée ; hors ligne, elle est appliquée et une validation a posteriori est ouverte. | AV-028 |
| BR-VEN-026 | Le statut de paiement (`UNPAID`, `PARTIALLY_PAID`, `PAID`) est **dérivé** des affectations actives de paiement et n'est jamais saisi. | D (C-05) |
| BR-VEN-027 | Annuler une vente produit : les mouvements inverses (de `V_CUSTOMER` vers l'emplacement d'origine, même lot, même coût unitaire) ; la restitution de la consommation d'allocation si le quota est encore actif, sinon le retour au stock commun ; la reprise des affectations de paiement. Le montant payé est remboursé (mouvement de caisse `REFUND`) ou conservé comme crédit client non affecté, au choix de l'approbateur. | C (CM §41) / D |
| BR-VEN-028 | L'annulation directe (sans validation) n'est permise qu'au vendeur de la vente, moins de 15 minutes après `occurred_at`, et si la session de caisse de la vente est encore ouverte. Dans tous les autres cas, une demande d'annulation soumise à validation est nécessaire. | AV-030 |
| BR-VEN-029 | Pour une vente hors ligne, si le prix figé diffère du prix que le serveur aurait résolu à `occurred_at` avec les règles alors actives, la vente est appliquée telle quelle et l'anomalie `PRICE_MISMATCH` est ouverte. | AV-063 |
| BR-VEN-030 | Une vente d'un produit désactivé est acceptée si elle a été capturée hors ligne avant la réception de la désactivation, avec une anomalie ; en ligne, elle est refusée. | AV-083 |
| BR-VEN-031 | Une ligne de produit de type `SERVICE` (ex. frais de livraison) n'a aucun effet de stock. | AV-085 |
| BR-VEN-032 | Taxes : les colonnes de taxe existent avec un taux de 0 ; les prix sont TTC. | AV-041 |

## 8. Validations

| Contrôle | Moment | Erreur |
|---|---|---|
| Au moins une ligne ; quantités > 0 ; entier pour les produits comptés à l'unité | Appareil + serveur | `LINE_INVALID` |
| Produit actif et vendable (sauf BR-VEN-030) | Appareil + serveur | `PRODUCT_NOT_SELLABLE` |
| Emplacement source autorisé pour le vendeur (portée) | Serveur | `FORBIDDEN_SCOPE` |
| Disponibilité (BR-VEN-018) | Appareil (hors ligne) / serveur (en ligne) | `INSUFFICIENT_STOCK`, `ALLOCATION_EXCEEDED` |
| Σ paiements ≤ total ; paiement intégral si anonyme | Appareil + serveur | `PAYMENT_EXCEEDS_TOTAL`, `ANONYMOUS_REQUIRES_FULL_PAYMENT` |
| Référence de mobile money unique par moyen de paiement | Serveur | `PAYMENT_REFERENCE_DUPLICATE` (conflit) |
| Crédit (BR-VEN-025) | Appareil + serveur | `CREDIT_NOT_ALLOWED`, `CREDIT_LIMIT_EXCEEDED` |
| Plafond de dérogation (BR-VEN-015) | Appareil + serveur | `PRICE_OVERRIDE_EXCEEDS_LIMIT` (validation) |
| Livraison ≤ reliquat (BR-VEN-008) | Serveur | `ORDER_OVER_FULFILMENT` |
| Version de la commande (BR-VEN-005) | Serveur | `VERSION_CONFLICT` |

## 9. Dépendances

- **Dépend de** : ADM, CRM (client, titulaire, crédit), PRX (résolution du prix), STK (disponibilité, mouvements, allocations, réservations), FIN (encaissements, sessions de caisse), TER (session de travail).
- **Utilisé par** : CRM (conversion, dernière vente), FIN (créances), ANA, KOM, NOT.

## 10. Événements produits

`OrderDrafted`, `OrderConfirmed`, `OrderUpdated`, `OrderCancelled`, `OrderPartiallyFulfilled`, `OrderFulfilled`, `OrderClosed`, `SaleConfirmed`, `SaleCancellationRequested`, `SaleCancelled`, `PriceOverrideApplied`, `PriceMismatchDetected`, `CreditLimitExceeded`.

## 11. Événements consommés

| Événement | Producteur | Réaction |
|---|---|---|
| `PaymentAllocated`, `PaymentCancelled` | FIN | Recalcul de `payment_status`, `amount_paid_xaf`, `balance_due_xaf` |
| `ApprovalGranted` / `ApprovalRejected` (types `SALE_CANCELLATION`, `PRICE_OVERRIDE`, `CREDIT_LIMIT_EXCEEDED`) | ADM | Exécution de l'annulation, ou clôture de l'anomalie |
| `StockReservationChanged` | STK | Mise à jour du statut de réservation de la commande |
| `CustomerMerged` | CRM | Les lectures suivent la chaîne de fusion ; aucune réécriture |

## 12. Fonctionnement hors ligne

| Élément | Comportement |
|---|---|
| Données locales | Règles tarifaires applicables au périmètre, produits vendables, soldes et allocations de l'utilisateur, clients du périmètre et leur encours, commandes ouvertes du périmètre, ventes des 7 derniers jours de l'utilisateur ou du PDV. |
| Vente | Prix résolu localement avec le même moteur que le serveur (code partagé, ADR-021) ; lot FIFO choisi localement à titre indicatif ; allocation décrémentée localement ; encaissement créé localement ; reçu affiché avec la référence locale. |
| Commande | Créée avec son UUID ; la réservation n'est effective qu'à la synchronisation. |
| Livraison | Possible hors ligne depuis un emplacement exclusif (stock mobile du livreur) ou dans la limite de la réservation téléchargée. |
| Annulation | Possible hors ligne (demande, ou annulation directe dans le délai BR-VEN-028). |
| Recalculs serveur | Coût unitaire, lot définitif (FIFO sur l'état serveur), attribution, conversion, numéro officiel. Le prix appliqué n'est **jamais** recalculé (BR-VEN-029). |

## 13. Permissions

`sales.order.read`, `sales.order.create`, `sales.order.cancel`, `sales.order.fulfil`, `sales.sale.read`, `sales.sale.record`, `sales.sale.cancel`, `sales.sale_cancel.approve`, `sales.price.override`, `sales.price_override.approve`, `sales.credit_sale.record`, `sales.credit_limit_exceed.approve`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Deux appareils livrent la même commande hors ligne | La première livraison appliquée est rattachée à la commande. Au-delà du reliquat, la seconde est appliquée comme **vente directe** (le fait physique existe), avec le conflit `ORDER_OVER_FULFILMENT` pour revue. |
| Stock insuffisant à la synchronisation | BR-VEN-019 : conflit `STOCK_NEGATIVE`, alerte au responsable du site, régularisation par inventaire ou par transfert manquant. |
| Client fusionné entre la saisie et la synchronisation | La vente est appliquée sur l'identifiant d'origine ; les lectures suivent la fusion. |
| Paiement mobile money en double (même référence) | Second encaissement mis en `SUSPECT_DUPLICATE`, non affecté ; la vente reste avec un reste dû ; validation Finance (D09). |
| Session de caisse fermée entre la vente et la synchronisation | La vente est rattachée à la session couvrant `occurred_at`. Si cette session est déjà validée, un écart de caisse complémentaire est ouvert (D05). |
| Vendeur désactivé | BR-ADM-002. |

## 15. Choix d'implémentation (P4)

Précisions retenues par le module `sales`, son schéma (migrations `20261003090100` à `20261003090700`) et la bibliothèque partagée (`packages/domain/src/sales.ts`) là où les règles laissent un choix ; toutes **DÉDUITES**, sans effet sur les règles confirmées ni sur les décisions du porteur du projet du 30/09/2026 (A-VALIDER §3, [ADR-028](../../decisions/ADR-028-commande-vente-livraison-p4.md)).

| Point | Choix | Justification |
|---|---|---|
| Quantité de tarification (P4-01) | À l'unité : la quantité en unité de base (poids facultatif, informatif) ; au poids : le poids pesé en kg, obligatoire (`WEIGHT_REQUIRED`). | BR-VEN-013, BR-CAT-009 ; décision AV-031. |
| Remise en pourcentage (P4-01) | Convertie en XAF sur le montant de la ligne, arrondie au franc (demi supérieur) ; deux décimales au plus. | AV-060 ne couvre que le montant de ligne. |
| Mesure d'une dérogation (P4-01) | Toute ligne dont le montant diffère du montant au prix catalogue est une dérogation (`sales.price.override` exigée). La remise se mesure sur le montant au prix catalogue, en points de base arrondis au supérieur (5,001 % dépasse 5 %) ; un prix supérieur au catalogue est une dérogation sans remise ; sans prix catalogue (`PRICE_NOT_FOUND`), la dérogation part en validation `PRICE_OVERRIDE`. | BR-VEN-015, BR-PRX-009 ; décision AV-026. |
| Plafond d'un utilisateur à plusieurs rôles (P4-01) | Le plus élevé des plafonds des rôles qui accordent `sales.price.override` ; un rôle qui l'accorde sans plafond compte pour 0 %. | RC-06 ; point relevé par la cartographie de P4 (deux sources de plafond). |
| Crédit sans plafond défini (P4-01) | Un client autorisé au crédit mais sans plafond renseigné : tout crédit dépasse (validation). | Prudence ; AV-028. |
| Référence de paiement (P4-01) | Unicité (moyen, référence) sur la forme normalisée : espaces retirés, majuscules. | INV-FIN-03 ; décision AV-056. |
| Doublon probable sans référence (P4-01) | Même client, même montant, écart au plus égal au paramètre `sales.duplicate_payment_window_minutes` (10 min par défaut). | Matrice des conflits ; règle 8 (seuil paramétré). |
| Annulation partielle (P4-01) | Montant annulé d'une ligne au prorata de la quantité en unité de base, arrondi au franc (demi supérieur) ; la dernière annulation de la ligne emporte le reste exact. | ADR-028 §5 ; somme des annulations = montant de la ligne. |
| Ancienneté d'une créance (P4-01) | Jours de retard = jours après l'échéance (0 avant) ; tranches 0-30, 31-60, 61-90, > 90 sur les jours de retard. | BR-FIN-007 ; dictionnaire `sales.v_receivables`. |
| Baisse d'une commande confirmée (P4-01) | La baisse retire d'abord la part en attente (aucun mouvement), puis annule par contre-écriture la part vendue non livrée ; jamais sous le livré (`ORDER_QUANTITY_BELOW_DELIVERED`). | Décision AV-130 ; moins de contre-écritures. |
| Statut d'une commande (P4-01) | Dérivé des lignes : `CONFIRMED` ou `PARTIALLY_FULFILLED` tant qu'il reste de l'attente ou du non-livré ; ensuite `CANCELLED` si rien n'a été livré, `CLOSED` si le reste a été annulé, sinon `FULFILLED`. | SM-ORDER réécrite par ADR-028. |
| Quantités d'une ligne de commande (P4-02) | Pas de statut de ligne. La ligne porte quatre quantités en unité de base : `quantity_base` (commandé en vigueur, après ajustements), `withdrawn_quantity_base` (cumul retiré, pour la traçabilité), `sold_quantity_base` (vendu net des annulations) et `delivered_quantity_base` (livré), sous le `CHECK` 0 ≤ livré ≤ vendu ≤ commandé. « En attente » (commandé − vendu) et « à livrer » (vendu − livré) se dérivent. Une ligne entièrement retirée a un commandé nul (`quantity` et `quantity_base` ≥ 0). Produit, unité et prix convenu sont figés par déclencheur ; le livré et le retiré ne diminuent jamais. | INV-VEN-04 ; décision AV-130 ; ADR-028 §4 et §5 ; mêmes quantités que `SalesOrderLineQuantities`. Un statut stocké dupliquerait les quantités et pourrait les contredire ; le statut de la commande se dérive déjà des lignes (ligne précédente de P4-01). |
| Clôture du reliquat (P4-02) | `closed_at`, `closed_by` et `closed_reason` sur la commande ; les deux premiers sont renseignés si et seulement si le statut est `CLOSED` (`CHECK`), comme les colonnes d'annulation pour `CANCELLED`. `CLOSED` : le reste d'une commande déjà en partie livrée a été annulé ; `CANCELLED` : la commande a été annulée avant toute livraison. `FULFILLED`, `CLOSED` et `CANCELLED` sont terminaux (déclencheur). | Décision AV-128 ; SM-ORDER réécrite par ADR-028 ; colonnes d'annulation du bloc `[STD-CANCEL]` des conventions. |
| Type d'une vente (P4-02) | `sale_type` vaut `DIRECT` ou `ORDER` (et non `ORDER_FULFILMENT`). Une vente `ORDER` naît à la confirmation de la commande, une vente par confirmation : elle porte `order_id` et `to_deliver_location_id` (l'emplacement « à livrer » du site, `V_TO_DELIVER`). Une vente `DIRECT` n'a ni l'un ni l'autre (`CHECK`). `from_location_id` reste l'emplacement de préparation ou de vente. | ADR-028 §4 ; `ORDER_FULFILMENT` supposait une vente créée à la livraison (ADR-014, remplacé). |
| Montants dérivés d'une vente (P4-02) | `net_total_xaf` (total − annulé), `balance_due_xaf` (net − payé) et `payment_status` sont des colonnes générées stockées ; `amount_paid_xaf` (somme des affectations actives) est mis à jour dans la transaction qui affecte ou renverse un paiement. `payment_status` vaut `PAID` si le solde est nul (y compris un net nul après annulation totale), sinon `UNPAID` si rien n'est payé, sinon `PARTIALLY_PAID`. `CHECK` : payé ≤ net. Aucun `CHECK` sur le solde d'une vente sans client : INV-VEN-07 se vérifie à l'enregistrement en ligne ; une vente anonyme saisie hors ligne est un fait accompli (AV-137). | BR-VEN-026, INV-VEN-06, INV-VEN-07 ; mêmes règles et même ordre de test que `saleBalances` ; un statut qu'on ne saisit pas ne peut pas contredire les montants. |
| Montant annulé et compteurs de ligne (P4-02) | La vente reste immuable : elle ne porte que `cancelled_xaf`, borné par le total et jamais décroissant (déclencheur). Chaque ligne de vente porte `cancelled_quantity_base`, `cancelled_xaf` et `delivered_quantity_base`, jamais décroissants, sous les `CHECK` : annulé ≤ quantité ; livré ≤ quantité − annulé ; montant annulé ≤ montant de la ligne, et égal à ce montant dès que la quantité est entièrement annulée. `CANCELLED` exige `cancelled_xaf = total_xaf` et ne se quitte plus. L'égalité entre le montant annulé de la vente et la somme de ses lignes n'est pas une contrainte inter-lignes : elle est tenue par la transaction de `sales`. | INV-VEN-02 ; ADR-028 §5 ; `lineCancellationAmountXaf` (la dernière annulation d'une ligne emporte le reste exact) ; ADR-006. |
| Coût figé d'une ligne de vente (P4-02) | `cost_xaf` d'une ligne = somme des valeurs figées des mouvements `SALE` de la ligne (un par lot en cas de répartition FIFO), jamais quantité × `unit_cost_xaf` arrondi. Les colonnes de coût sont nulles tant que le serveur ne les a pas renseignées (vente saisie hors ligne), puis ne changent plus (déclencheur). Le coût est brut : le net des annulations et des livraisons se lit par `soldGoodsPosition`. | ADR-027 (la dernière sortie d'un lot biologique emporte le reliquat, sans dérive d'un franc) ; ADR-025 §4 (coût figé à la vente) ; ADR-029 §7. |
| Document d'annulation (P4-02) | Toute annulation, totale ou partielle, est un document `sales_sale_cancellations` (numéro `ANV`) avec ses lignes (`sale_line_id`, quantité en unité de base, montant), les lignes étant en ajout seul. Statut `REQUESTED` (en attente de validation), `APPLIED` ou `REJECTED`, sans autre changement une fois `REQUESTED` quitté ; `applied_at` est l'heure métier de l'effet sur le chiffre d'affaires et le stock, renseignée si et seulement si `APPLIED` (`CHECK`), distincte de `occurred_at` (saisie ou demande). Cause : `SALE_CANCELLATION` (annulation d'une vente), `ORDER_CANCELLATION` (commande annulée avant livraison), `ORDER_CLOSURE` (reliquat clos), `ORDER_ADJUSTMENT` (baisse d'une commande confirmée). `released_payment_treatment` (`CUSTOMER_CREDIT` ou `REFUND`) fixe le sort de la part payée libérée, nul tant qu'aucune part n'est libérée. Une demande rejetée n'a aucun effet. | ADR-028 §5 (diminution du chiffre d'affaires « à sa propre heure métier ») ; AV-128 et AV-130 ; BR-VEN-027 ; chiffre d'affaires d'une période = Σ ventes − Σ annulations, chacune à son heure. |
| Unicité de `command_id` (P4-02) | `UNIQUE (command_id)` sur les commandes, les ventes et les bons de livraison : une commande de synchronisation en crée au plus un. `UNIQUE (command_id, sale_id)` sur les annulations ; index simple, non unique, sur les encaissements et les affectations : une modification de commande ou une annulation du reliquat peut toucher plusieurs ventes d'une même commande (un document d'annulation par vente), et une vente enregistrée en une commande crée un encaissement par moyen de paiement. | Le dictionnaire `sales` posait `UNIQUE (command_id)` sur les commandes, les ventes et les encaissements : pour les encaissements (BR-VEN-023) et les annulations, il bloquerait ces cas. L'unicité reste un filet là où une commande crée exactement un document ; sur les annulations, `UNIQUE (command_id, sale_id)` (au plus un document par vente et par commande) protège d'un rejeu hors du chemin `sync.command_inbox` (relecture P4-02). |
| Bon de livraison (P4-02) | Le bon (`sales_delivery_notes`, numéro `LIV`) et ses lignes (`order_line_id`, `sale_line_id`, quantité > 0, une ligne par ligne de vente et par bon) sont en ajout seul : aucun statut, aucune modification, aucune suppression (déclencheurs ; droits `SELECT` et `INSERT`). Pas de correction d'un bon en V1 : seul le non-livré s'annule. Le plafond de livraison n'est pas un `CHECK` du bon : il est tenu par les compteurs `delivered_quantity_base` des lignes de vente et de commande et par le mouvement `DELIVERY` rattaché à son `SALE` (INV-STK-17). | ADR-028 §7 ; défauts d'AV-134 (option a) et d'AV-029 (retour de marchandise livrée hors MVP) ; ajouter plus tard un statut ou une reprise ne casse pas cette structure. |
| Unicité de la référence d'un encaissement (P4-02) | `reference_normalized` (calculée par `normalizePaymentReference` : espaces retirés, majuscules) est conservée à côté de la référence saisie. L'unicité porte sur `reference_key` = « moyen:référence normalisée », colonne générée non nulle seulement pour les statuts `RECORDED` et `CANCELLATION_REQUESTED` : un encaissement `SUSPECT_DUPLICATE`, `REJECTED` ou `CANCELLED` ne la compte pas, et un encaissement annulé libère sa référence. | INV-FIN-03 (précisé dans le même commit, il ne citait que `RECORDED`) ; décision AV-056 ; conventions §4 (unicité partielle par colonne générée) ; précédent `posted_note_key` des réceptions. |
| Encaissement suspect (P4-02) | `duplicate_of_payment_id` (clé étrangère vers l'encaissement dont le suspect semble le doublon) est fixé à la création. `cash_movement_id` est nul tant que l'encaissement est `SUSPECT_DUPLICATE` ou `REJECTED`, obligatoire pour `RECORDED`, `CANCELLATION_REQUESTED` et `CANCELLED` (`CHECK`), et ne change plus une fois renseigné. Montant, moyen, référence saisie et référence normalisée sont figés (déclencheur) : un suspect ne passe à `RECORDED` que si sa clé est libre. La Finance peut corriger la référence **au moment de la décision** (`SUSPECT_DUPLICATE` vers `RECORDED`, seule exception du déclencheur) ; la vente ou la commande visées sont mémorisées à la création (`intended_sale_id`, `intended_order_id`, figées) pour que l'affectation puisse suivre la décision (AV-135). | INV-FIN-09 ; décision AV-056 : le suspect n'a ni trésorerie ni affectation tant que la Finance n'a pas décidé (type de validation `PAYMENT_DUPLICATE`). |
| Cause de renversement d'une affectation (P4-02) | `reversal_cause` prend `PAYMENT_CANCELLED`, `SALE_CANCELLED`, `REALLOCATED`, `ORDER_CONFIRMED`, `ORDER_CANCELLED` ou `ORDER_CLOSED` (les deux derniers : acompte libéré par une commande annulée ou clôturée sans vente). `ORDER_CONFIRMED` remplace `ORDER_FULFILLED` du dictionnaire : un acompte affecté à la commande (cible `order_id`) est renversé à la confirmation, puis affecté à la vente (cible `sale_id`). Une affectation vise exactement une cible, vente ou commande (`CHECK`). | ADR-028 §8 (l'acompte passe à la vente à la confirmation : défaut retenu pour AV-033, qui recommandait la livraison avant ADR-025 ; AV-033 reste ouvert) : la vente naît à la confirmation, non plus à la livraison. |
| Libération partielle d'une affectation (P4-02) | Le registre d'affectation est immuable, sauf le passage unique de `ACTIVE` à `REVERSED` (déclencheur). Une libération partielle, par exemple après l'annulation partielle d'une vente déjà payée, renverse l'affectation entière et en crée une nouvelle pour la part conservée ; la part libérée devient du crédit client non affecté ou un remboursement. | INV-FIN-04 ; ADR-028 §8 ; BR-VEN-027 ; le montant d'une affectation existante n'est jamais modifié. |
| Créances sans vue SQL (P4-02) | Pas de vue `sales.v_receivables` : créances, ancienneté et encours client se calculent par requêtes du module `sales` (P4-09) sur `balance_due_xaf`, `due_date` et `payment_status` (index `(payment_status, due_date)`), les tranches venant de `receivableAging`. | Règle 6 (logique métier partagée : l'ancienneté vit dans `packages/domain`, sans doublon en SQL) ; le solde est déjà une colonne générée. La créance reste calculée, jamais stockée (ADR-010) : seul l'objet SQL diffère du dictionnaire. |
| Préfixes de numéros (P4-02) | Deux préfixes de numéro officiel : `LIV` (bon de livraison) et `ANV` (document d'annulation de vente, toutes causes), au format `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}` avec compteur par type, site et année ; `doc_number` est unique. | `LIV` : ADR-028 §7. `ANV` est DÉDUIT : aucune source ne nomme le préfixe d'une annulation de vente. |
| Paramètres semés (P4-02) | Trois paramètres en portée `GLOBAL` : `sales.duplicate_payment_window_minutes` = 10 (visible de l'appareil, qui contrôle aussi localement), `sales.offline_over_allocation_allowed` = `false` (visible de l'appareil ; réglable par site grâce à la portée `SITE`) et `sales.undelivered_alert_days` = 7 (serveur seulement ; seuil de l'alerte de P9). | Règle 8 (seuils = paramètres) ; AV-056, AV-025 et AV-132. Noms de clés : `sales.duplicate_payment_window_minutes` (nommée en P4-01) et `sales.undelivered_alert_days` (nommée par AV-132) sont CONFIRMÉES ; `sales.offline_over_allocation_allowed` est DÉDUITE. Valeur 7 jours : défaut d'AV-132, encore ouvert. |
| Politiques de contrôle par défaut (P4-02) | Cinq politiques semées, sans condition (toute opération du type est soumise à validation), sans photo, d'approbateur de portée `ALL` : `PRICE_OVERRIDE_DEFAULT` (`sales.price_override.approve`), `SALE_CANCELLATION_DEFAULT` (`sales.sale_cancel.approve`), `CREDIT_LIMIT_EXCEEDED_DEFAULT` (`sales.credit_limit_exceed.approve`), `PAYMENT_CANCELLATION_DEFAULT` et `PAYMENT_DUPLICATE_DEFAULT` (`sales.payment.cancel`). Le seed n'insère que les codes absents. Les types `PAYMENT_CANCELLATION` et `PAYMENT_DUPLICATE` sont ajoutés au `CHECK` des types d'opération. | Sans politique, l'opération est refusée (`CONTROL_POLICY_MISSING`) ; AV-026, AV-030, AV-028 et AV-056 ; les seuils éventuels se règlent ensuite dans la politique (règle 8). |
| Dérogation d'une ligne de commande (P4-02, relecture) | La ligne de commande porte le prix catalogue (`list_unit_price_xaf`), le motif (`override_reason_code_id`, obligatoire si `MANUAL_OVERRIDE`) et la validation `PRICE_OVERRIDE` de la dérogation, figés ; la ligne de vente créée à chaque confirmation (y compris tardive, AV-127) les recopie. Une ligne de vente `RULE` porte sa règle, sa version et son prix catalogue ; `ORDER_QUOTE` porte sa ligne de commande. | BR-VEN-015, INV-VEN-05, AV-026 ; sans ces colonnes, la dérogation ne survit pas à une confirmation différée. |
| Commande d'un produit vendu au poids (P4-02, relecture) | Défaut : en P4, seuls les produits à l'unité (`PER_UNIT`) se commandent ; un produit `PER_WEIGHT` se vend en vente directe, au poids pesé (la ligne de commande n'a ni quantité ni unité de tarification). | AV-136 (ouvert) ; AV-031 (les deux modes dès P4) ; ADR-028 place la vente à la confirmation, avant toute pesée. |
| Vente anonyme saisie hors ligne (P4-02, relecture) | La base accepte une vente sans client avec un reste dû : c'est un fait accompli qui n'est jamais rejeté. Défaut : la vente est enregistrée, le drapeau `ANONYMOUS_UNPAID` est posé dans `flags` et un conflit est ouvert pour la Finance (cas d'un doublon d'encaissement ou d'une annulation de paiement sur une vente anonyme). | BR-SYN-007, INV-SYN-06, AV-137 (ouvert) ; INV-VEN-07 reste vérifiée en transaction à l'enregistrement en ligne. |
| Échéance de toute vente à un client identifié (P4-02, relecture) | `due_date` est calculée à l'enregistrement pour toute vente à un client identifié, même soldée, et figée : une créance rouverte par l'annulation d'un encaissement garde une échéance, donc une ancienneté (`receivableAging`). | BR-FIN-007, AV-129 ; l'échéance « si reste dû » du dictionnaire d'origine ne couvre pas la réouverture. |
| Acompte libéré sans vente (P4-02, relecture) | Une commande annulée ou clôturée sans vente (aucun stock, AV-127) libère son acompte : les affectations sont renversées pour `ORDER_CANCELLED` ou `ORDER_CLOSED`, le sort (crédit client ou remboursement) est consigné sur la commande (`released_payment_treatment`, écrit une fois), et le remboursement est un mouvement de trésorerie `SALE_REFUND` dont `source_doc_id` désigne la commande. | BR-VEN-009, AV-033 ; `finance_cash_movements` n'a pas de type propre aux acomptes (polymorphe, sans clé étrangère). |
| Part remboursée d'un encaissement (P4-02, relecture) | `refunded_xaf` (jamais décroissant) trace l'argent rendu au client, distinct du crédit disponible `unallocated_xaf` ; `unallocated_xaf + refunded_xaf ≤ amount_xaf`. L'annulation d'un encaissement ne ressort que `amount_xaf − refunded_xaf`. | INV-FIN-04 ; BR-VEN-027 ; sans cette trace, un remboursement partiel suivi d'une annulation ferait sortir plus que l'entrée. |
| Écritures groupées (P4-02, relecture) | Les `CHECK` sont immédiats : une opération qui modifie plusieurs compteurs d'une ligne ou d'une vente le fait en **un seul `UPDATE`** (par exemple `quantity_base` et `sold_quantity_base` ensemble pour une baisse AV-130 ; `cancelled_xaf` et `amount_paid_xaf` ensemble pour annuler une vente payée). | Contrainte d'écriture des commandes de P4-04 à P4-08, à couvrir par leurs tests. |
| Conversion du prospect (P4-02, relecture) | Le prospect est converti à la première **vente** confirmée (BR-CRM-010), pas à la première commande : une commande sans stock (aucune vente) laisse le prospect en l'état, même avec un acompte. | AV-012, AV-127 ; conséquence de la vente à la confirmation, signalée à la relecture ; à rouvrir si une conversion sur commande ou acompte est souhaitée. |
| Gardes d'insertion de cohérence (P4-02, relecture) | Déclencheurs `BEFORE INSERT` : « à livrer » de la vente = celui du site de la préparation ; affectation seulement d'un encaissement `RECORDED` à une cible non annulée (INV-FIN-09, INV-FIN-10) ; ligne d'annulation de la vente du document ; ligne de bon de livraison concordante (ligne de vente, ligne de commande, commande du bon). | Ce que les `CHECK` ne peuvent pas exprimer entre tables ; relecture adverse de P4-02. |
