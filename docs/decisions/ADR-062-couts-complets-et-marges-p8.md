# ADR-062 — Coûts complets, marges des lots, valeur des pertes et vue d'ensemble financière

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-FIN-040 à 044, KPI-FIN-01 à 05 et 08, D07 l.234 « ventes des têtes et produits du lot » ; le choix métier est AV-366, à confirmer par le porteur)
- **Date** : 13/10/2026
- **Précise** : [ADR-026](ADR-026-cout-de-lot-frais-generaux-coproduits.md), [ADR-027](ADR-027-valorisation-lots-biologiques.md), [ADR-041](ADR-041-activite-par-periode-accueil-et-tableau.md) (encaissé), [ADR-060](ADR-060-depenses-p8.md) §8
- **Questions liées** : AV-042, AV-043, AV-366

## Contexte

Depuis P4, la « marge de lot » se compose dans `production-api` : CA net des ventes du lot (`lotRevenue`) moins le coût net du lot (registre de coûts). P8 y ajoute les dépenses directes (ADR-060 §8). La cartographie de P8 relève trois manques.

- **Lot abattu.** `withSales` ne passe à `lotRevenue` que le lot de stock du lot de production. Or les produits d'abattage ont leur propre lot de stock (origine `TRANSFORMATION`, ADR-027 §4). Un lot abattu puis vendu en produits affiche donc un CA nul et une marge négative, alors que D07 (l.234) compte « les ventes des têtes et produits du lot ».
- **Pertes.** Aucune lecture ne donne la valeur des pertes par produit, lot et motif (BR-FIN-044, KPI-FIN-08, AT-041). Les déclarations portent pourtant `value_xaf`.
- **Vue d'ensemble.** « Combien réellement encaissé ? » (AT-040) suppose de lire ensemble encaissé, CA, créances, dépenses et dettes, sur une même période et avec les définitions existantes.

## Décision

1. **CA d'un lot de production** (AV-366). Le CA de la marge de lot comprend :
   - les ventes de son lot de stock ;
   - les ventes des lots de stock de ses abattages (`production_slaughter_batches.stock_lot_id`).

   Les œufs (`production_egg_collections`) n'y entrent pas. Ils sortent du lot au coût standard par un crédit `PRODUCTION_TRANSFEREE` (ADR-027), qui réduit déjà le coût net du lot : ajouter leur CA compterait leur valeur deux fois.

   Mise en œuvre :
   - `production` expose les lots de stock de ses abattages enregistrés (`slaughterStockLotIds`, lecture publique) ;
   - `production-api` la passe à `lotRevenue` ;
   - les autres formules ne changent pas : marge de lot = CA net − coût net du lot, et marge brute des ventes = CA net − coût des ventes figé.
2. **Coût complet.** Le coût d'un lot est la somme de ses écritures (INV-FIN-08) :
   - mise en place, intrants consommés ;
   - dépenses imputées (`DEPENSE_DIRECTE` et les types repris de la catégorie, ADR-060 §8) ;
   - frais généraux répartis, nourris par les dépenses de site d'une espèce ;
   - crédits de production transférée.

   Pas de nouvelle formule : `GET /production/lots/:id` (détail par nature), `GET /costs` (écritures d'un objet), coût restant et coût par tête (ADR-027).
3. **Valeur des pertes** (BR-FIN-044, KPI-FIN-08). Nouvelle lecture publique d'`inventory`, `lossValueSummary`, sur les déclarations de pertes d'une période. Elle regroupe par produit, lot de production et motif, en quantité et en valeur, selon le statut de la déclaration (confirmée, en attente, non justifiée).
   - Route `GET /api/v1/losses/summary?from&to&group_by=product|lot|reason&site_id`, permission `inventory.loss.read` (sans site : portée `ALL` exigée).
   - Valeurs masquées sans `inventory.valuation.read` (RC-05).
   - C'est un indicateur, jamais une charge ajoutée au coût du lot (BR-PRD-013).
4. **Vue d'ensemble financière** (AT-040). `GET /api/v1/finance/overview?from&to`, permission `finance.payable.read` et portée `ALL`. Elle se compose dans `finance-api` à partir des lectures publiques existantes, sans nouvelle définition :
   - CA net et coût des ventes (`periodRevenue`, `sales`) ;
   - encaissé (KPI-FIN-01, `cashedSummary` d'ADR-041) ;
   - créances à la fin de la période, par tranche (KPI-FIN-02) ;
   - dépenses approuvées ou payées de la période, par catégorie (KPI-FIN-04) ;
   - dettes et avances fournisseurs (KPI-FIN-05) ;
   - soldes de trésorerie (KPI-FIN-06).

   Les montants sont masqués selon les droits du lecteur (coûts : `inventory.valuation.read`).
5. **Rejouer l'exemple de la stratégie finance** (AT-026, DoD de P8). La « dépense directe » de 140 000 passe désormais par `finance.expense.record`, imputée au lot. Les totaux restent 5 600 000 (coût), environ 2 424 (coût par tête), 10 741 500 (CA) et 5 141 500 (marge de lot), avec un détail `DEPENSE_DIRECTE` de 140 000.

## Conséquences

- La marge d'un lot abattu devient juste, sans toucher aux règles de valorisation. Seules deux additions touchent P7 et P4 : une lecture publique de `production` et la composition dans `production-api`. Elles sont signalées à la session principale.
- Le CA d'un lot sur les écrans existants change pour les lots abattus, et seulement pour eux.
- AT-040 et AT-041 se lisent chacun en une requête, sur les définitions de D11.
- Tests : `production-acceptance.test.ts` (variante dépense), `p8-acceptance.test.ts` (AT-040, AT-041, lot abattu), `inventory-loss-summary.test.ts`.

## Alternatives

- **Inclure le CA des œufs dans la marge du lot pondeur** : leur valeur serait comptée deux fois (crédit au coût standard et vente). Écartée.
- **Marges calculées dans `packages/domain`** : la composition reste une soustraction de deux lectures. Déplacer la formule n'apporte rien tant que P9 (analytics) n'existe pas.
- **Valeur des pertes ajoutée au coût du lot** : contraire à BR-PRD-013 (la mortalité répartit le coût sur moins de têtes). Écartée.
