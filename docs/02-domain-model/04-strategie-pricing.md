# Stratégie pricing

> Section 17 du format final (PM §48). Règles : D10 (BR-PRX-*). Décision : ADR-005. Invariants : INV-PRX-*, INV-VEN-05.

---

## 1. Objectifs

1. Plusieurs règles simultanées selon produit, zone, site ou PDV, catégorie de client, canal, quantité, période et campagne commerciale (CM §29 ; PM §9).
2. Résultat **déterministe**, identique sur l'appareil hors ligne et sur le serveur (INV-PRX-04).
3. Application automatique à la date d'effet, même hors ligne (CM §43).
4. Historique complet : le prix en vigueur à toute date passée est reconstructible. Aucune vente n'est réécrite (CM §30).

## 2. Modèle d'une règle

| Champ | Rôle | Obligatoire |
|---|---|---|
| `product_id` | Produit tarifé | Oui |
| `unit_price_xaf` | Prix unitaire (entier XAF) | Oui |
| `pricing_unit_code` | Unité à laquelle le prix s'applique (unité de base, conditionnement ou `KG`) | Oui |
| `zone_id` | Dimension géographique ou commerciale (tout niveau de la hiérarchie) | Non |
| `site_id` | Site ou point de vente précis | Non |
| `customer_category_id` | Type de client | Non |
| `channel_code` | Canal de vente | Non |
| `min_quantity` | Palier de quantité (dans l'unité de tarification) | Non |
| `commercial_campaign_id` | Campagne commerciale (période nommée) | Non |
| `valid_from`, `valid_to` | Période de validité `[from, to[` | `valid_from` oui |
| `priority` | Départage explicite (0 = grille standard, 100 = campagne par défaut) | Oui (défaut 0) |
| `status` | `DRAFT`, `ACTIVE`, `RETIRED`, `CANCELLED` | Oui |
| `version`, `supersedes_rule_id` | Lignée de versions | — |
| `approved_by`, `approved_at` | Activation | À l'activation |

## 3. Algorithme de résolution

```text
resolvePrice(ctx = {product_id, at, site_id?, zone_path[], customer_category_id?, channel_code?, quantity, active_campaign_ids[]}, rules):

  candidates = rules où
      r.product_id = ctx.product_id
    ∧ r.status = ACTIVE
    ∧ r.valid_from ≤ ctx.at < coalesce(r.valid_to, +∞)
    ∧ (r.site_id est nul ou = ctx.site_id)
    ∧ (r.zone_id est nul ou ∈ ctx.zone_path)             -- zone du contexte et ses ancêtres
    ∧ (r.customer_category_id est nul ou = ctx.customer_category_id)
    ∧ (r.channel_code est nul ou = ctx.channel_code)
    ∧ (r.min_quantity est nul ou ≤ ctx.quantity)
    ∧ (r.commercial_campaign_id est nul ou ∈ ctx.active_campaign_ids)

  si candidates vide → PRICE_NOT_FOUND

  trier candidates par
      priority DESC,
      specificity(r) DESC,
      coalesce(r.min_quantity, 0) DESC,
      r.valid_from DESC,
      r.id DESC                       -- déterminisme final (UUIDv7 ⇒ la plus récente)

  retourner {rule: candidates[0], unit_price: candidates[0].unit_price_xaf, specificity, reason}

specificity(r) = 32·[site] + 16·[catégorie client] + 3·profondeur(zone) + 2·[canal] + 1·[quantité min]
```

Construction du contexte :

| Élément | Source |
|---|---|
| `at` | `occurred_at` de la vente, ou de la confirmation de commande |
| `site_id` | Site du point de vente, ou site de l'emplacement source |
| `zone_path` | Zone du site pour une vente en PDV ; sinon zone du client ; à défaut zone de la session de travail ; plus tous leurs ancêtres |
| `customer_category_id` | Catégorie du client (nulle pour une vente anonyme) |
| `channel_code` | Canal déduit (BR-VEN-021) |
| `quantity` | Quantité de la ligne dans l'unité de tarification |

## 4. Conflits

Deux règles actives **A** et **B** sont en conflit si toutes les conditions suivantes sont réunies :

- même produit ;
- même priorité ;
- même spécificité ;
- périodes qui se chevauchent ;
- pour chaque dimension, les deux valeurs sont égales, ou au moins une est nulle ;
- même `min_quantity`.

Dans ce cas, un même contexte pourrait les sélectionner toutes les deux avec un départage arbitraire. L'activation de la seconde est donc refusée (`PRICE_RULE_CONFLICT`), avec la liste des règles en conflit (INV-PRX-02).

## 5. Exemples

Grille : produit « Poulet de chair vif » (P).

| Règle | Dimensions | Prix | Priorité | Spécificité |
|---|---|---|---|---|
| R1 | aucune (global) | 4 500 | 0 | 0 |
| R2 | zone Douala (profondeur 1) | 4 700 | 0 | 3 |
| R3 | zone Marché Mboppi (profondeur 2, sous Douala) | 4 800 | 0 | 6 |
| R4 | site PDV Mboppi | 4 900 | 0 | 32 |
| R5 | catégorie `REVENDEUR`, zone Douala | 4 400 | 0 | 19 |
| R6 | min 20 têtes, zone Douala | 4 300 | 0 | 4 |
| R7 | campagne « Fêtes 2026 », global | 4 200 | 100 | 0 |

| Contexte | Candidates | Choix | Pourquoi |
|---|---|---|---|
| Vente au PDV Mboppi, client anonyme, 2 têtes, hors campagne | R1, R2, R3, R4 | R4 (4 900) | Spécificité la plus haute |
| Commercial terrain, client particulier à Akwa (Douala), 2 têtes | R1, R2 | R2 (4 700) | — |
| Revendeur à Akwa, 2 têtes | R1, R2, R5 | R5 (4 400) | 19 > 3 |
| Revendeur au PDV Mboppi, 25 têtes | R1, R2, R3, R4, R5, R6 | R4 (4 900) | 32 > 19 : le PDV prime sur la catégorie. Si GIC préfère l'inverse, il faut une priorité explicite sur R5 (AV-061). |
| Même contexte pendant la campagne | + R7 | R7 (4 200) | Priorité 100 |

## 6. Historisation

| Mécanisme | Effet |
|---|---|
| Règle active immuable (INV-PRX-01) | Le passé tarifaire ne change pas |
| Remplacement : nouvelle règle + `valid_to` de l'ancienne | Frise continue des prix |
| Aucune suppression (INV-PRX-03) | « Quel était le prix le 10/09 à Douala ? » = résolution avec `at = 10/09` |
| Snapshot sur chaque ligne de vente et de commande | `price_rule_id`, `price_rule_version`, `list_unit_price_xaf`, `unit_price_xaf`, `price_source`, `override_reason_code_id`, `specificity` |

Question CM §30 « quel prix, pourquoi, quand, selon quelle règle » : ligne de vente → règle (dimensions = pourquoi, période = quand), prix catalogue vs appliqué, source (règle, prix convenu, dérogation motivée).

## 7. Hors ligne

- Jeu téléchargé : règles `ACTIVE` non terminées, y compris à date d'effet future, pour les produits vendables du périmètre (D10 §12).
- Le **même module de code** (bibliothèque partagée TypeScript, ADR-021) résout sur l'appareil et sur le serveur.
- Écart détecté à la synchronisation (règle activée après le dernier téléchargement) → vente appliquée au prix figé + anomalie `PRICE_MISMATCH` (AV-063).
- Garde-fou : si le jeu local a plus de 24 h, un bandeau d'avertissement s'affiche ; la vente n'est pas bloquée.

## 8. Dérogations

| Rôle (défaut, AV-026) | Remise maximale sans validation | Au-delà |
|---|---|---|
| `VENDEUR_PDV` | 0 % | Validation `sales.price_override.approve` |
| `COMMERCIAL_TERRAIN`, `COMMERCIAL_SEDENTAIRE` | 5 % | Idem |
| `RESP_COMMERCIAL` | 15 % | Direction |
| `DIRECTION` | illimitée | — |

Le plafond est un paramètre par rôle (`system_settings`, clé `pricing.max_discount_pct.<ROLE>`). Toute dérogation est auditée et visible dans l'analyse des écarts de prix.
