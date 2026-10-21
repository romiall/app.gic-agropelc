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
- **Offline** SRV. **Intégrité** INV-AUD-01, INV-AUD-02 ; chaînage calculé sous verrou séquentiel (une file d'écriture dédiée pour préserver l'ordre) — le verrou porte sur `audit.chain_head`.

## audit.chain_head

**Responsabilité** : tête de la chaîne d'audit (dernier `seq`, dernier `row_hash`), seul point de sérialisation du chaînage. Ajoutée en P2 : verrouiller « la dernière ligne » d'`audit_log` posait un verrou d'intervalle (InnoDB) qui interbloquait deux écritures concurrentes ; un verrou de ligne par clé primaire exacte n'en pose aucun.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | smallint | Non | — | Toujours 1 (ligne unique) |
| `last_seq` | bigint | Non | — | `seq` de la dernière entrée écrite (0 sur une base neuve) |
| `last_row_hash` | char(64) | Non | — | `row_hash` de cette entrée (empreinte de genèse, 64 zéros, sur une base neuve) |
| `updated_at` | ts | Non | `now()` | |

- **PK** `id`. **CK** `id = 1`.
- **Suppr.** Jamais (ligne unique posée par la migration, mise à jour par l'écriture d'audit dans la même transaction).
- **Offline** SRV. **Intégrité** `last_seq` = `max(audit_log.seq)` et `last_row_hash` = son `row_hash` à tout instant (mise à jour atomique avec l'insertion).

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
| `claimed_at` | ts | Oui | — | Dernière réclamation du traitement (insertion ou reprise) ; l'abandon d'une ligne `RECEIVED` se mesure depuis elle (`received_at` reste la première réception), de même que la date du rejet d'une commande retenue puis rejetée par le pipeline (alerte `SYNC_ERROR`, AV-471). Modifiable (P5-21, AV-210) |
| `clock_skew_ms` | int | Oui | — | Écart mesuré du lot (serveur − appareil), borné à ±2 147 483 647 ms (AV-227) |
| `clock_suspect` | boolean | Non | false | Horloge suspecte, décidée à la réception au seuil `sync.clock_skew_flag_minutes` (P5-23, AV-216) ; figée (déclencheur) ; source de `[STD-ORIGIN].clock_suspect` |
| `captured_offline` | boolean | Non | false | |
| `batch_id` | uuid | Oui | — | Lot d'envoi |
| `status` | enum(`RECEIVED`,`APPLIED`,`APPLIED_WITH_WARNINGS`,`CONFLICT`,`REJECTED`,`FAILED_RETRYABLE`) | Non | `RECEIVED` | |
| `result` | json | Oui | — | Identifiants et numéros créés, avertissements |
| `error_code`, `error_message` | varchar, text | Oui | — | |
| `attempts` | int | Non | 1 | Tentatives d'application serveur ; numéro de la réclamation en cours : toute conclusion de l'inbox y est conditionnée (P5-21, AV-210, AV-217) |

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
| `owner_role` | code | Non | — | Rôle chargé de la résolution ; `TITULAIRE` = titulaire du compte client concerné (P3-04, matrice des conflits) |
| `applied` | boolean | Non | — | La commande a-t-elle été appliquée (conflit informatif) ou non (quarantaine) ? |
| `details` | json | Non | — | État serveur et intention client, différences |
| `status` | enum(`OPEN`,`RESOLVED`,`DISMISSED`) | Non | `OPEN` | SM-CONFLICT |
| `resolution` | enum(`ACCEPT_CLIENT`,`KEEP_SERVER`,`MERGE`,`COMPENSATE`) | Oui | — | |
| `resolution_refs` | uuid[] | Non | `{}` | Documents de régularisation, cités par la personne qui clôt (`refs`, P5-17, AV-190) ou par le traitement qui clôt d'office (ex. l'inventaire, P5-10) ; la clôture manuelle n'en crée aucun |
| `resolved_by`, `resolved_at`, `resolution_comment` | | Oui | — | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **IX** `(status, owner_role, site_id)`. **Suppr.** `IMMUABLE` après résolution. **Offline** DL (conflits de l'utilisateur).
- **Lecture (P5-17)** : `GET /sync/conflicts(/{id})` (droit `sync.conflict.resolve`, visibilité par rôle propriétaire puis portée sur le site et l'auteur de la commande d'origine, AV-191 ; lectures du noyau `listConflicts`, `findConflict`). **Clôture manuelle** (`sync.conflict.resolve`, `.dismiss`, AV-190) : `status` `RESOLVED` avec `resolution`, ou `DISMISSED` avec `resolution` **nulle** ; `resolved_by`, `resolved_at` (heure de la décision, `occurred_at` de la commande), `resolution_comment` et `resolution_refs` renseignés ; la ligne n'est modifiée que si elle est encore `OPEN` (`closeConflict`), le déclencheur d'immuabilité n'est donc jamais atteint.

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
| `last_pull_at` | ts | Oui | — | Dernier pull (P5-19, AV-202) : écrit à chaque `GET /sync/pull` sur les lignes `_device` et `_a:<auteur>` (appareil connu seulement), base de la fraîcheur avec `last_push_at` |
| `bootstrapped_at` | ts | Oui | — | |
| `needs_rebootstrap` | boolean | Non | false | |

Et, par appareil (ligne `dataset = '_device'`) : `last_push_at`, `last_device_seq`, `known_gaps` (json — tableau technique de paires `[début, fin]`, ex. `[[45,47],[103,105]]` ; équivalent PostgreSQL : `int8range[]` ; **écrit depuis P9-10** par `sync.devices.seq_gap_check` : plages de `device_seq` déjà signalées par `DEVICE_SEQ_GAP`, effacé quand la suite est complète, AV-473), `last_clock_skew_ms`, `pending_reported` (nombre d'opérations restant à envoyer **après** le dernier lot, déclaré par l'appareil dans `pending_by_author` ; nul si non déclaré), `app_version`. `last_device_seq` est le plus grand `device_seq` reçu (P5-07). Sur un appareil partagé (AV-007), une ligne supplémentaire par auteur, `dataset = '_a:<utilisateur>'` (32 caractères hexadécimaux), porte son dernier envoi, son plus grand `device_seq` et ses opérations restantes.

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

**Surveillance (P9-10, AV-475)** : la passe `communication.consumers.failure_check` examine **toutes** les lignes (retard = âge du plus ancien événement de numéro supérieur à `last_seq`). L'application n'a pas le droit de supprimer une ligne : renommer ou retirer un consommateur impose une migration qui renomme ou apure sa ligne, sinon `CONSUMER_FAILED` le signale à jamais ; un consommateur neuf part de `last_seq = 0` et rejoue l'historique (retard transitoire au déploiement, à amorcer avec la tête du flux).

## platform.document_sequences

**Responsabilité** : compteurs de numérotation.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `doc_type` | code | Non | — | `VTE`, `CMD`, … |
| `site_id` | uuid | Non | — | Réf. sans FK (le noyau `platform` ne dépend d'aucun module). Clé du compteur : identifiant du site, sauf pour `RMF` (remises de fonds, P5-15, AV-176), clé par un identifiant déterministe tiré du **code** de la série (`codeEntityId('DOCUMENT_SERIES', code)`, ADR-031) : le numéro `RMF-{CODE}-{AAAA}-{seq6}` ne dépend que du code et de l'année, le compteur aussi |
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

## platform.job_schedules

**Responsabilité** : ordonnanceur des tâches récurrentes (P5-16 ; 05-architecture/05-stack.md K5 « tâches planifiées par verrou de ligne dédié », ADR-011, ADR-023). Une ligne par type de tâche récurrente, déclaré par les modules au démarrage (`RecurringJobRegistry.register({ jobType, schedule })`) ; la boucle du worker (`JobScheduler.enqueueDue`) dépose au plus une tâche dans `platform.jobs` par créneau.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `job_type` | varchar(80) | Non | — | PK ; type de la tâche déposée dans `platform.jobs` |
| `schedule_kind` | varchar(10) | Non | — | `INTERVAL` (intervalle fixe) ou `DAILY` (heure locale quotidienne) |
| `interval_seconds` | int | Oui | — | `INTERVAL` : secondes (> 0), créneaux alignés sur l'origine des temps |
| `local_time` | char(5) | Oui | — | `DAILY` : `HH:MM` en Africa/Douala (UTC+1, sans heure d'été) |
| `next_run_at` | ts | Non | — | Prochain créneau : la tâche est due dès que `next_run_at ≤ maintenant` ; à la création de la ligne, maintenant pour `INTERVAL`, prochain créneau local pour `DAILY` |
| `last_enqueued_at` | ts | Oui | — | Dernier dépôt |
| `last_job_id` | uuid | Oui | — | Dernière tâche déposée ; sans FK (`platform.jobs` est purgeable) |
| `created_at`, `updated_at` | ts | Non | `now()` | |

- **PK** `job_type`. **CK** `INTERVAL` ⇒ `interval_seconds > 0` et `local_time` nul ; `DAILY` ⇒ `local_time` au format `HH:MM` et `interval_seconds` nul.
- **Sémantique** : à chaque tour, une transaction par type verrouille la ligne due (`FOR UPDATE SKIP LOCKED` : plusieurs workers ne déposent jamais deux fois un créneau), dépose la tâche, puis avance `next_run_at` au créneau **suivant l'instant présent** dans la même transaction. Aucun rattrapage en rafale après un arrêt (une seule occurrence puis le créneau à venir) ; aucun empilement tant que la tâche précédente est `PENDING` ; une ligne sans récurrence inscrite dans le processus est ignorée. La forme de la récurrence modifiée dans le code met la ligne à jour sans réinitialiser `next_run_at`. **Première inscription** d'un type : `next_run_at` vaut maintenant pour une récurrence `INTERVAL` (premier tour du worker) et le prochain créneau local pour une récurrence `DAILY` (une tâche « à 02:00 » ou « à 23:59 » ne part pas au milieu de la journée parce qu'elle vient d'être inscrite) ; un créneau manqué par un arrêt du worker reste dû et part, une seule fois, au redémarrage.
- **Droits** `SELECT`, `INSERT`, `UPDATE` pour le compte applicatif (pas de `DELETE`). **Suppr.** Aucune (table technique). Pas de `[STD-AUDIT]` ni `[STD-ORIGIN]` (créée par du code système).
- **Implémentation** : migration `20261010093100_create_platform_job_schedules.sql`.

## platform.event_consumer_marks

**Responsabilité** : marque de traitement idempotent par consommateur (P0-08 ;
08-api-events/02-catalogue-evenements.md §1, §3 « consommateurs idempotents (position +
clé) »). Utilitaire optionnel : un consommateur dont l'effet de bord n'a pas déjà sa propre
contrainte d'unicité métier peut s'appuyer sur cette table plutôt que d'en construire une
pour son propre domaine. Aujourd'hui exercée uniquement par le consommateur de démonstration
du critère de sortie P0-08 (« consommateur de test exactement-une-fois par clé ») ; les
consommateurs réels (alertes, projections, Kommo…) restent hors périmètre P0-08.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `consumer_name` | code | Non | — | Même espace de noms que `event_consumer_offsets.consumer_name` |
| `event_id` | uuid | Non | — | `platform_domain_events.event_id` (sans FK — outbox non liée) |
| `processed_at` | ts | Non | `now()` | |

- **PK** `(consumer_name, event_id)`.
- **Suppr.** Ajout seul (comme `domain_events`) : la preuve d'idempotence tient à ce qu'une
  seconde écriture pour la même clé échoue (contrainte PK) plutôt que d'écraser la première —
  ni `UPDATE` ni `DELETE` pour l'application.

## platform.event_consumer_failures

**Responsabilité** : événements **sautés** par un consommateur après ses essais (P9-04 ; ADR-071 §12,
AV-412 ; catalogue d'événements §3 « Échecs »). Le runner saute l'événement et avance la position ;
`event_consumer_offsets.last_error` n'en garde que le dernier message, réécrit à `NULL` par le premier
événement traité ensuite. Cette table consigne chaque saut pour que l'alerte technique `CONSUMER_FAILED`
(ADMIN) ne repose pas sur un champ éphémère.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | bigint | Non | auto | |
| `consumer_name` | code | Non | — | Même espace de noms que `event_consumer_offsets` |
| `event_seq` | bigint | Non | — | `platform_domain_events.seq` |
| `event_id` | uuid | Non | — | `platform_domain_events.event_id` (sans FK) |
| `event_type` | varchar(80) | Non | — | |
| `error_message` | varchar(1000) | Non | — | Dernier message d'erreur |
| `attempts` | smallint | Non | — | Essais effectués |
| `failed_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `(consumer_name, event_seq)` : un saut n'est consigné qu'une fois. **IX** `(failed_at)`.
- **Suppr.** Ajout seul (`SELECT` et `INSERT` seulement pour l'application).
- **Implémentation** : migration `20261201090200_create_platform_event_consumer_failures.sql`.
