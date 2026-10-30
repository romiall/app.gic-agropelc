# 24 — Refonte graphique, lot L6 (Production)

> Suivi du lot L6, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/production/` (lots, fiche de lot, mise en place, saisie du jour, collecte des œufs, incubation, sortie)

## Livré

**Critère du plan** : saisie du jour réalisable d'une main. Réponse : en-tête compact (retour, titre, code du lot et effectif), liens vers les écrans voisins en une rangée qui défile, nature de la saisie en quatre tuiles de 56 px (icône et texte, deux par deux sur téléphone), champs numériques avec leur unité (têtes, kg), un seul bouton plein par écran, dans la barre d'action collée au-dessus des onglets, retour de l'opération ramené sous les yeux après chaque saisie. La page n'est pas plus courte (1 851 px avant, 1 855 px après, journal de quatre saisies : ses lignes sont plus aérées) ; ce qui change, c'est ce que voit le premier écran : avant, quatre radios empilées (190 px) et trois liens poussaient le premier champ sous la ligne de flottaison ; après, le nombre de morts, le bâtiment et le bouton d'enregistrement (barre collée au-dessus des onglets) sont visibles sans défiler.

| Écran | Ce qui change |
|---|---|
| `production.css` (nouveau) | Feuille du domaine, jetons seulement : formulaires en une colonne (`prd-form`, deux champs côte à côte `prd-pair`, grille de calibres `prd-grid`, colonne lisible sur ordinateur `prd-narrow`), notes en ligne (`prd-note`), tuiles de choix (`prd-kinds`), informations repliées (`prd-more`), chiffres en tuiles et totaux (`prd-figures`, `prd-totals`, `prd-lines`), fiche sur deux colonnes (`prd-sheet`), ligne de lot qui est un lien (`prd-link-row`), cartes d'incubation |
| `SelectField.tsx` (nouveau) | Liste déroulante avec son libellé (`Field` et `Select`), partagée par la mise en place et l'incubation |
| Lots actifs (`LotsScreen`) | `PageHeader` ; `DataList` : cartes sur téléphone avec une flèche, cinq colonnes dès 900 px (lot, âge, effectif, saisies du jour, situation) ; **toute la ligne est le lien** (son nom accessible porte toujours le code, l'effectif et l'âge) ; pastilles Actif, En vente ; lots planifiés en liste avec la pastille Planifié ; état vide et squelette |
| Saisie du jour (`DailyEntryScreen`) | `PageHeader` avec retour (le code du lot passe en sous-titre, avec le type et l'effectif) ; rangée de liens (collecte d'œufs, sortie, fiche) en boutons teintés ; nature de la saisie en `Segmented` (tuiles) ; les quatre formulaires restent montés ; champs `Field` : nombre de morts en tête avec l'unité, bâtiment avec l'effectif en aide, cause, commentaire ; gravité d'une observation en contrôle segmenté ; erreurs rattachées au champ ; `ActionBar` ; journal du jour et mortalités en attente en listes à icônes et pastilles ; bouton de la pièce papier en dernier |
| Collecte d'œufs (`EggCollectionScreen`) | `PageHeader` avec retour ; quatre compteurs en grille de deux colonnes ; calibres en grille ; **ce qui reste à répartir suit la saisie dans la barre d'action** (en plus du message, conservé) |
| Sortie vers la commercialisation (`OutputScreen`) | `PageHeader` ; bloc « vente depuis l'élevage » en section avec bouton teinté ; formulaire de sortie en `Field`, `ActionBar` |
| Nouveau lot ou entrée (`LotSetupScreen`) | Rubriques en `Segmented` ; origine des animaux en lignes à cocher dans une carte ; **informations facultatives de la création repliées** (parent, fournisseur, souche, dates, note) ; quantité et poids côte à côte ; `ActionBar` |
| Incubation (`IncubationScreen`) | Rubriques en `Segmented` ; carte de lot avec pastille de situation (en incubateur, en éclosoir), étapes en boutons teintés, formulaire d'étape sous la carte (enregistrer, annuler en fantôme) ; origine des œufs en `Segmented` ; démarrage dans la barre d'action |
| Fiche lot (`LotSheetScreen`) | `PageHeader` ; choix du lot en `Field` (liste groupée conservée) ; situation en pastille ; effectif et indicateurs en tuiles ; coûts, ventes et marges en cartes ; résultat mensuel, entrées, pesées en listes ; deux colonnes sur ordinateur ; bandeaux d'erreur avec « Réessayer » |

Libellés, rôles ARIA et noms accessibles sont inchangés (voir § Notes pour les trois exceptions de présentation) : aucun essai n'a été modifié.

## Vérification

Passe faite sous verrou le 31/10/2026, sur la branche du lot.

- **Types** : `pnpm --filter @gic/pwa run typecheck`, sans erreur.
- **ESLint** : `npx eslint apps/pwa/src/features/production apps/pwa/src/i18n/fr.ts`, sans avertissement.
- **Essais** : `npx vitest run src/features/production src/styles` dans `apps/pwa` : 6 fichiers, 112 essais passés (logique 7, fiche 8, mise en place 9, incubation 10, écrans de saisie et de lots 8, jetons et contrastes 70). **Aucun essai modifié.** Un premier passage a montré un seul échec, la liste des lots (le lien de la ligne devait garder l'effectif et l'âge dans son texte) : la ligne entière est devenue le lien, l'essai passe sans changement.
- **Contrôle visuel** (Chromium sans fenêtre, 375 px et 1280 px, thèmes clair et sombre) sur la saisie du jour (quatre formulaires), les lots, la fiche, la collecte (avec bilan), la sortie, la mise en place (repli ouvert, entrée dans un lot) et l'incubation : aucun débordement horizontal de la page, aucune erreur de console, aucun texte sous 12 px, aucune cible visible sous 36 px (zone tactile de 48 px).
- **Hauteurs de page en 375 px, avant → après** : saisie du jour 1 851 → 1 855 px (voir ci-dessus), fiche 1 615 → 2 125 px (tuiles : plus aérée, lue sur ordinateur sur deux colonnes : 1 420 → 1 415 px), collecte 1 030 → 1 114 px (les trois champs de contexte passent sur une ligne chacun), incubation 1 013 → 886 px, mise en place 1 404 → 952 px, sortie 1 298 → 1 367 px.
- **Non vérifié** : sur un téléphone réel ; l'envoi réel d'une saisie au serveur (l'appareil de démonstration attend son approbation) ; la lecture de la fiche d'un lot réel (simulée côté API pour les images) ; la construction et le contrôle de taille (`size-check`), réservés au dernier lot de la session.

## Questions à trancher

- **Q-L6-1** — Le bouton « Fiche de suivi de la semaine » (module des pièces, hors périmètre des lots) garde l'ancien bouton nu : à reprendre avec `Button` au lot L10 si la session principale l'autorise (le module `features/pieces/` ne doit pas être touché pendant les lots).
- **Q-L6-2** — La rangée de liens de la saisie du jour (collecte d'œufs, sortie, fiche) défile sur téléphone : faut-il en faire des onglets du bas pour le responsable de ferme (table `ROLE_TABS`, session principale) ? Le plan retient « Saisie du jour » et « Stock ».

## Notes

- **Besoins communs contournés dans la feuille du domaine** : (1) `Segmented` en tuiles deux par deux (`prd-kinds`), candidat à une variante du composant ; (2) `DataList` n'a pas de variante « ligne qui est un lien » : la ligne est un `a.data-row` dans un `li` (grille et cellules de `DataList` conservées) ; (3) `Field` n'enveloppe pas un groupe d'options : libellé visible `field-label` et `Segmented` côte à côte (gravité, origine des œufs) ; (4) `Banner` ne prend pas d'`id` : les notes reliées à un bouton par `aria-describedby` restent des paragraphes `prd-note` ; (5) `PageHeader` n'a pas de `className` (taille du titre).
- **Textes** : `production.daily_title` retiré (le titre de la saisie du jour est « Saisie du jour », le code du lot est le sous-titre : un titre de 34 caractères se coupait au milieu du code sur téléphone). `production.back`, `eggs.back` et `output.back` perdent la flèche « ← » (le lien de retour de `PageHeader` porte déjà une icône). Ajoutés : `production.col.*` (en-têtes des colonnes), `eggs.remaining_label`, `lot_setup.more_title`.
- **Rôles ARIA** : les anomalies de champ (nombre invalide, dépassement en ligne, commentaire exigé) passent par `Field` et sont maintenant annoncées en `alert` ; les messages « hors ligne » (la saisie sera tout de même enregistrée) restent de simples notes. Les essais qui cherchent « un seul `alert` » passent (ils ne contiennent qu'une anomalie à la fois).
- **Retour de l'opération** : après chaque saisie, la page remonte le bandeau de retour sous la barre du haut si besoin (`scrollIntoView` « nearest », ignoré là où l'API manque).
- **Images de contrôle** : la base de démonstration ne contient aucun lot de production ; les captures sont prises sur des lots semés dans le stockage local du navigateur de test (outil dans le scratchpad de la session, rien dans le dépôt) et la fiche de lot est simulée côté API par l'outil.
- **Hors lot** : la bannière d'approbation de l'appareil (lot L2) prend 120 px en haut de chaque écran tant que l'appareil n'est pas approuvé ; sur les images, elle accentue la longueur apparente des pages.
