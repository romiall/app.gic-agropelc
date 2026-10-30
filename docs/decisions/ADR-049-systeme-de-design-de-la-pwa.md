# ADR-049 — Système de design de la PWA : jetons, composants, navigation par rôle, thèmes

- **Statut** : ACCEPTÉ (style, navigation et thème : choix du porteur du 30/10/2026 sur maquette ; le reste est DÉDUIT, technique)
- **Date** : 30/10/2026
- **Précise** : ADR-021 (la logique reste dans `packages/domain` ; la refonte ne touche que la présentation), ADR-036 (navigation par rôle, registre des écrans), ADR-048 (la mise en page des pièces imprimées n'est pas touchée)
- **Questions liées** : NFR-05 (budget de taille), UX-01 (accueil par rôle), UX-11 (zones tactiles, contraste)

## Contexte

L'application est complète côté métier ; son rendu est jugé fonctionnel mais brut (audit : [`24-refonte-graphique.md`](../10-development-plan/24-refonte-graphique.md) § 2 à 4). Tout `button` est un bloc vert plein de 44 px, `select`, cases et radios gardent l'aspect du navigateur, aucun tableau n'existe, aucune navigation permanente non plus (tout passe par la page « Menu »), il n'y a ni icône, ni thème sombre, ni échelle typographique, et le vert sombre de l'interface (`#0b3d1e`) n'est pas celui du logo officiel. Le porteur veut une application moderne, soignée, qui garde sa simplicité, à fonctionnalités constantes.

## Décision

1. **Style sobre et aéré** (choix du porteur) : fond clair teinté de vert, cartes blanches à bord fin et ombre très légère, cartes réservées aux objets (résumé, formulaire, ligne de liste), chiffres en tuiles.
2. **Palette tirée du logo officiel et de la charte des pièces papier** : vert de la banderole `#3a6351` (principal, 6,6 : 1 avec du blanc), vert profond `#2b4b3d`, surface de la barre latérale `#243f33`, jaune d'œuf `#cdab0a` en accent rare (repère de l'onglet actif, compteur), neutres teintés de vert, encre `#15211b`. Quatre tons d'état (réussi, attention, alerte, information) distincts de la couleur de marque, et toujours doublés d'un point et d'un texte. Le vert `#0b3d1e` disparaît, y compris du manifeste (`theme_color`, `background_color`) et des icônes d'installation (lot L2).
3. **Typographie** : Noto Sans pour l'interface (400, 500, 600, 700), Barlow Semi Condensed pour les titres et les grands nombres (600, 700), en fichiers `woff2` embarqués par `@fontsource` (déjà dépendances, aucun réseau). Échelle 12, 13, 15, 17, 20, 24, 32 px, jamais sous 12 px ; champs à 16 px (pas de zoom du téléphone) ; chiffres tabulaires.
4. **Forme et gestes** : rayons de 8 px (contrôles), 12 px (cartes), pastilles arrondies ; hauteur visible de 40 px (48 px pour l'unique action principale d'un écran), zone tactile prolongée à 48 px par un pseudo-élément transparent (la cible dépasse l'élément sans l'agrandir) ; un seul bouton plein par écran, les autres en teinté, fantôme ou contour ; icônes SVG en traits de 1,8 px, jeu restreint écrit dans le code, sans bibliothèque.
5. **Navigation par rôle** (choix du porteur) : sur téléphone, barre du haut compacte (titre, indicateur de synchronisation, compte) et barre d'onglets en bas : Accueil, deux écrans du rôle, bouton « + » central (créations rapides du rôle : vente, visite, encaissement…), « Plus » (menu groupé par domaine). Sur ordinateur (à partir de 1024 px), barre latérale groupée par domaine (`ScreenGroup`) ; de 768 à 1023 px, rail d'icônes. Onglets de départ : vendeur de point de vente, Ventes et Stock ; commercial terrain, Clients et Ventes ; magasinier, Réceptions et Stock ; responsable de ferme, Saisie du jour et Stock ; les autres rôles, travaillant surtout sur ordinateur, sont arrêtés au lot L2. Les destinations organisent le menu, jamais l'autorisation : le serveur revérifie chaque permission (inchangé).
6. **Thèmes** (choix du porteur) : clair par défaut ; sombre et automatique (qui suit le téléphone) au choix, dans le menu du compte. Le choix se pose sur `<html data-theme>` et se mémorise dans `localStorage` (lecture et écriture protégées : sans stockage, le thème clair s'applique). Chaque jeton est défini pour les deux thèmes dans le même fichier ; aucun composant n'écrit une couleur en dur.
7. **Architecture des styles** : `apps/pwa/src/styles/` (`tokens.css`, `base.css`, `components.css`, `shell.css`) remplace `app.css` par étapes ; une classe encore employée par un écran est conservée comme alias jusqu'à la clôture (lot L10). Sont conservés tels quels : les sélecteurs que les essais emploient (`text-warn`, `result-warn`, `result-error`, `action-primary`, `home-muted`, `[data-kpi]`) et la structure testée (`li`, `[role="alert"]`).
8. **Composants partagés** dans `apps/pwa/src/components/ui/` (React et CSS, sans bibliothèque) : bouton et variantes, champ (libellé, aide, erreur, unité), sélecteur, case, interrupteur, contrôle segmenté, carte, pastille, onglets, ligne de liste, liste en colonnes, en-tête de page, état vide, squelette, bandeau, feuille, tuile d'indicateur, icônes. Les listes restent des `ul` et des `li` : sur ordinateur, les mêmes éléments s'affichent en colonnes par la grille CSS, sans changer les rôles du DOM (les essais par rôle, libellé et texte restent valables). Une page de référence, réservée au développement et absente de la construction de production, montre tous les composants dans les deux thèmes.
9. **Accessibilité** : noms accessibles inchangés (clés de `fr.ts`), focus visible sur chaque contrôle, contraste AA, `prefers-reduced-motion` (transitions de 120 à 180 ms supprimées).

## Alternatives étudiées

- **Bibliothèque d'interface** (composants prêts à l'emploi) : refusée, le budget de 300 Ko gzip (NFR-05) et l'usage hors ligne la rendent coûteuse pour une application de 61 écrans.
- **CSS utilitaire** (Tailwind) : refusé, il ajoute une étape de construction et déplace le style dans 90 composants, alors que le vocabulaire actuel tient en une centaine de classes.
- **Retouche écran par écran** : refusée, elle laisse des incohérences et coûte plus que de passer par des composants partagés.
- **Menu à tiroir** et **thème clair seul** : écartés par le porteur.

## Justification

Le markup n'utilise qu'environ 120 classes et aucun style en ligne : un système de jetons et de composants change l'apparence de tous les écrans sans toucher aux commandes ni à la synchronisation. Les couleurs du logo rapprochent l'application des pièces papier déjà validées. La navigation permanente supprime l'aller-retour par la page « Menu » ; le bouton « + » met sous la main l'action la plus fréquente de chaque rôle.

## Conséquences

- Lots L1 à L10 du suivi ([`24-refonte-graphique.md`](../10-development-plan/24-refonte-graphique.md) § 6) ; un commit par lot, essais d'`apps/pwa` du domaine à chaque lot, suite complète au plus une fois par lot.
- Budget NFR-05 contrôlé (`size-check`) à chaque lot : les polices passent par le précache du service worker (`woff2` déjà couverts), pas par le JavaScript initial.
- Le manifeste et les icônes d'installation suivent la palette du logo (lot L2).
- `app.css` disparaît à la clôture ; `features/pieces/` ne change pas.

## Risques

- Un essai qui s'appuierait sur une classe ou une structure non repérée : seuls 18 sélecteurs sur 9 fichiers existent aujourd'hui, tous conservés ; la suite du domaine est rejouée à chaque lot.
- Contraste insuffisant d'un ton d'état dans l'un des deux thèmes : calculé à la définition des jetons, vérifié sur la page de référence.
- Onglets du bas mal choisis pour un rôle : table de rôles en un seul endroit du registre des écrans, modifiable sans toucher aux écrans.
