# ADR-013 — Monnaie, montants et quantités

- **Statut** : ACCEPTÉ (DÉDUIT : FCFA au CM §30 ; taxes AV-041, arrondis AV-060)
- **Date** : 24/09/2026

## Décision
- Monnaie unique **XAF** (franc CFA BEAC), sans subdivision : montants en **entiers** (`bigint`). Pas de colonne devise (H-03).
- Montants de document ≥ 0 ; le sens est porté par le type ou la colonne `direction`.
- Quantités `numeric(14,3)` en unité de base ; entières pour les unités comptées.
- Arrondi : montant de ligne = arrondi au franc (demi supérieur) de quantité × prix − remise ; total = Σ lignes (AV-060).
- CMUP stocké avec 2 décimales internes et arrondi au franc à l'usage.
- Taxes : colonnes présentes à 0, prix TTC (AV-041).
- Types et arrondis centralisés dans la bibliothèque partagée.

## Alternatives
`numeric(18,2)` pour les montants : décimales inutiles en XAF, source d'erreurs d'affichage. Multidevise : non requise.

## Conséquences
Ajouter une devise plus tard exige une colonne `currency` et des taux (impact limité, documenté en H-03).
