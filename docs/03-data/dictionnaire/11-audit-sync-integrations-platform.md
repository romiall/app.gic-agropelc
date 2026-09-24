# Dictionnaire — schémas `audit`, `sync`, `integrations`, `platform`

## audit.audit_log

**Responsabilité** : journal d'audit en ajout seul, chaîné (D12 ; spécification [`../../07-security-rbac/03-audit.md`](../../07-security-rbac/03-audit.md)).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `seq` | BIGINT UNSIGNED AUTO_INCREMENT | Non | — | PK, ordre global |
| `id` | uuid | Non | généré par l'application | Identifiant exposé (aucune fonction `uuidv7()` native en MySQL — voir `01-identifiants-et-conventions.md` §3.1) |
| `occurred_at` | ts | Non | — | Heure métier (de la commande) |
| `recorded_at` | ts | Non | `now()` | Heure serveur |
| `actor_user_id` | uuid → identity.users | Non | — | Utilisateur ou `system` |
| `actor_roles` | text[] | Non | — | Rôles actifs à `occurred_at` (instantané) |
| `device_id` | uuid → identity.devices | Oui | — | |
| `ip` | inet | Oui | — | |
| `user_agent` | varchar(300) | Oui | — | |
| `captured_offline` | boolean | Non | false | |
| `sync_delay_ms` | bigint | Oui | — | `received_at − client_created_at` |
| `clock_skew_ms` | int | Oui | — | |
| `command_id` | uuid | Oui | — | |
| `action` | varchar(80) | Non | — | Code de commande ou d'action (`sales.sale.cancel`, `auth.login.failed`, `audit.log.read`) |
| `entity_type` | code | Non | — | |
| `entity_id` | uuid | Oui | — | |
| `site_id` | uuid | Oui | — | Pour le filtrage par périmètre |
| `before` | json | Oui | — | Champs modifiés, valeurs avant |
| `after` | json | Oui | — | Valeurs après |
| `reason` | text | Oui | — | Motif ou commentaire |
| `approval_request_id` | uuid | Oui | — | |
| `result` | enum(`SUCCESS`,`DENIED`,`FAILED`,`QUARANTINED`) | Non | — | |
| `error_code` | varchar(60) | Oui | — | |
| `correlation_id` | uuid | Oui | — | Requête ou traitement |
| `prev_hash` | char(64) | Non | — | Hachage de l'entrée précédente |
| `row_hash` | char(64) | Non | — | SHA-256(`prev_hash` ‖ sérialisation canonique) |

- **PK** `seq`. **UQ** `id`.
- **IX** `(entity_type, entity_id)`, `(actor_user_id, recorded_at)`, `(action, recorded_at)`, `(site_id, recorded_at)`, `(device_id, recorded_at)`.
- **Partitionnement** mensuel par `recorded_at`.
- **Suppr.** `IMMUABLE` (privilèges + déclencheur) ; archivage froid après 24 mois ; conservation de 10 ans (AV-074).
- **Offline** SRV. **Intégrité** INV-AUD-01, INV-AUD-02 ; chaînage calculé sous verrou séquentiel (une file d'écriture dédiée pour préserver l'ordre).

## sync.command_inbox

**Responsabilité** : réception idempotente de chaque commande et son résultat (ADR-007).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `command_id` | uuid | Non | — | PK (INV-SYN-01) |
| `device_id` | uuid → identity.devices | Oui | — | Nul pour une commande back-office sans appareil enrôlé |
| `user_id` | uuid → identity.users | Non | — | Auteur |
| `device_seq` | bigint | Oui | — | Séquence d'appareil |
| `transport` | enum(`SYNC_PUSH`,`ONLINE_API`,`SYSTEM`) | Non | — | |
| `command_type` | varchar(80) | Non | — | `sales.sale.record` |
| `command_version` | smallint | Non | 1 | BR-SYN-016 |
| `aggregate_type`, `aggregate_id` | code, uuid | Oui | — | Cible principale |
| `base_version` | int | Oui | — | Concurrence optimiste |
| `depends_on` | uuid[] | Non | `{}` | |
| `payload` | json | Non | — | Contenu de la commande (conservé pour le rejeu et l'enquête) |
| `payload_hash` | char(64) | Non | — | INV-SYN-02 |
| `occurred_at` | ts | Non | — | |
| `client_created_at` | ts | Oui | — | |
| `device_sent_at` | ts | Oui | — | |
| `received_at` | ts | Non | `now()` | |
| `applied_at` | ts | Oui | — | |
| `clock_skew_ms` | int | Oui | — | |
| `captured_offline` | boolean | Non | false | |
| `batch_id` | uuid | Oui | — | Lot d'envoi |
| `status` | enum(`RECEIVED`,`APPLIED`,`APPLIED_WITH_WARNINGS`,`CONFLICT`,`REJECTED`,`FAILED_RETRYABLE`) | Non | `RECEIVED` | |
| `result` | json | Oui | — | Identifiants et numéros créés, avertissements |
| `error_code`, `error_message` | varchar, text | Oui | — | |
| `attempts` | smallint | Non | 1 | Tentatives d'application serveur |

- **PK** `command_id`. **UQ** `(device_id, device_seq)` (INV-SYN-03).
- **IX** `(device_id, received_at)`, `(user_id, received_at)`, `(status)` partiel non terminal.
- **Suppr.** `IMMUABLE` sauf transitions ; archivage après 13 mois (charges utiles compressées, conservées 10 ans avec l'audit).
- **Offline** SRV.

## sync.sync_conflicts

**Responsabilité** : conflits.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `command_id` | uuid → command_inbox | Oui | — | Commande à l'origine |
| `conflict_type` | code | Non | — | Voir la matrice des conflits |
| `entity_type`, `entity_id` | code, uuid | Non | — | |
| `site_id` | uuid | Oui | — | Routage |
| `owner_role` | code | Non | — | Rôle chargé de la résolution |
| `applied` | boolean | Non | — | La commande a-t-elle été appliquée (conflit informatif) ou non (quarantaine) ? |
| `details` | json | Non | — | État serveur et intention client, différences |
| `status` | enum(`OPEN`,`RESOLVED`,`DISMISSED`) | Non | `OPEN` | SM-CONFLICT |
| `resolution` | enum(`ACCEPT_CLIENT`,`KEEP_SERVER`,`MERGE`,`COMPENSATE`) | Oui | — | |
| `resolution_refs` | uuid[] | Non | `{}` | Documents compensatoires créés |
| `resolved_by`, `resolved_at`, `resolution_comment` | | Oui | — | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **IX** `(status, owner_role, site_id)`. **Suppr.** `IMMUABLE` après résolution. **Offline** DL (conflits de l'utilisateur).

## sync.change_feed

**Responsabilité** : flux ordonné des changements, filtrable par périmètre (ADR-007 ; [`../../06-offline-sync/02-synchronisation.md`](../../06-offline-sync/02-synchronisation.md) §5).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `seq` | BIGINT UNSIGNED AUTO_INCREMENT | Non | — | PK, curseur |
| `dataset` | code | Non | — | Jeu de données (`catalog`, `price_rules`, `customers`, `stock_balances`…) |
| `entity_type` | code | Non | — | |
| `entity_id` | uuid | Non | — | |
| `change_type` | enum(`UPSERT`,`DELETE`,`SCOPE_EXIT`) | Non | — | `DELETE` : désactivation ou retrait du jeu ; `SCOPE_EXIT` : l'entité sort du périmètre d'un destinataire |
| `scope_type` | enum(`GLOBAL`,`SITE`,`ZONE`,`TEAM`,`USER`,`DEVICE`,`LOCATION`) | Non | — | Destinataires |
| `scope_id` | uuid | Oui | — | |
| `row_version` | bigint | Non | — | Version de l'entité à ce changement |
| `recorded_at` | ts | Non | `now()` | |

- **PK** `seq`. **IX** `(scope_type, scope_id, seq)`, `(dataset, seq)`.
- **Suppr.** `PURGE_TECHNIQUE` au-delà de 60 jours (BR-SYN-015).
- Le contenu n'est **pas** copié dans le flux : le serveur lit l'état courant de l'entité au moment du téléchargement. Il n'y a donc aucune seconde vérité.

## sync.device_sync_state

**Responsabilité** : curseurs et état par appareil.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `device_id` | uuid → identity.devices | Non | — | |
| `dataset` | code | Non | — | |
| `cursor_seq` | bigint | Non | 0 | Dernier `change_feed.seq` reçu |
| `last_pull_at` | ts | Oui | — | |
| `bootstrapped_at` | ts | Oui | — | |
| `needs_rebootstrap` | boolean | Non | false | |

Et, par appareil (ligne `dataset = '_device'`) : `last_push_at`, `last_device_seq`, `known_gaps` (json — tableau technique de paires `[début, fin]`, ex. `[[45,47],[103,105]]` ; équivalent PostgreSQL : `int8range[]`), `last_clock_skew_ms`, `pending_reported` (nombre d'opérations en attente déclaré par l'appareil), `app_version`.

- **PK** `(device_id, dataset)`. **Suppr.** Technique (suit l'appareil). **Offline** SRV.

## integrations.external_links

**Responsabilité** : `CUSTOMER`, `SALES_ORDER`, `USER`.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `system` | enum(`KOMMO`) | Non | — | |
| `entity_type` | enum(`CUSTOMER`,`SALES_ORDER`,`USER`) | Non | — | |
| `entity_id` | uuid | Non | — | |
| `external_type` | enum(`contact`,`lead`,`company`,`user`) | Non | — | |
| `external_id` | varchar(60) | Non | — | |
| `last_inbound_hash`, `last_outbound_hash` | char(64) | Oui | — | Anti-boucle (BR-KOM-005) |
| `last_synced_at` | ts | Oui | — | |
| `status` | enum(`ACTIVE`,`BROKEN`) | Non | `ACTIVE` | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `(system, external_type, external_id)` (INV-KOM-01) ; `(system, entity_type, entity_id, external_type)`.
- **Offline** DL (liens des comptes du portefeuille : bouton « ouvrir dans Kommo »).

## integrations.inbox_messages

**Responsabilité** : webhooks reçus.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `system` | enum(`KOMMO`) | Non | — | |
| `dedup_key` | varchar(200) | Non | — | BR-KOM-006 |
| `event_type` | varchar(80) | Non | — | |
| `received_at` | ts | Non | `now()` | |
| `signature_valid` | boolean | Non | — | |
| `headers` | json | Non | — | Sans secret |
| `payload` | json | Non | — | Brut |
| `status` | enum(`RECEIVED`,`PROCESSED`,`IGNORED_DUPLICATE`,`IGNORED_ECHO`,`FAILED`,`DEAD`) | Non | `RECEIVED` | |
| `attempts` | smallint | Non | 0 | |
| `processed_at` | ts | Oui | — | |
| `error` | text | Oui | — | |

- **PK** `id`. **UQ** `(system, dedup_key)` (INV-KOM-02). **Suppr.** `PURGE_TECHNIQUE` après 180 jours pour les `PROCESSED` et `IGNORED_*`.

## integrations.outbox_messages

**Responsabilité** : appels sortants.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `system` | enum(`KOMMO`) | Non | — | |
| `operation` | varchar(80) | Non | — | Ex. `contact.upsert`, `lead.update_fields` |
| `entity_type`, `entity_id` | code, uuid | Non | — | |
| `idempotency_key` | varchar(200) | Non | — | BR-KOM-007 |
| `payload` | json | Non | — | Valeurs absolues |
| `payload_hash` | char(64) | Non | — | |
| `caused_by_event_id` | uuid | Oui | — | Événement métier source |
| `status` | enum(`PENDING`,`SENT`,`DEAD`) | Non | `PENDING` | |
| `attempts` | smallint | Non | 0 | |
| `next_attempt_at` | ts | Non | `now()` | |
| `last_error` | text | Oui | — | |
| `sent_at` | ts | Oui | — | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `idempotency_key`. **IX** `(status, next_attempt_at)`. **Suppr.** `PURGE_TECHNIQUE` après 180 jours pour les `SENT`.

## integrations.integration_settings

**Responsabilité** : paramètres Kommo.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `system` | enum(`KOMMO`) | Non | — | |
| `key` | varchar(100) | Non | — | Ex. `qualified_status_ids`, `field_map.total_revenue`, `user_map` |
| `value` | json | Non | — | |
| `updated_at`, `updated_by` | | | | |

- **PK** `(system, key)`. Les secrets (jetons d'API Kommo) sont **hors base**, dans le gestionnaire de secrets.

## platform.domain_events

**Responsabilité** : outbox transactionnelle des événements métier (ADR-011), consommée par le worker.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `seq` | BIGINT UNSIGNED AUTO_INCREMENT | Non | — | PK, ordre de consommation |
| `event_id` | uuid | Non | généré par l'application | |
| `event_type` | varchar(80) | Non | — | `SaleConfirmed` |
| `event_version` | smallint | Non | 1 | |
| `producer_module` | code | Non | — | |
| `aggregate_type`, `aggregate_id` | code, uuid | Non | — | |
| `occurred_at` | ts | Non | — | Heure métier |
| `recorded_at` | ts | Non | `now()` | |
| `payload` | json | Non | — | Données minimum du catalogue |
| `command_id` | uuid | Oui | — | Causalité |
| `correlation_id`, `causation_id` | uuid | Oui | — | Traçage |

- **PK** `seq`. **UQ** `event_id`. **IX** `(event_type, seq)`, `(aggregate_type, aggregate_id)`.
- **Suppr.** Rétention de 13 mois puis archivage. Ce n'est **pas** un event store : les tables métier restent la source de vérité.

## platform.event_consumer_offsets

**Responsabilité** : position de chaque consommateur.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `consumer_name` | code | Non | — | PK (ex. `communication.alerts`, `integrations.kommo`, `analytics.projections`) |
| `last_seq` | bigint | Non | 0 | |
| `updated_at` | ts | Non | `now()` | |
| `last_error` | text | Oui | — | |

## platform.document_sequences

**Responsabilité** : compteurs de numérotation.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `doc_type` | code | Non | — | `VTE`, `CMD`, … |
| `site_id` | uuid | Non | — | Réf. sans FK (le noyau `platform` ne dépend d'aucun module) |
| `year` | smallint | Non | — | |
| `next_value` | int | Non | 1 | Incrément sous verrou de ligne (numérotation sans trou) |

- **PK** `(doc_type, site_id, year)`.

## platform.jobs

**Responsabilité** : file de tâches maison (P0-08 ; ADR-011, ADR-023 « pg-boss abandonné,
table de tâches maison, `SELECT … FOR UPDATE SKIP LOCKED` ») — travaux différés/planifiés du
worker, consommée par verrou de ligne (`SKIP LOCKED`), pas par courtier de messages.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | uuid | Non | généré par l'application | PK |
| `job_type` | varchar(80) | Non | — | Résolu vers un gestionnaire enregistré (comme `command_type`) |
| `payload` | json | Non | — | Paramètres de la tâche (charge technique) |
| `status` | varchar(10) | Non | `PENDING` | `PENDING`, `DONE`, `FAILED` |
| `run_at` | ts | Non | — | Éligible dès que `run_at ≤ now()` ; une reprise avec attente progressive réécrit cette colonne — pas de statut `PROCESSING` séparé, le verrou de ligne tenu pendant le traitement en tient lieu |
| `attempts` | smallint | Non | 0 | |
| `max_attempts` | smallint | Non | 5 | Nombre d'essais avant `FAILED` (08-api-events/02-catalogue-evenements.md §3) |
| `last_error` | text | Oui | — | |
| `created_at` | ts | Non | `now()` | |
| `completed_at` | ts | Oui | — | |

- **PK** `id`. **IX** `(status, run_at)` (lecture du worker).
- **Suppr.** PURGE_TECHNIQUE : table opérationnelle, pas un registre métier ni un journal —
  contrairement à `domain_events` (outbox, ajout seul), une tâche terminée peut être purgée.
- Pas de `[STD-AUDIT]` (créée par du code système, pas par une commande utilisateur ; aucune
  concurrence optimiste — le verrou de ligne/`SKIP LOCKED` la remplace) ni `[STD-ORIGIN]`
  (aucun lien à un appareil), à la différence des tables des modules métier.
