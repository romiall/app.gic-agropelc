# Dictionnaire — schéma `identity`

## identity.users

**Responsabilité** : compte nominatif d'une personne. Source des acteurs de toutes les opérations (dimension responsabilité, CM §5.3).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `full_name` | label | Non | — | Nom affiché |
| `phone` | phone | Non | — | Identifiant de connexion (BR-ADM-001) |
| `email` | varchar(200) | Oui | — | Contact optionnel |
| `password_hash` | text | Non | — | Hachage argon2id du mot de passe |
| `must_change_password` | boolean | Non | true | Forcer le changement à la première connexion |
| `status` | enum(`ACTIVE`,`SUSPENDED`,`DEACTIVATED`) | Non | `ACTIVE` | SM-USER |
| `status_changed_at` | ts | Oui | — | Date d'effet du dernier changement de statut (sert à BR-ADM-002) |
| `status_reason` | text | Oui | — | Motif de suspension ou désactivation |
| `primary_device_id` | uuid → devices | Oui | — | Appareil principal (stock mobile, BR-STK-016) |
| `locale` | varchar(10) | Non | `fr-CM` | Langue (AV-079) |
| `is_system` | boolean | Non | false | Vrai pour l'utilisateur technique `system` |
| `last_login_at` | ts | Oui | — | Dernière authentification |
| [STD-AUDIT] | | | | |

- **PK** `id`. **FK** `primary_device_id` → `identity.devices(id)` (différée, pour gérer la création croisée).
- **UQ** `phone` parmi `status <> 'DEACTIVATED'` (index unique partiel).
- **CK** `phone` au format E.164 ; `status_reason` requis si `status <> 'ACTIVE'`.
- **IX** `(status)`.
- **Suppr.** `DESACTIVATION` (jamais de suppression : l'utilisateur est l'acteur d'opérations passées).
- **Hist.** Changements de statut, téléphone et nom dans l'audit (avant et après).
- **Audit** Création, modification, suspension, désactivation, réactivation, réinitialisation de mot de passe.
- **Offline** L'appareil télécharge son propre profil et les noms (id, `full_name`) des utilisateurs de son périmètre, pour l'affichage.
- **Intégrité** INV-ADM-01 (au moins un `ADMIN` actif) ; `password_hash` jamais exposé ni journalisé (INV-AUD-02).

## identity.roles

**Responsabilité** : rôle métier (CM §47). Donnée configurable (ADR-008).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | `DIRECTION`, `ADMIN`, `RESP_COMMERCIAL`, … |
| `name` | label | Non | — | Libellé |
| `description` | text | Oui | — | |
| `allowed_scope_types` | text[] | Non | `{GLOBAL}` | Types de périmètre autorisés à l'affectation (`GLOBAL`, `SITE`, `ZONE`, `TEAM`) |
| `is_system` | boolean | Non | false | Rôle livré avec le système (non supprimable) |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **CK** `code` en `UPPER_SNAKE_CASE`.
- **Suppr.** `DESACTIVATION`. **Audit** Toute modification. **Offline** DL.

## identity.permissions

**Responsabilité** : catalogue des permissions élémentaires (livré par le code, synchronisé à chaque déploiement).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `code` | varchar(80) | Non | — | PK, ex. `sales.sale.record` |
| `module` | code | Non | — | Module concerné |
| `description` | text | Non | — | Libellé |
| `supported_scopes` | text[] | Non | — | Portées applicables (`OWN`, `TEAM`, `SITE`, `ZONE`, `ALL`) |
| `is_approval` | boolean | Non | false | Permission d'approbation |
| `is_sensitive` | boolean | Non | false | Déclenche un audit renforcé et une revue d'attribution |

- **PK** `code`. **Suppr.** Une permission retirée du code est marquée obsolète (colonne `deprecated_at`), jamais supprimée. **Offline** DL.

## identity.role_permissions

**Responsabilité** : permissions accordées à un rôle, avec portée maximale.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `role_id` | uuid → roles | Non | — | |
| `permission_code` | varchar(80) → permissions | Non | — | |
| `max_scope` | enum(`OWN`,`TEAM`,`SITE`,`ZONE`,`ALL`) | Non | — | Portée maximale (PM §31) |
| `limits` | jsonb | Oui | — | Limites paramétriques, ex. `{"max_discount_pct": 5}` |
| `granted_at` | ts | Non | `now()` | |
| `granted_by` | uuid → users | Non | — | |

- **PK** `(role_id, permission_code)`. **CK** `max_scope` ∈ `permissions.supported_scopes` (contrôle TX).
- **Suppr.** Retrait autorisé (liaison de configuration). Chaque retrait est **audité** avec l'état avant, ce qui historise la configuration des droits.
- **Offline** DL.

## identity.user_role_assignments

**Responsabilité** : affectation d'un rôle à un utilisateur sur un périmètre et une période (rôles multiples, CM §6).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → users | Non | — | |
| `role_id` | uuid → roles | Non | — | |
| `scope_type` | enum(`GLOBAL`,`SITE`,`ZONE`,`TEAM`) | Non | `GLOBAL` | Type de périmètre |
| `scope_site_id` | uuid → organization.sites | Oui | — | Si `SITE` |
| `scope_zone_id` | uuid → organization.zones | Oui | — | Si `ZONE` (inclut les sous-zones) |
| `scope_team_id` | uuid → organization.teams | Oui | — | Si `TEAM` |
| `valid_from` | ts | Non | `now()` | Début |
| `valid_to` | ts | Oui | — | Fin prévue |
| `revoked_at` | ts | Oui | — | Révocation |
| `revoked_by` | uuid → users | Oui | — | |
| `revoke_reason` | text | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`.
- **CK** Exactement une colonne de périmètre renseignée, cohérente avec `scope_type` (aucune si `GLOBAL`) ; `valid_to > valid_from` ; `scope_type` ∈ `roles.allowed_scope_types`.
- **IX** `(user_id, valid_from, valid_to)`, `(role_id)`.
- **Suppr.** `IMMUABLE` sauf fermeture (`valid_to`, `revoked_*`) (INV-ADM-04).
- **Hist.** La table **est** l'historique des droits.
- **Audit** Octroi, révocation. **Offline** DL (ses propres affectations).
- **Intégrité** Droits effectifs à `t` = affectations avec `valid_from ≤ t < coalesce(revoked_at, valid_to, ∞)` (BR-ADM-004).

## identity.devices

**Responsabilité** : appareil enrôlé (CM §5.3 « appareil » ; PM §37 « appareils autorisés »).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Généré par l'appareil à l'installation |
| `short_code` | varchar(4) | Non | attribué | Code court des références locales (BR-ADM-007) |
| `label` | label | Oui | — | Nom lisible (« Tablette PDV Mboppi ») |
| `enrolled_by_user_id` | uuid → users | Non | — | Utilisateur de l'enrôlement |
| `status` | enum(`PENDING`,`ACTIVE`,`BLOCKED`,`LOST`,`RETIRED`) | Non | `PENDING` | SM-DEVICE |
| `status_changed_at` | ts | Non | `now()` | Date d'effet (quarantaine, BR-ADM-006) |
| `status_reason` | text | Oui | — | |
| `approved_by` | uuid → users | Oui | — | |
| `platform` | varchar(100) | Oui | — | Système, navigateur, version (déclaratif) |
| `app_version` | varchar(20) | Oui | — | Version de la PWA au dernier contact |
| `is_shared` | boolean | Non | false | Appareil partagé (AV-007) |
| `designated_site_id` | uuid → organization.sites | Oui | — | Site de rattachement d'un appareil de PDV ou de ferme |
| `last_seen_at` | ts | Oui | — | Dernier contact serveur |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `short_code`.
- **CK** `approved_by` requis si `status = 'ACTIVE'`.
- **IX** `(status)`, `(enrolled_by_user_id)`.
- **Suppr.** `DESACTIVATION` (`RETIRED`) ; `short_code` jamais réattribué.
- **Audit** Enrôlement, approbation, blocage, déblocage, perte, retrait. **Offline** DL (son propre enregistrement).
- **Intégrité** INV-ADM-03.

## identity.auth_sessions

**Responsabilité** : session d'authentification d'un utilisateur sur un appareil ; jetons de rafraîchissement et autonomie hors ligne.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → users | Non | — | |
| `device_id` | uuid → devices | Non | — | |
| `refresh_token_hash` | text | Non | — | SHA-256 du jeton de rafraîchissement opaque (rotation à chaque usage) |
| `token_family_id` | uuid | Non | — | Famille de rotation (détection de réutilisation) |
| `created_at` | ts | Non | `now()` | |
| `last_used_at` | ts | Non | `now()` | |
| `expires_at` | ts | Non | — | Expiration du jeton de rafraîchissement (30 jours glissants) |
| `offline_grant_until` | ts | Non | — | Fin de l'autonomie hors ligne accordée (AV-009) |
| `revoked_at` | ts | Oui | — | |
| `revoked_reason` | enum(`LOGOUT`,`ADMIN`,`USER_DEACTIVATED`,`DEVICE_BLOCKED`,`TOKEN_REUSE`,`EXPIRED`) | Oui | — | |
| `ip_first`, `ip_last` | inet | Oui | — | Adresses de création et de dernier usage |

- **PK** `id`. **UQ** `refresh_token_hash`.
- **IX** `(user_id, device_id)`, `(expires_at)`.
- **Suppr.** `PURGE_TECHNIQUE` 90 jours après expiration ou révocation (les événements d'authentification restent dans l'audit).
- **Audit** Création (connexion), révocation, détection de réutilisation. **Offline** SRV (l'appareil conserve ses jetons dans un stockage local protégé).
