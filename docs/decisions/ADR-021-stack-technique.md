# ADR-021 — Stack technique : TypeScript de bout en bout et bibliothèque métier partagée

- **Statut** : PROPOSÉ (recommandation de fin de cadrage, PM §46) — à confirmer avant P0
- **Date** : 24/09/2026

## Contexte
La même logique doit s'exécuter sur l'appareil hors ligne et sur le serveur : validation des commandes, moteur de prix, politiques, disponibilité, arrondis. Petite équipe, appareils modestes, PWA.

## Décision
- **TypeScript** partout. Monorepo : `apps/pwa`, `apps/server`, `packages/domain` (bibliothèque métier partagée), `packages/contracts` (schémas de commandes et de jeux), `db/migrations`.
- PWA : React + Vite, plugin PWA (Workbox), Dexie (IndexedDB), schémas zod, i18n.
- Serveur : Node.js LTS, NestJS (adaptateur Fastify) organisé en modules, Kysely (SQL typé), migrations SQL, pg-boss (tâches sur PostgreSQL), argon2, jose.
- Détail et alternatives : [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md).

## Alternatives
Serveur Python/Django (ORM mature, mais duplication de la logique métier en JS pour l'offline) ; Kotlin/Java (idem) ; Flutter (application native, abandon de la PWA).

## Justification
Un seul langage = moteur de prix et validations **identiques** hors ligne et en ligne (INV-PRX-04) ; écosystème mature ; recrutement facilité.

## Risques
RISK-21, RISK-23 (poids du bundle React : budget NFR-05 en CI ; repli possible sur Preact compat).
