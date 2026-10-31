# ADR-050 — Compléments au système de design de la PWA (lots L4 à L10)

- **Statut** : ACCEPTÉ (choix du porteur du 31/10/2026 sur les questions des sessions de lot ; le reste est DÉDUIT, technique)
- **Date** : 31/10/2026
- **Précise** : ADR-049 (système de design de la PWA : jetons, composants, navigation par rôle ; §5 « deux écrans du rôle » et §7 « `app.css` disparaît à la clôture »)
- **Questions liées** : AV-486 à AV-488 ; NFR-05 (budget de taille), UX-11 (zones tactiles, contraste)

## Contexte

Les lots L4 à L9 de la refonte graphique ([`24-refonte-graphique.md`](../10-development-plan/24-refonte-graphique.md) § 8 ter) ont été menés par trois sessions en parallèle, chacune sur ses dossiers. Elles ont posé dix questions (`Q-L<n>-<k>`) et contourné dans leurs feuilles de domaine plusieurs besoins communs. Le lot L10 fusionne les branches, tranche avec le porteur et clôt.

## Décision

1. **Un seul lien de retour** (Q-L5-1, adoptée). `BackLink` (`components/ui/Nav.tsx`) : chevron et libellé, c'est le retour de `PageHeader`, que les écrans qui gardent leur propre titre (reçu d'une vente, détail d'une commande) ou n'en ont pas (élément introuvable) emploient seul. Le libellé n'a plus de flèche (« Mon portefeuille », non « ← Mon portefeuille ») ; la classe `back-link` disparaît.
2. **Lien hors de l'application en bouton** (Q-L5-2, adoptée). `AnchorButton` (`components/ui/Button.tsx`) : lien téléphone ou courriel qui a l'apparence d'un bouton. La fiche client ouvre sa rangée d'actions par « Appeler » quand le compte a un numéro ; « Noter un échange » prend l'icône du crayon.
3. **Vieillissement des créances sur tout l'encours** (Q-L8-1, adoptée). La barre empilée commence par un segment gris neutre (ce qui n'est pas encore échu) puis les quatre tranches échues (rampe ordinale à un ton, validée pour les deux thèmes). La barre reste décorative ; la ligne « À échoir » ouvre la légende et la liste des quatre tranches échues, lue par les essais, ne change pas.
4. **Responsable de ferme** (Q-L6-2, adoptée). Onglets du bas : Saisie du jour et Collecte des œufs. La règle d'ADR-049 §5 est conservée (deux écrans du rôle autour du « + ») : le stock quitte la barre, reste dans « Plus » et sert de repli si la collecte n'est pas proposée au rôle. La table `ROLE_TABS` reste le seul endroit à modifier.
5. **`app/app.css` retiré.** Les règles encore employées passent dans `styles/screens.css` (vocabulaire hérité des écrans, pièces papier, impression) et `features/auth/auth.css` (connexion) ; les alias de variables et les règles sans usage sont supprimés. Le test des couleurs balaie toutes les feuilles.
6. **Propositions écartées à ce jour** (le porteur ne les a pas retenues le 31/10/2026) : pastille de statut dans le rapprochement des achats (Q-L7-1, cinq assertions à réécrire), composant commun d'aide repliée (Q-L9-1, `HelpDisclosure` reste dans `features/users/`), variante de bouton à contour rouge (Q-L9-2, les actions destructives restent à contour ou en fantôme). Elles pourront être reprises sans changer d'architecture.
7. **Briques communes demandées et non faites** : marge portée par `Banner` et `Section` (chaque domaine pose `> .banner` et `> .section`), ligne de liste en colonnes cliquable (`DataRow` avec lien), contrôle segmenté avec libellé visible, état vide compact, `ref` transmis par `Input`, `Select` et `Textarea`, état à point dont le texte passe à la ligne, barre empilée ordinale, ligne extensible, cadre « position ». Chacune est contournée proprement dans une feuille de domaine ; les faire coûte des retouches dans plusieurs domaines et leurs essais pour un gain d'écriture, pas d'usage.
8. **Questions laissées au registre** : validation de l'éditeur de règle de prix (AV-486), définition du solde de trésorerie (AV-487), bouton du module des pièces (AV-488).

## Alternatives étudiées

- **Quatre ou cinq destinations pour la ferme** : refusé, la barre du bas de cinq emplacements est centrée sur le « + » ; au-delà, les zones tactiles passent sous 48 px à 375 px et le « + » se décentre.
- **Retour dans chaque écran** (statu quo) : refusé, deux formes de retour coexistaient (flèche dans le texte, chevron du composant).
- **Barre de vieillissement de l'échu seul** : écartée, elle ne montrait pas la part de l'encours déjà en retard.

## Conséquences

- Quatre essais lisent désormais le nom du lien de retour sans flèche ; un essai suit la table des onglets de la ferme ; deux essais sont ajoutés (« Appeler », ligne « À échoir »). Aucun comportement n'est modifié.
- Le dossier `features/pieces/` n'a pas été touché (ADR-048).
- La refonte a été fusionnée dans `main`, poussée et mise en ligne le 31/10/2026, à la demande du porteur (livraison `20261031-102020`).

## Risques

- La barre du bas de la ferme sans stock : le stock demande un geste de plus (« Plus ») ; à confirmer à l'usage, un seul endroit à changer (`ROLE_TABS`).
- Briques contournées : si un cinquième domaine reprend le même contournement, les promouvoir en composants communs.
