# ADR-020 — Base de données : PostgreSQL

- **Statut** : ACCEPTÉ (DÉDUIT de PM §47)
- **Date** : 24/09/2026

## Contexte
Domaine hautement relationnel, avec des invariants forts (registres immuables, unicités partielles, périodes non chevauchantes), des transactions multi-tables, du reporting et une volumétrie moyenne.

## Analyse
| Critère | PostgreSQL | MySQL 8 |
|---|---|---|
| Contraintes `CHECK`, index uniques **partiels** | Oui | CHECK oui ; index partiels non (contournements) |
| Contraintes d'**exclusion** (périodes non chevauchantes) | Oui (`btree_gist`) | Non |
| DDL transactionnel (migrations sûres) | Oui | Non |
| RLS (sécurité au niveau des lignes) | Oui | Non |
| JSONB indexable (charges techniques) | Oui | JSON, moins riche |
| Partitionnement, fonctions de fenêtre, CTE | Oui | Oui (partitionnement moins souple) |
| `uuid` natif, UUIDv7 | Type natif ; `uuidv7()` natif en version 18 | Stockage binaire à gérer |
| File de tâches `SKIP LOCKED` | Oui | Oui |
| Recherche trigramme | `pg_trgm` | Limitée |

## Décision
**PostgreSQL ≥ 16** (18 recommandé si disponible chez l'hébergeur, pour `uuidv7()` natif), en service managé avec PITR. Extensions : `btree_gist`, `pg_trgm`, `pgcrypto`. Pas de base NoSQL (PM §47).

## Conséquences
Contraintes au plus près des données ; migrations SQL versionnées ; un rôle par schéma de module.
