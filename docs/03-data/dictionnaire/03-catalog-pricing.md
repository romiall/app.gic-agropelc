# Dictionnaire — schémas `catalog` et `pricing`

## catalog.product_categories

**Responsabilité** : arborescence d'analyse des produits.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `parent_id` | uuid → product_categories | Oui | — | |
| `code` | code | Non | — | `VOLAILLE`, `OEUFS`, `PORCS`, `ALIMENTS`, `VETERINAIRE`, `EMBALLAGES`, `SERVICES` |
| `name` | label | Non | — | |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL.

## catalog.units

**Responsabilité** : unités de mesure.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `code` | code | Non | — | PK : `TETE`, `OEUF`, `PIECE`, `KG`, `G`, `L`, `SAC`, `PLATEAU`, `CARTON`, `DOSE` |
| `name` | label | Non | — | |
| `is_count` | boolean | Non | — | Unité comptée (quantités entières, BR-CAT-003) |
| `is_active` | boolean | Non | true | |

- **PK** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL.

## catalog.products

**Responsabilité** : produit stocké, produit, acheté, consommé ou vendu (D16).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | SKU |
| `name` | label | Non | — | |
| `category_id` | uuid → product_categories | Non | — | |
| `stock_family` | enum(`BIOLOGIQUE`,`PRODUCTION_COMMERCIALISABLE`,`INTRANT`,`MARCHANDISE`,`EMBALLAGE_CONSOMMABLE`,`SERVICE`) | Non | — | CM §20 |
| `base_unit_code` | code → units | Non | — | Unité du registre (INV-CAT-01) |
| `lot_tracking` | enum(`REQUIRED`,`OPTIONAL`,`NONE`) | Non | `NONE` | AV-036 |
| `expiry_tracking` | boolean | Non | false | Péremption suivie (FEFO) |
| `is_sellable`, `is_purchasable`, `is_producible`, `is_consumable` | boolean | Non | false | Usages permis |
| `pricing_mode` | enum(`PER_UNIT`,`PER_WEIGHT`) | Non | `PER_UNIT` | AV-031 |
| `species` | enum(`POULET_CHAIR`,`PONDEUSE`,`PORC`) | Oui | — | Produits biologiques |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | BR-CAT-006 |
| `sellable_since` | ts | Oui | — | Activation à la vente (après la règle tarifaire globale, BR-CAT-008) |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`.
- **CK** `SERVICE` ⇒ `lot_tracking = NONE` ; `species` requis si `BIOLOGIQUE`.
- **IX** `(category_id)`, `(status, is_sellable)`.
- **Suppr.** `DESACTIVATION`. **Hist.** Modifications auditées ; les transactions figent le libellé (BR-CAT-007).
- **Audit** Toute modification. **Offline** DL (produits actifs et produits inactifs avec solde du périmètre).
- **Intégrité** INV-CAT-01 (déclencheur : refus de modifier `base_unit_code` si un mouvement existe).

## catalog.product_units

**Responsabilité** : conditionnements d'un produit et leur conversion vers l'unité de base.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `product_id` | uuid → products | Non | — | |
| `unit_code` | code → units | Non | — | |
| `factor_to_base` | DECIMAL(14,6) | Non | — | 1 plateau = 30 œufs ; 1 sac = 50 kg |
| `is_sales_unit`, `is_purchase_unit`, `is_count_unit` | boolean | Non | false | Usages |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(product_id, unit_code)`. **CK** `factor_to_base > 0`.
- **Suppr.** `DESACTIVATION` ; `factor_to_base` immuable une fois utilisé (BR-CAT-004 ; modification = nouvelle unité). **Offline** DL.

## catalog.reason_codes

**Responsabilité** : motifs normalisés par catégorie.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `category` | enum(`LOSS`,`REJECTION`,`INVENTORY_ADJUSTMENT`,`CANCELLATION`,`PRICE_OVERRIDE`,`VISIT_OUTCOME`,`PROSPECT_LOST`,`CHECKIN_OVERRIDE`,`PRODUCTION_YIELD`,`CASH_VARIANCE`,`TRANSFER_DISCREPANCY`) | Non | — | |
| `code` | code | Non | — | Ex. `CASSE_TRANSPORT`, `INFERTILE`, `COMMANDE_PRISE` |
| `label` | label | Non | — | |
| `loss_category` | enum(catégories de perte) | Oui | — | Pour `LOSS` : catégorie à laquelle le motif est lié |
| `requires_comment` | boolean | Non | false | |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(category, code)`. **Suppr.** `DESACTIVATION` (BR-CAT-010). **Offline** DL.

## catalog.product_standard_costs

**Responsabilité** : coût standard historisé d'un produit (BR-CAT-011).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `product_id` | uuid → products | Non | — | |
| `unit_cost_xaf` | money_xaf | Non | — | Par unité de base |
| `valid_from` | ts | Non | — | |
| `reason` | text | Oui | — | |
| `created_at`, `created_by` | ts, uuid | Non | — | |

- **PK** `id`. **UQ** `(product_id, valid_from)`. **Suppr.** `IMMUABLE` (versionnement). **Audit** Création. **Offline** SRV.

---

## pricing.commercial_campaigns

**Responsabilité** : période commerciale nommée (promotion, saison) regroupant des règles (PM §9). À distinguer du lot de production (tension C-03).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | |
| `name` | label | Non | — | « Fêtes de fin d'année 2026 » |
| `valid_from` | ts | Non | — | |
| `valid_to` | ts | Non | — | |
| `status` | enum(`DRAFT`,`ACTIVE`,`CANCELLED`) | Non | `DRAFT` | « Active à t » = `ACTIVE` et t dans la période |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **CK** `valid_to > valid_from`. **Suppr.** `ANNULATION` (statut). **Offline** DL (actives et futures).

## pricing.price_rules

**Responsabilité** : règle tarifaire versionnée (D10, stratégie pricing).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | UUIDv7 (le plus récent gagne au départage final) |
| `code` | code | Non | — | Identifiant lisible de la lignée |
| `version` | int | Non | 1 | Version dans la lignée (remplace `version` de STD-AUDIT : la règle n'est jamais modifiée) |
| `supersedes_rule_id` | uuid → price_rules | Oui | — | Règle remplacée |
| `product_id` | uuid → catalog.products | Non | — | |
| `unit_price_xaf` | money_xaf | Non | — | > 0 |
| `pricing_unit_code` | code → catalog.units | Non | — | |
| `zone_id` | uuid → organization.zones | Oui | — | Dimension |
| `site_id` | uuid → organization.sites | Oui | — | Dimension |
| `customer_category_id` | uuid → catalog.customer_categories | Oui | — | Dimension |
| `channel_code` | code → catalog.sales_channels | Oui | — | Dimension |
| `min_quantity` | qty | Oui | — | Palier |
| `commercial_campaign_id` | uuid → commercial_campaigns | Oui | — | Dimension |
| `priority` | int | Non | 0 | |
| `specificity` | smallint | Non | calculé | BR-PRX-005 (stocké pour les index et l'explication) |
| `valid_from` | ts | Non | — | |
| `valid_to` | ts | Oui | — | Seule colonne modifiable après activation (réduction uniquement) |
| `status` | enum(`DRAFT`,`ACTIVE`,`RETIRED`,`CANCELLED`) | Non | `DRAFT` | SM-PRICE-RULE |
| `approved_by` | uuid → users | Oui | — | |
| `approved_at` | ts | Oui | — | |
| `notes` | text | Oui | — | Justification |
| `created_at`, `created_by`, `updated_at`, `updated_by` | | | | [STD-AUDIT] hors `version` |

- **PK** `id`. **UQ** `(code, version)`.
- **CK** `unit_price_xaf > 0` ; `valid_to > valid_from` ; `approved_*` requis si `ACTIVE` ou `RETIRED` ; `min_quantity > 0` si renseigné.
- **IX** `(product_id, status, valid_from)`, `(zone_id)`, `(site_id)`.
- **Suppr.** `VERSIONNEMENT` + `IMMUABLE` après activation (INV-PRX-01, INV-PRX-03).
- **Audit** Création, activation, fin, remplacement, annulation.
- **Offline** DL : règles `ACTIVE` non terminées (y compris futures) pour les produits vendables, les zones (avec ancêtres) et les sites du périmètre.
- **Intégrité** INV-PRX-02 (pas de conflit à l'activation, verrou consultatif par produit).
