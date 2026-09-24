# ADR-011 — Architecture backend : monolithe modulaire, PostgreSQL comme file, worker

- **Statut** : ACCEPTÉ (DÉDUIT de PM §34, §35)
- **Date** : 24/09/2026

## Contexte
Un produit unique avec de nombreux domaines fortement couplés par des transactions (vente = stock + caisse + créance + CRM), une petite équipe (AV-084), un besoin de frontières claires (PM §35) et de simplicité d'exploitation (PM §34).

## Décision
- **Monolithe modulaire** : un seul code et une seule image, deux processus (API, worker) ; un **schéma PostgreSQL par module** ; écriture limitée à son schéma ; appels inter-modules uniquement via API publique, dans l'unité de travail commune ; graphe de dépendances acyclique vérifié en CI.
- **Outbox transactionnelle** (`platform.domain_events`) et file de tâches **dans PostgreSQL** (`SKIP LOCKED`) : pas de courtier de messages ni de Redis au MVP.
- Effets de cohérence synchrones ; effets secondaires asynchrones (alertes, Kommo, projections).
- Inversions de dépendance : registre des commandes (`sync`), gestionnaires de décision (`approvals`).

## Alternatives étudiées
Microservices, monolithe non structuré, BFF : voir [`../05-architecture/01-architecture-logicielle.md`](../05-architecture/01-architecture-logicielle.md) §1.

## Justification
Transactions ACID pour les invariants critiques ; exploitation simple ; frontières fortes, avec l'extraction future d'un module possible.

## Conséquences
Discipline de modules outillée (analyse des imports, rôles de base par schéma). Plusieurs corrections du cadrage découlent de cette règle : encaissements dans `sales`, coûts dans `inventory`, référentiels commerciaux dans `catalog`, références universelles aux utilisateurs.

## Risques
RISK-21, RISK-25.
