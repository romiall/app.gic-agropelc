# Dictionnaire — schéma `production`

## production.production_lots

**Responsabilité** : lot (campagne) de production animale (SM-PRODUCTION-LOT ; D07).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `lot_code` | varchar(20) | Non | — | Ex. `L-2026-014` (= `stock_lots.lot_code`) |
| `lot_type` | enum(`POULET_CHAIR`,`PONDEUSE`,`PORC_ENGRAISSEMENT`,`REPRODUCTEUR_VOLAILLE`,`PORC_NAISSAGE`) | Non | — | AV-044 (types optionnels activables) |
| `product_id` | uuid → catalog.products | Non | — | Produit biologique du lot |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | Lot de traçabilité (1:1) |
| `site_id` | uuid → organization.sites | Non | — | Ferme |
| `main_location_id` | uuid → organization.locations | Non | — | Bâtiment principal |
| `supplier_id` | uuid → procurement.suppliers | Oui | — | Fournisseur des animaux |
| `strain` | label | Oui | — | Souche (CM §15) |
| `planned_start_date` | date | Oui | — | |
| `start_date` | date | Oui | — | Date de première entrée |
| `initial_quantity` | qty | Oui | — | Σ entrées `PLACEMENT` (INV-PRD-01) |
| `planned_end_date` | date | Oui | — | |
| `status` | enum(`PLANNED`,`ACTIVE`,`SELLING`,`CLOSED`,`CANCELLED`) | Non | `PLANNED` | |
| `closed_at` | ts | Oui | — | |
| `closing_summary` | json | Oui | — | Indicateurs figés à la clôture (mortalité, coût total, CA, marge) — instantané technique, pas une source de vérité |
| `notes` | text | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `lot_code`, `stock_lot_id`, `command_id`.
- **CK** `CLOSED` ⇒ `closed_at` non nul.
- **IX** `(site_id, status)`.
- **Suppr.** `ANNULATION` (`CANCELLED` sans entrée) ; sinon clôture. **Audit** Création, changements de statut, clôture. **Offline** DL (lots actifs du site), CR.
- **Remarque** : **aucune** colonne d'effectif courant (INV-PRD-01) ; l'effectif se lit dans `inventory.stock_balances`.

## production.lot_entries

**Responsabilité** : entrée d'animaux dans un lot (mise en place, naissance, transfert entrant).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `entry_type` | enum(`PLACEMENT`,`BIRTH`,`TRANSFER_IN`) | Non | — | |
| `quantity_base` | qty | Non | — | > 0 |
| `to_location_id` | uuid → organization.locations | Non | — | Bâtiment ou case |
| `source_kind` | enum(`PURCHASE`,`INTERNAL_STOCK`,`BIRTH`,`TRANSFER`) | Non | — | |
| `source_location_id` | uuid → organization.locations | Oui | — | Emplacement des poussins en stock (reclassement) |
| `source_product_id` | uuid → catalog.products | Oui | — | Produit d'origine (ex. poussin d'un jour) |
| `goods_receipt_id` | uuid → procurement.goods_receipts | Oui | — | Achat direct |
| `unit_cost_xaf` | money_xaf | Oui | — | Coût d'entrée (déterminé par le serveur) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **Suppr.** `ANNULATION` (inverses). **Offline** DL (30 j), CR.

## production.lot_weighings

**Responsabilité** : pesées.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `location_id` | uuid → organization.locations | Oui | — | |
| `sample_size` | int | Non | — | > 0 |
| `avg_weight_g` | DECIMAL(10,1) | Non | — | > 0 |
| `total_weight_kg` | DECIMAL(12,3) | Oui | — | |
| `source` | enum(`MANUAL`,`DEVICE`) | Non | `MANUAL` | `DEVICE` : extension F-04 |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **Suppr.** `ANNULATION`. **Offline** DL (30 j), CR.

## production.lot_observations

**Responsabilité** : observations.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | |
| `observation_type` | enum(`SANITAIRE`,`COMPORTEMENT`,`ENVIRONNEMENT`,`INCIDENT`,`AUTRE`) | Non | — | |
| `text` | text | Non | — | |
| `severity` | enum(`INFO`,`WARNING`,`CRITICAL`) | Non | `INFO` | `CRITICAL` → alerte |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **Suppr.** `IMMUABLE` (correction par une nouvelle observation). **Offline** DL (30 j), CR.

## production.egg_collections

**Responsabilité** : collecte journalière d'un lot de pondeuses (CM §17 ; SM-EGG-COLLECTION).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `production_lot_id` | uuid → production_lots | Non | — | Lot `PONDEUSE` |
| `collection_date` | date | Non | — | Jour métier |
| `storage_location_id` | uuid → organization.locations | Non | — | Stockage des œufs |
| `collected_qty` | int | Non | — | |
| `broken_qty` | int | Non | 0 | |
| `nonconforming_qty` | int | Non | 0 | |
| `marketable_qty` | int | Non | — | |
| `hatching_qty` | int | Non | 0 | |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(production_lot_id, collection_date)` parmi `RECORDED` (BR-OEU-004) ; `command_id`.
- **CK** `collected_qty = broken_qty + nonconforming_qty + marketable_qty + hatching_qty` (INV-OEU-01) ; toutes les quantités ≥ 0.
- **Suppr.** `ANNULATION`. **Offline** DL (30 j), CR.

## production.incubation_batches

**Responsabilité** : lot d'incubation (CM §18 ; SM-INCUBATION).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `batch_code` | varchar(20) | Non | — | `INC-2026-007` |
| `stock_lot_id` | uuid → inventory.stock_lots | Non | — | |
| `site_id` | uuid → organization.sites | Non | — | |
| `incubator_location_id` | uuid → organization.locations | Non | — | `INCUBATOR` |
| `hatcher_location_id` | uuid → organization.locations | Oui | — | `HATCHER` |
| `egg_source` | enum(`INTERNAL`,`PURCHASED`) | Non | — | AV-047 |
| `eggs_set_qty` | int | Non | — | Figé au démarrage |
| `set_at` | ts | Non | — | |
| `expected_candling_date`, `expected_transfer_date`, `expected_hatch_date` | date | Oui | — | Échéancier (BR-INC-008) |
| `infertile_qty`, `early_dead_qty`, `accidental_loss_qty`, `transferred_qty`, `hatched_viable_qty`, `hatched_nonviable_qty`, `unhatched_qty` | int | Non | 0 | Compteurs (dénormalisés depuis les étapes) |
| `status` | enum(`INCUBATING`,`IN_HATCHER`,`CLOSED`,`CANCELLED`) | Non | `INCUBATING` | |
| `hatch_rate` | DECIMAL(5,4) | Oui | — | BR-INC-007 (figé à la clôture) |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `batch_code`, `command_id`.
- **CK** À la clôture : `eggs_set_qty = infertile_qty + early_dead_qty + accidental_loss_qty + unhatched_qty + hatched_viable_qty + hatched_nonviable_qty` (INV-INC-01).
- **Suppr.** `ANNULATION`. **Offline** DL (en cours), CR.

## production.incubation_events

**Responsabilité** : étapes d'incubation.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `batch_id` | uuid → incubation_batches | Non | — | |
| `event_type` | enum(`SET`,`CANDLING`,`TRANSFER_TO_HATCHER`,`HATCH`,`CANCEL`) | Non | — | |
| `qty_infertile`, `qty_early_dead`, `qty_transferred`, `qty_hatched_viable`, `qty_hatched_nonviable`, `qty_unhatched` | int | Oui | — | Selon le type |
| `output_location_id` | uuid → organization.locations | Oui | — | Destination des poussins (`HATCH`) |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id` ; un seul `HATCH` et un seul `TRANSFER_TO_HATCHER` `RECORDED` par lot.
- **CK** Quantités ≥ 0 et cohérentes avec le type.
- **Suppr.** `ANNULATION`. **Offline** CR.

## production.animals (extension future — non créée)

Identification individuelle (CM §19 ; F-08) : `id`, `tag_code`, `production_lot_id`, `stock_lot_id` (lot d'une seule unité), `sex`, `birth_date`, `status`. Le registre de stock reste inchangé.
