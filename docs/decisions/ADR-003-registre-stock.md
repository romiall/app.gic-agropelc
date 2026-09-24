# ADR-003 — Registre de stock en partie double avec emplacements virtuels

- **Statut** : ACCEPTÉ (principe CONFIRMÉ CM §21 et PM §6 ; forme DÉDUITE)
- **Date** : 24/09/2026

## Contexte
Le stock ne doit jamais être une quantité modifiable ; il doit découler de mouvements traçables (CM §21 ; PM §6). La direction doit comprendre tout écart (CM §60, §62). Plusieurs familles de stock et des pertes, mortalités, consommations, productions et transferts doivent être représentées sans confusion.

## Décision
1. Table `inventory.stock_moves` en **ajout seul** : chaque mouvement déplace une quantité **positive** d'un emplacement **source** vers un emplacement **destination**.
2. Les origines et destinations externes sont des **emplacements virtuels** : `V_SUPPLIER`, `V_CUSTOMER`, `V_PRODUCTION`, `V_CONSUMPTION`, `V_LOSS`, `V_PENDING_LOSS`, `V_ADJUSTMENT`, `V_TRANSIT`, `V_OPENING`.
3. Chaque mouvement porte un type (cause), un document source, un coût unitaire figé, un lot éventuel, l'heure métier, l'auteur et l'appareil.
4. `stock_balances` est une **projection** mise à jour dans la même transaction et reconstructible ; une réconciliation quotidienne la vérifie.
5. Une correction se fait par **mouvement inverse** référencé (unique).

## Alternatives étudiées
- **Quantité modifiable** : interdit (CM §21).
- **Registre à simple entrée** (delta signé par emplacement) : pas de conservation structurelle ; totaux vendus, perdus et consommés moins lisibles.
- **Event sourcing complet** : complexité injustifiée (PM §33).

## Justification
La partie double garantit par construction la **conservation** (INV-STK-03). Elle rend le registre auto-explicatif (« où est passé le stock ? ») et répond directement aux questions « vendu où, perdu où ».

## Conséquences
- Deux sorties dans le registre pour une vente (source et destination sur une seule ligne) ; volume estimé à environ 5,5 millions de lignes par an, partitionnement prévu.
- Pertes en attente de validation représentées comme un emplacement (`V_PENDING_LOSS`), donc indisponibles immédiatement.
- Soldes « à une date métier » calculables (inventaires, rapprochements tardifs).

## Risques
RISK-05, RISK-12, RISK-24.
