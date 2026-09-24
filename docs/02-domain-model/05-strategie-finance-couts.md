# Stratégie finance opérationnelle et coûts

> Complète la stratégie stock pour la dimension financière (CM §31–§33 ; PM §15). Décisions : ADR-010 (comptabilité opérationnelle), ADR-013 (monnaie), ADR-015 (valorisation). Règles : D09 (BR-FIN-*), D07 (BR-PRD-012 à 014).

---

## 1. Positionnement

GIC AGROPELC a besoin d'une **comptabilité opérationnelle fiable**, pas d'un logiciel comptable réglementaire (CM §31, §56). Le système ne tient donc **pas** de grand livre en partie double au MVP. Il tient :

1. des **documents financiers** typés et immuables : vente, encaissement, dépense, facture fournisseur, paiement fournisseur, remise de fonds ;
2. trois **registres** en ajout seul :
   - **trésorerie** (`cash_movements`) : où est l'argent ;
   - **coûts** (`cost_entries`) : ce que coûtent les lots et les sites ;
   - **stock valorisé** : le coût unitaire figé sur chaque `stock_move` ;
3. des **vues calculées** : créances, dettes fournisseurs, marges, valeur du stock, valeur des pertes.

Cette structure est « comptabilisable » plus tard (AV-059) : chaque document a un type, une date métier, un montant, un tiers et un objet de coût. Un export peut donc produire des écritures au format d'un logiciel comptable, sans ressaisie.

## 2. Correspondance physique ↔ financier (CM §32)

| Fait | Physique | Financier | Responsabilité |
|---|---|---|---|
| Vente | `SALE` emplacement → `V_CUSTOMER` (coût figé) | CA ; coût des ventes = Σ quantité × coût ; créance ou encaissement ; trésorerie `IN` | Vendeur, commercial attribué, appareil |
| Annulation de vente | Inverse du `SALE` | CA négatif daté de l'annulation ; affectations désactivées ; `REFUND` ou crédit client | Auteur, approbateur |
| Perte | `LOSS` → `V_LOSS` | Valeur perdue = quantité × coût | Déclarant, approbateur |
| Réception | `PURCHASE_RECEIPT` `V_SUPPLIER` → emplacement | Valeur d'entrée ; base de la dette (après facture) ; CMUP | Magasinier |
| Facture fournisseur | — | Dette fournisseur | Finance |
| Paiement fournisseur | — | Trésorerie `OUT` ; dette réduite | Finance, Direction |
| Consommation pour un lot | `CONSUMPTION` → `V_CONSUMPTION` | Écriture de coût sur le lot | Resp. ferme |
| Mise en place d'un lot | Reclassement | Écriture de coût `ANIMAUX` | Resp. production |
| Dépense | — | Trésorerie `OUT` (si payée) ; écriture de coût (si objet de coût) | Déclarant, approbateur |
| Écart d'inventaire | `INVENTORY_GAIN` / `INVENTORY_LOSS` | Valeur de l'écart | Compteur, approbateur |
| Écart de caisse | — | `SESSION_VARIANCE` | Vendeur, Finance |

## 3. Datation et stabilité des rapports

- Tout montant est daté par l'`occurred_at` de son document.
- Une annulation est une **contre-écriture datée de son propre `occurred_at`** (BR-FIN-042). Un rapport de septembre n'est pas modifié par l'annulation, le 3 octobre, d'une vente de septembre : l'annulation apparaît en octobre. La vue « net par date de vente » existe, explicitement libellée, pour l'analyse commerciale.
- Les opérations hors ligne tardives s'insèrent à leur date métier : un rapport passé peut donc s'enrichir d'opérations remontées tardivement. Le tableau de bord affiche la fraîcheur (BR-ANA-005). Le verrouillage de période est une option future (AV-088).

## 4. Créances et dettes

```text
créance(vente) = total − Σ affectations actives (encaissements)
créance(client) = Σ créances de ses ventes CONFIRMED − crédit client non affecté (présenté séparément)
âge = date du jour − due_date ; tranches 0-30, 31-60, 61-90, > 90 jours
dette(facture) = montant − Σ affectations de paiements fournisseurs
```

Les deux sont des **vues** (`finance.v_receivables`, `finance.v_payables`). Elles ne sont jamais stockées comme soldes saisis.

## 5. Trésorerie

- Un compte de trésorerie par caisse de PDV, par caisse d'utilisateur (commercial terrain qui encaisse), caisse centrale, compte mobile money et compte bancaire.
- Solde = Σ `cash_movements` (INV-FIN-02).
- Chaque argent reçu ou versé a un **responsable** : le détenteur du compte. Cela répond à « où est passé l'argent » (CM §64).
- Rapprochement externe (relevés mobile money et banque) : manuel au MVP, par la Finance, avec annulation ou correction tracée.

## 6. Coûts de production et marges

### 6.1 Coût d'un lot

```text
coût_lot(t) = Σ cost_entries(lot, occurred_at ≤ t)
  types : ANIMAUX (mise en place), ALIMENT, VETERINAIRE, AUTRE_INTRANT (consommations valorisées),
          DEPENSE_DIRECTE (dépenses imputées), AJUSTEMENT (correction tracée)
coût_par_tête(t) = coût_lot(t) / effectif_non_vendu(t)
```

Seuls les coûts directs sont incorporés au MVP (AV-043).

### 6.2 Exemple chiffré (lot de chair)

| Élément | Valeur |
|---|---|
| Mise en place : 2 400 poussins × 450 | 1 080 000 |
| Aliment consommé : 280 sacs × 15 000 (CMUP) | 4 200 000 |
| Vétérinaire | 180 000 |
| Dépense directe (litière, électricité imputée) | 140 000 |
| **Coût total du lot** | **5 600 000** |
| Mortalité cumulée | 90 têtes (3,75 %) |
| Têtes vendues | 2 310 |
| Coût par tête final | 5 600 000 / 2 310 ≈ 2 424 |
| CA des ventes portant le lot : 2 310 × 4 650 (prix moyen) | 10 741 500 |
| **Marge du lot** | **5 141 500** |
| Valeur économique de la mortalité (indicateur) | 90 × coût par tête au moment de chaque mort (Σ) |

Le coût figé sur chaque sortie est le coût par tête **au moment** de la sortie, et non le coût final. La marge de lot calculée par « CA − coût total » (lot clôturé) peut donc différer de « CA − coût des ventes figé ». Les deux indicateurs sont affichés et libellés :

- « marge de lot » (clôture) ;
- « marge brute des ventes » (au fil de l'eau).

C'est un choix assumé : le coût des ventes au fil de l'eau ne peut pas connaître les coûts futurs du lot.

### 6.3 Marge brute des ventes

```text
marge_brute(P, dimensions) = CA(P) − Σ (qté × unit_cost_xaf) des mouvements SALE nets de P
```

Elle est déclinable par produit, PDV, zone, commercial, canal, client et lot. Elle n'est visible qu'avec `finance.cost.read` (BR-ANA-004).

## 7. Valorisation (rappel)

Voir la stratégie stock §9. Méthode par défaut : CMUP perpétuel par produit ; coût par tête pour les produits biologiques de lot ; coût standard pour les productions internes non rattachées à un lot valorisé (AV-042).

## 8. Préparation d'une intégration comptable future (non construite)

| Document GIC | Nature d'écriture envisagée (à valider avec l'expert-comptable, AV-059) |
|---|---|
| Vente | Client / Ventes de produits |
| Encaissement | Trésorerie / Client |
| Facture fournisseur | Achats ou stock / Fournisseur |
| Paiement fournisseur | Fournisseur / Trésorerie |
| Dépense payée | Charges / Trésorerie |
| Remise de fonds | Trésorerie / Trésorerie |
| Perte, écart d'inventaire | Variation de stock / Stock |

Aucune de ces écritures n'est produite au MVP. L'architecture garantit seulement que chaque document porte les informations nécessaires : type, date, tiers, montant, objet de coût, immuabilité.
