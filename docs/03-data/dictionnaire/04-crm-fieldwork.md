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

- **UQ** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL — jeu `catalog`, ligne `GLOBAL` (P5-18, AV-196) : `PIPELINE_STEP` (republiée par `crm.pipeline.configure`), `LEAD_SOURCE` (semées, publiées par le seed), `SALES_CHANNEL` (clé dérivée du code, ADR-031) ; les catégories de client restent sur le repli. Canaux système (`is_system`, colonne absente de `catalog.sales_channels`) : `POINT_DE_VENTE`, `TERRAIN`, `SEDENTAIRE`, `DIRECT`, désactivation refusée `SYSTEM_REFERENCE` (liste `SYSTEM_SALES_CHANNEL_CODES`, P5-18). **Catégories de client semées** (MP-02, AV-017) : `PARTICULIER`, `REVENDEUR`, `RESTAURATION_HOTELLERIE`, `GROSSISTE`, `INSTITUTION`, codes absents seulement, publiées dans le jeu `customer_category` (celui du repli générique de leurs commandes).

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
| `duplicate_of_id` | uuid → customers | Oui | — | DÉDUIT (P3-02) : prospect créé hors ligne avec le téléphone d'un compte existant — fait accompli enregistré (BR-SYN-007), rattaché au compte existant et exclu de l'unicité du téléphone jusqu'à la fusion (conflit `DUPLICATE_CUSTOMER`, BR-CRM-006) |
| `credit_allowed` | boolean | Non | false | AV-028 |
| `credit_limit_xaf` | money_xaf | Oui | — | |
| `payment_terms_days` | smallint | Oui | — | Défaut : paramètre système |
| `interest_product_id` | uuid → catalog.products | Oui | — | Profil commercial (PP-D ; AV-316) : produit qui intéresse le client |
| `potential_qty_per_day` | numeric(14,3) | Oui | — | Profil commercial : quantité qu'il peut écouler par jour (≥ 0), avec `potential_unit_code` |
| `potential_unit_code` | varchar(20) | Oui | — | Unité du potentiel (code du catalogue) ; requise si le potentiel est renseigné |
| `usual_payment_method_code` | varchar(40) | Oui | — | Moyen de paiement habituel, **à titre indicatif** (pas de FK : `crm` ne lit pas la table de `finance`) |
| `credit_requested` | boolean | Non | false | Demande de paiement différé du commercial, **distincte** de `credit_allowed` (décision du responsable, AV-028) |
| `last_sale_at` | ts | Oui | — | Dénormalisé (actif / inactif, KPI) |
| `field_versions` | json | Non | `{}` | DÉDUIT (P3-02), donnée technique : dernière écriture (`version`, `occurred_at`, et `deviceId` : l'appareil de la commande, depuis le 04/11/2026) de chaque champ modifiable, pour la fusion champ par champ d'un compte modifié sur deux appareils (matrice des conflits ; `mergeFieldPatch`, `packages/domain`) : un appareil ne se heurte jamais à sa propre écriture. Rendue en chaîne de caractères par MariaDB, en objet par MySQL : les deux se lisent |
| `kommo_contact_ref` | — | — | — | *(absent : dans `integrations.external_links`)* |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **FK** vers les référentiels, zones, utilisateurs et sites.
- **UQ** `phone_primary` parmi `stage <> 'MERGED'` et hors doublons en attente de fusion (`duplicate_of_id` nul) — colonne générée `phone_key` (INV-CRM-03) ; `command_id`.
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
| `created_at` | ts | Non | `now()` | Application serveur |

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

## crm.visit_market_watch

**Responsabilité** : veille marché relevée pendant une visite (PP-D ; REQ-308, AV-315) — le fournisseur ou le concurrent rencontré et le prix constaté d'un produit, un relevé par ligne, plusieurs par visite. Table fille de `crm.visits` ; ajout seul comme la visite (BR-CRM-016) : une visite annulée garde ses relevés. Migration `20261104100000_create_crm_visit_market_watch.sql`.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | uuid | Non | — | Choisi par le serveur |
| `visit_id` | uuid → crm.visits | Non | — | |
| `position_no` | smallint | Non | — | Ordre sur la fiche (1, 2…), unique par visite |
| `watch_type` | enum(`SUPPLIER`,`COMPETITOR`) | Non | — | De qui vient le prix |
| `source_name` | varchar(120) | Non | — | Libellé libre (pas de référentiel de concurrents, AV-315) |
| `product_id` | uuid → catalog.products | Oui | — | Produit constaté |
| `unit_code` | varchar(20) | Oui | — | Unité du prix constaté |
| `observed_price_xaf` | bigint | Oui | — | Francs entiers, ≥ 0 |
| `created_at`, `created_by` | | Non | — | |

- **PK** `id`. **UQ** `(visit_id, position_no)`. **IX** `(product_id)`. **Suppr.** `IMMUABLE` (déclencheurs de refus de la modification et de la suppression). **Offline** DL avec la visite (`crm_activity`, ligne `VISIT`, clé `market_watch`) ; CR par la commande `crm.visit.record` (`marketWatch`, 20 relevés au plus).

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

## crm.weekly_reports

**Responsabilité** : bilan hebdomadaire du commercial (PP-E ; REQ-307, AV-314, [ADR-056](../../decisions/ADR-056-presence-du-personnel-et-bilan-hebdomadaire.md)) — un bilan par commercial et par semaine (lundi au dimanche, jours métier de Douala) : réussites, difficultés, besoins et demandes à la direction, priorités de la semaine suivante, informations du marché ; le « vu » du responsable et son commentaire. **Les chiffres de la fiche papier BH** (visites, nouveaux prospects et clients, chiffre d'affaires, encaissé, casses et pertes) **ne sont pas stockés** : `GET /api/v1/weekly-reports/figures` les calcule à la lecture avec les définitions déjà publiées. Migration `20261104130000_create_crm_weekly_reports.sql`.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Identifiant dérivé du couple (commercial, semaine) : renvoyer le bilan est une correction |
| `user_id` | uuid → identity.users | Non | — | Le commercial auteur |
| `week_start` | date | Non | — | Lundi de la semaine (contrôle `DAYOFWEEK`) |
| `successes`, `difficulties`, `needs`, `priorities`, `market_info` | text | Oui | — | Cinq textes de 2 000 caractères au plus ; au moins un est renseigné |
| `status` | enum(`SUBMITTED`,`REVIEWED`) | Non | `SUBMITTED` | `REVIEWED` : vu par le responsable, textes figés |
| `last_edited_at` | ts | Non | — | `occurred_at` du dernier envoi retenu (le plus récent l'emporte) |
| `reviewed_at`, `reviewed_by` | ts, uuid → identity.users | Oui | — | Renseignés si et seulement si `REVIEWED` |
| `manager_comment` | text | Oui | — | Commentaire du responsable ; nul tant que le bilan n'est pas vu |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`, `(user_id, week_start)`. **IX** `(week_start)`.
- **Suppr.** `IMMUABLE` : déclencheur de refus de la suppression ; le commercial et la semaine ne changent jamais ; une fois `REVIEWED`, déclencheurs de refus de la modification des textes et du retour à `SUBMITTED`. **Audit** Envoi, correction (textes d'avant et d'après), revue. **Offline** CR (outbox : `crm.weekly_report.submit`) ; lecture en ligne seulement (aucun jeu hors ligne : AV-514).

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
| `start_checkin_id` | uuid (réf. sans FK) | Non | — | Tentative d'ouverture. Sans clé étrangère : référence circulaire avec `geo_checkins.work_session_id`, MySQL ne différant pas la vérification des clés (la session est insérée d'abord) — vérifiée par le gestionnaire |
| `ended_at` | ts | Oui | — | |
| `end_checkin_id` | uuid (réf. sans FK) | Oui | — | Tentative de fin (même raison) |
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

## fieldwork.presence_sheets

**Responsabilité** : feuille de présence du personnel reportée depuis la fiche papier PT (PP-E ; REQ-306, AV-313, [ADR-056](../../decisions/ADR-056-presence-du-personnel-et-bilan-hebdomadaire.md)) — site, semaine (lundi), numéro de la feuille papier et responsable. Le pointage numérique (`fieldwork.work_sessions`) ne couvre que les commerciaux de terrain : ces feuilles couvrent les ouvriers et le personnel administratif, qui n'ont pas tous un compte. Usage statistique et de suivi, ni paie ni discipline. Migration `20261104120000_create_fieldwork_staff_presence.sql`.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Identifiant choisi par l'appareil (agrégat `PRESENCE_SHEET`) |
| `site_id` | uuid → organization.sites | Non | — | Portée de saisie et de lecture |
| `week_start` | date | Non | — | Lundi de la semaine (contrôle `DAYOFWEEK`) |
| `paper_ref` | varchar(30) | Oui | — | Numéro de la feuille papier |
| `responsible_name` | varchar(120) | Oui | — | Responsable qui a tenu la feuille |
| `source` | enum(`PAPER`) | Non | `PAPER` | |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | Annulation motivée (`cancel_comment` obligatoire) |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(site_id, week_start)`.
- **Suppr.** `ANNULATION` : déclencheur de refus de toute modification autre que l'annulation motivée, et de toute modification d'une feuille annulée, qui ne redevient pas `RECORDED` (corriger une feuille, c'est l'annuler puis la reporter de nouveau, règle 4), et de la suppression. **Audit** Report, annulation. **Offline** CR (outbox : `fieldwork.presence.record` et `.cancel`) ; lecture en ligne seulement (AV-514).

## fieldwork.staff_presence

**Responsabilité** : une ligne par personne et par jour d'une feuille de présence (PP-E ; REQ-306, AV-313). Un jour s'écrit en heures (arrivée, départ) **ou** par un code d'absence, jamais les deux ; un départ suppose une arrivée. Ces lignes ne sont pas des sessions de travail : elles n'entrent ni dans le pointage numérique ni dans `analytics.f_attendance` (aucun jour de présence d'un commercial n'est compté deux fois).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | uuid | Non | — | Choisi par le serveur |
| `sheet_id` | uuid → fieldwork.presence_sheets | Non | — | |
| `line_no` | smallint | Non | — | Ligne de la feuille (une personne par ligne, 50 au plus) |
| `presence_date` | date | Non | — | Jour de la semaine de la feuille |
| `person_name` | varchar(120) | Non | — | Libellé libre |
| `person_role` | varchar(80) | Oui | — | Fonction |
| `mission_label` | varchar(80) | Oui | — | Zone ou mission |
| `user_id` | uuid → identity.users | Oui | — | Compte lié, facultatif (ni l'écran ni le chargement ne le renseignent : AV-514) |
| `arrival_time`, `departure_time` | time | Oui | — | Heures métier de Douala |
| `absence_code` | enum(`A`,`M`,`C`,`R`,`MI`) | Oui | — | Absent, maladie, congé, repos, mission hors zone |
| `created_at`, `created_by` | | Non | — | |

- **PK** `id`. **UQ** `(sheet_id, line_no, presence_date)`. **IX** `(presence_date)`, `(user_id, presence_date)`.
- **Suppr.** `IMMUABLE` (déclencheurs de refus de la modification et de la suppression). **Offline** CR avec la feuille.
