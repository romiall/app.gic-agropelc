# ADR-019 — Style d'API : commandes et requêtes sur HTTP/JSON

- **Statut** : ACCEPTÉ (DÉDUIT de PM §32)
- **Date** : 24/09/2026

## Décision
Écritures = **commandes** (enveloppe unique, idempotente) via `/sync/push` (lots) ou `/commands` (unitaire) ; lectures = **REST GET** paginé par curseur ; analyse = DSL déclaratif `/analytics/query` ; fichiers = upload par morceaux ; webhooks entrants authentifiés.

## Alternatives
REST CRUD pur (états plutôt qu'intentions, incompatible avec l'offline et l'audit d'intention) ; GraphQL (pas de gain avec une outbox, sécurité par champ complexe) ; gRPC (support navigateur).

## Conséquences
Un seul modèle d'écriture en ligne et hors ligne ; OpenAPI générée depuis les schémas partagés.
