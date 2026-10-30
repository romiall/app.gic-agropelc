# 24 — Refonte graphique, lot L8 (Finance et trésorerie)

> Suivi du lot L8, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/finance/` (factures, paiements, dépenses, créances, coûts et marges)
- `apps/pwa/src/features/treasury/` (trésorerie, mouvements, sessions de caisse)

## Livré

Principe : les phrases d'indicateurs deviennent des **tuiles** (libellé, valeur, précision), les listes à plusieurs colonnes des **tableaux** (`DataList` : cartes sur téléphone, colonnes alignées dès 900 px, toujours des `ul` et des `li`), les formulaires des **champs reliés** (`Field`) avec **barre d'action collée** pour l'unique action principale. Libellés, rôles ARIA et noms accessibles sont conservés (voir § Vérification pour les quatre fichiers d'essais touchés). Deux feuilles de domaine : `features/finance/finance.css` (préfixe `fin-`) et `features/treasury/treasury.css` (préfixe `tre-`), sans couleur en dur.

| Écran | Ce qui change |
|---|---|
| **Créances** (`ReceivablesScreen`) | En-tête de page. Encours en **trois tuiles** (dû par les clients, échu en ton alerte avec sa part de l'encours, à échoir). **Vieillissement de l'échu** : barre empilée ordinale (un seul ton, celui de l'alerte, dilué dans la surface en quatre pas de 50, 66, 82 et 100 % ; intervalle de 2 px, bout arrondi, 12 px d'épaisseur) ; la liste des tranches est la légende et l'équivalent en tableau, la barre est décorative (`aria-hidden`). Créances en **tableau** client / dû / échu / actions : les ventes d'un groupe se déplient sous la ligne ; actions à libellé court (« Appeler », « Fiche », « Encaisser », « Voir les ventes ») dont le nom accessible reste la phrase complète. Filtres en `filter-bar`, pannes et relances en `Banner` |
| **Factures fournisseurs** (`SupplierInvoicesScreen`, `InvoiceForm`) | Dettes : deux tuiles (dette totale, avances versées) et tableau fournisseur / dette / position (échu, avance, net ; tranches sous la ligne). Factures en **tableau** facture / dates / montant / situation (pastille) / actions, le détail sous la ligne (auteur, écarts de rapprochement en boîte d'avertissement, motifs, photos, lignes à la demande, décision motivée). Saisie : carte de champs, lignes, aperçu du rapprochement en bandeau, barre d'action collée |
| **Paiements fournisseurs** (`SupplierPaymentsScreen`, `PaymentForm`) | **Tableau** paiement / montant / situation (point et texte, ton selon l'attente de la Direction, le refus ou le décaissement) / actions ; détail sous la ligne (moyen, compte, bon de décaissement, affectations) ; formulaires d'affectation et d'annulation ; saisie en carte avec barre d'action collée |
| **Dépenses** (`ExpenseScreen`, `ExpenseFollowUp`) | Saisie : « Payée maintenant / À payer par la Finance » en **contrôle segmenté**, champs reliés, barre d'action collée ; « Mes dépenses » et suivi en fiches (titre et montant sur une ligne, situation avec point, motifs de revue, justificatif) ; bascule Saisie / Suivi en rangée de liens |
| **Coûts et marges** (`CostsScreen`) | Vue d'ensemble en **tuiles** : chiffre d'affaires net, marge brute, encaissé, dépenses (période) puis créances, dettes, trésorerie (à la date de lecture) ; un bloc non lisible avec ses droits reste annoncé (tuile « non visible », jamais un zéro) ; pertes, fiche de lot et écritures de coût en sections de champs reliés |
| **Trésorerie** (`TreasuryScreen`, `SessionDetail`, `AccountMovements`, `MovementDocument`, `PendingSupplierPayments`) | Quatre tuiles en tête (solde des comptes, sessions à valider, écarts à décider, remises à recevoir) ; sessions, écarts et remises en fiches avec leurs actions ; **comptes en tableau** compte / type / solde / mouvements ; mouvements d'un compte en lignes avec leur pièce ; paiements en attente de la Direction en tableau |

Textes : nouvelles clés au milieu des blocs `receivables`, `supplier_invoice`, `supplier_payment`, `costs_margins` et `treasury` de `fr.ts` (`tile_*`, `col_*`, libellés visibles courts `*_short`) ; les clés devenues inutiles (phrases d'encours, de dettes, de ventes et de trésorerie remplacées par des tuiles) sont retirées.

## Vérification

_À remplir en fin de lot : types, ESLint, essais du domaine, contrôle visuel mobile et bureau (clair et sombre)._

## Questions à trancher

- **Q-L8-1** (design) : la barre de vieillissement montre l'échu seulement (quatre tranches, proportions de l'échu) ; « À échoir » a sa tuile. Faut-il une barre de l'encours entier (à échoir en gris, puis les quatre tranches) ? La liste des tranches, imposée par les essais, resterait de quatre lignes.
- **Q-L8-2** (métier) : le « Solde des comptes » de la trésorerie additionne les comptes listés, inactifs compris ; la vue d'ensemble des coûts lit un total de trésorerie fourni par le serveur. Les deux doivent-ils concorder (lire le total serveur ici aussi) ou exclure les comptes inactifs ?

## Notes

- **Briques communes qui auraient servi** (contournées dans les feuilles de domaine, à trancher au lot L10) : un état à point et texte qui passe à la ligne (la pastille `Badge` ne coupe pas son texte : les situations longues d'un paiement ou d'une dépense s'écrivent avec `.fin-status`) ; une barre empilée ordinale (`.fin-age-*`, validée avec le script de la compétence `dataviz` pour les deux thèmes) ; `Input`, `Select` et `Textarea` ne transmettent pas `ref` (`ComponentPropsWithRef` suffirait) : les contrôles qui reçoivent le focus par programme (fournisseur d'une saisie, motif d'une décision) restent des éléments natifs `.select` et `.textarea` dans un `Field`.
- `features/pieces/` (`PieceAction`) n'est pas touché ; la trésorerie importe `finance.css` pour le suivi des dépenses qu'elle embarque (`ExpenseFollowUp`).
- **Essais adaptés (forme seulement, comportement identique)** : `ReceivablesScreen.test.tsx` (les phrases d'encours deviennent des tuiles ; le montant d'un groupe n'est plus précédé de « · » ; l'aide à la lecture des lignes de groupe filtre la classe `data-row` au lieu de `line-card`), `CostsScreen.test.tsx` (vue d'ensemble en tuiles), `SupplierInvoicesScreen.test.tsx` (dette totale en tuile), `TreasuryScreen.test.tsx` (solde en colonne du tableau des comptes).
- Typecheck d'un worktree neuf : il faut construire `@gic/domain` et `@gic/contracts` d'abord (`pnpm --filter @gic/domain --filter @gic/contracts run build`) ; sinon `TS2307` en cascade sur `@gic/domain`. Note déposée dans le dossier partagé.
