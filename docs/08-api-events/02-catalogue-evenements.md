# Catalogue des événements (Livrable n°10)

> Section 23 du format final (PM §48). Décision : ADR-011 (outbox transactionnelle `platform.domain_events`, pas d'event sourcing).

---

## 1. Quatre natures de messages à ne pas confondre (PM §33)

| Nature | Support | Écrit par | Lu par | Garantie | Exemple |
|---|---|---|---|---|---|
| **Événement métier** | `platform.domain_events` (outbox transactionnelle) | Gestionnaire de commande, dans sa transaction | Worker : alertes, projections, Kommo, réactions interdomaines | Au moins une fois ; consommateurs idempotents (position + clé) | `SaleConfirmed` |
| **Journal d'audit** | `audit.audit_log` | Tout module, dans la transaction | Humains (enquête, contrôle) | Exactement une fois (transaction) | `sales.sale.cancel` par Awa depuis PDV2 |
| **Événement d'intégration** | `integrations.outbox_messages` / `inbox_messages` | Adaptateur Kommo | Kommo / GIC | Au moins une fois ; idempotence par clé | `contact.upsert` vers Kommo |
| **Message de synchronisation** | Commandes (`sync.command_inbox`) et flux (`sync.change_feed`) | Appareils / serveur | Serveur / appareils | Exactement une fois (inbox) ; téléchargement idempotent (`row_version`) | Commande `sales.sale.record` ; changement du jeu `stock` |

Principes :

1. Les tables métier restent **la** source de vérité. Les événements sont des notifications de faits, pas un stockage d'état : on ne reconstruit pas l'état à partir d'eux.
2. Les **effets indispensables à la cohérence** (stock, trésorerie, réservation, conversion du prospect) sont faits **de manière synchrone**, dans la transaction, via l'API interne du module propriétaire. Les événements portent les effets **secondaires** tolérant un délai de quelques secondes : alertes, notifications, Kommo, projections analytiques, écritures de coût issues d'une dépense approuvée.
3. Chaque événement a une version (`event_version`) ; un consommateur ignore une version inconnue et lève une alerte technique.
4. Données minimum : identifiants et valeurs utiles aux consommateurs. Pas de données personnelles inutiles.

Enveloppe commune (toujours présente, non répétée ci-dessous) : `event_id`, `event_type`, `event_version`, `producer_module`, `aggregate_type`, `aggregate_id`, `occurred_at`, `recorded_at`, `actor_user_id`, `device_id`, `site_id`, `command_id`, `correlation_id`.

Consommateurs, en abrégé : **NOT** (alertes et notifications), **ANA** (projections, instantanés), **KOM** (intégration Kommo), **CRM**, **VEN**, **FIN**, **STK**, **PRD**.

## 2. Catalogue

### 2.1 Identité et organisation (producteurs : `identity`, `organization`)

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `UserCreated`, `UserUpdated` | identity | KOM (correspondance), ANA | `user_id`, rôles | Référentiel à jour |
| `UserDeactivated` | identity | NOT, STK, CRM, FIN | `user_id`, `effective_at` | Alertes : portefeuille, stock mobile et caisse à régulariser ; sessions révoquées |
| `UserReactivated` | identity | — | `user_id` | — |
| `RoleAssigned`, `RoleAssignmentRevoked` | identity | SYN (périmètres), NOT | `user_id`, `role_code`, `scope` | Recalcul des périmètres de synchronisation (`SCOPE_EXIT` éventuels) |
| `RolePermissionsChanged` | identity | SYN | `role_id` | Invalidation du cache des droits |
| `DeviceEnrollmentRequested` | identity | NOT | `device_id`, `user_id` | Notification aux approbateurs |
| `DeviceApproved` | identity | NOT | `device_id` | L'utilisateur peut synchroniser |
| `DeviceBlocked`, `DeviceDeclaredLost` | identity | STK, SYN, NOT | `device_id`, `effective_at` | Allocations `REVOCATION_PENDING` ; quarantaine des commandes postérieures |
| `SessionRevoked` | identity | — | `session_id`, raison | — |
| `SiteCreated`, `SiteUpdated`, `SiteClosed` | organization | ANA, SYN | `site_id` | Référentiels |
| `LocationCreated`, `LocationUpdated`, `LocationDeactivated` | organization | SYN, STK | `location_id` | — |
| `ZoneCreated`, `ZoneUpdated` | organization | SYN, PRX | `zone_id`, géorepère | Nouveaux géorepères pour les pointages futurs |
| `TeamMembershipChanged` | organization | SYN, ANA | `team_id`, `user_id` | Périmètres `TEAM` |
| `SystemSettingChanged` | organization | SYN | `key` | Téléchargement si visible côté client |

### 2.2 Contrôle, pièces jointes, catalogue, tarification

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `ControlPolicyChanged` | approvals | SYN | `policy_id`, version | Téléchargement |
| `ApprovalRequested` | approvals | NOT | `approval_id`, `operation_type`, `subject`, `amount_xaf`, `site_id` | Notification aux approbateurs du périmètre |
| `ApprovalGranted`, `ApprovalRejected` | approvals | Module propriétaire du sujet (STK, VEN, FIN, APP, TER, PRD), NOT | `approval_id`, `subject`, `decision_option`, `decided_by` | Le module exécute la transition de son document (réaction idempotente) ; notification au demandeur |
| `ApprovalCancelled` | approvals | NOT | `approval_id` | — |
| `AttachmentRegistered` | attachments | — | `attachment_id`, `owner` | — |
| `AttachmentUploaded` | attachments | approvals, NOT | `attachment_id` | Déblocage d'une validation en attente de pièce |
| `AttachmentUploadFailed` | attachments | NOT | `attachment_id`, cause | Nouvel essai demandé à l'auteur |
| `ProductCreated`, `ProductUpdated`, `ProductReactivated` | catalog | SYN, KOM | `product_id` | Catalogue |
| `ProductDeactivated` | catalog | SYN, PRX, NOT | `product_id` | Alerte si des règles actives ou des soldes restent |
| `ProductStandardCostChanged` | catalog | STK | `product_id`, coût | Valorisation des productions futures |
| `ReasonCodeChanged` | catalog | SYN | `reason_code_id` | — |
| `PriceRuleDrafted` | pricing | — | `rule_id` | — |
| `PriceRuleActivated` | pricing | SYN, NOT (note automatique), KOM | `rule_id`, produit, prix, dimensions, `valid_from` | Téléchargement vers les appareils concernés ; note de direction (BR-PRX-012) |
| `PriceRuleSuperseded`, `PriceRuleEnded` | pricing | SYN | `rule_id`, `valid_to` | — |
| `CommercialCampaignCreated` | pricing | SYN | `campaign_id` | — |

### 2.3 CRM et pointage

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `ProspectCreated` | crm | ANA, KOM (si lié) | `customer_id`, `acquired_by`, `zone_id`, `source` | KPI « prospects créés » ; création du contact Kommo si demandé |
| `CustomerUpdated` | crm | KOM | `customer_id`, champs modifiés | Mise à jour du contact Kommo (anti-boucle) |
| `ProspectStepChanged` | crm | ANA | `customer_id`, `from`, `to` | Suivi du pipeline |
| `CustomerConverted` | crm | ANA, KOM, NOT | `customer_id`, `sale_id`, `converted_at`, titulaire | KPI conversions ; stade client dans Kommo |
| `ProspectLost`, `ProspectReopened` | crm | ANA, KOM | `customer_id`, motif | — |
| `CustomerReassigned` | crm | SYN (`SCOPE_EXIT`), KOM, NOT | `customer_id`, ancien et nouveau titulaire | Téléchargement ou retrait ; responsable Kommo ; notification |
| `CustomerMerged` | crm | KOM, ANA | `kept_id`, `merged_id` | Liens externes rattachés |
| `CustomerCreditTermsChanged` | crm | SYN | `customer_id` | Contrôle du crédit hors ligne |
| `VisitRecorded`, `VisitCancelled` | crm | ANA, NOT (`far_from_customer`) | `visit_id`, `customer_id`, `user_id`, drapeaux | KPI visites |
| `InteractionRecorded` | crm | ANA | `interaction_id` | — |
| `SalesTargetSet` | crm | ANA | `target_id` | Suivi des objectifs |
| `CheckInAccepted`, `CheckInRejected` | fieldwork | ANA, NOT (rejets répétés) | `checkin_id`, résultat, distance | Audit de présence |
| `CheckInOverrideRequested` | fieldwork | NOT (via `ApprovalRequested`) | `session_id` | — |
| `CheckInSuspicious` | fieldwork | NOT | `checkin_id`, signaux | Alerte `CHECKIN_SUSPICIOUS` |
| `WorkSessionStarted`, `WorkSessionEnded`, `WorkSessionAutoClosed` | fieldwork | ANA | `session_id`, `user_id` | KPI présence ; levée de `INACTIVE_COMMERCIAL` |

### 2.4 Ventes et encaissements (producteur : `sales`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `OrderDrafted` | — | `order_id` | — |
| `OrderConfirmed` | ANA, KOM, NOT (réservation incomplète) | `order_id`, `customer_id`, commercial, total, statut de réservation | KPI commandes ; statut de commande Kommo ; alerte au magasinier |
| `OrderUpdated`, `OrderCancelled`, `OrderClosed` | ANA, KOM | `order_id`, statut | — |
| `OrderPartiallyFulfilled`, `OrderFulfilled` | ANA, KOM | `order_id`, `sale_id` | — |
| `SaleConfirmed` | CRM (conversion ; le premier achat est aussi traité de façon synchrone), ANA, KOM, NOT (seuils) | `sale_id`, `customer_id`, commercial, vendeur, canal, zone, site, total, statut de paiement, `occurred_at`, lignes (produit, quantité, lot, montant) | CA ; performances ; profil Kommo |
| `SaleCancellationRequested` | NOT (via `ApprovalRequested`) | `sale_id` | — |
| `SaleCancelled` | CRM, ANA, KOM | `sale_id`, `cancelled_at` | CA négatif à la date d'annulation ; profil Kommo |
| `PriceOverrideApplied` | NOT, ANA | `sale_line_id`, écart | Suivi des remises |
| `PriceMismatchDetected` | NOT | `sale_id`, prix figé, prix serveur | Alerte `PRICE_MISMATCH` |
| `CreditLimitExceeded` | NOT (via approbation) | `sale_id`, encours | — |
| `PaymentReceived` | ANA, KOM, NOT | `payment_id`, montant, moyen, client | KPI encaissé ; CA cumulé Kommo |
| `PaymentAllocated` | ANA | `payment_id`, `sale_id` ou `order_id`, montant | Statut de paiement (écrit de façon synchrone ; l'événement ne sert qu'aux projections) |
| `PaymentFlaggedDuplicate` | NOT | `payment_id`, référence | Alerte `DUPLICATE_SUSPECTED` |
| `PaymentCancelled` | ANA, KOM | `payment_id` | — |

### 2.5 Stock (producteur : `inventory`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `StockTransferRequested` | NOT | `transfer_id`, source, destination | Notification à l'expéditeur |
| `StockTransferDispatched` | NOT, ANA | `transfer_id`, lignes | Notification au destinataire ; KPI « envoyé » |
| `StockTransferReceived` | ANA | `transfer_id`, reçu | KPI « reçu » |
| `StockTransferDiscrepancyDetected` | NOT | `transfer_id`, écart, valeur | Validation ; alerte |
| `StockTransferDiscrepancyResolved` | ANA | `transfer_id`, décision | — |
| `StockTransferCancelled` | NOT | `transfer_id` | — |
| `StockTransferUnmatched` | NOT | `transfer_id` (réception sans document) | Alerte `TRANSFER_UNMATCHED` |
| `StockAllocated`, `StockAllocationReleased`, `StockAllocationRevoked` | SYN, NOT | `allocation_id`, détenteur | Téléchargement du quota |
| `StockReservationChanged` | VEN | `order_line_id`, réservé | Statut de réservation de la commande |
| `StockLossDeclared` | NOT (`HIGH_LOSS`), ANA | `loss_id`, catégorie, produit, lot, quantité, valeur, emplacement, statut | Alerte immédiate si anormal ; KPI pertes |
| `StockLossApproved`, `StockLossRejected` | PRD (indicateurs du lot), ANA, NOT | `loss_id`, décision | — |
| `ConsumptionRecorded` | ANA | `consumption_id`, objet de coût, valeur | Le coût est écrit de façon synchrone au registre ; l'événement sert aux projections |
| `InventoryCountOpened`, `InventoryCountSubmitted` | NOT | `count_id`, écarts | Alerte `INVENTORY_VARIANCE` |
| `InventoryAdjusted` | ANA, NOT | `count_id`, écarts nets, valeur | KPI écarts |
| `InventoryCountReconciled` | ANA | `count_id`, ajustement | — |
| `StockThresholdBreached` | NOT | emplacement, produit, disponible, seuil | Alertes `STOCK_LOW`, `STOCK_OUT`, `POS_REPLENISH` |
| `StockNegativeDetected` | NOT, SYN (conflit) | emplacement, produit, solde | Alerte `STOCK_NEGATIVE` |
| `ProductValuationChanged` | ANA | `product_id`, CMUP | — |
| `CostEntryRecorded` | ANA | objet, type, montant | KPI coûts |

### 2.6 Production (producteur : `production`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `ProductionLotCreated` | ANA | `lot_id`, type, site | — |
| `LotEntryRecorded` | ANA | `lot_id`, type d'entrée, quantité | Effectif ; coût (écrit de façon synchrone) |
| `MortalityRecorded` | NOT (`HIGH_MORTALITY`), ANA | `lot_id`, quantité, effectif de référence, `loss_id` | Alerte immédiate. **Même fait** que `StockLossDeclared` catégorie `MORTALITE` : un consommateur s'abonne à l'un **ou** à l'autre, jamais aux deux pour compter |
| `LotInputConsumed` | ANA | `lot_id`, produit, quantité, valeur | Même principe vis-à-vis de `ConsumptionRecorded` |
| `LotWeighingRecorded`, `LotObservationRecorded` | ANA, NOT (observation critique) | `lot_id` | — |
| `EggCollectionRecorded`, `EggCollectionCancelled` | ANA | `collection_id`, quantités | KPI œufs |
| `IncubationBatchStarted`, `CandlingRecorded`, `HatcherTransferRecorded`, `HatchRecorded` | ANA, NOT (retard d'échéance) | `batch_id`, quantités | Taux d'éclosion |
| `ProductionRecorded` | ANA | produit, quantité, lot, source | KPI production générique |
| `LotStatusChanged` | ANA, SYN | `lot_id`, statut | Disponibilité à la vente |
| `ProductionLotClosed` | ANA, NOT | `lot_id`, indicateurs figés | Marge de lot |
| `HighMortalityDetected` | NOT | `lot_id`, taux | Alerte critique |

### 2.7 Approvisionnement (producteur : `procurement`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `SupplierCreated`, `SupplierUpdated` | SYN | `supplier_id` | — |
| `PurchaseRequestSubmitted` | NOT (via approbation) | `request_id` | — |
| `PurchaseRequestApproved`, `PurchaseRequestRejected`, `PurchaseRequestCancelled` | NOT | `request_id` | Notification au demandeur |
| `PurchaseOrderCreated`, `PurchaseOrderApproved` | NOT | `po_id`, total | — |
| `PurchaseOrderSent` | SYN (téléchargement par les réceptionnaires) | `po_id` | Réception possible hors ligne |
| `PurchaseOrderCancelled`, `PurchaseOrderClosed` | SYN | `po_id` | — |
| `GoodsReceived` | ANA, NOT, FIN (base du rapprochement), PRD (mise en place directe) | `receipt_id`, lignes (livré, rejeté, accepté, coût) | Reliquats ; alerte si rejet |
| `GoodsReceiptQuarantined` | NOT | `receipt_id` | Validation |
| `GoodsReceiptCancelled` | ANA | `receipt_id` | — |
| `ReceiptIncompleteDetected` | NOT | `po_id`, reliquat | Alerte `RECEIPT_INCOMPLETE` |

### 2.8 Finance (producteur : `finance`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `CashSessionOpened`, `CashSessionClosed` | ANA | `session_id`, montants | — |
| `CashVarianceDetected` | NOT | `session_id`, écart | Alerte `CASH_VARIANCE` ; validation |
| `CashSessionValidated` | ANA | `session_id` | — |
| `CashTransferSent`, `CashTransferReceived` | NOT, ANA | `transfer_id`, montants | Notification au destinataire |
| `CashTransferDiscrepancyDetected` | NOT | `transfer_id`, écart | Validation |
| `ExpenseRecorded` | NOT (via approbation) | `expense_id`, montant, catégorie, objet | — |
| `ExpenseApproved` | STK (écriture de coût via l'API d'inventory si non faite), ANA | `expense_id`, objet de coût | Coût du lot |
| `ExpenseRejected`, `ExpensePaid` | ANA, NOT | `expense_id` | — |
| `SupplierInvoiceRecorded`, `SupplierInvoiceApproved` | APP (quantités facturées), ANA | `invoice_id` | — |
| `SupplierInvoiceMismatchDetected` | NOT | `invoice_id`, écarts | Validation |
| `SupplierPaymentRecorded` | ANA | `payment_id` | Dettes |
| `ReceivableOverdue` | NOT | `sale_id`, retard | Alerte `OVERDUE_RECEIVABLE` (produit par la tâche quotidienne du module `sales`) |

### 2.9 Transverses

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `AlertRaised`, `AlertEscalated`, `AlertAcknowledged`, `AlertResolved` | communication | notifications (interne) | `alert_id` | Push ou in-app |
| `InternalNotePublished`, `InternalNoteAcknowledged` | communication | SYN | `note_id` | Téléchargement des notes |
| `CommandRejected` | sync | NOT | `command_id`, code | Alerte `SYNC_ERROR` |
| `CommandApplied` | sync | — (technique, non publié) | — | Métriques uniquement |
| `SyncConflictDetected`, `SyncConflictResolved` | sync | NOT, module concerné | `conflict_id`, type, rôle responsable | File de résolution |
| `DeviceSequenceGapDetected` | sync | NOT | `device_id`, trou | Alerte critique |
| `ClockSkewDetected` | sync | NOT | `device_id`, écart | Alerte `CLOCK_SKEW` |
| `DeviceSyncStale` | sync (tâche planifiée) | NOT | `device_id`, dernière synchronisation | Alerte `SYNC_STALE` |
| `AuditChainBroken` | audit | NOT | partition, position | Alerte critique |
| `AnalyticsExportRequested`, `AnalyticsExportCompleted`, `SavedViewShared` | analytics | NOT | `export_id` | Lien de téléchargement |
| `ReplenishmentSuggested` | inventory (tâche planifiée) | NOT | PDV, produit, quantité | Alerte `POS_REPLENISH` |
| `KommoLeadQualifiedReceived` | integrations | CRM | `lead_id`, contact | Création ou rapprochement du compte |
| `KommoContactUpdateReceived` | integrations | CRM | `contact_id`, champs | Mise à jour conditionnelle (BR-KOM-003) |
| `KommoFieldConflictDetected` | integrations | NOT | `customer_id`, champ | Information au titulaire |
| `KommoSyncFailed` | integrations | NOT | `message_id` | Alerte `KOMMO_SYNC_FAILED` |

## 3. Garanties de livraison

| Aspect | Règle |
|---|---|
| Publication | Insertion dans `platform.domain_events` **dans la transaction** métier : pas d'événement sans fait, pas de fait sans événement |
| Consommation | Le worker lit par `seq` croissant ; chaque consommateur a sa position (`event_consumer_offsets`) ; les réactions sont idempotentes (clé = `event_id` + consommateur, ou contrainte d'unicité métier) |
| Ordre | Garanti par `seq` à l'intérieur d'un consommateur ; les consommateurs n'exigent pas d'ordre global entre agrégats |
| Échecs | 5 essais avec attente progressive ; ensuite le consommateur marque l'événement en erreur, continue avec les suivants (sauf dépendance d'ordre déclarée) et lève une alerte technique |
| Délai | p95 < 10 s entre publication et réaction (NFR-15) |
