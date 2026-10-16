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
| `geofence_radius_m` | meters | Oui | paramètre `fieldwork.geofence_radius_m` (applicatif) | Rayon (CM §10, AV-022) |
| `max_gps_accuracy_m` | meters | Oui | 150 | Précision maximale acceptée (AV-022) |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **FK** `parent_id`. **UQ** `code`.
- **CK** Latitude, longitude et rayon renseignés ensemble ou pas du tout ; rayon entre 50 et 5 000 ; pas de cycle (TX). Le défaut de `geofence_radius_m` est appliqué **côté application** à la construction d'un géorepère (création ou modification de la zone) : paramètre `fieldwork.geofence_radius_m` en vigueur (500 au seed), à défaut la constante de `packages/domain` — pas comme `DEFAULT` de colonne : un défaut de colonne s'appliquerait aussi quand aucun géorepère n'est fourni (`geofence_lat`/`geofence_lng` nuls), ce qui violerait la contrainte « ensemble ou pas du tout ». Le géorepère est modifiable ou retirable (`organization.zone.update`, P3-09) ; l'ancien reste lisible dans l'audit (avant / après), et chaque tentative de pointage fige celui qu'elle a utilisé.
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
- **Lecture (P5-17)** : `GET /sites` (filtres `site_type`, `status`, `zone_id` ; droit `org.structure.read`, portée du site et de sa zone, AV-189) ; lectures publiques `listSites`, `findSite`.

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
- **Écriture** (P5-05, ADR-033 §2, INV-DIS-01) : `organization.pos.configure` est la seule commande qui l'écrit, par upsert (rejouer la même configuration est sans effet). Elle refuse (`POS_CONFIG_INVALID`) un emplacement de vente qui n'est pas un `POS` actif de ce site ou qui appartient à un autre PDV, un magasin source qui n'est pas un `STORE` actif d'un *autre* site, un appareil non actif ou déjà désigné pour un autre PDV. `SHARED` ne désigne aucun appareil. **Dans la même transaction**, le mode et l'appareil désigné sont reportés sur l'emplacement de vente (`organization.locations`), seule source lue par le stock, les ventes et la synchronisation. Changer ou retirer l'appareil désigné est refusé (`POS_DEVICE_CHANGE_BLOCKED`, BR-DIS-014) tant que l'ancien appareil déclare des opérations en attente (`sync.device_sync_state`, ligne `_device`, `pending_reported` > 0) ; l'appareil bloqué, perdu ou retiré ne retient plus personne, et un appareil qui n'a encore rien envoyé n'a rien déclaré (DÉDUIT : la correction d'une désignation faite par erreur reste possible).
- **Suppr.** Suit le site. **Audit** Toute modification (changement d'appareil désigné : BR-DIS-014). **Offline** DL (son PDV) — jeu `org` (P5-18, AV-195) : `POINT_OF_SALE` (clé = le site), ligne `SITE` du PDV, republié à chaque configuration avec l'emplacement de vente (`LOCATION`, mode de garde et appareil désigné) ; un changement d'appareil désigné arrive par cette mise à jour, sans sortie de périmètre.
- **Lecture (P5-17)** : `GET /points-of-sale` (filtre `site_id` ; droit `org.structure.read`, portée du site et de sa zone, AV-189) ; lecture publique `listPointsOfSale`. La couche de transport y ajoute l'identifiant de la caisse `CAISSE_PDV` active du site et celui de sa session ouverte, sans aucun montant.
- Le compte de caisse du PDV se trouve dans `finance.cash_accounts` (`site_id`, type `CAISSE_PDV`) : pas de clé étrangère organization → finance.

## organization.locations

**Responsabilité** : emplacement où un stock peut exister, physique ou virtuel (glossaire §1, ADR-003, ADR-028 §1).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `site_id` | uuid → sites | Oui | — | Nul pour un emplacement virtuel global (les neuf types `V_*` sauf `V_TO_DELIVER`) ; renseigné pour un emplacement physique **et** pour l'emplacement « à livrer » `V_TO_DELIVER` (P4-02, ADR-028 §1) |
| `parent_location_id` | uuid → locations | Oui | — | Bâtiment d'une case |
| `code` | code | Non | — | Unique par site |
| `name` | label | Non | — | |
| `location_type` | enum(`STORE`,`POS`,`BUILDING`,`PEN`,`INCUBATOR`,`HATCHER`,`MOBILE`,`SLAUGHTERHOUSE`,`V_OPENING`,`V_SUPPLIER`,`V_CUSTOMER`,`V_PRODUCTION`,`V_CONSUMPTION`,`V_LOSS`,`V_PENDING_LOSS`,`V_ADJUSTMENT`,`V_TRANSIT`,`V_TO_DELIVER`) | Non | — | `SLAUGHTERHOUSE` (abattoir de la ferme, AV-101) ajouté en P7-02 ; `V_TO_DELIVER` (« vendu, à livrer », un par site) ajouté en P4-02 (ADR-028 §1) |
| `is_virtual` | boolean | Non | calculé | Vrai pour les types `V_*`, y compris `V_TO_DELIVER` (colonne générée stockée, étendue en P4-02) |
| `custody_mode` | enum(`EXCLUSIVE_USER`,`EXCLUSIVE_DEVICE`,`SHARED`) | Oui | — | Obligatoire pour les emplacements physiques (BR-STK-010) |
| `custodian_user_id` | uuid → identity.users | Oui | — | Détenteur d'un emplacement `MOBILE` |
| `designated_device_id` | uuid → identity.devices | Oui | — | Appareil désigné en `EXCLUSIVE_DEVICE` |
| `capacity` | int | Oui | — | Capacité d'un bâtiment ou d'une case (têtes), informative |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(site_id, code)` ; un seul emplacement actif par type virtuel **global** (colonne générée `active_virtual_type`, inchangée : elle ne porte que les neuf types `V_OPENING`, `V_SUPPLIER`, `V_CUSTOMER`, `V_PRODUCTION`, `V_CONSUMPTION`, `V_LOSS`, `V_PENDING_LOSS`, `V_ADJUSTMENT`, `V_TRANSIT` ; elle est nulle pour `V_TO_DELIVER`) ; **un seul `V_TO_DELIVER` actif par site** (colonne générée stockée `active_to_deliver_site` = `site_id` si `location_type = V_TO_DELIVER` et `status = ACTIVE`, nulle sinon, avec un `UNIQUE` : index unique partiel émulé, ADR-023, P4-02) ; un seul `MOBILE` actif par `custodian_user_id` (INV-ADM-05).
- **CK** Mode de garde obligatoire (P5-05, AV-163) : `ck_organization_locations_custody_required` refuse un emplacement physique sans mode ; le déclencheur `trg_organization_locations_custody_default` remplit, à l'insertion, le défaut du type (`MOBILE` : `EXCLUSIVE_USER` ; tout autre emplacement physique : `SHARED`). Les commandes écrivent déjà le mode explicitement ; le déclencheur et le `CHECK` ne sont qu'un filet. Un emplacement virtuel n'a pas de mode. Un emplacement virtuel global (`is_virtual` et type différent de `V_TO_DELIVER`) a un `site_id` nul ; un emplacement physique a un `site_id` non nul ; `V_TO_DELIVER` exige un `site_id` non nul. Le `CHECK` `ck_organization_locations_virtual_site` a été modifié en P4-02 pour cette exception à l'ancienne règle « virtuel ⇔ `site_id` nul » (nom conservé, BR-ADM-010 amendée). `MOBILE` ⇒ `custodian_user_id` non nul et `custody_mode = EXCLUSIVE_USER` ; `EXCLUSIVE_DEVICE` ⇒ `designated_device_id` non nul ; `PEN` ⇒ parent de type `BUILDING`. Le `CHECK` de liste `ck_organization_locations_type` porte les dix-huit types, dont `V_TO_DELIVER`.
- **IX** `(site_id, location_type)`, `(custodian_user_id)`.
- **Suppr.** `DESACTIVATION` sous condition (BR-ADM-011, INV-STK-07). Les virtuels, `V_TO_DELIVER` compris, ne sont jamais désactivés. `organization.location.deactivate` refuse l'emplacement de vente d'un PDV configuré (`LOCATION_IS_POS_SALES_LOCATION`, BR-DIS-001), puis consulte le **registre de gardes** (P5-05) où chaque module propriétaire d'une donnée enregistre la sienne (inversion de dépendance, comme les décisions d'approbation) : `inventory` refuse un solde non nul (`LOCATION_NOT_EMPTY`), un quota d'appareil actif (`LOCATION_HAS_ALLOCATIONS`) ou un transfert ouvert (`LOCATION_HAS_OPEN_TRANSFER` : demandé, expédié, écart à trancher, non rapproché) ; `finance` (P5-12) refuse l'emplacement de vente (`POS`) d'un site dont la caisse de PDV a une session de caisse ouverte (`LOCATION_HAS_OPEN_CASH_SESSION`, sessions lues en verrou partagé) — limite connue : un site sans emplacement `POS` actif ne consulte pas cette garde à sa fermeture. `organization.site.close` consulte les mêmes gardes pour chacun des emplacements actifs du site (« à livrer » compris).
- **Audit** Création, modification, désactivation, changement de détenteur ou d'appareil. **Offline** DL (emplacements du périmètre et virtuels globaux ; l'emplacement « à livrer » suit son site, DÉDUIT de son rattachement à un site) — jeu du repli `location` (ligne `GLOBAL`) ; P5-18 : l'emplacement de vente est republié par `organization.pos.configure`, les emplacements virtuels globaux semés par le seed (`db/seeds/publish-references.ts`) ; les emplacements « à livrer », créés à la demande, ne sont pas publiés (AV-196).
- **Lecture (P5-17)** : `GET /locations?site_id=` (site obligatoire ; filtres `status`, `location_type` ; droit `org.structure.read`, portée du site, AV-189) ; lecture publique `listLocations`.
- **Emplacement « à livrer » `V_TO_DELIVER`** (P4-02, ADR-028 §1, ADR-029) :
  - *Rôle* (ADR-028 §1, DÉDUIT dans l'ADR) : un emplacement virtuel **par site**, où la marchandise d'une commande confirmée attend sa livraison. Virtuel, il n'est ni vendable, ni compté dans le disponible, ni dans l'effectif non vendu d'un lot, ni dans un inventaire du magasin.
  - *Création* (ADR-028 §1) : par le système, à la première confirmation sur le site. Elle ne vient ni du seed de démarrage, qui ne porte que les neuf types globaux (BR-ADM-010), ni de `organization.location.create`, qui ne crée que des types physiques.
  - *Immuabilité* (DÉDUIT) : `is_virtual` étant vrai, les commandes `organization.location.update` et `.deactivate` le refusent (`LOCATION_VIRTUAL_IMMUTABLE`), comme tout virtuel.
  - *Mode de garde* (DÉDUIT) : `custody_mode` reste nul (obligatoire pour les seuls emplacements physiques, BR-STK-010 ; le `CHECK` `ck_organization_locations_custody_required` (P5-05) exempte tout virtuel).
  - *Solde* : jamais négatif, par site, produit et lot, en quantité et en valeur (INV-STK-18) ; les mouvements qui le soldent sont plafonnés en base par leur origine (INV-STK-17, ADR-029).

## organization.location_custody_periods

**Responsabilité** : historique de la garde d'un emplacement (P5-23, ADR-040, AV-195 (2)) : un fait hors ligne se juge sur la garde en vigueur à son `occurred_at` (`custodyAt`, API publique), pas sur la garde courante.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `location_id` | uuid → locations | Non | — | |
| `custody_mode` | enum(`EXCLUSIVE_USER`,`EXCLUSIVE_DEVICE`,`SHARED`) | Non | — | Mode de la période |
| `designated_device_id` | uuid → identity.devices | Oui | — | Appareil désigné (exigé en `EXCLUSIVE_DEVICE`) |
| `valid_from` | ts | Non | — | Début inclus : `occurred_at` de la commande, jamais avant le début de la période fermée |
| `valid_to` | ts | Oui | — | Fin exclue ; nul pour la période ouverte ; égal au début pour une période vide (deux changements de même date), jamais retenue |
| `command_id` | uuid | Oui | — | Commande qui a ouvert la période (nul pour l'amorçage) |
| `created_by`, `created_at` | uuid, ts | Non | — | |

- **PK** `id`. **IX** `(location_id, valid_from)`. **CK** mode admis ; appareil exigé en `EXCLUSIVE_DEVICE` ; `valid_to ≥ valid_from`.
- **Écriture** : `organization.location.create` (période initiale), `organization.pos.configure` (une période seulement si le couple (mode, appareil) change ; la précédente est fermée sous le verrou de l'emplacement de vente). Un emplacement sans période (inséré avant l'historique) reçoit d'abord la période de son état d'avant, si elle a une durée.
- **Suppr.** Ni modification (sauf la fermeture `valid_to`, une seule fois) ni suppression (déclencheurs). Amorçage par la migration `20261013090200` : une période ouverte par emplacement physique, depuis sa création.
- **Lecture** : `custodyAt(executor, locationId, at)` — période couvrante `[valid_from, valid_to)`, à défaut la plus ancienne qui a une durée, à défaut aucune (garde courante).
- **Intégrité** INV-DIS-03. Ni jeu hors ligne ni flux de changements.

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
- **Audit** Toute nouvelle valeur. **Offline** DL (paramètres `is_client_visible`) — jeu `me` (P5-18, AV-196) : chaque version visible, ligne `GLOBAL` quelle que soit sa portée (portée dans la donnée) ; les versions visibles antérieures de la même clé et de la même portée en sortent (`DELETE`) ; une version antidatée sous une version plus récente n'est pas publiée ; versions en vigueur semées publiées par le seed, qui retire les versions qu'une révision remplace.

Catalogue initial des clés (valeurs par défaut, références AV) :

| Clé | Défaut | Réf. |
|---|---|---|
| `fieldwork.geofence_radius_m` | 500 | CM §10, AV-022 |
| `fieldwork.max_gps_accuracy_m` | 150 | AV-022 |
| `fieldwork.override_min_attempts` / `override_min_minutes` | 3 / 2 | AV-021 |
| `fieldwork.suspicion_max_speed_kmh` / `suspicion_repeated_accuracy_count` | 150 / 5 | BR-TER-010 |
| `offline.max_autonomy_hours` / `warning_hours` | 168 / 48 | AV-009 |
| `sync.clock_skew_flag_minutes` | 5 | BR-SYN-011, AV-216 (minutes > 0 ; lu à la réception de chaque lot ; valeur absurde : 5) |
| `sync.occurred_at_future_tolerance_minutes` | 5 | INV-GLO-02, AV-226 (minutes ≥ 0 ; tolérance d'une date de fait postérieure à l'heure serveur, après correction de l'écart ; valeur absurde : 5) |
| `sync.retry_hold_minutes` | 30 | AV-217 |
| `sync.pull_settle_seconds` | 120 | AV-198 (fenêtre de stabilisation de la numérotation du flux) |
| `sync.backdate_max_hours` / `justification_after_hours` | 72 / 24 | AV-078 |
| `crm.inactive_after_days` | 30 | AV-013 |
| `crm.visit.max_distance_m` | 500 | BR-CRM-015 |
| `crm.phone_default_country_code` | 237 | BR-CRM-006 (DÉDUIT : indicatif d'un numéro national) |
| `procurement.receipt_over_tolerance_pct` | 0 | AV-053 (acceptation au-delà du commandé, en % du commandé) |
| `procurement.offline_over_receipt_mode` | `QUARANTINE` | AV-095 (réception hors ligne au-delà du reliquat : `QUARANTINE` ou `APPLY_WITH_REVIEW`) |
| `procurement.receipt_photo_threshold_xaf` | 100 000 | BR-APP-014, AV-037 (photo du bon de livraison exigée à partir de cette valeur acceptée) |
| `production.egg_grade_product_codes` | `[]` | AV-046 (codes produits des calibres d'œufs, liste ordonnée ; à paramétrer avec les produits GIC, AV-072) |
| `production.hatching_egg_product_code` | `""` | AV-046, AV-047 (code produit des œufs à couver ; vide = non paramétré) |
| `production.egg_shelf_life_days` | 28 | AV-100, AV-122 (péremption du lot d'une collecte : date de collecte + N jours ; 0 = sans date) |
| `production.slaughter_shelf_life_days` | 5 | AV-100, AV-125 (péremption du lot d'un abattage : jour de l'abattage + N jours ; 0 = sans date) |
| `production.incubation_durations` | `{"POULE": {"candlingDay": 7, "transferDay": 18, "hatchDay": 21}}` | AV-047, BR-INC-008 (échéancier par espèce, jours depuis la mise en incubateur ; ne bloque rien) |
| `production.slaughterable_lot_types` | `["POULET_CHAIR","PONDEUSE","REPRODUCTEUR_VOLAILLE","PORC_ENGRAISSEMENT","PORC_NAISSAGE"]` | AV-032, AV-115 (types de lots abattables : tous, décision du 28/09/2026) |
| `production.high_mortality_alert_pct` | 0,5 | AV-121 (seuil relatif de l'alerte `HIGH_MORTALITY`, cumul du jour ; découplé de la validation) |
| `production.high_mortality_alert_heads` | 20 | AV-121 (seuil absolu de l'alerte `HIGH_MORTALITY`) |
| `production.daily_entry_working_days` | `["1","2","3","4","5","6","7"]` | AV-462 (P9-09) : numéros ISO des jours (1 = lundi) où une saisie du jour est attendue d'un lot en cours ; une liste vide ou sans numéro valide : les sept jours. Un jour absent de la liste n'est pas examiné par `DAILY_ENTRY_MISSING` |
| `production.standard_cost_alert_lookback_days` | 30 | AV-463 (P9-09) : fenêtre, en jours, des entrées de production (collectes, naissances) revues par `STANDARD_COST_MISSING` ; entier strictement positif, sinon 30 |
| `crm.commercial_role_codes` | `["RESP_COMMERCIAL", "COMMERCIAL_TERRAIN", "COMMERCIAL_SEDENTAIRE"]` | BR-CRM-003, BR-CRM-020 (DÉDUIT : rôles réputés commerciaux — titulaire à la création, nouveau titulaire d'une réaffectation) |
| `sales.direct_cancel_minutes` | 15 | AV-030 |
| `sales.default_payment_terms_days` | 30 | AV-028 |
| `sales.duplicate_payment_window_minutes` | 10 | AV-056 (minutes ; fenêtre de détection d'un doublon d'encaissement sans référence : même client, même montant ; client visible, l'appareil contrôle aussi localement) |
| `sales.offline_over_allocation_allowed` | `false` | AV-025 (booléen JSON ; vente hors ligne au-delà de l'allocation, autorisée et signalée si vrai ; client visible, lu par l'appareil hors ligne ; réglable par site, `scope_type = SITE`) |
| `sales.offline_unallocated_sale_signal` | `"WHEN_ALLOCATED"` | AV-166 (P5-11 ; chaîne JSON `WHEN_ALLOCATED`, `ALWAYS` ou `NEVER` : une vente hors ligne sans quota utilisable sur un emplacement partagé est signalée `ALLOCATION_EXCEEDED` si l'emplacement porte au moins un quota actif du produit, même épuisé (un quota reste actif jusqu'à sa libération ou sa révocation), toujours, ou jamais ; valeur absente ou inconnue : `WHEN_ALLOCATED` ; serveur, non client visible ; réglable par site, `scope_type = SITE`) |
| `sales.undelivered_alert_days` | 7 | AV-132, AV-451 (jours ; ancienneté au-delà de laquelle une vente confirmée non livrée est signalée, depuis la plus tardive de la confirmation et de la livraison demandée ; alerte `SALE_UNDELIVERED`, P9-07 ; entier ≥ 0, sinon 7 ; serveur, non client visible) |
| `pricing.max_discount_pct.<ROLE>` | 0 / 5 / 15 | AV-026 |
| `pricing.stale_rules_hours` | 24 | AV-063 |
| `finance.cash_holding_max_xaf` | 200 000 | D09 §14, AV-447 : plafond d'encaisse d'une caisse d'utilisateur, alerte `CASH_HOLDING_HIGH` (P9-07) ; solde strictement supérieur ; 0 désactive le critère ; entier ≥ 0, sinon 200 000 |
| `finance.cash_sessions_per_day_max` | 0 = sans limite (visible de l'appareil ; révision « AV-154 (13/10/2026) » depuis 1) | AV-154 tranché : sessions de caisse par PDV et par jour métier ; une valeur ≥ 1 borne un site, une valeur invalide vaut « sans limite » |
| `finance.cash_session_force_close_hours` | 24 | D05 §14 : au-delà, session signalée et clôture d'office possible |
| `finance.cash_variance_critical_xaf` | 10 000 | D13 : gravité critique de l'alerte d'écart de caisse |
| `finance.cash_variance_tolerance_xaf` | 0 | AV-057 : tout écart est validé ; un écart dans la tolérance est validé d'office et n'est pas une alerte (`tolerated`, AV-450, P9-07) |
| `finance.cash_transfer_unreceived_hours` | 48 | AV-158 : alerte sur une remise de fonds envoyée et jamais reçue (tâche `finance.cash_transfers.unreceived_check`, P5-15 ; entier > 0, sinon 48) |
| `finance.cash_transfer_allowed_pairs` | `{CAISSE_PDV: [CAISSE_CENTRALE, BANQUE], CAISSE_UTILISATEUR: [CAISSE_CENTRALE, BANQUE], CAISSE_CENTRALE: [CAISSE_PDV, BANQUE], BANQUE: [CAISSE_CENTRALE], MOBILE_MONEY: [CAISSE_CENTRALE, BANQUE]}` | AV-158 (P5-15) : paires de comptes admises pour une remise (type source → types destinataires) ; téléchargé sur l'appareil ; forme invalide → défaut du domaine |
| `finance.cash_transfer_series_code` | `SIEGE` | AV-176 (P5-15) : code de la série globale `RMF-{CODE}-AAAA-nnnnnn` d'une remise entre comptes sans site (1 à 10 lettres majuscules ou chiffres) |
| `finance.cash_holding_max_days` | 3 | D09 §14, AV-447 : jours métier d'encaisse sans remise avant l'alerte `CASH_HOLDING_HIGH` (P9-07) ; strictement plus ; 0 désactive le critère ; entier ≥ 0, sinon 3 |
| `finance.supplier_payment_approval_xaf` | 500 000 | AV-055 ; BR-FIN-033 : au-delà (strictement), validation de la Direction avant décaissement (ADR-043 §6) |
| `finance.expense_approval_threshold_xaf` | 50 000 (visible de l'appareil) | AV-058 : au-delà (strictement), la dépense attend une validation (ADR-042 §2) |
| `finance.expense_photo_threshold_xaf` | 10 000 (visible de l'appareil) | AV-058 : au-delà (strictement), justificatif exigé |
| `finance.pos_expense_max_xaf` | 50 000 (visible de l'appareil) | AV-266 : plafond d'une dépense payée par la caisse d'un PDV (BR-DIS-013) |
| `finance.invoice_match_qty_tolerance_pct` | 0 | AV-053 : tolérance de quantité du rapprochement, en % de l'accepté |
| `finance.invoice_match_price_tolerance_xaf` | 0 | AV-053 : tolérance de prix unitaire du rapprochement |
| `finance.invoice_without_po_mode` | `REVIEW` | AV-271 : facture sans BC mise en revue (`REVIEW`) ou approuvée d'office (`APPROVE`) |
| `finance.supplier_advance_allowed` | vrai | AV-275 : paiement non affecté admis comme avance |
| `finance.supplier_series_code` | `SIEGE` | ADR-043 §10 : série globale des factures (`FF`) et paiements (`PF`) fournisseurs (1 à 10 lettres majuscules ou chiffres) |
| `procurement.po_approval_threshold_xaf` | 500 000 | AV-051 |
| `inventory.count_approval_threshold_xaf` | 25 000 | AV-039 |
| `inventory.transfer_unmatched_hours` | 48 | BR-STK-024 |
| `inventory.blind_receipt_match_mode` | `SUBSET` | AV-177 : règle de rapprochement d'une réception sans document (`SUBSET` : produits reçus inclus dans les produits expédiés ; `EXACT` : mêmes produits et mêmes quantités) ; lue au site, puis globale |
| `analytics.freshness_warning_hours` | 2 | BR-ANA-005 |
| `analytics.dashboard_max_period_days` | 366 | AV-207 (P5-20) : durée maximale, en jours, d'une période bornée (`from`/`to`) d'un tableau de bord ; entier > 0, sinon 366 |
| `communication.push_group_minutes` | 15 | AV-416, D13 §14 (P9-03) : fenêtre de regroupement des notifications push d'un même type pour un utilisateur |
| `communication.consumer_lag_alert_seconds` | 300 | AV-412, AV-438 (P9-03) : retard d'un consommateur d'événements au-delà duquel il est signalé |
| `communication.alert_retention_days` | 730 | AV-437 (P9-03) : conservation d'une alerte résolue, en jours |
| `communication.notification_retention_days` | 90 | AV-437 (P9-03) : conservation d'une notification lue, en jours |
| `approvals.pending_long_hours` | 24 | AV-408, AV-466 (P9-03, P9-09) : délai, en heures depuis la réception de la demande par le serveur (borne comprise), au-delà duquel une demande de validation en attente est signalée et escaladée (`escalated_at`) ; nombre > 0, sinon 24 |
| `attachments.missing_alert_days` | 7 | AV-407, AV-449 (P9-03, P9-07) : jours sans justificatif avant l'alerte `ATTACHMENT_MISSING` ; compté depuis la réception par le serveur ; 0 désactive l'alerte et ferme celles qui sont ouvertes ; entier ≥ 0, sinon 7 |
| `attachments.missing_alert_horizon_days` | 90 | AV-449 (P9-07) : horizon du balayage des justificatifs manquants, en jours ; au moins le délai plus un jour ; entier > 0, sinon 90 |
| `procurement.receipt_incomplete_alert_days` | 2 | BR-APP-015, AV-410, AV-464 (P9-03, P9-09) : jours métier de retard sur la date prévue du bon au-delà desquels (strict : « plus de 2 jours ») un bon avec reliquat est signalé ; entier ≥ 0 (0 : dès le lendemain), sinon 2 ; la lecture est globale |
| `inventory.high_loss_alert_xaf` | 50 000 | AV-406, AV-453 (P9-03, P9-08) : seuil absolu de l'alerte `HIGH_LOSS`, en XAF, par emplacement et par jour métier du fait ; lu à la déclaration (site, à défaut global) ; nombre ≥ 0, sinon 50 000 ; une perte sans valeur n'alerte jamais |
| `sales.high_loss_alert_sales_pct` | 5 | AV-406, AV-455 (P9-03, P9-08) : part du CA net du jour du site au-delà de laquelle la perte d'un emplacement est signalée, en % ; nombre > 0, sinon 5 |
| `inventory.transfer_not_received_hours` | 48 | AV-065, AV-458 (P9-03, P9-08) : délai de l'alerte `TRANSFER_NOT_RECEIVED`, compté depuis l'expédition ; site de l'expéditeur, à défaut global ; nombre > 0, sinon 48 |
| `inventory.lot_expiring_days` | 15 | AV-065, AV-454 (P9-03, P9-08) : jours avant péremption pour l'alerte `LOT_EXPIRING` ; entier ≥ 0, sinon 15 ; 0 : seulement les lots périmant aujourd'hui ou déjà périmés |
| `inventory.replenish_alert_scope` | `BELOW_TARGET` | AV-452 (P9-08) : condition de l'alerte `POS_REPLENISH` — `BELOW_TARGET` (la suggestion « cible − disponible − transit entrant » est positive, D13 littéral) ou `BELOW_MINIMUM` (aussi sous le minimum du point de vente) ; autre valeur : `BELOW_TARGET` |
| `sales.commercial_working_days` | `["1","2","3","4","5","6"]` | BR-TER-013, AV-409 (P9-03) : jours ouvrés ISO (1 = lundi) suivis par l'alerte `INACTIVE_COMMERCIAL` ; liste vide ou invalide : lundi à samedi |
| `sales.inactive_commercial_role_codes` | `["COMMERCIAL_TERRAIN"]` | BR-TER-013, AV-444 (P9-07) : rôles suivis par l'alerte `INACTIVE_COMMERCIAL` |
| `sync.stale_hours` | 24 | D13 §7.1 (P9-03) : durée sans synchronisation au-delà de laquelle un appareil est signalé |
| `sync.error_alert_window_hours` | 24 | AV-442 (P9-03) : fenêtre de la passe qui signale les erreurs de synchronisation |
