# 24 — Refonte graphique, lot L7 (Achats)

> Suivi du lot L7, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/procurement/` (demandes, bons de commande, réceptions, fournisseurs, rapprochement)

## Livré

Principe du lot L5 repris : les composants communs (`PageHeader`, `Field`, `Segmented`, `DataList`, `Banner`, `Badge`, `Section`, `ActionBar`, `EmptyState`, `SkeletonRows`) remplacent le vocabulaire hérité ; libellés, rôles ARIA et noms accessibles lus par les essais sont conservés. Une feuille de domaine nouvelle (`procurement.css`, aucune couleur en dur) et une fonction de présentation (`tones.ts` : ton de la pastille d'un statut de demande, de bon de commande ou de réception). **Aucun essai modifié.**

| Écran | Ce qui change |
|---|---|
| Demande d'achat (ECR-APP-02) | `PageHeader` ; formulaire en champs partagés (site et date côte à côte, justification, lignes en cartes avec produit, quantité, unité, prix estimé, note) ; « Ajouter une ligne » en bouton pointillé ; barre d'action collée avec « Soumettre la demande » ; **Mes demandes** en liste en colonnes (numéro, justification, statut en pastille, date) avec le bouton « Voir la pièce » sous la ligne |
| Fournisseurs (ECR-APP-01) | « Nouveau fournisseur » dans l'en-tête ; liste en colonnes (fournisseur et code, contact, délai de paiement, statut, « Modifier » et « Désactiver » à droite) ; éditeur en carte (champs par deux, catégories fournies en cases), barre d'action collée avec « Annuler » |
| Bons de commande (ECR-APP-03) | Rubriques « Bons de commande » et « Nouveau bon de commande » en contrôle segmenté (la rubrique masquée reste montée) ; filtre de statut en barre de filtres ; **liste en colonnes** (bon, fournisseur et lieu, livraison prévue, montant, statut) avec, sous chaque ligne, les lignes du bon, le bon papier et les actions (modifier, soumettre, marquer envoyé, clôturer le reliquat, annuler) ; modification, annulation et clôture dans un panneau de la ligne ; création d'un bon en champs partagés avec **barre d'action collée portant le total du bon** |
| Réceptions (ECR-APP-04) | Bons à recevoir en liste en colonnes dont toute la ligne est le lien (bon, fournisseur, livraison prévue, statut) ; réceptions des 30 derniers jours en colonnes avec la photo du bon et le bon papier sous la ligne ; formulaire de réception en champs partagés (lignes en cartes : livré, rejeté, motif, lot, péremption) avec barre d'action collée |
| Rapprochement (ECR-APP-05) | `PageHeader`, filtres en barre (groupe, fournisseur, « écarts seulement ») ; **liste en colonnes** (bon et statut, fournisseur, dates et montant, écarts avec un point d'attention par constat) avec résumé des lignes et bouton de détail dessous ; échecs de lecture et de section en bandeaux avec leur « Relire » ; détail du bon (lignes, réceptions, factures) inchangé dans son contenu |

## Vérification

Faite le 31/10/2026, une fois, sous le verrou commun.

| Contrôle | Résultat |
|---|---|
| Types (`pnpm --filter @gic/pwa run typecheck`) | 0 erreur |
| ESLint des fichiers modifiés ou créés | 0 erreur, 0 avertissement |
| Essais : `src/features/procurement`, `pieces`, `styles`, `i18n`, `components` | 12 fichiers passés, 167 essais passés, un ignoré (`pieces/apercu.test.ts`, ignoré avant ce lot) ; aucun essai de `procurement` modifié |
| Construction (`pnpm --filter @gic/pwa run build`) | Réussie (1 min 08) |
| Budget NFR-05 (`node tools/size-check.mjs`, lancé depuis `apps/pwa`) | **JS initial 256,8 Ko gzip pour un budget de 300 Ko** ; écrans chargés à la demande : 261,7 Ko (hors budget) |
| Contrôle visuel (Chromium, API et PWA locales, base `gic_agropelc_refonte`) | 375 px et 1280 px, clair ; sombre sur les fournisseurs (téléphone) et les bons de commande (ordinateur) : demandes, fournisseurs, bons de commande (liste et création), réceptions (liste et formulaire), rapprochement (liste et détail ouvert). Aucun débordement horizontal de page, aucune erreur de console. Deux défauts relevés puis corrigés : numéros de document coupés sur deux lignes (première colonne élargie), bouton « Voir la pièce » en barre pleine |

Non vérifié : les écrans n'ont été vus qu'avec le jeu de démonstration (un fournisseur, un bon envoyé, aucune demande ni réception) ; les panneaux de modification, d'annulation et de clôture d'un bon, la création d'un bon depuis une demande approuvée, les écarts de réception (rejet, dépassement, quarantaine) et les états d'échec ne sont couverts que par les essais, pas par un contrôle visuel. Les petits réglages de largeur faits après la vérification (valeurs de `template` des listes, une règle de `procurement.css`) n'ont pas été rejoués dans les essais : ils ne touchent ni au balisage ni aux textes.

## Questions à trancher

- **Q-L7-1 — Pastille de statut dans le rapprochement** : le statut d'un bon, d'une réception ou d'une facture s'y lit encore en texte après un point (« BC-… · Reçu en partie »), parce que cinq assertions de `MatchingScreen.test.tsx` lisent cette forme exacte (`/^· Reçu en partie$/`, `/^· Annulée$/`, `/^· Comptabilisée$/`, `/^· Payée en partie$/`). Une pastille colorée, comme dans toutes les autres listes, demande de réécrire ces assertions (comportement inchangé). À faire au lot L10 avec l'harmonisation des essais ? Recommandé : oui.

## Notes

**Besoins communs contournés dans la feuille de domaine** (à trancher au lot L10) :

1. **Espace des bandeaux et des sections** : même contournement qu'au lot L5 (`.proc-screen > .banner` et `> .section`) ; une marge portée par le composant le règlerait pour tous les domaines.
2. **Ligne de liste en colonnes cliquable** : les bons à recevoir mettent la classe `data-row` sur le lien (`li > a.data-row`, classe `proc-row`), comme le portefeuille du lot L5 ; une propriété `to` sur `DataRow` servirait aux deux.
3. **Ligne de liste avec corps déroulant** (bons de commande, rapprochement) : les colonnes portent l'essentiel, puis une cellule pleine largeur (`DataCell wide`) porte lignes, pièce et actions sous un filet (`.proc-order-body`). Le motif revient dans plusieurs lots (finance, stock) : candidat à un composant « ligne extensible ».
4. **Bouton « Voir la pièce »** (`features/pieces/PieceAction`, hors périmètre) : barre pleine par défaut ; une règle de domaine le ramène à sa largeur (`.proc-order-body .piece-action`). À reprendre au lot des pièces si besoin.

**Constatés hors du lot, non corrigés** :

5. Photo du bon de livraison (`features/attachments/PhotoField`, lot L9) : texte d'aide en grand corps et boutons nus, visibles dans le formulaire de réception.
6. Formulaire de demande d'achat : avant le choix d'un produit, le libellé du prix se lit « Prix estimé par (F, facultatif) » (l'unité manque) ; comportement d'avant, conservé.

**Détails de mise en œuvre** :

7. Les écrans de chargement passent de « Chargement… » à `SkeletonRows` (nom accessible « Chargement… ») ; aucun essai de ce domaine ne lisait l'ancien texte.
8. Les rôles ARIA d'origine sont conservés sur les bandeaux (`role="status"` ou `"alert"` explicites). Les messages reliés au bouton de création d'un bon (`aria-describedby` : création renvoyée sans succès, relecture des demandes) gardent leur identifiant.
9. Clés de texte ajoutées : `purchase_request.col.*`, `suppliers.col.*`, `orders_po.col.*` et `orders_po.summary_total`, `purchase_receipt.col.*`, `order_matching.col.*` (en-têtes des listes en colonnes, libellé du total de la barre d'action).
