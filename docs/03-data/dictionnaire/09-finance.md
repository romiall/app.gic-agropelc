# Dictionnaire — schéma `finance`

> Périmètre du module `finance` : trésorerie, dépenses, dettes fournisseurs. Les encaissements clients sont dans `sales`, le registre de coûts dans `inventory` (D09, en-tête).

## finance.payment_methods

**Responsabilité** : moyens de paiement.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `code` | code | Non | — | PK : `ESPECES`, `MOBILE_MONEY_ORANGE`, `MOBILE_MONEY_MTN`, `VIREMENT`, `CHEQUE` (AV-056) |
| `label` | label | Non | — | |
| `requires_reference` | boolean | Non | false | Référence externe obligatoire |
| `default_account_type` | enum(types de compte) | Non | — | Compte crédité par défaut |
| `is_active` | boolean | Non | true | |

- **PK** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL (jeu `catalog`, type `PAYMENT_METHOD`, clé dérivée du code, ADR-031 ; publié par le seed, une ligne par `version`, P4-11).
- **Implémentation** (P4-02, migration `20261003090000_create_finance_core.sql`) : colonnes `created_at`, `updated_at`, `version` ; `CHECK` sur `default_account_type` ; suppression refusée par déclencheur. Données initiales : les cinq moyens d'AV-056 (seed).

## finance.cash_accounts

**Responsabilité** : réceptacle d'argent avec un responsable (BR-FIN-010).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | |
| `name` | label | Non | — | |
| `account_type` | enum(`CAISSE_PDV`,`CAISSE_UTILISATEUR`,`CAISSE_CENTRALE`,`MOBILE_MONEY`,`BANQUE`) | Non | — | |
| `site_id` | uuid → organization.sites | Oui | — | Requis pour `CAISSE_PDV` |
| `holder_user_id` | uuid → identity.users | Oui | — | Requis pour `CAISSE_UTILISATEUR` |
| `responsible_user_id` | uuid → identity.users | Non | — | Responsable |
| `external_ref` | varchar(60) | Oui | — | Numéro de compte ou numéro marchand |
| `balance_xaf` | bigint | Non | 0 | Projection (INV-FIN-02) |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code` ; une `CAISSE_PDV` active par site ; une `CAISSE_UTILISATEUR` active par utilisateur.
- **Suppr.** `DESACTIVATION` (solde nul, aucune session de caisse ouverte, P5-12, et aucune remise de fonds `SENT` depuis ou vers le compte : `CASH_ACCOUNT_TRANSFER_IN_TRANSIT`, P5-15). **Offline** DL (comptes de l'utilisateur, avec solde au téléchargement) — jeu `cash` (P4-11) : comptes actifs du détenteur, à défaut du responsable, et caisse du PDV de son site ; republié à chaque mouvement ; un compte désactivé sort du jeu. P5-18 (AV-197) : chaque compte actif sans détenteur personnel est aussi publié à tous les appareils comme destination de remise (`CASH_TRANSFER_TARGET`, ligne `GLOBAL`), sans solde, responsable ni version. Réattribution : la sortie de l'ancien responsable est écrite avant les mises à jour.
- **Commandes** (P4-03, permission `finance.cash_account.manage`) : `finance.cash_account.create` (site requis pour une caisse de PDV, détenteur pour une caisse d'utilisateur, responsable actif ; unicité « une active par site / par détenteur » contrôlée avant l'insertion, `CASH_ACCOUNT_DUPLICATE`), `.update` (nom, responsable, référence externe), `.deactivate` (refusée tant que le solde n'est pas nul, `CASH_ACCOUNT_NOT_EMPTY`, et, depuis P5-12, tant qu'une session de caisse est ouverte sur le compte, `CASH_ACCOUNT_HAS_OPEN_SESSION`, contrôlé d'abord ; depuis P5-15, tant qu'une remise de fonds envoyée part du compte ou y arrive, `CASH_ACCOUNT_TRANSFER_IN_TRANSIT`). Réconciliation quotidienne `finance.cash.reconcile_daily` (solde projeté = Σ entrées − Σ sorties du registre) ; `rebuildCashBalances` est une procédure de maintenance.
- **Implémentation** (P4-02) : unicités « une active par… » portées par les colonnes générées `active_pos_site` et `active_user_holder` (index uniques, conventions §4 MySQL) ; `CHECK` site requis pour `CAISSE_PDV` et détenteur requis pour `CAISSE_UTILISATEUR` ; pas de `CHECK balance_xaf ≥ 0` (solde négatif admis hors ligne, `CASH_NEGATIVE`, BR-FIN-012) ; suppression refusée par déclencheur.

## finance.cash_sessions

**Responsabilité** : session de caisse d'un PDV (SM-CASH-SESSION ; BR-DIS-005 à 008 ; ADR-032). Implémentée en P5-03 ; commandes en P5-12 et P5-13.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cash_account_id` | uuid → cash_accounts | Non | — | Caisse de PDV |
| `site_id` | uuid → organization.sites | Non | — | Site de la caisse, copié à l'ouverture |
| `opened_by`, `opened_device_id` | uuid → identity | Non, Oui | — | Ouvreur et appareil |
| `opened_at` | ts | Non | — | Heure métier ; début de la **fenêtre** |
| `business_date` | date | Non | généré | Jour métier de l'ouverture (Africa/Douala) |
| `opening_counted_xaf` | money_xaf | Non | — | Fonds compté |
| `opening_expected_xaf` | bigint | Non | — | Solde du registre à l'ouverture (somme ordonnée par `occurred_at`), signé |
| `opening_variance_xaf` | bigint | Non | — | Écart d'ouverture = compté − attendu ; période précédente, **exclu** de l'attendu |
| `closed_by`, `closed_device_id` | uuid → identity | Oui | — | |
| `closed_at` | ts | Oui | — | Fin de la fenêtre |
| `closing_counted_xaf` | money_xaf | Oui | — | |
| `closing_expected_xaf` | bigint | Oui | — | Attendu par fenêtre à la clôture (ADR-032 §3) ; valeur de clôture, jamais réécrite |
| `variance_xaf` | bigint | Oui | — | Compté − attendu à la clôture (exact, `CHECK`) |
| `status` | enum(`OPEN`,`PENDING_VALIDATION`,`VALIDATED`) | Non | `OPEN` | |
| `force_closed`, `forced_by` | boolean, uuid | Non, Oui | false | Clôture forcée par un responsable (AV-155) |
| `auto_validated` | boolean | Non | false | Écart nul ou toléré : validé d'office, sans valideur |
| `validated_by`, `validated_at` | uuid, ts | Oui | — | |
| `variance_reason` | varchar(500) | Oui | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Demande `CASH_VARIANCE`, posée à la clôture d'une session à valider (P5-13) ; absente sans politique active (AV-183) |
| `open_account` | uuid | Oui | généré | `cash_account_id` si `OPEN` : index unique (INV-FIN-06) |
| `command_id`, `client_created_at`, `received_at_server`, `captured_offline`, `clock_suspect`, `backdated_reason` | | | | Origine de l'ouverture |
| `close_command_id`, `close_captured_offline` | uuid, boolean | Oui, Non | | Origine de la clôture |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `open_account` (une session `OPEN` par compte, INV-FIN-06), `command_id`, `close_command_id`. **IX** `(cash_account_id, opened_at)`, `(site_id, business_date)`, `(status, opened_at)`.
- **CK** `ck_finance_cash_sessions_opening` (écart d'ouverture = compté − attendu), `_closing` (ouverte ⇒ aucune donnée de clôture ; close ⇒ toutes, écart exact), `_validation` (`VALIDATED` ⇒ date et valideur ou validation d'office), `_forced`.
- **Déclencheurs** : `insert_guard` et `update_guard` (non-chevauchement des fenêtres d'un compte, **filet** : le code l'assure, ADR-032 §2) ; `update_guard` : identité et ouverture immuables, session close ne se rouvre pas, **session `VALIDATED` figée** (INV-FIN-05) ; `no_delete`.
- **Suppr.** `IMMUABLE` après `VALIDATED` ; correction par ajustement (ADR-006). **Audit** Ouverture, clôture, validation, réévaluation. **Offline** DL (session du PDV, jeu `cash`) — P5-18 : `CASH_SESSION`, ligne `SITE` de la session (sites qu'atteint `finance.cash.read`), servie `OPEN` puis `PENDING_VALIDATION` avec l'attendu et l'écart du serveur (valeurs de clôture, plus l'attendu et l'écart **courants** après une réévaluation par le delta, republiés à chaque ajustement), sortie à `VALIDATED` (AV-193), CR. **Remarque** : aucune clé étrangère de la session vers le registre (le mouvement d'écart cite la session, pas l'inverse).
- **Validation** (P5-13 ; D05 §15) : `finance.cash_session.validate` (en ligne, permission `finance.cash_session.validate`, portée du site), façade de la décision `CASH_VARIANCE` (ou validation directe sans demande, AV-183) ; écrit `status` `VALIDATED`, `validated_by`, `validated_at`, `variance_reason` et valide les ajustements inclus ; la décision directe `approvals.request.approve` a le même effet.
- **Lecture (P5-17)** : `GET /cash-sessions` et `GET /cash-sessions/{id}` (droit `finance.cash.read`, portée du compte, AV-189) ; lectures publiques `listCashSessions`, `findCashSessionDetail`, `listCashSessionAdjustments` ; la fiche porte aussi les flux de la fenêtre avec les sous-totaux par vendeur (AV-187), composés par la couche de transport.
- **Commandes** (P5-12 ; D05 §15) : `finance.cash_session.open` (hors ligne possible, permission `finance.cash_session.operate`, portée du site de la caisse ; caisse de PDV seulement, `CASH_SESSION_POS_ACCOUNT_REQUIRED` ; en ligne `SITE_CLOSED`, `CASH_ACCOUNT_INACTIVE`, `CASH_SESSION_ALREADY_OPEN`, `CASH_SESSION_OVERLAP`, `CASH_SESSION_DAILY_LIMIT` ; hors ligne, un site fermé depuis ouvre la session avec l'avertissement et le conflit `CASH_SESSION_SITE_CLOSED` ; hors ligne, une ouverture concurrente n'écrit **aucune ligne** : fusion consignée dans le conflit `CASH_SESSION_CONCURRENT_OPEN` de `sync.sync_conflicts`, ou décalage de `opened_at` à la clôture d'une session de la veille close depuis, AV-168 ; à la création seulement, jamais à une fusion, l'ouverture résout (`MERGE`, référence de la session) les conflits ouverts `CASH_SESSION_MISSING` des encaissements de la caisse dont le mouvement est sans index et daté à l'heure d'ouverture ou après, sans borne haute et sans réécrire l'index, P5-14, AV-184 ; si la session est ensuite close à une heure antérieure à l'encaissement, le conflit n'est pas rouvert : signal `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` ou `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS`, AV-171) ; `opening_expected_xaf` = solde du registre à `opened_at` (`SESSION_VARIANCE` de l'instant exact compris) ; `finance.cash_session.close` (hors ligne possible, `operate` ; `closing_expected_xaf` par fenêtre, `variance_xaf`, `closed_by` = l'auteur ; en ligne `CASH_SESSION_NOT_OPEN`, `CASH_SESSION_CLOSE_BEFORE_OPEN`, `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` (mouvement du compte daté à l'heure de clôture ou après, AV-171 ; hors ligne : clôture appliquée, `PENDING_VALIDATION`, conflit `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS`), hors ligne observation `CASH_SESSION_CONCURRENT_CLOSE` sans écriture ; `CASH_AMOUNT_INVALID` si l'écart sort des entiers représentables ; alias d'une ouverture fusionnée) ; `finance.cash_session.force_close` (en ligne, `finance.cash_session.validate`, plus de `finance.cash_session_force_close_hours`, `CASH_SESSION_FORCE_CLOSE_TOO_EARLY` ; `force_closed`, `forced_by` = `closed_by` ; toujours `PENDING_VALIDATION` ; motif dans l'audit et l'événement, aucune colonne). Validation d'office à la clôture (écarts d'ouverture et de clôture dans `finance.cash_variance_tolerance_xaf`) : `VALIDATED`, `auto_validated`, `validated_at` = `closed_at`, `validated_by` nul ; `approval_request_id` reste nul jusqu'à P5-13 (validation par la Finance, réévaluation). Événements `CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected` ; tâche `finance.cash_sessions.open_long_check` (`CashSessionOpenLongDetected`).

## finance.cash_session_adjustments

**Responsabilité** : réévaluation d'une session close après une opération tardive (ADR-032 §6 ; BR-DIS-008). Implémentée en P5-03 ; écrite depuis P5-13 par la réévaluation de `recordCashMovement` (une ligne par delta non nul, avec son mouvement compensatoire daté de la clôture) ; validée avec sa session (`INCLUDED_IN_VALIDATION`) ou par sa propre demande (`OWN_APPROVAL`, sujet `CASH_SESSION_ADJUSTMENT`).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `session_id` | uuid → cash_sessions | Non | — | |
| `movement_id` | uuid → cash_movements | Non | — | Mouvement compensatoire `SESSION_VARIANCE` (unique) |
| `trigger_movement_id` | uuid → cash_movements | Oui | — | Mouvement tardif déclencheur |
| `cause` | enum(`LATE_OPERATION`,`REVERSAL`,`LATE_BEFORE_OPENING`) | Non | — | `LATE_BEFORE_OPENING` (P5-23, AV-224, migration `20261012100000`) : ajustement de l'écart d'**ouverture** — opération datée entre la clôture de la session précédente et l'ouverture de celle-ci, appliquée après l'ouverture ; mouvement compensatoire daté de l'ouverture ; jamais compté dans l'écart de clôture (INV-FIN-11) |
| `variance_before_xaf`, `variance_after_xaf`, `delta_xaf` | bigint | Non | — | Σ des écarts posés avant, écart courant après ; `delta = après − avant ≠ 0` (INV-FIN-11) |
| `expected_after_xaf` | bigint | Non | — | Attendu recalculé |
| `treatment` | enum(`INCLUDED_IN_VALIDATION`,`OWN_APPROVAL`) | Non | — | Session `PENDING_VALIDATION` (ou `OPEN`, pour un ajustement d'ouverture) : validé avec elle — une session qui en porte un en attente ne se valide jamais d'office ; `VALIDATED` : demande propre |
| `status` | enum(`PENDING`,`VALIDATED`) | Non | `PENDING` | |
| `applied_at` | ts | Non | — | |
| `approval_request_id`, `validated_by`, `validated_at`, `variance_reason` | | Oui | — | Validation |
| `command_id` | uuid | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `movement_id`. **IX** `(session_id, applied_at)`, `(status, applied_at)`. **Déclencheurs** : ajustement immuable hors validation, figé une fois `VALIDATED`, jamais supprimé.

## finance.cash_movements

**Responsabilité** : registre de trésorerie en ajout seul (BR-FIN-011).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cash_account_id` | uuid → cash_accounts | Non | — | |
| `direction` | enum(`IN`,`OUT`) | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `movement_type` | enum(`CUSTOMER_PAYMENT`,`REFUND`,`SUPPLIER_PAYMENT`,`EXPENSE`,`TRANSFER_OUT`,`TRANSFER_IN`,`SESSION_VARIANCE`,`OPENING_BALANCE`) | Non | — | |
| `source_doc_type` | enum(`CUSTOMER_PAYMENT`,`SALE_REFUND`,`SUPPLIER_PAYMENT`,`EXPENSE`,`CASH_TRANSFER`,`CASH_SESSION`) | Non | — | |
| `source_doc_id` | uuid | Non | — | |
| `cash_session_id` | uuid → cash_sessions | Oui | — | |
| `occurred_at` | ts | Non | — | |
| `business_date` | date | Non | généré | |
| `recorded_at` | ts | Non | `now()` | |
| `is_reversal` | boolean | Non | false | |
| `reverses_movement_id` | uuid → cash_movements | Oui | — | Unique |
| `created_by`, `created_device_id`, `command_id`, `captured_offline` | | | | Origine |

- **PK** `id`. **UQ** `reverses_movement_id`. **CK** `amount_xaf > 0`.
- **IX** `(cash_account_id, occurred_at)`, `(source_doc_type, source_doc_id)`, `(cash_session_id)`.
- **Suppr.** `IMMUABLE`. **Offline** SRV (le solde du compte est téléchargé). **Intégrité** INV-FIN-01, INV-FIN-02.
- **Écriture** (P4-03) : seul `recordCashMovement` (module `finance`) écrit ce registre, dans la transaction du document appelant ; il verrouille la ligne du compte, insère le mouvement et met à jour `balance_xaf` (INV-FIN-02). Sens et document source suivent le type (`CUSTOMER_PAYMENT` : entrée, `CUSTOMER_PAYMENT` ; `REFUND` : sortie, `SALE_REFUND` ; `SUPPLIER_PAYMENT`, `EXPENSE` : sorties ; `TRANSFER_OUT`/`TRANSFER_IN` : `CASH_TRANSFER` ; `SESSION_VARIANCE` : `CASH_SESSION`, dans les deux sens ; `OPENING_BALANCE` : entrée citant `CASH_SESSION`, **DÉDUIT** faute de document propre). Un inverse reprend compte, montant, type et document de l'original en sens opposé, une seule fois ; un remboursement partiel n'est pas un inverse mais un mouvement `REFUND`. BR-FIN-012 : en ligne, une sortie ne rend pas négatif le solde d'une caisse physique (`CASH_INSUFFICIENT`) ; hors ligne elle est appliquée et signalée (`negativeBalance`, anomalie `CASH_NEGATIVE` à ouvrir par l'appelant). Un compte inactif refuse un mouvement en ligne, l'accepte hors ligne (fait accompli). Un inverse porte en général l'`occurred_at` de l'original ; **exception** : l'inverse de la sortie d'une remise annulée est daté de l'annulation, fait physique nouveau (ADR-032 §2 dernière phrase, AV-157 (a) ; D09 §16) — la session d'un mouvement se détermine par son `occurred_at`, jamais par `reverses_movement_id`.
- **Implémentation** (P4-02) : `CHECK is_reversal ⇔ reverses_movement_id` non nul ; modification et suppression refusées par déclencheurs ; droits `SELECT`, `INSERT` seulement ; `cash_session_id` est un **index dénormalisé** de la session de la fenêtre (clé étrangère depuis P5-03) : l'attendu et INV-FIN-11 se calculent par fenêtre de temps, jamais par ce pointeur (ADR-032 §2). **Pose de l'index** (P5-12) : pour une caisse de PDV, `recordCashMovement` écrit la session dont la fenêtre couvre `occurred_at` **au moment de l'écriture** (lecture verrouillante après le verrou du compte), sinon `NULL` ; pour un inverse, l'index de l'original, à défaut la session couvrant la date de l'original (AV-157 ; depuis P5-14, l'inverse de l'annulation d'un encaissement porte l'`occurred_at` de l'original et retombe donc dans sa fenêtre) ; une valeur explicite de l'appelant prime (écarts de session `SESSION_VARIANCE`). Les autres comptes gardent `NULL`. L'index n'est jamais réécrit : une ouverture hors ligne appliquée après coup ne rattache pas les mouvements déjà écrits, et une clôture hors ligne rétrodatée peut laisser un mouvement indexé à une session dont la fenêtre ne le couvre plus — P5-13 et P5-14 ne s'y fient pas pour l'attendu. `recordCashMovement` renvoie l'index posé (`cashSessionId`), que `sales` recopie sur l'encaissement et la vente (P5-14).

## finance.cash_transfers

**Responsabilité** : remise de fonds entre comptes (SM-CASH-TRANSFER ; ADR-032 §7). Implémentée en P5-03 ; commandes livrées en P5-15 (D09 §16).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `RMF` ; `site_id` de numérotation facultatif (le compte source n'a pas toujours de site) |
| `from_account_id`, `to_account_id` | uuid → cash_accounts | Non | — | Distincts (`CHECK`) |
| `amount_sent_xaf` | money_xaf | Non | — | > 0 |
| `amount_received_xaf` | money_xaf | Oui | — | ≥ 0 |
| `discrepancy_xaf` | bigint | Oui | — | Reçu − envoyé (comparaison null-safe) : négatif = manque, positif = excédent |
| `status` | enum(`SENT`,`RECEIVED`,`DISCREPANCY_PENDING`,`CLOSED`,`CANCELLED`) | Non | `SENT` | Cohérence état/données par `CHECK` |
| `sent_by`, `sent_device_id`, `sent_at` | uuid, uuid, ts | Non, Oui, Non | — | |
| `carrier_user_id`, `carrier_name` | uuid, label | Oui | — | Porteur : utilisateur connu ou nom libre (AV-158) |
| `received_by`, `received_device_id`, `received_at` | | Oui | — | Réception (`received_at`, `received_by` et montant reçu vont ensemble) |
| `out_movement_id` | uuid → cash_movements | Non | — | `TRANSFER_OUT` (unique) |
| `in_movement_id` | uuid → cash_movements | Oui | — | `TRANSFER_IN` du montant reçu |
| `cancel_movement_id` | uuid → cash_movements | Oui | — | Inverse de l'annulation |
| `imputation` | enum(`SENDER`,`CARRIER`,`RECEIVER`,`COMPANY`) | Oui | — | Imputation d'un écart clos (AV-153), **sans écriture de trésorerie** |
| `closing_reason`, `closed_by`, `closed_at`, `approval_request_id` | | Oui | — | Clôture de l'écart (type `CASH_TRANSFER_DISCREPANCY`) ; `approval_request_id` vide pour un écart reçu sans politique active, clos directement (AV-183, P5-23) |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | Oui | — | |
| `occurred_at`, `command_id`, `receive_command_id`, `cancel_command_id`, [STD-ORIGIN] | | | | Origine de chaque étape |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `(created_device_id, local_ref)`, `command_id`, `receive_command_id`, `cancel_command_id`, `out_movement_id`. **IX** `(from_account_id, status)`, `(to_account_id, status)`, `(status, sent_at)`.
- **Déclencheurs** : l'envoi est immuable ; une remise `RECEIVED`, `CLOSED` ou `CANCELLED` ne change plus ; `CLOSED` et `CANCELLED` sont terminaux ; `no_delete`. **Suppr.** `ANNULATION`. **Offline** DL (en cours, jeu `cash`) — P5-18 : `CASH_TRANSFER`, lignes `USER` (détenteur, à défaut responsable) et `SITE` des deux comptes, servie `SENT` et `DISCREPANCY_PENDING`, sortie à `RECEIVED`, `CLOSED` et `CANCELLED` (AV-193), et vers l'ancien responsable d'un compte réattribué ; ni mouvements ni imputation, CR.
- **Commandes** (P5-15, permission `finance.cash_transfer.record` sur le compte concerné) : `finance.cash_transfer.send` (sortie `TRANSFER_OUT`, numéro `RMF` : site du compte source, sinon du destinataire, sinon série globale `finance.cash_transfer_series_code`, AV-176 ; paires `finance.cash_transfer_allowed_pairs`, AV-158 ; `CASH_NEGATIVE` hors ligne ; commentaire d'envoi tracé par l'audit, sans colonne), `.receive` (entrée du montant reçu, aucune pour 0 ; écart → demande `CASH_TRANSFER_DISCREPANCY`, `approval_request_id`, si une politique est active, sinon aucune, AV-183 ; récepteur ≠ expéditeur), `.cancel` (expéditeur seul, inverse daté de l'annulation, `cancel_movement_id`) ; décision `CASH_TRANSFER_DISCREPANCY` → `CLOSED` (`imputation`, `closing_reason`, `closed_by`, `closed_at`, aucun mouvement) ; `.close_discrepancy` (P5-23, en ligne, permission `finance.cash_session.validate` sur le site de la remise) : façade de cette décision, ou clôture directe d'un écart sans demande (AV-183) ; courses hors ligne conservées en conflit informatif (AV-173) ; `cash_session_id` des mouvements laissé à P5-12. Lectures : `findCashTransfer`, `cashTransfersInTransit`, `verifyCashTransfers`. Lecture HTTP (P5-17) : `GET /cash-transfers` et `/cash-transfers/{id}` (droit `finance.cash.read` ; remise visible si l'un de ses deux comptes l'est, AV-189) ; `listCashTransfers`, `cashTransferMovements`.
- **Implémentation** (migration `20261010092000`, P5-15) : `ck_finance_cash_transfers_state` remplacé — `DISCREPANCY_PENDING` et `CLOSED` exigent l'entrée si le montant reçu est > 0 et l'interdisent s'il est nul (AV-175), `CLOSED` exige aussi le motif, `CANCELLED` n'a aucune entrée ; nouveau `ck_finance_cash_transfers_in_movement` (entrée ⇒ reçu > 0). Le code applique ces règles avant l'écriture.

## finance.expense_categories

**Responsabilité** : catégories de dépenses (AV-058, AV-357 ; ADR-060 §9).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | UUIDv7 semé une fois (administrable par commande, ADR-060 §9) |
| `code` | code | Non | — | AV-058 ; immuable |
| `label` | label | Non | — | |
| `default_cost_type` | enum(`VETERINAIRE`,`ALIMENT`,`AUTRE_INTRANT`,`DEPENSE_DIRECTE`) | Oui | — | Type de coût d'une dépense imputée à un lot ; vide = `DEPENSE_DIRECTE` (AV-357) |
| `allowed_on_pos` | boolean | Non | false | Petite dépense de caisse PDV (BR-DIS-013) |
| `is_system` | boolean | Non | false | Catégorie système (`NON_JUSTIFIEE`, BR-FIN-022), jamais saisie ; immuable |
| `is_active` | boolean | Non | true | |
| `status_reason` | varchar(500) | Oui | — | Motif de la dernière désactivation ou réactivation |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **CK** type de coût admis ; une catégorie système n'est pas permise au PDV. **Déclencheurs** : code et nature système immuables ; `no_delete`. **Suppr.** `DESACTIVATION`. **Offline** DL (jeu `catalog`, P8-10).
- **Seed** (`finance-references.ts`, codes absents seulement) : `ALIMENT_HORS_STOCK` (`ALIMENT`), `VETERINAIRE` (`VETERINAIRE`), `TRANSPORT`, `CARBURANT`, `ENERGIE_EAU`, `MAIN_OEUVRE_OCCASIONNELLE`, `ENTRETIEN`, `FOURNITURES`, `DIVERS`, `NON_JUSTIFIEE` (système) ; permises au PDV : transport, carburant, entretien, fournitures, divers (AV-357).
- **Commandes** (P8-04, permission `finance.expense_category.manage`, en ligne, `ONLINE_REQUIRED` sinon) : `finance.expense_category.create` (code unique, `EXPENSE_CATEGORY_DUPLICATE` ; rejeu idempotent sur l'agrégat), `.update` (libellé, type de coût, PDV), `.deactivate` et `.reactivate` (motif `status_reason` ; état déjà atteint sans effet) ; une catégorie système ne se modifie ni ne se désactive (`EXPENSE_CATEGORY_SYSTEM`). Chaque écriture publie `EXPENSE_CATEGORY` au jeu `catalog` (ligne `GLOBAL`, version de la ligne) ; les catégories semées sont publiées par le seed (`publish-references.ts`).

## finance.expenses

**Responsabilité** : dépense (SM-EXPENSE ; D09 §7.3 ; ADR-060).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Agrégat de la commande |
| [STD-DOC] | | | | Type `DEP` ; site de la saisie (charge utile) |
| `category_id` | uuid → expense_categories | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `payee_name` | label | Oui | — | Bénéficiaire |
| `supplier_id` | uuid → procurement.suppliers | Oui | — | |
| `description` | varchar(1000) | Non | — | |
| `cost_object_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SITE`) | Oui | — | |
| `cost_object_id` | uuid | Oui | — | Lot de production, lot d'incubation ou site (sans clé étrangère, comme le registre de coûts) |
| `species_group` | enum(`VOLAILLE`,`PORC`) | Oui | — | Site seulement : frais généraux de cette espèce (AV-356) |
| `paid_now` | boolean | Non | — | Payée à l'enregistrement |
| `paid_from_account_id` | uuid → cash_accounts | Oui | — | Compte payeur |
| `paid_at`, `paid_by` | ts, uuid → users | Oui | — | Paiement (à l'enregistrement ou par `finance.expense.pay`) |
| `cash_movement_id` | uuid → cash_movements | Oui | — | Mouvement `EXPENSE` `OUT` |
| `status` | enum(`RECORDED`,`PENDING_APPROVAL`,`APPROVED`,`REJECTED`,`PAID`,`PAID_PENDING_APPROVAL`,`PAID_REJECTED`,`CANCELLED`) | Non | — | |
| `review_reasons` | json | Oui | — | Motifs de revue d'une saisie hors ligne non conforme (ADR-060 §6, AV-352) |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Demande `EXPENSE` |
| `reclassified_category_id` | uuid → expense_categories | Oui | — | `NON_JUSTIFIEE` (BR-FIN-022, AV-355) |
| `responsibility_user_id` | uuid → users | Oui | — | Déclarant tenu pour responsable d'une dépense rejetée après paiement |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | Oui | — | [STD-CANCEL] (motif libre, comme les remises) |
| `business_date` | date | Non | généré | Jour métier de `occurred_at` (UTC+1) |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `(created_device_id, local_ref)`, `command_id`, `cash_movement_id`. **IX** `(category_id, business_date)`, `(cost_object_type, cost_object_id)`, `(site_id, business_date)`, `(created_by, business_date)`, `(status, business_date)`.
- **CK** montant > 0 ; objet de coût : type et identifiant ensemble, espèce réservée au site ; payée ⇔ compte, date, auteur et mouvement ; `paid_now` ⇒ payée ; état : statuts payés ⇔ paiement, en attente ⇒ demande, `PAID_REJECTED` ⇔ reclassement et responsable, `CANCELLED` ⇔ annulation motivée.
- **Déclencheurs** : saisie immuable (seuls décision, paiement et annulation évoluent) ; paiement immuable une fois posé ; `REJECTED`, `PAID`, `PAID_REJECTED`, `CANCELLED` terminaux ; `no_delete`.
- **Suppr.** `ANNULATION`. **Audit** Toute transition. **Offline** DL (30 j, jeu `cash`, P8-10), CR. P8-10 : projection `EXPENSE` servie sur la ligne `USER` de l'auteur seul (jamais la ligne `GLOBAL` de repli), dépenses datées ou modifiées dans les 30 derniers jours, ou en attente de décision (revue de P8-14), sans coût ni décision : numéro, référence locale, site, catégorie, montant, bénéficiaire, objet de coût, paiement, statut, motifs de revue, version.
- **Commandes** (P8-05, `expense-commands.ts`) : `finance.expense.record` (permission `finance.expense.record` sur le site de la dépense, propriété de l'auteur ; hors ligne admis) : catégorie et site connus, objet de coût connu (`COST_OBJECT_UNKNOWN`), compte que l'auteur peut mouvementer (`CASH_ACCOUNT_FORBIDDEN`) ; règles de revue (catégorie, PDV, plafond, justificatif, lot clos) : refus en ligne, validation a posteriori hors ligne ; session de caisse exigée au PDV en ligne (`CASH_SESSION_REQUIRED`), `CASH_SESSION_MISSING` hors ligne ; statut par `expenseStatusAtRecord` ; demande `EXPENSE` (justificatif exigé de l'approbateur) avant le numéro `DEP-{site}-{AAAA}-{seq6}` (ADR-038) ; coût dès l'enregistrement sans validation ; événements `ExpenseRecorded`, `ExpensePaid`. `finance.expense.pay` (en ligne, `finance.expense.pay`) : `RECORDED` ou `APPROVED` → `PAID`, mêmes règles du PDV. `finance.expense.cancel` (en ligne ; l'auteur, ou un détenteur de `finance.expense.approve`) : non payée seulement, coût contrepassé à la date de la dépense (refus `OVERHEAD_ALREADY_ALLOCATED` si le mois de frais généraux est réparti), demande retirée. Chaque écriture publie `EXPENSE` au jeu `cash` (ligne `USER` de l'auteur).
- **Décision `EXPENSE`** (P8-06, `expense-decisions.ts`) : approbation `PENDING_APPROVAL` → `APPROVED`, `PAID_PENDING_APPROVAL` → `PAID`, écriture de coût posée à ce moment ; plafond `limits.maxAmountXaf` du droit `finance.expense.approve` de l'approbateur, le plus permissif de ses rôles (`APPROVAL_LIMIT_EXCEEDED`, AV-350) ; rejet `REJECTED`, ou `PAID_REJECTED` avec `reclassified_category_id` = `NON_JUSTIFIEE` et `responsibility_user_id` = déclarant, sans coût (AV-355) ; retrait par le demandeur refusé (`EXPENSE_NOT_WITHDRAWABLE`) ; événements `ExpenseApproved`, `ExpenseRejected`.

## finance.supplier_invoices

**Responsabilité** : facture fournisseur (SM-SUPPLIER-INVOICE ; ADR-061). En ligne seulement.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Agrégat de la commande |
| `doc_number` | varchar(40) | Non | — | Type `FF`, série globale `finance.supplier_series_code` (ADR-061 §10) |
| `site_id` | uuid → organization.sites | Oui | — | Site du BC, s'il existe |
| `supplier_id` | uuid → procurement.suppliers | Non | — | |
| `supplier_invoice_ref` | varchar(60) | Non | — | Numéro du fournisseur |
| `invoice_date` | date | Non | — | |
| `due_date` | date | Non | — | Saisie, sinon date + délai du fournisseur, sinon date (AV-360) ; ≥ `invoice_date` |
| `purchase_order_id` | uuid → procurement.purchase_orders | Oui | — | |
| `total_xaf` | money_xaf | Non | — | Σ des lignes |
| `printed_total_xaf` | money_xaf | Oui | — | Total imprimé, comparé à Σ des lignes (rapprochement) |
| `tax_total_xaf` | money_xaf | Non | 0 | AV-041 |
| `paid_xaf` | money_xaf | Non | 0 | Σ affectations actives, dénormalisé (INV-FIN-07) |
| `status` | enum(`MISMATCH`,`DISPUTED`,`APPROVED`,`PARTIALLY_PAID`,`PAID`,`CANCELLED`) | Non | — | |
| `mismatch_details` | json | Oui | — | Écarts de rapprochement (`matchSupplierInvoice`) |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Demande `INVOICE_MISMATCH` |
| `approved_by`, `approved_at`, `approval_reason` | | Oui | — | Approbation (rapprochement conforme ou décision) |
| `disputed_by`, `disputed_at`, `dispute_reason` | | Oui | — | Contestation |
| `comment` | varchar(500) | Oui | — | |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | Oui | — | Annulation motivée (avoir, AV-359) |
| `active_ref_key` | varchar(60) | Oui | généré | Référence d'une facture non annulée |
| `occurred_at`, `command_id` | | | | Enregistrement |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `(supplier_id, active_ref_key)` (référence unique parmi les factures non annulées, AV-359), `command_id`. **IX** `(supplier_id, status, due_date)`, `purchase_order_id`, `(status, due_date)`.
- **CK** montants ≥ 0 et `paid_xaf ≤ total_xaf` (INV-FIN-07) ; échéance ≥ date ; état : approuvée ⇒ approbateur, contestée ⇒ date, `CANCELLED` ⇔ annulation motivée, payé cohérent avec `APPROVED` (0), `PARTIALLY_PAID`, `PAID` (total), nul ailleurs.
- **Déclencheurs** : facture immuable (seuls décision, payé et annulation évoluent) ; `CANCELLED` terminal ; `no_delete`. **Suppr.** `ANNULATION`. **Offline** SRV.
- **Commandes** (P8-07, `supplier-invoice-commands.ts`, en ligne seulement) : `finance.supplier_invoice.record` (`finance.supplier_invoice.record`) : fournisseur, produits et lignes de réception contrôlés (`PO_LINE_MISMATCH`), référence active unique (`INVOICE_DUPLICATE`), rapprochement `matchSupplierInvoice` sous le verrou du BC (`lockOrderForInvoicing`) ; conforme : `APPROVED` (approuvée par son auteur, motif « Rapprochement conforme »), quantités facturées écrites ; sinon `MISMATCH` et demande `INVOICE_MISMATCH` si une politique est active ; échéance par défaut (AV-360) ; numéro `FF` de la série globale. `.dispute`, `.approve`, `.cancel` (`finance.supplier_invoice.approve`) : contestation (demande retirée) ; approbation par la demande en cours (façade de `decideApprovalRequest`) ou directe pour une facture contestée, jamais par son auteur (`SELF_APPROVAL_FORBIDDEN`) ; annulation motivée (avoir, AV-359 ; quantités retirées d'une facture approuvée ; `INVOICE_HAS_PAYMENTS` si elle porte un paiement). Décision `INVOICE_MISMATCH` : approbation → `APPROVED`, rejet → `DISPUTED` ; retrait refusé (`INVOICE_NOT_WITHDRAWABLE`). Événements `SupplierInvoiceRecorded`, `SupplierInvoiceApproved`, `SupplierInvoiceMismatchDetected`.

## finance.supplier_invoice_lines

**Responsabilité** : lignes de facture.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `invoice_id` | uuid → supplier_invoices | Non | — | |
| `line_no` | smallint | Non | — | > 0 |
| `po_line_id` | uuid → procurement.purchase_order_lines | Oui | — | |
| `receipt_line_id` | uuid → procurement.goods_receipt_lines | Oui | — | |
| `product_id` | uuid → catalog.products | Oui | — | Nul pour une ligne de service ou de frais |
| `description` | varchar(200) | Non | — | |
| `quantity_base` | qty | Oui | — | > 0 |
| `unit_price_xaf` | money_xaf | Oui | — | Par unité de base |
| `line_total_xaf` | money_xaf | Non | — | ≥ 0 |
| `created_at` | ts | Non | — | |

- **PK** `id`. **UQ** `(invoice_id, line_no)`. **IX** `po_line_id`, `receipt_line_id`. **CK** ligne de BC ⇒ quantité et prix. **Déclencheurs** : `no_update`, `no_delete`. **Suppr.** Suit la facture.

## finance.supplier_payments

**Responsabilité** : paiements fournisseurs (SM-SUPPLIER-PAYMENT ; ADR-061 §6 et §7). En ligne seulement.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Agrégat de la commande |
| `doc_number` | varchar(40) | Non | — | Type `PF`, série globale `finance.supplier_series_code` |
| `site_id` | uuid → organization.sites | Oui | — | |
| `supplier_id` | uuid → procurement.suppliers | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `payment_method_code` | code → payment_methods | Non | — | |
| `from_account_id` | uuid → cash_accounts | Non | — | |
| `external_reference` | varchar(80) | Oui | — | |
| `status` | enum(`PENDING_APPROVAL`,`RECORDED`,`REJECTED`,`CANCELLED`) | Non | — | |
| `unallocated_xaf` | money_xaf | Non | — | Avance : montant − Σ affectations prévues ou actives (AV-362) |
| `cash_movement_id`, `disbursed_at` | | Oui | — | Décaissement : à l'enregistrement, ou à la validation au-delà du seuil (AV-363) |
| `cancel_movement_id` | uuid → cash_movements | Oui | — | Inverse de l'annulation |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Demande `SUPPLIER_PAYMENT` |
| `decided_by`, `decided_at` | | Oui | — | Décision de la Direction |
| `comment` | varchar(500) | Oui | — | |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | Oui | — | Annulation motivée (AV-364) |
| `occurred_at`, `command_id` | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`, `cash_movement_id`, `cancel_movement_id`. **IX** `(supplier_id, status)`, `(status, occurred_at)`.
- **CK** montant > 0, 0 ≤ non affecté ≤ montant ; mouvement ⇔ date de décaissement ; état : en attente ⇒ ni décaissement ni demande manquante, enregistré ⇒ décaissé, rejeté ⇒ non décaissé et décidé, `CANCELLED` ⇔ annulation motivée, annulation d'un paiement décaissé ⇒ inverse.
- **Déclencheurs** : paiement immuable (seuls décision, affectations et annulation évoluent) ; décaissement immuable ; `REJECTED`, `CANCELLED` terminaux ; `no_delete`. **Suppr.** `ANNULATION`. **Offline** SRV.
- **Commandes** (P8-08, `supplier-payment-commands.ts`, en ligne seulement) : `finance.supplier_payment.record` (`finance.supplier_payment.record`) : fournisseur connu ; moyen actif (`PAYMENT_METHOD_INVALID`), référence exigée par le moyen (`PAYMENT_REFERENCE_REQUIRED`), compatible avec le compte (`PAYMENT_METHOD_ACCOUNT_MISMATCH` : espèces vers une caisse, sinon le type de compte du moyen) ; compte actif que l'auteur peut mouvementer ; factures verrouillées, affectations `planSupplierPayment` (`ALLOCATION_INVALID`, `ALLOCATION_EXCEEDS`, `SUPPLIER_PAYMENT_EXCEEDS`) ; au-delà de `finance.supplier_payment_approval_xaf` : `PENDING_APPROVAL`, affectations `PLANNED`, demande `SUPPLIER_PAYMENT` (sans politique : `CONTROL_POLICY_MISSING`) ; sinon décaissement immédiat (session exigée au PDV), affectations `ACTIVE`, factures recalculées ; numéro `PF` de la série globale. Décision `SUPPLIER_PAYMENT` (Direction) : affectations revérifiées sous verrou (refus si une facture est soldée ou annulée entre-temps, AV-363), décaissement daté de la décision ; rejet : `REJECTED`, affectations `REVERSED` ; retrait refusé (`SUPPLIER_PAYMENT_NOT_WITHDRAWABLE`). `.allocate` : affecte l'avance d'un paiement décaissé (AV-362). `.cancel` (permission grossière `finance.payable.read`, contrôle fin) : en attente par son auteur (demande retirée), décaissé par la Direction (mouvement inverse, affectations contrepassées, factures rouvertes, AV-364). Événement `SupplierPaymentRecorded` au décaissement.

## finance.supplier_payment_allocations

**Responsabilité** : affectations aux factures (INV-FIN-07).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `payment_id` | uuid → supplier_payments | Non | — | |
| `invoice_id` | uuid → supplier_invoices | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `status` | enum(`PLANNED`,`ACTIVE`,`REVERSED`) | Non | — | `PLANNED` : paiement en attente de validation (ADR-061 §6) |
| `activated_at` | ts | Oui | — | |
| `reversed_at`, `reversed_by`, `reversal_reason` | | Oui | — | Contrepassation |
| `active_invoice_key` | uuid | Oui | généré | Facture d'une affectation non contrepassée |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `(payment_id, active_invoice_key)`. **IX** `(invoice_id, status)`. **CK** montant > 0 ; `REVERSED` ⇔ contrepassation motivée ; `ACTIVE` ⇒ date d'activation.
- **Déclencheurs** : données immuables ; seuls `PLANNED` → `ACTIVE` → `REVERSED` (ou `PLANNED` → `REVERSED`) ; `no_delete`. **Suppr.** `IMMUABLE` sauf `REVERSED`. **Intégrité** INV-FIN-07.

## finance.v_payables (vue)

Dette par facture (BR-FIN-032, KPI-FIN-05) : `supplier_id`, `invoice_id`, `doc_number`, `supplier_invoice_ref`, `invoice_date`, `due_date`, `total_xaf`, `paid_xaf`, `balance_xaf`, `days_overdue` (jours de retard au jour métier de Douala, 0 avant l'échéance). Source : factures `APPROVED` et `PARTIALLY_PAID`. Vue `finance_v_payables`, `SQL SECURITY INVOKER` (droits du lecteur).

- **Implémentation** (migration `20261101090000`, P8-03) : six tables et la vue ; type de validation `INVOICE_MISMATCH` ajouté au CHECK des politiques ; tests `db/tests/finance-operations.test.ts`.
