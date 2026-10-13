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
| UC-FIN-07 | Remettre des fonds ; confirmer la réception des fonds ; annuler une remise non reçue (expéditeur) ; clore un écart de remise | `finance.cash_transfer.send`, `receive`, `cancel`, `close_discrepancy` | Détenteur de caisse ; FINANCE | **Oui** (envoi, annulation ; réception possible) |
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
| BR-FIN-013 | Une remise de fonds se fait en deux temps : `TRANSFER_OUT` du montant **envoyé** sur le compte source à l'envoi, `TRANSFER_IN` du montant **reçu** sur le compte destinataire à la réception (aucune entrée pour une réception de 0, remise perdue). Écart = reçu − envoyé (négatif : manque ; positif : excédent). Un écart ouvre la validation `CASH_TRANSFER_DISCREPANCY`, close par la Finance avec imputation et motif **sans second mouvement** : la différence est déjà dans les livres. Le récepteur n'est jamais l'expéditeur ; l'expéditeur seul annule une remise non reçue. Détail : §16. | D (ADR-032 §7) / AV-153, AV-172, AV-175 |
| BR-FIN-014 | Session de caisse : voir D05 (BR-DIS-005 à BR-DIS-008). Seule une caisse de PDV (`CAISSE_PDV`) ouvre une session (AV-165). À l'ouverture, un fonds compté différent du **solde du registre** de la caisse à l'heure d'ouverture (somme des mouvements par `occurred_at`, jamais la projection, ADR-032 §4) produit un mouvement `SESSION_VARIANCE`, à valider avec la session ; cet écart appartient à la période précédente et n'entre pas dans l'attendu de la session (AV-156). | AV-057 / D (ADR-032, P5-12) |

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
| BR-FIN-040 | Le **registre de coûts** (`inventory.cost_entries`, module `inventory`) est en ajout seul. Chaque écriture porte : objet de coût, type de coût (`ANIMAUX`, `OEUFS`, `ALIMENT`, `VETERINAIRE`, `AUTRE_INTRANT`, `DEPENSE_DIRECTE`, `AJUSTEMENT`, `FRAIS_GENERAUX`, `PRODUCTION_TRANSFEREE` ; liste du schéma, complétée en P8-05), montant, document source, `occurred_at`. Correction par écriture de sens opposé liée à l'originale. | C (CM §15, §33) / D |
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
| Encaissement en espèces sur la caisse d'un PDV : session `OPEN` couvrant son heure, en ligne (BR-DIS-005, P5-14 ; hors ligne : avertissement et conflit `CASH_SESSION_MISSING`, AV-184) ; un remboursement n'est jamais refusé pour l'absence de session (AV-186) | `CASH_SESSION_REQUIRED` |
| Désactivation d'un compte : solde nul, aucune session de caisse ouverte (P5-12) | `CASH_ACCOUNT_NOT_EMPTY`, `CASH_ACCOUNT_HAS_OPEN_SESSION` |
| Remise de fonds : comptes connus ; paire de comptes admise (`finance.cash_transfer_allowed_pairs`, refus en ligne seulement) | `CASH_ACCOUNT_INVALID`, `CASH_TRANSFER_PAIR_NOT_ALLOWED` |
| Remise : compte source (envoi, annulation) ou destinataire (réception) dans la portée de l'auteur | `CASH_ACCOUNT_FORBIDDEN` |
| Envoi : porteur connu ; en ligne, compte destinataire actif, solde suffisant d'une caisse physique, référence locale libre | `CASH_TRANSFER_CARRIER_INVALID`, `CASH_ACCOUNT_INACTIVE`, `CASH_INSUFFICIENT`, `LOCAL_REF_DUPLICATE` |
| Réception : récepteur ≠ expéditeur ; en ligne, remise ni annulée ni déjà reçue, pas antérieure à l'envoi (un écart sans politique de validation active n'est jamais refusé : il attend sans demande, AV-183) | `CASH_TRANSFER_SELF_RECEIVE`, `CASH_TRANSFER_CANCELLED`, `CASH_TRANSFER_ALREADY_RECEIVED`, `CASH_TRANSFER_BEFORE_SENT` |
| Clôture d'un écart de remise (`finance.cash_transfer.close_discrepancy`, en ligne) : remise en écart, droit `finance.cash_session.validate` sur le site de la remise, valideur ni expéditeur, ni récepteur, ni porteur, imputation admise, motif ; avec une demande, refus d'`approvals` (auto-approbation) | `ONLINE_REQUIRED`, `NOT_FOUND`, `CASH_TRANSFER_STATUS_INVALID`, `FORBIDDEN_SCOPE`, `CASH_TRANSFER_VALIDATOR_INVOLVED`, `CASH_TRANSFER_IMPUTATION_REQUIRED`, `CASH_TRANSFER_IMPUTATION_INVALID`, `REASON_REQUIRED`, `SELF_APPROVAL_FORBIDDEN` |
| Annulation : par l'expéditeur ; en ligne, remise non reçue | `CASH_TRANSFER_NOT_SENDER`, `CASH_TRANSFER_ALREADY_RECEIVED` |
| Décision d'un écart de remise : écart en attente ; ni rejet ni retrait ; valideur hors expéditeur, récepteur et porteur ; imputation et motif | `CASH_TRANSFER_STATUS_INVALID`, `CASH_TRANSFER_DISCREPANCY_NOT_REJECTABLE`, `CASH_TRANSFER_DISCREPANCY_NOT_WITHDRAWABLE`, `CASH_TRANSFER_VALIDATOR_INVOLVED`, `CASH_TRANSFER_IMPUTATION_REQUIRED`, `CASH_TRANSFER_IMPUTATION_INVALID`, `REASON_REQUIRED` |
| Désactivation d'un compte : aucune remise envoyée en transit depuis ou vers lui | `CASH_ACCOUNT_TRANSFER_IN_TRANSIT` |
| Facture : référence unique par fournisseur | `INVOICE_DUPLICATE` |
| Paiement fournisseur ≤ dette + avance autorisée | `SUPPLIER_PAYMENT_EXCEEDS` |
| Justificatif requis présent | `ATTACHMENT_REQUIRED` |

## 9. Dépendances

ADM, CRM (clients, crédit), VEN (ventes, commandes), STK (valorisation des mouvements), APP (BC, réceptions), PRD (objets de coût), NOT, ANA.

## 10. Événements produits

`PaymentReceived`, `PaymentAllocated`, `PaymentFlaggedDuplicate`, `PaymentCancelled`, `CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected`, `CashSessionValidated`, `CashTransferSent`, `CashTransferReceived`, `CashTransferCancelled`, `CashTransferDiscrepancyDetected`, `CashTransferUnreceived`, `ExpenseRecorded`, `ExpenseApproved`, `ExpenseRejected`, `ExpensePaid`, `SupplierInvoiceRecorded`, `SupplierInvoiceMismatchDetected`, `SupplierInvoiceApproved`, `SupplierPaymentRecorded`, `CostEntryRecorded`, `ReceivableOverdue`.

## 11. Événements consommés

Aucun par le module `finance` (corrigé en P5-15 ; ADR-032 §1 et Conséquences ; ADR-018 ; DÉDUIT) :

- **caisse et remises** : l'attendu d'une session et les remises se lisent sur le registre de trésorerie, écrit dans la transaction de chaque document (`recordCashMovement`, ADR-032 §1) ; aucun événement de vente (`SaleConfirmed`, `SaleCancelled`, `PaymentReceived`) ne sert à calculer une caisse ou une remise ;
- **encaissements, affectations, créances et acomptes** : ils relèvent du module `sales` (§15, P4-08), qui les écrit dans la transaction de la vente, de la commande ou de la livraison ; `finance` ne consomme donc ni `SaleConfirmed`, ni `SaleCancelled`, ni `OrderFulfilled` ;
- **coûts** : le registre de coûts appartient à `inventory` (en-tête), qui écrit les écritures de consommation et de mise en place dans la transaction du mouvement ; une dépense imputée (P8) appellera l'API publique d'`inventory` ;
- **rapprochement fournisseur** (P8) : lecture de l'API publique de `procurement` à l'enregistrement de la facture, sans événement `GoodsReceived` consommé ;
- **décisions** : celles des types de `finance` (`CASH_VARIANCE`, `CASH_TRANSFER_DISCREPANCY` ; `EXPENSE`, `SUPPLIER_PAYMENT`, `INVOICE_MISMATCH` en P8) arrivent par le registre des gestionnaires de décision d'`approvals`, dans la transaction de la décision (ADR-018), non par un événement ; `PAYMENT_DUPLICATE` et `PAYMENT_CANCELLATION` sont décidés par `sales` (§15).

## 12. Fonctionnement hors ligne

- Hors ligne : encaissements (avec ou sans vente), ouverture et clôture de caisse, envoi et annulation d'une remise de fonds, réception d'une remise (en général faite en ligne par la Finance), dépenses payées immédiatement. L'appareil calcule le solde attendu de sa caisse.
- Encaissement en espèces au PDV saisi hors ligne sans session couvrant son heure (P5-14) : appliqué avec avertissement et conflit `CASH_SESSION_MISSING` pour la Finance, résolu par une ouverture synchronisée ensuite, à une heure égale ou antérieure à la sienne (AV-184).
- Remises hors ligne (P5-15) : un envoi qui rend une caisse négative, ou entre deux types de comptes non admis, est appliqué avec avertissement et conflit pour la Finance ; une réception après l'annulation, une annulation après la réception et une seconde réception sont conservées comme observations, sans mouvement (AV-173, §16).
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
| Doublon de référence et décision de la Finance | Référence déjà enregistrée pour ce moyen : `SUSPECT_DUPLICATE`, sans trésorerie ni affectation, cible mémorisée s'il n'y en a qu'une (`intended_sale_id`, `intended_order_id`), validation `PAYMENT_DUPLICATE`, conflit `PAYMENT_REFERENCE_DUPLICATE` non appliqué. Approbation : la Finance donne la référence corrigée (`decisionData.correctedReference` de `approvals.request.approve`) ; sans correction, la référence doit être redevenue libre, sinon refus `PAYMENT_REFERENCE_DUPLICATE` (la demande reste en attente). L'encaissement devient `RECORDED` à son heure d'origine, avec son mouvement de trésorerie, et est affecté à la cible mémorisée dans la limite de son reste (le surplus en crédit). Rejet : `REJECTED`, sans effet. **Revue adverse de P5-23** : la cible mémorisée était ignorée par la décision (affectation automatique aux ventes ouvertes du client, et refus `ALLOCATION_EXCEEDS` pour un encaissement joint à une vente sans client) ; elle est désormais rejouée quand le conflit ne consigne aucune cible saisie (préexistant, P4-04 et P4-08). | BR-FIN-005 ; AV-056 ; AV-135 (défaut implémenté). |
| Annulation d'un encaissement | `sales.payment.request_cancellation` (en ligne, `sales.payment.record`, motif ou commentaire) : `CANCELLATION_REQUESTED`, motif et demande consignés, validation `PAYMENT_CANCELLATION`. Approuvée : affectations renversées (`PAYMENT_CANCELLED`) et compteurs diminués, mouvement de trésorerie **inverse** du mouvement d'origine (même compte, même montant), **daté de l'encaissement d'origine** (P5-14, AV-157 (a) : il retombe dans la fenêtre de sa session, qu'il réévalue si elle est close, cause `REVERSAL`), appliqué même si la caisse passe en négatif (correction, non sortie physique ; un remboursement, lui, est un fait nouveau daté de sa propre date), crédit remis à 0, `CANCELLED`. Rejetée : retour à `RECORDED`, motif et demande effacés de l'encaissement (ils restent sur la demande de validation). Un encaissement en partie remboursé ne s'annule pas (`PAYMENT_PARTIALLY_REFUNDED`, AV-151). Un encaissement qui règle une vente **sans client saisie en ligne** ne s'annule pas non plus (`PAYMENT_ANONYMOUS_SALE`, à la demande et à la décision, P5-23) : la vente resterait due sans personne à qui réclamer le solde (INV-VEN-07) ; annuler la vente, ou la régler autrement, d'abord (**À VALIDER**, AV-188 (a)). | BR-FIN-006 ; SM-CUSTOMER-PAYMENT ; CHECK de la table (motif seulement en demande ou annulé). |
| Réaffectation (`sales.payment.reallocate`, Finance, en ligne) | `release[]` libère des affectations d'une cible (cause `REALLOCATED`, la part conservée est recréée), `allocate[]` affecte le crédit (libéré compris) à d'autres ventes ou commandes du client, aux mêmes contrôles que la saisie en ligne ; le crédit restant est réécrit en un `UPDATE`. Permission nouvelle `sales.payment.reallocate` (Finance, `ALL`). | UC-FIN-03 ; BR-FIN-003, 004. La permission manquait au référentiel RBAC. |
| Remboursement d'un crédit (`sales.payment.refund`, Finance, en ligne) | Rembourse tout ou partie de la part non affectée d'un encaissement `RECORDED` : mouvement `REFUND` (`SALE_REFUND`, pièce source = l'encaissement) depuis le compte d'origine ou celui désigné, jamais en négatif pour une caisse (BR-FIN-012) ; `unallocated_xaf` baisse et `refunded_xaf` monte. Permission nouvelle `sales.payment.refund` (Finance, `ALL`). | BR-FIN-003 ; D09 §14 (vente annulée déjà payée) ; UC-FIN-15. |
| Ordre des verrous | Commandes, puis ventes (identifiant croissant), puis les affectations de l'encaissement, puis l'encaissement, puis le compte de trésorerie, puis le compteur de numéros `ENC` : celui des encaissements joints à une vente et de l'annulation d'une vente (`sale-cancellation.ts`). | D04 §15 (« Ordre des verrous de `sales` »). |
| Revue adverse de P4-08 (07/10/2026) | Validation d'une annulation refusée si une part a été remboursée depuis la demande (`PAYMENT_PARTIALLY_REFUNDED`, sinon double décaissement) ; un encaissement en demande d'annulation garde ses affectations recréables (confirmation d'une commande, annulation partielle d'une vente : migration `20261007090000`) ; hors ligne, la part non affectable reste en crédit avec l'avertissement `PAYMENT_UNALLOCATED` et un conflit appliqué pour la Finance ; doublon validé : les cibles et montants saisis (consignés dans le conflit) sont rejoués, la référence corrigée ne dépasse pas 80 caractères (`PAYMENT_REFERENCE_INVALID`) et le conflit est résolu ; une cible citée deux fois est refusée (`ALLOCATION_INVALID`) ; `reallocate`, `refund` et `request_cancellation` en ligne seulement (`ONLINE_REQUIRED`) ; remboursement depuis la caisse personnelle d'un autre : `CASH_ACCOUNT_FORBIDDEN` ; une demande retirée permet une nouvelle demande ; inverse d'un mouvement et fait passé validé appliqués même sur un compte désactivé depuis ; plafond de l'acompte lu en verrou. | BR-FIN-003 à 006 ; BR-SYN-007 ; AV-135, AV-150, AV-151. |
| CA, coût des ventes et marge d'une période (P4-09) | `periodRevenue` (`sales`, API publique) : CA brut = Σ `total_xaf` des ventes dont `occurred_at` est dans la période ; annulé = Σ `cancelled_total_xaf` des documents d'annulation **appliqués** dans la période (`applied_at`) ; coût des ventes = Σ valeurs figées des mouvements `SALE` de la période − Σ des retours `CUSTOMER_RETURN` de la période (lus par l'API publique d'`inventory`, `saleCostsInPeriod`) ; marge brute = CA net − coût. Filtres : sites, commercial attributaire, clients. Bornes : début du premier jour métier inclus, fin du dernier exclue. | BR-FIN-042, BR-FIN-043 ; ADR-010 (jamais stocké). DÉDUIT : bornes en jours métier (Africa/Douala). |
| CA et marge d'un lot (P4-09) | `lotRevenue` : le montant de chaque ligne de vente est partagé entre ses mouvements `SALE` au prorata des quantités, au franc près et sans dérive (`splitAmountXaf`, `packages/domain`) ; une annulation retire, au mois de son retour, la part de chaque retour (montant de la ligne d'annulation partagé de même). Le coût des ventes d'un lot est la valeur figée de ses mouvements (CMUP du produit, ou coût par tête d'un lot biologique). La fiche d'un lot de production (`GET /production/lots/{id}`) ajoute `sales` : CA brut, annulé, net, coût des ventes, quantité vendue nette, **marge de lot** (CA net − coût du lot) et **marge brute des ventes** (CA net − coût des ventes), et le CA mensuel du résultat (`costs.monthly[].revenueXaf`, AV-109) ; montants masqués sans droit de valorisation (RC-05). | Stratégie finance §6.2-6.3 (« les deux indicateurs sont affichés et libellés »). DÉDUIT : partage au prorata des quantités, arrondi au franc par cumul. |
| Créances par ancienneté et tâche des retards (P4-09) | `listReceivables` : ventes non annulées au solde dû positif, échéance, jours de retard et tranche (`receivableAging`), l'échéance la plus ancienne d'abord, filtres client, site, commercial, échues seulement ; `summarizeReceivables` : total, échu, montant par tranche. Tâche `sales.receivables.overdue_daily` (processus worker) : un événement `ReceivableOverdue` par vente échue et par jour métier (rejouable sans doublon) ; l'alerte `OVERDUE_RECEIVABLE` qui le consomme et la planification à 07:00 relèvent de P9 et du déploiement. | BR-FIN-007 ; AT-032 (alerte : P9). |
| Réalisé des objectifs commerciaux (P4-09) | `GET /performance/commercial` : objectif `CA` = CA net des ventes attribuées au commercial (`commercial_user_id`) sur la période demandée ; `QTE_PRODUIT` = quantité nette du produit (lignes des ventes de la période − annulations appliquées dans la période, unité de base, `periodProductQuantity`). | D02 (objectifs) ; BR-VEN-020 ; BR-FIN-042. |
| Sessions de caisse (P5-12) | Ouverture, clôture et clôture forcée, écarts d'ouverture et de clôture, fusion et observation hors ligne, index `cash_session_id` posé par `recordCashMovement` (inverse : index de l'original), gardes de désactivation, tâche `finance.cash_sessions.open_long_check` : voir D05 §15. | ADR-032 ; AV-154 à 157, AV-165, AV-167 à 170. |
| Encaissements et sessions de caisse (P5-14) | Encaissement en espèces `RECORDED` sur une caisse de PDV : session exigée en ligne (`CASH_SESSION_REQUIRED` : refus précoce à la planification, puis contrôle repris sous le verrou du compte après l'écriture du mouvement ; index nul, toute la transaction est annulée ; clôture concurrente datée après l'heure de l'encaissement, session close réévaluée), constat `CASH_SESSION_MISSING` hors ligne seulement, résolu par une ouverture datée à l'heure de l'encaissement ou avant ; index de session recopié sur l'encaissement (à l'insertion, ou à l'approbation d'un doublon suspect `PAYMENT_DUPLICATE`, qui n'est soumise à aucune session : sans session couvrante, index nul, ni refus ni constat) et, pour une vente directe seulement, sur la vente (D05 §15). Remboursement en espèces (`sales.payment.refund`, annulation d'une vente) : jamais refusé faute de session, daté de sa propre date, rattaché à la session qui la couvre s'il y en a une, sans conflit (AV-186). Inverse d'une annulation d'encaissement daté de l'original (AV-157). | BR-DIS-005 ; ADR-032 §2 ; AV-157, AV-184, AV-186 |

## 16. Remises de fonds : choix d'implémentation (P5-15)

Commandes `finance.cash_transfer.send`, `.receive`, `.cancel` (`cash-transfer-commands.ts`), décision `CASH_TRANSFER_DISCREPANCY`, tâche `finance.cash_transfers.unreceived_check`, lectures publiques `findCashTransfer`, `cashTransfersInTransit`, `verifyCashTransfers` ; règles pures partagées avec l'appareil dans `packages/domain` (`cash-transfer.ts`). Classement : **DÉDUIT**, sauf mention.

| Point | Choix | Justification |
|---|---|---|
| Charges utiles | Agrégat `CASH_TRANSFER` (identifiant de la remise choisi par l'appareil). `send` : `fromAccountId`, `toAccountId`, `amountXaf` (> 0), `carrierUserId?` ou `carrierName?`, `comment?`, `localRef?` (≤ 20) ; `receive` : `receivedXaf` (≥ 0), `comment?` ; `cancel` : `reason` ; `close_discrepancy` (P5-23) : `imputation` (`SENDER`, `CARRIER`, `RECEIVER` ou `COMPANY`), `reason`, réponse `cashTransferId`, `status`, `imputation`, `approvalRequestId?`. Réponse de l'envoi : `docNumber`. Le commentaire d'envoi n'a pas de colonne : il est tracé par l'audit (état après) ; le commentaire de réception aussi, et dans le résumé de la demande de validation. | `packages/contracts/src/distribution-commands.ts` ; R5. |
| Permission et portée | Une seule permission, `finance.cash_transfer.record`, évaluée sur le compte concerné : compte source pour l'envoi et l'annulation, compte destinataire pour la réception (`CASH_ACCOUNT_FORBIDDEN`, §8). Le détenteur d'une caisse personnelle en est propriétaire (RBAC §3) : il lui suffit de détenir la permission, quel que soit le périmètre de son affectation (une caisse personnelle n'a ni site ni zone, que l'intersection de `evaluateAccess` refuserait) ; tout autre compte est évalué par `evaluateAccess` sur sa ressource (responsable, site). | AV-158 (a), AV-172 ; D09 §8. |
| Paires de comptes | Paramètre `finance.cash_transfer_allowed_pairs` lu à `occurred_at`, repli sur `DEFAULT_CASH_TRANSFER_PAIRS` (liste complète dans AV-158). Paire refusée : rejet en ligne `CASH_TRANSFER_PAIR_NOT_ALLOWED` ; **hors ligne, fait appliqué** avec l'avertissement du même nom et un conflit informatif (l'argent a déjà quitté la caisse). | **À VALIDER** (AV-158) ; BR-SYN-007 ; ADR-032 §8. |
| Envoi | `TRANSFER_OUT` du montant par `recordCashMovement` ; en ligne, une caisse physique ne devient jamais négative (`CASH_INSUFFICIENT`) ; hors ligne, sortie appliquée, avertissement `CASH_NEGATIVE` et conflit appliqué `CASH_NEGATIVE` (entité `CASH_ACCOUNT`, Finance). En ligne, compte destinataire inactif refusé. Même agrégat renvoyé : sans effet, numéro existant. `cash_session_id` reste vide : l'attendu se calcule par fenêtre (ADR-032 §2), l'index est posé par P5-12. | BR-FIN-012 ; ADR-032 §2. |
| Référence locale | Unique par appareil : en ligne `LOCAL_REF_DUPLICATE` ; hors ligne, remise appliquée sans sa référence, avertissement `LOCAL_REF_DUPLICATE` (comme une vente, P5-07). | BR-SYN-007. |
| Numérotation | `RMF-{CODE}-{AAAA}-{seq6}` : site du compte source, à défaut du destinataire (la remise porte ce site) ; sans site, série globale de code `finance.cash_transfer_series_code` (validé, `SIEGE` par défaut) ; la remise n'a alors pas de site. **Le compteur est clé par le code de la série** (identifiant déterministe tiré du seul code, ADR-031), jamais par l'identifiant d'un site : numéro et compteur se correspondent un pour un, donc aucun doublon, que le site réel du même code existe avant les premières remises de la série globale ou soit créé après (revue adverse P5-15 ; le code d'un site est unique et ne change pas). Année = jour métier de Douala. | **À VALIDER** (AV-176) ; AV-077. |
| Réception | `TRANSFER_IN` du montant reçu (aucun pour 0) ; écart = `transferDiscrepancyXaf`, état = `transferStatusAfterReceive`. Écart ≠ 0 : demande `CASH_TRANSFER_DISCREPANCY` (sujet `CASH_TRANSFER`, montant = \|écart\|, demandeur = récepteur), événement `CashTransferDiscrepancyDetected`, avertissement `CASH_TRANSFER_DISCREPANCY`. Politique : la plus récente active à `occurred_at` (hors ligne, repli à la réception serveur) qui exige une validation et nomme un approbateur ; sans elle, **aucune demande** et aucun refus, en ligne comme hors ligne (`approval_request_id` vide) : l'écart se clôt directement (AV-183, harmonisé en P5-23 avec la clôture d'une session de caisse ; P5-15 refusait `CONTROL_POLICY_MISSING`). Aucun `SESSION_VARIANCE` : pour 173 000 envoyés et 170 000 reçus, la source est débitée de 173 000. En ligne, une réception antérieure à l'envoi est refusée ; hors ligne, l'heure est conservée (ADR-016). | ADR-032 §7 ; AV-153, AV-174, AV-175. |
| Décision de l'écart | Gestionnaire enregistré auprès du registre d'`approvals` : `DISCREPANCY_PENDING` → `CLOSED`, imputation = `decisionOption`, motif = `decisionData.reason`, `closed_by` / `closed_at` = décideur et date de décision, **aucun mouvement**. Rejet et retrait refusés (garde de retrait d'`approvals`) ; valideur ni expéditeur, ni récepteur, ni porteur ; `CARRIER` exige un porteur connu. | **À VALIDER** (AV-174) ; ADR-018. |
| Clôture d'un écart (P5-23) | `finance.cash_transfer.close_discrepancy` (en ligne, droit `finance.cash_session.validate` — celui de l'approbateur de la politique semée — évalué sur le site de la remise, à défaut celui du compte destinataire) : comme `finance.cash_session.validate`, **façade** de la décision quand l'écart a sa demande (`decideApprovalRequest` : auto-approbation, droit d'approbation, puis le gestionnaire ci-dessus), **clôture directe** sinon, avec les mêmes contrôles et le même effet (aucun mouvement). La remise est verrouillée sous ses comptes avant la demande, mise à jour en fin de décision (ADR-038, N10 puis N13). Audit : état avant (`DISCREPANCY_PENDING`, écart), état après (imputation, motif, valideur, date). `verifyCashTransfers` admet une remise en écart ou close sans demande. | **À VALIDER** (AV-183) ; ADR-032 §7. |
| Annulation | Expéditeur seul, depuis `SENT`, hors ligne possible. **Inverse comptable** de la sortie (même compte, montant, type et document, sens `IN`, lien `reverses_movement_id`) mais **fait physique nouveau, daté de l'annulation** : il tombe dans la session couvrant sa propre date, par exception à la règle générale « un inverse porte l'`occurred_at` de l'original » (ADR-032 §2, dernière phrase, et AV-157 (a) nomment la remise annulée parmi les faits nouveaux). Conséquence pour P5-13 et P5-22 : la session d'un mouvement se détermine **toujours par son `occurred_at`**, jamais par le lien d'inverse. Seconde annulation : sans effet. Admis même vers un compte désactivé depuis (correction). | ADR-032 §2 ; AV-157 (a), AV-172. |
| Courses hors ligne | Une seule table de transitions (`decideCashTransferAction`) : réception après annulation, annulation après réception, seconde réception → observation (conflit informatif appliqué, propriétaire Finance, détails : montant ou motif, auteur, appareil, heure, état trouvé), avertissement du même code, aucun mouvement, remise inchangée ; en ligne, refus. | ADR-032 §8 ; AV-173. |
| Ordre des verrous | Réception, annulation, décision : les deux comptes de la remise, dans l'ordre croissant (ADR-038, P5-22), puis la ligne de la remise (`FOR UPDATE`) — l'ordre inverse s'interbloquait avec un envoi depuis la même caisse. Envoi : les deux comptes, dans l'ordre croissant de leur identifiant (l'état du destinataire est lu sous verrou : une désactivation concurrente est sérialisée ; deux remises croisées ne s'interbloquent pas) → compteur `RMF` → insertion de la remise. Réception et annulation concurrentes d'une même remise : une seule passe. Les tests de concurrence propres aux remises sont livrés ici ; P5-22 garde l'écriture de l'ordre complet (D04 §15, D06, D09) et les scénarios qui croisent modules ou sessions. | ADR-032 §10. |
| Ordre de verrouillage global (P5-22) | [ADR-038](../../decisions/ADR-038-ordre-de-verrouillage-global.md) : comptes de trésorerie d'une opération verrouillés en une passe triée (`lockCashAccounts`, publique) avant le premier mouvement — remboursements d'une annulation compris —, après le stock, les affectations et les encaissements ; sessions et ajustements sous le verrou de leur compte ; compteur `ENC`, `RMF` juste avant le document. | ADR-038 ; ADR-032 §10. DÉDUIT. |
| Garde de désactivation | `finance.cash_account.deactivate` refuse `CASH_ACCOUNT_TRANSFER_IN_TRANSIT` tant qu'une remise `SENT` part du compte ou y arrive (elle ne pourrait plus être reçue en ligne). | Dictionnaire `finance.cash_accounts`. |
| Indicateur « en transit » | `cashTransfersInTransit` : remises `SENT` filtrées par comptes (source ou destinataire) ou sites — nombre, somme (`cashInTransitXaf`), envoi le plus ancien, nombre et somme en retard au-delà de `finance.cash_transfer_unreceived_hours`, détail par compte source et destinataire. Fonction unique réutilisée par P5-19 et P5-20. | BR-ANA-009. |
| Alerte à 48 h | Tâche `finance.cash_transfers.unreceived_check` : un `CashTransferUnreceived` par remise `SENT` en retard et par jour métier (rejouable), délai lu à l'exécution (entier > 0, sinon 48). L'alerte NOT `CASH_TRANSFER_NOT_RECEIVED` qui le consomme relève de P9, la planification de l'ordonnanceur ou du déploiement. | **À VALIDER** (AV-158) ; D13 §7.1. |
| Cohérence | `verifyCashTransfers` (lecture seule) : une sortie du montant envoyé ; une entrée du montant reçu si et seulement si la remise est reçue d'un montant > 0 ; l'inverse de la sortie si et seulement si elle est annulée ; aucun autre mouvement ne cite la remise ; écart en attente ⇔ demande en attente, écart clos ⇔ demande approuvée. Branchée dans `finance.cash.reconcile_daily` (P5-22), avec `verifyCashLedger` et `verifyCashSessions` (sessions de caisse : INV-FIN-05, 06, 11, BR-DIS-006 ; lectures sans verrou) sur un même instantané ; un écart fait échouer la tâche (message par section, cinq détails au plus) après journalisation, l'alerte `CASH_MISMATCH` relevant de P9. | INV-FIN-01, INV-FIN-02. |
| Hors ligne réel | Depuis P5-18, le jeu `cash` de l'appareil contient les remises en cours (`CASH_TRANSFER`) et les comptes destinataires sans solde, caisse centrale comprise (`CASH_TRANSFER_TARGET`, AV-197) ; le paramètre des paires est publié dans le jeu `me` (AV-196). Les écrans de la PWA restent à livrer : d'ici là, seul le harnais de test envoie des remises hors ligne. Une remise hors ligne vers un compte désactivé ne se reçoit pas en ligne : l'expéditeur l'annule et renvoie vers un compte actif. | Plan §4 (P5-18). |
| Lectures HTTP (P5-17) | `GET /cash-sessions(/{id})` et `GET /cash-transfers(/{id})` : droit `finance.cash.read` (comme `GET /cash-accounts`), portée du **compte** : une session est visible si sa caisse l'est, une remise si l'un de ses deux comptes l'est. La fiche de session porte ses ajustements et les flux de sa fenêtre avec les sous-totaux par vendeur, celle de la remise ses mouvements. Lectures publiques `listCashSessions`, `findCashSessionDetail`, `listCashSessionAdjustments`, `listCashTransfers`, `cashTransferMovements`. Conséquence : le Resp. commercial, qui envoie des remises (`finance.cash_transfer.record`, `OWN`), ne les relit pas faute de `finance.cash.read`. | **DÉDUIT** ; AV-189, AV-187. |

## 17. Finance opérationnelle : choix d'implémentation (P8)

> Conception arrêtée le 13/10/2026 : [ADR-060](../../decisions/ADR-060-depenses-p8.md) (dépenses), [ADR-061](../../decisions/ADR-061-factures-et-paiements-fournisseurs-p8.md) (factures, paiements, dettes, verrous), [ADR-062](../../decisions/ADR-062-couts-complets-et-marges-p8.md) (coûts complets, marges, pertes, vue d'ensemble). Points ouverts : AV-350 à AV-366, défauts paramétrables, aucun bloquant. Les sections ci-dessus (§4, §7.3 à 7.5, §12) restent la règle ; celle-ci dit comment P8 les applique.

- **Seuils** (AV-058) : `finance.expense_approval_threshold_xaf` (50 000), `finance.expense_photo_threshold_xaf` (10 000), `finance.pos_expense_max_xaf` (50 000, AV-353), `finance.supplier_payment_approval_xaf` (500 000, AV-055), tolérances de rapprochement nulles (AV-053) ; comparaisons strictes ; politiques `EXPENSE_DEFAULT`, `INVOICE_MISMATCH_DEFAULT`, `SUPPLIER_PAYMENT_DEFAULT` (qui approuve).
- **Dépense payée depuis la caisse d'un PDV** : catégorie `allowed_on_pos`, plafond, session ouverte exigée comme pour un encaissement (AV-354) ; hors ligne, `CASH_SESSION_MISSING` résolu à l'ouverture.
- **Hors ligne** (§12, AV-352) : saisie payée ou non ; une règle que seul le serveur juge (catégorie, PDV, justificatif, objet de coût) place la dépense en validation a posteriori au lieu de la rejeter (BR-SYN-007).
- **Rejet après paiement** (BR-FIN-022, AV-355) : catégorie système `NON_JUSTIFIEE`, responsabilité du déclarant enregistrée, aucune écriture de coût.
- **Coût des objets** (BR-FIN-041, AV-356, AV-357) : `recordCostEntry` d'`inventory`, source `EXPENSE` ; lot ou lot d'incubation : type de coût de la catégorie (défaut `DEPENSE_DIRECTE`) ; site avec espèce : `FRAIS_GENERAUX` répartis (ADR-026) ; site sans espèce : dépense directe du site.
- **Factures** (BR-FIN-030, 031) : rapprochement par `matchSupplierInvoice` (`packages/domain`) ; facture sans BC en revue (AV-358) ; quantités facturées écrites par `procurement` à l'approbation (§11 : `finance` appelle l'API publique de `procurement`, qui reste propriétaire de `invoiced_qty_base`) ; avoir = annulation motivée et facture rectificative (AV-359).
- **Paiements** (BR-FIN-032, 033) : au-delà du seuil, affectations `PLANNED` et décaissement à la validation de la Direction (AV-363) ; sans politique `SUPPLIER_PAYMENT`, refus `CONTROL_POLICY_MISSING` (commande en ligne, rien n'est décaissé) ; avance admise et affectable plus tard (AV-362) ; annulation d'un paiement en attente par son auteur, d'un paiement décaissé par la Direction (AV-364) ; moyen de paiement compatible avec le compte et référence exigée par le moyen (AV-056).
- **Numérotation** : `DEP` par site ; `FF` et `PF` sur la série globale `finance.supplier_series_code`, comme les remises de fonds (§16).
- **Lectures** : `GET /expenses`, `/supplier-invoices`, `/supplier-payments`, `/payables` (`finance.payable.read`, AV-365), `/finance/overview` (AT-040), `/inventory/losses/summary` (AT-041).
