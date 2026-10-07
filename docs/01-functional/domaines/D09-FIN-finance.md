# D09 — Finance opérationnelle (FIN)

> Couvre : comptes de trésorerie, registre de trésorerie, sessions de caisse, remises de fonds, encaissements clients et affectations, créances, dépenses, factures et paiements fournisseurs, dettes fournisseurs, registre de coûts, coût des ventes, marges, valeur des pertes.
> **Modules de code** (le domaine fonctionnel FIN s'étend sur trois modules pour garder un graphe de dépendances sans cycle, ADR-011) :
> - `finance` : trésorerie (comptes, mouvements, sessions, remises), dépenses, factures et paiements fournisseurs, dettes ;
> - `sales` : encaissements clients, affectations et créances (chaîne commande → encaissement), car ils sont saisis avec la vente et portent sur des ventes ;
> - `inventory` : registre de coûts et valorisation (sous-domaine *valorisation*), car le coût par tête d'un lot sert à valoriser les mouvements de stock.
>
> Stratégie : [`../../02-domain-model/05-strategie-finance-couts.md`](../../02-domain-model/05-strategie-finance-couts.md). Décision : ADR-010.

---

## 1. Objectif

Donner une **comptabilité opérationnelle fiable** (CM §31), et non un logiciel comptable réglementaire. Il s'agit de savoir :

- ce qui a été vendu, encaissé, dépensé, acheté et payé ;
- ce qui reste dû, par les clients et aux fournisseurs ;
- où est l'argent (caisses, mobile money, banque) et qui en est responsable ;
- ce que coûtent les pertes et les lots ;
- quelles marges l'activité produit.

Tout cela doit rester **cohérent avec le stock** (CM §32).

## 2. Acteurs

`FINANCE`, `DIRECTION`, `VENDEUR_PDV` et commerciaux (encaissements, remises de fonds), tout rôle doté de `finance.expense.record` (dépenses), `RESP_ACHATS` (lecture des dettes), `system` (créances en retard, coûts).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Compte de trésorerie | `finance.cash_accounts` | Caisse de PDV, caisse d'utilisateur, caisse centrale, mobile money, banque |
| Mouvement de trésorerie | `finance.cash_movements` | Registre de trésorerie en ajout seul |
| Session de caisse | `finance.cash_sessions` | Ouverture, clôture, écart (D05) |
| Remise de fonds | `finance.cash_transfers` | Argent entre comptes, en deux temps |
| Moyen de paiement | `finance.payment_methods` | Référentiel (AV-056) |
| Encaissement client | `sales.customer_payments` | Argent reçu d'un client |
| Affectation de paiement | `sales.payment_allocations` | Répartition sur ventes ou commandes (acomptes) |
| Catégorie de dépense | `finance.expense_categories` | Référentiel (AV-058) |
| Dépense | `finance.expenses` | Charge non stockée |
| Facture fournisseur et lignes | `finance.supplier_invoices`, `finance.supplier_invoice_lines` | Dette fournisseur |
| Paiement fournisseur et affectations | `finance.supplier_payments`, `finance.supplier_payment_allocations` | Règlement des dettes |
| Écriture de coût | `inventory.cost_entries` | Registre de coûts par objet de coût |
| Créances, dettes | requête sur `sales.sales` (créances, P4-09), vue `finance.v_payables` | Calculées, jamais saisies |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-FIN-01 | Encaisser avec une vente | inclus dans `sales.sale.record` | Vendeur, commerciaux | **Oui** |
| UC-FIN-02 | ENCAISSER un règlement de créance ou un acompte | `sales.payment.record` | Vendeur, commerciaux, FINANCE | **Oui** |
| UC-FIN-03 | Réaffecter un encaissement | `sales.payment.reallocate` | FINANCE | Non |
| UC-FIN-04 | Annuler un encaissement | `sales.payment.request_cancellation` → validation | FINANCE | Non |
| UC-FIN-05 | Traiter un encaissement suspect de doublon | `approvals.request.approve` / `reject` | FINANCE | Non |
| UC-FIN-15 | Rembourser un crédit client (part non affectée d'un encaissement) | `sales.payment.refund` | FINANCE | Non |
| UC-FIN-06 | Ouvrir, clôturer, valider une session de caisse | `finance.cash_session.open`, `close`, `validate` | Vendeur ; FINANCE | **Oui** (ouvrir, clôturer) |
| UC-FIN-07 | Remettre des fonds ; confirmer la réception des fonds | `finance.cash_transfer.send`, `receive` | Détenteur de caisse ; FINANCE | **Oui** (envoi) |
| UC-FIN-08 | + DÉPENSE (payée immédiatement ou à payer) | `finance.expense.record` | Rôles autorisés | **Oui** |
| UC-FIN-09 | Approuver ou rejeter une dépense ; payer une dépense | `approvals.request.approve` / `reject` ; `finance.expense.pay` | FINANCE, DIRECTION | Non |
| UC-FIN-10 | Enregistrer une facture fournisseur et la rapprocher | `finance.supplier_invoice.record` | FINANCE | Non |
| UC-FIN-11 | Approuver une facture ; la contester | `finance.supplier_invoice.approve`, `finance.supplier_invoice.dispute` | FINANCE, DIRECTION | Non |
| UC-FIN-12 | Payer un fournisseur | `finance.supplier_payment.record` | FINANCE | Non |
| UC-FIN-13 | Imputer manuellement un coût à un lot ou un site | `inventory.cost_entry.record` | FINANCE | Non |
| UC-FIN-14 | Suivre créances (âge, retards), dettes, trésorerie, coûts et marges | requêtes (ECR-FIN-*) | FINANCE, DIRECTION | Non |

## 5. Entrées

Ventes et annulations (D04), paiements saisis, comptages de caisse, dépenses et justificatifs, réceptions et BC (D08), factures fournisseurs, consommations et pertes valorisées (D06), mises en place de lots (D07).

## 6. Sorties

Soldes de trésorerie par compte et par responsable, créances par client, par commercial et par âge, dettes par fournisseur, coûts par lot, site et PDV, coût des ventes, marges, valeur des pertes, alertes `OVERDUE_RECEIVABLE`, `CASH_VARIANCE`, `PAYMENT_DUPLICATE_SUSPECTED`, `INVOICE_MISMATCH`.

## 7. Règles métier

### 7.1 Encaissements et créances

| ID | Règle | Statut |
|---|---|---|
| BR-FIN-001 | Un encaissement porte : montant > 0 (XAF entiers), moyen de paiement, `occurred_at`, utilisateur qui reçoit, compte de trésorerie crédité, référence externe (obligatoire pour le mobile money et le virement), client (obligatoire hors vente anonyme). | C (CM §31) / D |
| BR-FIN-002 | Le compte crédité est déduit du contexte : caisse du PDV (espèces au PDV), caisse de l'utilisateur (espèces reçues par un commercial terrain), compte mobile money de l'entreprise, compte bancaire. | D |
| BR-FIN-003 | Σ affectations actives d'un encaissement ≤ son montant ; Σ affectations actives sur une vente ≤ son net (total − annulé). La part non affectée d'un encaissement est un **crédit client** disponible. | D |
| BR-FIN-004 | Un règlement saisi sans vente précise s'affecte automatiquement aux ventes impayées du client, de la plus ancienne échéance à la plus récente, sauf choix explicite. | D |
| BR-FIN-005 | Le couple (moyen de paiement, référence externe) est unique. Un doublon reçu est mis en `SUSPECT_DUPLICATE`, **sans** mouvement de trésorerie ni affectation, jusqu'à la décision de la Finance. | D (PM §30 « paiement en double ») / AV-056 |
| BR-FIN-006 | Un encaissement n'est jamais supprimé. Son annulation (validation requise) crée le mouvement de trésorerie inverse et désactive ses affectations, ce qui rouvre les créances. | C (CM §41) |
| BR-FIN-007 | Créance d'une vente = total − Σ affectations actives. Échéance = `due_date` de la vente. Une créance est **en retard** si la date du jour dépasse l'échéance et que le solde est > 0 ; l'alerte `OVERDUE_RECEIVABLE` est levée chaque jour à 07:00. | C (CM §13, §54) / AV-028 |
| BR-FIN-008 | Un acompte est un encaissement affecté à une commande. À la confirmation de la commande (la vente naît à la confirmation, ADR-025, ADR-028 §8), son affectation est transférée vers la vente créée : affectation commande renversée (`ORDER_CONFIRMED`), affectation vente créée ; une commande annulée ou clôturée sans vente libère l'acompte (`ORDER_CANCELLED`, `ORDER_CLOSED`). | AV-033 (défaut) |

### 7.2 Trésorerie

| ID | Règle | Statut |
|---|---|---|
| BR-FIN-010 | Types de compte de trésorerie : `CAISSE_PDV`, `CAISSE_UTILISATEUR`, `CAISSE_CENTRALE`, `MOBILE_MONEY`, `BANQUE`. Chaque compte a un responsable. Une `CAISSE_UTILISATEUR` n'a qu'un détenteur. | C (CM §12, §31) / D |
| BR-FIN-011 | Tout flux d'argent est un **mouvement de trésorerie** en ajout seul : compte, sens (`IN` / `OUT`), montant > 0, type (`CUSTOMER_PAYMENT`, `REFUND`, `SUPPLIER_PAYMENT`, `EXPENSE`, `TRANSFER_OUT`, `TRANSFER_IN`, `SESSION_VARIANCE`, `OPENING_BALANCE`), document source, `occurred_at`, session de caisse éventuelle. Solde d'un compte = Σ entrées − Σ sorties. Correction uniquement par mouvement inverse. | D (CM §31, §41) |
| BR-FIN-012 | En ligne, une sortie ne peut rendre négatif le solde d'une caisse physique (`CAISSE_*`). Hors ligne, elle est appliquée et produit l'anomalie `CASH_NEGATIVE`. | D |
| BR-FIN-013 | Une remise de fonds se fait en deux temps : `TRANSFER_OUT` à l'envoi, `TRANSFER_IN` à la réception. Un écart ouvre `CASH_TRANSFER_DISCREPANCY`, à valider. | D |
| BR-FIN-014 | Session de caisse : voir D05 (BR-DIS-005 à BR-DIS-008). À l'ouverture, un fonds compté différent du solde du compte produit un mouvement `SESSION_VARIANCE`, à valider. | AV-057 |

### 7.3 Dépenses

| ID | Règle | Statut |
|---|---|---|
| BR-FIN-020 | Une dépense porte : catégorie, montant, `occurred_at` (date de la charge), bénéficiaire, description, objet de coût optionnel (lot de production, lot d'incubation, site, PDV), justificatif selon la politique, et indicateur « payée immédiatement » avec son compte. | C (CM §31, §42) / AV-058 |
| BR-FIN-021 | **Payée immédiatement** : le mouvement de trésorerie `EXPENSE` est enregistré tout de suite (fait accompli) ; la validation, si requise, est a posteriori (statut `PAID_PENDING_APPROVAL`). **À payer** : `PENDING_APPROVAL` ou `APPROVED`, puis `PAID` par `finance.expense.pay`. | D |
| BR-FIN-022 | Une dépense imputée à un objet de coût crée une écriture de coût (`inventory.cost_entries`) à son approbation, ou dès l'enregistrement si aucune validation n'est requise. Une dépense rejetée après paiement reste un décaissement réel : elle est reclassée en catégorie `NON_JUSTIFIEE` et imputée au déclarant pour suivi. | D |

### 7.4 Fournisseurs

| ID | Règle | Statut |
|---|---|---|
| BR-FIN-030 | Une facture fournisseur porte : fournisseur, référence du fournisseur (unique par fournisseur), date, échéance, montant total, lignes rattachées aux lignes de BC et de réception, pièce jointe. | C (CM §26, §27) |
| BR-FIN-031 | **Rapprochement** à l'enregistrement : quantité facturée ≤ quantité acceptée, prix facturé = prix du BC. Tout écart met la facture en `MISMATCH`, qui exige l'approbation d'un utilisateur `FINANCE` avec un motif. | C (CM §26 « écarts ») / AV-053 |
| BR-FIN-032 | Dette fournisseur = Σ factures approuvées − Σ affectations de paiements fournisseurs. Un paiement non affecté est une avance fournisseur. | C (CM §32) / AV-055 |
| BR-FIN-033 | Un paiement fournisseur au-delà du seuil (500 000 XAF) exige l'approbation de la Direction **avant** le décaissement. | AV-055 |

### 7.5 Coûts, marges, pertes

| ID | Règle | Statut |
|---|---|---|
| BR-FIN-040 | Le **registre de coûts** (`inventory.cost_entries`, module `inventory`) est en ajout seul. Chaque écriture porte : objet de coût, type de coût (`ANIMAUX`, `ALIMENT`, `VETERINAIRE`, `AUTRE_INTRANT`, `DEPENSE_DIRECTE`, `AJUSTEMENT`), montant, document source, `occurred_at`. Correction par écriture de sens opposé liée à l'originale. | C (CM §15, §33) / D |
| BR-FIN-041 | Sources d'écritures de coût : consommations imputées à un lot et mises en place (écrites par `inventory` dans la transaction du mouvement) ; dépenses imputées (écrites par `finance` via l'API d'`inventory` à l'approbation ou à l'enregistrement) ; imputation manuelle (`inventory.cost_entry.record`). | D |
| BR-FIN-042 | **CA** d'une période = Σ montants des ventes dont `occurred_at` est dans la période − Σ montants des ventes **annulées dont l'annulation** est dans la période (l'annulation est une contre-écriture datée de son propre `occurred_at`). Un rapport passé n'est donc jamais réécrit par une annulation ultérieure. Une vue « net par date de vente » est aussi disponible. | C (CM §30, §41) / D |
| BR-FIN-043 | **Coût des ventes** = Σ (quantité × coût unitaire figé) des mouvements `SALE` − ceux de leurs inverses, sur les mêmes principes de date. **Marge brute** = CA − coût des ventes. | C (CM §31) / D |
| BR-FIN-044 | **Valeur des pertes** = Σ (quantité × coût unitaire figé) des mouvements vers `V_LOSS` et des ajustements d'inventaire négatifs. Pour les produits biologiques de lot, c'est un indicateur économique (BR-PRD-013). | C (CM §32) |
| BR-FIN-045 | Tous les montants sont en XAF entiers ; aucune conversion de devise. | D (ADR-013) |
| BR-FIN-046 | Pas de clôture de période verrouillant la saisie au MVP. La fenêtre de saisie rétroactive (AV-078) et l'immuabilité des sessions de caisse validées limitent les modifications du passé. | AV-088 |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Montant > 0, entier | `AMOUNT_INVALID` |
| Référence externe requise selon le moyen | `PAYMENT_REFERENCE_REQUIRED` |
| Affectations ≤ montant et ≤ reste dû | `ALLOCATION_EXCEEDS` |
| Client obligatoire hors règlement d'une vente anonyme désignée | `CUSTOMER_REQUIRED` |
| Cible d'affectation du client, payable (vente confirmée non soldée, commande ni livrée ni terminée) | `ALLOCATION_TARGET_INVALID`, `ALLOCATION_INVALID` (cible citée deux fois) |
| Site déterminable (fourni, ou celui de la première vente ou commande réglée, ou du client) | `SITE_REQUIRED` |
| Remboursement ≤ crédit non affecté de l'encaissement | `REFUND_EXCEEDS_CREDIT` |
| Annulation : encaissement `RECORDED`, non remboursé en partie ; motif | `PAYMENT_STATUS_INVALID`, `PAYMENT_ALREADY_CANCELLED`, `PAYMENT_PARTIALLY_REFUNDED`, `REASON_REQUIRED` |
| Compte de trésorerie actif et accessible à l'utilisateur | `CASH_ACCOUNT_FORBIDDEN` |
| Facture : référence unique par fournisseur | `INVOICE_DUPLICATE` |
| Paiement fournisseur ≤ dette + avance autorisée | `SUPPLIER_PAYMENT_EXCEEDS` |
| Justificatif requis présent | `ATTACHMENT_REQUIRED` |

## 9. Dépendances

ADM, CRM (clients, crédit), VEN (ventes, commandes), STK (valorisation des mouvements), APP (BC, réceptions), PRD (objets de coût), NOT, ANA.

## 10. Événements produits

`PaymentReceived`, `PaymentAllocated`, `PaymentFlaggedDuplicate`, `PaymentCancelled`, `CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected`, `CashSessionValidated`, `CashTransferSent`, `CashTransferReceived`, `CashTransferDiscrepancyDetected`, `ExpenseRecorded`, `ExpenseApproved`, `ExpenseRejected`, `ExpensePaid`, `SupplierInvoiceRecorded`, `SupplierInvoiceMismatchDetected`, `SupplierInvoiceApproved`, `SupplierPaymentRecorded`, `CostEntryRecorded`, `ReceivableOverdue`.

## 11. Événements consommés

`SaleConfirmed` et `SaleCancelled` (créances, affectations), `OrderFulfilled` (transfert des acomptes), `ConsumptionRecorded` et `LotEntryRecorded` (écritures de coût), `GoodsReceived` (base du rapprochement), `ApprovalGranted` / `ApprovalRejected` (types `EXPENSE`, `PAYMENT_DUPLICATE`, `PAYMENT_CANCELLATION`, `SUPPLIER_PAYMENT`, `CASH_VARIANCE`, `INVOICE_MISMATCH`).

## 12. Fonctionnement hors ligne

- Hors ligne : encaissements (avec ou sans vente), ouverture et clôture de caisse, envoi de remise de fonds, dépenses payées immédiatement. L'appareil calcule le solde attendu de sa caisse.
- Données locales : comptes de trésorerie dont l'utilisateur est responsable et leur solde au dernier téléchargement, moyens de paiement, catégories de dépense autorisées, encours des clients du périmètre.
- En ligne uniquement : validations, factures et paiements fournisseurs, réaffectations, rapports financiers. La Finance travaille principalement connectée (acteurs §2).

## 13. Permissions

`sales.payment.record`, `sales.payment.read`, `sales.payment.cancel`, `sales.payment.reallocate` (P4-08), `sales.payment.refund` (P4-08), `sales.receivable.read`, `finance.cash.read`, `finance.cash_session.operate`, `finance.cash_session.validate`, `finance.cash_account.manage`, `finance.cash_transfer.record`, `finance.expense.read`, `finance.expense.record`, `finance.expense.approve`, `finance.expense.pay`, `finance.supplier_invoice.record`, `finance.supplier_invoice.approve`, `finance.supplier_payment.record`, `finance.supplier_payment.approve`, `finance.payable.read`, `inventory.valuation.read`, `inventory.cost_entry.record`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Commercial terrain avec beaucoup d'espèces non remises | Alerte `CASH_HOLDING_HIGH` si le solde de la caisse utilisateur dépasse un plafond (paramètre, défaut 200 000 XAF) ou si aucune remise n'a eu lieu depuis plus de 3 jours. |
| Encaissement mobile money déclaré mais non reçu sur le compte | Rapprochement manuel par la Finance à partir du relevé opérateur ; annulation de l'encaissement si nécessaire (BR-FIN-006). |
| Facture reçue avant la réception | Enregistrée en `MISMATCH` (quantité facturée > acceptée) jusqu'à réception. |
| Vente annulée déjà payée | Remboursement (mouvement `REFUND`) ou conservation en crédit client (BR-VEN-027). |

## 15. Choix d'implémentation (P4-08)

Précisions retenues par le module `sales` pour les encaissements hors vente (`payment-commands.ts`), là où les règles laissent un choix ; toutes **DÉDUITES**, sauf mention.

| Point | Choix | Justification |
|---|---|---|
| `sales.payment.record` (hors ligne) | Agrégat `CUSTOMER_PAYMENT` (identifiant de l'encaissement). Charge utile : `customerId?`, `siteId?`, `methodCode`, `amountXaf`, `reference?`, `cashAccountId?`, `localRef?`, `allocations[]?` (`saleId` ou `orderId`, `amountXaf`). Moyen, référence, compte crédité et doublons : mêmes règles que les encaissements joints à une vente (`planPayments`, AV-139). Sans `allocations` : les ventes ouvertes du client (comptes fusionnés compris) sont réglées de l'échéance la plus ancienne à la plus récente, le reste est un crédit client. Avec `allocations` : Σ ≤ montant ; chaque cible appartient au client ; en ligne, une affectation dépasse le reste dû d'une vente ou le **reste à vendre** d'une commande (attente × prix convenu − acompte déjà affecté) : `ALLOCATION_EXCEEDS` ; hors ligne, la part au-delà, ou destinée à une cible devenue non payable, reste en crédit client (fait accompli). Sans client : seulement pour régler exactement une vente anonyme désignée. Site : fourni, sinon celui de la première vente ou commande réglée, sinon le site de rattachement du client (`SITE_REQUIRED`). Portée `sales.payment.record` évaluée sur le titulaire du client (à défaut l'auteur), le site et la zone du client. Réponse : `docNumber` (`ENC`). | BR-FIN-001 à 005 ; AV-150 (plafond de l'acompte, défaut) ; BR-SYN-007. |
| Doublon de référence et décision de la Finance | Référence déjà enregistrée pour ce moyen : `SUSPECT_DUPLICATE`, sans trésorerie ni affectation, cible mémorisée s'il n'y en a qu'une (`intended_sale_id`, `intended_order_id`), validation `PAYMENT_DUPLICATE`, conflit `PAYMENT_REFERENCE_DUPLICATE` non appliqué. Approbation : la Finance donne la référence corrigée (`decisionData.correctedReference` de `approvals.request.approve`) ; sans correction, la référence doit être redevenue libre, sinon refus `PAYMENT_REFERENCE_DUPLICATE` (la demande reste en attente). L'encaissement devient `RECORDED` à son heure d'origine, avec son mouvement de trésorerie, et est affecté à la cible mémorisée dans la limite de son reste (le surplus en crédit). Rejet : `REJECTED`, sans effet. | BR-FIN-005 ; AV-056 ; AV-135 (défaut implémenté). |
| Annulation d'un encaissement | `sales.payment.request_cancellation` (en ligne, `sales.payment.record`, motif ou commentaire) : `CANCELLATION_REQUESTED`, motif et demande consignés, validation `PAYMENT_CANCELLATION`. Approuvée : affectations renversées (`PAYMENT_CANCELLED`) et compteurs diminués, mouvement de trésorerie **inverse** du mouvement d'origine (même compte, même montant), appliqué même si la caisse passe en négatif (correction, non sortie physique), crédit remis à 0, `CANCELLED`. Rejetée : retour à `RECORDED`, motif et demande effacés de l'encaissement (ils restent sur la demande de validation). Un encaissement en partie remboursé ne s'annule pas (`PAYMENT_PARTIALLY_REFUNDED`, AV-151). | BR-FIN-006 ; SM-CUSTOMER-PAYMENT ; CHECK de la table (motif seulement en demande ou annulé). |
| Réaffectation (`sales.payment.reallocate`, Finance, en ligne) | `release[]` libère des affectations d'une cible (cause `REALLOCATED`, la part conservée est recréée), `allocate[]` affecte le crédit (libéré compris) à d'autres ventes ou commandes du client, aux mêmes contrôles que la saisie en ligne ; le crédit restant est réécrit en un `UPDATE`. Permission nouvelle `sales.payment.reallocate` (Finance, `ALL`). | UC-FIN-03 ; BR-FIN-003, 004. La permission manquait au référentiel RBAC. |
| Remboursement d'un crédit (`sales.payment.refund`, Finance, en ligne) | Rembourse tout ou partie de la part non affectée d'un encaissement `RECORDED` : mouvement `REFUND` (`SALE_REFUND`, pièce source = l'encaissement) depuis le compte d'origine ou celui désigné, jamais en négatif pour une caisse (BR-FIN-012) ; `unallocated_xaf` baisse et `refunded_xaf` monte. Permission nouvelle `sales.payment.refund` (Finance, `ALL`). | BR-FIN-003 ; D09 §14 (vente annulée déjà payée) ; UC-FIN-15. |
| Ordre des verrous | Commandes, puis ventes (identifiant croissant), puis les affectations de l'encaissement, puis l'encaissement, puis le compte de trésorerie, puis le compteur de numéros `ENC` : celui des encaissements joints à une vente et de l'annulation d'une vente (`sale-cancellation.ts`). | D04 §15 (« Ordre des verrous de `sales` »). |
| Revue adverse de P4-08 (07/10/2026) | Validation d'une annulation refusée si une part a été remboursée depuis la demande (`PAYMENT_PARTIALLY_REFUNDED`, sinon double décaissement) ; un encaissement en demande d'annulation garde ses affectations recréables (confirmation d'une commande, annulation partielle d'une vente : migration `20261007090000`) ; hors ligne, la part non affectable reste en crédit avec l'avertissement `PAYMENT_UNALLOCATED` et un conflit appliqué pour la Finance ; doublon validé : les cibles et montants saisis (consignés dans le conflit) sont rejoués, la référence corrigée ne dépasse pas 80 caractères (`PAYMENT_REFERENCE_INVALID`) et le conflit est résolu ; une cible citée deux fois est refusée (`ALLOCATION_INVALID`) ; `reallocate`, `refund` et `request_cancellation` en ligne seulement (`ONLINE_REQUIRED`) ; remboursement depuis la caisse personnelle d'un autre : `CASH_ACCOUNT_FORBIDDEN` ; une demande retirée permet une nouvelle demande ; inverse d'un mouvement et fait passé validé appliqués même sur un compte désactivé depuis ; plafond de l'acompte lu en verrou. | BR-FIN-003 à 006 ; BR-SYN-007 ; AV-135, AV-150, AV-151. |

