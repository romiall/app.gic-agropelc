# D10 — Tarification (PRX)

> Module de code : `pricing`. Stratégie détaillée (algorithme, exemples) : [`../../02-domain-model/04-strategie-pricing.md`](../../02-domain-model/04-strategie-pricing.md). Décision : ADR-005.

---

## 1. Objectif

Chaque vendeur obtient **automatiquement le bon prix** selon le contexte (produit, lieu, client, quantité, période), en ligne comme hors ligne, dès la date d'effet d'une règle et sans réunion ni appel (CM §29, §43). Le prix réellement appliqué est **conservé** avec sa justification, et aucun changement ultérieur ne réécrit les transactions passées (CM §30).

## 2. Acteurs

`RESP_COMMERCIAL` (préparation des règles), `DIRECTION` (activation, AV-062), `ADMIN` (catalogue), tous les vendeurs (consommation du prix), `system` (résolution).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Règle tarifaire | `pricing.price_rules` | Prix d'un produit dans un contexte, sur une période, avec une priorité |
| Campagne commerciale | `pricing.commercial_campaigns` | Période commerciale nommée qui regroupe des règles |
| Catégorie de client, canal | `catalog.customer_categories`, `catalog.sales_channels` | Dimensions tarifaires (référentiels partagés du catalogue) |
| Zone, site | `organization.zones`, `organization.sites` | Dimensions tarifaires (propriété de l'organisation) |
| Prix figé sur la transaction | `sales.sale_lines`, `sales.sales_order_lines` | Snapshot (propriété des ventes) |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-PRX-01 | Préparer une règle (brouillon) | `pricing.rule.draft` | RESP_COMMERCIAL, DIRECTION | Non |
| UC-PRX-02 | Activer une règle (publication, date d'effet immédiate ou future) | `pricing.rule.activate` | DIRECTION | Non |
| UC-PRX-03 | Remplacer une règle (nouvelle version) | `pricing.rule.supersede` | RESP_COMMERCIAL (brouillon) → DIRECTION (activation) | Non |
| UC-PRX-04 | Mettre fin à une règle à une date | `pricing.rule.end` | DIRECTION | Non |
| UC-PRX-05 | Créer une campagne commerciale | `pricing.campaign.create` | RESP_COMMERCIAL, DIRECTION | Non |
| UC-PRX-06 | Résoudre un prix (vente, commande, simulateur) | fonction partagée `resolvePrice(context)` | Moteur (appareil et serveur) | **Oui** |
| UC-PRX-07 | Consulter la grille et l'historique des prix d'un produit | requête | Vendeurs (prix applicables), responsables (grille) | **Oui** (prix applicables) |

## 5. Entrées

Décisions tarifaires : produit, prix, contexte, période, priorité. Contexte de vente : produit, `occurred_at`, site, zone, catégorie du client, canal, quantité.

## 6. Sorties

Prix résolu avec : règle et version, prix catalogue, spécificité, motif de choix. Grille tarifaire en vigueur. Historique des prix. Jeu de règles téléchargé sur les appareils.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-PRX-001 | Une règle tarifaire porte : produit (obligatoire), prix unitaire en XAF entiers, unité de tarification (unité de base, unité de conditionnement ou kilogramme), et des **dimensions optionnelles** : zone, site (y compris un PDV), catégorie de client, canal, quantité minimale, campagne commerciale. Elle porte aussi une période de validité `[valid_from, valid_to[` (`valid_to` optionnel) et une priorité entière. | C (CM §29 ; PM §9) |
| BR-PRX-002 | Plusieurs règles peuvent exister simultanément pour un même produit. | C (PM §9) |
| BR-PRX-003 | Une règle **candidate** pour un contexte : même produit ; statut `ACTIVE` ; `valid_from` ≤ `occurred_at` < `valid_to` ; chaque dimension renseignée correspond au contexte. La zone correspond si elle est la zone du contexte ou l'un de ses ancêtres. La quantité minimale doit être ≤ la quantité de la ligne. La campagne doit être active à `occurred_at`. | D (PM §9) |
| BR-PRX-004 | Choix entre candidates, dans l'ordre : priorité la plus haute ; puis **spécificité** la plus haute ; puis quantité minimale la plus haute ; puis `valid_from` le plus récent ; puis identifiant le plus grand, ce qui rend le résultat déterministe. | D (PM §9) |
| BR-PRX-005 | Spécificité = Σ des poids des dimensions renseignées : site 32 ; catégorie de client 16 ; zone 3 × profondeur (1 à 4, donc 3 à 12) ; canal 2 ; quantité minimale 1. Ainsi une règle de PDV prime sur une règle de zone, et une règle de quartier sur une règle de ville. | D / AV-061 |
| BR-PRX-006 | **Conflit interdit** : l'activation est refusée (`PRICE_RULE_CONFLICT`) si une autre règle active du même produit, de même priorité et de même spécificité, a une période qui chevauche et qu'aucune dimension ne les distingue (aucune dimension renseignée des deux côtés avec des valeurs différentes). | D (PM §9 « conflits entre règles ») |
| BR-PRX-007 | Une règle active est **immuable**, sauf pour avancer sa date de fin. Changer un prix = activer une nouvelle règle qui **remplace** l'ancienne (`supersedes_rule_id`). L'activation du remplaçant fixe automatiquement le `valid_to` de l'ancienne à son propre `valid_from`. | C (CM §30 ; PM §7) |
| BR-PRX-008 | Aucune règle n'est supprimée. Un brouillon abandonné passe `CANCELLED`, une règle terminée `RETIRED`. Le prix en vigueur à toute date passée est reconstructible. | C (CM §30) |
| BR-PRX-009 | Un contexte sans règle candidate donne `PRICE_NOT_FOUND` : la vente est bloquée, sauf dérogation de prix permise (BR-VEN-015). Tout produit vendable doit avoir une règle globale, sans dimension (contrôle d'activation du produit). | D |
| BR-PRX-010 | L'activation exige `pricing.rule.activate`. Préparer un brouillon exige `pricing.rule.draft`. | AV-062 |
| BR-PRX-011 | Une règle peut être activée avec une date d'effet **future**. Elle est téléchargée à l'avance sur les appareils concernés, qui l'appliquent automatiquement à sa date d'effet, même hors ligne. | C (CM §29, §43) / D |
| BR-PRX-012 | À l'activation, une note de direction peut être publiée automatiquement pour informer les équipes (option cochée par défaut) ; la note n'est pas la source du prix. | C (CM §43) |
| BR-PRX-013 | Le moteur de résolution est **une seule implémentation**, partagée par l'appareil et le serveur, pour garantir le même résultat hors ligne et en ligne. | D (ADR-021) |
| BR-PRX-014 | Chaque ligne de vente et de commande fige : `price_rule_id`, `price_rule_version`, prix catalogue résolu, prix appliqué, source du prix et motif de dérogation éventuel (BR-VEN-013). | C (CM §30 ; PM §9) |
| BR-PRX-015 | Une campagne commerciale a un nom, une période et un statut. Ses règles portent en général une priorité supérieure (100 par défaut) à celle de la grille standard (0). | C (PM §9) / D |
| BR-PRX-016 | Une « saison » (CM §29) se modélise par une campagne commerciale ou par la période de validité d'une règle, sans dimension spécifique. | D |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Prix > 0, entier ; produit vendable ; unité valide pour le produit | `PRICE_RULE_INVALID` |
| `valid_to` > `valid_from` ; `valid_from` ≥ maintenant − 5 minutes à l'activation (pas de règle rétroactive) | `PRICE_RULE_PERIOD_INVALID` |
| Dimensions cohérentes : le site appartient à la zone si les deux sont renseignés ; campagne active sur la période | `PRICE_RULE_DIMENSIONS_INVALID` |
| Conflit (BR-PRX-006) | `PRICE_RULE_CONFLICT` |

## 9. Dépendances

ADM (zones, sites), CAT (produits, unités, catégories de client, canaux de vente — référentiels commerciaux partagés). Utilisé par VEN, DIS, ANA (écarts de prix), KOM (informatif).

## 10. Événements produits

`PriceRuleDrafted`, `PriceRuleActivated`, `PriceRuleSuperseded`, `PriceRuleEnded`, `CommercialCampaignCreated`.

## 11. Événements consommés

`ProductDeactivated` (alerte si des règles actives restent), `ZoneUpdated` (aucun effet sur les règles : le rattachement se fait par identifiant de zone).

## 12. Fonctionnement hors ligne

- Téléchargement de toutes les règles `ACTIVE` dont la période n'est pas terminée (y compris celles à date d'effet future) pour les produits vendables du périmètre. Filtrage : zones du périmètre et leurs ancêtres, sites du périmètre, toutes les catégories de client, tous les canaux.
- Résolution locale avec le moteur partagé.
- Fraîcheur : si le jeu de règles local n'a pas été rafraîchi depuis plus de 24 h, un bandeau « prix peut-être non à jour » s'affiche ; la vente n'est pas bloquée (AV-063).

## 13. Permissions

`pricing.price.read`, `pricing.rule.draft`, `pricing.rule.activate`, `pricing.campaign.manage`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Règle activée pendant qu'un appareil est hors ligne | Ventes hors ligne à l'ancien prix : acceptées, anomalie `PRICE_MISMATCH` (BR-VEN-029). |
| Erreur de saisie d'un prix actif | Nouvelle règle de remplacement immédiate. Les ventes déjà faites au mauvais prix restent telles quelles ; la correction commerciale éventuelle passe par une annulation ou un geste client, à décider par un responsable. |
| Deux campagnes simultanées sur un même produit | La priorité les départage ; à priorité égale sans dimension distinctive, activation refusée (BR-PRX-006). |
