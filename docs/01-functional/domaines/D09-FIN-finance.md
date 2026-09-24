# D09 — Finance opérationnelle (FIN)

> Couvre : comptes de trésorerie, registre de trésorerie, sessions de caisse, remises de fonds, encaissements clients et affectations, créances, dépenses, factures et paiements fournisseurs, dettes fournisseurs, registre de coûts, coût des ventes, marges, valeur des pertes.
> Module de code : `finance`. Stratégie : [`../../02-domain-model/05-strategie-finance-couts.md`](../../02-domain-model/05-strategie-finance-couts.md). Décision : ADR-010.

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
| Encaissement client | `finance.customer_payments` | Argent reçu d'un client |
| Affectation de paiement | `finance.payment_allocations` | Répartition sur ventes ou commandes (acomptes) |
| Catégorie de dépense | `finance.expense_categories` | Référentiel (AV-058) |
| Dépense | `finance.expenses` | Charge non stockée |
| Facture fournisseur et lignes | `finance.supplier_invoices`, `finance.supplier_invoice_lines` | Dette fournisseur |
| Paiement fournisseur et affectations | `finance.supplier_payments`, `finance.supplier_payment_allocations` | Règlement des dettes |
| Écriture de coût | `finance.cost_entries` | Registre de coûts par objet de coût |
| Créances, dettes (vues) | `finance.v_receivables`, `finance.v_payables` | Calculées, jamais saisies |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-FIN-01 | Encaisser avec une vente | inclus dans `sales.sale.record` | Vendeur, commerciaux | **Oui** |
| UC-FIN-02 | ENCAISSER un règlement de créance ou un acompte | `finance.payment.record` | Vendeur, commerciaux, FINANCE | **Oui** |
| UC-FIN-03 | Réaffecter un encaissement | `finance.payment.reallocate` | FINANCE | Non |
| UC-FIN-04 | Annuler un encaissement | `finance.payment.request_cancellation` → validation | FINANCE | Non |
| UC-FIN-05 | Traiter un encaissement suspect de doublon | `approvals.request.approve` / `reject` | FINANCE | Non |
| UC-FIN-06 | Ouvrir, clôturer, valider une session de caisse | `finance.cash_session.open`, `close`, `validate` | Vendeur ; FINANCE | **Oui** (ouvrir, clôturer) |
| UC-FIN-07 | Remettre des fonds ; confirmer la réception des fonds | `finance.cash_transfer.send`, `receive` | Détenteur de caisse ; FINANCE | **Oui** (envoi) |
| UC-FIN-08 | + DÉPENSE (payée immédiatement ou à payer) | `finance.expense.record` | Rôles autorisés | **Oui** |
| UC-FIN-09 | Approuver ou rejeter une dépense ; payer une dépense | `approvals.request.approve` / `reject` ; `finance.expense.pay` | FINANCE, DIRECTION | Non |
| UC-FIN-10 | Enregistrer une facture fournisseur et la rapprocher | `finance.supplier_invoice.record` | FINANCE | Non |
| UC-FIN-11 | Approuver une facture ; la contester | `finance.supplier_invoice.approve`, `finance.supplier_invoice.dispute` | FINANCE, DIRECTION | Non |
| UC-FIN-12 | Payer un fournisseur | `finance.supplier_payment.record` | FINANCE | Non |
| UC-FIN-13 | Imputer manuellement un coût à un lot ou un site | `finance.cost_entry.record` | FINANCE | Non |
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
| BR-FIN-003 | Σ affectations actives d'un encaissement ≤ son montant ; Σ affectations actives sur une vente ≤ son total. La part non affectée d'un encaissement est un **crédit client** disponible. | D |
| BR-FIN-004 | Un règlement saisi sans vente précise s'affecte automatiquement aux ventes impayées du client, de la plus ancienne échéance à la plus récente, sauf choix explicite. | D |
| BR-FIN-005 | Le couple (moyen de paiement, référence externe) est unique. Un doublon reçu est mis en `SUSPECT_DUPLICATE`, **sans** mouvement de trésorerie ni affectation, jusqu'à la décision de la Finance. | D (PM §30 « paiement en double ») / AV-056 |
| BR-FIN-006 | Un encaissement n'est jamais supprimé. Son annulation (validation requise) crée le mouvement de trésorerie inverse et désactive ses affectations, ce qui rouvre les créances. | C (CM §41) |
| BR-FIN-007 | Créance d'une vente = total − Σ affectations actives. Échéance = `due_date` de la vente. Une créance est **en retard** si la date du jour dépasse l'échéance et que le solde est > 0 ; l'alerte `OVERDUE_RECEIVABLE` est levée chaque jour à 07:00. | C (CM §13, §54) / AV-028 |
| BR-FIN-008 | Un acompte est un encaissement affecté à une commande. À la livraison, son affectation est transférée vers la vente créée : affectation commande désactivée, affectation vente créée. | AV-033 |

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
| BR-FIN-022 | Une dépense imputée à un objet de coût crée une écriture de coût (`finance.cost_entries`) à son approbation, ou dès l'enregistrement si aucune validation n'est requise. Une dépense rejetée après paiement reste un décaissement réel : elle est reclassée en catégorie `NON_JUSTIFIEE` et imputée au déclarant pour suivi. | D |

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
| BR-FIN-040 | Le **registre de coûts** (`cost_entries`) est en ajout seul. Chaque écriture porte : objet de coût, type de coût (`ANIMAUX`, `ALIMENT`, `VETERINAIRE`, `AUTRE_INTRANT`, `DEPENSE_DIRECTE`, `AJUSTEMENT`), montant, document source, `occurred_at`. Correction par écriture de sens opposé liée à l'originale. | C (CM §15, §33) / D |
| BR-FIN-041 | Sources automatiques d'écritures de coût : consommations imputées à un lot (valeur de la sortie de stock), mise en place (valeur des animaux d'origine), dépenses imputées. | D |
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

`finance.payment.record`, `finance.payment.read`, `finance.payment.cancel`, `finance.receivable.read`, `finance.cash_session.operate`, `finance.cash_session.validate`, `finance.cash_account.manage`, `finance.cash_transfer.record`, `finance.expense.record`, `finance.expense.approve`, `finance.expense.pay`, `finance.supplier_invoice.record`, `finance.supplier_invoice.approve`, `finance.supplier_payment.record`, `finance.supplier_payment.approve`, `finance.cost.read`, `finance.cost_entry.record`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Commercial terrain avec beaucoup d'espèces non remises | Alerte `CASH_HOLDING_HIGH` si le solde de la caisse utilisateur dépasse un plafond (paramètre, défaut 200 000 XAF) ou si aucune remise n'a eu lieu depuis plus de 3 jours. |
| Encaissement mobile money déclaré mais non reçu sur le compte | Rapprochement manuel par la Finance à partir du relevé opérateur ; annulation de l'encaissement si nécessaire (BR-FIN-006). |
| Facture reçue avant la réception | Enregistrée en `MISMATCH` (quantité facturée > acceptée) jusqu'à réception. |
| Vente annulée déjà payée | Remboursement (mouvement `REFUND`) ou conservation en crédit client (BR-VEN-027). |
