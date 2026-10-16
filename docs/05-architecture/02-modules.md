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

**Lectures HTTP (P5-17).** Les contrôleurs de lecture appartiennent à la couche de transport (`apps/server/src/<module>-api/`, `apps/server/src/sync/`), non aux modules : ils composent au besoin les lectures publiques de plusieurs modules (le PDV et sa caisse, la session de caisse et ses sous-totaux par vendeur). Ils partagent la boîte à outils `apps/server/src/read-api/read-access.ts` (`ReadAccess`, `parseOrThrow`), extraite du patron de P4-10 : 400 `VALIDATION_ERROR`, 403 `FORBIDDEN` audité (`access.denied`), 404 `NOT_FOUND` audité hors portée ou inconnu. Aucun module n'importe ce dossier. Les tableaux d'analyse livrés avant P9 suivent le même patron (`apps/server/src/distribution-api/`, P5-20, ADR-035) ; `read-api/distribution-targets.ts` résout les cibles d'un ensemble de PDV (sites, emplacements de vente, caisses), pour le tableau et pour l'accueil.

## 1. `platform` (noyau partagé technique)

| Rubrique | Contenu |
|---|---|
| Responsabilité | Types transverses (UUIDv7, argent, quantités, temps métier), unité de travail, outbox d'événements, séquences documentaires, file de tâches, registre des commandes et des consommateurs |
| Tables | `platform.domain_events`, `platform.event_consumer_offsets`, `platform.document_sequences`, `platform.jobs`, `platform.event_consumer_marks`, `platform.job_schedules` (P5-16) |
| API | `uow.begin()`, `events.publish(uow, evt)`, `sequences.next(uow, type, site, year)`, `jobs.enqueue(...)`, `clock.now()` ; ordonnanceur (P5-16) : `recurringJobs.register({ jobType, schedule })` (jeton `RECURRING_JOB_REGISTRY`, une ligne d'inscription par tâche dans le module propriétaire, au démarrage) et `scheduler.enqueueDue()` (appelé par la boucle du worker). `schedule` : `{ kind: 'INTERVAL', intervalSeconds }` ou `{ kind: 'DAILY', localTime: 'HH:MM' }` (Africa/Douala) ; le gestionnaire reste enregistré dans `JobHandlerRegistry`. Sémantique : au plus un dépôt par créneau (verrou de ligne `SKIP LOCKED`), aucun rattrapage en rafale, aucun empilement tant que la tâche précédente est `PENDING` |
| Événements | — |
| Dépendances autorisées | Aucune |
| Interdites | Tout module métier |

## 2. `audit`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Journal d'audit chaîné (D12) |
| Tables | `audit.audit_log` |
| API | `audit.record(uow, entry)`, `audit.recordDenied(entry)` (transaction séparée) ; requête `GET /audit` |
| Événements | `AuditChainBroken` (P9-10 : publié par `audit.chain.verify_daily`, 03:00 Douala, AV-470) |
| Autorisées | `platform` |
| Interdites | Tout module métier (il est appelé, il n'appelle pas) |

## 3. `identity`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Utilisateurs, rôles, permissions, affectations, appareils, sessions, droits effectifs |
| Tables | `users`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `devices`, `auth_sessions` |
| API | `/auth/*`, `/users`, `/devices`, `/roles` ; interne : `authz.can(user, permission, resource, at)`, `authz.scopeFilter(user, resourceType, at)`, `identity.getUser(id)`, `identity.deviceStatusAt(device, at)`. **Livré en P5-17** : `evaluateAccess` accepte `roleCodes` (évaluation restreinte aux affectations de ces rôles : la portée d'une décision vient du rôle qui la fonde, AV-191) ; le cache des octrois porte le rôle de l'affectation. |
| Événements | `User*`, `Role*`, `Device*`, `SessionRevoked` |
| Autorisées | `platform`, `audit`, `organization` (l'évaluateur de portée lit les zones, sites et équipes par l'API d'`organization`) |
| Interdites | Modules métier |

## 4. `organization`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Zones, sites, PDV, emplacements (y compris virtuels), équipes, paramètres |
| Tables | `zones`, `sites`, `points_of_sale`, `locations`, `teams`, `team_memberships`, `system_settings` |
| API | `/sites`, `/locations`, `/zones`, `/teams`, `/settings` ; interne : `org.zonePath(zone)`, `org.location(id)`, `org.virtualLocation(type)`, `org.teamMembersAt(team, at)`, `settings.get(key, scope, at)`. **Livré en P5-17** : lectures publiques `listSites`, `findSite`, `listLocations`, `listPointsOfSale` (`structure-query.ts`), exposées par `GET /sites`, `/locations?site_id=` et `/points-of-sale` dans la couche de transport `apps/server/src/organization-api/` (droit `org.structure.read`, portée du site et de sa zone) ; la caisse et la session ouverte du PDV y sont composées depuis l'API publique de `finance`, sans que `organization` l'importe |
| Événements | `Site*`, `Location*`, `Zone*`, `TeamMembershipChanged`, `SystemSettingChanged` |
| Autorisées | `platform`, `audit`. Clés étrangères vers `identity.users` et `identity.devices` au titre des **références universelles** (voir le graphe §1), sans aucun appel de code vers `identity` |
| Interdites | `identity` (code), tous les modules métier au-dessus |

## 5. `approvals`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Politiques de contrôle, demandes de validation, file de validation, exécution des décisions via les gestionnaires enregistrés |
| Tables | `control_policies`, `approval_requests` |
| API | `/approvals/inbox`, commandes `approvals.*` ; interne : `approvals.evaluatePolicy(op, context, at)`, `approvals.request(uow, …)`, `approvals.registerHandler(operationType, handler)` ; `approvals.decideApprovalRequest(uow, registry, …)` (P5-13 : cœur des décisions, appelable par un module propriétaire qui offre une commande en façade, ex. `finance.cash_session.validate`) |
| Événements | `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected`, `ApprovalCancelled`, `ControlPolicyChanged` (aucun publié à ce jour : P9-11), `ApprovalPendingLong` (P9-09) |
| Tâches planifiées | P9-09 : `approvals.requests.pending_long_check` (horaire ; `escalated_at` posé une fois), dans `ApprovalsJobsModule` (importé aussi par le worker) |
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
| Événements | `Product*`, `ReasonCodeChanged`, `ProductStandardCostChanged` (non publié), `StandardCostSet` (P9-09 : un par version de coût, résolution immédiate de `STANDARD_COST_MISSING`, AV-463) |
| Autorisées | `platform`, `audit`, `identity` |
| Interdites | Modules métier au-dessus |

## 8. `fieldwork`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Pointages, sessions de travail, dérogations |
| Tables | `geo_checkins`, `work_sessions` |
| API | `/work-sessions` ; commandes `fieldwork.*` ; interne : `fieldwork.openSessionAt(user, at)` |
| Événements | `CheckIn*`, `WorkSession*`, `CheckInSuspicious` (P9-10 : sur `fieldwork.checkin.record`, AV-468) |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `approvals` |
| Interdites | `crm`, `sales` et au-dessus |

## 9. `crm`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Comptes clients, portefeuille, pipeline, visites, interactions, objectifs, référentiels commerciaux |
| Tables | `customers`, `customer_assignments`, `customer_stage_history`, `pipeline_steps`, `lead_sources`, `visits`, `interactions`, `sales_targets` |
| API | `/customers`, `/visits`, `/interactions`, `/targets` ; interne : `crm.customer(id)`, `crm.ownerAt(customer, at)`, `crm.creditStatus(customer)`, `crm.markConverted(uow, customer, sale)`, `crm.recordLastSale(uow, customer, at)`, `crm.createOrLinkFromExternal(uow, …)` |
| Événements | `Prospect*`, `Customer*`, `Visit*`, `InteractionRecorded`, `SalesTargetSet`, `CustomerDuplicateSuspected` et `CustomerDuplicateResolved` (P9-10 : sur `crm.customer.create` et `crm.customer.merge`, AV-469) |
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
| Tables | `stock_lots`, `stock_moves`, `stock_balances`, `stock_balance_snapshots`, `stock_transfers`, `stock_transfer_lines`, `transfer_pair_locks` (P5-16), `stock_allocations`, `stock_allocation_entries`, `loss_declarations`, `consumptions`, `inventory_counts`, `inventory_count_lines`, `stock_thresholds`, `product_valuations`, `cost_entries` |
| API | Endpoints §4.6 de l'architecture API ; interne : `recordMoves`, `availability`, `consumeAllocation`, `declareLoss`, `recordConsumption`, `createLot`, `lotHeadcount`, `unitCost`, `recordCost`, `reverseDocument` (contre-passation d'un document), `onLateMove` (rapprochements) ; P5-16 : `pairTransit` (transit net d'une paire de transfert, par produit), `transferTransit` (transit d'un document), `verifyTransferTransit` (INV-STK-08, relue par `inventory.ledger.reconcile_daily`). **Livré en P5-17** : lectures publiques des quotas `listAllocations`, `findAllocation`, `listAllocationEntries`, `activeAllocationTotals` (`allocation-query.ts`), exposées par `GET /allocations(/{id})` (`apps/server/src/inventory-api/`, droit `inventory.stock.read`) ; `isAllocationOvercommitted`, `hasNegativeStock` (`stock-conflict-conditions.ts`), consultées avant la clôture manuelle d'un conflit (AV-190). Tâches récurrentes inscrites à l'ordonnanceur : `inventory.transfers.unmatched_sweep` (horaire), `inventory.allocations.expiry_daily` (00:05), `inventory.ledger.reconcile_daily` (02:00) ; P9-08 : `inventory.alerts.stock_threshold_sweep` (horaire), `inventory.alerts.lot_expiring_daily` (06:00), `inventory.alerts.transfer_not_received_check` (06:30), et, dans `sales`, `sales.losses.sales_share_check` (06:45), heures de Douala ; les tâches quotidiennes des autres modules (audit, finance, ventes, terrain) s'inscrivent de la même façon, une ligne chacune, dans leur module |
| Événements | `StockTransfer*`, `StockAllocation*`, `AllocationRevocationPending`, `AllocationExpired`, `StockLoss*`, `ConsumptionRecorded`, `InventoryCount*`, `InventoryAdjusted`, `StockThresholdBreached`, `StockNegativeDetected`, `ProductValuationChanged`, `CostEntryRecorded` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments` |
| Interdites | `sales`, `procurement`, `production`, `finance`, `crm` (ils l'appellent ; il ne les appelle jamais) |

## 12. `procurement`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Fournisseurs, demandes d'achat, bons de commande, réceptions |
| Tables | `suppliers`, `purchase_requests`, `purchase_request_lines`, `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines` |
| API | §4.8 ; interne : `findSupplier(id)` (P8-05), `lockOrderForInvoicing`, `applyInvoicedQuantities`, `receiptLinesForInvoicing` (facturation par `finance`, ADR-043 §3, P8-07), `purchaseOrderMatching`, `procurement.receiptForPlacement(receipt)` (mise en place directe : réception et entrée de lot dans le même lot de commandes, AV-112) |
| Événements | `Supplier*`, `PurchaseRequest*`, `PurchaseOrder*`, `GoodsReceived` (non publié), `GoodsReceiptQuarantined`, `GoodsReceiptQuarantineDecided`, `GoodsReceiptCancelled` (non publié), `ReceiptIncompleteDetected`, `ReceiptIncompleteCleared`, `AttachmentMissingDetected` (réceptions) — P9-09 |
| Tâches planifiées | P9-09 : `procurement.receipts.attachment_missing_check` (06:15) et `procurement.orders.receipt_incomplete_check` (07:15), dans `ProcurementJobsModule` (importé aussi par le worker) |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory` |
| Interdites | `finance`, `production`, `sales` |

## 13. `production`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Lots, entrées, saisies quotidiennes, collectes d'œufs, incubation, abattage, répartition des frais généraux (ADR-026) |
| Tables | `production_lots`, `lot_entries`, `lot_weighings`, `lot_observations`, `egg_collections` (+ lignes), `incubation_batches`, `incubation_events`, `slaughter_batches` (+ produits), `overhead_allocations` (+ lignes) |
| API | §4.7 ; interne : `production.lot(id)`, `production.lotStatus(id)` |
| Événements | `ProductionLot*`, `LotEntryRecorded`, `MortalityRecorded` (non publié), `LotInputConsumed`, `Lot*Recorded`, `EggCollection*`, `Incubation*`, `Candling*`, `Hatch*`, `ProductionRecorded`, `LotStatusChanged`, `HighMortalityDetected` (P9-09 : sur `production.mortality.record`, agrégat lot × jour), `DailyEntryMissing`, `StandardCostMissing` (passes planifiées) |
| Tâches planifiées | P9-09 : `production.products.standard_cost_check` (07:45), `production.lots.daily_entry_check` (10:00), dans `ProductionJobsModule` (importé aussi par le worker) |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory`, `procurement` |
| Interdites | `sales`, `finance`, `crm` |

## 14. `finance`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Comptes et registre de trésorerie, sessions de caisse, remises de fonds, moyens de paiement, dépenses, factures et paiements fournisseurs, dettes |
| Tables | `payment_methods`, `cash_accounts`, `cash_sessions`, `cash_movements`, `cash_transfers`, `expense_categories`, `expenses`, `supplier_invoices`, `supplier_invoice_lines`, `supplier_payments`, `supplier_payment_allocations` (+ vue `v_payables`) |
| API | §4.9 ; interne : `finance.recordCashMovement(uow, …)`, `finance.findCashSessionCovering(executor, account, at, { lock })`, `finance.cashAccountFor(context)`, `finance.paymentMethod(code)`. **Livré en P4-03** : `recordCashMovement` (registre en ajout seul, inverse, caisse physique jamais négative en ligne), `findCashAccount`, `cashAccountBalance`, `verifyCashLedger`, `rebuildCashBalances`, commandes `finance.cash_account.create`/`update`/`deactivate`, tâche `finance.cash.reconcile_daily` ; `cashAccountFor` et `paymentMethod` suivront avec les encaissements (P4-08). **Livré en P5-12** : `findCashSessionCovering` (session dont la fenêtre couvre un instant ; remplace `openSessionFor` prévu, pour que `sales` pose l'index `cash_session_id` de ses documents en P5-14) ; `recordCashMovement` pose cet index sur le registre d'une caisse de PDV ; commandes `finance.cash_session.open`/`close`/`force_close` (`CashSessionCommandsRegistrar`) ; garde de désactivation `finance` enregistrée auprès du registre d'`organization` (`LOCATION_HAS_OPEN_CASH_SESSION` ; dépendance `organization` déjà autorisée) ; tâche `finance.cash_sessions.open_long_check` (`FinanceJobsModule`) ; **Livré en P5-15** : commandes `finance.cash_transfer.send`, `.receive`, `.cancel`, décision `CASH_TRANSFER_DISCREPANCY` (registre des décisions d'`approvals`, garde de retrait), tâche `finance.cash_transfers.unreceived_check`, fonctions `findCashTransfer`, `cashTransfersInTransit` (indicateur « en transit »), `verifyCashTransfers` ; **Livré en P5-13** : commande `finance.cash_session.validate` (façade de la décision `CASH_VARIANCE`), décision `CASH_VARIANCE` et garde de retrait enregistrées auprès d'`approvals`, réévaluation par le delta dans `recordCashMovement` (champ `reevaluation` du résultat), `verifyCashSessionVariance` (INV-FIN-11, une session, lectures verrouillantes : tests) ; **Livré en P5-22** : `verifyCashSessions` (toutes les sessions ou une portée, sans verrou : INV-FIN-05, 06, 11, BR-DIS-006), branchée avec `verifyCashTransfers` sur `finance.cash.reconcile_daily` ; **Livré en P5-14** : `recordCashMovement` renvoie l'index posé (`cashSessionId`, que `sales` recopie sur l'encaissement et la vente), `findCashSessionSummary` et `cashSessionWindowFlows` (lectures d'une session et des flux de sa fenêtre pour les sous-totaux par vendeur, sans que `finance` importe `sales` : la composition est faite par la couche de transport `apps/server/src/finance-api/`, route `GET /cash-sessions/{id}`) ; **Livré en P5-17** : lectures publiques `listCashSessions`, `findCashSessionDetail`, `listCashSessionAdjustments`, `listCashTransfers`, `cashTransferMovements`, `CASH_TRANSFER_STATUSES`, exposées par `GET /cash-sessions(/{id})` (avec les sous-totaux par vendeur) et `GET /cash-transfers(/{id})` (`apps/server/src/finance-api/cash-operations-read.controller.ts`, droit `finance.cash.read`, portée du compte) |
| Événements | `CashSession*`, `CashVarianceDetected`, `CashTransfer*`, `Expense*`, `SupplierInvoice*`, `SupplierPaymentRecorded` |
| Autorisées | `platform`, `audit`, `identity`, `organization`, `catalog`, `approvals`, `attachments`, `inventory` (`recordCost` pour les dépenses imputées), `procurement` (lecture pour le rapprochement) |
| Interdites | `sales`, `crm`, `production` |

## 15. `sales`

| Rubrique | Contenu |
|---|---|
| Responsabilité | Commandes, ventes, encaissements clients, affectations, créances |
| Tables | `sales_orders`, `sales_order_lines`, `sales`, `sale_lines`, `sale_cancellations`, `sale_cancellation_lines`, `delivery_notes`, `delivery_note_lines`, `customer_payments`, `payment_allocations` (créances en requête, sans vue) |
| API | §4.5 ; interne : `sales.receivables(customer)`. **Livré en P5-14** : `paymentReceivers` (receveur de chaque encaissement, lu par la couche de transport `apps/server/src/finance-api/` qui compose les sous-totaux d'une session de caisse avec `finance`, que `finance` n'importe pas) |
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
| API | `/sync/*`, `/commands` ; interne : `changeFeed.append(uow, …)` (utilisé par tous les modules), `conflicts.open(uow, …)`. **Livré en P5-17** : lectures du noyau (`apps/server/src/platform/sync/conflicts.ts`) `listConflicts`, `findConflict`, `closeConflict`, `CONFLICT_STATUSES`, `CONFLICT_RESOLUTIONS` ; transport `apps/server/src/sync/` : `GET /sync/conflicts(/{id})` (`conflicts-read.controller.ts`), visibilité par rôle propriétaire et portée (`conflict-access.ts`, AV-191), commandes `sync.conflict.resolve` et `.dismiss` enregistrées par `SyncConflictCommandsRegistrar` (`conflict-commands.ts`, AV-190) |
| Événements | `CommandRejected`, `SyncConflict*` (`SyncConflictResolved` produit depuis P5-17, `SyncConflictDetected` pas encore), `DeviceSequenceGapDetected`, `ClockSkewDetected`, `DeviceSyncStale` |
| Autorisées | `platform`, `audit`, `identity` ; **registre** des gestionnaires de commandes (inversion : les modules s'enregistrent) |
| Interdites | Logique métier (aucune règle de domaine dans `sync`). Exception de transport (P5-17) : `apps/server/src/sync/` (et non le noyau `platform/sync/`) compose les API publiques d'`identity` (portée, `roleCodes`) et d'`inventory` (`findStockLocation`, `isAllocationOvercommitted`, `hasNegativeStock`) et le catalogue des rôles (`home-api/role-catalog.ts`) pour décider de la visibilité et de la clôture d'un conflit (AV-190 à AV-192) ; aucune table d'un autre module n'y est lue ni écrite |

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
