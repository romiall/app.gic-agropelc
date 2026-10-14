# ADR-076 — Tableaux par rôle, tour de contrôle, instantanés personnels et jeu hors ligne `kpi`

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique D11 §7.2, §12, BR-ANA-005, NFR-12, UC-ANA-01 et 02 ; les choix métier sont AV-429 à AV-431, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-035](ADR-035-tableaux-d-analyse-avant-p9.md) (contrat « repris sans changement par P9 »), [ADR-075](ADR-075-une-seule-definition-par-indicateur-et-periodes.md)
- **Questions liées** : AV-013, AV-086, AV-202, AV-429 à AV-431

## Contexte

Le tableau de distribution (`GET /analytics/dashboards/distribution`, couche `distribution-api/`) est livré et son contrat est « repris sans changement par P9 » (ADR-035). La tour de contrôle (ECR-ANA-01) compose sept blocs (PRODUCTION, STOCK, DISTRIBUTION, VENTES, FINANCES, ÉQUIPES, ALERTES) ; les tableaux de rôle (ECR-ANA-02 à 05, ECR-CRM-05) existent en partie dans l'accueil. Hors ligne, un tableau personnel montre les indicateurs locaux de l'appareil et le dernier instantané serveur daté (`kpi_snapshots`, D11 §12). NFR-12 : p95 ≤ 3 s ; lisibilité en moins de 30 s.

Faits du code :
- La logique du tableau de distribution — résolution de la période, périmètre des PDV par `evaluateAccess` PDV par PDV, droits annexes (valorisation, caisse, paiement, supervision de synchronisation) — est **en ligne dans le contrôleur** (`distribution-dashboard.controller.ts`) et dépend de `AuthenticatedRequest` ; seule `buildDistributionDashboard` est réutilisable. `ReadAccess` lit `request.auth` et audite un refus.
- Plusieurs indicateurs de D11 n'ont pas de fonction publique (ADR-075 §1).
- `pendingApprovalsFor` est plafonné à 50 et ne rend aucun curseur ; `approvalInboxPage` pagine (`afterId`, `nextCursor`) avec une évaluation exacte par demande.
- Une indication « valeur de la période précédente » n'a de sens que pour un **flux** ; pas pour un solde ou un instant.

## Décision

1. **Famille de lectures** `GET /api/v1/analytics/dashboards/{code}` dans `analytics-api/`, un contrôleur par code : `direction` (tour de contrôle), `commercial`, `stock`, `production`, `finance` ; `distribution` reste servi par `distribution-api/` sous la même racine, sans changement de contrat. Chaque code exige sa permission `analytics.dashboard.<code>` ; le périmètre vient de l'étendue exacte de la permission (ADR-074 §4). Les mesures protégées sont masquées sans `inventory.valuation.read`, jamais en erreur (ADR-035).
2. **Forme commune** : `{ period, previousPeriod, blocks[], freshness, computedAt }`. Un bloc : `code`, `title`, `kpis[]` (code `KPI-*`, valeur, unité, lien d'exploration, alerte associée ; **valeur de la période précédente et variation pour les flux seulement** — CA, nombre de ventes, encaissé, pertes, mortalité, dépenses ; les indicateurs d'instant — valeur du stock, créances, effectifs, couverture, clients inactifs — n'en portent pas), `details[]` (lignes classées, bornées), `unavailable` (raison, quand le droit manque). Aucun bloc ne lit de table : il appelle les fonctions de référence du registre (ADR-075 §1), y compris celles que P9 crée dans les modules propriétaires.
3. **Extraction préalable.** La logique en ligne du contrôleur de distribution devient une fonction pure `resolveDashboardScope(executor, { userId, at, siteId?, productId?, period })` de `distribution-api/` (période, PDV visibles, droits annexes) ; le contrôleur, le bloc DISTRIBUTION de la tour de contrôle et la tâche d'instantanés l'appellent. Hors requête HTTP, il n'y a ni refus audité ni `AuthenticatedRequest` : un droit perdu fait **sauter** l'utilisateur. Un test de non-régression garde le schéma de réponse du tableau de distribution, et un test AT-054 égale contrôleur = bloc = instantané. Modifier `distribution-api/` (P5) est signalé au suivi §3.
4. **Tour de contrôle** : le bloc ALERTES lit `communication` par son API publique (compteurs par gravité dans l'étendue, selon l'évaluation exacte d'ADR-072 §3) ; le bloc validations en attente utilise `countPendingApprovalsFor`, bâtie sur `approvalInboxPage` (curseur) avec un plafond paramétrable `analytics.pending_approvals_count_cap` (500) et un indicateur « plus de N » : un balayage borné, pas un `COUNT` indexé. Les blocs se calculent **en parallèle** et chacun peut échouer sans faire échouer la page (`unavailable` + code d'erreur technique).
5. **Instantanés personnels** (`analytics_kpi_snapshots`, clé `(user_id, scope_key, period_key)`, `scope_key` = **code du tableau**) : une tâche `analytics.kpi_snapshots.refresh` (`analytics-api/`, INTERVAL 15 min) recalcule, pour les utilisateurs actifs titulaires d'un tableau et dont un appareil a contacté le serveur dans les `analytics.snapshot_active_days` (7) derniers jours, les trois périodes `TODAY`, `WEEK`, `MONTH` de leur périmètre.
   - Elle appelle `resolveDashboardScope` et les mêmes fonctions que les tableaux, **sous l'étendue exacte de l'utilisateur** (jamais élargie pour une réutilisation), écrase la ligne et pose `computed_at` (« à jour au »).
   - À chaque passe, elle **supprime** les lignes d'un utilisateur dont le tableau n'est plus couvert par ses droits ou sans appareil actif, et publie la suppression au flux (`DELETE`, identifiant dérivé de `(user, scope_key, period_key)` par `codeEntityId`, portée `USER`).
   - Traitement par lots d'utilisateurs de `analytics.snapshot_batch_size` (200) avec reprise ; une passe a un budget de durée (ADR-078 §3) ; elle est isolée du consommateur d'alertes.
6. **Jeu hors ligne `kpi`** (portée `USER`, ligne par `(scope_key, period_key)`) : publié par le chemin des autres jeux (`sync_change_feed`, lecteur `sync/kpi-projections.ts`, ADR-070 §6). Le contenu publié porte `computed_at` : la ligne est republiée quand le contenu change **ou** au plus toutes les heures pour la date seule, afin que « à jour au » ne soit pas trompeur. L'appareil affiche ses indicateurs locaux et, en regard, l'instantané daté ; la tour de contrôle et l'explorateur restent en ligne, avec le dernier affichage en cache et sa date.
7. **Lecture personnelle** : `GET /analytics/snapshots/me` rend les lignes de l'utilisateur authentifié, jamais celles d'un autre.
8. **Fraîcheur** : chaque tableau rend `computedAt` et les appareils en retard (`analytics.freshness_warning_hours`) ; aucune extrapolation des données manquantes (D11 §14).

## Alternatives écartées

- **Tableaux calculés sur le dernier instantané seulement** : un instantané de 15 minutes sert l'hors ligne, mais la tour de contrôle doit montrer l'état courant.
- **Instantané pour tous les utilisateurs** : la plupart n'ont ni tableau ni appareil actif ; le calcul serait du bruit.
- **Étendue élargie pour partager un instantané entre utilisateurs** : un utilisateur lirait l'instantané d'un périmètre qui n'est pas le sien.
- **Dupliquer la logique du contrôleur de distribution dans la tour de contrôle** : deux endroits où corriger une règle de périmètre ; l'extraction est un prérequis.
- **`COUNT(*)` SQL des validations en attente** : un sur-ensemble de ce que l'utilisateur peut décider (portée jugée demande par demande).

## Conséquences

- Le contrat du tableau de distribution ne change pas ; sa logique devient réutilisable.
- Un bloc indisponible est visible et explicite, pas masqué.
- Le registre des indicateurs dit, pour chaque indicateur, s'il se lit par une fonction existante ou à créer : l'estimation des incréments P9-15 et P9-16 en dépend.

## Tests

Contrat par bloc (forme, `previousPeriod` des seuls flux, `unavailable`), non-régression du schéma du tableau de distribution, cohérence avec l'accueil (ADR-075), mesure masquée sans `inventory.valuation.read`, périmètre (`OWN` ne voit que ses lignes ; utilisateur à portées multiples), tâche d'instantanés (étendue de l'utilisateur, droit retiré = lignes supprimées et `DELETE` publié, aucune ligne sans appareil actif, reprise par lots), publication du jeu `kpi` par le pull réel, compteur de validations plafonné, p95 sur le jeu de charge (ADR-078).
