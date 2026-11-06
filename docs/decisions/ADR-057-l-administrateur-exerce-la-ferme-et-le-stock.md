# ADR-057 — L'Administrateur exerce la gestion de la ferme et du stock

- **Statut** : ACCEPTÉ (CONFIRMÉ : décision du porteur du 06/11/2026 ; l'étendue — ni approbation ni valorisation — est DÉDUITE de RC-03 et RC-05)
- **Date** : 06/11/2026
- **Précise** : ADR-008 (RBAC), RC-03 et RC-05 de [`01-rbac.md`](../07-security-rbac/01-rbac.md) §4
- **Questions liées** : AV-524, AV-005

## Contexte

Le porteur a constaté (06/11/2026) que, depuis son compte Administrateur, il ne pouvait ni ajouter, ni modifier, ni consulter un
lot de production : les écrans de la ferme paraissaient « statiques ». Ils ne l'étaient pas (le parcours complet a été joué en local
le même jour : création d'un lot, réception des animaux, entrée dans le lot, mortalité, aliment, pesée, fiche, transfert, perte),
mais ils étaient **réservés** : la matrice ne donnait à l'Administrateur aucune permission de production, de stock ni de
réception, et le registre des écrans (`ROLE_SETS`) ne lui proposait donc rien. Les écrans de la ferme sont en outre réservés à des
rôles de terrain affectés à un site, qu'il faut avoir créé (Administration → Organisation) avant d'y affecter quelqu'un.

Le porteur veut pouvoir apprécier, depuis son compte, **toute** la gestion de la ferme (lots, saisie du jour, collectes d'œufs,
incubations, réceptions, transferts, pertes, inventaires, consommations, seuils), avant de créer les comptes de terrain
(Responsable de production, Responsable de ferme, Magasinier).

## Décision

1. L'Administrateur reçoit **22 octrois en portée `ALL`** : production (`production.lot.read`, `.lot.manage`, `.daily.record`,
   `.incubation.record`), stock (`inventory.stock.read`, `.ledger.read`, `.transfer.request`, `.transfer.dispatch`,
   `.transfer.receive`, `.transfer.cancel`, `.loss.declare`, `.loss.read`, `.count.perform`, `.consumption.record`,
   `.threshold.manage`, `.allocation.manage`), achats (`procurement.supplier.read`, `.request.create`, `.order.read`,
   `.receipt.record`) et tableaux de bord de stock et de production.
2. **Il ne reçoit aucune permission d'approbation** (RC-03 : la séparation des tâches reste entière, l'Administrateur ne valide ni
   ses mortalités, ni ses pertes, ni ses inventaires, ni les écarts de transfert) **ni de valorisation** (RC-05 :
   `inventory.valuation.read`, coûts, marges et valeurs restent masqués). Le compte du porteur porte aussi `DIRECTION` : il valide
   ses propres opérations (`SELF_APPROVED`) ; un compte Administrateur seul dépose sans valider.
3. Le registre des écrans (`ROLE_SETS`) suit les droits : l'Administrateur voit les écrans de la ferme et du stock ; le
   **Responsable de production**, qui détenait déjà `procurement.receipt.record`, `inventory.transfer.dispatch` et
   `inventory.count.perform` en `ALL`, voit aussi les écrans de réception, de transfert et d'inventaire.
4. L'accueil de l'Administrateur propose les raccourcis « Lots de production », « Nouveau lot », « Collecte d'œufs »,
   « Incubations », « Réceptions » et « Alertes de stock » ; celui du Responsable de production gagne « Nouveau lot ».

## Conséquences

- `db/seeds/rbac-data.ts` : 53 octrois pour l'Administrateur (542 au total) ; la matrice de `01-rbac.md` §5 et sa vue condensée
  (§6) sont alignées. Une base déjà semée reçoit les 22 octrois en rejouant `pnpm run db:seed` (le kit de livraison rejoue les semis).
- Les sites de ferme et leurs emplacements doivent exister (Administration → Organisation) : sans eux, les écrans de la ferme
  s'ouvrent mais n'ont rien à montrer, ce que l'aide contextuelle de chaque page explique désormais (ADR-058).
- Essai `apps/server/test/admin-farm-rights.test.ts` : les 22 octrois sont effectifs sur un site de ferme, aucune approbation ni
  valorisation n'est accordée ; l'essai de la synthèse des pertes (`p8-costs.e2e.test.ts`) refuse maintenant le Responsable des
  achats au lieu de l'Administrateur.
- Aucune migration ; aucun changement des commandes ni des contrôles de portée du serveur (le pipeline revérifie chaque
  permission, RC-08).

## Alternatives écartées

- **Toutes les permissions de la ferme, approbations comprises** : l'Administrateur validerait ses propres mortalités et pertes ;
  contredit RC-03 et AV-010.
- **Rien de plus, comptes de terrain seulement** : le porteur ne peut pas apprécier le module avant d'avoir créé les sites et les
  comptes ; c'est le défaut constaté.
- **Un rôle « super-administrateur » distinct** : AV-004 (aucun rôle supplémentaire au lancement) ; le cumul `ADMIN` + `DIRECTION` du
  porteur donne déjà l'étendue voulue.
