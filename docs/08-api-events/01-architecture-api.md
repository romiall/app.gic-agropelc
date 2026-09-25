# Architecture API (Livrable n°9)

> Section 22 du format final (PM §48). Décision : ADR-019 (style d'API). Ce document fixe les **domaines d'API**, leurs commandes, requêtes, événements, exigences d'idempotence et permissions. Il ne décrit pas chaque endpoint (PM §32).

---

## 1. Style retenu : commandes + requêtes sur HTTP/JSON

| Besoin | Mécanisme | Justification |
|---|---|---|
| Écritures depuis la PWA (en ligne ou hors ligne) | `POST /api/v1/sync/push` (lot de commandes) | Chemin d'écriture unique (O1, BR-SYN-001) ; idempotence par `command_id` |
| Écritures du back-office (en ligne) | `POST /api/v1/commands` (une commande, **même enveloppe**) | Même gestionnaire, même idempotence, même audit ; pas de second modèle d'écriture |
| Lectures | `GET /api/v1/<ressource>` (REST, pagination par curseur, filtres déclarés) | Simple, cacheable, compatible avec les proxys |
| Téléchargement hors ligne | `GET /api/v1/sync/pull`, `POST /api/v1/sync/bootstrap` | Flux de changements par périmètre |
| Analyse flexible | `POST /api/v1/analytics/query` (DSL déclaratif : jeu, dimensions, mesures, filtres) | Flexibilité de type tableau croisé sans SQL libre (BR-ANA-006) |
| Fichiers | `/api/v1/attachments/*` (upload par morceaux) | Reprise sur réseau faible (ADR-012) |
| Intégration entrante | `POST /api/v1/integrations/kommo/webhook` | Webhooks authentifiés |

Alternatives écartées (détail dans ADR-019) :

- **REST CRUD pur**, qui pousse l'appareil à envoyer des états et non des intentions : incompatible avec l'idempotence, la fusion des conflits et l'audit par intention.
- **GraphQL** : aucun gain pour une PWA hors ligne dont les écritures passent par une outbox ; complexité de sécurité (requêtes arbitraires, contrôle de portée par champ).
- **gRPC** : mal supporté par les navigateurs, peu utile sur ce volume.

## 2. Conventions

| Sujet | Règle |
|---|---|
| Versionnement | Préfixe `/api/v1` ; `command_version` par type de commande (BR-SYN-016) |
| Authentification | `Authorization: Bearer <jeton d'accès>` ; `device_id` dans le jeton |
| Identifiants | UUIDv7 dans les URL et les corps ; les numéros officiels sont des attributs, jamais des clés d'URL |
| Pagination | Par curseur (`cursor`, `limit` ≤ 200) ; pas de pagination par décalage sur les grandes tables |
| Filtres | Déclarés par ressource (liste blanche) ; toute requête est restreinte à la portée de l'utilisateur |
| Dates | ISO 8601 UTC en transport ; les filtres de période sont interprétés en jour métier `Africa/Douala` |
| Montants | Entiers XAF |
| Erreurs | `{ "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": {…}, "correlation_id": "…" } }` ; codes HTTP : 400 (validation), 401, 403, 404 (hors portée **ou** inexistant, sans distinction), 409 (conflit de version), 422 (règle métier), 429, 5xx |
| Résultat d'une commande | Enveloppe de résultat identique pour `/commands` et `/sync/push` (synchronisation §3.1) |
| Idempotence | **Obligatoire** sur toute commande (`command_id`) ; les lectures sont sans effet |
| Compression | `gzip` accepté en requête (push) et en réponse |
| Langue | Messages d'erreur en français ; codes stables en anglais |

## 3. Enveloppe de commande et gestionnaires

Enveloppe : voir [`../06-offline-sync/02-synchronisation.md`](../06-offline-sync/02-synchronisation.md) §2. Chaque `command_type` a :

- un **schéma** versionné (bibliothèque partagée) ;
- une **permission** requise, et la ressource à laquelle s'applique la portée ;
- un **gestionnaire** unique dans le module propriétaire ;
- la liste des **événements** publiés ;
- sa **classe de conflit** (fait accompli ou intention).

Il n'existe **aucune** écriture en dehors de ces gestionnaires : pas d'endpoint `PUT /sales/{id}`.

## 4. Domaines d'API

Pour chaque domaine : responsabilités, commandes, requêtes, événements, idempotence, permissions. Dans les tableaux, **F** = fait accompli (jamais rejeté pour une raison d'état, BR-SYN-007) et **I** = intention sur un état partagé (`base_version`).

### 4.1 `/auth`, `/users`, `/devices`, `/roles` — module `identity`

| Élément | Contenu |
|---|---|
| Responsabilités | Authentification, sessions, enrôlement et cycle de vie des appareils, utilisateurs, rôles, affectations |
| Endpoints hors commandes | `POST /auth/login` (téléphone, mot de passe, empreinte d'appareil) → jetons + statut d'appareil ; `POST /auth/refresh` ; `POST /auth/logout` |
| Commandes (I) | `identity.user.create`, `.update`, `.suspend`, `.deactivate`, `.reactivate` ; `identity.role.set_permissions` ; `identity.role_assignment.grant`, `.revoke` ; `identity.device.approve`, `.block`, `.unblock`, `.declare_lost`, `.retire` ; `identity.session.revoke` |
| Requêtes | `GET /users`, `/users/{id}`, `/me` (profil, droits effectifs), `/devices`, `/roles`, `/permissions` |
| Événements | `UserCreated`, `UserDeactivated`, `RoleAssigned`, `DeviceApproved`, `DeviceBlocked`… |
| Idempotence | `command_id` ; `/auth/login` n'est pas idempotent (rate limit) |
| Permissions | `identity.*` |

### 4.2 `/sites`, `/locations`, `/zones`, `/teams`, `/settings` — module `organization`

| Élément | Contenu |
|---|---|
| Commandes (I) | `organization.site.create`, `.update`, `.close` ; `organization.pos.configure` ; `organization.location.create`, `.update`, `.deactivate` ; `organization.zone.create`, `.update` ; `organization.team.create`, `.set_members` ; `organization.setting.set` |
| Requêtes | `GET /sites`, `/locations?site_id=`, `/zones/tree`, `/teams`, `/settings?keys=` |
| Événements | `SiteCreated`, `LocationCreated`, `ZoneUpdated`, `TeamMembershipChanged`, `SystemSettingChanged` |
| Permissions | `org.structure.*`, `org.settings.manage` |

### 4.3 `/products`, `/units`, `/reason-codes` — module `catalog` ; `/price-rules`, `/campaigns`, `/prices/resolve` — module `pricing`

| Élément | Contenu |
|---|---|
| Commandes (I) | `catalog.product.create`, `.update`, `.deactivate`, `.reactivate`, `.set_standard_cost` ; `catalog.product_unit.set` ; `catalog.category.set` ; `catalog.unit.set` ; `catalog.reason_code.set` ; `pricing.rule.draft`, `.activate`, `.supersede`, `.end`, `.cancel` ; `pricing.campaign.create`, `.update`, `.cancel` |
| Requêtes | `GET /products`, `/price-rules?product_id=&at=`, `GET /prices/resolve?product_id=&site_id=&customer_id=&quantity=&at=` (simulateur ; même moteur que l'appareil) |
| Événements | `ProductCreated`, `ProductDeactivated`, `PriceRuleActivated`, `PriceRuleSuperseded` |
| Permissions | `catalog.*`, `pricing.*` |

### 4.4 `/customers`, `/visits`, `/interactions`, `/targets` — module `crm` ; `/work-sessions` — module `fieldwork`

| Élément | Contenu |
|---|---|
| Commandes | `crm.customer.create` (F pour la création), `.update` (I, fusion champ par champ), `.set_pipeline_step` (I), `.mark_lost` (I), `.reopen` (I), `.reassign` (I, en ligne), `.merge` (en ligne), `.set_credit_terms` (en ligne) ; `crm.visit.record` (F), `.cancel` ; `crm.interaction.record` (F), `.cancel` ; `crm.target.set`, `.cancel` ; `crm.pipeline.configure` ; `fieldwork.checkin.record` (F), `fieldwork.checkin.request_override` (F) |
| Requêtes | `GET /customers?owner=me&stage=&q=`, `/customers/{id}` (fiche : historique, visites, commandes, ventes, créances, liens Kommo), `GET /customers/duplicate-check?phone=` (réponse masquée, AV-014), `/visits?user_id=&from=&to=`, `/targets?user_id=`, `/work-sessions?team_id=&date=` |
| Événements | `ProspectCreated`, `CustomerConverted`, `CustomerReassigned`, `VisitRecorded`, `WorkSessionStarted`, `CheckInRejected` |
| Permissions | `crm.*`, `fieldwork.*` |

### 4.5 `/orders`, `/sales`, `/payments`, `/receivables` — module `sales`

| Élément | Contenu |
|---|---|
| Commandes | `sales.order.save_draft` (I), `.place` (F pour l'engagement), `.update` (I), `.cancel` (I), `.close_remaining` (I), `.fulfil` (F) ; `sales.sale.record` (F), `.cancel` (F dans le délai, sinon transformée en demande), `.request_cancellation` (F) ; `sales.payment.record` (F), `.request_cancellation`, `.reallocate` (en ligne) |
| Requêtes | `GET /orders?status=&fulfilment_location_id=`, `/sales?site_id=&from=&to=`, `/sales/{id}` (lignes, mouvements, paiements, historique), `/sales/{id}/receipt` (reçu), `/receivables?customer_id=&aging=` |
| Événements | `OrderConfirmed`, `OrderFulfilled`, `SaleConfirmed`, `SaleCancelled`, `PaymentReceived`, `PaymentAllocated`, `PriceMismatchDetected` |
| Idempotence | `command_id` ; `(moyen, référence)` unique pour les paiements ; livraison ≤ reliquat |
| Permissions | `sales.*` |

### 4.6 `/stock`, `/stock-moves`, `/transfers`, `/allocations`, `/losses`, `/consumptions`, `/inventory-counts`, `/thresholds`, `/costs` — module `inventory`

| Élément | Contenu |
|---|---|
| Commandes | `inventory.transfer.request` (F), `.decline` (I), `.cancel` (I), `.dispatch` (F), `.receive` (F), `.move_internal` (F), `.return_to_source` (F) ; `inventory.allocation.grant` (en ligne), `.release` (F, émise par l'appareil), `.revoke` (en ligne) ; `inventory.loss.declare` (F), `.withdraw`, `.request_cancellation` ; `inventory.consumption.record` (F), `.cancel` ; `inventory.count.open`, `.record_lines`, `.submit` (F), `.cancel` ; `inventory.threshold.set` ; `inventory.cost_entry.record` (en ligne) |
| Requêtes | `GET /stock?location_id=&product_id=` (solde, disponible, réservé, alloué, par lot), `GET /stock/availability?zone_id=&product_id=` (réponse à « combien de poulets à Douala »), `GET /stock-moves?location_id=&product_id=&from=&to=` (registre, explication d'écart), `GET /stock/at?location_id=&at=` (solde à date), `/transfers?status=`, `/losses?status=`, `/inventory-counts/{id}`, `/costs?cost_object=` |
| Événements | `StockTransferDispatched`, `StockTransferReceived`, `StockLossDeclared`, `InventoryAdjusted`, `StockNegativeDetected`, `StockThresholdBreached` |
| Permissions | `inventory.*` |
| API interne (non HTTP) | `recordMoves(document, lines)`, `reserve(orderLine, qty)`, `consumeAllocation(...)`, `valuate(product, lot)`, `recordCost(...)`, appelées dans la transaction du module appelant (ADR-011) |

### 4.7 `/production/lots`, `/production/egg-collections`, `/production/incubations` — module `production`

| Élément | Contenu |
|---|---|
| Commandes | `production.lot.create`, `.cancel`, `.set_status`, `.close` (en ligne), `.record_entry` (F) ; `production.mortality.record` (F), `production.input.record` (F), `production.weighing.record` (F), `production.observation.record` (F) ; `production.egg_collection.record` (F), `.cancel` ; `production.incubation.start` (F), `.record_candling` (F), `.transfer_to_hatcher` (F), `.record_hatch` (F), `.cancel` |
| Requêtes | `GET /production/lots?site_id=&status=`, `/production/lots/{id}` (effectif, mortalité, consommations, pesées, coûts, ventes, marge), `/production/lots/{id}/daily?from=&to=`, `/production/incubations?status=` |
| Événements | `ProductionLotCreated`, `LotEntryRecorded`, `MortalityRecorded`, `EggCollectionRecorded`, `HatchRecorded`, `ProductionLotClosed` |
| Permissions | `production.*` |

### 4.8 `/suppliers`, `/purchase-requests`, `/purchase-orders`, `/receipts` — module `procurement`

| Élément | Contenu |
|---|---|
| Commandes | `procurement.supplier.create`, `.update` ; `procurement.request.submit` (F), `.cancel`, `.close` ; `procurement.order.create`, `.submit`, `.mark_sent`, `.close_remaining`, `.cancel` ; `procurement.receipt.record` (F), `.request_cancellation` |
| Requêtes | `GET /suppliers`, `/purchase-orders?status=&site_id=` (reliquats), `/purchase-orders/{id}/matching` (commandé, livré, rejeté, accepté, facturé, payé), `/receipts?from=&to=` |
| Événements | `PurchaseRequestSubmitted`, `PurchaseOrderApproved`, `GoodsReceived`, `GoodsReceiptQuarantined` |
| Permissions | `procurement.*` |

### 4.9 `/cash-accounts`, `/cash-sessions`, `/cash-transfers`, `/expenses`, `/supplier-invoices`, `/supplier-payments`, `/payables` — module `finance`

| Élément | Contenu |
|---|---|
| Commandes | `finance.cash_session.open` (F), `.close` (F), `.force_close`, `.validate` ; `finance.cash_transfer.send` (F), `.receive` (F), `.cancel` ; `finance.expense.record` (F), `.pay`, `.cancel` ; `finance.supplier_invoice.record`, `.dispute`, `.approve`, `.cancel` ; `finance.supplier_payment.record`, `.cancel` ; `finance.cash_account.create`, `.update` |
| Requêtes | `GET /cash-accounts` (soldes), `/cash-accounts/{id}/movements`, `/cash-sessions?status=`, `/expenses?from=&to=`, `/payables?supplier_id=`, `/margins?group_by=` (délégué à analytics) |
| Événements | `CashSessionClosed`, `CashVarianceDetected`, `ExpenseRecorded`, `SupplierInvoiceMismatchDetected`, `SupplierPaymentRecorded` |
| Permissions | `finance.*` |

### 4.10 `/approvals`, `/attachments`, `/alerts`, `/notifications`, `/notes` — modules `approvals`, `attachments`, `communication`

| Élément | Contenu |
|---|---|
| Commandes | `approvals.request.approve`, `.reject`, `.withdraw` ; `approvals.policy.set` ; `communication.alert.acknowledge`, `.resolve`, `.dismiss` ; `communication.alert_rule.set` ; `communication.note.publish`, `.archive`, `.acknowledge` ; `communication.push.subscribe` |
| Endpoints de fichiers | `POST /attachments/{id}/upload-session`, `PUT /attachments/{id}/content` (`Content-Range`), `HEAD /attachments/{id}/content` (offset), `GET /attachments/{id}/url` (URL signée) |
| Requêtes | `GET /approvals/inbox` (file de validation unifiée du périmètre), `/alerts?status=open`, `/notifications`, `/notes` |
| Événements | `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected`, `AlertRaised`, `InternalNotePublished` |

### 4.11 `/sync` — module `sync`

| Endpoint | Rôle |
|---|---|
| `POST /sync/push` | Lot de commandes (synchronisation §3) |
| `GET /sync/pull?dataset=&cursor=&limit=` | Changements incrémentaux (§5) |
| `POST /sync/bootstrap` | Chargement initial paginé d'un jeu, avec son `high_water` |
| `GET /sync/status` | État serveur de l'appareil (dernière séquence reçue, trous, écart d'horloge) |
| Commandes | `sync.conflict.resolve`, `sync.conflict.dismiss` (en ligne) |
| Requêtes | `GET /sync/conflicts?status=open`, `GET /sync/devices` (supervision) |

### 4.12 `/analytics` — module `analytics`

| Endpoint | Rôle |
|---|---|
| `GET /analytics/dashboards/{code}?period=` | Tableaux de bord par rôle (instantanés, fraîcheur) |
| `POST /analytics/query` | Requête déclarative : `{dataset, dimensions[], measures[], filters[], sort[], limit}` |
| `GET /analytics/catalog` | Jeux, dimensions et mesures autorisés pour l'utilisateur |
| Commandes | `analytics.view.save`, `.share`, `.delete` ; `analytics.export.request` (asynchrone) |

### 4.13 `/integrations/kommo` — module `integrations`

| Endpoint | Rôle |
|---|---|
| `POST /integrations/kommo/webhook` | Réception authentifiée ; enregistrement brut ; réponse 200 immédiate ; traitement asynchrone |
| Commandes | `integrations.kommo.settings.set`, `integrations.kommo.replay` |
| Requêtes | `GET /integrations/kommo/messages?status=` (supervision) |

## 5. Exigences transverses

| Exigence | Détail |
|---|---|
| Idempotence | Toute commande : inbox (INV-SYN-01). Webhooks : clé de déduplication (INV-KOM-02). Upload : identifiant de pièce + offset |
| Concurrence | Verrou par appareil pour le push ; verrous de ligne sur les soldes (stock, caisse) ; `base_version` pour les intentions |
| Performance | Voir NFR-10 à NFR-14 (latence p95 des commandes, des lectures et d'`analytics/query`) |
| Traçabilité | `correlation_id` renvoyé dans chaque réponse et propagé aux événements et à l'audit |
| Documentation | OpenAPI générée depuis les schémas partagés ; catalogue des commandes généré depuis le registre des gestionnaires |
