# ADR-069 — Reprise d'un lot en cours : un stock d'ouverture par lot, validé par la Direction

- **Statut** : ACCEPTÉ (DÉDUIT de la décision du porteur du 08/11/2026 — questionnaire de clôture, Q42 réponse A ;
  AV-541 à AV-544 posent les points que cette décision ne tranche pas, avec leur défaut paramétrable)
- **Date** : 08/11/2026
- **Précise** : ADR-006 (rien ne disparaît), ADR-018 (décisions exécutées par le module propriétaire), ADR-027 (coût restant
  d'un lot d'animaux), ADR-053 (chargement de données par fichier) ; prolonge BR-STK-046 (inventaire d'ouverture)
- **Questions liées** : BR-PRD-016, BR-STK-046, AV-072, AV-517 (3)(b), AV-500, AV-541 à AV-544, RP-2 ;
  [`28-decisions-de-cloture.md`](../10-development-plan/28-decisions-de-cloture.md) Q42

## Contexte

La commande du stock d'ouverture (`inventory.opening.post`, AV-517) refuse les animaux, les services et les produits suivis
par lot obligatoire : le lot d'un animal naît d'une réception ou de la production. Le pilote démarre avec une ferme dont des
lots sont **déjà en élevage** à la date d'arrêt (poulets de chair en bande, pondeuses, porcs) ; ni la mise en place (elle
prend des animaux déjà en stock ou une réception, à la date de la saisie) ni le chargement par fichier (aucun type « lots »)
ne savent les reprendre. Le script de mise en service de Bonabéri écrivait directement en base le lot de poulets vifs du point
de vente : hors du pipeline, donc hors audit et hors validation. Il fallait décider comment entre le stock vivant qui existe
à la date d'arrêt. Le porteur a choisi (Q42 A) : *« un lot d'ouverture au coût déclaré, créé avec le stock et validé par la
Direction »*.

## Décision

1. **Une déclaration, pas un lot.** La commande `production.lot_opening.post` (agrégat `PRODUCTION_LOT_OPENING`) pose une
   **déclaration** dans `production.lot_openings` (statut `PENDING_APPROVAL`) et une demande de validation. **Rien n'existe
   avant la décision** : ni lot, ni lot de stock, ni mouvement, ni écriture de coût. L'`aggregate_id` de l'enveloppe est
   l'identifiant du lot qui naîtra : l'appareil le connaît d'avance, comme pour `production.lot.create`. C'est le même
   principe que le stock d'ouverture (BR-STK-046), et il évite un lot « à moitié repris » que l'écran de mise en place
   proposerait à une entrée de plus (double comptage).
2. **Contenu de la déclaration** (contrat partagé `lotOpeningPostPayloadSchema`, `packages/contracts`) : type de lot, produit
   (animal suivi par lot, de l'espèce du type : BR-PRD-001), bâtiment ou case principal d'une **ferme**, **date de mise en
   place réelle**, **effectif repris** à la date d'arrêt (entier, 1 à 1 000 000), **valeur totale déclarée** du lot (francs
   entiers, 0 à 10 000 000 F par tête) ; facultatifs : fournisseur, souche, poids moyen constaté, note. Pas de lot lié (truies
   ↔ porcelets) : chaque lot se reprend pour lui-même (AV-542).
3. **Validation.** Toujours (le stock initial valorise le bilan) : nouveau type d'opération `LOT_OPENING`, politique par défaut
   `LOT_OPENING_DEFAULT` (sans condition), **mêmes approbateurs que le stock d'ouverture** (permission d'approbation
   `inventory.count.approve` : Direction, Finance, Responsable production, Responsable de ferme sur son site, Responsable commercial sur sa zone — la liste du semis, à resserrer si le porteur le décide : AV-541). Le demandeur ne
   valide pas sa propre demande, sauf la Direction qui le déclare explicitement (BR-ADM-017). La demande porte la valeur dans
   son montant (masqué sans droit de valorisation, RC-05) ; son résumé n'en porte aucune. Une demande en attente **ne se retire
   pas** (garde de retrait) : elle est approuvée ou refusée.
4. **À l'approbation**, dans la transaction de la décision, `production` crée — par les API publiques d'`inventory`, jamais
   par ses tables — : le lot (`ACTIVE`, `start_date` = mise en place réelle, `initial_quantity` = effectif repris, numéro
   `LOT-…` de la séquence ordinaire), son lot de stock de traçabilité (`PRODUCTION_LOT`, rang FIFO = début du jour de mise en
   place), l'**entrée de reprise** (`entry_type` et `source_kind` `OPENING`, sans source), le mouvement **`OPENING_BALANCE`
   depuis `V_OPENING`** à la valeur déclarée (valeur exacte, jamais le CMUP : un lot d'animaux ne se valorise pas au CMUP,
   ADR-027) et l'écriture de coût **`ANIMAUX`** du même montant. Le coût restant, le coût par tête et la marge du lot partent
   de cette valeur, comme pour un lot né d'une mise en place. INV-PRD-01 tient : `initial_quantity` = Σ des entrées
   enregistrées = l'entrée de reprise.
5. **Au refus**, la déclaration passe `REJECTED` sans aucun effet ; une nouvelle tentative prend un autre identifiant, et le
   même identifiant rejoué est refusé (`LOT_OPENING_ID_TAKEN`) plutôt que « appliqué » sans rien créer (même précédent que
   `OPENING_ID_TAKEN`). Un état qui a changé entre la déclaration et la décision (emplacement désactivé, produit retiré,
   doublon né entre-temps) refuse la décision d'**approuver** (`ApprovalDecisionRefused`) : la demande reste en attente et la
   Direction peut la refuser.
6. **Droit et portée.** Nouveau droit `production.lot_opening.post` (portées `ALL` et `SITE`) : Administrateur et Responsable
   production partout, Responsable de ferme sur sa ferme ; le jugement de portée est celui de la ferme de l'emplacement
   (`FORBIDDEN_SCOPE` sinon). Utilisable hors ligne : la politique est alors jugée à la réception par le serveur.
7. **Idempotence et doublons.** Le rejeu d'une déclaration vivante ne fait rien de plus. Un **même lot réel** — même
   emplacement, même produit, même jour de mise en place — ne se déclare qu'une fois : une autre reprise en attente ou
   comptabilisée, ou un lot existant (saisi à l'écran de mise en place, par exemple) est refusé `LOT_OPENING_DUPLICATE`, à la
   déclaration et de nouveau à la décision. Un refus de la Direction libère le lot réel.
8. **Bornes** : garde-fous de saisie, non des seuils métier (règle 8) — l'effectif (1 000 000), la valeur par tête
   (10 000 000 F), l'ancienneté de la mise en place (1 100 jours), la date jamais postérieure à la déclaration. Constantes de
   `packages/domain` (`lot-opening.ts`), rejouées à l'identique par l'écran, le chargement par fichier et le serveur
   (ADR-021). Le seuil de validation, lui, est la politique de contrôle.
9. **Pas d'annulation après comptabilisation.** Aucun mouvement n'inverse une ouverture (`V_OPENING` n'est la destination
   d'aucun type de mouvement) : `production.lot.cancel_entry` refuse une entrée de reprise (`LOT_ENTRY_INVALID`). Un effectif
   faux se corrige par un inventaire d'animaux (`ANIMAL_COUNT_ADJUSTMENT`, validé par le Responsable production, AV-108) ; une
   valeur fausse se corrige avant la décision (refus, nouvelle déclaration). AV-543.
10. **Côté appareil.** La section « Reprise d'un lot » de l'écran ECR-PRD-04 (Responsable production) et le type de chargement
    par fichier « Lots en cours (reprise) » (`RP-2`, réservé à l'Administrateur comme le menu de chargement, essai à blanc comme
    les autres types, identifiants dérivés de l'auteur et de tout le contenu : recharger le même fichier ne déclare rien deux
    fois ; le porteur prépare le fichier de GIC, Q04 A). Les contrôles sont ceux du domaine et le contrat
    est celui du serveur : ce que le serveur refuserait est signalé d'avance.

## Ce que cette décision ne fait pas

- **Les mortalités antérieures à la date d'arrêt** ne sont pas reprises : l'effectif repris est le seul effectif initial
  (INV-PRD-01), donc le taux de mortalité d'un lot repris est calculé *depuis la reprise* (AV-542 ; `cumulativeMortalityRate`
  divise les pertes enregistrées par la somme des entrées).
- **Un stock vif sans lot de production** (animaux d'un point de vente ou d'un magasin) et **les produits à lot obligatoire**
  (vaccins, aliments à péremption) restent refusés par `inventory.opening.post` : hors de ce lot, consigné AV-544. Le stock de
  15 000 poulets vifs de Bonabéri, écrit par le script de mise en service, est conservé en l'état (Q05).
- **Le coût n'est pas ventilé** : la valeur totale est inscrite en coût `ANIMAUX` (aliments et soins déjà engagés compris) ;
  un type de coût dédié à la reprise serait un changement d'énumération et d'analyses (AV-542 (c)).
- **Aucune publication de la déclaration vers les appareils** : l'auteur la suit dans la file des validations ; le lot arrive
  par le jeu `production` à l'approbation.
- **Pas d'entrée d'audit propre à la création du lot** : l'audit est écrit par commande, la tête de la chaîne se prend en
  dernier (ADR-038) et un gestionnaire de décision n'écrit pas dans l'audit. La trace est la déclaration (commande
  `production.lot_opening.post`, auditée), la décision (commande d'approbation, auditée, avec son approbateur) et les lignes
  immuables liées à l'identifiant de la déclaration : le lot, l'entrée, le mouvement et l'écriture de coût.

## Conséquences

- Migration `20261205090000` : table `production_lot_openings` (immuable hors statut et décision, jamais supprimée), `OPENING`
  ajouté aux contraintes de `production_lot_entries` (`entry_type`, `source_kind`) et `LOT_OPENING` à celle des politiques de
  contrôle.
- `OPERATION_TYPES`, libellés (`APPROVAL_OPERATION_LABELS`, PWA), règle de décision (`APPROVAL_DECISION_SPECS`) et politique
  semée `LOT_OPENING_DEFAULT` ; droit `production.lot_opening.post` (131 droits, 564 octrois).
- `production` enregistre désormais un gestionnaire de décision (premier du module) ; il écrit ses propres tables et passe
  par `createStockLot`, `recordStockMove` et `recordCostEntry` d'`inventory` (frontières inchangées).
- Essais : domaine, contrat, serveur (pipeline réel : déclaration, approbation, refus, rejeu, doublons, portée, retrait,
  hors ligne), PWA (logique, écran, chargement par fichier, conformité de la charge au schéma du serveur).
