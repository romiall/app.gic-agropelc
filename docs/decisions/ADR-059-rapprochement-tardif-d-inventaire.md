# ADR-059 — Rapprochement tardif d'inventaire et répartition de l'écart d'une ligne sans lot

- **Statut** : ACCEPTÉ (DÉDUIT ; AV-527 pose les questions que cette décision ne tranche pas)
- **Date** : 07/11/2026
- **Précise** : ADR-003 (registre en partie double), ADR-006 (rien ne disparaît), ADR-038 (ordre de verrouillage)
- **Questions liées** : BR-STK-042 à BR-STK-045, INV-STK-09, AT-021, WF-08, S-23, AV-527 ; REQ-043 ;
  [`03-strategie-stock.md`](../02-domain-model/03-strategie-stock.md) § 8

## Contexte

Un fait saisi hors ligne (une vente, une réception) garde sa date et peut arriver après la comptabilisation d'un inventaire
dont le comptage lui est postérieur. Le solde du registre à `counted_at` n'est alors plus la quantité comptée
(INV-STK-09) et l'écart « réellement inexpliqué » de l'inventaire est faussé. Les phases P2 et suivantes avaient laissé
BR-STK-044 (rapprochement tardif) et BR-STK-045 (répartition de l'écart d'une ligne sans lot sur les lots) « hors
périmètre, documentés et non simulés » (`count-commands.ts`, démonstration de P2 § 4, S-23), avec l'échéance « avant la mise
en production de R1 » : les inventaires réels du pilote en dépendent.

Deux défauts voisins se voyaient dans le même code : l'ajustement d'une ligne sans lot n'indiquait pas de lot, donc une perte
était imputée par le FIFO du serveur aux lots d'aujourd'hui, alors que le théorique de la ligne ne portait que sur le solde
sans lot (le solde compté ne pouvait pas devenir exact) ; et le théorique se lisait en lecture simple, qui sous l'isolation
répétable ne voit pas ce qu'une transaction concurrente a validé pendant l'attente des verrous de solde.

## Décision

1. **Le rapprochement est dans l'enregistreur de mouvements.** `recordStockMove` est le chemin d'écriture unique du registre :
   après chaque mouvement, pour chaque extrémité physique, il cherche les lignes comptées du produit dans l'emplacement dont
   le comptage est égal ou postérieur à l'`occurred_at` du mouvement, d'inventaires `POSTED` hors stock d'ouverture. Un
   mouvement du jour n'en trouve aucune (index `(product_id, counted_at)`, une lecture vide).
2. **Une seule ligne compense : la plus ancienne qui couvre le lot du mouvement.** L'ajustement est daté de son comptage, donc
   il rétablit aussi les soldes de tous les comptages postérieurs (le fait et son ajustement s'annulent à toute date après
   le comptage). Le calcul est un **delta absolu** : compté moins le solde de la portée de la ligne à `counted_at`, tous
   mouvements compris ; il ne suppose donc pas que les rapprochements précédents ont tous eu lieu.
3. **L'ajustement est un `INVENTORY_GAIN` ou `INVENTORY_LOSS` ordinaire** : motif du système `RAPPROCHEMENT_INVENTAIRE`
   (catégorie `INVENTORY_ADJUSTMENT`, semé, jamais proposé au compteur), acteur le compte système, `source_doc` = l'inventaire,
   `source_line` = la ligne. Il ne se rapproche pas à son tour (`skipLateReconciliation`). Sa valeur est celle d'un ajustement
   (coût déclaré = CMUP courant pour un gain, coût par tête d'un lot d'animaux).
4. **Le lot de l'ajustement est celui du fait tardif** quand la ligne porte sur tous les lots ; celui de la ligne sinon. Le
   solde de ce lot revient à ce qu'il était.
5. **Portée d'une ligne (BR-STK-045).** Une ligne désigne un lot (`LOT`), ou porte sur le seul solde sans lot (`NO_LOT`), ou,
   sans lot, sur **tous les lots du produit** (`ALL_LOTS`, colonne `all_lots`) : seulement si le produit a des soldes par lot
   dans l'emplacement et si le même inventaire ne compte aucun lot de ce produit. L'écran « une ligne par lot plus une ligne
   pour le reste sans lot » garde donc sa lecture. Pour `ALL_LOTS`, le théorique est le total des soldes et l'écart se répartit
   en FIFO inverse : un gain va au lot le plus récent ; une perte prend les lots du plus ancien au plus récent, chacun dans la
   limite de son solde, le dépassement allant au lot le plus récent comme le manque d'une sortie (BR-STK-018). La répartition
   est pure et partagée (`packages/domain/src/inventory-count-reconciliation.ts`). Les ajustements sont **toujours explicites
   sur le lot** (`null` = sans lot, jamais résolu par le FIFO) : c'est ce qui rend INV-STK-09 vrai pour une ligne sans lot.
6. **À la comptabilisation**, immédiate ou à la décision d'un inventaire à valider, les ajustements de l'écart figé sont posés
   (répartis sur les soldes par lot d'aujourd'hui à `counted_at` pour `ALL_LOTS`), puis une passe vérifie chaque ligne : un
   fait daté d'avant le comptage entré entre la soumission et la décision, ou validé par une transaction concurrente, se
   rapproche comme un fait tardif. L'écart approuvé n'est pas modifié : la dérive est une ligne de rapprochement visible.
7. **Lectures verrouillantes** (`FOR SHARE`) pour le théorique, la recherche des lignes et le solde de rapprochement : une
   lecture simple après l'attente d'un verrou verrait l'instantané périmé de la transaction (mêmes raisons que pour les
   verrous de lecture des zones et des équipes).
8. **Écart net.** La ligne cumule `reconciled_adjustment_qty_base` (signé) ; l'inventaire cumule
   `net_variance_after_reconciliation_xaf` (écart constaté plus valeur des rapprochements, mesure financière RC-05 masquée sans
   droit de valorisation). L'écart constaté (`variance_*`) ne change jamais. L'inventaire est republié aux appareils (jeu
   `counts`) avec la quantité rapprochée par ligne.
9. **Pas d'entrée d'audit dédiée.** L'écriture d'audit prend la tête de la chaîne et ne peut pas se faire au milieu d'un
   gestionnaire (ADR-038 : la tête est prise en dernier). La trace est le registre, immuable : acteur système, ligne et
   inventaire d'origine, motif, date d'enregistrement ; le fait qui l'a déclenchée a sa propre entrée d'audit.

## Conséquences

- INV-STK-09 devient vrai pour tout inventaire comptabilisé et est balayé par l'essai `inventory-late-reconciliation.test.ts`
  (WF-08 chiffré, AT-021, lots, répartition, inventaire à valider, deux comptages, transaction concurrente).
- Un fait tardif est un peu plus coûteux : deux lectures d'index en plus par extrémité physique ; avec un comptage postérieur,
  quelques sommes sur le registre de l'emplacement et du produit. Les lectures verrouillantes peuvent produire un interblocage
  (1213) avec un mouvement concurrent du même couple ; le pipeline relance (`RETRY_LATER`).
- Les lignes d'avant la livraison gardent la portée qu'elles avaient (`all_lots` à 0).
- Limites connues (AV-527) : un rapprochement n'est pas audité à part ; la répartition d'un total sans détail est un choix du
  serveur que le compteur ne voit pas avant la comptabilisation ; une ligne `ALL_LOTS` rapprochée d'un fait tardif garde le
  total exact mais peut laisser un lot isolé au-dessous de zéro.
