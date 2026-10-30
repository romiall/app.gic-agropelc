# 24 — Refonte graphique et ergonomique de la PWA

> **Statut (30/10/2026)** : audit fait, **direction visuelle validée par le porteur sur maquette** ([ADR-049](../decisions/ADR-049-systeme-de-design-de-la-pwa.md)) ; les lots L0 (audit, direction) et L1 (fondations, § 7) sont clos. Les écrans ne sont pas encore repris un à un : ils profitent déjà des jetons et du style des éléments nus ; le lot L2 (coquille et navigation) suit. Branche `claude/refonte-graphique-b75250`, travail séquentiel, un lot à la fois, un commit par lot.
> **Portée** : `apps/pwa` seulement, **à fonctionnalités constantes** (mêmes commandes, même hors ligne, même synchronisation). `apps/server`, `db/`, `deploy/` et `apps/pwa/src/features/pieces/` (mise en page exacte des pièces imprimées) ne sont pas touchés.
> **Numéros réservés au chantier** : de 486 à 499 pour les AV, de 049 à 051 pour les ADR (la session principale n'y touche pas).

## 1. Pourquoi

L'application est complète côté métier, mais son rendu est jugé « fonctionnel sans donner envie de l'utiliser » : gros boutons, champs bruts, pages de texte. Le porteur veut une application moderne, soignée, qui garde la simplicité appréciée. Priorité : **l'ergonomie et la logique de disposition** (ce que l'utilisateur fait le plus souvent est sous la main, dans l'ordre naturel de son travail).

## 2. Mesures de départ

Relevées le 30/10/2026 sur une base locale neuve (données de démonstration), avec un compte qui détient les onze rôles, en largeur mobile 375 px (51 écrans ; les totaux de boutons et de contrôles portent sur 47 d'entre eux) et bureau 1280 px (8 écrans). Outil de relevé : § 8.

| Mesure | Valeur |
|---|---|
| Écrans / composants | 61 `*Screen.tsx` / 90 fichiers `.tsx` hors essais |
| Feuille de styles | un seul fichier, `app.css` (1 351 lignes, 23 Ko) |
| Couleurs écrites en dur | 28 teintes distinctes, 59 occurrences ; 10 variables seulement |
| Tailles de police | 10 tailles (11 à 24 px) sur 47 déclarations, aucune échelle |
| Thème sombre, mouvement réduit, transitions | aucun, aucun, aucune |
| Icônes | aucune (un seul `<svg>` : le tracé des indicateurs) |
| Polices | celles du système ; Noto Sans et Barlow Semi Condensed ne servent qu'aux pièces imprimées |
| Classes CSS utilisées / styles en ligne | environ 120 / aucun : le vocabulaire est petit |
| Essais qui dépendent d'une classe ou du DOM | 18 sélecteurs dans 9 des 102 fichiers d'essais ; tous les autres passent par rôles, libellés et textes |
| Débordement horizontal à 375 px | aucun sur 51 écrans |
| Tableaux (`<table>`) | **aucun** : listes de cartes jusque sur ordinateur |
| Boutons relevés | 96, dont 25 pleins en vert foncé |
| Contrôles natifs | 67 listes déroulantes, 32 cases et boutons radio (bleu du navigateur) |
| Hauteur de l'accueil / du menu (compte à onze rôles) | 11 565 px / 4 998 px |

## 3. Audit par motif

| Motif | Constat | Direction |
|---|---|---|
| **Boutons** | Tout `button` est un bloc vert plein de 44 px de haut ; une seule variante, le contour (`secondary`). Le bouton principal d'un écran ne se distingue pas des actions secondaires. | Hauteur visible de 40 px (48 px pour l'unique action principale), zone tactile prolongée à 48 px sans élargir le dessin ; variantes pleine, teintée, fantôme, contour, danger ; un seul bouton plein par écran. |
| **Champs** | Seuls trois types de `input` sont stylés ; `select`, `textarea`, nombres, dates, cases et radios gardent l'aspect du navigateur. Pas d'aide ni d'erreur rattachées, pas d'unité à côté d'une quantité (« Quantité » vide sans unité). | Composant champ unique (libellé, aide, erreur, unité), sélecteur, case, interrupteur, **contrôle segmenté** pour les petits choix (les 6 radios de la perte occupent 300 px, les 4 radios d'un filtre d'utilisateurs 200 px). |
| **Listes et tableaux** | Aucun tableau. Les créances, utilisateurs, mouvements de stock sont des cartes empilées, y compris à 1280 px ; les numéros de vente (`VTE-DEMO-MAG-2026-000001`) occupent la ligne principale et se coupent. | Ligne de liste à trois zones (repère, texte, valeur et état) ; sur ordinateur, les mêmes listes s'affichent en colonnes, sans changer les rôles du DOM (les essais restent valables). Client et montant d'abord, référence ensuite. |
| **Cartes et groupes** | Cartes blanches à bord plein partout, sections annoncées par un petit titre gris en capitales ; `/pdv` est un mur de texte avec des chiffres noyés dans des phrases. | Cartes réservées aux objets (un résumé, un formulaire, une ligne de liste) ; chiffres en tuiles ; textes d'aide repliés. |
| **En-têtes de page** | Titre seul, sans retour ni action ; l'action principale flotte à côté du titre (« + Prospect ») ou se trouve en bas de page, hors de vue. | En-tête de page : retour, titre, sous-titre, action principale ; sur un formulaire, barre d'action collée en bas avec le total. |
| **Navigation** | Aucune navigation permanente : tout passe par la page « Menu » (40 entrées en une colonne, tuiles de hauteurs et de poids inégaux, certaines pleines au hasard) ; sur ordinateur, même colonne centrée de 928 px. | Barre d'onglets en bas sur mobile (4 destinations selon le rôle plus « Plus »), bouton « + » pour les créations rapides ; barre latérale groupée par domaine sur ordinateur. |
| **Retours à l'utilisateur** | Chargement : une ligne de texte ; états vides : une phrase ; confirmations en `window.confirm`. | Squelettes, états vides avec la prochaine action, bandeaux et notifications, feuille de confirmation. |
| **Pastilles d'état** | Une seule famille de verts : « Non payée » et « Payée » se ressemblent (`saleStatusTone` renvoie un ton neutre pour l'impayé). | Quatre tons sémantiques (réussi, attention, alerte, information) distincts de la couleur de marque, plus un point et le texte. |
| **Nombres et montants** | Même graisse partout ; chiffres non alignés ; l'extrémité du tracé des indicateurs est écrasée en ellipse (SVG étiré). | Chiffres tabulaires, police condensée pour les grands nombres, point d'extrémité net. |
| **Densité** | 85 textes sous 14 px sur l'accueil ; hiérarchie à deux niveaux (gras ou non). | Échelle de 12 à 32 px, jamais sous 12 px ; trois niveaux d'encre. |
| **Accueil** | Une section par rôle, mêmes indicateurs répétés (« Chiffre d'affaires du jour » quatre fois) ; actions du jour en tuiles de hauteurs inégales. | Un indicateur n'apparaît qu'une fois ; l'action principale du rôle en tête ; sélecteur de rôle quand l'utilisateur en cumule. |
| **Coquille** | Bandeau « approbation de l'appareil » de 70 px sur chaque écran tant que l'appareil n'est pas approuvé ; pastille de synchronisation en lien souligné. | Bandeau réduit et refermable ; indicateur de synchronisation compact (point, nombre d'opérations en attente), détail dans une feuille. |

## 4. Ruptures de logique métier

- **Vendeur de point de vente** : l'action quotidienne (« + Vente ») est une tuile parmi d'autres sur l'accueil, et le bouton « Enregistrer » d'une vente est sous la ligne de flottaison. La caisse (ouverte ou non, depuis quand) est une phrase de `/pdv`, alors qu'elle conditionne l'encaissement.
- **Commercial terrain** : six actions (service, prospect, visite, vente, commande, dépense) au même niveau ; « Prendre service » est un lien en capitales dans un signal.
- **Magasinier et responsable de ferme** : les opérations de stock (recevoir, transférer, compter, déclarer une perte) ne sont pas sur l'écran de stock ; il faut repasser par le menu.
- **Finance** : créances, dépenses, factures, paiements et trésorerie sont des écrans isolés, sans barre latérale ; les créances sont du texte et des puces là où un tableau (client, dû, échu, échéance, actions) est l'outil naturel.
- **Direction** : la « Tour de contrôle » est annoncée « Bientôt » en tête de l'accueil, devant des actions qui existent.
- **Administration** : un paragraphe d'explication précède la liste des utilisateurs ; le filtre d'état est un groupe de radios.
- **Tous** : le même écran sert un compte à un rôle et un compte à onze rôles ; l'accueil ne se hiérarchise pas par fréquence d'usage.

## 5. Direction visuelle (validée le 30/10/2026, ADR-049)

Maquette envoyée au porteur le 30/10/2026 (accueil d'un vendeur de point de vente, nouvelle vente, thème sombre, créances sur ordinateur). Choix du porteur : style **sobre et aéré**, navigation **onglets en bas avec bouton « + »** sur téléphone (barre latérale sur ordinateur), thème **clair par défaut, sombre au choix**. Le thème automatique, qui suit le téléphone, est une troisième valeur du réglage.

- **Palette** : celle du logo officiel et de la charte des pièces papier. Vert de la banderole `#3a6351` (principal), vert profond `#2b4b3d`, jaune d'œuf `#cdab0a` en accent rare (repère de l'onglet actif, pastille de compteur), neutres légèrement teintés de vert, encre `#15211b`. Le vert très sombre actuel (`#0b3d1e`) n'est pas celui du logo : il est remplacé. Couleurs d'état séparées de la marque : réussi, attention, alerte, information.
- **Typographie** : Noto Sans pour l'interface (4 graisses), Barlow Semi Condensed pour les titres et les grands nombres ; polices déjà dépendances du projet, embarquées, sans réseau. Échelle 12, 13, 15, 17, 20, 24, 32 px ; base de 15 px, champs de 16 px (évite le zoom du téléphone).
- **Forme** : fond clair teinté, cartes blanches à bord fin et ombre très légère, rayon de 8 px pour les contrôles, 12 px pour les cartes, pastilles arrondies ; icônes en traits de 1,8 px, intégrées sans réseau.
- **Navigation** : mobile, barre du haut compacte (titre, synchronisation, compte) et barre d'onglets en bas ; ordinateur, barre latérale verte groupée par domaine, en-tête de page avec actions. Les destinations suivent le rôle (catalogue `role-catalog.ts`).
- **Thèmes** : clair par défaut (usage en plein jour), sombre au choix ou selon le système.
- **Mouvement** : transitions de 120 à 180 ms, supprimées avec `prefers-reduced-motion`.

## 6. Plan par lots

| Lot | Contenu | Critère d'achèvement |
|---|---|---|
| **L0** | Audit, direction, plan (ce document) | Direction validée par le porteur |
| **L1** | Fondations : jetons (`tokens.css`, thèmes clair et sombre), base typographique, composants partagés (bouton, champ, sélecteur, case, interrupteur, segmenté, carte, pastille, onglets, ligne de liste, liste en colonnes, en-tête de page, état vide, squelette, bandeau, feuille, tuile d'indicateur, icônes), page de référence réservée au développement | La page de référence montre chaque composant en clair et en sombre, mobile et bureau ; types et essais verts ; budget NFR-05 tenu |
| **L2** | Coquille et navigation par rôle, connexion, PIN, changement de mot de passe, accueil par rôle | Onglets en bas et barre latérale ; accueil sans indicateur répété ; essais de l'accueil et de la navigation verts |
| **L3** | Ventes et caisse : vente, liste et détail, encaissement, commandes de vente, caisse, point de vente | Barre d'action fixe sur les formulaires ; plus aucun style propre à ces écrans |
| **L4** | Stock : stock, registre, transferts, réceptions, inventaire, perte, consommation, quotas | Actions du stock accessibles depuis l'écran de stock |
| **L5** | Commandes et clients, objectifs, service, catalogue, prix | Portefeuille et fiche client lisibles en bureau et en mobile |
| **L6** | Production : lots, saisie du jour, collecte, incubation, sortie | Saisie du jour réalisable d'une main |
| **L7** | Achats : demandes, bons de commande, réceptions, fournisseurs, rapprochement | Listes en colonnes sur ordinateur |
| **L8** | Finance : trésorerie, créances, dépenses, factures, paiements, coûts et marges, remises | Créances et paiements en tableaux ; tuiles et vieillissement lisibles |
| **L9** | Administration, validations, synchronisation et conflits | Filtres en contrôle segmenté ; explications repliées |
| **L10** | Clôture : une vérification complète, suivi, point dans `CLAUDE.md` | Types, ESLint, essais, construction et contrôle de taille, frontières et références verts |

Chaque lot ferme sur : contrôle visuel mobile et bureau, `typecheck`, essais du domaine (la suite complète d'`apps/pwa` au plus une fois par lot), un commit en français, un point d'avancement avec avant et après sur deux ou trois écrans.

## 7. Fondations livrées (lot L1)

Le lot L1 est l'infrastructure de tout le reste : un écran qui n'a pas encore été repris profite déjà des jetons et du style des éléments nus (boutons, champs, cases), les lots suivants adoptent les composants.

| Où | Contenu |
|---|---|
| `apps/pwa/src/styles/tokens.css` | Jetons : couleurs clair et sombre (le sombre sous `data-theme="dark"` et, pour « automatique », sous `prefers-color-scheme`), typographie (7 tailles), espacement de 4 px, rayons, ombres, gestes (40 px visibles, 48 px pour l'action principale), mouvement |
| `styles/fonts.css`, `base.css` | Noto Sans (400, 600, 700) et Barlow Semi Condensed (600, 700) en `woff2`, mêmes fichiers que les pièces imprimées ; style des éléments nus : boutons, champs, listes déroulantes, cases et radios dessinées, interrupteur, focus visible, `prefers-reduced-motion` |
| `styles/components.css` | Classes des composants ; aucune couleur en dur |
| `app/app.css` | Feuille héritée, **re-tokenisée** : plus aucune couleur écrite en dur, anciens noms de variables renvoyés aux jetons, règles en conflit avec la base retirées. Disparaît au lot L10 |
| `components/ui/` | `Button`, `LinkButton`, `IconButton` · `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Radio`, `Switch`, `Segmented` · `Card`, `Section`, `List`, `ListRow`, `DataList` (cartes sur téléphone, colonnes dès 900 px), `Badge`, `Avatar`, `KpiTile`, `Sparkline` · `Banner`, `EmptyState`, `Skeleton`, `Spinner`, `Sheet`, `ToastProvider` et `useToast` · `Tabs`, `TabPanel`, `PageHeader` · `Icon` (47 icônes) · thème (`theme.ts`) |
| `dev/ComponentGallery.tsx` | Page de référence `/dev/composants`, développement seulement : absente de la construction de production (`import.meta.env.DEV`) |

Règles pour les lots suivants :

- **Un seul bouton plein par écran** (`primary`) ; les autres actions en `tonal`, `ghost` ou `outline`. Le bouton nu reste plein pour ne pas casser les écrans non repris : le premier geste d'un lot est de le rétrograder là où il n'est pas l'action principale.
- **Listes** : `List` et `ListRow` sur téléphone, `DataList` quand un écran a plusieurs colonnes ; toujours des `ul` et des `li`, jamais de `table`, pour que les essais par rôle, libellé et texte restent valables.
- **Petits choix exclusifs** (cinq au plus) : `Segmented`, pas une pile de radios ni une liste déroulante.
- **Formulaires** : `Field` relie libellé, aide, erreur et unité au contrôle ; le bouton principal va dans une barre d'action collée en bas (lot L3).
- **Aucune couleur en dur** : `styles/tokens.test.ts` le vérifie sur `base.css`, `components.css` et `app.css`, et vérifie les contrastes (texte 4,5 : 1, bordure de champ 3 : 1) dans les deux thèmes.
- Les sélecteurs que les essais utilisent (`text-warn`, `result-warn`, `result-error`, `action-primary`, `home-muted`, `[data-kpi]`) sont conservés tant que l'essai correspondant ne change pas.

## 8. Outils de vérification

- **Relevé et captures sans fenêtre** : Chromium déjà installé (révision 1234) piloté par Playwright, profil persistant (appareil et code PIN conservés), navigation interne sans rechargement. Il rend les écrans en 375 px et 1280 px, clair et sombre, et relève par écran : débordement horizontal, boutons, contrôles natifs, tailles de police, tableaux, erreurs de console. Le navigateur intégré à l'application reste utilisable pour un coup d'œil, mais sa fenêtre est parfois masquée et les captures échouent alors.
- **Base locale** : `gic_agropelc_refonte`, neuve (migrations, semis, `demo:data`), compte de démonstration à onze rôles ; jamais la base partagée des essais.

## 9. Journal

| Date | Fait |
|---|---|
| 30/10/2026 | Audit des 61 écrans (mesures § 2), maquette de la direction (§ 5), plan par lots (§ 6). Direction validée par le porteur (style, navigation, thème) ; ADR-049 rédigé. Lot L0 clos. |
| 30/10/2026 | Lot L1 (fondations, § 7) : jetons clair et sombre, polices, base, composants partagés, page de référence, `app.css` re-tokenisée. |
