# D08 — Approvisionnement : fournisseurs, achats, réceptions (APP)

> Module de code : `procurement`. Les factures et paiements fournisseurs (dettes) sont dans D09 (`finance`). Les entrées en stock passent par D06 (`inventory`).
> Processus de référence (CM §27) : **Besoin → Demande d'achat → Validation → Bon de commande → Réception → Facture → Paiement**, avec **commandé ≠ livré ≠ reçu ≠ accepté ≠ facturé ≠ payé** (tension C-02).

---

## 1. Objectif

Contrôler les approvisionnements. Pour chaque fournisseur, savoir ce qui a été commandé, à quel prix, ce qui a réellement été livré et accepté, avec quels écarts et quels documents. N'augmenter le stock que de la quantité **acceptée** (CM §26–§28).

## 2. Acteurs

`RESP_ACHATS`, demandeurs (`MAGASINIER`, `RESP_FERME`, `RESP_PRODUCTION`, et tout rôle doté de `procurement.request.create`), `MAGASINIER` et `RESP_FERME` (réception), `DIRECTION` (validation au-dessus du seuil), `FINANCE` (lecture, rapprochement).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Fournisseur | `procurement.suppliers` | Tiers fournisseur |
| Demande d'achat et lignes | `procurement.purchase_requests`, `procurement.purchase_request_lines` | Besoin interne soumis à validation |
| Bon de commande et lignes | `procurement.purchase_orders`, `procurement.purchase_order_lines` | Engagement fournisseur |
| Réception et lignes | `procurement.goods_receipts`, `procurement.goods_receipt_lines` | Livré, rejeté, accepté |
| Facture fournisseur | `finance.supplier_invoices` | Propriété de D09 |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-APP-01 | Créer ou modifier un fournisseur | `procurement.supplier.create`, `procurement.supplier.update` | RESP_ACHATS | Non |
| UC-APP-02 | Exprimer un besoin : créer et soumettre une demande d'achat | `procurement.request.submit` | Demandeurs | **Oui** |
| UC-APP-03 | Valider ou rejeter une demande d'achat | `approvals.request.approve` / `reject` | RESP_ACHATS, DIRECTION | Non |
| UC-APP-04 | Créer un bon de commande (depuis des demandes approuvées ou directement) | `procurement.order.create` | RESP_ACHATS | Non |
| UC-APP-05 | Approuver un bon de commande au-dessus du seuil | `approvals.request.approve` | DIRECTION | Non |
| UC-APP-06 | Marquer un bon de commande envoyé | `procurement.order.mark_sent` | RESP_ACHATS | Non |
| UC-APP-07 | RÉCEPTIONNER : livré, rejeté, accepté | `procurement.receipt.record` | MAGASINIER, RESP_FERME | **Oui** |
| UC-APP-08 | Réception directe sans bon de commande | `procurement.receipt.record` (sans BC) | MAGASINIER, RESP_FERME | **Oui** |
| UC-APP-09 | Traiter une réception en quarantaine ou une réception sans BC | `approvals.request.approve` / `reject` | RESP_ACHATS | Non |
| UC-APP-10 | Clôturer le reliquat d'un bon de commande ; annuler un bon de commande | `procurement.order.close_remaining`, `procurement.order.cancel` | RESP_ACHATS | Non |
| UC-APP-11 | Annuler une réception comptabilisée | `procurement.receipt.request_cancellation` | MAGASINIER → validation RESP_ACHATS | Non |
| UC-APP-12 | Suivre reliquats, retards, écarts et rapprochement | requête (ECR-APP-05) | RESP_ACHATS, FINANCE | Non |

## 5. Entrées

Besoins exprimés, décisions de validation, prix négociés, livraisons physiques (quantités livrées, rejetées, lots fournisseur, bons de livraison photographiés), factures (D09).

## 6. Sorties

Engagements fournisseurs, entrées en stock valorisées au prix d'achat, reliquats, écarts, alertes `RECEIPT_INCOMPLETE`, données de rapprochement pour la Finance, historique des prix d'achat par fournisseur.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-APP-001 | Un fournisseur a un code unique, un nom, les catégories de produits qu'il fournit, des contacts, un délai de paiement et un statut (`ACTIVE`, `INACTIVE`). Un fournisseur inactif ne reçoit plus de nouveau BC ; son historique reste consultable. | C (CM §26) / D |
| BR-APP-002 | Une demande d'achat porte : demandeur, site bénéficiaire, date de besoin, justification, et des lignes (produit, quantité, prix estimé optionnel). Une fois soumise, elle n'est plus modifiable : pour la changer, on l'annule et on en soumet une nouvelle. | C (CM §27) / D |
| BR-APP-003 | Toute demande d'achat soumise exige une validation (`procurement.request.approve`), par le Resp. achats ou la Direction, distinct du demandeur. | AV-051, AV-010 |
| BR-APP-004 | Une demande approuvée peut être couverte par un ou plusieurs BC, entièrement ou partiellement ; ses lignes suivent la quantité commandée. | D |
| BR-APP-005 | Un BC porte : fournisseur actif, emplacement de livraison, lignes (produit, quantité, prix unitaire XAF), total, date de livraison prévue. Au-delà du seuil (500 000 XAF par défaut), il exige l'approbation de la Direction avant envoi. | C (CM §26, §27) / AV-051 |
| BR-APP-006 | Une fois envoyé (`SENT`), un BC n'est plus augmenté : on peut seulement réduire ou clôturer le reliquat, ou annuler les lignes non reçues. Une hausse de quantité ou de prix se fait par un nouveau BC. | D (CM §30 « ne pas réécrire ») |
| BR-APP-007 | Une ligne de réception porte : **quantité livrée**, **quantité rejetée** (avec motif), **quantité acceptée = livrée − rejetée**, lot fournisseur et date de péremption optionnels. **Seule la quantité acceptée entre en stock**, par un mouvement `V_SUPPLIER` → emplacement de réception. | C (CM §28) |
| BR-APP-008 | La réception fige le coût unitaire d'entrée : prix de la ligne de BC, ou prix déclaré pour une réception sans BC. Ce coût alimente le CMUP (BR-STK-053). | C (CM §32) / AV-042 |
| BR-APP-009 | Reliquat d'une ligne de BC = quantité commandée − Σ quantités acceptées. Un BC est `PARTIALLY_RECEIVED` tant qu'un reliquat existe, `RECEIVED` quand tous les reliquats sont nuls, `CLOSED` quand le reliquat restant est clôturé manuellement. | C (CM §27) / D |
| BR-APP-010 | Une acceptation cumulée supérieure à la quantité commandée est refusée en ligne (tolérance 0 par défaut). Hors ligne, la réception est appliquée et l'excédent part en revue (`OVER_RECEIPT`). | AV-053 |
| BR-APP-011 | Une réception sans BC est autorisée : fournisseur, prix déclaré et justificatif obligatoires. Le stock entre immédiatement ; la réception reste `POSTED_PENDING_REVIEW` jusqu'à la validation du Resp. achats. | AV-052 |
| BR-APP-012 | Une réception suspectée d'être un **doublon** (même numéro de bon de livraison fournisseur déjà reçu pour ce fournisseur, ou acceptation cumulée > commandée pour une réception concurrente hors ligne) est mise en `QUARANTINED` : **aucun effet stock** jusqu'à décision. Approuvée, elle est comptabilisée ; rejetée, elle est sans effet (`REJECTED`). | D (PM §30 « réception en double ») |
| BR-APP-013 | Annuler une réception comptabilisée exige une validation et crée les mouvements inverses. C'est impossible si le stock concerné n'est plus disponible : on passe alors par un retour fournisseur (extension). | C (CM §41) / D |
| BR-APP-014 | Une photo du bon de livraison est requise selon la politique de contrôle (par défaut : toute réception sans BC, et toute réception de valeur ≥ 100 000 XAF). | C (CM §42) / AV-037 |
| BR-APP-015 | Alerte `RECEIPT_INCOMPLETE` : BC dont la date prévue est dépassée de plus de 2 jours avec un reliquat, ou réception comportant une quantité rejetée. | C (CM §54) / AV-065 |
| BR-APP-016 | L'achat d'animaux vivants (poussins, porcelets) se réceptionne directement dans un bâtiment et peut déclencher la mise en place d'un lot dans la même opération (BR-PRD-004). | D |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Fournisseur actif | `SUPPLIER_INACTIVE` |
| Quantités > 0 ; rejetée ≤ livrée ; motif présent si rejetée > 0 | `RECEIPT_LINE_INVALID`, `REJECTION_REASON_REQUIRED` |
| Ligne de réception rattachée à une ligne de BC du même BC ; même produit | `PO_LINE_MISMATCH` |
| BC `SENT` ou `PARTIALLY_RECEIVED` pour recevoir | `PO_NOT_RECEIVABLE` |
| Emplacement de réception sur le site de livraison du BC (ou dérogation motivée) | `RECEIPT_LOCATION_INVALID` |
| Prix unitaire ≥ 0 | `PRICE_INVALID` |

## 9. Dépendances

ADM (validations, pièces, emplacements), CAT (produits achetables), STK (entrées en stock, CMUP), PRD (mise en place d'animaux), FIN (factures, paiements, rapprochement, dette fournisseur), NOT.

## 10. Événements produits

`SupplierCreated`, `SupplierUpdated`, `PurchaseRequestSubmitted`, `PurchaseRequestApproved`, `PurchaseRequestRejected`, `PurchaseRequestCancelled`, `PurchaseOrderCreated`, `PurchaseOrderApproved`, `PurchaseOrderSent`, `PurchaseOrderCancelled`, `PurchaseOrderClosed`, `GoodsReceived`, `GoodsReceiptQuarantined`, `GoodsReceiptCancelled`, `ReceiptIncompleteDetected`.

## 11. Événements consommés

`ApprovalGranted` / `ApprovalRejected` (types `PURCHASE_REQUEST`, `PURCHASE_ORDER`, `RECEIPT_WITHOUT_PO`, `RECEIPT_QUARANTINE`, `RECEIPT_CANCELLATION`), `SupplierInvoiceRecorded` (mise à jour de la quantité facturée des lignes de BC, pour le rapprochement).

## 12. Fonctionnement hors ligne

- Données locales du magasinier ou du responsable ferme : BC `SENT` et `PARTIALLY_RECEIVED` livrables sur son site, avec lignes et reliquats ; fournisseurs actifs (liste courte) ; motifs de rejet.
- Réception hors ligne possible ; photo capturée localement.
- Création d'une demande d'achat hors ligne possible ; validation et émission des BC en ligne.

## 13. Permissions

`procurement.supplier.read`, `procurement.supplier.manage`, `procurement.request.create`, `procurement.request.approve`, `procurement.order.read`, `procurement.order.manage`, `procurement.order.approve`, `procurement.receipt.record`, `procurement.receipt.cancel`, `procurement.receipt_exception.approve`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Deux magasiniers réceptionnent le même BC hors ligne | La première réception appliquée est comptabilisée. La seconde passe en quarantaine si elle dépasse le reliquat (BR-APP-012). |
| Livraison d'un produit non commandé | Réception sans BC (BR-APP-011) ou rejet complet (livré = rejeté). |
| Fournisseur livre en plusieurs fois | Plusieurs réceptions sur le même BC ; le reliquat est suivi. |
| Prix facturé différent du prix du BC | Écart signalé au rapprochement (D09) ; le coût de stock reste celui de la réception. L'écart est traité en finance, sans réécrire les mouvements. |
| Réception de lot périssable (vaccins) | Date de péremption portée par le lot fournisseur ; alerte `LOT_EXPIRING` 15 jours avant (paramètre). |
