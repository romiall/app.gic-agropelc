# ADR-061 — Factures et paiements fournisseurs : rapprochement, quantités facturées, avoir, validation avant décaissement, dettes et verrous

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-FIN-030 à 033, SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT, WF-09, INV-FIN-07 ; les choix métier sont AV-358 à AV-364, à confirmer par le porteur)
- **Date** : 13/10/2026
- **Précise** : [ADR-038](ADR-038-ordre-de-verrouillage-global.md) (rangs des documents de P8 et des bons de commande), [ADR-018](ADR-018-validations-generiques.md) (types de décision `INVOICE_MISMATCH`, `SUPPLIER_PAYMENT`) ; tranche l'écart D08 / D09 sur l'écrivain des quantités facturées
- **Questions liées** : AV-041, AV-053, AV-054, AV-055, AV-358 à AV-364

## Contexte

P6 a livré bons de commande et réceptions. Le rapprochement (`GET /purchase-orders/{id}/matching`) expose `invoicedQtyBase` à 0 et `paidXaf` à `null` « jusqu'à P8 ». La colonne `procurement_purchase_order_lines.invoiced_qty_base` existe, mais rien ne l'écrit. D08 (l.93) fait consommer à `procurement` l'événement `SupplierInvoiceRecorded`, tandis que D09 (l.171) fait lire à `finance` l'API publique de `procurement`. Le graphe interdit `procurement` vers `finance`. Restent à fixer :
- le rapprochement à l'enregistrement d'une facture (BR-FIN-031) ;
- l'avoir de WF-09 (« 98 puis 95 ») ;
- le paiement au-delà du seuil (BR-FIN-033) et les affectations (INV-FIN-07) ;
- les dettes (BR-FIN-032, `v_payables`) ;
- l'ordre des verrous des nouveaux documents.

## Décision

1. **Commandes**, toutes en ligne seulement (SM : « aucune transition hors ligne ») ; un `captured_offline` est refusé `ONLINE_REQUIRED`. Permission entre parenthèses.
   - Factures :
     - `finance.supplier_invoice.record` (`finance.supplier_invoice.record`) ;
     - `.dispute`, `.approve`, `.cancel` (`finance.supplier_invoice.approve`).
   - Paiements :
     - `finance.supplier_payment.record` et `.allocate` (`finance.supplier_payment.record`) ;
     - `.cancel` : l'auteur avec `finance.supplier_payment.record` tant que le paiement attend sa validation, puis `finance.supplier_payment.approve`.
   - Décisions `INVOICE_MISMATCH` (nouveau type, CHECK des politiques recréé) et `SUPPLIER_PAYMENT`, avec leurs gestionnaires dans `finance`.
2. **Rapprochement, règle pure dans `packages/domain`** (`matchSupplierInvoice`, BR-FIN-031, AV-053). Pour chaque ligne rattachée à une ligne de BC :
   - quantité facturée cumulée (factures déjà approuvées, colonne `invoiced_qty_base`) + quantité de la ligne ≤ quantité acceptée ;
   - prix unitaire = prix du BC.

   Les tolérances sont des paramètres, nulles par défaut :
   - `finance.invoice_match_qty_tolerance_pct` ;
   - `finance.invoice_match_price_tolerance_xaf`.

   Les autres écarts suivent :
   - une ligne hors BC, un fournisseur différent de celui du BC, ou un total imprimé différent de la somme des lignes, sont des écarts ;
   - une facture sans BC est mise en revue (`finance.invoice_without_po_mode` = `REVIEW`, AV-358) ;
   - revue de P8-14 : un produit saisi différent de celui de la ligne de BC est un écart (`PRODUCT_MISMATCH`) ; une ligne de réception citée doit être comptabilisée (`POSTED`), sinon `PO_LINE_MISMATCH`.

   Résultat : `APPROVED` si conforme. Sinon `MISMATCH`, avec le détail dans `mismatch_details` et une demande `INVOICE_MISMATCH` sous la politique `INVOICE_MISMATCH_DEFAULT` (`finance.supplier_invoice.approve`). Une facture arrivée avant la réception est donc en `MISMATCH` (D09 l.192).
3. **Quantités facturées : écrites par `procurement`, appelé par `finance`** (option A ; tranche D08 l.93 contre D09 l.171).
   - `procurement` expose `lockOrderForInvoicing(uow, orderId)` (en-tête puis lignes du BC verrouillés, prix, accepté, déjà facturé) et `applyInvoicedQuantities(uow, {orderId, lines:[{poLineId, deltaBase}]})`, qui met à jour `invoiced_qty_base` (les lignes de BC n'ont pas de version). Le propriétaire écrit donc sa table. Le rapprochement se fait sous ce verrou : deux factures concurrentes sur les mêmes lignes se rapprochent l'une après l'autre (P8-07).
   - `finance` l'appelle dans sa transaction : `+` quand une facture devient `APPROVED`, `−` quand une facture approuvée est annulée.
   - Une facture en `MISMATCH` ou `DISPUTED` ne compte pas. Deux factures pour la même quantité ne passent donc jamais sans décision.
   - Précision de la revue de P8-14 : la décision doit être informée. À l'approbation d'une demande `INVOICE_MISMATCH`, le rapprochement est refait sous le verrou du BC, avec le facturé courant. Si l'accepté serait dépassé sur une ligne où l'écart enregistré à la saisie ne le disait pas (une autre facture approuvée entre-temps), la décision est refusée (`INVOICE_MATCHING_CHANGED`). Le chemin est alors : rejet de la demande, puis approbation directe et motivée de la facture contestée.
   - Le rapprochement de P6 affiche ainsi le facturé réel (en quantité). Le payé (`paidXaf`) est composé dans la couche de transport, par une lecture publique de `finance` : `procurement` n'importe pas `finance`.
4. **Avoir** (WF-09, AV-359, en lien avec AV-054). L'avoir est l'annulation motivée de la facture contestée (`.cancel`), suivie de la facture rectificative du fournisseur.
   - La référence fournisseur est unique parmi les factures non annulées (unicité partielle par colonne générée). La rectificative peut donc reprendre la même référence. Revue de P8-14 : le contrôle compare les références sans casse ni ponctuation (« FA-0012 », « fa 0012 » et « FA0012 » sont la même facture). L'unicité en base reste exacte.
   - L'historique « facturé 98 puis 95 » reste lisible : deux documents, dont un annulé avec son motif.
   - Un avoir sur une facture déjà payée passe d'abord par l'annulation du paiement.
   - Pas d'entité « avoir » au MVP.
5. **Décision sur un écart.**
   - `approvals.request.approve`, ou la façade `finance.supplier_invoice.approve` (sur la demande en cours ou sur une facture `DISPUTED`) : la facture passe `APPROVED`, la dette vaut le montant facturé, les quantités facturées sont appliquées. Un motif est exigé et l'approbateur doit être différent de l'auteur.
   - `.dispute`, ou le rejet de la demande : la facture passe `DISPUTED`, la demande en cours étant retirée.
   - Revue de P8-14 : par la commande générique `approvals.request.approve`, même avec `selfApproved`, l'auteur de la facture ne peut pas approuver son écart (`SELF_APPROVAL_FORBIDDEN`). La règle vaut aussi pour la validation d'un paiement (§6).
   - `.cancel` : depuis `MISMATCH`, `DISPUTED` ou `APPROVED` sans paiement affecté, avec un motif.
6. **Paiement** (BR-FIN-033, AV-055, AV-362, AV-363).
   - Au-delà de `finance.supplier_payment_approval_xaf` (500 000, strict) : le paiement passe `PENDING_APPROVAL`, avec une demande `SUPPLIER_PAYMENT` sous la politique `SUPPLIER_PAYMENT_DEFAULT` (`finance.supplier_payment.approve`, Direction). Aucun décaissement à ce stade.
   - Les affectations demandées sont enregistrées `PLANNED` et revérifiées à l'approbation : une facture payée ou annulée entre-temps fait refuser la décision (`ALLOCATION_EXCEEDS`, ou `ALLOCATION_INVALID` pour une facture soldée ou annulée). Sans politique `SUPPLIER_PAYMENT` active, un paiement au-delà du seuil est refusé (`CONTROL_POLICY_MISSING`) : la commande est en ligne, rien n'est encore décaissé.
   - À l'approbation : décaissement daté de la décision, affectations `ACTIVE`, statut des factures recalculé.
   - Sous le seuil : `RECORDED` tout de suite.
   - Le moyen de paiement doit être compatible avec le type du compte (`defaultAccountType` du moyen, `ESPECES` vers une caisse). En ligne, une caisse `CAISSE_*` ne devient jamais négative. Une caisse de PDV exige une session ouverte (ADR-060 §5).
7. **Affectations et avances** (INV-FIN-07, BR-FIN-032).
   - Σ affectations `ACTIVE` d'une facture ≤ son total. `paid_xaf` est la somme dénormalisée, avec la contrainte `paid_xaf ≤ total_xaf`.
   - Le reste d'un paiement est une avance (`unallocated_xaf`), admise si `finance.supplier_advance_allowed` (vrai par défaut, AV-055) ; sinon `SUPPLIER_PAYMENT_EXCEEDS`.
   - `finance.supplier_payment.allocate` affecte plus tard une avance à une facture approuvée. Revue de P8-14 : un complément sur une facture déjà affectée par ce paiement regroupe les deux montants. L'affectation précédente est contrepassée et la nouvelle porte le cumul (une seule affectation active par facture et par paiement), et le payé n'augmente que du complément. Avant ce correctif, l'unicité refusait le complément par une erreur prise pour transitoire.
   - Une affectation est immuable sauf son passage à `REVERSED` (date, auteur, motif).
   - `.cancel` d'un paiement enregistré passe par la Direction, sans demande séparée (AV-364) : mouvement inverse, affectations `REVERSED`, factures recalculées.
8. **Dettes** (KPI-FIN-05).
   - La vue `finance_v_payables` porte les factures `APPROVED` et `PARTIALLY_PAID`, avec leur solde.
   - L'échéance est celle de la saisie, sinon la date de facture + `payment_terms_days` du fournisseur, sinon la date de facture (AV-360).
   - L'ancienneté réutilise `receivableAging` de `packages/domain` (mêmes tranches que les créances).
   - `GET /payables` ajoute les avances par fournisseur.
9. **Ordre des verrous** (complète ADR-038, rang N2 « documents racines »). Ordre : paiement fournisseur, puis factures fournisseurs (triées par id), puis dépense, puis en-tête du BC, puis lignes du BC (triées par id). Viennent ensuite les rangs existants : comptes de trésorerie (N9), session (N10), demandes et conflits (N11), compteur (N12), demande décidée (N13).
   - Une facture neuve n'est qu'insérée : l'enregistrement verrouille le BC (via `applyInvoicedQuantities` à l'approbation) sans attendre une autre facture.
   - Une réception de P6 verrouille l'en-tête puis les lignes du BC, sans document de `finance` : aucun cycle.
   - `decideApprovalRequest` lit la demande sans verrou, puis appelle le gestionnaire qui verrouille le document, et met à jour la demande en dernier : l'ordre est respecté.
10. **Numérotation**. `FF` et `PF` suivent la série globale des documents de `finance`, comme les remises de fonds : code `finance.supplier_series_code`, `SIEGE` par défaut. Le `site_id` est celui du BC pour une facture, s'il existe ; il est nul sinon. La portée de lecture est `ALL` (`finance.payable.read`, AV-365).

## Conséquences

- Le rapprochement de P6 devient complet (commandé, livré, rejeté, accepté, facturé, payé) sans que `procurement` connaisse `finance`. Seules deux additions touchent P6 : une fonction publique et une composition dans `procurement-api`.
- Une réception annulée ou un BC annulé après facturation ne sont pas bloqués par les achats. L'écart « facturé > accepté » se lit dans le rapprochement du BC (`/purchase-orders/{id}/matching`) et se corrige par un avoir (AV-361). Précision de la revue de P8-14 : ce n'est pas une rupture de la réconciliation, puisqu'une décision de la Finance peut l'avoir voulu (AT-025). `verifySupplierLedger` contrôle en revanche que le facturé écrit par `procurement` vaut Σ des factures approuvées (`INVOICED_QTY_DRIFT`), et une décision qui l'aggraverait sans le savoir est refusée (§3).
- AT-025 se rejoue de bout en bout. Ordre : facture 98, `MISMATCH`, contestation, annulation motivée, rectificative 95 conforme, paiement de 1 425 000, `PENDING_APPROVAL`, approbation de la Direction, décaissement, dette nulle.
- Tests : `finance-supplier-invoice-commands.test.ts`, `finance-supplier-payment-commands.test.ts`, `p8-acceptance.test.ts`, `p8-lock-order.test.ts`.

## Alternatives

- **`procurement` abonné à `SupplierInvoiceApproved`** (D08) : écriture asynchrone, rapprochement momentanément faux, consommateur de plus. Écartée : l'appel synchrone de l'API publique garde la frontière, `procurement` reste propriétaire.
- **Facturé tiré des seules lignes de facture** (colonne laissée à 0) : la colonne existe et le rapprochement la lit. Écartée.
- **Entité « avoir »** (facture négative liée) : plus fidèle comptablement, mais elle complique la dette et la vue pour un cas rare au MVP. Laissée à AV-359 (b).
- **Affectations créées seulement à l'approbation** (charge utile gardée en JSON) : moins lisible, et elles échappent à la réconciliation. Écartée au profit de `PLANNED`.
