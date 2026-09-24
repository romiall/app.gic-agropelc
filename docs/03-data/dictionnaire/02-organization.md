# Dictionnaire — schéma `organization`

## organization.zones

**Responsabilité** : découpage géographique et commercial hiérarchique (ville, marché, quartier, secteur), utilisé pour la tarification, le portefeuille, l'analyse et le pointage (CM §9, §10, §29).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `parent_id` | uuid → zones | Oui | — | Zone parente |
| `level` | enum(`PAYS`,`REGION`,`VILLE`,`MARCHE`,`QUARTIER`,`SECTEUR`) | Non | — | Niveau (AV-003) |
| `code` | code | Non | — | |
| `name` | label | Non | — | |
| `depth` | smallint | Non | calculé | Profondeur (1 = racine utile), utilisée par la spécificité tarifaire |
| `geofence_lat` | lat | Oui | — | Point de référence du géorepère |
| `geofence_lng` | lng | Oui | — | |
| `geofence_radius_m` | meters | Oui | 500 | Rayon (CM §10) |
| `max_gps_accuracy_m` | meters | Oui | 150 | Précision maximale acceptée (AV-022) |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **FK** `parent_id`. **UQ** `code`.
- **CK** Latitude, longitude et rayon renseignés ensemble ou pas du tout ; rayon entre 50 et 5 000 ; pas de cycle (TX).
- **IX** `(parent_id)`.
- **Suppr.** `DESACTIVATION`. **Hist.** Géorepère figé sur chaque tentative de pointage (BR-ADM-013) ; modifications auditées.
- **Offline** DL : zones du périmètre de l'utilisateur, leurs ancêtres et leurs géorepères.
- **Recherche d'appartenance** (« la zone B est-elle sous la zone A ? ») : table de fermeture transitive `organization.zone_ancestors`, ci-dessous — remplace la colonne `path` + index GIN de la version PostgreSQL du cadrage (ADR-023, [`../../05-architecture/05-stack.md`](../../05-architecture/05-stack.md) §3.2).

## organization.zone_ancestors

**Responsabilité** : table de fermeture transitive de la hiérarchie des zones — un couple (zone, ancêtre) par ancêtre, y compris la zone elle-même (`depth = 0`). Maintenue par le gestionnaire de commande à la création ou au déplacement d'une zone.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `zone_id` | uuid → zones | Non | — | Zone descendante (ou elle-même) |
| `ancestor_id` | uuid → zones | Non | — | Ancêtre (ou la zone elle-même si `depth = 0`) |
| `depth` | smallint | Non | — | 0 = la zone elle-même ; 1 = parent direct ; etc. |

- **PK** `(zone_id, ancestor_id)`. **IX** `(ancestor_id)` (recherche des descendants d'une zone donnée).
- **Suppr.** Recalculée entièrement à chaque changement de parent d'une zone (déplacement rare).
- **Usage** : appartenance = `EXISTS (SELECT 1 FROM zone_ancestors WHERE zone_id = :b AND ancestor_id = :a)` ; descendants d'une zone = `SELECT zone_id FROM zone_ancestors WHERE ancestor_id = :a`.
- **Offline** DL : dérivée des zones téléchargées (reconstruite localement depuis `parent_id`, pas synchronisée en tant que telle).

## organization.sites

**Responsabilité** : lieu d'activité (ferme, magasin, PDV, bureau) (CM §12, §22, §57).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | varchar(10) | Non | — | Code court (numérotation des documents) |
| `name` | label | Non | — | |
| `site_type` | enum(`FERME`,`MAGASIN`,`POINT_DE_VENTE`,`BUREAU`) | Non | — | |
| `zone_id` | uuid → zones | Non | — | Zone du site |
| `address` | text | Oui | — | |
| `lat`, `lng` | lat, lng | Oui | — | Position |
| `status` | enum(`ACTIVE`,`CLOSED`) | Non | `ACTIVE` | BR-ADM-008 |
| `opened_on`, `closed_on` | date | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **CK** `closed_on` renseigné si et seulement si `CLOSED`.
- **Suppr.** `DESACTIVATION` (`CLOSED`). **Audit** Toute modification. **Offline** DL.

## organization.points_of_sale

**Responsabilité** : configuration d'un site de type `POINT_DE_VENTE` (CM §12).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `site_id` | uuid → sites | Non | — | PK et FK (extension 1:1 du site) |
| `sales_location_id` | uuid → locations | Non | — | Emplacement de vente par défaut (`POS`) |
| `replenishment_source_location_id` | uuid → locations | Oui | — | Magasin qui réapprovisionne par défaut |
| `custody_mode` | enum(`EXCLUSIVE_DEVICE`,`SHARED`) | Non | `EXCLUSIVE_DEVICE` | BR-DIS-002 |
| `designated_device_id` | uuid → identity.devices | Oui | — | Appareil désigné en mode exclusif |
| `opening_hours` | text | Oui | — | Informatif |
| [STD-AUDIT] | | | | |

- **PK** `site_id`. **CK** `designated_device_id` requis si `EXCLUSIVE_DEVICE` ; le site est de type `POINT_DE_VENTE` (TX).
- **Suppr.** Suit le site. **Audit** Toute modification (changement d'appareil désigné : BR-DIS-014). **Offline** DL (son PDV).
- Le compte de caisse du PDV se trouve dans `finance.cash_accounts` (`site_id`, type `CAISSE_PDV`) : pas de clé étrangère organization → finance.

## organization.locations

**Responsabilité** : emplacement où un stock peut exister, physique ou virtuel (glossaire §1, ADR-003).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `site_id` | uuid → sites | Oui | — | Nul pour un emplacement virtuel |
| `parent_location_id` | uuid → locations | Oui | — | Bâtiment d'une case |
| `code` | code | Non | — | Unique par site |
| `name` | label | Non | — | |
| `location_type` | enum(`STORE`,`POS`,`BUILDING`,`PEN`,`INCUBATOR`,`HATCHER`,`MOBILE`,`V_OPENING`,`V_SUPPLIER`,`V_CUSTOMER`,`V_PRODUCTION`,`V_CONSUMPTION`,`V_LOSS`,`V_PENDING_LOSS`,`V_ADJUSTMENT`,`V_TRANSIT`) | Non | — | |
| `is_virtual` | boolean | Non | calculé | Vrai pour les types `V_*` |
| `custody_mode` | enum(`EXCLUSIVE_USER`,`EXCLUSIVE_DEVICE`,`SHARED`) | Oui | — | Obligatoire pour les emplacements physiques (BR-STK-010) |
| `custodian_user_id` | uuid → identity.users | Oui | — | Détenteur d'un emplacement `MOBILE` |
| `designated_device_id` | uuid → identity.devices | Oui | — | Appareil désigné en `EXCLUSIVE_DEVICE` |
| `capacity` | int | Oui | — | Capacité d'un bâtiment ou d'une case (têtes), informative |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(site_id, code)` ; un seul emplacement actif par type virtuel ; un seul `MOBILE` actif par `custodian_user_id` (INV-ADM-05).
- **CK** Virtuel ⇔ `site_id` nul ; `MOBILE` ⇒ `custodian_user_id` non nul et `custody_mode = EXCLUSIVE_USER` ; `EXCLUSIVE_DEVICE` ⇒ `designated_device_id` non nul ; `PEN` ⇒ parent de type `BUILDING`.
- **IX** `(site_id, location_type)`, `(custodian_user_id)`.
- **Suppr.** `DESACTIVATION` sous condition (BR-ADM-011, INV-STK-07). Les virtuels ne sont jamais désactivés.
- **Audit** Création, modification, désactivation, changement de détenteur ou d'appareil. **Offline** DL (emplacements du périmètre et virtuels).

## organization.teams

**Responsabilité** : équipe commerciale et son responsable (CM §6, §48).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | |
| `name` | label | Non | — | |
| `manager_user_id` | uuid → identity.users | Non | — | Responsable commercial |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL (son équipe).

## organization.team_memberships

**Responsabilité** : appartenance datée d'un utilisateur à une équipe.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `team_id` | uuid → teams | Non | — | |
| `user_id` | uuid → identity.users | Non | — | |
| `valid_from` | ts | Non | — | |
| `valid_to` | ts | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **Non-chevauchement** : pas deux appartenances d'un même utilisateur qui se chevauchent, conformément à BR-ADM-014 — verrouillage de ligne (`SELECT … FOR UPDATE`) sur les appartenances existantes de l'utilisateur dans le gestionnaire de commande + déclencheur `BEFORE INSERT/UPDATE` de re-vérification (MySQL, ADR-023 ; équivalent PostgreSQL : `EXCLUDE USING gist`).
- **Suppr.** `IMMUABLE` sauf fermeture. **Hist.** La table est l'historique. **Offline** DL (son équipe).

## organization.system_settings

**Responsabilité** : paramètres de configuration historisés (seuils, délais, rayons, plafonds).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `key` | varchar(100) | Non | — | Ex. `crm.visit.max_distance_m`, `pricing.max_discount_pct.VENDEUR_PDV` |
| `value` | json | Non | — | Valeur typée |
| `scope_type` | enum(`GLOBAL`,`SITE`,`ZONE`,`ROLE`) | Non | `GLOBAL` | Portée de la valeur |
| `scope_id` | uuid | Oui | — | Cible si non globale |
| `valid_from` | ts | Non | `now()` | Date d'effet |
| `is_client_visible` | boolean | Non | false | Téléchargé sur les appareils |
| `created_at`, `created_by` | ts, uuid | Non | — | |
| `reason` | text | Oui | — | Motif de la modification |

- **PK** `id`. **UQ** `(key, scope_type, scope_id, valid_from)`.
- **Suppr.** `VERSIONNEMENT` : une nouvelle ligne par changement ; valeur en vigueur = dernière `valid_from` ≤ t (BR-ADM-015).
- **Audit** Toute nouvelle valeur. **Offline** DL (paramètres `is_client_visible`).

Catalogue initial des clés (valeurs par défaut, références AV) :

| Clé | Défaut | Réf. |
|---|---|---|
| `fieldwork.geofence_radius_m` | 500 | CM §10, AV-022 |
| `fieldwork.max_gps_accuracy_m` | 150 | AV-022 |
| `fieldwork.override_min_attempts` / `override_min_minutes` | 3 / 2 | AV-021 |
| `offline.max_autonomy_hours` / `warning_hours` | 168 / 48 | AV-009 |
| `sync.clock_skew_flag_minutes` | 5 | BR-SYN-011 |
| `sync.backdate_max_hours` / `justification_after_hours` | 72 / 24 | AV-078 |
| `crm.inactive_after_days` | 30 | AV-013 |
| `crm.visit.max_distance_m` | 500 | BR-CRM-015 |
| `sales.direct_cancel_minutes` | 15 | AV-030 |
| `sales.default_payment_terms_days` | 30 | AV-028 |
| `pricing.max_discount_pct.<ROLE>` | 0 / 5 / 15 | AV-026 |
| `pricing.stale_rules_hours` | 24 | AV-063 |
| `finance.cash_holding_max_xaf` | 200 000 | D09 §14 |
| `finance.supplier_payment_approval_xaf` | 500 000 | AV-055 |
| `procurement.po_approval_threshold_xaf` | 500 000 | AV-051 |
| `inventory.count_approval_threshold_xaf` | 25 000 | AV-039 |
| `inventory.transfer_unmatched_hours` | 48 | BR-STK-024 |
| `analytics.freshness_warning_hours` | 2 | BR-ANA-005 |
