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
5. **Nom stocké et nom logique** (DÉDUIT du pipeline, P5-06) : pour un événement produit par une commande, le pipeline écrit `event_type` = type de la commande (`identity.device.block`) et `aggregate_id` = son agrégat ; le nom du catalogue (`DeviceBlocked`) est le nom logique du même fait. Un consommateur filtre sur le `event_type` stocké. Correspondances d'`identity` : `DeviceBlocked` = `identity.device.block`, `DeviceDeclaredLost` = `identity.device.declare_lost`, `UserDeactivated` = `identity.user.deactivate`, `UserReactivated` = `identity.user.reactivate`, `DeviceUnblocked` = `identity.device.unblock`. Correspondances d'`inventory` (P5-08) : `StockAllocated` = `inventory.allocation.grant`, `StockAllocationIncreased` = `inventory.allocation.increase`, `StockAllocationReleased` = `inventory.allocation.release`, `StockAllocationRevoked` = `inventory.allocation.revoke`. Correspondances de `finance` (P5-15) : `CashTransferSent` = `finance.cash_transfer.send`, `CashTransferReceived` = `finance.cash_transfer.receive`, `CashTransferCancelled` = `finance.cash_transfer.cancel`, `CashTransferDiscrepancyClosed` = `approvals.request.approve` d'une demande `CASH_TRANSFER_DISCREPANCY` ; une course hors ligne conservée en observation (AV-173) est aussi publiée sous le type de sa commande : un consommateur lit l'état de la remise ou l'avertissement, il ne conclut pas à une réception ou à une annulation sur le seul événement. **Exception de `finance`** (P5-12) : les sessions de caisse publient leurs événements **sous leur nom logique**, écrits par le gestionnaire dans la transaction de la commande (`CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected`) ou par une tâche (`CashSessionOpenLongDetected`), producteur `finance`, agrégat `CASH_SESSION` : une ouverture fusionnée hors ligne ne crée pas de session (aucun `CashSessionOpened`) et les montants calculés par le serveur (attendu, écart, statut) ne sont pas dans la charge utile de la commande. Les lignes génériques du pipeline (`finance.cash_session.open`, `.close`, `.force_close`) subsistent, mais un consommateur de caisse filtre sur les noms logiques.

Enveloppe commune (toujours présente, non répétée ci-dessous) : `event_id`, `event_type`, `event_version`, `producer_module`, `aggregate_type`, `aggregate_id`, `occurred_at`, `recorded_at`, `actor_user_id`, `device_id`, `site_id`, `command_id`, `correlation_id`.

Consommateurs, en abrégé : **NOT** (alertes et notifications), **ANA** (projections, instantanés), **KOM** (intégration Kommo), **CRM**, **VEN**, **FIN**, **STK**, **PRD**.

## 2. Catalogue

### 2.1 Identité et organisation (producteurs : `identity`, `organization`)

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `UserCreated`, `UserUpdated` | identity | KOM (correspondance), ANA | `user_id`, rôles | Référentiel à jour |
| `UserDeactivated` | identity | NOT, STK, CRM, FIN | `user_id`, `effective_at` | Alertes : portefeuille, stock mobile et caisse à régulariser ; sessions révoquées |
| `UserReactivated` | identity | STK | `user_id` | Lève le signal `revocation_pending` des quotas de l'utilisateur si l'appareil est en service (P5-08) |
| `RoleAssigned`, `RoleAssignmentRevoked` | identity | SYN (périmètres), NOT | `user_id`, `role_code`, `scope` | Recalcul des périmètres de synchronisation (`SCOPE_EXIT` éventuels) |
| `RolePermissionsChanged` | identity | SYN | `role_id` | Invalidation du cache des droits |
| `DeviceEnrollmentRequested` | identity | NOT | `device_id`, `user_id` | Notification aux approbateurs. **Non publié** (AV-432) : la file des appareils (ECR-ADM-05) reste le canal |
| `DeviceApproved` | identity | NOT | `device_id` | L'utilisateur peut synchroniser |
| `DeviceBlocked`, `DeviceDeclaredLost` | identity | STK, SYN, NOT | `device_id`, `effective_at` | Quotas actifs de l'appareil en `revocation_pending` (consommateur `inventory.allocation_revocation`, P5-08) ; quarantaine des commandes postérieures |
| `DeviceUnblocked` | identity | STK | `device_id` | Lève le signal `revocation_pending` des quotas de l'appareil si l'utilisateur est en service (P5-08) |
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
| `ApprovalRequested` | approvals | NOT | `approval_id`, `operation_type`, `subject_type`, `subject_id`, `amount_xaf`, `site_id`, `zone_id`, `requester_user_id`, `approver_permission`, `requested_at` | Notification aux titulaires de la permission d'approbation de la politique figée sur la demande, sur son périmètre, la Direction à défaut (`communication.direct`, P9-11, AV-430) ; publié par `requestApproval` sous un identifiant déterministe ; jamais le résumé de la demande (RC-05) |
| `ApprovalPendingLong` | approvals | NOT | `request_id`, `operation_type`, `operation_label`, `hours_pending`, `threshold_hours`, `approver_permission`, `approver_scope`, `requester_user_id`, `subject_type`, `subject_id`, `requested_at`, `escalated` (déjà escaladée avant la passe), `site_id`, `zone_id`, `business_day`, `pass_id` | Alerte `APPROVAL_PENDING_LONG` (P9-09, AV-416) ; passe horaire `approvals.requests.pending_long_check` ; agrégat : la demande ; ni résumé ni montant (RC-05) |
| `ApprovalGranted`, `ApprovalRejected` | approvals | NOT, ANA | `approval_id`, `operation_type`, `subject_type`, `subject_id`, `site_id`, `zone_id`, `requester_user_id`, `decision`, `decision_option`, `decided_by`, `comment`, `decided_at` | Notification au demandeur seul, avec le motif d'un refus (`communication.direct`, P9-11, AV-430) ; elle tient lieu de `PurchaseRequestApproved` et `PurchaseRequestRejected` pour une demande d'achat. La transition du document est exécutée **de manière synchrone**, dans la transaction de la décision, par le gestionnaire que le module propriétaire a enregistré auprès d'`approvals` (ADR-018) ; l'événement ne sert qu'aux effets secondaires |
| `ApprovalCancelled` | approvals | NOT | `approval_id` | — |
| `AttachmentRegistered` | attachments | — | `attachment_id`, `owner` | — |
| `AttachmentUploaded` | attachments | approvals, NOT | `attachment_id` | Déblocage d'une validation en attente de pièce |
| `AttachmentUploadFailed` | attachments | NOT | `attachment_id`, cause | Nouvel essai demandé à l'auteur |
| `ProductCreated`, `ProductUpdated`, `ProductReactivated` | catalog | SYN, KOM | `product_id` | Catalogue |
| `ProductDeactivated` | catalog | SYN, PRX, NOT | `product_id` | Alerte si des règles actives ou des soldes restent |
| `ProductStandardCostChanged` | catalog | STK | `product_id`, coût | Valorisation des productions futures. **Non publié par le code** : la commande `catalog.product_standard_cost.set` publie `StandardCostSet` (P9-09) |
| `StandardCostSet` | catalog | NOT | `product_id` | Résolution immédiate de l'alerte `STANDARD_COST_MISSING` du produit (AV-413) ; agrégat : la version de coût ; un événement par version, publié dans la transaction de la commande |
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
| `CustomerMerged` | crm | KOM, ANA | `kept_id`, `merged_id` | Liens externes rattachés (non publié à ce jour) |
| `CustomerDuplicateSuspected` | crm | NOT | `customer_id` (sujet : le nouveau compte), `existing_customer_id`, `reference` (nom du nouveau compte), `reason_label`, `owner_user_id`, `site_id`, `zone_id`, `business_day` | Alerte `DUPLICATE_SUSPECTED` (P9-10, AV-419) ; publié par `crm.customer.create` pour un doublon créé hors ligne, sans téléphone |
| `CustomerDuplicateResolved` | crm | NOT | `customer_id`, `kept_customer_id`, `merged_customer_id`, `decided_by` | Ferme l'alerte du compte qui n'est plus un doublon en attente ; publié par `crm.customer.merge` |
| `CustomerCreditTermsChanged` | crm | SYN | `customer_id` | Contrôle du crédit hors ligne |
| `VisitRecorded`, `VisitCancelled` | crm | ANA, NOT (`far_from_customer`) | `visit_id`, `customer_id`, `user_id`, drapeaux | KPI visites |
| `InteractionRecorded` | crm | ANA | `interaction_id` | — |
| `SalesTargetSet` | crm | ANA | `target_id` | Suivi des objectifs |
| `CheckInAccepted`, `CheckInRejected` | fieldwork | ANA, NOT (rejets répétés) | `checkin_id`, résultat, distance | Audit de présence |
| `CheckInOverrideRequested` | fieldwork | NOT (via `ApprovalRequested`) | `session_id` | — |
| `CheckInSuspicious` | fieldwork | NOT | `checkin_id`, `user_id`, `user_label`, `zone_id`, `flags` (libellés), `flag_codes`, `distance_m`, `accuracy_m`, `server_result`, `business_day` — sans coordonnées | Alerte `CHECKIN_SUSPICIOUS` (P9-10, AV-418) ; publié par `fieldwork.checkin.record` après l'écriture du pointage |
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
| `PriceMismatchDetected` | NOT | `sale_id` ou `order_id`, `document_type` (`SALE`, `SALES_ORDER`), `doc_number`, `site_id`, `zone_id`, `product_id`, `product_label`, `applied_price_xaf`, `expected_price_xaf`, `declared_list_price_xaf` (première ligne en écart), `lines` (100 au plus), `lines_count`, `seller_user_id`, `commercial_user_id`, `captured_offline`, `business_day` | Alerte `PRICE_MISMATCH` (INFO, P9-07) : un événement par vente directe ou par commande saisie hors ligne en écart de prix, publié dans la transaction de `sales.sale.record`, `sales.order.place` et `sales.order.update` (lignes ajoutées) (AV-395) |
| `CreditLimitExceeded` | NOT (via approbation) | `sale_id`, encours | — |
| `PaymentReceived` | ANA, KOM, NOT | `payment_id`, montant, moyen, client | KPI encaissé ; CA cumulé Kommo |
| `PaymentAllocated` | ANA | `payment_id`, `sale_id` ou `order_id`, montant | Statut de paiement (écrit de façon synchrone ; l'événement ne sert qu'aux projections) |
| `PaymentFlaggedDuplicate` | NOT | `payment_id`, `kind`, `reference` (numéro du document), `reason` (`SAME_REFERENCE` ou `PROBABLE_SAME_AMOUNT`), `duplicate_of_payment_id` ou `similar_payment_id`, `method_code`, `amount_xaf`, `external_reference`, `customer_id`, `sale_id`, `order_id`, `received_by_user_id`, `site_id`, `zone_id`, `captured_offline`, `business_day` | Alerte `DUPLICATE_SUSPECTED` (P9-07) : un événement par encaissement signalé, publié dans la transaction de la commande ; le sujet est l'encaissement suspect (AV-396) |
| `PaymentDuplicateDecided` | NOT | `payment_id`, `decision` (`APPROVED`, `REJECTED`), `decided_by` | Résolution de l'alerte `DUPLICATE_SUSPECTED` d'un encaissement (décision `PAYMENT_DUPLICATE`, P9-07) |
| `PaymentCancelled` | ANA, KOM | `payment_id` | — |

### 2.5 Stock (producteur : `inventory`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `StockTransferRequested` | NOT | `transfer_id`, `doc_number`, `from_location_id`, `to_location_id`, `from_site_id`, `to_site_id`, `line_count`, `requested_by`, `occurred_at` | Notification aux expéditeurs du site source (`inventory.transfer.dispatch`), demandeur exclu (`communication.direct`, P9-11, AV-430) ; publié par la commande `inventory.transfer.request` sous un identifiant déterministe |
| `StockTransferDispatched` | NOT, ANA | `transfer_id`, `doc_number`, `from_location_id`, `to_location_id`, `from_site_id`, `to_site_id`, `line_count`, `dispatched_by`, `occurred_at` | Notification aux réceptionnaires du site destinataire (`inventory.transfer.receive`), expéditeur exclu (`communication.direct`, P9-11, AV-430) ; publié par la commande `inventory.transfer.dispatch` (sur demande ou en expédition directe, jamais en quarantaine) ; KPI « envoyé » |
| `StockTransferReceived` | ANA | `transfer_id`, reçu | KPI « reçu ». P5-16 : publié aussi par la tâche `inventory.transfers.unmatched_sweep` pour un rapprochement qu'elle fait (`blind_receipt_id`, `matched_by`) ; la réception « reçue » exclut les retours à la source (inverses de l'expédition) |
| `StockTransferDiscrepancyDetected` | NOT | `transfer_id`, écart, valeur | Validation ; alerte |
| `StockTransferDiscrepancyResolved` | ANA | `transfer_id`, décision | — |
| `StockTransferCancelled` | NOT | `transfer_id` | — |
| `StockTransferUnmatched` | NOT | `transfer_id` (réception sans document), `doc_number`, `from_location_id`, `to_location_id`, `from_location_label`, `to_location_label`, `site_id` (site source), `destination_site_id`, `occurred_at`, `hours` (seuil), `hours_elapsed`, `business_day`, `lines` (P5-16, P9-08) | Alerte `TRANSFER_UNMATCHED` (WARNING, résolution manuelle) ; produit par la tâche `inventory.transfers.unmatched_sweep`, au plus un par réception sans document encore `UNMATCHED` au délai de `inventory.transfer_unmatched_hours` ; sujet : la réception ; fermée par `BlindReceiptMatched` (AV-410) |
| `BlindReceiptMatched` (P9-08) | NOT | `receipt_id` (réception sans document), `transfer_id` (expédition rapprochée), `matched_by`, `matched_at`, `site_id`, `business_day` ; `aggregate_id` = la réception | Ferme l'alerte `TRANSFER_UNMATCHED` ; publié par le rapprochement **tardif** (tâche `inventory.transfers.unmatched_sweep` ou expédition arrivée après la réception) ; le rapprochement immédiat n'a jamais levé d'alerte (AV-410) |
| `StockTransferNotReceived` (P9-08) | NOT | `transfer_id`, `doc_number`, `hours_elapsed`, `threshold_hours`, `dispatched_at`, `from_location_id`, `to_location_id`, libellés, `sender_user_id`, `recipient_user_id` (gardien exclusif), `site_id` (site de réception), `source_site_id`, `business_day`, `pass_id` | Alerte `TRANSFER_NOT_RECEIVED` (WARNING, auto) ; produit par la passe quotidienne `inventory.alerts.transfer_not_received_check` (06:30) pour un transfert `STANDARD` `DISPATCHED` au-delà de `inventory.transfer_not_received_hours` ; fermé par la réception, l'annulation, le refus, le retour, le rapprochement d'une réception sans document (`TransferMatchedByBlindReceipt`) ou le marqueur (AV-408) |
| `TransferMatchedByBlindReceipt` (P9-08) | NOT | `transfer_id` (l'expédition), `receipt_id` (réception sans document), `status` (`RECEIVED` ou `DISCREPANCY_PENDING`), `site_id`, `business_day` ; `aggregate_id` = l'expédition | Ferme l'alerte `TRANSFER_NOT_RECEIVED` ; publié aux deux chemins de rapprochement d'une réception sans document avec son expédition (immédiat à l'enregistrement, tardif par la tâche ou l'expédition), en plus de `BlindReceiptMatched` (sujet : la réception) |
| `StockAllocated`, `StockAllocationIncreased`, `StockAllocationReleased`, `StockAllocationRevoked` | SYN, NOT | `allocation_id`, détenteur | Téléchargement du quota |
| `AllocationRevocationPending` (P5-08, P9-08) | NOT, SYN | `allocation_id`, `reason` (`DEVICE_BLOCKED`, `DEVICE_LOST`, `DEVICE_RETIRED`, `USER_DEACTIVATED` ; `REVOCATION_PENDING` en repli pour le filet quand ni l'appareil ni l'utilisateur ne l'explique), détenteur, appareil, produit, `product_label`, `location_id`, `location_label`, reste, `site_id`, `business_day` | Alerte `ALLOCATION_REVOCATION_PENDING` (WARNING, auto) ; aucun mouvement automatique, la décision (révocation) est la sienne (ADR-033 §9). Publié une fois par quota signalé (sur fait, sans passe) ; la passe quotidienne `inventory.allocations.expiry_daily` le republie avec `pass_id` et son marqueur (filet, AV-410) |
| `AllocationRevocationCleared` (P9-08) | NOT | `allocation_id`, `cleared_by` (`identity.device.unblock`, `identity.user.reactivate`), `site_id`, `business_day` ; `aggregate_id` = le quota | Ferme l'alerte `ALLOCATION_REVOCATION_PENDING` (la condition a disparu sans libération ni révocation) ; publié une fois par quota dont le signal est levé (AV-410) |
| `AllocationExpired` (P5-08, P9-08) | NOT | `allocation_id`, détenteur, appareil, produit, `product_label`, `location_id`, `location_label`, reste (nombre), `valid_until`, `site_id`, `business_day`, `pass_id` | Alerte « quota échu à libérer » (`ALLOCATION_EXPIRED`) ; produit par la passe `inventory.allocations.expiry_daily` (00:05), un par quota actif échu et par passe (identité de créneau, plus de déduplication par jour), suivi du marqueur de fin de passe ; fermé par la libération, la révocation ou le marqueur ; le serveur ne libère jamais seul |
| `StockLossDeclared` | NOT (`HIGH_LOSS`), ANA | `loss_id`, catégorie, produit, lot, quantité, valeur, emplacement, statut | Alerte immédiate si anormal ; KPI pertes |
| `StockLossApproved`, `StockLossRejected` | PRD (indicateurs du lot), ANA, NOT | `loss_id`, décision | — |
| `ConsumptionRecorded` | ANA | `consumption_id`, objet de coût, valeur | Le coût est écrit de façon synchrone au registre ; l'événement sert aux projections |
| `InventoryCountOpened`, `InventoryCountSubmitted` | ANA | `count_id`, écarts | — |
| `InventoryVarianceDetected` (P9-08) | NOT | `count_id`, `location_id`, `location_label`, `site_id`, `variance_quantity`, `variance_value_xaf` (protégé), `abs_variance_value_xaf`, `lines_with_variance`, `animal_variance`, `threshold_xaf`, `approval_request_id`, `business_day` ; `aggregate_id` = l'inventaire | Alerte `INVENTORY_VARIANCE` (WARNING, manuelle) ; publié à la soumission quand la validation est requise (valeur ≥ seuil d'approbation ou animaux) ; fermée par `InventoryAdjusted` (AV-406) |
| `InventoryAdjusted` (P9-08) | ANA, NOT | `count_id`, `location_id`, `site_id`, `variance_quantity`, `variance_value_xaf` (champ protégé), `status` = `POSTED`, `business_day` ; `aggregate_id` = l'inventaire | KPI écarts. Publié à la comptabilisation : soumission sans validation ou décision `INVENTORY_ADJUSTMENT` approuvée ; ferme l'alerte `INVENTORY_VARIANCE` du même inventaire (AV-406) |
| `InventoryCountReconciled` | ANA | `count_id`, ajustement | — |
| `StockThresholdBreached` (P9-08) | NOT | `location_id`, `product_id`, `level` (`LOW` ou `OUT`), `breached` (vrai : levé, faux : terminé), `available` (disponible physique), `threshold` (minimum), `target`, `location_label`, `product_label`, `site_id`, `business_day`, `pass_id` (filet seulement) | Alertes `STOCK_LOW` (WARNING) et `STOCK_OUT` (CRITICAL), sujet (emplacement, produit), résolution automatique. Publié dans la transaction du mouvement pour chaque extrémité **physique** qui a un seuil actif dont l'état change (`recordStockMove`), par `inventory.threshold.set` (changement de minimum) et par le filet horaire `inventory.alerts.stock_threshold_sweep` (avec marqueurs) ; une transition `LOW → OUT` publie la fin de `LOW` puis la levée de `OUT` (AV-355) |
| `StockNegativeDetected` (P9-08) | NOT, SYN (conflit) | `location_id`, `product_id`, `negative` (vrai), `balance` (plus petit solde de lot négatif), `lot_id`, `location_label`, `product_label`, `site_id`, `business_day`, `move_type`, `source_doc_type`, `source_doc_id`, `captured_offline` | Alerte `STOCK_NEGATIVE` (CRITICAL, manuelle) ; publié par `recordStockMove` pour toute sortie physique qui laisse un solde de lot négatif, **y compris** quand l'appelant ouvre lui-même le conflit (vente directe) ; un événement par appel et par couple |
| `HighLossDetected` (P9-08) | NOT | `location_id`, `business_day` (jour du fait), `location_label`, `site_id`, `loss_quantity` (nul si plusieurs produits), `loss_value_xaf` (protégé), `declarations`, `cause` = `ABSOLUTE`, `threshold_xaf`, `last_loss_id` ; `aggregate_id` = sujet emplacement × jour | Alerte `HIGH_LOSS` (CRITICAL, manuelle) ; publié à chaque déclaration de perte tant que le cumul du jour de l'emplacement (déclarations en attente comprises, mortalité exclue) atteint `inventory.high_loss_alert_xaf` (AV-403) |
| `HighLossSalesShareDetected` (P9-08, producteur `sales`) | NOT | `location_id`, `business_day`, `location_label`, `site_id`, `loss_quantity` (nul si plusieurs produits), `loss_value_xaf` (protégé), `declarations`, `cause` = `SALES_SHARE`, `share_pct`, `threshold_pct`, `sales_net_xaf`, `pass_id` (jour examiné) ; sans `threshold_xaf` ni `last_loss_id` | Même alerte `HIGH_LOSS` (même sujet emplacement × jour) ; produit par `sales.losses.sales_share_check` (06:45) pour les deux derniers jours clos, au plus un par emplacement et par jour, **seulement** pour une perte sous le seuil absolu (AV-405) |
| `LotExpiringDetected` (P9-08) | NOT | `lot_id`, `lot_code`, `product_id`, `product_label`, `origin_type`, `expiry_date`, `days_left` (négatif : périmé), `quantity` (stock physique du lot au site, pour ce produit), `site_id`, `business_day`, `pass_id` | Alerte `LOT_EXPIRING` (WARNING, auto), sujet lot × site × produit ; produit par la passe quotidienne `inventory.alerts.lot_expiring_daily` (06:00) ; fermée par le marqueur quand le stock disparaît, le lot est clos ou la date repoussée (AV-404) |
| `ReplenishmentSuggested` (P9-08) | NOT | `location_id`, `product_id`, libellés, `suggested_quantity`, `available`, `min_quantity`, `target_quantity`, `in_transit_in`, `site_id`, `source_location_id`, `source_location_label`, `business_day`, `pass_id` | Alerte `POS_REPLENISH` (WARNING, auto), sujet point de vente × produit ; produit par la passe horaire des seuils pour un emplacement `POS` (condition : `inventory.replenish_alert_scope`) ; fermée par le marqueur (AV-402) |
| `LedgerMismatchDetected` (P9-08) | NOT | `site_key` (site ou `GLOBAL`), `site_id`, `business_day`, `mismatches`, `breakdown` (soldes, conservation, « à livrer », règlement, quotas, dépassement, négatif, transit), `balances_checked`, `sample` (borné), `pass_id` | Alerte `LEDGER_MISMATCH` (CRITICAL, manuelle) ; produit par `inventory.ledger.reconcile_daily`, **qui se termine en succès** ; un événement par site et par jour métier (AV-409) |
| `ProductValuationChanged` | ANA | `product_id`, CMUP | — |
| `CostEntryRecorded` | ANA | objet, type, montant | KPI coûts |

### 2.6 Production (producteur : `production`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `ProductionLotCreated` | ANA | `lot_id`, type, site | — |
| `LotEntryRecorded` | ANA | `lot_id`, type d'entrée, quantité | Effectif ; coût (écrit de façon synchrone) |
| `MortalityRecorded` | ANA | `lot_id`, quantité, effectif de référence, `loss_id` | **Non publié par le code** (P9-09) : l'événement générique `production.mortality.record` et la ligne de stock portent le fait ; l'alerte est `HighMortalityDetected`. **Même fait** que `StockLossDeclared` catégorie `MORTALITE` : un consommateur s'abonne à l'un **ou** à l'autre, jamais aux deux pour compter |
| `LotInputConsumed` | ANA | `lot_id`, produit, quantité, valeur | Même principe vis-à-vis de `ConsumptionRecorded` |
| `LotWeighingRecorded`, `LotObservationRecorded` | ANA, NOT (observation critique) | `lot_id` | — |
| `EggCollectionRecorded`, `EggCollectionCancelled` | ANA | `collection_id`, quantités | KPI œufs |
| `IncubationBatchStarted`, `CandlingRecorded`, `HatcherTransferRecorded`, `HatchRecorded` | ANA, NOT (retard d'échéance) | `batch_id`, quantités | Taux d'éclosion |
| `ProductionRecorded` | ANA | produit, quantité, lot, source | KPI production générique |
| `LotStatusChanged` | ANA, SYN | `lot_id`, statut | Disponibilité à la vente |
| `ProductionLotClosed` | ANA, NOT | `lot_id`, indicateurs figés | Marge de lot |
| `HighMortalityDetected` | NOT | `lot_id`, `lot_label`, `business_day`, `site_id`, `heads`, `rate_pct` (`null` sans effectif de référence ; le message omet le champ), `reference_headcount`, `cause` (`RELATIVE`, `ABSOLUTE`, `BOTH`), `threshold_pct`, `threshold_heads`, `last_loss_id`, `captured_offline` | Alerte `HIGH_MORTALITY` critique (P9-09, AV-411) ; publié dans la transaction de `production.mortality.record` quand le cumul des morts du jour métier du fait du lot atteint un seuil ; agrégat `LOT_DAY` (lot × jour) ; un événement par saisie tant que le cumul reste au seuil |
| `DailyEntryMissing` | NOT | `lot_id`, `lot_label`, `lot_type`, `missing_day`, `business_day`, `site_id`, `pass_id` | Alerte `DAILY_ENTRY_MISSING` (P9-09, AV-412) ; passe `production.lots.daily_entry_check` (10:00) ; agrégat : le lot ; résolue par le marqueur de la passe suivante |
| `StandardCostMissing` | NOT | `product_id`, `product_label`, `entry_day`, `business_day`, `pass_id` | Alerte `STANDARD_COST_MISSING` (P9-09, AV-413) ; passe `production.products.standard_cost_check` (07:45) ; sujet : le produit (UUID v5 de `PRODUCT:<product_id>`) |

### 2.7 Approvisionnement (producteur : `procurement`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `SupplierCreated`, `SupplierUpdated` | SYN | `supplier_id` | — |
| `PurchaseRequestSubmitted` | NOT (via approbation) | `request_id` | — |
| `PurchaseRequestApproved`, `PurchaseRequestRejected`, `PurchaseRequestCancelled` | NOT | `request_id` | Notification au demandeur : portée, pour l'approbation et le rejet, par `ApprovalGranted` et `ApprovalRejected` (type d'opération `PURCHASE_REQUEST`, AV-430) — non publiés séparément ; l'annulation reste sans notification (AV-389) |
| `PurchaseOrderCreated`, `PurchaseOrderApproved` | NOT | `po_id`, total | — |
| `PurchaseOrderSent` | SYN (téléchargement par les réceptionnaires) | `po_id` | Réception possible hors ligne |
| `PurchaseOrderCancelled`, `PurchaseOrderClosed` | SYN | `po_id` | — |
| `ReceiptIncompleteDetected` | NOT | `po_id`, `doc_number`, `supplier_id`, `supplier_label`, `site_id`, `expected_delivery_date`, `days_late` (`null` hors retard), `threshold_days`, `reason` (`OVERDUE`, `REJECTED`, `BOTH`), `rejected` (`null` sans rejet ou en plusieurs unités), `remaining_lines`, `po_status`, `trigger` (`PASS`, `RECEIPT`, `RECEIPT_CANCELLATION`), `business_day`, `pass_id` (passe) | Alerte `RECEIPT_INCOMPLETE` (P9-09, AV-414) ; agrégat : le bon ; publié à chaque changement des quantités acceptées du bon et par la passe quotidienne (07:15) ; aucune valeur au coût |
| `ReceiptIncompleteCleared` | NOT | `po_id`, `trigger`, `business_day` | Ferme l'alerte `RECEIPT_INCOMPLETE` du bon (P9-09, AV-414) : après un changement de ses quantités, le bon n'est plus incomplet (reliquat nul, clôturé ou annulé, ou reliquat dans les délais et sans rejet) |
| `GoodsReceiptQuarantined` | NOT | `kind` (« Réception »), `reference`, `receipt_id`, `doc_number`, `purchase_order_id`, `supplier_id`, `supplier_label`, `site_id`, `reasons` (`PO_NOT_RECEIVABLE`, `OVER_RECEIPT`, `DUPLICATE_DELIVERY_NOTE`), `reason_label`, `approval_request_id`, `supplier_delivery_note_ref`, `business_day`, `captured_offline` | Alerte `DUPLICATE_SUSPECTED` à la mise en quarantaine (P9-09, AV-415) ; agrégat : la réception ; aucun effet de stock jusqu'à la décision |
| `GoodsReceiptQuarantineDecided` | NOT | `receipt_id`, `decision` (`APPROVED`, `REJECTED`), `decided_by` | Ferme l'alerte `DUPLICATE_SUSPECTED` de la réception (P9-09, AV-415) ; publié à la décision de validation `RECEIPT_QUARANTINE` |
| `GoodsReceived` | ANA, NOT, FIN (base du rapprochement), PRD (mise en place directe) | `receipt_id`, lignes (livré, rejeté, accepté, coût) | Reliquats ; alerte si rejet. **Non publié par le code** (P9-09) |
| `GoodsReceiptCancelled` | ANA | `receipt_id` | — **Non publié par le code** (P9-09) |
| `AttachmentMissingDetected` | NOT | `document_type` (`GOODS_RECEIPT`), `document_id`, `document_label`, `days_missing`, `author_user_id`, `site_id`, `status`, `without_order`, `threshold_days`, `business_day`, `pass_id` | Alerte `ATTACHMENT_MISSING` des réceptions (P9-09, AV-417) ; tâche quotidienne `procurement.receipts.attachment_missing_check` (06:15) : un événement par réception dont la photo du bon de livraison est exigée et absente, par passe de portée `GOODS_RECEIPT` ; aucun montant (valeur au coût) |

### 2.8 Finance (producteur : `finance`)

| Événement | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|
| `CashSessionOpened` | ANA | `session_id`, `cash_account_id`, `site_id`, `opened_by`, `opened_device_id`, `opened_at`, `opening_counted_xaf`, `opening_expected_xaf`, `opening_variance_xaf`, `captured_offline`, `shifted_from` (ouverture décalée, AV-168), `comment` | Création d'une session seulement (jamais pour une fusion, P5-12) |
| `CashSessionClosed` | ANA | `session_id`, `cash_account_id`, `site_id`, `opened_by`, `opened_at`, `opening_counted_xaf`, `opening_variance_xaf`, `closed_by`, `closed_device_id`, `closed_at`, `closing_counted_xaf`, `closing_expected_xaf`, `variance_xaf`, `status`, `auto_validated`, `forced`, `forced_by`, `reason` (clôture forcée), `comment`, `captured_offline` | Clôture ordinaire et clôture forcée (P5-12) ; jamais pour une observation |
| `CashVarianceDetected` | NOT | `session_id`, `cash_account_id`, `site_id`, `phase` (`OPENING`, `CLOSING`, ou `ADJUSTMENT` pour une réévaluation, P5-13 : avec `adjustment_id`, `variance_after_xaf`, `treatment`, `approval_request_id` ; P9-07 : `cause` `LATE_OPERATION`, `REVERSAL`, `LATE_BEFORE_OPENING` (publié par l'ajustement de l'écart d'ouverture, AV-224) ou `REMAINING_ADJUSTMENTS` (ajustements encore en attente après la validation d'un autre, AV-400)), `variance_xaf`, `severity` (`WARNING`, `CRITICAL` à partir de `finance.cash_variance_critical_xaf`), `tolerated` (écart dans `finance.cash_variance_tolerance_xaf` : constat sans alerte, P9-07), `business_day`, `counted_xaf`, `expected_xaf`, `imputed_user_id` (AV-155, AV-170), `opened_by`, `closed_by`, `forced` | Alerte `CASH_VARIANCE` (P9, AV-400) ; validation (P5-13) |
| `CashSessionOpenLongDetected` | NOT | `session_id`, `cash_account_id`, `site_id`, `opened_by`, `opened_at`, `hours_open`, `threshold_hours`, `business_day`, `pass_id` | Alerte `CASH_SESSION_OPEN_LONG` (P9) ; produit par la tâche `finance.cash_sessions.open_long_check` (P5-12) ; **passe horaire à identité** (P9-07) : un événement par session ouverte trop longtemps et par passe, suivi d'un `AlertDetectionPassCompleted` ; l'alerte d'état se résout seule quand la session n'est plus revue |
| `CashSessionValidated` | ANA | `session_id`, `cash_account_id`, `site_id`, `validated_by`, `validated_at`, `variance_xaf` (écart de clôture + ajustements inclus, ou delta de l'ajustement validé), `reason`, `approval_request_id` ; session : `opening_variance_xaf`, `closing_variance_xaf`, `included_adjustments`, `included_delta_xaf` ; ajustement à demande propre : `adjustment_id` (P5-13) | Indicateurs ; produit sous son nom logique par la façade `finance.cash_session.validate` ou la décision `CASH_VARIANCE` |
| `CashTransferSent`, `CashTransferReceived`, `CashTransferCancelled` | NOT, ANA | `transfer_id`, montants | Notification au destinataire (noms logiques des commandes, §1 point 5) |
| `CashTransferDiscrepancyDetected` | NOT | `transfer_id`, `doc_number`, `from_account_id`, `to_account_id`, `amount_sent_xaf`, `amount_received_xaf`, `discrepancy_xaf`, `approval_request_id`, `received_by`, `site_id` | Validation `CASH_TRANSFER_DISCREPANCY` (inséré par `finance.cash_transfer.receive`, P5-15) |
| `CashTransferUnreceived` | NOT | `transfer_id`, `doc_number`, comptes, `amount_sent_xaf`, `sent_at`, `sent_by`, porteur, `hours_elapsed`, `unreceived_hours`, `site_id`, `business_day`, `pass_id` | Alerte `CASH_TRANSFER_NOT_RECEIVED` (P9) ; produit par la tâche `finance.cash_transfers.unreceived_check` (P5-15) ; **passe horaire à identité** (P9-07) : un événement par remise envoyée non reçue au-delà de 48 h et par passe, suivi du marqueur de fin de passe |
| `CashHoldingHighDetected` | NOT | `account_id` (= `cash_account_id`), `account_code`, `holder_user_id`, `holder_label`, `balance_xaf`, `days_without_transfer`, `last_transfer_at`, `held_since` (entrée de l'espèce encore détenue, FIFO), `reference_at` (la plus récente des deux), `threshold_xaf`, `threshold_days`, `reason` (`AMOUNT`, `DAYS`, `BOTH`), `site_id`, `business_day`, `pass_id` | Alerte `CASH_HOLDING_HIGH` (WARNING, AV-397) ; produit par la tâche horaire `finance.cash_holdings.high_check` : un événement par caisse d'utilisateur en dépassement et par passe, suivi du marqueur de fin de passe |
| `CashMismatchDetected` | NOT | `cash_account_id` (ou `NONE`), `account_label`, `sections_label`, `business_day`, `sections` (`LEDGER`, `TRANSFERS`, `SESSIONS`, `EXPENSES`, `SUPPLIERS`), `breaches`, `details` (5 au plus), `difference_xaf`, `projected_xaf`, `ledger_xaf`, `site_id` | Alerte `CASH_MISMATCH` (CRITICAL, résolution manuelle, AV-398) ; produit par `finance.cash.reconcile_daily`, **qui se termine en succès** au lieu d'échouer ; un événement par compte et par jour métier, sans identité de passe |
| `AttachmentMissingDetected` | NOT | `document_type` (`EXPENSE` ; les réceptions : §2.7), `document_id`, `document_label`, `days_missing`, `author_user_id`, `site_id`, `amount_xaf`, `status`, `review_reasons`, `threshold_days`, `business_day`, `pass_id` | Alerte `ATTACHMENT_MISSING` (AV-357, AV-399) ; produit par la tâche quotidienne `finance.expenses.attachment_missing_check` : un événement par dépense sans justificatif disponible et par passe de portée `EXPENSE`, suivi du marqueur de la même portée |
| `ExpenseRecorded` | NOT (via approbation) | `expense_id`, montant, catégorie, objet | — |
| `ExpenseApproved` | STK (écriture de coût via l'API d'inventory si non faite), ANA | `expense_id`, objet de coût | Coût du lot |
| `ExpenseRejected`, `ExpensePaid` | ANA, NOT | `expense_id` | — |
| `SupplierInvoiceRecorded`, `SupplierInvoiceApproved` | APP (quantités facturées), ANA | `invoice_id` | — |
| `SupplierInvoiceMismatchDetected` | NOT | `invoice_id`, écarts | Validation |
| `SupplierPaymentRecorded` | ANA | `payment_id` | Dettes |
| `ReceivableOverdue` | NOT | `sale_id`, `doc_number`, `customer_id`, `commercial_user_id`, `seller_user_id`, `site_id`, `zone_id`, `due_date`, `days_overdue`, `bucket`, `balance_due_xaf`, `business_day`, `pass_id` | Alerte `OVERDUE_RECEIVABLE` ; produit par la tâche quotidienne `sales.receivables.overdue_daily` (P4-09) ; **passe à identité** (P9-07) : un événement par vente échue et par passe, suivi du marqueur de fin de passe (le même créneau rejoué ne publie rien de plus) |
| `SaleUndeliveredDetected` | NOT | `sale_id`, `doc_number`, `order_id`, `customer_id`, `commercial_user_id`, `seller_user_id`, `site_id`, `zone_id`, `sale_day`, `requested_delivery_day`, `reference_day` (la plus tardive des deux), `days_undelivered`, `threshold_days`, `business_day`, `pass_id` | Alerte `SALE_UNDELIVERED` (AV-132) ; produit par la tâche `sales.orders.undelivered_check` : un événement par vente confirmée dont une partie reste à livrer depuis plus de `sales.undelivered_alert_days`, suivi du marqueur de fin de passe |
| `InactiveCommercialDetected` | NOT | `user_id`, `user_label`, `inactive_day`, `role_code`, `zone_id`, `business_day`, `pass_id` | Alerte `INACTIVE_COMMERCIAL` (BR-TER-013, AV-359, AV-394) ; produit par la tâche quotidienne `sales.commercial.inactivity_check` sur le jour ouvré précédent ; aucun marqueur un jour non ouvré |

### 2.9 Transverses

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|
| `AlertRaised`, `AlertEscalated`, `AlertAcknowledged`, `AlertResolved` | communication | notifications (interne) | `alert_id` | Push ou in-app |
| `AlertDetectionPassCompleted` | tout module détecteur | communication | `alert_type`, `pass_id`, `scope` (facultatif : sépare deux producteurs d'un même type d'alerte d'état), `business_day` | Publié en dernier par une passe de détection **complète** (ADR-061 §3, P9-07) : le consommateur d'alertes résout les alertes d'état ouvertes du type (et de la portée) que cette passe n'a pas revues ; une passe interrompue ne publie rien. Identifiant d'événement dérivé de (type, passe) : un rejeu ne le publie pas deux fois |
| `InternalNotePublished` | communication | SYN | `note_id`, `title`, `category`, `requires_ack`, `published_at`, `expires_at`, `audience`, `recipients_count`, `published_by` | Téléchargement des notes ; source des notifications `NOTE` (P9-11, AV-427) |
| `InternalNoteArchived` | communication | SYN | `note_id`, `previous_status`, `archived_at`, `archived_by` | Retrait d'une note publiée ou abandon d'un brouillon (P9-11, AV-427) |
| `InternalNoteAcknowledged` | communication | SYN | `note_id`, `user_id`, `kind` (`READ` ou `ACKNOWLEDGE`), `read_at`, `acknowledged_at`, `requires_ack` | Un événement par changement de la ligne de lecture ou d'accusé, à la date du fait (P9-11, AV-428) |
| `SyncErrorDetected` | sync (tâche planifiée) | NOT | `device_id`, `error_code`, `device_label`, `occurrences`, `user_id`, `first_at`, `last_at` (dates de la dernière prise en charge des commandes), `window_hours` — sans message d'erreur | Alerte `SYNC_ERROR` (P9-10, AV-421) ; un événement par appareil × code, sujet composite |
| `CommandRejected` | sync | — | `command_id`, code | **Non publié** : remplacé par `SyncErrorDetected` (une alerte par commande inonderait) |
| `CommandApplied` | sync | — (technique, non publié) | — | Métriques uniquement |
| `SyncConflictDetected` | sync | NOT, module concerné | `conflict_id`, type, rôle responsable | File de résolution. **Pas encore produit** (la file se lit par `GET /sync/conflicts`) |
| `SyncConflictResolved` | sync | NOT, module concerné | `conflict_id`, `conflict_type`, `owner_role`, `entity_type`, `entity_id`, `site_id`, `applied`, `status`, `resolution`, `refs` | File de résolution. **Produit depuis P5-17** par `sync.conflict.resolve` et `.dismiss` (agrégat `SYNC_CONFLICT`), en plus de l'événement générique du pipeline ; clôture administrative sans rejeu (AV-190) |
| `DeviceSequenceGapDetected` | sync (tâche planifiée) | NOT | `device_id`, `device_label`, `missing_from`, `missing_to`, `missing_count`, `gaps_count`, `new_ranges`, `opened_at`, `pending_reported` | Alerte critique `DEVICE_SEQ_GAP` (P9-10, AV-423) ; une plage n'est signalée qu'une fois |
| `ClockSkewDetected` | sync (tâche planifiée) | NOT | `device_id`, `device_label`, `skew_minutes` (signé), `threshold_minutes`, `last_push_at`, `user_id` | Alerte `CLOCK_SKEW` (P9-10, AV-424) |
| `DeviceSyncStale` | sync (tâche planifiée) | NOT | `device_id`, `device_label`, `last_sync_at` (omis d'un appareil jamais contacté), `silent_since` (omis quand il égale `last_sync_at`), `hours_since`, `threshold_hours`, `never_contacted`, `user_id` (qui a enrôlé l'appareil) | Alerte `SYNC_STALE` (P9-10, AV-422) |
| `ConsumerFailureDetected` | communication (tâche planifiée) | NOT | `consumer_name`, `failed_events`, `lag_seconds`, `last_seq`, `last_failed_at`, `threshold_seconds`, `window_hours` — sans message d'erreur ni type de l'événement sauté | Alerte `CONSUMER_FAILED` (P9-10, AV-425) ; un par consommateur, sujet = son nom |
| `JobFailureDetected` | communication (tâche planifiée) | NOT | `job_type`, `failed_jobs`, `last_failed_at`, `window_hours`, `business_day` — sans message d'erreur ni charge de la tâche | Alerte `JOB_FAILED` (P9-27, AV-469 choix (b), AV-484) ; un par type de tâche ayant une tâche `FAILED` dans `platform.failed_jobs_window_hours`, sujet = le type de tâche |
| `AuditChainBroken` | audit | NOT | `partition` (mois métier), `position` (seq), `reason`, bornes de la fenêtre, `business_day` | Alerte critique `AUDIT_CHAIN_BROKEN` (P9-10, AV-420) ; sujet = partition × position ; publié par `audit.chain.verify_daily`, qui se termine en succès |
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
| Consommation | Le worker lit par `seq` croissant ; chaque consommateur a sa position (`event_consumer_offsets`), qui ne dépasse jamais un trou récent de la numérotation (un numéro est attribué à l'insertion, pas à la validation : un événement validé après un numéro supérieur serait sauté ; P5-23, même règle que le curseur du pull, AV-198) ; les réactions sont idempotentes (clé = `event_id` + consommateur, ou contrainte d'unicité métier) |
| Ordre | Garanti par `seq` à l'intérieur d'un consommateur ; les consommateurs n'exigent pas d'ordre global entre agrégats |
| Échecs | 5 essais **immédiats** (en mémoire, sans attente) ; ensuite le consommateur consigne le saut dans `platform_event_consumer_failures` (ajout seul à l'écriture ; purge technique à 90 jours, ADR-068 §8), avance sa position et continue avec les suivants (sauf dépendance d'ordre déclarée) ; la passe `communication.consumers.failure_check` lève l'alerte `CONSUMER_FAILED` (P9-10, AV-425) ; limite connue (P9-25, AL-2) : le marqueur de fin de passe d'une passe dont un événement a été sauté peut résoudre l'alerte du sujet concerné, qui renaît à la passe suivante |
| Délai | p95 < 10 s entre publication et réaction (NFR-15) |
