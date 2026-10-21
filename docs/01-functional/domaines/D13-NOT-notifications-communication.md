# D13 — Alertes, notifications et communication interne (NOT)

> Module de code : `communication`.

---

## 1. Objectif

Produire des **alertes utiles, qui provoquent une action** et ne s'accumulent pas (CM §54). Délivrer les notifications aux bonnes personnes. Permettre à la direction de diffuser des notes internes, qui ne remplacent jamais une règle automatisable (CM §43).

## 2. Acteurs

`system` (détection), tous les rôles (destinataires), `DIRECTION` (notes), `ADMIN` (configuration des règles d'alerte).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Règle d'alerte | `communication.alert_rules` | Type, seuils, gravité, destinataires, activation |
| Alerte | `communication.alerts` | Occurrence avec cycle de vie |
| Destinataire d'alerte | `communication.alert_recipients` | Boîte d'un utilisateur : qui doit voir l'alerte, et pourquoi (règle, propriétaire, escalade) — [ADR-072](../../decisions/ADR-072-destinataires-notifications-push-et-escalade.md) |
| Notification | `communication.notifications` | Message à un utilisateur (in-app, push) |
| Abonnement push | `communication.push_subscriptions` | Point de terminaison Web Push par appareil |
| Note de direction | `communication.internal_notes`, `communication.note_audiences`, `communication.note_acknowledgements` | Communication interne ciblée |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-NOT-01 | Lever une alerte (sur événement ou par tâche planifiée) | interne | `system` | n/a |
| UC-NOT-02 | Prendre en compte, résoudre ou écarter une alerte | `communication.alert.acknowledge`, `resolve`, `dismiss` | Destinataires | **Oui** (prise en compte) |
| UC-NOT-03 | Consulter ses alertes et notifications | requête | Tous | **Oui** (dernières) |
| UC-NOT-04 | Configurer les règles d'alerte | `communication.alert_rule.set` | ADMIN, DIRECTION | Non |
| UC-NOT-05 | Publier une note de direction | `communication.note.publish` | DIRECTION | Non |
| UC-NOT-06 | Lire et accuser réception d'une note | `communication.note.acknowledge` | Destinataires | **Oui** |
| UC-NOT-07 | S'abonner aux notifications push | `communication.push.subscribe` | Tous | Non |

## 5. Entrées

Événements métier, résultats de tâches planifiées, seuils configurés, notes rédigées.

## 6. Sorties

Alertes routées, notifications in-app et push, notes ciblées, accusés de lecture.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-NOT-001 | Chaque type d'alerte a une règle : condition de déclenchement, gravité (`INFO`, `WARNING`, `CRITICAL`), destinataires (rôles × périmètre de l'objet concerné), écran d'action associé, mode de résolution (automatique quand la condition disparaît, ou manuelle). | C (CM §54) / D |
| BR-NOT-002 | **Déduplication** : au plus une alerte ouverte par (type, objet concerné). Une nouvelle occurrence met à jour l'alerte ouverte (compteur, dernière occurrence) au lieu d'en créer une autre. | C (CM §54 « pas accumuler ») |
| BR-NOT-003 | Une alerte d'**état** (stock faible, créance en retard) se résout automatiquement quand la condition disparaît. Une alerte d'**événement** (perte anormale, doublon suspect) se résout manuellement, avec un commentaire. | D |
| BR-NOT-004 | Une alerte `CRITICAL` déclenche une notification push immédiate aux destinataires. Une alerte `WARNING` produit une notification in-app. Les alertes `INFO` ne sont visibles que dans le centre d'alertes. | D / AV-064 |
| BR-NOT-005 | Une alerte `CRITICAL` non prise en compte sous 4 h est escaladée au niveau supérieur (responsable → Direction). | D |
| BR-NOT-006 | Une note de direction a une audience (tous, rôles, sites, zones, utilisateurs), une date de publication, une date d'expiration optionnelle et une option d'accusé de lecture. Elle est immuable une fois publiée ; on peut la retirer (archivage) ou publier une note corrective. | C (CM §43) / AV-066 |
| BR-NOT-007 | Une note ne porte **aucun effet** métier (ni prix, ni règle) : ces effets passent par leurs modules. Une note peut **référencer** l'objet concerné (ex. la règle tarifaire activée). | C (CM §43) |
| BR-NOT-008 | Un utilisateur ne reçoit que les alertes et notifications relatives à des objets de son périmètre RBAC. | C (CM §48) |

### 7.1 Catalogue initial des alertes

Toutes les valeurs de seuil sont des défauts paramétrables (AV-065). Les seuils sont des paramètres `organization.system_settings`, lus par le détecteur dans le module propriétaire ; la règle d'alerte porte l'activation, la gravité, les rôles et le mode de résolution (AV-400, [ADR-071](../../decisions/ADR-071-alertes-detection-correlation-et-cycle-de-vie.md)).

| Code | Déclencheur | Détection | Gravité | Destinataires | Résolution |
|---|---|---|---|---|---|
| `STOCK_LOW` | Disponible physique < minimum du seuil actif (BR-STK-051) : événement `StockThresholdBreached` `LOW`, publié par `recordStockMove` aux extrémités physiques d'un mouvement, par `inventory.threshold.set` et par le filet horaire (P9-08, AV-405) | Sur mouvement (+ passe horaire) | WARNING | Magasinier du site, vendeurs du PDV | Auto (niveau terminé ou marqueur de passe) |
| `STOCK_OUT` | Disponible ≤ 0 avec seuil défini : `StockThresholdBreached` `OUT` (P9-08, AV-405) ; un solde négatif lève aussi `STOCK_NEGATIVE` | Sur mouvement (+ passe horaire) | CRITICAL | Idem + RESP_COMMERCIAL | Auto |
| `POS_REPLENISH` | Suggestion « cible − disponible − transit entrant » > 0 pour un point de vente (`inventory.replenish_alert_scope` : `BELOW_TARGET` par défaut, `BELOW_MINIMUM` au choix) : `ReplenishmentSuggested` de la passe horaire des seuils (P9-08, AV-452) | Planifiée (horaire, 06:00 compris) | WARNING | Magasinier du site du PDV, vendeurs du PDV | Auto (marqueur de passe) |
| `STOCK_NEGATIVE` | Solde physique de lot < 0 après une sortie (BR-STK-018, INV-STK-05) : `StockNegativeDetected` de `recordStockMove`, quel que soit l'appelant (P9-08) | Sur mouvement | CRITICAL | Responsable du site, DIRECTION | Manuelle (après régularisation) |
| `HIGH_LOSS` | Valeur des pertes d'un emplacement sur 1 jour métier ≥ `inventory.high_loss_alert_xaf` (50 000 XAF, `HighLossDetected` à chaque déclaration, déclarations en attente comprises, mortalité exclue, AV-453) ou ≥ `sales.high_loss_alert_sales_pct` (5 %) du CA net du site du jour pour une perte **sous** le seuil absolu (`HighLossSalesShareDetected`, deux derniers jours clos, 06:45, AV-455) | Sur perte (seuil absolu) ; planifiée (part du CA) | CRITICAL | Responsable du site, DIRECTION | Manuelle |
| `HIGH_MORTALITY` | Mortalité journalière > 0,5 % de l'effectif ou > 20 têtes : cumul du jour métier du fait d'un lot, validé ou en attente, sur l'effectif en élevage au début du jour (comparaisons strictes, seuils `production.high_mortality_alert_*`, site puis global) ; un sujet par lot et par jour (AV-461) | Sur mortalité (`production.mortality.record`) | CRITICAL | RESP_PRODUCTION, DIRECTION | Manuelle |
| `DAILY_ENTRY_MISSING` | Lot actif (`ACTIVE` ou `SELLING`, mis en place avant la veille, animaux en élevage) sans mortalité, intrant, pesée, observation ni collecte datés de la veille ; jours attendus : `production.daily_entry_working_days` (AV-462) | Planifiée (10:00 ; `production.lots.daily_entry_check`) | WARNING | RESP_FERME, RESP_PRODUCTION | Auto (la première passe dont le jour examiné a une saisie du lot) |
| `STANDARD_COST_MISSING` | Production entrée en stock (collecte, naissance) d'un produit sans coût standard défini à l'instant de la passe, sur les `production.standard_cost_alert_lookback_days` derniers jours (AV-124, AV-463) | Planifiée (07:45 ; `production.products.standard_cost_check`) | WARNING | ADMIN | Auto (`StandardCostSet` ou passe suivante) |
| `RECEIPT_INCOMPLETE` | BR-APP-015 : bon `SENT` ou `PARTIALLY_RECEIVED` avec un reliquat et (date prévue dépassée de plus de `procurement.receipt_incomplete_alert_days` jours, ou quantité rejetée à une réception comptée) (AV-464) | Planifiée (07:15 ; `procurement.orders.receipt_incomplete_check`) + sur réception | WARNING | RESP_ACHATS | Auto (reliquat nul ou clôturé, bon annulé, passe suivante) |
| `INVENTORY_VARIANCE` | Inventaire dont l'écart exige une validation (valeur ≥ `inventory.count_approval_threshold_xaf`, ou animaux, AV-108) : `InventoryVarianceDetected` (P9-08, AV-456) | Sur soumission | WARNING | Responsable du site, FINANCE | Manuelle (validation) ; fermée par `InventoryAdjusted` |
| `OVERDUE_RECEIVABLE` | Créance échue | Planifiée (07:00) | WARNING | Titulaire du client, RESP_COMMERCIAL, FINANCE | Auto |
| `CASH_VARIANCE` | Écart de caisse ≠ 0 : événement `CashVarianceDetected` (P5-12 ; responsable imputé `imputed_user_id`, AV-155, AV-170) | Sur clôture ; aussi sur ouverture, phase `OPENING` (DÉDUIT d'AV-156 : l'écart d'ouverture, fonds initial compris, est validé par la Finance avec la session), et sur réévaluation d'une session close, phase `ADJUSTMENT` (P5-13 ; P9-07 : aussi quand l'opération antérieure à l'ouverture corrige l'écart d'ouverture, cause `LATE_BEFORE_OPENING`, AV-224) ; un écart dans `finance.cash_variance_tolerance_xaf` est un constat sans alerte (AV-450) | WARNING (CRITICAL si ≥ `finance.cash_variance_critical_xaf`, 10 000 XAF par défaut) | FINANCE | Manuelle (validation par la Finance) ; fermée aussi par la clôture validée d'office (`CashSessionClosed` avec `auto_validated`, AV-450) ; les ajustements encore en attente après une validation sont signalés de nouveau (cause `REMAINING_ADJUSTMENTS`) |
| `CASH_HOLDING_HIGH` | Caisse utilisateur active de solde positif > `finance.cash_holding_max_xaf` (200 000 XAF) ou aucune remise depuis plus de `finance.cash_holding_max_days` (3) jours métier : événement `CashHoldingHighDetected` de la tâche `finance.cash_holdings.high_check` (P9-07, AV-447) | Planifiée (horaire) | WARNING | FINANCE, responsable | Auto |
| `CASH_SESSION_OPEN_LONG` | Session de caisse ouverte depuis plus de `finance.cash_session_force_close_hours` (24 h par défaut, réglable par site) : événement `CashSessionOpenLongDetected` de la tâche `finance.cash_sessions.open_long_check` (P5-12), un par session et par passe horaire, suivi du marqueur de fin de passe (P9-07) | Planifiée | WARNING | FINANCE, vendeur | Auto ; consommateur en P9 |
| `CASH_TRANSFER_NOT_RECEIVED` | Remise de fonds envoyée et non reçue depuis plus de 48 h (`finance.cash_transfer_unreceived_hours`, AV-158) | Planifiée (horaire : événement `CashTransferUnreceived` par remise et par passe, tâche `finance.cash_transfers.unreceived_check`, P5-15, P9-07) | WARNING | FINANCE, expéditeur | Auto (remise reçue ou annulée) |
| `SYNC_ERROR` | Commande `/sync/push` `REJECTED` ou `CONFLICT` sur un appareil, dont la dernière prise en charge date des `sync.error_alert_window_hours` dernières heures, par appareil et par code ; un conflit de gestionnaire reste signalé tant qu'il est ouvert (conflit refermé et codes exclus écartés, `SyncErrorDetected`, AV-471) | Planifiée (horaire) | WARNING | Utilisateur (auteur du dernier rejet), ADMIN | Auto (erreur sortie de la fenêtre ou conflit résolu) |
| `SYNC_STALE` | Appareil actif sans synchronisation depuis plus de `sync.stale_hours` heures (24), compté depuis le plus récent du dernier contact et de l'activation, jusqu'à l'horizon d'oubli `sync.stale_horizon_days` (`DeviceSyncStale`, AV-472) | Planifiée (horaire) | WARNING | Titulaire de l'appareil (qui l'a enrôlé), son responsable d'équipe, ADMIN | Auto |
| `DEVICE_SEQ_GAP` | Trou de séquence non comblé depuis plus de `sync.seq_gap_alert_hours` heures (24) et non expliqué par les restes déclarés de l'appareil ; une plage n'est signalée qu'une fois (`DeviceSequenceGapDetected`, AV-473) | Planifiée (horaire) | CRITICAL | ADMIN, DIRECTION | Manuelle |
| `CLOCK_SKEW` | Écart d'horloge du dernier envoi d'un appareil actif au-delà de `sync.clock_skew_flag_minutes` (5 min par défaut, AV-216), signé (`ClockSkewDetected`, AV-474) | Planifiée (horaire) | WARNING | Utilisateur (auteur du dernier envoi), ADMIN | Auto (appareil remis à l'heure ou silencieux) |
| `INACTIVE_COMMERCIAL` | BR-TER-013 : jour ouvré précédent (`sales.commercial_working_days`), rôles `sales.inactive_commercial_role_codes` (`COMMERCIAL_TERRAIN`, AV-444), ni prise de service, ni visite, ni vente | Planifiée (08:00, tâche `sales.commercial.inactivity_check`) | WARNING | RESP_COMMERCIAL | Auto (nouvelle activité) |
| `CHECKIN_SUSPICIOUS` | BR-TER-010 : au moins un signal sur un pointage, quels que soient son type et son résultat (`CheckInSuspicious`, AV-468) | Sur pointage | WARNING | RESP_COMMERCIAL (zone ou équipe), l'agent et son responsable d'équipe | Manuelle |
| `PRICE_MISMATCH` | BR-VEN-029 : prix appliqué différent du prix en vigueur à la date du fait, vente directe ou commande saisie hors ligne (AV-445) | Sur vente | INFO | RESP_COMMERCIAL | Manuelle |
| `DUPLICATE_SUSPECTED` | Client, réception ou encaissement suspect de doublon ; client : compte créé hors ligne avec un téléphone déjà détenu, sujet = le nouveau compte (`CustomerDuplicateSuspected`, AV-469) ; réception : toute mise en quarantaine, avec ses raisons (`GoodsReceiptQuarantined`, AV-465) | Sur application | WARNING | Responsable concerné | Manuelle (fusion ou décision ; fusion du compte et décision sur la quarantaine d'une réception : automatique) |
| `APPROVAL_PENDING_LONG` | Demande de validation en attente depuis au moins `approvals.pending_long_hours` heures (24), depuis sa réception par le serveur ; `escalated_at` posé une fois par `approvals` (AV-466) | Planifiée (horaire ; `approvals.requests.pending_long_check`) | WARNING | Approbateurs + niveau supérieur | Auto (décision, retrait ou annulation ; le marqueur de la passe suivante pour une décision par façade) |
| `TRANSFER_NOT_RECEIVED` | Transfert `STANDARD` expédié non reçu depuis plus de `inventory.transfer_not_received_hours` (48 h) : `StockTransferNotReceived` de la passe `inventory.alerts.transfer_not_received_check` (P9-08, AV-458) | Planifiée (06:30) | WARNING | Expéditeur, destinataire (site de réception) | Auto (reçu, annulé, refusé, retourné, rapproché d'une réception sans document, ou marqueur) |
| `TRANSFER_UNMATCHED` | BR-STK-024 : réception sans document non rapprochée après `inventory.transfer_unmatched_hours` : événement `StockTransferUnmatched` de la tâche `inventory.transfers.unmatched_sweep` (P5-16 ; P9-08 : numéro du document et temps écoulé) | Planifiée (horaire) | WARNING | Magasinier, responsable | Manuelle ; fermée par `BlindReceiptMatched` (AV-460) |
| `LOT_EXPIRING` | Lot ouvert portant une date de péremption et du stock physique, périmant sous `inventory.lot_expiring_days` (15) jours ou déjà périmé : `LotExpiringDetected`, un par lot, par site et par produit (P9-08, AV-454) | Planifiée (06:00) | WARNING | Magasinier | Auto (marqueur de passe) |
| `ATTACHMENT_MISSING` | Pièce requise non reçue après `attachments.missing_alert_days` (7) jours depuis la réception par le serveur ; dépenses au-delà du seuil de justificatif : tâche quotidienne `finance.expenses.attachment_missing_check`, passe de portée `EXPENSE`, horizon `attachments.missing_alert_horizon_days` (90) (AV-449) ; réceptions dont la photo du bon de livraison est exigée (BR-APP-014) : `procurement.receipts.attachment_missing_check`, passe de portée `GOODS_RECEIPT` (AV-467) | Planifiée (06:15) | WARNING | Auteur, responsable | Auto |
| `KOMMO_SYNC_FAILED` | Message d'intégration en échec définitif | Sur échec | WARNING | ADMIN | Manuelle (rejeu) |
| `AUDIT_CHAIN_BROKEN` | BR-AUD-006 : rupture de la chaîne sur le jour métier précédent le créneau planifié et la suite, sujet = mois métier de la ligne rompue et position (`AuditChainBroken`, AV-470) | Planifiée (03:00) | CRITICAL | ADMIN, DIRECTION | Manuelle |
| `ALLOCATION_EXPIRED` | Quota d'appareil échu non libéré : `AllocationExpired` de la passe `inventory.allocations.expiry_daily` (P5-08 ; P9-08 : identité de passe, plus de déduplication par jour, AV-402, AV-460) | Planifiée (00:05) | WARNING | Magasinier du site, responsable | Auto (quota libéré ou révoqué, ou marqueur) |
| `ALLOCATION_REVOCATION_PENDING` | Quota d'un appareil bloqué, perdu ou d'un utilisateur désactivé, en attente de révocation : `AllocationRevocationPending` (P5-08 ; P9-08 : libellés, filet quotidien, AV-402, AV-460) | Sur fait (+ filet quotidien) | WARNING | Magasinier du site, responsable | Auto (quota révoqué ou libéré, signal levé : `AllocationRevocationCleared`, ou marqueur) |
| `SALE_UNDELIVERED` | Vente confirmée non livrée depuis plus de `sales.undelivered_alert_days` (7 par défaut ; AV-132, AV-402) : tâche `sales.orders.undelivered_check`, jours métier depuis la confirmation ou, si elle est postérieure, la livraison demandée par le client (AV-451) | Planifiée (07:30) | WARNING | Titulaire du client, vendeur, responsable | Auto (livrée ou annulée) |
| `CONSUMER_FAILED` | Événement sauté après échec persistant (table des échecs du runner) dans les `communication.consumer_failure_window_hours` dernières heures (24), ou consommateur dont le plus ancien événement non traité date de plus de `communication.consumer_lag_alert_seconds` (300) ; un par consommateur (`ConsumerFailureDetected`, AV-412, AV-475) | Planifiée (5 minutes) | WARNING | ADMIN | Auto (retard résorbé et sauts sortis de la fenêtre) |
| `LEDGER_MISMATCH` | Écart de la réconciliation quotidienne du registre de stock (INV-STK-01, AT-047) : `LedgerMismatchDetected`, un par site et par jour métier (`GLOBAL` pour une anomalie sans site ; une alerte par jour tant que l'anomalie dure, AV-459), publié par `inventory.ledger.reconcile_daily` avant de se terminer en succès (AV-402) | Planifiée (02:00) | CRITICAL | Responsable du site, DIRECTION, ADMIN | Manuelle (après régularisation) |
| `CASH_MISMATCH` | Écart de la réconciliation quotidienne de la trésorerie (D09) : événement `CashMismatchDetected`, publié par `finance.cash.reconcile_daily` avant de se terminer en succès (AV-402) ; un événement par compte et par jour métier, les écarts sans compte sous la clé `NONE` (AV-448) | Planifiée (02:30) | CRITICAL | FINANCE, DIRECTION | Manuelle (après régularisation) |

## 8. Validations

Règle d'alerte : seuils numériques ≥ 0 et destinataires non vides. Note : titre et corps non vides, audience non vide dont les références existent (rôle actif, site, zone, utilisateur), expiration postérieure à la publication (instant du serveur) ; une note corrective référence une note existante (AV-477).

## 9. Dépendances

Consomme les événements de tous les modules ; utilise ADM (rôles, périmètres).

## 10. Événements produits

`AlertRaised`, `AlertEscalated`, `AlertAcknowledged`, `AlertResolved`, `InternalNotePublished`, `InternalNoteArchived`, `InternalNoteAcknowledged`.

## 11. Événements consommés

Tous les événements déclencheurs du §7.1 (ex. `StockThresholdBreached`, `StockNegativeDetected`, `StockLossDeclared`, `HighMortalityDetected`, `CashVarianceDetected`, `CashTransferDiscrepancyDetected`, `CashTransferUnreceived`, `CommandRejected`, `SyncConflictDetected`, `CheckInSuspicious`, `PriceMismatchDetected`, `PaymentFlaggedDuplicate`, `GoodsReceiptQuarantined`, `ApprovalRequested`, `PriceRuleActivated` pour une note automatique).

## 12. Fonctionnement hors ligne

Les alertes et notes de l'utilisateur sont téléchargées : 50 dernières alertes ouvertes, notes non expirées. La prise en compte d'une alerte et l'accusé de lecture d'une note fonctionnent hors ligne. Les alertes locales (ex. « stock de votre allocation < 5 ») sont calculées sur l'appareil, sans passer par le serveur.

## 13. Permissions

`comm.alert.read`, `comm.alert.manage`, `comm.alert_rule.manage`, `comm.note.read`, `comm.note.publish`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Tempête d'alertes (ex. panne généralisant les ruptures) | Déduplication (BR-NOT-002) + regroupement des notifications push : au plus 1 push par utilisateur et par type toutes les 15 minutes. |
| Destinataire absent ou désactivé | Routage vers les autres titulaires du rôle dans le périmètre ; à défaut, la Direction. |
| Push non supporté (navigateur, iOS ancien) | Notification in-app seulement. |

## 15. Conception de P9 (14/10/2026)

| Sujet | Décision |
|---|---|
| Architecture | Détection par les modules propriétaires, corrélation par le consommateur `communication.alerts` ; `communication` ne lit aucune table d'autrui ([ADR-070](../../decisions/ADR-070-architecture-de-p9-communication-et-analytics.md), [ADR-071](../../decisions/ADR-071-alertes-detection-correlation-et-cycle-de-vie.md)) |
| Déduplication | Colonne générée `open_dedup_key` sous index unique (INV-NOT-01) ; événement marqué consommé à la première instruction |
| Résolution | Alerte d'état : marqueur de fin de passe ou événement de résolution ; alerte d'événement : manuelle avec commentaire |
| Destinataires | Explicites, écrits à la levée ; supervision par la portée de `comm.alert.read` ; repli sur la Direction ([ADR-072](../../decisions/ADR-072-destinataires-notifications-push-et-escalade.md)) |
| Push | Port `WebPushSender`, adaptateur journal tant que le porteur n'a pas fourni bibliothèque ni clés (AV-415) |
| Notes | Immuables après publication, audience évaluée à la lecture, accusés hors ligne ([ADR-073](../../decisions/ADR-073-notes-de-direction.md)) |
| Placement des détecteurs | Dans le module qui porte la donnée, selon le graphe : `INACTIVE_COMMERCIAL`, `HIGH_LOSS` (part « % des ventes ») et `OVERDUE_RECEIVABLE` dans `sales` ; les passes d'état portent une identité (ADR-071 §2 et §3) |
| Valeurs au coût | Jamais dans le message d'une alerte : champ protégé, rendu selon le droit `inventory.valuation.read` du lecteur (AV-440) |
| Questions ouvertes | AV-400 à AV-420 et AV-438 à AV-442 |
