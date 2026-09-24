# D16 — Catalogue et référentiels (CAT)

> Module de code : `catalog`. Domaine ajouté par cohérence : les autres domaines (VEN, STK, PRD, APP, PRX) dépendent tous d'un catalogue produit commun, que le PM §39 cite en phase 1 (« produits, catégories, unités ») sans l'isoler comme domaine.

---

## 1. Objectif

Définir **une seule fois** ce qui peut être stocké, produit, acheté, consommé ou vendu, dans quelle unité et avec quel suivi par lot. Définir aussi les listes de motifs, afin que tous les modules parlent du même produit et des mêmes causes (CM §5.1, §20, §24).

## 2. Acteurs

`ADMIN` (gestion), `DIRECTION` (validation des nouveaux produits vendables), lecture par tous.

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Catégorie de produit | `catalog.product_categories` | Arborescence d'analyse (volaille, œufs, porcs, aliments, vétérinaire, emballages) |
| Unité | `catalog.units` | Unités de mesure (tête, œuf, kg, g, L, sac, plateau, carton) |
| Produit | `catalog.products` | Article : famille de stock, unité de base, suivi par lot, drapeaux vendable / achetable / produit / consommable, mode de tarification, statut |
| Unité de conditionnement | `catalog.product_units` | Conversion d'une unité vers l'unité de base, par produit |
| Code motif | `catalog.reason_codes` | Motifs par catégorie : `LOSS`, `REJECTION`, `INVENTORY_ADJUSTMENT`, `CANCELLATION`, `PRICE_OVERRIDE`, `VISIT_OUTCOME`, `PROSPECT_LOST`, `CHECKIN_OVERRIDE`, `PRODUCTION_YIELD`, `CASH_VARIANCE` |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-CAT-01 | Créer ou modifier un produit | `catalog.product.create`, `catalog.product.update` | ADMIN | Non |
| UC-CAT-02 | Désactiver ou réactiver un produit | `catalog.product.deactivate`, `catalog.product.reactivate` | ADMIN | Non |
| UC-CAT-03 | Gérer unités, conditionnements et catégories | `catalog.unit.*`, `catalog.product_unit.set`, `catalog.category.*` | ADMIN | Non |
| UC-CAT-04 | Gérer les codes motifs | `catalog.reason_code.set` | ADMIN | Non |
| UC-CAT-05 | Consulter le catalogue | requête | Tous | **Oui** |

## 5. Entrées / 6. Sorties

**Entrées** : définitions de produits, d'unités et de motifs. **Sorties** : référentiel téléchargé sur tous les appareils, utilisé par toutes les saisies.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-CAT-001 | Un produit a un code unique, un libellé, une catégorie, une **famille de stock** (`BIOLOGIQUE`, `PRODUCTION_COMMERCIALISABLE`, `INTRANT`, `MARCHANDISE`, `EMBALLAGE_CONSOMMABLE`, `SERVICE`), une unité de base, un suivi par lot (`REQUIRED`, `OPTIONAL`, `NONE`) et les drapeaux `is_sellable`, `is_purchasable`, `is_producible`, `is_consumable`. | C (CM §20) / D |
| BR-CAT-002 | L'unité de base d'un produit est **immuable** dès qu'un mouvement existe : changer d'unité de base fausserait le registre. On crée alors un nouveau produit. | D (INV-CAT-01) |
| BR-CAT-003 | Une unité de base « à l'unité » (tête, œuf, pièce) impose des quantités **entières** en unité de base. | D |
| BR-CAT-004 | Une unité de conditionnement a un facteur de conversion > 0 vers l'unité de base, figé une fois utilisé dans une transaction (les transactions gardent la quantité en unité de base, BR-VEN-013). | D / AV-080 |
| BR-CAT-005 | Un produit de famille `SERVICE` n'a aucun effet de stock et un suivi par lot `NONE`. | AV-085 |
| BR-CAT-006 | Désactiver un produit interdit toute **nouvelle** saisie en ligne. L'historique, les soldes et les règles restent. Les opérations hors ligne antérieures à la réception de la désactivation sont acceptées (BR-VEN-030). Un produit avec un solde non nul peut être désactivé à la vente mais reste mobilisable pour les pertes, transferts et inventaires. | C (PM §30 « produit désactivé ») / D |
| BR-CAT-007 | Modifier le libellé d'un produit ne réécrit pas l'historique : les lignes de vente gardent le libellé figé (BR-VEN-013). | C (PM §7) |
| BR-CAT-008 | Un produit vendable doit avoir au moins une règle tarifaire globale active avant d'être activé à la vente (BR-PRX-009). | D |
| BR-CAT-009 | Mode de tarification par produit : `PER_UNIT` (par défaut) ou `PER_WEIGHT` (prix au kg, poids saisi à la vente). | AV-031 |
| BR-CAT-010 | Les codes motifs sont désactivables mais jamais supprimés : les opérations passées gardent leur référence. | C (PM §7) |
| BR-CAT-011 | Un produit peut porter un **coût standard** (XAF par unité de base), utilisé pour valoriser les productions internes sans lot (œufs, poussins avant rattachement). Il est historisé à chaque modification. | AV-042 |

## 8. Validations

Code produit unique ; unité de base existante ; facteur > 0 ; catégorie existante ; famille `SERVICE` incompatible avec un suivi par lot ; libellé non vide.

## 9. Dépendances

Aucune dépendance métier. Utilisé par PRX, VEN, STK, PRD, APP, FIN, ANA.

## 10. Événements produits

`ProductCreated`, `ProductUpdated`, `ProductDeactivated`, `ProductReactivated`, `ProductStandardCostChanged`, `ReasonCodeChanged`.

## 11. Événements consommés

Aucun.

## 12. Fonctionnement hors ligne

Catalogue actif complet téléchargé sur chaque appareil (quelques centaines de lignes au plus), avec unités, conditionnements et motifs.

## 13. Permissions

`catalog.product.read`, `catalog.product.manage`, `catalog.reference.manage`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Erreur d'unité de base découverte après des mouvements | Nouveau produit ; transfert du stock par reclassement (`PRODUCTION_INPUT` / `PRODUCTION_OUTPUT`) avec le motif `CORRECTION_CATALOGUE` ; ancien produit désactivé. |
| Doublon de produit | Désactivation de l'un ; reclassement du stock comme ci-dessus. |
