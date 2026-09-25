# ADR-006 — Annulation et contre-écriture plutôt que suppression

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §40, §41 ; PM §8)
- **Date** : 24/09/2026

## Contexte
Une opération importante ne doit jamais disparaître silencieusement (CM §40). La correction d'une vente, d'un paiement, d'une réception, d'un mouvement ou d'une perte ne doit pas effacer la trace (CM §41). Le PM demande une politique table par table (PM §8).

## Décision
Six politiques (détail dans [`../03-data/03-historisation-suppression.md`](../03-data/03-historisation-suppression.md)) :

| Politique | Tables |
|---|---|
| `IMMUABLE` | Registres, audit, événements, inbox, historiques |
| `ANNULATION` | Documents (statut + contre-écritures) |
| `DESACTIVATION` | Référentiels et master data |
| `VERSIONNEMENT` | Règles, politiques, paramètres |
| `PURGE_TECHNIQUE` | Données techniques éphémères |
| `LIBRE` | Objets de confort (vues sauvegardées) |

Mise en œuvre par les droits de la base (pas de `DELETE` pour le rôle applicatif sur les tables protégées) et par des déclencheurs d'immuabilité. Les données personnelles sont pseudonymisées, jamais supprimées d'une transaction.

## Alternatives étudiées
- Soft delete générique (`deleted_at` partout) : la sémantique d'annulation (effets inverses) se perd et la ligne peut être « restaurée » sans trace.
- Suppression physique avec copie dans l'audit : histoire dispersée, requêtes complexes.

## Justification
La contre-écriture préserve les soldes et les rapports passés (un rapport de septembre n'est pas modifié par une annulation d'octobre) et rend chaque correction attribuable.

## Conséquences
Chaque document annulable porte les colonnes `[STD-CANCEL]` ; chaque registre porte `reverses_*_id`. Les annulations sont soumises aux règles de validation de leur domaine.

## Risques
Croissance des volumes (RISK-12).
