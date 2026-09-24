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

Toutes les valeurs de seuil sont des défauts paramétrables (AV-065).

| Code | Déclencheur | Détection | Gravité | Destinataires | Résolution |
|---|---|---|---|---|---|
| `STOCK_LOW` | Disponible < minimum (BR-STK-051) | Sur mouvement | WARNING | Magasinier du site, vendeurs du PDV | Auto |
| `STOCK_OUT` | Disponible ≤ 0 avec seuil défini | Sur mouvement | CRITICAL | Idem + RESP_COMMERCIAL | Auto |
| `POS_REPLENISH` | Suggestion de réapprovisionnement > 0 pour un PDV | Planifiée (06:00) + sur mouvement | WARNING | Magasinier source, vendeurs du PDV | Auto |
| `STOCK_NEGATIVE` | Solde physique < 0 (BR-STK-018) | Sur mouvement | CRITICAL | Responsable du site, DIRECTION | Manuelle (après régularisation) |
| `HIGH_LOSS` | Valeur des pertes d'un emplacement sur 1 jour ≥ 50 000 XAF ou ≥ 5 % des ventes du jour | Sur perte | CRITICAL | Responsable du site, DIRECTION | Manuelle |
| `HIGH_MORTALITY` | Mortalité journalière > 0,5 % de l'effectif ou > 20 têtes | Sur mortalité | CRITICAL | RESP_PRODUCTION, DIRECTION | Manuelle |
| `DAILY_ENTRY_MISSING` | Lot actif sans saisie du jour la veille | Planifiée (10:00) | WARNING | RESP_FERME, RESP_PRODUCTION | Auto |
| `RECEIPT_INCOMPLETE` | BR-APP-015 | Planifiée + sur réception | WARNING | RESP_ACHATS | Auto (reliquat nul ou clôturé) |
| `INVENTORY_VARIANCE` | Inventaire avec écart en valeur ≥ seuil | Sur soumission | WARNING | Responsable du site, FINANCE | Manuelle (validation) |
| `OVERDUE_RECEIVABLE` | Créance échue | Planifiée (07:00) | WARNING | Titulaire du client, RESP_COMMERCIAL, FINANCE | Auto |
| `CASH_VARIANCE` | Écart de caisse ≠ 0 | Sur clôture | WARNING (CRITICAL si ≥ 10 000 XAF) | FINANCE | Manuelle (validation) |
| `CASH_HOLDING_HIGH` | Caisse utilisateur > plafond ou aucune remise depuis plus de 3 jours | Planifiée | WARNING | FINANCE, responsable | Auto |
| `CASH_SESSION_OPEN_LONG` | Session de caisse ouverte depuis plus de 24 h | Planifiée | WARNING | FINANCE, vendeur | Auto |
| `SYNC_ERROR` | Commande `REJECTED` ou `CONFLICT` sur un appareil | Sur synchronisation | WARNING | Utilisateur, ADMIN | Auto (conflit résolu) |
| `SYNC_STALE` | Appareil actif sans synchronisation depuis plus de 24 h | Planifiée (horaire) | WARNING | Responsable de l'utilisateur, ADMIN | Auto |
| `DEVICE_SEQ_GAP` | Trou de séquence non comblé depuis plus de 24 h | Planifiée | CRITICAL | ADMIN, DIRECTION | Manuelle |
| `CLOCK_SKEW` | Écart d'horloge d'un appareil > 5 min | Sur synchronisation | WARNING | Utilisateur, ADMIN | Auto |
| `INACTIVE_COMMERCIAL` | BR-TER-013 | Planifiée (08:00) | WARNING | RESP_COMMERCIAL | Auto (nouvelle activité) |
| `CHECKIN_SUSPICIOUS` | BR-TER-010 | Sur pointage | WARNING | RESP_COMMERCIAL | Manuelle |
| `PRICE_MISMATCH` | BR-VEN-029 | Sur vente | INFO | RESP_COMMERCIAL | Manuelle |
| `DUPLICATE_SUSPECTED` | Client, réception ou encaissement suspect de doublon | Sur application | WARNING | Responsable concerné | Manuelle (fusion ou décision) |
| `APPROVAL_PENDING_LONG` | Demande de validation en attente depuis plus de 24 h | Planifiée | WARNING | Approbateurs + niveau supérieur | Auto |
| `TRANSFER_NOT_RECEIVED` | Transfert expédié non reçu depuis plus de 48 h | Planifiée | WARNING | Expéditeur, destinataire | Auto |
| `TRANSFER_UNMATCHED` | BR-STK-024 | Planifiée | WARNING | Magasinier, responsable | Manuelle |
| `LOT_EXPIRING` | Lot fournisseur périmant sous 15 jours | Planifiée | WARNING | Magasinier | Auto |
| `ATTACHMENT_MISSING` | Pièce requise non reçue après 7 jours | Planifiée | WARNING | Auteur, responsable | Auto |
| `KOMMO_SYNC_FAILED` | Message d'intégration en échec définitif | Sur échec | WARNING | ADMIN | Manuelle (rejeu) |
| `AUDIT_CHAIN_BROKEN` | BR-AUD-006 | Planifiée | CRITICAL | ADMIN, DIRECTION | Manuelle |

## 8. Validations

Règle d'alerte : seuils numériques ≥ 0 et destinataires non vides. Note : titre et corps non vides, audience non vide, expiration postérieure à la publication.

## 9. Dépendances

Consomme les événements de tous les modules ; utilise ADM (rôles, périmètres).

## 10. Événements produits

`AlertRaised`, `AlertEscalated`, `AlertAcknowledged`, `AlertResolved`, `InternalNotePublished`, `InternalNoteAcknowledged`.

## 11. Événements consommés

Tous les événements déclencheurs du §7.1 (ex. `StockThresholdBreached`, `StockNegativeDetected`, `StockLossDeclared`, `MortalityRecorded`, `CashVarianceDetected`, `CommandRejected`, `SyncConflictDetected`, `CheckInSuspicious`, `PriceMismatchDetected`, `PaymentFlaggedDuplicate`, `GoodsReceiptQuarantined`, `ApprovalRequested`, `PriceRuleActivated` pour une note automatique).

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
