# 24 — Refonte graphique, lot L8 (Finance et trésorerie)

> Suivi du lot L8, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/finance/` (factures, paiements, dépenses, créances, coûts et marges)
- `apps/pwa/src/features/treasury/` (trésorerie, mouvements, sessions de caisse)

## Livré

Principe : les phrases d'indicateurs deviennent des **tuiles** (libellé, valeur, précision), les listes à plusieurs colonnes des **tableaux** (`DataList` : cartes sur téléphone, colonnes alignées dès 900 px, toujours des `ul` et des `li`), les formulaires des **champs reliés** (`Field`) avec **barre d'action collée** pour l'unique action principale. Libellés, rôles ARIA et noms accessibles sont conservés (voir § Vérification pour les quatre fichiers d'essais touchés). Deux feuilles de domaine : `features/finance/finance.css` (préfixe `fin-`) et `features/treasury/treasury.css` (préfixe `tre-`), sans couleur en dur ; les pages portent `fin-page` (sections espacées) et un état vide compact (`EmptyLine`, une ligne icône et texte) remplace le bloc centré quand plusieurs files vides se suivent.

| Écran | Ce qui change |
|---|---|
| **Créances** (`ReceivablesScreen`) | En-tête de page. Encours en **trois tuiles** (dû par les clients, échu en ton alerte avec sa part de l'encours, à échoir). **Vieillissement de l'échu** : barre empilée ordinale (un seul ton, celui de l'alerte, dilué dans la surface en quatre pas de 50, 66, 82 et 100 % ; intervalle de 2 px, bout arrondi, 12 px d'épaisseur) ; la liste des tranches est la légende et l'équivalent en tableau, la barre est décorative (`aria-hidden`). Créances en **tableau** client / dû / échu / actions : les ventes d'un groupe se déplient sous la ligne ; appel et fiche en icônes seules, libellés courts « Encaisser » et « Ventes » : le nom accessible (et l'infobulle des icônes) reste la phrase complète. Filtres en `filter-bar`, pannes et relances en `Banner` |
| **Factures fournisseurs** (`SupplierInvoicesScreen`, `InvoiceForm`) | Dettes : deux tuiles (dette totale, avances versées) et tableau fournisseur / dette / position (échu, avance, net ; tranches sous la ligne). Factures en **tableau** facture / dates / montant / situation (pastille), le détail et les actions sous la ligne (auteur, écarts de rapprochement en boîte d'avertissement, motifs, photos, approuver, contester ou annuler avec motif, lignes à la demande). Saisie : carte de champs, lignes, aperçu du rapprochement en bandeau, barre d'action collée |
| **Paiements fournisseurs** (`SupplierPaymentsScreen`, `PaymentForm`) | **Tableau** paiement / montant / situation (point et texte, ton selon l'attente de la Direction, le refus ou le décaissement) ; détail et actions sous la ligne (moyen, compte, bon de décaissement, affecter, annuler, affectations) ; formulaires d'affectation et d'annulation ; saisie en carte avec barre d'action collée |
| **Dépenses** (`ExpenseScreen`, `ExpenseFollowUp`) | Saisie : « Payée maintenant / À payer par la Finance » en **contrôle segmenté**, champs reliés, barre d'action collée ; « Mes dépenses » et suivi en fiches (titre et montant sur une ligne, situation avec point, motifs de revue, justificatif) ; bascule Saisie / Suivi en rangée de liens |
| **Coûts et marges** (`CostsScreen`) | Vue d'ensemble en **tuiles** : chiffre d'affaires net, marge brute, encaissé, dépenses (période) puis créances, dettes, trésorerie (à la date de lecture) ; un bloc non lisible avec ses droits reste annoncé (tuile « non visible », jamais un zéro) ; pertes, fiche de lot et écritures de coût en sections de champs reliés |
| **Trésorerie** (`TreasuryScreen`, `SessionDetail`, `AccountMovements`, `MovementDocument`, `PendingSupplierPayments`) | Quatre tuiles en tête (solde des comptes, sessions à valider, écarts à décider, remises à recevoir) ; sessions, écarts et remises en fiches avec leurs actions ; **comptes en tableau** compte / type / solde / mouvements ; mouvements d'un compte en lignes avec leur pièce ; paiements en attente de la Direction en tableau |

Textes : nouvelles clés au milieu des blocs `receivables`, `supplier_invoice`, `supplier_payment`, `costs_margins` et `treasury` de `fr.ts` (`tile_*`, `col_*`, libellés visibles courts `*_short`) ; les clés devenues inutiles (phrases d'encours, de dettes, de ventes et de trésorerie remplacées par des tuiles) sont retirées.

## Vérification

Fin de lot (31/10/2026), worktree neuf, sous le verrou commun :

- **Types** : `pnpm --filter @gic/pwa run typecheck` vert (après construction de `@gic/domain` et `@gic/contracts`, voir § Notes).
- **ESLint** : `features/finance` et `features/treasury`, sans erreur ni avertissement.
- **Essais** : `src/features/finance`, `src/features/treasury`, `src/styles` et `src/components` : 18 fichiers, 250 essais passés. Seules les assertions de forme ont changé (§ Notes) ; aucun comportement n'est modifié.
- **Construction et budget NFR-05** : `pnpm --filter @gic/pwa run build` vert ; JavaScript initial 256,9 Ko gzip pour un budget de 300 Ko (écrans chargés à la demande : 262,7 Ko, hors budget).
- **Contrôle visuel** (Chromium, base locale de démonstration) : créances, trésorerie, coûts et marges, factures, paiements et dépenses, en 375 px et 1280 px, thèmes clair et sombre : aucun débordement horizontal, aucune erreur de console. La base de démonstration n'a ni créance échue, ni facture, ni paiement fournisseur ; ces écrans ont été regardés avec des lectures simulées dans l'outil de capture (interception des requêtes `GET` des créances, des factures, des paiements, des dettes et des fournisseurs ; rien n'est livré dans l'application). Rampe du vieillissement : un ton, quatre pas, validée avec le script de la compétence `dataviz` (mode ordinal) dans les deux thèmes.
- **Non regardé à l'écran** (aucune donnée de démonstration) : les formulaires ouverts dans une ligne (décision d'une facture, affectation ou annulation d'un paiement, annulation d'une dépense), les mouvements d'un compte et les fiches de session ; leur comportement est couvert par les essais.

## Questions à trancher

- **Q-L8-1** (design) : la barre de vieillissement montre l'échu seulement (quatre tranches, proportions de l'échu) ; « À échoir » a sa tuile. Faut-il une barre de l'encours entier (à échoir en gris, puis les quatre tranches) ? La liste des tranches, imposée par les essais, resterait de quatre lignes.
- **Q-L8-2** (métier) : le « Solde des comptes » de la trésorerie additionne les comptes listés, inactifs compris ; la vue d'ensemble des coûts lit un total de trésorerie fourni par le serveur. Les deux doivent-ils concorder (lire le total serveur ici aussi) ou exclure les comptes inactifs ?

## Notes

- **Briques communes qui auraient servi** (contournées dans les feuilles de domaine, à trancher au lot L10) : un état à point et texte qui passe à la ligne (la pastille `Badge` ne coupe pas son texte : les situations longues d'un paiement ou d'une dépense s'écrivent avec `.fin-status`) ; une barre empilée ordinale (`.fin-age-*`, validée avec le script de la compétence `dataviz` pour les deux thèmes) ; `Input`, `Select` et `Textarea` ne transmettent pas `ref` (`ComponentPropsWithRef` suffirait) : les contrôles qui reçoivent le focus par programme (fournisseur d'une saisie, motif d'une décision) restent des éléments natifs `.select` et `.textarea` dans un `Field`.
- `features/pieces/` (`PieceAction`) n'est pas touché ; la trésorerie importe `finance.css` pour le suivi des dépenses qu'elle embarque (`ExpenseFollowUp`).
- **Essais adaptés (forme seulement, comportement identique)** : `ReceivablesScreen.test.tsx` (les phrases d'encours deviennent des tuiles ; le montant d'un groupe n'est plus précédé de « · » ; l'aide à la lecture des lignes de groupe filtre la classe `data-row` au lieu de `line-card`), `CostsScreen.test.tsx` (vue d'ensemble en tuiles), `SupplierInvoicesScreen.test.tsx` (dette totale en tuile), `TreasuryScreen.test.tsx` (solde en colonne du tableau des comptes).
- **État vide compact** : `EmptyState` est un bloc centré, trop haut quand plusieurs files vides s'empilent (trésorerie : sessions, écarts, remises). `features/finance/EmptyLine.tsx` (une ligne, icône et texte, classe `fin-compact`) le remplace dans le domaine ; une variante compacte de `EmptyState` serait la brique commune (à trancher au lot L10).
- **Visuels** : les captures « après » des créances, des factures et des paiements viennent de lectures simulées (l'outil de capture est complété hors dépôt par une interception des requêtes ; les gabarits de données sont ceux des essais du domaine).
- Deux fichiers d'essais du domaine (`ExpenseScreen.test.tsx`, `SupplierPaymentsScreen.test.tsx`) ne sont pas conformes à Prettier depuis avant le lot ; ils ne sont pas touchés.
- Typecheck d'un worktree neuf : il faut construire `@gic/domain` et `@gic/contracts` d'abord (`pnpm --filter @gic/domain --filter @gic/contracts run build`) ; sinon `TS2307` en cascade sur `@gic/domain`. Note déposée dans le dossier partagé.
