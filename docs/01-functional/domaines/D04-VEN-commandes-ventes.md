# D04 — Commandes et ventes (VEN)

> Couvre : commandes clients, réservations, livraison (vente sur commande), ventes directes, prix appliqués, attribution commerciale, encaissement intégré à la vente, annulation.
> Module de code : `sales`. Les encaissements sont **enregistrés** par le module `finance` (D09) mais **saisis** dans le même geste que la vente. Les mouvements de stock sont **créés** par le module `inventory` (D06) à la demande de `sales`.

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
| Encaissement | `finance.customer_payments`, `finance.payment_allocations` | Propriété de D09 |

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
