# Dictionnaire — schéma `production`

> Tables créées en P7-04 (`db/migrations/20261002090100_create_production.sql`). Décisions intégrées : AV-044 (cinq types de lots), AV-099 (un lot par produit, lots liés), AV-100 (lot de stock propre par collecte et par abattage), AV-101/102 (abattage à la ferme), AV-104 à AV-106 (frais généraux par espèce, répartition à la demande, part estimée à la clôture), AV-110 (plusieurs collectes par jour), AV-111 (naissance et sevrage) ; ADR-026 amendé, ADR-027.

## production.production_lots

**Responsabilité** : lot (campagne ou troupeau permanent) de production animale (SM-PRODUCTION-LOT ; D07).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `lot_code` | varchar(40) | Non | — | Numéro `LOT-{site}-{AAAA}-{seq6}` (= `stock_lots.lot_code`) |
| `lot_type` | enum(`POULET_CHAIR`,`PONDEUSE`,`PORC_ENGRAISSEMENT`,`REPRODUCTEUR_VOLAILLE`,`PORC_NAISSAGE`) | Non | — | Les cinq types sont actifs (AV-044) |
| `product_id` | uuid → catalog.products | Non | — | Produit biologique du lot — un seul produit par lot (AV-099) |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | Lot de traçabilité (1:1, origine `PRODUCTION_LOT`) |
| `site_id` | uuid → organization.sites | Non | — | Ferme |
| `main_location_id` | uuid → organization.locations | Non | — | Bâtiment ou case principal |
| `parent_lot_id` | uuid → production_lots | Oui | — | Lot lié de la même bande (truies ↔ porcelets, poules ↔ coqs ; AV-099, AV-111) |
| `supplier_id` | uuid → procurement.suppliers | Oui | — | Fournisseur des animaux |
| `strain` | label | Oui | — | Souche (CM §15) |
| `planned_start_date` | date | Oui | — | |
| `start_date` | date | Oui | — | Date de première entrée |
| `initial_quantity` | qty | Oui | — | Σ entrées `PLACEMENT` (INV-PRD-01) |
| `planned_end_date` | date | Oui | — | |
| `status` | enum(`PLANNED`,`ACTIVE`,`SELLING`,`CLOSED`,`CANCELLED`) | Non | `PLANNED` | |
| `closed_at` | ts | Oui | — | |
| `closing_summary` | json | Oui | — | Indicateurs figés à la clôture (mortalité, coûts directs et frais généraux séparés, CA, marge) — instantané, pas une source de vérité |
| `notes` | text | Oui | — | |
| [STD-CANCEL] | | | | Renseigné si et seulement si `CANCELLED` |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `lot_code`, `stock_lot_id`, `command_id`. **IX** `(site_id, status)`, `(parent_lot_id)`.
- **CK** `CLOSED` ⇒ `closed_at` non nul ; colonnes d'annulation ⇔ `CANCELLED` ; `parent_lot_id` ≠ `id`.
- **Déclencheurs** : code, type, produit, lot de stock et ferme immuables ; un lot `CLOSED` ou `CANCELLED` ne change plus de statut ; aucune suppression.
- **Suppr.** `ANNULATION` (`CANCELLED` sans entrée) ; sinon clôture. **Audit** Création, statuts, clôture. **Offline** DL (lots actifs du site), CR.
- **Remarque** : **aucune** colonne d'effectif (INV-PRD-01) ; l'effectif se lit dans le registre de stock (`inventory.lotHeadcount`).

## production.lot_entries

**Responsabilité** : entrée d'animaux dans un lot (mise en place, naissance, transfert entrant et sevrage).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | Lot de destination |
| `entry_type` | enum(`PLACEMENT`,`BIRTH`,`TRANSFER_IN`) | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | Produit entrant (produit du lot) |
| `quantity_base` | qty | Non | — | > 0 (nés vivants pour une naissance) |
| `to_location_id` | uuid → organization.locations | Non | — | Bâtiment ou case |
| `source_kind` | enum(`PURCHASE`,`INTERNAL_STOCK`,`BIRTH`,`TRANSFER`,`WEANING`) | Non | — | `WEANING` : sevrage depuis un lot de porcelets (AV-111) |
| `source_location_id` | uuid → organization.locations | Oui | — | Emplacement source (reclassement) |
| `source_product_id` | uuid → catalog.products | Oui | — | Produit d'origine (ex. poussin d'un jour) |
| `source_stock_lot_id` | uuid | Oui | — | Lot de stock d'origine (réf. sans FK) |
| `source_production_lot_id` | uuid → production_lots | Oui | — | Lot d'origine d'un transfert ou d'un sevrage |
| `goods_receipt_id` | uuid → procurement.goods_receipts | Oui | — | Achat direct (AV-112) |
| `stillborn_qty` | int | Non | 0 | Mort-nés d'une mise bas, hors stock (AV-111) |
| `avg_weight_g` | DECIMAL(10,1) | Oui | — | Poids moyen à l'entrée (GMQ, AV-116) |
| `unit_cost_xaf` | money_xaf | Oui | — | Coût d'entrée (déterminé par le serveur) |
| `value_xaf` | money_xaf | Non | 0 | Valeur d'entrée (écriture `ANIMAUX` du lot) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(production_lot_id, occurred_at)`, `(source_production_lot_id)`.
- **Suppr.** `ANNULATION` (inverses). **Offline** DL (30 j), CR.

## production.lot_weighings

**Responsabilité** : pesées (BR-PRD-015 ; poids moyen, GMQ et indice de consommation, AV-049).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `location_id` | uuid → organization.locations | Oui | — | |
| `sample_size` | int | Non | — | > 0 |
| `avg_weight_g` | DECIMAL(10,1) | Non | — | > 0 |
| `total_weight_kg` | DECIMAL(12,3) | Oui | — | > 0 si renseigné |
| `source` | enum(`MANUAL`,`DEVICE`) | Non | `MANUAL` | `DEVICE` : extension F-04 |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **Suppr.** `ANNULATION`. **Offline** DL (30 j), CR.

## production.lot_observations

**Responsabilité** : observations (sanitaires, AV-050 ; incidents).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `observation_type` | enum(`SANITAIRE`,`COMPORTEMENT`,`ENVIRONNEMENT`,`INCIDENT`,`AUTRE`) | Non | — | |
| `text` | text | Non | — | Non vide |
| `severity` | enum(`INFO`,`WARNING`,`CRITICAL`) | Non | `INFO` | `CRITICAL` → alerte (P9) |
| [STD-ORIGIN] | | | | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `command_id`. **Suppr.** `IMMUABLE` (correction par une nouvelle observation). **Offline** DL (30 j), CR.

## production.egg_collections

**Responsabilité** : collecte d'œufs d'un lot de pondeuses ou de reproducteurs (CM §17 ; SM-EGG-COLLECTION ; AV-044, AV-046, AV-110).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `doc_number` | varchar(40) | Non | — | `COL-{site}-{AAAA}-{seq6}` (code du lot de stock de la collecte) |
| `production_lot_id` | uuid → production_lots | Non | — | Lot `PONDEUSE` ou `REPRODUCTEUR_VOLAILLE` |
| `site_id` | uuid → organization.sites | Non | — | |
| `collection_date` | date | Non | — | Jour métier |
| `storage_location_id` | uuid → organization.locations | Non | — | Stockage des œufs |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | Lot de stock propre (origine `COLLECTION`, AV-100) |
| `hatching_product_id` | uuid → catalog.products | Oui | — | Produit « œuf à couver » (requis si `hatching_qty` > 0) |
| `collected_qty` | int | Non | — | |
| `broken_qty` | int | Non | 0 | Hors stock |
| `nonconforming_qty` | int | Non | 0 | Hors stock |
| `marketable_qty` | int | Non | — | = Σ des lignes par calibre |
| `hatching_qty` | int | Non | 0 | |
| `standard_value_xaf` | money_xaf | Non | 0 | Valeur au coût standard des œufs entrés, créditée au lot producteur (AV-098) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `stock_lot_id`, `command_id` — **aucune** unicité (lot, date) : plusieurs collectes par jour (AV-110, remplace BR-OEU-004).
- **CK** `collected_qty = broken_qty + nonconforming_qty + marketable_qty + hatching_qty` (INV-OEU-01) ; quantités ≥ 0 ; produit « à couver » requis si `hatching_qty` > 0.
- **Suppr.** `ANNULATION`. **Offline** DL (30 j), CR.

## production.egg_collection_lines

**Responsabilité** : œufs commercialisables d'une collecte, par calibre (AV-046 : chaque calibre est un produit, liste paramétrée `production.egg_grade_product_codes`).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `collection_id` | uuid → egg_collections | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | Produit du calibre |
| `quantity` | int | Non | — | > 0 |
| `unit_cost_xaf` | money_xaf | Non | 0 | Coût standard figé (AV-098) |

- **PK** `id`. **UQ** `(collection_id, product_id)`. **Suppr.** `IMMUABLE`. **Intégrité** Σ `quantity` = `marketable_qty` (transaction ; INV-OEU-01 étendu).

## production.incubation_batches

**Responsabilité** : lot d'incubation (CM §18 ; SM-INCUBATION ; AV-047, AV-113).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `batch_code` | varchar(40) | Non | — | `INC-{site}-{AAAA}-{seq6}` |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | Lot de stock (origine `INCUBATION_BATCH`) |
| `site_id` | uuid → organization.sites | Non | — | |
| `species` | code | Non | — | Espèce (clé des durées `production.incubation_durations`, AV-047) |
| `egg_product_id` | uuid → catalog.products | Non | — | Œuf à couver |
| `chick_product_id` | uuid → catalog.products | Non | — | Poussin produit (chair ou ponte) |
| `incubator_location_id` | uuid → organization.locations | Non | — | `INCUBATOR` |
| `hatcher_location_id` | uuid → organization.locations | Oui | — | `HATCHER` |
| `egg_source` | enum(`INTERNAL`,`PURCHASED`) | Non | — | AV-047 |
| `eggs_set_qty` | int | Non | — | Figé au démarrage |
| `set_at` | ts | Non | — | |
| `expected_candling_date`, `expected_transfer_date`, `expected_hatch_date` | date | Oui | — | Échéancier (BR-INC-008) |
| `infertile_qty`, `early_dead_qty`, `accidental_loss_qty`, `transferred_qty`, `hatched_viable_qty`, `hatched_nonviable_qty`, `unhatched_qty` | int | Non | 0 | Compteurs (dénormalisés depuis les étapes et les pertes) |
| `status` | enum(`INCUBATING`,`IN_HATCHER`,`CLOSED`,`CANCELLED`) | Non | `INCUBATING` | |
| `hatch_rate` | DECIMAL(5,4) | Oui | — | BR-INC-007 (figé à la clôture) |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `batch_code`, `stock_lot_id`, `command_id`.
- **CK** À la clôture : `eggs_set_qty = infertile_qty + early_dead_qty + accidental_loss_qty + unhatched_qty + hatched_viable_qty + hatched_nonviable_qty` (INV-INC-01) ; compteurs ≥ 0.
- **Déclencheurs** : œufs incubés, produits et code figés ; un lot clos ne change plus de statut.
- **Suppr.** `ANNULATION`. **Offline** DL (en cours), CR.

## production.incubation_events

**Responsabilité** : étapes d'incubation.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `batch_id` | uuid → incubation_batches | Non | — | |
| `event_type` | enum(`SET`,`CANDLING`,`TRANSFER_TO_HATCHER`,`HATCH`,`CANCEL`) | Non | — | |
| `qty_infertile`, `qty_early_dead`, `qty_transferred`, `qty_hatched_viable`, `qty_hatched_nonviable`, `qty_unhatched` | int | Oui | — | Selon le type, ≥ 0 |
| `output_location_id` | uuid → organization.locations | Oui | — | Destination des poussins (`HATCH`) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| `single_step_key` | varchar(60) | Oui | généré | Donnée technique : unicité du transfert et de l'éclosion enregistrés |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |

- **PK** `id`. **UQ** `command_id` ; un seul `HATCH` et un seul `TRANSFER_TO_HATCHER` `RECORDED` par lot (`single_step_key`).
- **Suppr.** `ANNULATION`. **Offline** CR.

## production.slaughter_batches

**Responsabilité** : abattage d'animaux d'un lot, transformation multi-produits (AV-032, AV-101, AV-102, AV-114 ; ADR-026 §2).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `doc_number` | varchar(40) | Non | — | `ABT-{site}-{AAAA}-{seq6}` (code du lot de stock des produits) |
| `production_lot_id` | uuid → production_lots | Non | — | Lot abattu (type abattable, paramètre `production.slaughterable_lot_types`) |
| `site_id` | uuid → organization.sites | Non | — | Ferme |
| `source_location_id` | uuid → organization.locations | Non | — | Emplacement des animaux |
| `location_id` | uuid → organization.locations | Non | — | Abattoir de la ferme (`SLAUGHTERHOUSE`) |
| `input_product_id` | uuid → catalog.products | Non | — | Produit vif |
| `heads_qty` | int | Non | — | Têtes abattues (> 0) |
| `condemned_heads` | int | Non | 0 | Têtes saisies, sans produit (AV-114) |
| `live_weight_g` | bigint | Non | — | Poids vif total (> 0) |
| `output_weight_g` | bigint | Non | — | Σ poids des produits, ≤ poids vif |
| `total_input_value_xaf` | money_xaf | Non | 0 | Valeur figée des têtes sorties du lot (coût restant, ADR-027) |
| `yield_rate` | DECIMAL(5,4) | Oui | — | Rendement = poids des produits ÷ poids vif |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | Lot de stock propre des produits (origine `TRANSFORMATION`, AV-100) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `stock_lot_id`, `command_id`. **CK** quantités et poids positifs ; saisies ≤ têtes ; poids des produits ≤ poids vif.
- **Suppr.** `ANNULATION` (inverses). **Offline** DL (30 j), CR.

## production.slaughter_outputs

**Responsabilité** : produits obtenus d'un abattage (poulet entier à la pièce, découpes et abats au kg, AV-102).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `slaughter_id` | uuid → slaughter_batches | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `to_location_id` | uuid → organization.locations | Non | — | Stockage |
| `quantity_base` | qty | Non | — | > 0 |
| `weight_g` | bigint | Non | — | Poids (clé de répartition), > 0 |
| `allocated_value_xaf` | money_xaf | Non | — | Part du coût au prorata du poids, au franc (AV-032) |
| `unit_cost_xaf` | money_xaf | Non | — | Coût unitaire figé |

- **PK** `id`. **UQ** `(slaughter_id, product_id)`. **Suppr.** `IMMUABLE`. **Intégrité** Σ `allocated_value_xaf` = `total_input_value_xaf` (transaction).

## production.overhead_allocations

**Responsabilité** : exécution de la répartition des frais généraux d'une ferme et d'une espèce sur un mois (ADR-026 amendé ; AV-104 à AV-106).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `site_id` | uuid → organization.sites | Non | — | Ferme |
| `species_group` | enum(`VOLAILLE`,`PORC`) | Non | — | Jamais de mélange (AV-104) |
| `period` | char(7) | Non | — | Mois métier `AAAA-MM` |
| `run_kind` | enum(`INITIAL`,`REGULARIZATION`,`CLOSING_ESTIMATE`) | Non | — | Première répartition, régularisation (frais tardifs), part estimée à la clôture d'un lot (AV-105) |
| `sequence` | int | Non | — | Rang de l'exécution dans (ferme, espèce, mois) |
| `pool_xaf` | money_xaf | Non | — | Masse à répartir (frais non encore répartis) |
| `allocated_xaf` | money_xaf | Non | — | Répartie (≤ masse ; nulle si aucun lot) |
| `head_days_total` | DECIMAL(18,3) | Non | — | Σ têtes × jours |
| `production_lot_id` | uuid → production_lots | Oui | — | Lot de la part estimée (⇔ `CLOSING_ESTIMATE`) |
| `occurred_at` | ts | Non | — | |
| `command_id` | uuid | Oui | — | Commande `production.overhead.allocate` |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `(site_id, species_group, period, sequence)`, `command_id`. **Suppr.** `IMMUABLE` (jamais réécrite, ADR-026).

## production.overhead_allocation_lines

**Responsabilité** : part de chaque lot dans une exécution.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `allocation_id` | uuid → overhead_allocations | Non | — | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `head_days` | DECIMAL(18,3) | Non | — | Têtes × jours du lot sur le mois |
| `amount_xaf` | money_xaf | Non | — | Part au prorata, au franc (plus fort reste) |
| `cost_entry_id` | uuid | Oui | — | Écriture `FRAIS_GENERAUX` du lot (nulle si part nulle) |

- **PK** `id`. **UQ** `(allocation_id, production_lot_id)`. **Suppr.** `IMMUABLE`. **Intégrité** Σ `amount_xaf` = `allocated_xaf`.

## production.animals (extension future — non créée)

Identification individuelle (CM §19 ; F-08) : `id`, `tag_code`, `production_lot_id`, `stock_lot_id` (lot d'une seule unité), `sex`, `birth_date`, `status`. Le registre de stock reste inchangé.
