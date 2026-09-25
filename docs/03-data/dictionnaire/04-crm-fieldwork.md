# Dictionnaire — schémas `crm` et `fieldwork`

## Référentiels CRM

### crm.lead_sources · crm.pipeline_steps (et, dans le schéma `catalog`, `catalog.customer_categories` · `catalog.sales_channels`)

> `customer_categories` et `sales_channels` sont des référentiels commerciaux **partagés** (CRM, tarification, ventes). Ils appartiennent au module `catalog`, ce qui permet de livrer la tarification (phase 1) sans dépendre du CRM. Leurs colonnes suivent la même structure que ci-dessous.

**Responsabilité** : référentiels configurables (AV-011, AV-017, AV-018).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | (`sales_channels` : PK = `code`) |
| `code` | code | Non | — | |
| `label` | label | Non | — | |
| `sort_order` | smallint | Non | 0 | Ordre d'affichage (étapes de pipeline) |
| `is_active` | boolean | Non | true | |
| `is_system` | boolean | Non | false | Valeur utilisée par des règles (ex. canal `POINT_DE_VENTE`, source `KOMMO`) : non désactivable |
| [STD-AUDIT] | | | | |

- **UQ** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL.

## crm.customers

**Responsabilité** : compte client, prospect ou client (ADR-017 ; D02).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Généré sur l'appareil |
| `stage` | enum(`PROSPECT`,`CUSTOMER`,`LOST`,`MERGED`) | Non | `PROSPECT` | SM-CUSTOMER |
| `pipeline_step_id` | uuid → pipeline_steps | Oui | — | Requis si `PROSPECT` |
| `customer_type` | enum(`PARTICULIER`,`ENTREPRISE`) | Non | `PARTICULIER` | |
| `display_name` | label | Non | — | |
| `contact_name` | label | Oui | — | Interlocuteur (entreprise) |
| `business_activity` | label | Oui | — | Activité (CM §7) |
| `category_id` | uuid → customer_categories | Oui | — | Type de client (tarification) |
| `phone_primary` | phone | Oui | — | Normalisé E.164 |
| `phone_secondary` | phone | Oui | — | |
| `email` | varchar(200) | Oui | — | |
| `address_text` | text | Oui | — | |
| `zone_id` | uuid → organization.zones | Non | — | |
| `lat`, `lng` | lat, lng | Oui | — | Position du compte |
| `geo_accuracy_m` | meters | Oui | — | |
| `source_code` | code → lead_sources | Non | — | Origine (CM §7) |
| `acquired_by_user_id` | uuid → identity.users | Non | — | Acquéreur, **immuable** (INV-CRM-01) |
| `acquired_at` | ts | Non | — | = `occurred_at` de la création, immuable |
| `owner_user_id` | uuid → identity.users | Oui | — | Titulaire courant (dénormalisé depuis `customer_assignments`) |
| `home_site_id` | uuid → organization.sites | Oui | — | Rattachement d'un client de PDV sans titulaire |
| `converted_at` | ts | Oui | — | Conversion |
| `first_sale_id` | uuid (réf. sans FK vers `sales.sales`) | Oui | — | Première vente (INV-CRM-04) |
| `conversion_reverted` | boolean | Non | false | BR-CRM-011 / D02 §11 |
| `lost_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si `LOST` |
| `merged_into_id` | uuid → customers | Oui | — | Requis si `MERGED` |
| `credit_allowed` | boolean | Non | false | AV-028 |
| `credit_limit_xaf` | money_xaf | Oui | — | |
| `payment_terms_days` | smallint | Oui | — | Défaut : paramètre système |
| `last_sale_at` | ts | Oui | — | Dénormalisé (actif / inactif, KPI) |
| `kommo_contact_ref` | — | — | — | *(absent : dans `integrations.external_links`)* |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **FK** vers les référentiels, zones, utilisateurs et sites.
- **UQ** `phone_primary` parmi `stage <> 'MERGED'` (INV-CRM-03) ; `command_id`.
- **CK** `phone_primary` ou (`lat`, `lng`) renseigné (BR-CRM-002) ; cohérence stade / colonnes (`LOST` ⇒ motif ; `MERGED` ⇒ `merged_into_id` ; `CUSTOMER` ⇒ `first_sale_id`).
- **IX** `(owner_user_id)`, `(zone_id)`, `(stage)`, plein texte `ngram` sur `display_name` (recherche approchée, MySQL — ADR-023), `(acquired_by_user_id, acquired_at)`.
- **Suppr.** `DESACTIVATION` / fusion (`MERGED`) ; pseudonymisation sur demande (données personnelles, AV-073).
- **Hist.** Stades et étapes dans `customer_stage_history` ; titulaires dans `customer_assignments` ; coordonnées et position dans l'audit (avant et après).
- **Audit** Création, modification, réaffectation, fusion, conditions de crédit, perte, réouverture.
- **Offline** DL (portefeuille ; équipe pour un responsable ; clients rattachés au PDV) ; CR (création, modification) avec `base_version`.

## crm.customer_assignments

**Responsabilité** : titulaires successifs d'un compte (CM §8).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `customer_id` | uuid → customers | Non | — | |
| `user_id` | uuid → identity.users | Non | — | Titulaire |
| `valid_from` | ts | Non | — | |
| `valid_to` | ts | Oui | — | Nul = en cours |
| `assigned_by` | uuid → identity.users | Non | — | |
| `reason` | text | Oui | — | Obligatoire pour une réaffectation |
| `command_id` | uuid | Oui | — | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **Non-chevauchement** par `customer_id` (INV-CRM-02) : verrouillage de ligne + déclencheur de re-vérification (MySQL, ADR-023).
- **IX** `(user_id, valid_from)`, `(customer_id, valid_from)`.
- **Suppr.** `IMMUABLE` sauf fermeture de `valid_to`. **Audit** Chaque affectation. **Offline** DL (affectations courantes du portefeuille).

## crm.customer_stage_history

**Responsabilité** : évolution d'un compte (CM §7 « évolution du prospect »).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `customer_id` | uuid → customers | Non | — | |
| `from_stage`, `to_stage` | enum | Oui / Non | — | |
| `from_step_id`, `to_step_id` | uuid → pipeline_steps | Oui | — | |
| `occurred_at` | ts | Non | — | |
| `actor_user_id` | uuid → identity.users | Non | — | |
| `reason_code_id` | uuid → catalog.reason_codes | Oui | — | |
| `cause_ref` | uuid | Oui | — | Ex. vente déclenchant la conversion |
| `command_id` | uuid | Oui | — | |

- **PK** `id`. **IX** `(customer_id, occurred_at)`. **Suppr.** `IMMUABLE`. **Offline** SRV.

## crm.visits

**Responsabilité** : visite physique d'un compte (CM §7, §10).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `customer_id` | uuid → customers | Non | — | |
| `user_id` | uuid → identity.users | Non | — | Visiteur |
| `work_session_id` | uuid → fieldwork.work_sessions | Oui | — | BR-CRM-013 |
| `customer_stage_at_visit` | enum | Non | — | Figé (KPI « prospects visités ») |
| `lat`, `lng`, `accuracy_m` | lat, lng, meters | Oui | — | |
| `distance_to_customer_m` | meters | Oui | — | Si le compte est géolocalisé |
| `outcome_reason_code_id` | uuid → catalog.reason_codes | Non | — | Résultat (`VISIT_OUTCOME`) |
| `notes` | text | Oui | — | |
| `next_action_at` | date | Oui | — | Prochaine action |
| `next_action_note` | text | Oui | — | |
| `flags` | text[] | Non | `{}` | `OUT_OF_SESSION`, `FAR_FROM_CUSTOMER`, `SESSION_REJECTED`, `CLOCK_SUSPECT` |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | SM-VISIT |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(user_id, occurred_at)`, `(customer_id, occurred_at)`, `(next_action_at)` partiel.
- **Suppr.** `ANNULATION`. **Audit** Création, annulation. **Offline** DL (90 jours du périmètre) ; CR.

## crm.interactions

**Responsabilité** : contact non physique hors Kommo (AV-019).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `customer_id` | uuid → customers | Non | — | |
| `user_id` | uuid → identity.users | Non | — | |
| `channel` | enum(`APPEL`,`SMS`,`EMAIL`,`AUTRE`) | Non | — | |
| `direction` | enum(`ENTRANT`,`SORTANT`) | Non | `SORTANT` | |
| `summary` | text | Oui | — | |
| `next_action_at`, `next_action_note` | date, text | Oui | — | |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **Suppr.** `ANNULATION`. **Offline** DL (90 j), CR.

## crm.sales_targets

**Responsabilité** : objectifs commerciaux (AV-016).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `target_type` | enum(`USER`,`TEAM`,`SITE`) | Non | — | |
| `user_id` / `team_id` / `site_id` | uuid | Oui | — | Exactement une selon le type |
| `metric` | enum(`CA`,`QTE_PRODUIT`,`NOUVEAUX_CLIENTS`,`VISITES`,`PROSPECTS_CREES`) | Non | — | |
| `product_id` | uuid → catalog.products | Oui | — | Requis si `QTE_PRODUIT` |
| `period_start`, `period_end` | date | Non | — | |
| `target_value` | DECIMAL(16,3) | Non | — | > 0 |
| `status` | enum(`ACTIVE`,`CANCELLED`) | Non | `ACTIVE` | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **Non-chevauchement** pour (cible, métrique, produit) actifs (BR-CRM-018) : verrouillage de ligne + déclencheur de re-vérification (MySQL, ADR-023).
- **Suppr.** `ANNULATION`. **Offline** DL (les siens et ceux de son équipe).

---

## fieldwork.geo_checkins

**Responsabilité** : chaque tentative de prise ou fin de service (CM §10, INV-TER-02).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → identity.users | Non | — | |
| `checkin_type` | enum(`START_SERVICE`,`END_SERVICE`) | Non | — | |
| `declared_zone_id` | uuid → organization.zones | Non | — | |
| `lat`, `lng` | lat, lng | Oui | — | Nuls si `NO_POSITION` |
| `accuracy_m` | meters | Oui | — | Précision fournie par l'appareil |
| `geofence_lat`, `geofence_lng`, `geofence_radius_m`, `max_accuracy_m` | | Oui | — | Géorepère figé (BR-ADM-013) |
| `distance_m` | meters | Oui | — | Distance calculée (serveur) |
| `client_result` | enum(`ACCEPTED`,`REJECTED_OUT_OF_ZONE`,`REJECTED_LOW_ACCURACY`,`NO_POSITION`) | Non | — | Résultat calculé sur l'appareil |
| `server_result` | enum(idem + `ZONE_INACTIVE`) | Non | — | Résultat de référence (BR-TER-003) |
| `result_divergence` | boolean | Non | false | |
| `work_session_id` | uuid → work_sessions | Oui | — | Session ouverte ou fermée |
| `suspicion_flags` | text[] | Non | `{}` | BR-TER-010 |
| [STD-ORIGIN] | | | | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(user_id, occurred_at)`.
- **Suppr.** `IMMUABLE` ; purge des coordonnées après 2 ans (AV-074, pseudonymisation par arrondi à 3 décimales).
- **Audit** Chaque tentative (y compris refusée). **Offline** CR.

## fieldwork.work_sessions

**Responsabilité** : session de travail terrain (SM-WORK-SESSION).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → identity.users | Non | — | |
| `device_id` | uuid → identity.devices | Non | — | |
| `declared_zone_id` | uuid → organization.zones | Non | — | |
| `started_at` | ts | Non | — | = `occurred_at` du pointage d'ouverture |
| `start_checkin_id` | uuid → geo_checkins | Non | — | |
| `ended_at` | ts | Oui | — | |
| `end_checkin_id` | uuid → geo_checkins | Oui | — | |
| `status` | enum(`OPEN`,`CLOSED`,`AUTO_CLOSED`) | Non | `OPEN` | |
| `close_cause` | enum(`END_SERVICE`,`SUPERSEDED`,`AUTO_2359`,`FORCED`) | Oui | — | |
| `override_status` | enum(`NOT_REQUIRED`,`PENDING`,`APPROVED`,`REJECTED`) | Non | `NOT_REQUIRED` | |
| `override_reason` | text | Oui | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** une session `OPEN` par `user_id` (index unique partiel, INV-TER-01).
- **IX** `(user_id, started_at)`.
- **Suppr.** `IMMUABLE` sauf transitions. **Audit** Ouverture, clôture, dérogation. **Offline** DL (sa session ouverte), CR.
