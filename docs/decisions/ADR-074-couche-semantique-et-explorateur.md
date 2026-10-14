# ADR-074 — Couche sémantique et explorateur : jeux déclarés, vues SQL en lecture, étendue exacte des lignes, mesures protégées, limites

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-ANA-004, 006, 007 et 009, D11 §8, NFR-12 et NFR-13 ; les choix métier sont AV-421 à AV-425, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 de la session P9 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-070](ADR-070-architecture-de-p9-communication-et-analytics.md), [ADR-035](ADR-035-tableaux-d-analyse-avant-p9.md)
- **Questions liées** : AV-013, AV-086, AV-421 à AV-425

## Contexte

D11 demande une analyse flexible de type tableau croisé (filtrer, trier, grouper, choisir les colonnes, agréger, exporter, sauvegarder) sans requête libre (BR-ANA-006). Le dictionnaire `12-analytics.md` décrit treize jeux `f_*` et prévoit un filtre de périmètre « par une fonction de sécurité au niveau des lignes » ; MySQL n'en a pas.

Faits du code :
- `listConfinementAt` (`identity`, `rights-check.ts`) rend `{ siteIds, ownerUserIds }` ou `null`. C'est un **pré-filtre sur-ensemble** destiné à précéder `evaluateAccess` document par document : il ne porte aucune zone, et `null` signifie « aucun pré-filtre possible » (portée `ALL`, ou `SITE` ou `ZONE` sous une affectation globale, de zone ou d'équipe), jamais « tout est permis ». Il n'est pas utilisable seul sur un agrégat, où l'évaluation par ligne est impossible.
- L'octroi effectif d'une permission est l'intersection de sa portée maximale et du périmètre de l'affectation (`scope-evaluation.ts`, `resourceInGrantScope`) ; `OWN` exige le titulaire **et** le périmètre de l'affectation ; `TEAM` ne passe pas par l'affectation (`isWithinTeamScope`).
- `ReadScope` (`platform/read-scope.ts`) combine sites et personnes en ET, sans zone.
- Les tables sources portent déjà des colonnes de jour métier générées et indexées : `sales_sales.business_date`, `sales_sale_cancellations.applied_business_date`, `inventory_stock_moves.business_date`, ainsi que des colonnes équivalentes sur les encaissements, les dépenses, les mouvements de trésorerie et les pertes ; `inventory_cost_entries`, `crm_visits` et `fieldwork_work_sessions` n'en ont pas (index par utilisateur ou objet et instant).
- `inventory_stock_moves`, `inventory_stock_balances`, `inventory_cost_entries`, `finance_cash_movements`, `crm_visits` n'ont ni `site_id` ni colonne de zone : le site se déduit de l'emplacement, du compte ou de l'objet de coût.

## Décision

1. **Catalogue déclaratif** dans `packages/domain` (`analytics-catalog.ts`), version numérotée. Par jeu : code, vue SQL, permissions de lecture requises (toutes), colonnes de portée, dimensions (nom, type, colonne, libellé), mesures (nom, agrégat, expression, colonne de période, `protected`), filtres admis par type, tri admis, période par défaut. Le compilateur n'accepte que ce qui est déclaré : un jeu, une dimension, une mesure ou un filtre inconnu est `ANALYTICS_FIELD_UNKNOWN`.
2. **Vues SQL en lecture** `analytics_f_*`, créées par les migrations du module `analytics` (`SQL SECURITY INVOKER`, `gic_app` : `SELECT` seulement) sur les tables des modules propriétaires, en lecture ; aucune écriture dans une table d'autrui. Chaque vue :
   - expose `business_day` comme **alias de la colonne de jour métier générée** de la table source quand elle existe, et ne calcule `CONVERT_TZ(…, '+00:00', '+01:00')` (décalage fixe) que pour les tables qui n'en ont pas ;
   - expose les colonnes de portée selon le tableau ci-dessous, dérivées une fois dans la vue, pas par la requête de l'utilisateur ;
   - porte les jointures lourdes, pour que la requête de l'utilisateur reste un `SELECT … GROUP BY` sur une seule vue.

   | Jeu | Colonnes de portée (dérivation) |
   |---|---|
   | `f_sales_line`, `f_orders` | site = `site_id` de la vente ; zone = `zone_id` ; personnes = vendeur et commercial |
   | `f_payments` | site et personnes de l'encaissement |
   | `f_stock_moves` | une ligne par mouvement ; site source et site destination ; titulaire d'un emplacement mobile ; visible si **l'une** des extrémités est dans l'étendue ; les emplacements virtuels (sans site) ne comptent pas |
   | `f_stock_balance` | site de l'emplacement ; titulaire d'un emplacement mobile |
   | `f_losses` | site de l'emplacement ; déclarant |
   | `f_prospecting` | zone du compte client (`crm_customers.zone_id`) ; utilisateur de la visite, acquéreur ou titulaire du compte |
| `f_attendance` | personne seulement (`user_id` de la session : aucune zone ni site n'est portée par la session) ; règle fermée pour les portées de site et de zone |
   | `f_production_daily`, `f_costs` | site du lot de production ; pour un coût, site déduit de l'objet de coût (lot : site du lot ; frais généraux : le site lui-même) ; auteur de l'écriture |
   | `f_expenses`, `f_cash` | site de la dépense ou du compte de trésorerie ; auteur |
   | `f_purchases` | site de réception ; auteur de la commande |

   **Règle fermée** : un jeu dont aucune colonne de portée ne permet d'exprimer le type de portée de l'utilisateur ne rend aucune ligne pour celui-ci (jamais « tout »).
3. **Grain et dates.** Une ligne de `f_sales_line` est une ligne de vente ou une ligne d'annulation **appliquée** (`status = 'APPLIED'`), datée de `applied_at` (jour `applied_business_date`), comme `saleActivityArms` (`period-activity.ts`). Elle expose **deux** colonnes de date : `business_day` (jour de l'événement) et `sale_day` (jour de la vente d'origine, repris par la jointure pour une annulation). Chaque mesure déclare la colonne de période sur laquelle porte le filtre (`revenue`, `quantity` : `business_day` ; `net_by_sale_date` : `sale_day`) ; une requête qui mêle des mesures de colonnes de période différentes est refusée (`ANALYTICS_MIXED_PERIOD_BASIS`). La dimension « lot » n'est pas portée par `f_sales_line` : une ligne se répartit sur plusieurs mouvements `SALE` (un par lot), et le CA d'un lot reste donné par `lotRevenue` (AV-424). La mesure « nombre de ventes » compte les ventes distinctes non annulées en totalité à l'instant de lecture (KPI-COM-07), pas la somme des événements.
4. **Étendue exacte des lignes (BR-ANA-004).** Une fonction `resolveExactScope(user, permission, at)` (fichier `analytics-api/analytics-scope.ts`) rend une **union de prédicats** : `ALL`, ou une liste de clauses sur `site`, `zone` (avec descendantes) et `titulaire`. Elle ne se déduit pas de `listConfinementAt`. Elle énumère les univers finis (sites de la ferme, zones, utilisateurs) et appelle `evaluateAccess` pour : chaque site (ressource `{siteId}`), chaque site avec l'utilisateur comme titulaire (`{siteId, ownerUserId: soi}`), chaque zone (`{zoneId}`) et chaque utilisateur (`{ownerUserId}`). Le résultat est **sûr par construction** : tout élément retenu est visible par un octroi pour **toute** ressource portant ce seul attribut, donc la clause ne rend jamais plus que `evaluateAccess` ; une combinaison qui exigerait le couple (site, titulaire) non énumérable (une permission `SITE` sous une affectation d'équipe) ne rend rien. L'énumération est bornée (40 sites, zones, 150 utilisateurs) et mise en cache par requête et par passe d'instantanés. Une fonction publique d'`identity` (`readScopeAt`) la remplacera sans changer le contrat (besoin B5, suivi §5). Une étendue qui ne se résout pas est **vide**, jamais `ALL`.
5. **Compilation** : le compilateur produit la clause `WHERE` de portée depuis l'union (`site IN (…)` OU `zone IN (…)` OU `titulaire IN (…)`, par clause) en plus des filtres de l'utilisateur ; `ReadScope` reçoit un mode « union » ajouté sans changer ses appelants (ET par défaut, AV-423).
6. **Requête** : `POST /api/v1/analytics/query` reçoit une définition JSON (jeu, période, filtres, dimensions, mesures, tri, limite), validée par un schéma zod puis par le catalogue, et rend les lignes, `computed_at`, la fraîcheur (BR-ANA-005) et les identifiants des documents sources (ADR-075 §6). Le compilateur ne concatène jamais de texte de l'utilisateur ; les noms de colonne viennent du catalogue, les valeurs sont des paramètres.
7. **Mesures protégées** : toute mesure exprimée en valeur au coût — coût, marge, valeur de stock, valeur d'une perte, montants d'achat, montants de coût — est marquée `protected` et exige `inventory.valuation.read` (BR-ANA-004, RC-05). L'explorateur et les exports **refusent** la requête qui la nomme (`FORBIDDEN_MEASURE`) ; les tableaux la masquent (valeur `null`, ADR-035). Chaque mesure protégée est vérifiée contre la lecture HTTP du module qui la masque déjà (pertes, achats, production) : l'explorateur refuse exactement ce que la lecture masque. Un jeu dont toutes les mesures utiles sont protégées pour l'utilisateur est refusé par la même erreur (AV-422, AV-424).
8. **Limites (BR-ANA-006)** en paramètres `analytics.*` : 10 000 lignes affichées, 100 000 lignes exportées, 15 s d'exécution (`MAX_EXECUTION_TIME`), période détaillée de trois ans au plus (`PERIOD_TOO_LONG`). Le compilateur lit `LIMIT + 1` ; **le dépassement est une erreur** `QUERY_LIMIT_EXCEEDED` avec une suggestion d'affiner, jamais un résultat tronqué en silence ; un export qui lit plus de 100 000 lignes termine `FAILED` avec ce code (ADR-077). Le total d'une requête est calculé séparément, sans `GROUP BY`, et n'est pas rendu pour une mesure non additive (comptes distincts, moyennes, ratios). La période est obligatoire pour un jeu daté ; les jeux d'état (`f_stock_balance`) lisent l'instant.
9. **Index** : ceux des tables sources suffisent là où la table porte un jour métier indexé avec le site ; P9-13 ajoute, dans une migration de sa plage, les index manquants (coûts par date, visites et sessions par date, mouvements par emplacement et date), chacun justifié par le plan `EXPLAIN` de la requête qui le motive (ADR-078 §4). Aucune vue matérialisée.
10. **Audit** : chaque requête est journalisée (utilisateur, jeu, filtres, dimensions, mesures, nombre de lignes, durée) dans `analytics_query_log` ; un refus de droit ou de limite l'est aussi (RC-09, BR-AUD-009).

## Alternatives écartées

- **Requêtes SQL libres sur un schéma d'analyse** : contraire à BR-ANA-006, exposerait les colonnes personnelles et défierait le confinement.
- **Étendue tirée de `listConfinementAt`** : c'est un pré-filtre dont `null` ne dit rien ; sur un agrégat, aucun contrôle par ligne ne le rattrape.
- **Évaluation par ligne** : impossible sur un agrégat ; l'étendue exacte est calculée avant la requête.
- **Copie des faits dans des tables `analytics_*` alimentées par événements** : double source de vérité et rattrapage des opérations tardives ; palier 2 de la stratégie, à n'ouvrir que sur mesure (ADR-078).
- **Un seul jeu « tout-en-un »** : jointures coûteuses, grain ambigu.

## Conséquences

- Ajouter un jeu ou une mesure est une modification du catalogue, d'une vue et d'un test d'équivalence (ADR-075) : trois fichiers, pas de code de requête.
- La permission de lecture du domaine **est** l'accès au jeu : `analytics.explore` ouvre l'outil, pas les données.
- Le calcul d'étendue coûte au plus quelques centaines d'évaluations de droits en cache ; la tâche d'instantanés le mutualise (ADR-076).

## Tests

Catalogue valide (toutes colonnes existent dans la vue ; migration descendante) ; **grille d'étendue** : chaque portée maximale (`ALL`, `SITE`, `ZONE`, `TEAM`, `OWN`) sous chaque affectation (globale, site, zone, équipe) — pour un échantillon de lignes, la clause compilée ne rend **jamais** une ligne que `evaluateAccess` refuse, et rend celles qu'il accepte hors combinaisons non énumérables ; étendue vide ; mesures protégées (refus exact = masquage de la lecture HTTP) ; limites (lignes, durée, période, `LIMIT + 1`) ; injection (nom de champ, tri, valeur hostiles) ; mélange de colonnes de période ; équivalence avec les fonctions publiques (ADR-075) ; mutations sur la clause de portée.
