# ADR-047 — Écrans de la finance (P8) : groupe Finance, accès par rôle, pièces des documents financiers, lectures en ligne

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; AV-298 à AV-300 ouverts avec leur défaut)
- **Date** : 15/10/2026
- **Précise** : ADR-042 (dépenses), ADR-043 (factures et paiements fournisseurs), ADR-044 (coûts et marges), ADR-046 §2 (propriétaires des pièces jointes), ADR-030 (accueil par rôle)
- **Questions liées** : AV-241, AV-263 à AV-279, AV-298 à AV-300

## Contexte

Le serveur de P8 est terminé depuis le 13/10/2026 : commandes, lectures, jeux hors ligne et règles partagées (`@gic/domain` : `expenses.ts`, `supplier-ledger.ts`). Les écrans ECR-FIN-02 à 06 et ECR-APP-05 ne sont décrits que par une ligne de l'inventaire ([`03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md)) ; la cartographie du 15/10/2026 (quatre lecteurs) relève en outre :

- aucune pièce jointe possible pour une dépense, une facture ou un paiement : ADR-046 n'admet que `GOODS_RECEIPT` et `STOCK_LOSS`, alors qu'une dépense au-delà du seuil de justificatif est refusée en ligne sans pièce (`ATTACHMENT_REQUIRED`) ;
- aucune marge par produit, point de vente ou commercial côté serveur (`/margins?group_by=` est délégué à l'explorateur de P9) ;
- le motif saisi pour accepter un écart de facture par la file de validation n'est pas relisible sur la facture ;
- la fiche `EXPENSE` servie à l'auteur ne porte ni sa demande de validation, ni son motif d'annulation, ni sa reclassification ;
- une dépense payée, en attente d'envoi, ne sort pas encore de sa caisse dans les soldes indicatifs de l'appareil ;
- les rôles de l'inventaire (FINANCE seule pour ECR-FIN-03 et 04) ne couvrent pas les droits que le RBAC donne à la Direction et aux Achats.

## Décision

1. **Groupe de menu « Finance »** dans la PWA : trésorerie (ECR-FIN-05, déplacée depuis « Ventes »), dépenses (ECR-FIN-02), factures (ECR-FIN-03) et paiements fournisseurs (ECR-FIN-04), coûts et marges (ECR-FIN-06), créances (ECR-FIN-01). Les remises de fonds de l'appareil (ECR-FIN-07) restent sous « Ventes », près de la caisse. Le menu propose un écran selon les rôles ; le serveur reste seul juge des droits.
2. **Dépenses (ECR-FIN-02)**, route `/finance/depenses` :
   - saisie **hors ligne** pour les dix rôles qui détiennent `finance.expense.record`, payée ou à payer (AV-265) ; règles de `@gic/domain` rejouées avant l'envoi (motifs de revue, statut prévisionnel, seuils lus dans `me`) ; une dépense non conforme saisie hors ligne est annoncée « en validation a posteriori » ;
   - « mes dépenses » sur l'appareil (jeu `cash`, fiche `EXPENSE`) ;
   - vue Finance **en ligne** (`GET /expenses`) : payer une dépense à payer, annuler.
3. **Pièces des documents financiers** (ADR-046 §2 complété) : propriétaires `EXPENSE` (nature `RECEIPT`) et `SUPPLIER_INVOICE` (nature `INVOICE`). La pièce est **citée** (`attachment_ids`) par l'opération, comme le bon de livraison d'une réception : c'est le justificatif exigé au-delà du seuil (dépense) ou par la politique (facture). Lecture (`GET /attachments/{id}/content`) : l'auteur, le valideur d'une demande en attente sur le document (existant), et le lecteur du document dans sa portée — dépense : `finance.expense.read` sur le site et l'auteur de la dépense ; facture : `finance.payable.read`.
4. **Factures (ECR-FIN-03) et paiements fournisseurs (ECR-FIN-04)**, en ligne seulement. La Finance saisit et agit ; la Direction lit, décide dans la file et annule un paiement décaissé (AV-277) ; le Resp. achats lit (AV-298). Les aperçus de l'appareil (rapprochement par `matchSupplierInvoice`, plan de paiement par `planSupplierPayment`) sont **indicatifs** : les tolérances, le mode « facture sans BC » et le seuil de paiement ne sont pas servis à l'appareil, le serveur tranche et l'écran rend son verdict (statut, motifs d'écart).
5. **Décisions** : `EXPENSE`, `INVOICE_MISMATCH` et `SUPPLIER_PAYMENT` restent décidées dans la file de validation (ECR-ADM-08), atteinte depuis les écrans par un lien filtré (`?types=`). Seules les actions propres au document restent dans son écran : contester, approuver ou annuler une facture (`finance.supplier_invoice.*`), affecter ou annuler un paiement, payer ou annuler une dépense. Le motif d'acceptation d'un écart décidé dans la file est recopié sur la facture.
6. **Coûts et marges (ECR-FIN-06)**, en ligne : vue d'ensemble d'une période (`GET /finance/overview`), marges des lots (détail de lot existant), pertes valorisées (`GET /losses/summary`), écritures de coût d'un lot (`GET /costs`). Les axes produit, point de vente et commercial attendent l'explorateur de P9 (une seule définition par indicateur, BR-ANA-009 ; AV-299).
7. **Trésorerie (ECR-FIN-05)** : dépenses à payer (payer, annuler), paiements fournisseurs en attente de la Direction (lecture), lien d'un mouvement `EXPENSE` ou `SUPPLIER_PAYMENT` vers son document (AV-300).
8. **Rapprochement (ECR-APP-05)**, en ligne : liste des bons de commande avec indicateurs calculés sur l'appareil (reliquat, rejeté, quarantaine, excédent, facturé au-delà de l'accepté) ; détail par `GET /purchase-orders/{id}/matching`, ses réceptions et ses factures. Aucune règle de retard propre : l'alerte de réception incomplète est celle de P9.
9. **Créances (ECR-FIN-01)**, en ligne : `GET /receivables` (P4) par ancienneté ; l'action d'accueil `RECEIVABLES` de la Finance y mène.
10. **Effets locaux** : une dépense payée en attente d'envoi sort de sa caisse dans les soldes et l'attendu indicatifs (`pendingCashMovements`, comme un encaissement ou une remise). La fiche `EXPENSE` servie à l'auteur porte aussi sa demande de validation, son motif d'annulation, sa reclassification et son imputation ; le motif d'un refus se lit dans la demande (`APPROVAL_REQUEST`, jeu `comms`).

## Conséquences

- `@gic/contracts` : `ATTACHMENT_OWNER_TYPES` étendu ; `attachments-api/attachment-access.ts` : deux règles de lecture ; ADR-046 §2 renvoie ici.
- `GET /expenses` et `/expenses/{id}` rendent les pièces de chaque dépense déposées par son auteur (P8E-03) : la vue de suivi montre le justificatif sans autre lecture, une pièce non reçue ou refusée y est annoncée comme telle. Le site et l'imputation proposés à la saisie relèvent d'AV-301. `GET /supplier-invoices` et `/supplier-invoices/{id}` rendent de même la photo de la facture déposée par son auteur (P8E-05).
- Une pièce exigée par une validation, refusée ou jamais reçue, n'est remplacée que par une pièce de l'**auteur** du document, le demandeur de la validation (`requiredAttachmentsSatisfied`, revue de P8E-05 ; AV-290) : la pièce d'un collègue, que les lectures ne présentent pas, ne lève plus l'exigence. La PWA ne propose de joindre une photo qu'à l'auteur de la dépense ou de la facture.
- La projection `EXPENSE` gagne six champs ; les appareils les reçoivent au prochain changement d'une dépense (aucune republication forcée).
- Les écrans affichent le message français du serveur pour un refus ; les avertissements d'une dépense (`EXPENSE_REVIEW_REQUIRED`, `CASH_NEGATIVE`, `CASH_SESSION_MISSING`, `LOCAL_REF_DUPLICATE`) ont leur libellé.
- Les axes de marge, les alertes (factures échues, justificatifs manquants) et le tableau Finance (ECR-ANA-05) relèvent de P9.
- Un poste de bureau de la Finance s'enregistre et s'approuve comme tout appareil (RC-02) avant d'écrire.
