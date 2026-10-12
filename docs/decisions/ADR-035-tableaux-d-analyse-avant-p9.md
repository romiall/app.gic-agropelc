# ADR-035 — Tableaux d'analyse avant P9 : composés dans la couche de transport, périmètre tiré de la permission

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; les notions affichées restent celles de BR-DIS-010, CONFIRMÉES par CM §12)
- **Date** : 11/10/2026

## Contexte

Le plan (P5-20) livre le tableau de distribution (ECR-DIS-04, KPI-DIS-01 à 07) avant le module `analytics` (P9). ADR-030 a fixé où composer l'accueil (couche de transport `home-api/`), mais pas un tableau d'analyse. Un tableau a une permission propre (`analytics.dashboard.distribution`, 01-rbac.md §5.1) avec une portée, des périodes, des mesures réservées à certains droits, et P9 doit le reprendre sans changer son contrat. Les métriques existent depuis P5-19 dans les modules propriétaires (`inventory`, `sales`, `finance`) et dans `sync/device-freshness.ts`.

## Décision

1. **Couche de transport.** Le tableau vit dans `apps/server/src/distribution-api/` (contrôleur, service de composition, module), comme `home-api/`. Elle n'écrit rien, ne possède aucune table et n'appelle que les fonctions **publiques** des modules : `locationFlows`, `distributionKpisOf`, `allocationPositions`, `stockThresholdsOf`, `soldByLocation`, `toDeliverByLocation`, `cashedByGroup`, `cashSessionsOverview`, `pendingCashTransfers`, `cashSessionThresholdsAt`, ainsi que `devicesOfSites` et `deviceFreshness` (`sync/`, déjà hors `modules/`). Chaque fonction de métrique est appelée **une fois pour tous les PDV**, puis le service assemble. Deux lectures restent proportionnelles au nombre de PDV du périmètre : les seuils de caisse (lus site par site, en parallèle) et l'évaluation de la portée, PDV par PDV, dans le contrôleur. Un cache par zone viendra si NFR-12 l'exige. Toutes les lectures de métriques partagent **un instantané** (transaction `REPEATABLE READ`, comme `ledger-reconciliation.ts`) : le rapprochement du vendu de `sales` avec le registre ne voit jamais une vente à moitié. Les cibles d'un ensemble de PDV (sites, emplacements de vente, caisses de PDV) sont résolues une seule fois par `read-api/distribution-targets.ts`, partagé avec l'accueil.
2. **Périmètre tiré de la permission** (AV-204). Le tableau montre les PDV configurés pour lesquels `evaluateAccess` accepte `analytics.dashboard.distribution`, PDV par PDV (zone et descendance comprises).
   - Aucun PDV : réponse vide, jamais « tout ».
   - `site_id` hors portée ou inconnu : 404 audité (RC-07).

   C'est délibérément **autre chose** que le périmètre par rôle de l'accueil (ADR-030 §5) : un tableau sert une permission, l'accueil un rôle.
3. **Droits par mesure et par détail** (AV-205, AV-206), évalués PDV par PDV :
   - valeurs sous `inventory.valuation.read` ;
   - session de caisse sous `finance.cash.read` ;
   - receveurs sous `sales.payment.read` ;
   - auteurs d'un appareil sous `sync.monitor.read`.

   Une mesure ou un détail non permis vaut `null` (patron d'ADR-030 §6). Un tableau ne renvoie jamais l'erreur `FORBIDDEN_MEASURE`, réservée à l'explorateur de P9 (D11 §8).
4. **Contrat versionné.** Le contrat vit dans `packages/contracts/src/distribution-dashboard.ts` (`distributionDashboardResponseSchema`) ; le serveur le valide avant de répondre. P9 reprend la route `GET /api/v1/analytics/dashboards/distribution` et ce contrat **sans changement**.
5. **Périodes** (AV-207). Une période est nommée (BR-ANA-002, `businessPeriodOf` du domaine) ou bornée, au plus `analytics.dashboard_max_period_days` jours. Chaque notion se lit à son instant, fin de période ou instant de lecture, comme l'écrit BR-DIS-010.
6. **Une seule fonction par indicateur** (BR-ANA-009, ADR-030 §7). L'accueil de la Finance et du magasinier (AV-208) appelle les mêmes fonctions que le tableau.

## Alternatives

- **Créer le module `analytics` dès P5** : prématuré, puisque les instantanés, l'explorateur et l'ordonnanceur relèvent de P9 ; il dupliquerait aussi les requêtes des modules.
- **Composer dans un module métier** (`inventory` ou `sales`) : un module ne lit pas les tables d'un autre (règle 5 de `CLAUDE.md`), et le tableau rencontre six modules.
- **Périmètre par rôle, comme l'accueil** : contredit la matrice, qui accorde une permission avec une portée. Un vendeur cumulant deux affectations verrait les PDV d'un rôle à travers la portée d'un autre.

## Justification

Cette décision applique ADR-030 (lectures composées dans la couche de transport), ADR-008 (portée d'une permission), BR-ANA-001, 004 et 009, et la règle 5 de `CLAUDE.md` (frontières des modules).

## Conséquences

- `dependency-cruiser` n'a besoin d'aucune règle nouvelle : `distribution-api/` importe `modules/*/application/public`, `read-api/` et `sync/device-freshness.ts`, et aucun module n'importe cette couche.
- P9 déplacera la composition dans `analytics` ou l'enveloppera, sans toucher à la PWA. Les tableaux suivants (`GET /analytics/dashboards/{code}`) suivent ce patron.
- Le Resp. commercial devient affectable sur une zone (AV-204). Sinon, la portée `ZONE` de la matrice n'atteindrait aucun PDV.
- Références : ADR-030, BR-DIS-010, AV-204 à AV-209, 01-architecture-api.md §4.12, 05-architecture/02-modules.md (lectures HTTP).

## Risques

- **Fuite d'une mesure** : il faut masquer avant la validation du contrat. Les tests (`p5-distribution-metrics.test.ts`, AT-042) affirment `null` pour le vendeur et le magasinier.
- **Coût (NFR-12)** : le solde d'ouverture somme tout le registre de l'emplacement. On passera aux instantanés de soldes si la mesure l'exige (AV-207).
- **Périmètre** : un Resp. commercial affecté seulement en `TEAM` voit un tableau vide (AV-204).
