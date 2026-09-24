# ADR-010 — Comptabilité opérationnelle sans grand livre au MVP

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §31, §56 ; PM §15)
- **Date** : 24/09/2026

## Contexte
Le MVP vise une comptabilité opérationnelle fiable, pas un logiciel comptable réglementaire (CM §31, §56). L'architecture doit permettre une intégration comptable future (PM §15).

## Décision
- **Documents financiers** typés et immuables : vente, encaissement, dépense, facture fournisseur, paiement fournisseur, remise de fonds.
- **Trois registres** en ajout seul : trésorerie (`finance.cash_movements`), coûts (`inventory.cost_entries`), stock valorisé (coût figé sur `stock_moves`).
- **Vues calculées** : créances (`sales.v_receivables`), dettes (`finance.v_payables`), marges, valeur des pertes.
- **Datation** : une annulation est une contre-écriture datée de sa propre heure métier.
- Répartition par modules pour éviter les cycles : encaissements et créances dans `sales`, coûts et valorisation dans `inventory`, trésorerie, dépenses et dettes dans `finance`.

## Alternatives étudiées
- Grand livre en partie double dès le MVP : lourd, demande un plan de comptes validé par un expert (SYSCOHADA, AV-059), hors besoin exprimé.
- Aucune structure de trésorerie : ne répond pas à « où est l'argent » (CM §64).

## Justification
Répond à toutes les questions du CM §31–§33 et §62 avec un coût modéré, et prépare l'export comptable.

## Conséquences
Export comptable futur par correspondance document → écritures (stratégie finance §8).

## Risques
RISK-24.
