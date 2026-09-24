# Modules de code (Livrable n°12)

> Section 26 du format final (PM §48). Pour chaque module : responsabilité, tables possédées, API exposées, événements publiés, dépendances autorisées, dépendances interdites (PM §35).
> Règle générale : **un module n'écrit que dans son schéma** et n'appelle que l'API publique des modules situés **sous** lui dans le graphe ([`03-graphe-dependances.md`](03-graphe-dependances.md)). Il peut **consommer les événements** de n'importe quel module.

---

## Correspondance domaines fonctionnels ↔ modules

| Domaine fonctionnel | Module(s) |
|---|---|
| D01-ADM | `identity`, `organization`, `approvals`, `attachments` |
| D02-CRM | `crm` |
| D03-TER | `fieldwork` |
| D04-VEN | `sales` |
| D05-DIS | composition : `organization` (PDV), `inventory`, `sales`, `finance` |
| D06-STK | `inventory` |
| D07-PRD | `production` |
| D08-APP | `procurement` |
| D09-FIN | `finance` (trésorerie, dépenses, dettes) + `sales` (encaissements, créances) + `inventory` (coûts, valorisation) |
| D10-PRX | `pricing` |
| D11-ANA | `analytics` |
| D12-AUD | `audit` |
| D13-NOT | `communication` |
| D14-SYN | `sync` |
| D15-KOM | `integrations` |
| D16-CAT | `catalog` |
| Transverse technique | `platform` |

## 1. `platform` (noyau partagé technique)

| Rubrique | Contenu |
|---|---|
| Responsabilité | Types transverses (UUIDv7, argent, quantités, temps métier), unité de travail, outbox d'événements, séquences documentaires, file de tâches, registre des commandes et des consommateurs |
| Tables | `platform.domain_events`, `platform.event_consumer_offsets`, `platform.document_sequences`, `platform.jobs` |
| API | `uow.begin()`, `events.publish(uow, evt)`, `sequences.next(uow, type, site, year)`, `jobs.enqueue(...)`, `clock.now()` |
| Événements | — |
| Dépendances autorisées | Aucune |
| Interdites | Tout module métier |

## 2. `audit`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Journal d'audit chaîné (D12) |
| Tables | `audit.audit_log` |
| API | `audit.record(uow, entry)`, `audit.recordDenied(entry)` (transaction séparée) ; requête `GET /audit` |
| Événements | `AuditChainBroken` |
| Autorisées | `platform` |
| Interdites | Tout module métier (il est appelé, il n'appelle pas) |

## 3. `identity`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Utilisateurs, rôles, permissions, affectations, appareils, sessions, droits effectifs |
| Tables | `users`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `devices`, `auth_sessions` |
| API | `/auth/*`, `/users`, `/devices`, `/roles` ; interne : `authz.can(user, permission, resource, at)`, `authz.scopeFilter(user, resourceType, at)`, `identity.getUser(id)`, `identity.deviceStatusAt(device, at)` |
| Événements | `User*`, `Role*`, `Device*`, `SessionRevoked` |
| Autorisées | `platform`, `audit`, `organization` (l'évaluateur de portée lit les zones, sites et équipes par l'API d'`organization`) |
| Interdites | Modules métier |

## 4. `organization`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Zones, sites, PDV, emplacements (y compris virtuels), équipes, paramètres |
| Tables | `zones`, `sites`, `points_of_sale`, `locations`, `teams`, `team_memberships`, `system_settings` |
| API | `/sites`, `/locations`, `/zones`, `/teams`, `/settings` ; interne : `org.zonePath(zone)`, `org.location(id)`, `org.virtualLocation(type)`, `org.teamMembersAt(team, at)`, `settings.get(key, scope, at)` |
| Événements | `Site*`, `Location*`, `Zone*`, `TeamMembershipChanged`, `SystemSettingChanged` |
| Autorisées | `platform`, `audit`. Clés étrangères vers `identity.users` et `identity.devices` au titre des **références universelles** (voir le graphe §1), sans aucun appel de code vers `identity` |
| Interdites | `identity` (code), tous les modules métier au-dessus |

## 5. `approvals`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Politiques de contrôle, demandes de validation, file de validation, exécution des décisions via les gestionnaires enregistrés |
| Tables | `control_policies`, `approval_requests` |
| API | `/approvals/inbox`, commandes `approvals.*` ; interne : `approvals.evaluatePolicy(op, context, at)`, `approvals.request(uow, …)`, `approvals.registerHandler(operationType, handler)` |
| Événements | `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected`, `ApprovalCancelled`, `ControlPolicyChanged` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `attachments` (présence des pièces requises) |
| Interdites | Modules métier (ils s'enregistrent auprès d'`approvals`, pas l'inverse) |

## 6. `attachments`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Métadonnées et cycle d'upload des pièces justificatives |
| Tables | `attachments` |
| API | Endpoints d'upload ; interne : `attachments.register(uow, owner, meta)`, `attachments.status(ids)`, `attachments.signedUrl(id, user)` (contrôle de portée délégué au propriétaire via un gestionnaire enregistré) |
| Événements | `AttachmentRegistered`, `AttachmentUploaded`, `AttachmentUploadFailed` |
| Autorisées | `platform`, `audit`, `identity` |
| Interdites | Modules métier |

## 7. `catalog`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Produits, unités, conditionnements, catégories, motifs, coûts standard |
| Tables | `product_categories`, `units`, `products`, `product_units`, `reason_codes`, `product_standard_costs`, `customer_categories`, `sales_channels` (référentiels commerciaux partagés) |
| API | `/products`, `/units`, `/reason-codes` ; interne : `catalog.product(id)`, `catalog.toBase(product, qty, unit)`, `catalog.standardCost(product, at)` |
| Événements | `Product*`, `ReasonCodeChanged`, `ProductStandardCostChanged` |
| Autorisées | `platform`, `audit`, `identity` |
| Interdites | Modules métier au-dessus |

## 8. `fieldwork`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Pointages, sessions de travail, dérogations |
| Tables | `geo_checkins`, `work_sessions` |
| API | `/work-sessions` ; commandes `fieldwork.*` ; interne : `fieldwork.openSessionAt(user, at)` |
| Événements | `CheckIn*`, `WorkSession*` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `approvals` |
| Interdites | `crm`, `sales` et au-dessus |

## 9. `crm`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Comptes clients, portefeuille, pipeline, visites, interactions, objectifs, référentiels commerciaux |
| Tables | `customers`, `customer_assignments`, `customer_stage_history`, `pipeline_steps`, `lead_sources`, `visits`, `interactions`, `sales_targets` |
| API | `/customers`, `/visits`, `/interactions`, `/targets` ; interne : `crm.customer(id)`, `crm.ownerAt(customer, at)`, `crm.creditStatus(customer)`, `crm.markConverted(uow, customer, sale)`, `crm.recordLastSale(uow, customer, at)`, `crm.createOrLinkFromExternal(uow, …)` |
| Événements | `Prospect*`, `Customer*`, `Visit*`, `InteractionRecorded`, `SalesTargetSet` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `fieldwork`, `approvals`, `attachments` |
| Interdites | `sales`, `inventory`, `finance`, `pricing` (le CRM ne connaît pas les ventes : la conversion est déclenchée par l'appel de `sales`) |

## 10. `pricing`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Règles tarifaires, campagnes, résolution du prix (moteur partagé) |
| Tables | `price_rules`, `commercial_campaigns` |
| API | `/price-rules`, `/campaigns`, `/prices/resolve` ; interne : `pricing.resolve(context)` |
| Événements | `PriceRule*`, `CommercialCampaignCreated` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog` |
| Interdites | `crm`, `sales`, `inventory`, `finance` |

## 11. `inventory` (stock, valorisation, coûts)

| Rubrique | Contenu |
|---|---|
| Responsabilité | Registre des mouvements, soldes, lots, transferts, allocations et réservations, pertes, consommations, inventaires, seuils, valorisation (CMUP, coût de lot), registre de coûts |
| Tables | `stock_lots`, `stock_moves`, `stock_balances`, `stock_balance_snapshots`, `stock_transfers`, `stock_transfer_lines`, `stock_allocations`, `stock_allocation_entries`, `loss_declarations`, `consumptions`, `inventory_counts`, `inventory_count_lines`, `stock_thresholds`, `product_valuations`, `cost_entries` |
| API | Endpoints §4.6 de l'architecture API ; interne : `recordMoves`, `availability`, `reserve`, `releaseReservation`, `transferReservation`, `consumeAllocation`, `declareLoss`, `recordConsumption`, `createLot`, `lotHeadcount`, `unitCost`, `recordCost`, `onLateMove` (rapprochements) |
| Événements | `StockTransfer*`, `StockAllocation*`, `StockReservationChanged`, `StockLoss*`, `ConsumptionRecorded`, `InventoryCount*`, `InventoryAdjusted`, `StockThresholdBreached`, `StockNegativeDetected`, `ProductValuationChanged`, `CostEntryRecorded` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments` |
| Interdites | `sales`, `procurement`, `production`, `finance`, `crm` (ils l'appellent ; il ne les appelle jamais) |

## 12. `procurement`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Fournisseurs, demandes d'achat, bons de commande, réceptions |
| Tables | `suppliers`, `purchase_requests`, `purchase_request_lines`, `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines` |
| API | §4.8 ; interne : `procurement.supplier(id)`, `procurement.poLineMatching(poLine)`, `procurement.recordDirectReceipt(uow, …)` (mise en place directe) |
| Événements | `Supplier*`, `PurchaseRequest*`, `PurchaseOrder*`, `GoodsReceived`, `GoodsReceiptQuarantined`, `GoodsReceiptCancelled`, `ReceiptIncompleteDetected` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory` |
| Interdites | `finance`, `production`, `sales` |

## 13. `production`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Lots, entrées, saisies quotidiennes, collectes d'œufs, incubation |
| Tables | `production_lots`, `lot_entries`, `lot_weighings`, `lot_observations`, `egg_collections`, `incubation_batches`, `incubation_events` |
| API | §4.7 ; interne : `production.lot(id)`, `production.lotStatus(id)` |
| Événements | `ProductionLot*`, `LotEntryRecorded`, `MortalityRecorded`, `LotInputConsumed`, `Lot*Recorded`, `EggCollection*`, `Incubation*`, `Candling*`, `Hatch*`, `ProductionRecorded`, `LotStatusChanged`, `HighMortalityDetected` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory`, `procurement` |
| Interdites | `sales`, `finance`, `crm` |

## 14. `finance`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Comptes et registre de trésorerie, sessions de caisse, remises de fonds, moyens de paiement, dépenses, factures et paiements fournisseurs, dettes |
| Tables | `payment_methods`, `cash_accounts`, `cash_sessions`, `cash_movements`, `cash_transfers`, `expense_categories`, `expenses`, `supplier_invoices`, `supplier_invoice_lines`, `supplier_payments`, `supplier_payment_allocations` (+ vue `v_payables`) |
| API | §4.9 ; interne : `finance.recordCashMovement(uow, …)`, `finance.openSessionFor(account, at)`, `finance.cashAccountFor(context)`, `finance.paymentMethod(code)` |
| Événements | `CashSession*`, `CashVarianceDetected`, `CashTransfer*`, `Expense*`, `SupplierInvoice*`, `SupplierPaymentRecorded` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory` (`recordCost` pour les dépenses imputées), `procurement` (lecture pour le rapprochement) |
| Interdites | `sales`, `crm`, `production` |

## 15. `sales`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Commandes, ventes, encaissements clients, affectations, créances |
| Tables | `sales_orders`, `sales_order_lines`, `sales`, `sale_lines`, `customer_payments`, `payment_allocations` (+ vue `v_receivables`) |
| API | §4.5 ; interne : `sales.receivables(customer)` |
| Événements | `Order*`, `Sale*`, `PriceOverrideApplied`, `PriceMismatchDetected`, `CreditLimitExceeded`, `Payment*`, `ReceivableOverdue` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `crm`, `fieldwork`, `pricing`, `inventory`, `finance` |
| Interdites | `procurement`, `production` (la vente d'un lot passe par `inventory`) |

## 16. `communication`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Règles d'alerte, alertes, notifications, push, notes de direction |
| Tables | `alert_rules`, `alerts`, `notifications`, `push_subscriptions`, `internal_notes`, `note_audiences`, `note_acknowledgements` |
| API | `/alerts`, `/notifications`, `/notes`. **Aucune API interne appelée par les modules métier** : les alertes naissent des gestionnaires d'événements de `communication` (et de ses tâches planifiées) |
| Événements | `Alert*`, `InternalNote*` |
| Autorisées | `platform`, `audit`, `identity`, `organization` ; **consomme** les événements de tous les modules |
| Interdites | Appels synchrones vers les modules métier (seulement de la lecture de résumé par événement) |

## 17. `sync`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Inbox des commandes, répartition vers les gestionnaires, flux de changements, chargement initial, conflits, supervision des appareils |
| Tables | `command_inbox`, `sync_conflicts`, `change_feed`, `device_sync_state` |
| API | `/sync/*`, `/commands` ; interne : `changeFeed.append(uow, …)` (utilisé par tous les modules), `conflicts.open(uow, …)` |
| Événements | `CommandRejected`, `SyncConflict*`, `DeviceSequenceGapDetected`, `ClockSkewDetected`, `DeviceSyncStale` |
| Autorisées | `platform`, `audit`, `identity` ; **registre** des gestionnaires de commandes (inversion : les modules s'enregistrent) |
| Interdites | Logique métier (aucune règle de domaine dans `sync`) |

## 18. `analytics`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Couche sémantique, jeux de faits, tableaux de bord, explorateur, vues sauvegardées, exports, instantanés |
| Tables | `saved_views`, `export_jobs`, `kpi_snapshots` (+ vues `f_*`, agrégats futurs) |
| API | `/analytics/*` |
| Événements | `AnalyticsExport*`, `SavedViewShared` |
| Autorisées | Lecture de tous les schémas **via des vues de lecture publiées** par chaque module ; `identity` (portées) |
| Interdites | Toute écriture hors de son schéma |

## 19. `integrations`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Adaptateur Kommo : liens externes, boîtes d'entrée et de sortie, configuration |
| Tables | `external_links`, `inbox_messages`, `outbox_messages`, `integration_settings` |
| API | `/integrations/kommo/*` |
| Événements | `Kommo*` |
| Autorisées | `platform`, `audit`, `identity`, `crm` (API de création et de rapprochement), lecture de `sales` (indicateurs agrégés) ; **consomme** les événements CRM, ventes et encaissements |
| Interdites | Écriture directe dans les tables des autres modules |
