# Dictionnaire — schémas `approvals`, `attachments`, `communication`

## approvals.control_policies

**Responsabilité** : politique de contrôle proportionnée au risque (CM §24, §42 ; ADR-018).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | Lignée de la politique |
| `version` | int | Non | 1 | |
| `operation_type` | enum(`LOSS_DECLARATION`,`MORTALITY`,`INVENTORY_ADJUSTMENT`,`TRANSFER_DISCREPANCY`,`EXPENSE`,`PURCHASE_REQUEST`,`PURCHASE_ORDER`,`RECEIPT_WITHOUT_PO`,`RECEIPT_VALUE`,`SUPPLIER_PAYMENT`,`PRICE_OVERRIDE`,`SALE_CANCELLATION`,`CREDIT_LIMIT_EXCEEDED`,`CASH_VARIANCE`,`CHECKIN_OVERRIDE`,`RECEIPT_QUARANTINE`,`RECEIPT_CANCELLATION`,`ANIMAL_COUNT_ADJUSTMENT`,`PAYMENT_CANCELLATION`,`PAYMENT_DUPLICATE`,`CASH_TRANSFER_DISCREPANCY`,`INVOICE_MISMATCH`) | Non | — | `RECEIPT_QUARANTINE`, `RECEIPT_CANCELLATION` ajoutés en P6-02 (D08 §11) ; `CASH_TRANSFER_DISCREPANCY` (écart d'une remise de fonds) en P5-03 ; `INVOICE_MISMATCH` (écart de rapprochement d'une facture fournisseur, ADR-043) en P8-03 ; `ANIMAL_COUNT_ADJUSTMENT` (écart d'inventaire sur des animaux, AV-108) en P7-02 ; `PAYMENT_CANCELLATION` (annulation d'un encaissement client) et `PAYMENT_DUPLICATE` (décision de la Finance sur un encaissement `SUSPECT_DUPLICATE`, AV-056) en P4-02 (SM-CUSTOMER-PAYMENT) |
| `condition` | json | Non | `{}` | Conditions déclaratives : catégorie, quantité ≥, valeur ≥, pourcentage de l'effectif ≥, site ou zone |
| `requires_photo` | boolean | Non | false | |
| `requires_comment` | boolean | Non | false | |
| `requires_approval` | boolean | Non | false | |
| `approver_permission` | varchar(80) → identity.permissions | Oui | — | Permission d'approbation |
| `approver_scope` | enum(`SITE`,`ZONE`,`TEAM`,`ALL`) | Oui | — | Portée d'approbation relative à l'opération |
| `valid_from` | ts | Non | — | |
| `valid_to` | ts | Oui | — | |
| `status` | enum(`ACTIVE`,`RETIRED`) | Non | `ACTIVE` | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `(code, version)`.
- **CK** `requires_approval` ⇒ `approver_permission` non nul. `operation_type` ∈ catalogue ci-dessus (`ck_approvals_control_policies_operation_type`, recréé à chaque ajout de type : la dernière fois en P8-03 pour `INVOICE_MISMATCH`, migration `20261101090000`). C'est la **seule** des deux tables à porter ce `CHECK` (voir `approval_requests`).
- **Suppr.** `VERSIONNEMENT` (INV : la version en vigueur à `occurred_at` est figée sur l'opération, BR-ADM-016).
- **Audit** Chaque version. **Offline** DL (politiques actives, pour l'évaluation indicative sur l'appareil) — jeu `policies`, ligne `GLOBAL` (P5-18, AV-196) : la nouvelle version active est publiée et la version retirée supprimée (`DELETE`) ; politiques semées publiées par le seed.
- Le schéma de `condition` est validé par l'application (JSON Schema versionné) ; il n'est **jamais** interrogé comme donnée métier.
- **Politiques par défaut des ventes** (P4-02, seed `db/seeds/sales-references.ts`). Le seed n'insère que les codes absents et ne réécrit jamais une politique modifiée depuis (versionnement, BR-ADM-016). Sans politique, l'opération est refusée (`CONTROL_POLICY_MISSING`). Toutes ont `condition = {}`, `requires_photo = false`, `requires_approval = true` et `approver_scope = ALL` : chaque opération de ces types est soumise à validation, les seuils éventuels se règlent ensuite dans la politique (DÉDUIT).

  | Code | `operation_type` | Permission d'approbation | Réf. |
  |---|---|---|---|
  | `PRICE_OVERRIDE_DEFAULT` | `PRICE_OVERRIDE` | `sales.price_override.approve` | AV-026, BR-VEN-015 |
  | `SALE_CANCELLATION_DEFAULT` | `SALE_CANCELLATION` | `sales.sale_cancel.approve` | AV-030, BR-VEN-028 |
  | `CREDIT_LIMIT_EXCEEDED_DEFAULT` | `CREDIT_LIMIT_EXCEEDED` | `sales.credit_limit_exceed.approve` | AV-028, BR-VEN-025 |
  | `PAYMENT_CANCELLATION_DEFAULT` | `PAYMENT_CANCELLATION` | `sales.payment.cancel` | AV-056, SM-CUSTOMER-PAYMENT |
  | `PAYMENT_DUPLICATE_DEFAULT` | `PAYMENT_DUPLICATE` | `sales.payment.cancel` | AV-056, BR-FIN-005 |

- **Politiques par défaut de la finance opérationnelle** (P8-03, seed `db/seeds/finance-references.ts`, mêmes règles d'insertion). Le seuil est un paramètre ; la politique dit qui approuve (ADR-042 §2, ADR-043).

  | Code | `operation_type` | Permission d'approbation | Réf. |
  |---|---|---|---|
  | `EXPENSE_DEFAULT` | `EXPENSE` | `finance.expense.approve` | AV-058, AV-264, BR-FIN-021 |
  | `INVOICE_MISMATCH_DEFAULT` | `INVOICE_MISMATCH` | `finance.supplier_invoice.approve` | AV-053, BR-FIN-031 |
  | `SUPPLIER_PAYMENT_DEFAULT` | `SUPPLIER_PAYMENT` | `finance.supplier_payment.approve` | AV-055, BR-FIN-033 |

## approvals.approval_requests

**Responsabilité** : demande de validation d'une opération (SM-APPROVAL).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `operation_type` | varchar(30) (mêmes valeurs que `control_policies.operation_type`) | Non | — | **Sans `CHECK` en base** (voir ci-dessous) |
| `subject_type` | code | Non | — | Type de document (polymorphe) |
| `subject_id` | uuid | Non | — | |
| `subject_summary` | text | Non | — | Résumé affiché (« Perte 40 sacs d'aliment, 600 000 XAF ») |
| `site_id` | uuid → organization.sites | Oui | — | Routage |
| `zone_id` | uuid → organization.zones | Oui | — | Routage |
| `amount_xaf` | money_xaf | Oui | — | Affichage et tri |
| `requested_by` | uuid → identity.users | Non | — | |
| `requested_at` | ts | Non | — | |
| `policy_id`, `policy_version` | uuid, int | Oui | — | Politique figée |
| `required_attachment_ids` | uuid[] | Non | `{}` | Pièces attendues |
| `status` | enum(`PENDING`,`APPROVED`,`REJECTED`,`CANCELLED`) | Non | `PENDING` | |
| `decision_option` | code | Oui | — | Issue choisie (ex. `ERREUR_DECLARATION`, `PERTE_NON_JUSTIFIEE`, `REFUND`, `CUSTOMER_CREDIT`, imputation `SENDER`/`CARRIER`/`RECEIVER`/`COMPANY` d'un écart de remise ; catalogue par type : `approvalDecisionSpec`, `@gic/domain`, MP-07). Des données propres au type d'opération (`decisionData` de `approvals.request.approve`, dix au plus, ex. `correctedReference` d'un encaissement suspect, AV-135, P4-08) sont remises au gestionnaire du module propriétaire sans être stockées ici : l'inbox et l'audit de la commande les tracent |
| `decided_by` | uuid → identity.users | Oui | — | |
| `decided_at` | ts | Oui | — | |
| `decision_comment` | text | Oui | — | Obligatoire en cas de rejet |
| `self_approved` | boolean | Non | false | Marqueur `SELF_APPROVED` (AV-010) |
| `escalated_at` | ts | Oui | — | Posé **une fois** par la tâche horaire `approvals.requests.pending_long_check` au premier constat du délai (AV-466), sans commande, sans audit et sans changement de `version` ; jamais remis à `NULL` |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** une demande `PENDING` par (`subject_type`, `subject_id`, `operation_type`).
- **CK** `decided_*` renseignés si et seulement si `APPROVED` ou `REJECTED` ; `decided_by <> requested_by` sauf `self_approved` (INV-ADM-02).
- **`operation_type` sans `CHECK`** : contrairement à `control_policies`, la colonne est un `VARCHAR(30)` libre en base ; aucun `CHECK` n'en limite les valeurs (migration `20260924100500_create_approvals.sql`). Ajouter un type d'opération (ex. `PAYMENT_CANCELLATION`, `PAYMENT_DUPLICATE` en P4-02) ne demande donc une migration que sur `control_policies`. Le catalogue fermé n'est tenu que côté application (`OPERATION_TYPES` et type `OperationType`, module `approvals`), sans garde-fou en base sur cette table.
- **IX** `(status, site_id)`, `(status, operation_type)`, `(requested_by)`.
- **Suppr.** `IMMUABLE` après décision. **Audit** Création, décision. **Offline** DL (celles de l'utilisateur, en lecture seule).

## attachments.attachments

**Responsabilité** : pièce justificative (SM-ATTACHMENT ; ADR-012).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Généré sur l'appareil |
| `owner_type` | code | Non | — | Document propriétaire (polymorphe) |
| `owner_id` | uuid | Non | — | |
| `kind` | enum(`PHOTO`,`INVOICE`,`RECEIPT`,`DELIVERY_NOTE`,`SUPPLIER_DOCUMENT`,`OTHER`) | Non | — | CM §42 |
| `mime_type` | varchar(60) | Non | — | |
| `size_bytes` | int | Non | — | ≤ 5 Mo |
| `sha256` | char(64) | Non | — | Empreinte déclarée par l'appareil, vérifiée à l'upload |
| `storage_key` | varchar(200) | Oui | — | Clé dans le stockage objet (après upload) |
| `upload_status` | enum(`PENDING_UPLOAD`,`AVAILABLE`,`QUARANTINED`,`MISSING`,`SUPERSEDED`) | Non | `PENDING_UPLOAD` | |
| `uploaded_bytes` | int | Non | 0 | Progression de l'upload reprenable |
| `captured_at` | ts | Non | — | Heure de prise de vue |
| `captured_lat`, `captured_lng` | lat, lng | Oui | — | Si disponible |
| `superseded_by_id` | uuid → attachments | Oui | — | |
| [STD-ORIGIN] | | | | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `storage_key`. **IX** `(owner_type, owner_id)`, `(upload_status)` partiel.
- **Suppr.** `IMMUABLE` (remplacement par une nouvelle pièce) ; purge des fichiers après 5 ans (AV-074), avec conservation des métadonnées.
- **Offline** CR : fichier conservé localement jusqu'à `AVAILABLE`.

## communication.alert_rules

**Responsabilité** : règles d'alerte. Les seuils ne sont pas portés ici : ce sont des paramètres `organization.system_settings` lus par le détecteur, dans le module propriétaire (AV-400, [ADR-071](../../decisions/ADR-071-alertes-detection-correlation-et-cycle-de-vie.md)).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `alert_type` | code | Non | — | PK (catalogue D13 §7.1) |
| `enabled` | boolean | Non | true | |
| `severity` | enum(`INFO`,`WARNING`,`CRITICAL`) | Non | — | |
| `recipient_roles` | text[] | Non | — | Codes de rôles destinataires |
| `resolution_mode` | enum(`AUTO`,`MANUAL`) | Non | — | |
| `escalation_hours` | smallint | Oui | 4 | Alertes `CRITICAL` (BR-NOT-005) |
| `escalation_roles` | text[] | Non | `{DIRECTION}` | Rôles du niveau supérieur (AV-417) |
| `updated_at`, `updated_by` | | | | |

- **PK** `alert_type`. **Suppr.** Désactivation (`enabled`). **Audit** Modification.

## communication.alerts

**Responsabilité** : toute entité.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `alert_type` | code → alert_rules | Non | — | |
| `nature` | enum(`STATE`,`EVENT`) | Non | — | Alerte d'état (se résout seule) ou d'événement (BR-NOT-003) |
| `severity` | enum(`INFO`,`WARNING`,`CRITICAL`) | Non | — | Relevée par une occurrence plus grave, jamais abaissée tant que l'alerte est ouverte (AV-401) |
| `subject_type`, `subject_id` | code, uuid | Non | — | Objet concerné ; UUID v5 déterministe pour un sujet composite (ADR-071 §5) |
| `site_id`, `zone_id` | uuid | Oui | — | Routage par périmètre |
| `owner_user_id` | uuid → identity.users | Oui | — | Propriétaire de l'objet (titulaire du client, auteur, vendeur) : sert la portée `OWN` et `TEAM` |
| `title` | varchar(200) | Non | — | |
| `message` | varchar(1000) | Non | `''` | Rendu **neutre** (sans valeur au coût) ; le rendu pour un lecteur est calculé à la lecture (ADR-071 §11) |
| `payload` | json | Non | `{}` | Valeurs du message en champs séparés (copie des données minimales de l'événement) ; les valeurs au coût y sont des champs **protégés**, rendus à la lecture selon `inventory.valuation.read` (ADR-071 §11) ; jamais recopiées dans `message` |
| `action_screen` | code | Oui | — | Écran d'action (`ECR-…`) |
| `dedup_key` | varchar(200) | Non | — | `type:subject` |
| `open_dedup_key` | varchar(200) | Oui | généré | `dedup_key` tant que `status` ∈ (`OPEN`, `ACKNOWLEDGED`), sinon `NULL` (colonne générée, ADR-071 §4) |
| `occurrences` | int | Non | 1 | |
| `first_detected_at`, `last_detected_at` | ts | Non | — | |
| `business_day` | date | Oui | — | Jour métier du dernier fait détecté |
| `status` | enum(`OPEN`,`ACKNOWLEDGED`,`RESOLVED`,`DISMISSED`) | Non | `OPEN` | |
| `acknowledged_by`, `acknowledged_at`, `resolved_by`, `resolved_at` | | Oui | — | |
| `resolution_kind` | enum(`CONDITION_CLEARED`,`PASS`,`MANUAL`,`DISMISSED`) | Oui | — | Comment l'alerte s'est close ; renseigné ⇔ `RESOLVED` ou `DISMISSED` |
| `resolution_comment` | varchar(500) | Oui | — | Obligatoire pour une résolution manuelle ou un écart |
| `escalated_at` | ts | Oui | — | |
| `critical_since` | ts | Oui | — | Instant de la levée ou du relèvement en `CRITICAL` : point de départ de l'échéance d'escalade (ADR-072 §7) |
| `last_pass_id` | varchar(64) | Oui | — | Identité de la dernière passe de détection qui a revu l'alerte d'état ; sert à la résolution par marqueur (ADR-071 §3) |

- **PK** `id`. **UQ** `open_dedup_key` (INV-NOT-01 : au plus une alerte ouverte par type et objet ; les valeurs `NULL` ne se heurtent pas). **IX** `(status, severity, first_detected_at)`, `(site_id, status)`, `(owner_user_id, status)`.
- **Suppr.** `IMMUABLE` après résolution ; purge après 2 ans. **Offline** DL (50 dernières ouvertes du périmètre).

## communication.alert_recipients

**Responsabilité** : boîte d'alertes d'un utilisateur — qui doit voir quelle alerte, fixé à la levée ou à l'escalade ([ADR-072](../../decisions/ADR-072-destinataires-notifications-push-et-escalade.md)).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `alert_id` | uuid → alerts | Non | — | |
| `user_id` | uuid → identity.users | Non | — | |
| `origin` | enum(`RULE`,`OWNER`,`TEAM_MANAGER`,`APPROVER`,`ESCALATION`,`FALLBACK`) | Non | — | Règle (rôle × périmètre), propriétaire, responsable de l'équipe du propriétaire, approbateur (permission et portée), escalade, repli Direction |
| `role_code` | code | Oui | — | Rôle par lequel l'utilisateur est destinataire |
| `added_at` | ts | Non | `now()` | |

- **PK** `(alert_id, user_id)`. **IX** `(user_id, alert_id)`. **Suppr.** Suit l'alerte (purge à 2 ans). **Offline** DL (via les alertes ouvertes).

## communication.notifications

**Responsabilité** : notifications par utilisateur.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → identity.users | Non | — | |
| `channel` | enum(`IN_APP`,`WEB_PUSH`) | Non | — | |
| `title`, `body` | label, text | Non | — | |
| `kind` | enum(`ALERT`,`NOTE`,`DIRECT`,`EXPORT`) | Non | — | Source : alerte, note de direction, notification directe d'un événement (AV-439), fin d'un export |
| `link` | varchar(200) | Oui | — | |
| `alert_id` | uuid → alerts | Oui | — | Mis à `NULL` à la purge de l'alerte |
| `alert_type` | code | Oui | — | Type de l'alerte (regroupement des push par couple utilisateur et type) ; exigé si `kind = ALERT` |
| `note_id` | uuid → internal_notes | Oui | — | Exigé si `kind = NOTE` |
| `source_type`, `source_id` | code, uuid | Oui | — | Objet source. Pour `kind = ALERT` : `source_type` vaut `ALERT` (levée, relèvement, occurrence) ou `ALERT_ESCALATION` (escalade, jamais regroupée) et `source_id` l'alerte ; sinon la notification directe ou l'export. Pour `kind = DIRECT` (P9-11, AV-480) : `source_type` vaut `APPROVAL_REQUEST` (demande de validation ou sa décision) ou `STOCK_TRANSFER` (transfert demandé ou expédié) et `source_id` l'objet |
| `source_event_id` | uuid | Oui | — | Événement qui l'a produite ; unique avec (utilisateur, canal) : un consommateur rejoué ne la double pas |
| `created_at` | ts | Non | `now()` | |
| `delivered_at`, `read_at` | ts | Oui | — | Seuls champs qui évoluent, chacun une fois. `delivered_at` : posé à la création pour `IN_APP` ; pour `WEB_PUSH`, à l'envoi accepté par au moins un abonnement (tâche `communication.push.dispatch`) ; une ligne jamais livrée est abandonnée après la fenêtre de reprise |

- **PK** `id`. **UQ** `(user_id, channel, source_event_id)`. **IX** `(user_id, read_at, created_at)`, `(alert_id)`, `(user_id, alert_type, channel, created_at)`. **Suppr.** `PURGE_TECHNIQUE` 90 jours après lecture. **Offline** DL (non lues).

## communication.push_subscriptions

**Responsabilité** : abonnements Web Push.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → identity.users | Non | — | |
| `device_id` | uuid → identity.devices | Non | — | |
| `endpoint` | varchar(500) | Non | — | |
| `p256dh`, `auth` | text | Non | — | Clés Web Push |
| `created_at` | ts | Non | `now()` | |
| `revoked_at` | ts | Oui | — | |

- **PK** `id`. **UQ** `endpoint`. **Suppr.** `PURGE_TECHNIQUE` des abonnements révoqués ou invalides (réponse 410).

## communication.internal_notes

**Responsabilité** : notes de direction.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `title` | label | Non | — | |
| `body` | text | Non | — | |
| `category` | enum(`PRIX`,`INSTRUCTION`,`PROCEDURE`,`INFORMATION`) | Non | — | CM §43 |
| `related_entity_type`, `related_entity_id` | code, uuid | Oui | — | Ex. règle tarifaire |
| `requires_ack` | boolean | Non | false | AV-066 |
| `published_at` | ts | Oui | — | |
| `expires_at` | ts | Oui | — | Postérieure à la publication |
| `status` | enum(`DRAFT`,`PUBLISHED`,`ARCHIVED`) | Non | `DRAFT` | |
| `archived_at`, `archive_reason` | ts, varchar(500) | Oui | — | Archivage d'une note publiée ou abandon d'un brouillon |
| `command_id` | uuid | Oui | — | Idempotence de la publication (unique) |
| [STD-AUDIT] | | | | |

- **PK** `id`. **Suppr.** `ARCHIVED` (un brouillon abandonné aussi : aucune suppression physique, INV-GLO-03) ; immuable une fois publiée, **audiences comprises** : déclencheurs d'immuabilité sur `internal_notes` et `note_audiences` (BR-NOT-006). **Offline** DL en portée `USER` (notes publiées non expirées des utilisateurs résolus à la publication).

## communication.note_audiences

**Responsabilité** : audience d'une note.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `note_id` | uuid → internal_notes | Non | — | |
| `audience_type` | enum(`ALL`,`ROLE`,`SITE`,`ZONE`,`USER`) | Non | — | |
| `audience_ref` | varchar(80) | Non | `'*'` | Code de rôle ou identifiant ; `'*'` pour `ALL` (une clé primaire n'admet pas de colonne nulle) |

- **PK** `(note_id, audience_type, audience_ref)`. **Suppr.** Suit la note.

## communication.note_acknowledgements

**Responsabilité** : lectures et accusés.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `note_id` | uuid → internal_notes | Non | — | |
| `user_id` | uuid → identity.users | Non | — | |
| `read_at` | ts | Non | — | |
| `acknowledged_at` | ts | Oui | — | |
| `command_id` | uuid | Oui | — | |

- **PK** `(note_id, user_id)`. **Suppr.** `IMMUABLE`. **Offline** CR.
